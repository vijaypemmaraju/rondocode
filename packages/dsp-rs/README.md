# @rondocode/dsp-rs — a spike, not a dependency

Two DSP kernels ported to Rust to answer one question: **would a shared Rust
backend (wasm in the browser, native in a plugin) be worth it?**

Nothing imports this. It is not in the app build, not in CI, and not in the
pnpm workspace's test run. It exists so the next person does not have to redo
the experiment.

## The answer: performance is a modest win, and the first measurement was wrong

Same workload throughout — 12 voices x 20,000 blocks of 128 samples at 48 kHz,
identical inputs, measured on an M-series Mac.

| kernel | TypeScript (V8) | Rust → wasm | native Rust |
| --- | --- | --- | --- |
| **ADSR** (branch-heavy) | 167 ms | **107 ms — 1.56x** | not measured |
| **supersaw** (arithmetic-heavy) | 328 ms | **291 ms — 1.13x** | **290 ms — 1.09x** |

### The wrong answer, and why it was wrong

The first supersaw run had wasm at 0.71x and native at 0.79x — i.e. Rust LOSING
to the JIT — and that was reported as a finding. It was not. It was one
unoptimised implementation with an obvious hot spot:

`no_std` has no `f32::floor`, so the phase wrap used a hand-rolled floor (int
cast + branch) and that dominated the loop. The wrap never needed a general
floor at all: `dt` is clamped to +-0.5 and `p` is in [0,1), so `np` is in
(-0.5, 1.5) and two compares suffice. That one line took wasm from 444 ms to
291 ms and flipped the conclusion.

The lesson worth keeping: `no_std` silently removes every float intrinsic, and
hand-rolling them will quietly cost more than the DSP does. The ADSR's `exp64`
is the same shape of problem and is probably still leaving time on the table —
so these numbers are a FLOOR, not a ceiling. Use `libm` (needs crates.io
reachable) or the wasm instructions directly.

Absolute cost is under 1% of a core in every case, so speed is still not a
reason to do this. What changed is that it is no longer a reason NOT to.

**The one real argument for the port remains: a VST3/CLAP cannot run
TypeScript.** That is a cost you pay for a plugin, not an upgrade to the engine.

## What the spike DID establish

- **The method works.** `renderOffline` is a golden oracle: render the same
  patch through TS and Rust and diff the samples. It caught a real bug in
  minutes that reading would not have — the ADSR attack reached 1.0 one sample
  late.
- **Zero dependencies is achievable.** No wasm-bindgen; raw exports over a
  static arena in linear memory, one call per block. 5.6 KB of wasm. Builds
  offline (crates.io is unreachable from this machine; the wasm32 target is
  not).
- **Precision is per-kernel, not a global rule.** This is the trap:
  - ADSR accumulates `level` in a JS **number (f64)** and narrows on write →
    the Rust needs an **f64** accumulator. With f32 it drifts a whole sample.
  - supersaw stores phases in a **Float32Array (f32)** but does its per-sample
    arithmetic in **f64** → needs f32 state with f64 intermediates.
  Two kernels, two different answers. Multiply by ~30.

With matched precision the ADSR is bit-identical on 4 of 5 cases and one ULP
(6e-8) on the fifth. The supersaw port here still uses f32 arithmetic and so
differs by ~1e-4 — left as-is deliberately, as the evidence for the point above.

## Running it

```sh
cd packages/dsp-rs
cargo build --release --target wasm32-unknown-unknown   # 5.6 KB module
cargo run --release --bin bench                         # native timing
```

The TS-vs-wasm diff and benchmark harnesses were scratch scripts; they
instantiate the .wasm in Node, share a `Float32Array` view over `arena_ptr()`,
and call the same kernel both ways. Rebuilding them is ~40 lines.
