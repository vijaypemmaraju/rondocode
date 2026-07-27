import type { DspContext, Kernel, SampleBankRO } from './types'

/** Slice/window options for SampleKernel. All optional; omitting every one
 *  plays the whole buffer forward, bit-identical to the pre-slicing kernel. */
export interface SampleSliceConfig {
  /** Window start as a fraction of the buffer, 0..1 (def 0). */
  start?: number
  /** Window end as a fraction of the buffer, 0..1 (def 1). */
  end?: number
  /** Play the window backwards (the read head still advances with `speed`). */
  reverse?: boolean
  /** Divide the window into N equal slices; the `pitch` input picks one.
   *  0/absent = off (the whole window is one slice). */
  slices?: number
  /** Edge fade in SECONDS, applied at both ends of the window so chops do not
   *  click. Default 0.003 when any window option is used, 0 otherwise. */
  fade?: number
}

const finite = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Sample playback voice. Inputs: 'gate' (a rising edge >0.5 retriggers from
 *  the start), optional 'speed' (playback-rate multiplier; 1 = the sample's
 *  natural pitch, 2 = an octave up) and optional 'pitch' (a frequency RATIO,
 *  used only when `slices` is set — see below). Config: the sample `name`,
 *  whether to `loop`, and the slice window. Output is mono; shape the
 *  amplitude with an ADSR like any oscillator.
 *
 *  Pitch/quality:
 *  - Advances the read head by `speed * (sampleRate / engineRate)` per output
 *    sample, so a 44.1k sample plays at natural pitch through a 48k engine.
 *  - Linear interpolation between adjacent frames (v1 — cheap, slight HF loss
 *    when pitched up; good enough for drums, chops, risers).
 *
 *  Slicing:
 *  - `start`/`end` (fractions 0..1) narrow playback to a WINDOW of the buffer.
 *    Everything else (loop, one-shot, speed, reverse) then acts on the window
 *    only — a loop wraps inside it and never leaks the rest of the buffer.
 *  - `slices: N` divides THAT window into N equal slices and the `pitch` input
 *    (a ratio: 1 = the reference note, 2 = an octave above it) picks one,
 *    rounded to the nearest semitone and wrapped mod N. The slice is latched
 *    on the gate edge, so a chop never jumps mid-hit.
 *  - `reverse` mirrors the read inside the window/slice.
 *  - `fade` ramps the window edges (default 3 ms once any window option is in
 *    play) so chopping mid-waveform does not click.
 *
 *  Lifecycle:
 *  - Resolves `name` against the shared bank EACH BLOCK, so a sample loaded
 *    after this synth was compiled starts sounding with no recompile. Missing
 *    name -> silence.
 *  - One-shot (loop=false): plays the window start->end once per gate edge,
 *    then silence until the next edge (drums don't need a held gate).
 *  - loop=true: wraps at the window end and keeps going while gated-or-
 *    triggered.
 *
 *  Hygiene: a non-finite or inverted window (end <= start) falls back to the
 *  whole buffer rather than going silent — the builder rejects those at build
 *  time, so only a hand-written graph can reach the kernel with them. */
export class SampleKernel implements Kernel {
  /** Fractional PHASE inside the current window, in source frames. Always runs
   *  forward-positive with `speed`; `reverse` mirrors the read, not the head. */
  private pos = 0
  private playing = false
  private prevGate = 0
  /** Window latched at the gate edge (source frames, w1 exclusive). */
  private w0 = 0
  private w1 = 0
  private fadeFrames = 0

  private readonly start: number
  private readonly end: number
  private readonly reverse: boolean
  private readonly slices: number
  private readonly fadeSec: number

  constructor(
    private readonly name: string,
    private readonly loop: boolean,
    private readonly bank: SampleBankRO | undefined,
    cfg?: SampleSliceConfig,
  ) {
    let a = clamp01(finite(cfg?.start, 0))
    let b = clamp01(finite(cfg?.end, 1))
    if (!(b > a)) {
      a = 0
      b = 1
    }
    this.start = a
    this.end = b
    this.reverse = cfg?.reverse === true
    const n = Math.floor(finite(cfg?.slices, 0))
    this.slices = n >= 1 ? n : 0
    const windowed = a > 0 || b < 1 || this.slices >= 1 || this.reverse
    const f = finite(cfg?.fade, -1)
    this.fadeSec = f >= 0 ? f : windowed ? 0.003 : 0
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const gate = inputs['gate']!
    const speed = inputs['speed'] // may be absent -> natural rate (1)
    const pitch = inputs['pitch'] // may be absent -> slice 0
    const s = this.bank?.get(this.name)
    if (s === undefined || s.data.length === 0) {
      // Not loaded (yet) — silence, but still track gate edges so a sample that
      // arrives between blocks starts on the NEXT edge, not retroactively.
      for (let i = 0; i < n; i++) {
        this.prevGate = gate[i]!
      }
      out.fill(0, 0, n)
      return
    }
    const data = s.data
    const len = data.length
    const rate = s.sampleRate / ctx.sampleRate

    // The window, in source frames. Recomputed per block because the bank can
    // hand us a different buffer (a fresh resample-to-loop bounce) at any time.
    let f0 = this.start * len
    let f1 = this.end * len
    // A sub-frame window is unplayable — fall back to the whole buffer.
    if (!(f1 - f0 >= 1)) {
      f0 = 0
      f1 = len
    }
    const region = f1 - f0
    // Never more slices than frames (a sub-frame slice cannot be read).
    const nsl = this.slices >= 1 ? Math.min(this.slices, Math.max(1, Math.floor(region))) : 0

    for (let i = 0; i < n; i++) {
      const g = gate[i]!
      if (g > 0.5 && this.prevGate <= 0.5) {
        // Latch the slice on the EDGE: the note that triggered picks the chop.
        let idx = 0
        if (nsl >= 1) {
          const r = pitch !== undefined ? pitch[i]! : 1
          const semis = Number.isFinite(r) && r > 0 ? Math.round(12 * Math.log2(r)) : 0
          idx = ((semis % nsl) + nsl) % nsl
        }
        const w = nsl >= 1 ? region / nsl : region
        this.w0 = f0 + idx * w
        this.w1 = this.w0 + w
        this.fadeFrames = Math.min(this.fadeSec * s.sampleRate, w / 2)
        this.pos = 0
        this.playing = true
      }
      this.prevGate = g

      if (!this.playing) {
        out[i] = 0
        continue
      }

      const w0 = this.w0
      const wlen = this.w1 - w0
      let p = this.pos
      if (this.loop) {
        // wrap into [0, wlen) — works for a NEGATIVE head too (reverse speed);
        // a NaN head (from a prior bad speed) resets rather than sticking.
        p -= Math.floor(p / wlen) * wlen
        if (!Number.isFinite(p)) p = 0
        this.pos = p
      } else if (!(p >= 0 && p < wlen)) {
        // one-shot ran off EITHER end (or went non-finite) — stop cleanly.
        this.playing = false
        out[i] = 0
        continue
      }

      // Offset inside the window: mirrored when reverse, so the window's last
      // frame is heard first and a ramp comes back out exactly reversed.
      let x = this.reverse ? wlen - 1 - p : p
      if (x < 0) x = this.loop ? x + wlen : 0

      const rp = w0 + x
      let i0 = rp | 0
      const frac = rp - i0
      if (i0 >= len) i0 = len - 1 // stale window after a mid-play buffer swap
      const a = data[i0]!
      // Next frame for the interpolation: inside the window, the frame after.
      // Past the window end, a loop wraps to the window start; a one-shot reads
      // the buffer's real next frame if there is one (a window in the middle of
      // a buffer has a true neighbour) and 0 only past the very end, exactly as
      // the un-sliced kernel always did.
      const wStartI = Math.max(0, Math.min(len - 1, Math.floor(w0)))
      const wEndI = Math.min(len, Math.max(wStartI + 1, Math.ceil(this.w1)))
      const i1 = i0 + 1
      const bNext = i1 < wEndI ? data[i1]! : this.loop ? data[wStartI]! : i1 < len ? data[i1]! : 0
      let v = a + frac * (bNext - a)

      // Edge fades: a few ms of ramp at both ends of the window so a chop that
      // starts or stops mid-waveform does not click (nor does a loop wrap).
      const ff = this.fadeFrames
      if (ff > 0) {
        let gain = 1
        if (p < ff) gain = p / ff
        const tail = wlen - p
        if (tail < ff) {
          const gt = tail / ff
          if (gt < gain) gain = gt
        }
        v *= gain
      }
      out[i] = v

      // Sanitize speed: a NaN/Inf multiplier would poison `pos` forever (only a
      // fresh gate edge clears it). Treat non-finite as 0 (freeze) — self-heals.
      const spRaw = speed !== undefined ? speed[i]! : 1
      const sp = Number.isFinite(spRaw) ? spRaw : 0
      this.pos = p + sp * rate
    }
  }

  reset(): void {
    this.pos = 0
    this.playing = false
    this.prevGate = 0
    this.w0 = 0
    this.w1 = 0
    this.fadeFrames = 0
  }
}
