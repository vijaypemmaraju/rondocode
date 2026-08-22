"""Features for the piano (struck) model from the Salamander Grand Piano
samples (CC BY 3.0): every note file is one key at one velocity layer,
held until silent — the complete story of a struck note.

No crepe needed: f0 is the key's equal-tempered pitch (constant per file;
the decoder learns the real stretch through the inharmonicity table).
Per frame: f0, loudness (measured, unused as input but kept for eval),
velocity (layer/16), onset_age (seconds from the strike), release_age (0 —
held), held (1). One dataset-wide gain, like prepare.py.

Usage: uv run python prepare_salamander.py configs/piano.yaml
"""

import pathlib
import re
import sys

import numpy as np
import soundfile as sf
import torch
import torchaudio
import yaml
from tqdm import tqdm

from ddsp.features import loudness_db

NOTE_RE = re.compile(r"^([A-G]#?)(\d)v(\d+)$")
NAMES = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def parse_name(stem: str) -> tuple[int, int] | None:
    m = NOTE_RE.match(stem)
    if not m:
        return None
    midi = 12 * (int(m.group(2)) + 1) + NAMES[m.group(1)]
    return midi, int(m.group(3))


def main(config_path: str) -> None:
    cfg = yaml.safe_load(pathlib.Path(config_path).read_text())
    sr, hop = cfg["sample_rate"], cfg["hop"]
    root = pathlib.Path(config_path).resolve().parent.parent
    raw_dir = root / "data" / cfg["name"] / "raw"
    out_dir = root / "data" / cfg["name"] / "features"
    out_dir.mkdir(parents=True, exist_ok=True)
    files = [p for p in sorted(raw_dir.glob("*.flac")) if parse_name(p.stem)]
    if not files:
        sys.exit(f"no Salamander note files in {raw_dir}")
    layers = max(parse_name(p.stem)[1] for p in files)

    def load_mono(path: pathlib.Path) -> np.ndarray:
        data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
        wav = torch.from_numpy(data.mean(axis=1))
        if file_sr != sr:
            wav = torchaudio.functional.resample(wav, file_sr, sr)
        return wav.numpy().astype(np.float32)

    gain_file = out_dir / "gain.txt"
    if gain_file.exists():
        gain = float(gain_file.read_text())
    else:
        peak = max(float(np.abs(load_mono(p)).max()) for p in tqdm(files, desc="peak scan"))
        gain = 0.9 / peak
        gain_file.write_text(str(gain))

    total = 0.0
    for path in tqdm(files, desc=cfg["name"]):
        out = out_dir / (path.stem + ".npz")
        if out.exists():
            continue
        midi, layer = parse_name(path.stem)
        audio = load_mono(path) * gain
        # trim the silent tail past the decay (keeps excerpts meaningful)
        env = np.abs(audio)
        thresh = env.max() * 10 ** (-70 / 20)
        last = int(np.argmax(env[::-1] > thresh))
        audio = audio[: max(hop * 16, len(audio) - last + sr // 2)]
        n = len(audio) // hop
        f0 = np.full(n, 440.0 * 2 ** ((midi - 69) / 12), dtype=np.float32)
        ld = loudness_db(audio, sr, hop)[:n]
        t = (np.arange(n) * hop / sr).astype(np.float32)
        np.savez(
            out,
            audio=audio[: n * hop],
            f0=f0,
            loudness=ld,
            periodicity=np.ones(n, dtype=np.float32),
            velocity=np.full(n, layer / layers, dtype=np.float32),
            onset_age=t,
            release_age=np.zeros(n, dtype=np.float32),
            held=np.ones(n, dtype=np.float32),
        )
        total += n * hop / sr
    print(f"prepared {len(files)} notes, {total / 60:.1f} min -> {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1])
