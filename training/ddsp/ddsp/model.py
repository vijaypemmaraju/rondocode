"""The frame-rate decoder. Architecture is pinned by SPEC.md; the TS runtime
reimplements exactly this, so structural changes require regenerating the
golden vectors."""

import math

import torch
import torch.nn as nn


def exp_sigmoid(x: torch.Tensor) -> torch.Tensor:
    return 2.0 * torch.sigmoid(x) ** math.log(10.0) + 1e-7


def hz_to_midi(f0_hz: torch.Tensor) -> torch.Tensor:
    return 69.0 + 12.0 * torch.log2(torch.clamp(f0_hz, min=1e-5) / 440.0)


def scale_f0(f0_hz: torch.Tensor) -> torch.Tensor:
    return hz_to_midi(f0_hz) / 127.0

def scale_loudness(loudness_db: torch.Tensor) -> torch.Tensor:
    return (torch.clamp(loudness_db, -90.0, 0.0) + 90.0) / 90.0


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
    ):
        super().__init__()
        self.hidden = hidden
        self.layers = layers
        self.gru_size = gru
        self.n_harmonics = n_harmonics
        self.n_noise = n_noise
        self.sample_rate = sample_rate
        self.hop = hop
        self.in_mlp_f0 = _mlp(1, hidden, layers)
        self.in_mlp_ld = _mlp(1, hidden, layers)
        self.gru = nn.GRU(2 * hidden, gru, batch_first=True)
        self.out_mlp = _mlp(gru + 2, hidden, layers)
        self.harm_head = nn.Linear(hidden, 1 + n_harmonics)
        self.noise_head = nn.Linear(hidden, n_noise)

    def forward(
        self, f0_hz: torch.Tensor, loudness_db: torch.Tensor
    ) -> dict[str, torch.Tensor]:
        """f0_hz, loudness_db: [batch, frames]. Returns per-frame synth params."""
        f0s = scale_f0(f0_hz).unsqueeze(-1)
        lds = scale_loudness(loudness_db).unsqueeze(-1)
        x = torch.cat([self.in_mlp_f0(f0s), self.in_mlp_ld(lds)], dim=-1)
        h, _ = self.gru(x)
        y = self.out_mlp(torch.cat([h, f0s, lds], dim=-1))
        harm = self.harm_head(y)
        amp = exp_sigmoid(harm[..., 0])
        dist = exp_sigmoid(harm[..., 1:])
        # Zero harmonics above the model Nyquist, then renormalize.
        k = torch.arange(1, self.n_harmonics + 1, device=dist.device)
        audible = (f0_hz.unsqueeze(-1) * k < self.sample_rate / 2).float()
        dist = dist * audible
        dist = dist / (dist.sum(dim=-1, keepdim=True) + 1e-7)
        return {
            "amp": amp,
            "harm_dist": dist,
            "harm_amps": amp.unsqueeze(-1) * dist,
            "noise_mags": exp_sigmoid(self.noise_head(y)),
        }
