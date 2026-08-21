"""Export a .bin from a training checkpoint WITHOUT finishing the run —
early listens, A/B against later checkpoints, etc.

Usage: uv run python export_ckpt.py configs/violin.yaml [--suffix early]
"""

import argparse
import pathlib

import torch
import yaml

from ddsp.export import export_bin, load_bin
from ddsp.model import Decoder


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--suffix", default="")
    args = ap.parse_args()
    cfg = yaml.safe_load(pathlib.Path(args.config).read_text())
    root = pathlib.Path(args.config).resolve().parent.parent
    run_dir = root / "runs" / cfg["name"]
    ck = torch.load(run_dir / "latest.pt", map_location="cpu", weights_only=True)
    model = Decoder(
        hidden=cfg.get("hidden", 128),
        layers=cfg.get("layers", 3),
        gru=cfg.get("gru", 192),
        n_harmonics=cfg.get("n_harmonics", 64),
        n_noise=cfg.get("n_noise", 65),
        sample_rate=cfg["sample_rate"],
        hop=cfg["hop"],
    )
    model.load_state_dict(ck["model"])
    tag = f"-{args.suffix}" if args.suffix else ""
    out = run_dir / f"ddsp-{cfg['name']}{tag}.bin"
    export_bin(model, str(out), cfg["name"], cfg["license"], cfg["provenance"])
    check = load_bin(str(out))
    n = sum(p.numel() for p in check.parameters())
    print(f"step {ck['step']}: exported {out} ({out.stat().st_size} bytes, {n} params)")


if __name__ == "__main__":
    main()
