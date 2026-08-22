"""The frame-rate decoder. Architecture is pinned by SPEC.md; the TS runtime
reimplements exactly this, so structural changes require regenerating the
golden vectors.

Format v2 generalizes two things:

- CONDITIONING INPUTS are a named, ordered list (`inputs`). v1 models are
  `["f0", "loudness"]`. A struck instrument (piano) cannot be conditioned on
  loudness at play time — the decay IS the note — so it uses
  `["f0", "velocity", "onset_age", "release_age"]` and GENERATES the decay.
  Each input gets its own small MLP (as in v1), concatenated into the GRU.
- INHARMONICITY: stiff strings stretch their partials,
  f_k = k * f0 * sqrt(1 + B k^2). A learnable per-MIDI-key B table (log
  domain) feeds the synthesizer; the runtime reads it from the header.
  Harmonic models leave it absent.
"""

import math

import torch
import torch.nn as nn

INPUT_FEATURES = ("f0", "loudness", "velocity", "onset_age", "release_age", "held")
AGE_SCALE = math.log1p(20.0)  # onset/release age in seconds -> log1p(t)/log1p(20), ~[0, 1]


def exp_sigmoid(x: torch.Tensor) -> torch.Tensor:
    return 2.0 * torch.sigmoid(x) ** math.log(10.0) + 1e-7


def hz_to_midi(f0_hz: torch.Tensor) -> torch.Tensor:
    return 69.0 + 12.0 * torch.log2(torch.clamp(f0_hz, min=1e-5) / 440.0)


def scale_f0(f0_hz: torch.Tensor) -> torch.Tensor:
    return hz_to_midi(f0_hz) / 127.0


def scale_loudness(loudness_db: torch.Tensor) -> torch.Tensor:
    return (torch.clamp(loudness_db, -90.0, 0.0) + 90.0) / 90.0


def scale_age(seconds: torch.Tensor) -> torch.Tensor:
    return torch.log1p(torch.clamp(seconds, min=0.0)) / AGE_SCALE


def scale_feature(name: str, x: torch.Tensor) -> torch.Tensor:
    if name == "f0":
        return scale_f0(x)
    if name == "loudness":
        return scale_loudness(x)
    if name in ("onset_age", "release_age"):
        return scale_age(x)
    if name in ("velocity", "held"):
        return torch.clamp(x, 0.0, 1.0)
    raise KeyError(f"unknown conditioning feature '{name}'")


def default_inharmonicity(midi: torch.Tensor) -> torch.Tensor:
    """Physics-shaped init for B per MIDI key: ~3e-5 at A0 rising ~2x per
    octave toward the treble (a real grand spans ~5e-5 .. 1e-2)."""
    return 3e-5 * torch.pow(2.0, (midi - 21.0) / 12.0)


def _mlp(n_in: int, hidden: int, layers: int) -> nn.Sequential:
    mods: list[nn.Module] = []
    for i in range(layers):
        mods.append(nn.Linear(n_in if i == 0 else hidden, hidden))
        mods.append(nn.LayerNorm(hidden))
        mods.append(nn.LeakyReLU(0.2))
    return nn.Sequential(*mods)


class Decoder(nn.Module):
    def __init__(
        self,
        hidden: int = 128,
        layers: int = 3,
        gru: int = 192,
        n_harmonics: int = 64,
        n_noise: int = 65,
        sample_rate: int = 48000,
        hop: int = 512,
        inputs: tuple[str, ...] | list[str] = ("f0", "loudness"),
        inharmonic: bool = False,
    ):
        super().__init__()
        for name in inputs:
            if name not in INPUT_FEATURES:
                raise ValueError(f"unknown conditioning feature '{name}'")
        if "f0" not in inputs:
            raise ValueError("conditioning must include f0")
        self.hidden = hidden
        self.layers = layers
        self.gru_size = gru
        self.n_harmonics = n_harmonics
        self.n_noise = n_noise
        self.sample_rate = sample_rate
        self.hop = hop
        self.inputs = list(inputs)
        self.inharmonic = inharmonic
        self.in_mlps = nn.ModuleDict({name: _mlp(1, hidden, layers) for name in self.inputs})
        self.gru = nn.GRU(len(self.inputs) * hidden, gru, batch_first=True)
        self.out_mlp = _mlp(gru + len(self.inputs), hidden, layers)
        self.harm_head = nn.Linear(hidden, 1 + n_harmonics)
        self.noise_head = nn.Linear(hidden, n_noise)
        if inharmonic:
            midi = torch.arange(128, dtype=torch.float32)
            self.log_b = nn.Parameter(torch.log(default_inharmonicity(midi)))
        else:
            self.log_b = None

    def partial_multipliers(self, f0_hz: torch.Tensor) -> torch.Tensor | None:
        """[..., K] stretch factors m_k so partial k sits at m_k * f0
        (m_k = k for a harmonic model -> returns None)."""
        if self.log_b is None:
            return None
        midi = torch.clamp(hz_to_midi(f0_hz), 0.0, 127.0)
        lo = torch.clamp(torch.floor(midi), max=126.0)
        frac = (midi - lo).unsqueeze(-1)
        idx = lo.long()
        b = torch.exp(self.log_b)
        b_at = b[idx].unsqueeze(-1) * (1.0 - frac) + b[idx + 1].unsqueeze(-1) * frac
        k = torch.arange(1, self.n_harmonics + 1, device=f0_hz.device, dtype=f0_hz.dtype)
        return k * torch.sqrt(1.0 + b_at * k * k)

    def forward(self, features: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
        """features: name -> [batch, frames] for every name in self.inputs.
        Returns per-frame synth params; 'partial_mult' is None for harmonic
        models."""
        f0_hz = features["f0"]
        scaled = [scale_feature(n, features[n]).unsqueeze(-1) for n in self.inputs]
        x = torch.cat([self.in_mlps[n](s) for n, s in zip(self.inputs, scaled)], dim=-1)
        h, _ = self.gru(x)
        y = self.out_mlp(torch.cat([h] + scaled, dim=-1))
        harm = self.harm_head(y)
        amp = exp_sigmoid(harm[..., 0])
        dist = exp_sigmoid(harm[..., 1:])
        mult = self.partial_multipliers(f0_hz)
        k = torch.arange(1, self.n_harmonics + 1, device=dist.device, dtype=dist.dtype)
        partial_hz = f0_hz.unsqueeze(-1) * (mult if mult is not None else k)
        audible = (partial_hz < self.sample_rate / 2).float()
        dist = dist * audible
        dist = dist / (dist.sum(dim=-1, keepdim=True) + 1e-7)
        return {
            "amp": amp,
            "harm_dist": dist,
            "harm_amps": amp.unsqueeze(-1) * dist,
            "noise_mags": exp_sigmoid(self.noise_head(y)),
            "partial_mult": mult,
        }
