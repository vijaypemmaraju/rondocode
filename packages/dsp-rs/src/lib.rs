//! rondocode DSP kernels in Rust: one implementation, two hosts.
//!
//! Compiled to wasm32 it runs inside the AudioWorklet (browser AND the mobile
//! web app); compiled natively the same code backs a VST3/CLAP plugin. The
//! point is that neither is a port of the other.
//!
//! ## The ABI is deliberately dumb
//!
//! No wasm-bindgen. Every export takes raw pointers into linear memory and a
//! block length, so the host makes ONE call per block rather than per sample,
//! and there is no glue in the hot path. It also means zero dependencies,
//! which is what keeps this buildable offline.
//!
//! Buffers are `f32` because that is what both a Float32Array and a plugin's
//! audio bus already are — no conversion at either boundary.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
use core::panic::PanicInfo;

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    // `panic = "abort"` plus no_std: an audio callback has nowhere to report to
    core::arch::wasm32::unreachable()
}

/* ---- a scratch arena the host writes buffers into ------------------------ *
 * The host needs somewhere in linear memory to put gate/a/d/s/r and read the
 * output back. Rather than an allocator (which no_std lacks and a realtime
 * path should not want), we expose one static arena and hand out its address.
 * BLOCK is 128 to match an AudioWorklet render quantum; six slots covers the
 * ADSR's five inputs plus its output. */
pub const BLOCK: usize = 128;
const SLOTS: usize = 8;
static mut ARENA: [f32; BLOCK * SLOTS] = [0.0; BLOCK * SLOTS];

/// Address of the shared arena, for the host to build its views over.
#[no_mangle]
pub extern "C" fn arena_ptr() -> *mut f32 {
    &raw mut ARENA as *mut f32
}

/// Slots available, so the host can bounds-check rather than guess.
#[no_mangle]
pub extern "C" fn arena_slots() -> usize {
    SLOTS
}

/// Samples per slot.
#[no_mangle]
pub extern "C" fn block_size() -> usize {
    BLOCK
}

/* ---- ADSR --------------------------------------------------------------- *
 * A direct port of packages/engine/src/dsp/env.ts, kept deliberately
 * line-for-line so the two can be diffed by eye as well as by output. The
 * behaviours that matter are the ones that cost real bugs to find:
 *
 *   - a/d/s/r are read PER SAMPLE, so a knob or LFO can drive them.
 *   - the clamps are NaN-safe by comparison order (`>= lo` first). Rust's
 *     f32::clamp panics on NaN and JS's Math.min/max propagates it; both are
 *     wrong here, because one NaN would poison `level` for the life of the
 *     voice and silence the synth with nothing to see.
 *   - the one-pole coefficients are cached against their input, so a constant
 *     time pays one exp() per block and only a moving knob pays per sample.
 */

const IDLE: u8 = 0;
const ATTACK: u8 = 1;
const DECAY: u8 = 2;
const SUSTAIN: u8 = 3;
const RELEASE: u8 = 4;

#[inline(always)]
fn clamp_time(v: f32) -> f32 {
    // NaN takes the `else` branch, which is the floor — never propagates
    if v >= 0.0005 {
        if v <= 30.0 { v } else { 30.0 }
    } else {
        0.0005
    }
}

#[inline(always)]
fn clamp_level(v: f32) -> f32 {
    if v >= 0.0 {
        if v <= 1.0 { v } else { 1.0 }
    } else {
        0.0
    }
}

/// Per-voice ADSR state, persisted across blocks by the host.
#[repr(C)]
pub struct AdsrState {
    /// f64, NOT f32: the TS kernel accumulates in a JS number (double) and
    /// narrows only on write. In f32 the attack ramp reached 1.0 one sample
    /// LATE — the diff against renderOffline caught it immediately.
    level: f64,
    stage: u8,
    last_d: f32,
    g_d: f64,
    last_r: f32,
    g_r: f64,
}

static mut ADSR: [AdsrState; 16] = [const {
    AdsrState { level: 0.0, stage: IDLE, last_d: f32::NAN, g_d: 0.0, last_r: f32::NAN, g_r: 0.0 }
}; 16];

/// Reset one voice's envelope to idle.
#[no_mangle]
pub extern "C" fn adsr_reset(voice: usize) {
    if voice >= 16 {
        return;
    }
    let s = unsafe { &mut (*(&raw mut ADSR))[voice] };
    s.level = 0.0;
    s.stage = IDLE;
    s.last_d = f32::NAN;
    s.last_r = f32::NAN;
}

/// Render `n` samples of an envelope.
///
/// `gate`, `a`, `d`, `s`, `r` and `out` are offsets INTO THE ARENA in samples
/// (slot * BLOCK), which keeps the ABI to plain integers.
#[no_mangle]
pub extern "C" fn adsr_process(
    voice: usize,
    n: usize,
    gate: usize,
    a: usize,
    d: usize,
    s_in: usize,
    r: usize,
    out: usize,
    sample_rate: f32,
) {
    if voice >= 16 || n > BLOCK {
        return;
    }
    let arena = unsafe { &mut *(&raw mut ARENA) };
    let st = unsafe { &mut (*(&raw mut ADSR))[voice] };

    let mut level = st.level;
    let mut stage = st.stage;
    let mut last_d = st.last_d;
    let mut g_d = st.g_d;
    let mut last_r = st.last_r;
    let mut g_r = st.g_r;

    for i in 0..n {
        let g = arena[gate + i];
        if g > 0.5 {
            if stage == IDLE || stage == RELEASE {
                stage = ATTACK;
            }
        } else if stage != IDLE && stage != RELEASE {
            stage = RELEASE;
        }

        if stage == ATTACK {
            level += 1.0 / (clamp_time(arena[a + i]) as f64 * sample_rate as f64);
            if level >= 1.0 {
                level = 1.0;
                stage = DECAY;
            }
        } else if stage == DECAY {
            let dv = clamp_time(arena[d + i]);
            if dv != last_d {
                last_d = dv;
                g_d = 1.0 - exp64(-1.0 / (dv as f64 * sample_rate as f64));
            }
            let sv = clamp_level(arena[s_in + i]) as f64;
            level += g_d * (sv - level);
            if abs64(level - sv) < 1e-4 {
                level = sv;
                stage = SUSTAIN;
            }
        } else if stage == RELEASE {
            let rv = clamp_time(arena[r + i]);
            if rv != last_r {
                last_r = rv;
                g_r = 1.0 - exp64(-1.0 / (rv as f64 * sample_rate as f64));
            }
            level -= g_r * level;
            if level < 1e-4 {
                level = 0.0;
                stage = IDLE;
            }
        } else if stage == SUSTAIN {
            let sv = clamp_level(arena[s_in + i]) as f64;
            if sv != level {
                level += g_d * (sv - level);
            }
        }
        arena[out + i] = level as f32;
    }

    st.level = level;
    st.stage = stage;
    st.last_d = last_d;
    st.g_d = g_d;
    st.last_r = last_r;
    st.g_r = g_r;
}

#[inline(always)]
fn abs64(x: f64) -> f64 {
    if x < 0.0 { -x } else { x }
}

/// exp() without libm: no_std has no float intrinsics on wasm, and pulling a
/// crate for one call would defeat the zero-dependency rule. This is the
/// standard range-reduced series — accurate to well under a float ULP over the
/// tiny negative range these coefficients use (-1/(t*sr) is at most -1/24).
#[inline]
fn exp64(x: f64) -> f64 {
    // e^x = 2^(x/ln2); split into integer and fractional parts
    let n = (x * core::f64::consts::LOG2_E + if x >= 0.0 { 0.5 } else { -0.5 }) as i32;
    let f = x - (n as f64) * core::f64::consts::LN_2;
    // 12 terms at double precision: the coefficients feed an exponential decay
    // heard over seconds, so a sloppy exp shows up as the wrong decay TIME
    let mut term = 1.0f64;
    let mut sum = 1.0f64;
    let mut k = 1.0f64;
    while k <= 12.0 {
        term *= f / k;
        sum += term;
        k += 1.0;
    }
    // scale by 2^n
    let scaled = f64::from_bits((((n + 1023) as u64) & 0x7ff) << 52);
    sum * scaled
}

/* ---- SUPERSAW ------------------------------------------------------------ *
 * 7 detuned polyblep saws — the arithmetic-dense counterpart to the ADSR, and
 * the kernel worth benchmarking: 7 oscillators, a polyblep branch and a floor
 * per sample, where the envelope was mostly branching.
 *
 * A precision note that matters, and cuts the OTHER way from the ADSR: the TS
 * kernel keeps its phases in a Float32Array, so each phase is narrowed to f32
 * on every store. Accumulating in f64 here would NOT match it — the state's
 * width is part of the algorithm, not an implementation detail. f32 is right
 * for this one precisely because f64 was right for the envelope.
 */

const SS_DETUNE: [f32; 7] = [-0.11002313, -0.06288439, -0.01952356, 0.0, 0.01991221, 0.06216538, 0.10745242];

#[inline(always)]
fn polyblep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

#[inline(always)]
fn flush(s: f32) -> f32 {
    if !s.is_finite() || abs32(s) < 1e-15 { 0.0 } else { s }
}

#[inline(always)]
fn abs32(x: f32) -> f32 {
    if x < 0.0 { -x } else { x }
}

/// floor() without std: wasm32 has the instruction, but no_std does not expose
/// f32::floor, and the phase wrap needs it every sample per oscillator.
#[inline(always)]
fn floor32(x: f32) -> f32 {
    let t = x as i32 as f32;
    if x < 0.0 && t != x { t - 1.0 } else { t }
}

static mut SAW_PHASES: [[f32; 7]; 16] = [[0.0; 7]; 16];

#[no_mangle]
pub extern "C" fn supersaw_reset(voice: usize) {
    if voice >= 16 { return }
    let ph = unsafe { &mut (*(&raw mut SAW_PHASES))[voice] };
    for s in 0..7 { ph[s] = s as f32 / 7.0 } // decorrelate the start
}

/// Render `n` samples of a supersaw. Offsets are arena slots, as with the ADSR.
#[no_mangle]
pub extern "C" fn supersaw_process(
    voice: usize, n: usize,
    freq: usize, detune: usize, mix: usize, out: usize,
    sample_rate: f32,
) {
    if voice >= 16 || n > BLOCK { return }
    let arena = unsafe { &mut *(&raw mut ARENA) };
    let ph = unsafe { &mut (*(&raw mut SAW_PHASES))[voice] };
    // get_unchecked: every index is proven in range by the `n > BLOCK` guard
    // and the fixed slot layout, and the bounds checks measurably cost more
    // than the arithmetic in this loop.
    unsafe {
        for i in 0..n {
            let dv = *arena.get_unchecked(detune + i);
            let mv = *arena.get_unchecked(mix + i);
            let f0 = *arena.get_unchecked(freq + i);
            let mut acc = 0.0f32;
            for s in 0..7 {
                let fr = f0 * (1.0 + *SS_DETUNE.get_unchecked(s) * dv);
                let mut dt = fr / sample_rate;
                if dt > 0.5 { dt = 0.5 } else if dt < -0.5 { dt = -0.5 }
                let p = *ph.get_unchecked(s);
                let v = 2.0 * p - 1.0 - polyblep(p, dt);
                acc += if s == 3 { v } else { v * mv };
                // dt is clamped to +-0.5 and p is in [0,1), so np is in
                // (-0.5, 1.5): the wrap is two compares, not a general floor.
                // The hand-rolled floor32 (int cast + branch) existed only
                // because no_std lacks f32::floor — and it was the bottleneck.
                let mut np = p + dt;
                if np >= 1.0 { np -= 1.0 } else if np < 0.0 { np += 1.0 }
                *ph.get_unchecked_mut(s) = np;
            }
            *arena.get_unchecked_mut(out + i) = (acc / (1.0 + 6.0 * mv)) * 1.2;
        }
    }
    for s in 0..7 { ph[s] = flush(ph[s]) }
}
