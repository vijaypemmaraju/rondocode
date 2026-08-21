"""Synthetic dataset for pipeline smoke tests: a sawtooth-ish additive tone
with vibrato and breath noise, so training has something learnable."""
import pathlib

import numpy as np

from ddsp.features import loudness_db

sr, hop = 48000, 512
out_dir = pathlib.Path(__file__).parent / "data/smoke/features"
out_dir.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(42)
for idx in range(3):
    dur = 30.0
    n = int(dur * sr)
    t = np.arange(n) / sr
    midi = 57 + 12 * np.sin(2 * np.pi * 0.11 * t + idx) + 0.3 * np.sin(2 * np.pi * 5.5 * t)
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    phase = 2 * np.pi * np.cumsum(f0) / sr
    audio = np.zeros(n)
    for k in range(1, 24):
        audio += (1.0 / k) * np.sin(k * phase)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.23 * t + idx * 2) ** 2
    audio = audio * env * 0.25 + rng.standard_normal(n) * 0.008 * env
    audio = (audio / np.abs(audio).max() * 0.9).astype(np.float32)
    frames = n // hop
    f0_frames = f0[::hop][:frames].astype(np.float32)
    ld = loudness_db(audio, sr, hop)[:frames]
    np.savez(out_dir / f"tone{idx}.npz", audio=audio[:frames*hop], f0=f0_frames,
             loudness=ld, periodicity=np.ones(frames, dtype=np.float32))
print("smoke data written:", sorted(p.name for p in out_dir.glob("*.npz")))
