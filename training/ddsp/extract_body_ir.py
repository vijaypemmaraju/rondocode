"""Extract per-instrument BODY impulse responses from the trained reverb.

The energy-capped TrainableReverb learned each instrument's body resonances +
early room reflections (that is exactly what the dry additive+noise synth
cannot make, so the optimizer parked it in the IR). Its first ~80 ms is a
usable body IR: convolved over the dry synth in a post chain it restores the
"wood" — fixed resonances that do not move with pitch.

Usage: uv run python extract_body_ir.py            # all instruments
Writes runs/<name>/ddsp-<name>-body.wav (48 kHz mono 16-bit, ~80 ms).
"""

import pathlib

import numpy as np
import soundfile as sf
import torch

INSTRUMENTS = ["violin", "viola", "cello", "bass", "flute", "trumpet", "tenorsax", "piano"]
SR = 48000
BODY_MS = 80


def main() -> None:
    root = pathlib.Path(__file__).parent
    for name in INSTRUMENTS:
        ck_path = root / "runs" / name / "latest.pt"
        if not ck_path.exists():
            print(f"{name}: no checkpoint, skipped")
            continue
        ck = torch.load(ck_path, map_location="cpu", weights_only=True)
        ir = ck["reverb"]["ir"].numpy().astype(np.float64)
        # the reverb applies an energy cap at forward time; reproduce it
        energy = float(np.sum(ir**2))
        if energy > 1.0:
            ir = ir / np.sqrt(energy)
        n = int(SR * BODY_MS / 1000)
        body = ir[:n].copy()
        body[0] = 0.0  # the dry path is added separately (reverb forward does too)
        # half-Hann fade over the last 25% so the truncation doesn't ring
        fade = n // 4
        body[-fade:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(fade) / fade)
        # normalize peak to a sane wet level for convolve-and-mix usage
        peak = np.abs(body).max()
        if peak > 1e-9:
            body = body * (0.5 / peak)
        out = root / "runs" / name / f"ddsp-{name}-body.wav"
        sf.write(out, body.astype(np.float32), SR, subtype="PCM_16")
        tail_e = float(np.sum(ir[n:] ** 2))
        print(f"{name}: body IR {n} samples, capped energy {min(energy,1):.2f}, discarded tail energy {tail_e:.3f} -> {out}")


if __name__ == "__main__":
    main()
