# rondo DDSP training

Trains the instrument models behind the engine's `ddsp` synth. PyTorch
reimplementation of DDSP (harmonic-plus-noise, multi-scale spectral loss),
sized for real-time TypeScript inference. `SPEC.md` is the contract with the
runtime; `make_fixture.py` regenerates the parity fixtures in
`packages/engine/test/fixtures/`.

Not part of the pnpm workspace. Uses [uv](https://docs.astral.sh/uv/):

```sh
uv sync                                    # once
uv run python make_smoke_data.py           # synthetic data
uv run python train.py configs/smoke.yaml  # 300-step pipeline check

# Real instrument, local (MPS):
#   1. drop solo recordings into data/<name>/raw/  (license notes -> DATA_LICENSES.md)
uv run python prepare.py configs/violin.yaml
uv run python train.py configs/violin.yaml

# Same thing on a Modal A10G (see modal_app.py header for volume setup):
uv run --extra modal modal run modal_app.py --config configs/violin.yaml
```

Outputs land in `runs/<name>/`: `latest.pt` (resumable checkpoint), `log.jsonl`
(train/eval loss), and `ddsp-<name>.bin` (the shipped fp16 model, ~1 MB).
Models are dry: the learned reverb absorbs the room during training and is
discarded at export.

`data/` and `runs/` are gitignored; only code, configs, and licensing notes
are committed. Shipped weights upload to `models.rondocode.com/ddsp/v1/`.
