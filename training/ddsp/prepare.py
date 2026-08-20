"""Extract features for one instrument: resample to the model rate, mono,
peak-normalize, then f0 (torchcrepe) + A-weighted loudness per frame.

Usage: uv run python prepare.py configs/violin.yaml
"""

import pathlib
import sys

import numpy as np
import torch
import torchaudio
import yaml
from tqdm import tqdm

from ddsp.features import f0_crepe, loudness_db

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff", ".m4a"}


def main(config_path: str) -> None:
    cfg = yaml.safe_load(pathlib.Path(config_path).read_text())
    sr, hop = cfg["sample_rate"], cfg["hop"]
    root = pathlib.Path(config_path).resolve().parent.parent
    raw_dir = root / "data" / cfg["name"] / "raw"
    out_dir = root / "data" / cfg["name"] / "features"
    out_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in raw_dir.rglob("*") if p.suffix.lower() in AUDIO_EXTS)
    if not files:
        sys.exit(f"no audio in {raw_dir}")
    device = "cuda" if torch.cuda.is_available() else "cpu"  # crepe on MPS is flaky
    total_sec = 0.0
    for path in tqdm(files, desc=cfg["name"]):
        out = out_dir / (path.stem + ".npz")
        if out.exists():
            continue
        wav, file_sr = torchaudio.load(str(path))
        wav = wav.mean(dim=0)
        if file_sr != sr:
            wav = torchaudio.functional.resample(wav, file_sr, sr)
        audio = wav.numpy().astype(np.float32)
        peak = np.abs(audio).max()
        if peak < 1e-4:
            continue
        audio = audio * (0.9 / peak)
        f0, periodicity = f0_crepe(
            audio, sr, hop, device=device,
            fmin=cfg.get("fmin", 50.0), fmax=cfg.get("fmax", 2000.0),
        )
        ld = loudness_db(audio, sr, hop)
        n = min(len(f0), len(ld), len(audio) // hop)
        np.savez(
            out,
            audio=audio[: n * hop],
            f0=f0[:n],
            loudness=ld[:n],
            periodicity=periodicity[:n],
        )
        total_sec += n * hop / sr
    print(f"prepared {len(files)} files, {total_sec / 60:.1f} min of audio -> {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1])
