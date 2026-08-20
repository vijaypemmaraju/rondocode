"""Excerpt dataset over precomputed features (prepare.py writes one .npz per
source file: audio, f0, loudness, periodicity)."""

import pathlib

import numpy as np
import torch
from torch.utils.data import Dataset


class ExcerptDataset(Dataset):
    def __init__(
        self,
        features_dir: str,
        hop: int,
        excerpt_frames: int,
        excerpts_per_epoch: int = 4000,
        files: list[str] | None = None,
        seed: int = 0,
    ):
        paths = (
            [pathlib.Path(f) for f in files]
            if files is not None
            else sorted(pathlib.Path(features_dir).glob("*.npz"))
        )
        if not paths:
            raise FileNotFoundError(f"no feature files in {features_dir}")
        self.hop = hop
        self.excerpt_frames = excerpt_frames
        self.excerpts_per_epoch = excerpts_per_epoch
        self.rng = np.random.default_rng(seed)
        self.items = []
        for p in paths:
            z = np.load(p)
            n_frames = min(len(z["f0"]), len(z["loudness"]), len(z["audio"]) // hop)
            if n_frames < 8:
                continue
            audio = z["audio"].astype(np.float32)[: n_frames * hop]
            f0 = z["f0"].astype(np.float32)[:n_frames]
            ld = z["loudness"].astype(np.float32)[:n_frames]
            if n_frames < excerpt_frames:
                # Short files (single pp notes are ~2 s) pad with silence
                # rather than being dropped: dropping them would bias the
                # dataset toward loud playing. Silence = -90 dB loudness with
                # the f0 held, which is also a true fact worth learning.
                pad = excerpt_frames - n_frames
                audio = np.pad(audio, (0, pad * hop))
                f0 = np.pad(f0, (0, pad), mode="edge")
                ld = np.pad(ld, (0, pad), constant_values=-90.0)
                n_frames = excerpt_frames
            self.items.append(
                {"audio": audio, "f0": f0, "loudness": ld, "n_frames": n_frames}
            )
        if not self.items:
            raise ValueError(
                f"no usable feature file in {features_dir}"
            )

    def __len__(self) -> int:
        return self.excerpts_per_epoch

    def __getitem__(self, _idx: int) -> dict[str, torch.Tensor]:
        item = self.items[self.rng.integers(len(self.items))]
        start = int(self.rng.integers(item["n_frames"] - self.excerpt_frames + 1))
        end = start + self.excerpt_frames
        audio = item["audio"][start * self.hop : end * self.hop]
        return {
            "audio": torch.from_numpy(audio.copy()),
            "f0": torch.from_numpy(item["f0"][start:end].copy()),
            "loudness": torch.from_numpy(item["loudness"][start:end].copy()),
        }
