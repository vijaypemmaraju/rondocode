"""Objective quality gate for an exported model (the fp16 .bin, i.e. exactly
what ships):

1. Held-out resynthesis: render the decoder dry over holdout (f0, loudness)
   curves and report multi-scale spectral loss vs the real audio, plus how
   well rendered loudness tracks the conditioning.
2. Parity vectors: 48 decoder frames (inputs + outputs) written next to the
   .bin for scripts/verify-ddsp-model.ts, which runs the same frames through
   the TS runtime and must match.

Usage: uv run python verify.py configs/violin.yaml
"""

import json
import pathlib
import sys

import numpy as np
import torch
import yaml

from ddsp.export import load_bin
from ddsp.features import loudness_db
from ddsp.losses import multiscale_stft_loss
from ddsp.synth import render


def main(config_path: str) -> None:
    cfg = yaml.safe_load(pathlib.Path(config_path).read_text())
    root = pathlib.Path(config_path).resolve().parent.parent
    run_dir = root / "runs" / cfg["name"]
    model = load_bin(str(run_dir / f"ddsp-{cfg['name']}.bin"))
    features_dir = root / "data" / cfg["name"] / "features"
    files = sorted(features_dir.glob("*.npz"))
    holdout = files[: max(1, len(files) // 10)]
    if not holdout:
        sys.exit(f"no features in {features_dir}")

    # 1. held-out resynthesis quality
    losses = []
    ld_errs = []
    with torch.no_grad():
        for p in holdout[:24]:
            z = np.load(p)
            n = min(len(z["f0"]), len(z["loudness"]), len(z["audio"]) // model.hop)
            if n < 32:
                continue
            f0 = torch.from_numpy(z["f0"][:n]).float().unsqueeze(0)
            ld = torch.from_numpy(z["loudness"][:n]).float().unsqueeze(0)
            target = torch.from_numpy(z["audio"][: n * model.hop]).float().unsqueeze(0)
            out = model(f0, ld)
            dry = render(
                f0, out["harm_amps"], out["noise_mags"], model.sample_rate, model.hop
            )
            losses.append(float(multiscale_stft_loss(dry, target)))
            got_ld = loudness_db(dry[0].numpy(), model.sample_rate, model.hop)[:n]
            want = z["loudness"][:n]
            aud = want > -70  # only where the target is actually sounding
            if aud.any():
                ld_errs.append(float(np.mean(np.abs(got_ld[aud] - want[aud]))))
    report = {
        "name": cfg["name"],
        "holdout_files": len(losses),
        "spectral_loss_mean": round(float(np.mean(losses)), 3),
        "spectral_loss_worst": round(float(np.max(losses)), 3),
        "loudness_track_mae_db": round(float(np.mean(ld_errs)), 2),
    }

    # 2. parity vectors for the TS runtime
    t = np.arange(48)
    f0v = 220.0 * 2 ** (t / 47.0)
    ldv = -60.0 + 35.0 * np.sin(t / 5.0) ** 2
    with torch.no_grad():
        out = model(
            torch.from_numpy(f0v).float().unsqueeze(0),
            torch.from_numpy(ldv).float().unsqueeze(0),
        )
    vec = {
        "f0_hz": [round(float(v), 6) for v in f0v],
        "loudness_db": [round(float(v), 6) for v in ldv],
        "harm_amps": [[round(float(v), 8) for v in row] for row in out["harm_amps"][0]],
        "noise_mags": [[round(float(v), 8) for v in row] for row in out["noise_mags"][0]],
    }
    vec_path = run_dir / f"ddsp-{cfg['name']}.vectors.json"
    vec_path.write_text(json.dumps(vec))

    (run_dir / "verify.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(f"parity vectors -> {vec_path}")


if __name__ == "__main__":
    main(sys.argv[1])
