"""Generate the tiny fixture models + golden vectors that pin the TS runtime to
the PyTorch reference. Outputs are checked into packages/engine/test/fixtures/.

Two fixtures:
  - ddsp-fixture.bin / ddsp-golden.json — the FROZEN v1-format artifact
    (tensor names in_mlp_f0 / in_mlp_ld, no `inputs` header field). It is
    never regenerated: it exists precisely to prove shipped v1 models keep
    loading. Rerunning this script leaves it alone unless it is missing.
  - ddsp-fixture-v2.bin / ddsp-golden-v2.json — a struck, inharmonic model
    conditioned on [f0, velocity, onset_age, release_age], exercising the v2
    paths: named inputs, per-MIDI inharmonicity, per-partial phases.

Usage: uv run python make_fixture.py
"""

import json
import math
import pathlib

import numpy as np
import torch

from ddsp.export import export_bin, load_bin
from ddsp.model import Decoder, scale_feature
from ddsp.synth import harmonic

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "packages/engine/test/fixtures"


def lst(a: torch.Tensor) -> list:
    return [round(float(v), 8) for v in a.flatten()]


def make_v2() -> None:
    torch.manual_seed(4321)
    inputs = ["f0", "velocity", "onset_age", "release_age"]
    model = Decoder(
        hidden=6, layers=2, gru=5, n_harmonics=8, n_noise=9, sample_rate=48000, hop=64,
        inputs=inputs, inharmonic=True,
    )
    with torch.no_grad():
        for name, p in model.named_parameters():
            if name != "log_b":
                p.add_(torch.randn_like(p) * 0.3)
        # an exaggerated, clearly non-harmonic stretch so the test bites
        model.log_b.copy_(torch.log(torch.linspace(2e-4, 8e-3, 128)))

    bin_path = FIXTURES / "ddsp-fixture-v2.bin"
    export_bin(model, str(bin_path), "fixture-v2", "CC0-1.0", "random weights, seed 4321, struck+inharmonic")
    model = load_bin(str(bin_path))  # goldens reflect fp16 weights + fp32 B table rounding

    n_frames = 16
    t = np.arange(n_frames)
    feats_np = {
        "f0": 110.0 * 2.0 ** (t / 10.0),
        "velocity": 0.2 + 0.75 * (t % 4) / 3.0,
        "onset_age": t * 0.07,
        "release_age": np.maximum(0, t - 9) * 0.07,
    }
    feats = {k: torch.from_numpy(v).float().unsqueeze(0) for k, v in feats_np.items()}
    with torch.no_grad():
        out = model(feats)
        scaled = [scale_feature(n, feats[n]).unsqueeze(-1) for n in inputs]
        x = torch.cat([model.in_mlps[n](s) for n, s in zip(inputs, scaled)], dim=-1)
        h, _ = model.gru(x)
        audio = harmonic(feats["f0"], out["harm_amps"], model.sample_rate, model.hop, out["partial_mult"])

    golden = {
        "spec_version": 2,
        "inputs": inputs,
        "features": {k: lst(v) for k, v in feats.items()},
        "intermediates": {
            "mlp_concat": [lst(x[0, i]) for i in range(n_frames)],
            "gru_h": [lst(h[0, i]) for i in range(n_frames)],
        },
        "outputs": {
            "amp": lst(out["amp"]),
            "harm_amps": [lst(out["harm_amps"][0, i]) for i in range(n_frames)],
            "noise_mags": [lst(out["noise_mags"][0, i]) for i in range(n_frames)],
            "partial_mult": [lst(out["partial_mult"][0, i]) for i in range(n_frames)],
        },
        "harmonic_render": {"sample_rate": model.sample_rate, "hop": model.hop, "samples": lst(audio)},
    }
    (FIXTURES / "ddsp-golden-v2.json").write_text(json.dumps(golden))
    peak = float(audio.abs().max())
    assert math.isfinite(peak) and peak > 1e-4, "v2 fixture render is silent/broken"
    print(f"wrote {bin_path} ({bin_path.stat().st_size} bytes) and ddsp-golden-v2.json (peak {peak:.4f})")


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    if not (FIXTURES / "ddsp-fixture.bin").exists():
        raise SystemExit(
            "the frozen v1 fixture is missing; it must be restored from git, not regenerated "
            "(the v2 exporter cannot produce v1 tensor names)"
        )
    make_v2()


if __name__ == "__main__":
    main()
