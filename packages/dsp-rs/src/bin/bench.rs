//! Native timing of the same workload the wasm/TS benchmark runs:
//! 12 voices x 20000 blocks of 128 samples at 48k. Identical inputs, so the
//! number is directly comparable to the JS figures.
use rondocode_dsp::*;
use std::time::Instant;

fn main() {
    const VOICES: usize = 12;
    const BLOCKS: usize = 20000;
    let sr = 48000.0f32;
    let n = block_size();
    // arena slots: 0=freq 1=detune 2=mix 3=out
    unsafe {
        let a = core::slice::from_raw_parts_mut(arena_ptr(), n * arena_slots());
        for i in 0..n {
            a[i] = 220.0;
            a[n + i] = 0.2;
            a[2 * n + i] = 0.7;
        }
    }
    for v in 0..VOICES {
        supersaw_reset(v);
    }
    // warm
    for v in 0..VOICES {
        supersaw_process(v, n, 0, n, 2 * n, 3 * n, sr);
    }
    let t0 = Instant::now();
    for _ in 0..BLOCKS {
        for v in 0..VOICES {
            supersaw_process(v, n, 0, n, 2 * n, 3 * n, sr);
        }
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let audio_ms = (BLOCKS * n) as f64 / sr as f64 * 1000.0;
    println!(
        "native Rust  {:>6.0} ms for {:.0}s x{} voices → {:.2}% of one core",
        ms,
        audio_ms / 1000.0,
        VOICES,
        ms / audio_ms * 100.0
    );
    println!("  (TypeScript was 316 ms / 0.59%, wasm 444 ms / 0.83%)");
    println!("  native vs TS: {:.2}x    native vs wasm: {:.2}x", 316.0 / ms, 444.0 / ms);
}
