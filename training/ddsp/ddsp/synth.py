"""Differentiable harmonic-plus-noise synthesis.

Interpolation semantics here define the runtime contract (SPEC.md): frame i's
values sit at sample i*hop and ramp linearly to frame i+1; the last frame
holds. The TS renderer streams the same math."""

import math

import torch
import torch.nn.functional as F


def upsample_frames(x: torch.Tensor, hop: int) -> torch.Tensor:
    """[B, T, C] frame values -> [B, T*hop, C] linearly interpolated."""
    b, t, c = x.shape
    x_next = torch.cat([x[:, 1:], x[:, -1:]], dim=1)
    w = torch.arange(hop, device=x.device, dtype=x.dtype).view(1, 1, hop, 1) / hop
    out = x.unsqueeze(2) * (1.0 - w) + x_next.unsqueeze(2) * w
    return out.reshape(b, t * hop, c)


def angular_cumsum_mod1(x: torch.Tensor, chunk: int = 1024) -> torch.Tensor:
    """Cumulative sum of [B, T] kept in [0, 1) chunk-by-chunk so float32
    precision survives long renders (MPS has no float64)."""
    b, t = x.shape
    pad = (-t) % chunk
    xp = F.pad(x, (0, pad)).reshape(b, -1, chunk)
    within = torch.cumsum(xp, dim=-1) % 1.0
    carry = torch.cumsum(within[..., -1], dim=-1) % 1.0
    carry = F.pad(carry[:, :-1], (1, 0))
    out = (within + carry.unsqueeze(-1)) % 1.0
    return out.reshape(b, -1)[:, :t]


def harmonic(
    f0_hz: torch.Tensor,  # [B, T] frames
    harm_amps: torch.Tensor,  # [B, T, K] frames
    sample_rate: int,
    hop: int,
) -> torch.Tensor:
    f0_up = upsample_frames(f0_hz.unsqueeze(-1), hop)[..., 0]  # [B, N]
    amps_up = upsample_frames(harm_amps, hop)  # [B, N, K]
    rev = angular_cumsum_mod1(f0_up / sample_rate)  # revolutions of the fundamental
    k = torch.arange(1, harm_amps.shape[-1] + 1, device=f0_hz.device)
    # frac(k * rev) == frac(k * frac(rev)) for integer k; keeps float32 exact.
    phase = (rev.unsqueeze(-1) * k) % 1.0
    return (amps_up * torch.sin(2.0 * math.pi * phase)).sum(dim=-1)


def noise_fir(noise_mags: torch.Tensor) -> torch.Tensor:
    """[B, T, n_noise] magnitudes -> [B, T, taps] windowed linear-phase FIRs."""
    taps = 2 * (noise_mags.shape[-1] - 1)
    h = torch.fft.irfft(noise_mags.to(torch.complex64), n=taps)
    h = torch.roll(h, shifts=taps // 2, dims=-1)
    win = torch.hann_window(taps, periodic=False, device=h.device, dtype=h.dtype)
    return h * win


def filtered_noise(
    noise_mags: torch.Tensor,  # [B, T, n_noise] frames
    hop: int,
    noise: torch.Tensor | None = None,  # [B, T*hop] in [-1, 1]
) -> torch.Tensor:
    b, t, _ = noise_mags.shape
    firs = noise_fir(noise_mags)  # [B, T, taps]
    taps = firs.shape[-1]
    if noise is None:
        noise = torch.rand(b, t * hop, device=noise_mags.device) * 2.0 - 1.0
    frames = noise.reshape(b, t, hop)
    n_fft = 1
    while n_fft < hop + taps:
        n_fft *= 2
    y = torch.fft.irfft(
        torch.fft.rfft(frames, n=n_fft) * torch.fft.rfft(firs, n=n_fft), n=n_fft
    )  # [B, T, n_fft]
    out = torch.zeros(b, t * hop + n_fft, device=y.device, dtype=y.dtype)
    for i in range(t):
        out[:, i * hop : i * hop + n_fft] += y[:, i]
    # Discard the FIR group delay so noise aligns with its frame.
    return out[:, taps // 2 : taps // 2 + t * hop]


def render(
    f0_hz: torch.Tensor,
    harm_amps: torch.Tensor,
    noise_mags: torch.Tensor,
    sample_rate: int,
    hop: int,
    noise: torch.Tensor | None = None,
) -> torch.Tensor:
    return harmonic(f0_hz, harm_amps, sample_rate, hop) + filtered_noise(
        noise_mags, hop, noise
    )


class TrainableReverb(torch.nn.Module):
    """Training-time room model so the dry synth isn't forced to explain the
    recording's reverb. Never exported."""

    def __init__(self, length: int = 48000):
        super().__init__()
        t = torch.arange(length)
        init = (torch.randn(length) * 1e-3) * torch.exp(-4.0 * t / length)
        init[0] = 0.0
        self.ir = torch.nn.Parameter(init)

    def forward(self, dry: torch.Tensor) -> torch.Tensor:
        ir = self.ir.clone()
        ir = torch.cat([ir.new_zeros(1), ir[1:]])  # no dry-path leakage
        # A room REFLECTS, it does not amplify: cap the IR energy at 1 so the
        # dry path must carry the level. Unconstrained, one training run
        # parked +17 dB of gain here (IR energy 51) and the shipped dry model
        # whispered ~29 dB under the recordings.
        energy = ir.pow(2).sum()
        ir = ir * torch.clamp(torch.rsqrt(energy + 1e-12), max=1.0)
        n = dry.shape[-1] + ir.shape[-1]
        n_fft = 1
        while n_fft < n:
            n_fft *= 2
        wet = torch.fft.irfft(
            torch.fft.rfft(dry, n=n_fft) * torch.fft.rfft(ir, n=n_fft), n=n_fft
        )[..., : dry.shape[-1]]
        return dry + wet
