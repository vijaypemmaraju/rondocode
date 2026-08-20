"""Generate the tiny fixture model + golden vectors that pin the TS runtime to
the PyTorch reference. Outputs are checked into packages/engine/test/fixtures/;
rerun only when SPEC.md changes (then re-commit both files).

Usage: uv run python make_fixture.py
"""

import json
import math
import pathlib

import numpy as np
import torch

from ddsp.export import export_bin, load_bin
from ddsp.model import Decoder, scale_f0, scale_loudness
from ddsp.synth import harmonic

FIXTURES = pathlib.Path(__file__).resolve().parents[2] / "packages/engine/test/fixtures"

def main() -> None:
    torch.manual_seed(1234)
    model = Decoder(
        hidden=6, layers=2, gru=5, n_harmonics=8, n_noise=9, sample_rate=48000, hop=64
    )
    # Nudge weights away from tiny init values so outputs aren't all ~sigmoid(0).
    with torch.no_grad():
        for p in model.parameters():
            p.add_(torch.randn_like(p) * 0.3)

    bin_path = FIXTURES / "ddsp-fixture.bin"
    FIXTURES.mkdir(parents=True, exist_ok=True)
    export_bin(model, str(bin_path), "fixture", "CC0-1.0", "random weights, seed 1234")
    model = load_bin(str(bin_path))  # golden vectors reflect fp16 quantization

    n_frames = 16
    t = np.arange(n_frames)
    f0 = 220.0 * 2.0 ** (t / (n_frames - 1))  # one-octave sweep
    ld = -60.0 + 40.0 * np.sin(t / 3.0) ** 2
    f0_t = torch.from_numpy(f0).float().unsqueeze(0)
    ld_t = torch.from_numpy(ld).float().unsqueeze(0)

    with torch.no_grad():
        out = model(f0_t, ld_t)
        # Intermediates for debugging parity failures, captured stepwise.
        f0s = scale_f0(f0_t).unsqueeze(-1)
        lds = scale_loudness(ld_t).unsqueeze(-1)
        x = torch.cat([model.in_mlp_f0(f0s), model.in_mlp_ld(lds)], dim=-1)
        h, _ = model.gru(x)
        audio = harmonic(f0_t, out["harm_amps"], model.sample_rate, model.hop)

    def lst(a: torch.Tensor) -> list:
        return [round(float(v), 8) for v in a.flatten()]

    golden = {
        "spec_version": 1,
        "frames": {"f0_hz": lst(f0_t), "loudness_db": lst(ld_t)},
        "intermediates": {
            "mlp_concat": [lst(x[0, i]) for i in range(n_frames)],
            "gru_h": [lst(h[0, i]) for i in range(n_frames)],
        },
        "outputs": {
            "amp": lst(out["amp"]),
            "harm_amps": [lst(out["harm_amps"][0, i]) for i in range(n_frames)],
            "noise_mags": [lst(out["noise_mags"][0, i]) for i in range(n_frames)],
        },
        "harmonic_render": {
            "sample_rate": model.sample_rate,
            "hop": model.hop,
            "samples": lst(audio),
        },
    }
    (FIXTURES / "ddsp-golden.json").write_text(json.dumps(golden))
    size = bin_path.stat().st_size
    peak = float(audio.abs().max())
    assert math.isfinite(peak) and peak > 1e-4, "fixture render is silent/broken"
    print(f"wrote {bin_path} ({size} bytes) and ddsp-golden.json (peak {peak:.4f})")


if __name__ == "__main__":
    main()
