"""Feature extraction: f0 via torchcrepe (on 16 kHz resampled audio) and
A-weighted loudness in dB, both at the model frame rate."""

import numpy as np
import torch
import torchaudio


def a_weighting_db(freqs: np.ndarray) -> np.ndarray:
    f2 = np.maximum(freqs, 1e-6) ** 2
    ra = (
        12194.0**2
        * f2**2
        / (
            (f2 + 20.6**2)
            * np.sqrt((f2 + 107.7**2) * (f2 + 737.9**2))
            * (f2 + 12194.0**2)
        )
    )
    return 20.0 * np.log10(np.maximum(ra, 1e-20)) + 2.0


def _raw_loudness_db(
    audio: np.ndarray, sample_rate: int, hop: int, n_fft: int
) -> np.ndarray:
    x = torch.from_numpy(audio).float()
    s = torch.stft(
        x,
        n_fft,
        hop_length=hop,
        window=torch.hann_window(n_fft),
        center=True,
        return_complex=True,
    )
    power = s.abs().numpy() ** 2  # [bins, frames]
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    weighted = power * (10.0 ** (a_weighting_db(freqs)[:, None] / 10.0))
    mean_power = weighted.mean(axis=0)
    return 10.0 * np.log10(np.maximum(mean_power, 1e-20))


_REF_DB: dict[tuple[int, int, int], float] = {}


def _ref_db(sample_rate: int, hop: int, n_fft: int) -> float:
    """Calibration: a FULL-SCALE 1 kHz sine reads 0 dB. Computed empirically
    through the exact analysis path (a closed-form window/bin-count offset was
    wrong once already: it pushed everything past 0 where the clip flattened
    the whole loudness curve to a constant — a dead conditioning input)."""
    key = (sample_rate, hop, n_fft)
    if key not in _REF_DB:
        t = np.arange(sample_rate) / sample_rate
        sine = np.sin(2 * np.pi * 1000.0 * t).astype(np.float32)
        db = _raw_loudness_db(sine, sample_rate, hop, n_fft)
        _REF_DB[key] = float(np.median(db[2:-2]))
    return _REF_DB[key]


def loudness_db(
    audio: np.ndarray, sample_rate: int, hop: int, n_fft: int = 2048
) -> np.ndarray:
    """[-90, 0] dB A-weighted loudness per frame, frame i centered at i*hop.
    0 dB = full-scale 1 kHz sine (see _ref_db)."""
    db = _raw_loudness_db(audio, sample_rate, hop, n_fft) - _ref_db(
        sample_rate, hop, n_fft
    )
    return np.clip(db, -90.0, 0.0).astype(np.float32)


def f0_crepe(
    audio: np.ndarray,
    sample_rate: int,
    hop: int,
    device: str = "cpu",
    fmin: float = 50.0,
    fmax: float = 2000.0,
) -> tuple[np.ndarray, np.ndarray]:
    """Returns (f0_hz, periodicity) per frame at sample_rate/hop fps."""
    import torchcrepe

    crepe_sr = 16000
    x = torch.from_numpy(audio).float().unsqueeze(0)
    x16 = torchaudio.functional.resample(x, sample_rate, crepe_sr)
    n_frames = int(np.ceil(len(audio) / hop))
    crepe_hop = int(round(crepe_sr * hop / sample_rate))
    f0, periodicity = torchcrepe.predict(
        x16,
        crepe_sr,
        hop_length=crepe_hop,
        fmin=fmin,
        fmax=fmax,
        model="full",
        batch_size=512,
        device=device,
        return_periodicity=True,
    )
    f0 = f0[0].cpu().numpy().astype(np.float32)[:n_frames]
    periodicity = periodicity[0].cpu().numpy().astype(np.float32)[:n_frames]
    if len(f0) < n_frames:  # pad with the last value if crepe came up short
        pad = n_frames - len(f0)
        f0 = np.pad(f0, (0, pad), mode="edge")
        periodicity = np.pad(periodicity, (0, pad), mode="edge")
    return f0, periodicity
