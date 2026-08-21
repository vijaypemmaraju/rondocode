"""Extract features for one instrument: resample to the model rate, mono,
then f0 (torchcrepe) + A-weighted loudness per frame.

Gain is normalized ONCE PER DATASET (a single gain applied to every file),
never per file: the decoder learns timbre AS A FUNCTION OF loudness, and
per-file normalization would make a pp note and an ff note equally "loud"
while sounding completely different — poisoning the conditioning.

Usage: uv run python prepare.py configs/violin.yaml
"""

import pathlib
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio
import yaml
from tqdm import tqdm

from ddsp.features import f0_crepe, loudness_db

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff", ".m4a"}


def load_mono(path: pathlib.Path, sr: int) -> np.ndarray:
    # soundfile, not torchaudio.load: torchaudio >= 2.9 delegates decoding to
    # torchcodec, an extra native dep we don't need for wav/flac/ogg
    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    if file_sr != sr:
        wav = torchaudio.functional.resample(wav, file_sr, sr)
    return wav.numpy().astype(np.float32)


def main(config_path: str) -> None:
    cfg = yaml.safe_load(pathlib.Path(config_path).read_text())
    sr, hop = cfg["sample_rate"], cfg["hop"]
    root = pathlib.Path(config_path).resolve().parent.parent
    raw_dir = root / "data" / cfg["name"] / "raw"
    out_dir = root / "data" / cfg["name"] / "features"
    out_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p
        for p in raw_dir.rglob("*")
        if p.suffix.lower() in AUDIO_EXTS and not p.name.startswith("._")
        and not p.name.startswith("medley_._")  # macOS AppleDouble junk
    )
    if not files:
        sys.exit(f"no audio in {raw_dir}")
    import os

    # crepe device: cuda when present; DDSP_DEVICE=mps to try Apple GPU
    device = os.environ.get("DDSP_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")

    # Pass 1: one gain for the whole dataset (see module docstring).
    gain_file = out_dir / "gain.txt"
    if gain_file.exists():
        gain = float(gain_file.read_text())
    else:
        peak = 0.0
        for path in tqdm(files, desc=f"{cfg['name']} peak scan"):
            audio = load_mono(path, sr)
            peak = max(peak, float(np.abs(audio).max()))
        if peak < 1e-4:
            sys.exit(f"dataset in {raw_dir} is silent")
        gain = 0.9 / peak
        gain_file.write_text(str(gain))

    total_sec = 0.0
    for path in tqdm(files, desc=cfg["name"]):
        out = out_dir / (path.stem + ".npz")
        if out.exists():
            continue
        audio = load_mono(path, sr) * gain
        if np.abs(audio).max() < 1e-4:
            continue
        f0, periodicity = f0_crepe(
            audio, sr, hop, device=device,
            fmin=cfg.get("fmin", 50.0), fmax=cfg.get("fmax", 2000.0),
        )
        ld = loudness_db(audio, sr, hop)
        n = min(len(f0), len(ld), len(audio) // hop)
        if n < 8:
            continue
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
