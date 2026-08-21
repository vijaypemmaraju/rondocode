# rondo DDSP model spec (format version 1)

This file is the contract between the PyTorch reference (this directory) and the
TypeScript runtime (`packages/engine/src/dsp/ddsp.ts`). The two implementations
are kept honest by golden vectors generated from a fixture model
(`make_fixture.py` writes `packages/engine/test/fixtures/ddsp-fixture.bin` and
`ddsp-golden.json`); any spec change must regenerate them.

## Model

A frame-rate decoder maps two control signals to synthesis parameters.

Inputs per frame (both scalars):

- `f0_scaled = hz_to_midi(f0_hz) / 127`, where `hz_to_midi(f) = 69 + 12*log2(f/440)`
- `ld_scaled = (loudness_db + 90) / 90`, loudness clamped to [-90, 0] dB

Architecture (dims come from the file header, names are fixed):

```
f0_scaled -> in_mlp_f0: [Linear(1,H), LayerNorm(H), LeakyReLU(0.2)] x L
ld_scaled -> in_mlp_ld: [Linear(1,H), LayerNorm(H), LeakyReLU(0.2)] x L
x = concat(mlp_f0_out, mlp_ld_out)          # 2H
h = GRU(x, hidden=G)                         # torch GRU equations, single layer
y = out_mlp(concat(h, f0_scaled, ld_scaled)) # [Linear(G+2,H), LayerNorm(H), LeakyReLU(0.2)] x L
harm = harm_head(y)                          # Linear(H, 1 + n_harmonics)
noise = noise_head(y)                        # Linear(H, n_noise)
```

Default sizes: `H = 128`, `L = 3`, `G = 192`, `n_harmonics = 64`, `n_noise = 65`.

GRU follows torch semantics exactly, including the separate input and hidden
biases: `n = tanh(W_in x + b_in + r * (W_hn h + b_hn))`, gate order `r, z, n`
in the packed weight matrices.

Output transforms (`exp_sigmoid(x) = 2.0 * sigmoid(x)^log(10) + 1e-7`):

- `amp = exp_sigmoid(harm[0])`
- `dist_k = exp_sigmoid(harm[1 + k])`, then zero every k where
  `(k+1) * f0_hz > sample_rate / 2`, then normalize so `sum(dist) = 1`
  (add `1e-7` to the denominator)
- harmonic amplitude `a_k = amp * dist_k`
- `noise_mag_j = exp_sigmoid(noise[j])`

## Synthesis

Frame rate is `sample_rate / hop` (default 48000 / 512 = 93.75 Hz).

- Harmonic: per-sample `f0` and per-harmonic amplitudes linearly interpolated
  between frames. Phase accumulates per harmonic:
  `theta_k += 2*pi * (k+1) * f0 / sr`, output `sum_k a_k * sin(theta_k)`.
  Harmonics above the *model's* Nyquist (`sample_rate` in the header) are zero
  regardless of the runtime rate.
- Noise: per frame, build a linear-phase FIR by `irfft(noise_mags)`
  (n_noise bins -> 2*(n_noise-1) taps), apply a Hann window centered on the
  impulse (roll by half the length), filter uniform white noise in [-1, 1],
  overlap-add at the hop. The runtime may use any uniform noise source; noise
  parity is statistical (band energies), not sample-exact.

Learned reverb is a training-time device only; exported models are dry.

## File format (.bin)

Little-endian throughout.

| bytes | content |
|---|---|
| 4 | magic `RDSP` |
| 4 | u32 format version = 1 |
| 4 | u32 header JSON byte length `n` |
| n | UTF-8 JSON header |
| pad | zero bytes to the next multiple of 4 |
| ... | tensor data, fp16, in header order, each tensor at its stated offset |

Header JSON fields:

```json
{
  "name": "violin",
  "license": "CC0-1.0",
  "provenance": "short human string; full detail in DATA_LICENSES.md",
  "sample_rate": 48000,
  "hop": 512,
  "n_harmonics": 64,
  "n_noise": 65,
  "hidden": 128,
  "layers": 3,
  "gru": 192,
  "out_norm": 1.0,
  "tensors": [{ "name": "in_mlp_f0.0.weight", "shape": [128, 1], "offset": 0 }]
}
```

`out_norm` (optional, default 1, runtime-clamped to [0.05, 20]) is the
per-model output calibration written at export: the model's forte level
(f0 440 Hz, loudness -15 dB) mapped onto a shared reference, so the
runtime's default gain lands every instrument at the same mixable level
regardless of how hot its source recording was.

Tensor offsets are relative to the start of the tensor data section. Tensor
names follow the PyTorch `state_dict` names of `ddsp/model.py::Decoder`.
