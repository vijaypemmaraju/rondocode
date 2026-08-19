import type { DspContext, Kernel, SampleBankRO } from './types'
import { parseSampleRef, sampleRefName } from '../samples'

/** Slice/window options for SampleKernel. All optional; omitting every one
 *  plays the whole buffer forward, bit-identical to the pre-slicing kernel. */
/** One key zone of a multisample instrument: which notes it covers, which
 *  sample plays them, and the note that sample was recorded at. */
export interface SampleZone {
  /** Lowest MIDI note this zone answers (inclusive). */
  lo: number
  /** Highest MIDI note this zone answers (inclusive). */
  hi: number
  /** Sample name, family and variant like any other (`piano_mid`, `bd:2`). */
  name: string
  /** MIDI note the sample plays back at natural rate. Default 60. */
  root?: number
}

export interface SampleSliceConfig {
  /** KEY ZONES: a different recording per range of the keyboard, each pitched
   *  from its own root.
   *
   *  One buffer stretched across a keyboard is the thing that gives a sampler
   *  away — a piano pitched down two octaves is a different instrument, not a
   *  lower note. Zones are how a real sampler avoids it, and they compose with
   *  families: a zone name may be `piano_mid:2`, so round robin still applies
   *  within the zone.
   *
   *  The zone is latched on the gate edge like the slice, so a note never
   *  changes instrument halfway through. A note outside every zone is silent
   *  rather than borrowing the nearest one, which is the same choice the
   *  family gap makes: substituting a sample nobody asked for sounds
   *  deliberate. */
  zones?: SampleZone[]
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

  /** The family this voice plays, and the variant its NAME asked for. A
   *  `variant` input overrides the latter per note. */
  private readonly base: string
  private readonly nameVariant: number
  /** Variant latched on the last gate edge, so a note keeps the sample it
   *  started on however the input moves afterwards. */
  private variant: number
  /** Key zones, sorted, and what the last gate edge picked. `zoneName`
   *  undefined means "use the plain name"; `zoneRate` is the pitch ratio the
   *  chosen zone implies. */
  private readonly zones: readonly SampleZone[]
  private zoneName: string | undefined
  private zoneRate = 1
  private zoneSilent = false

  constructor(
    private readonly name: string,
    private readonly loop: boolean,
    private readonly bank: SampleBankRO | undefined,
    cfg?: SampleSliceConfig,
  ) {
    const ref = parseSampleRef(name)
    this.base = ref.base
    this.nameVariant = ref.index ?? 0
    this.variant = this.nameVariant
    this.zones = Array.isArray(cfg?.zones) ? cfg.zones.filter((z) => z !== null && typeof z === 'object') : []
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
    const variant = inputs['variant'] // may be absent -> the name's own index
    const nfreq = inputs['nfreq'] // note frequency, for picking a key zone

    /* Resolved from the LATCHED variant, and recomputed below whenever a gate
     * edge selects a different one. Everything here derives from the buffer,
     * so a variant change has to move all of it together.
     *
     * Still re-resolved every block, which is deliberate: the bank can hand us
     * a different buffer for the same name at any time (a resample-to-loop
     * bounce), and a voice mid-note follows it. Latching the BUFFER would have
     * broken that; latching the variant INDEX does not. */
    let data: Float32Array | undefined
    let len = 0
    let rate = 1
    let srcRate = 0
    let region = 0
    let f0 = 0
    let f1 = 0
    let nsl = 0
    const resolve = (): void => {
      const s = this.zoneSilent
        ? undefined
        : this.bank?.get(this.zoneName ?? sampleRefName(this.base, this.variant))
      data = s !== undefined && s.data.length > 0 ? s.data : undefined
      if (s === undefined || data === undefined) return
      len = data.length
      srcRate = s.sampleRate
      rate = s.sampleRate / ctx.sampleRate
      f0 = this.start * len
      f1 = this.end * len
      // A sub-frame window is unplayable — fall back to the whole buffer.
      if (!(f1 - f0 >= 1)) {
        f0 = 0
        f1 = len
      }
      region = f1 - f0
      // Never more slices than frames (a sub-frame slice cannot be read).
      nsl = this.slices >= 1 ? Math.min(this.slices, Math.max(1, Math.floor(region))) : 0
    }
    resolve()

    for (let i = 0; i < n; i++) {
      const g = gate[i]!
      if (g > 0.5 && this.prevGate <= 0.5) {
        /* Latch the VARIANT on the edge too, and re-resolve immediately if it
         * moved, so round-robin is sample-accurate: the note that triggered
         * plays the sample it asked for, not the one the previous note left
         * loaded. A block can hold more than one edge. */
        /* KEY ZONE first: it decides which SAMPLE plays, and the variant then
         * picks among that zone's family. Latched here so a note never
         * changes instrument halfway through. */
        if (this.zones.length > 0) {
          const f = nfreq !== undefined && Number.isFinite(nfreq[i]!) && nfreq[i]! > 0 ? nfreq[i]! : 440
          const midi = 69 + 12 * Math.log2(f / 440)
          const near = Math.round(midi)
          const zone = this.zones.find((z) => near >= z.lo && near <= z.hi)
          if (zone === undefined) {
            // outside every zone: silent, rather than borrowing a neighbour
            this.zoneSilent = true
            this.zoneName = undefined
          } else {
            this.zoneSilent = false
            const root = Number.isFinite(zone.root) ? (zone.root as number) : 60
            this.zoneName = zone.name
            this.zoneRate = f / (440 * Math.pow(2, (root - 69) / 12))
          }
          resolve()
        }
        if (variant !== undefined) {
          const raw = variant[i]!
          const want = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : this.nameVariant
          if (want !== this.variant) {
            this.variant = want
            resolve()
          }
        }
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
        this.fadeFrames = Math.min(this.fadeSec * srcRate, w / 2)
        this.pos = 0
        this.playing = true
      }
      this.prevGate = g

      if (!this.playing || data === undefined) {
        /* Silent, but the gate edge above still ran — so a sample that arrives
         * between blocks, or a variant that exists when the next note asks for
         * it, starts on the NEXT edge rather than retroactively. */
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
      // a zone carries its own root, so the ratio is the kernel's to apply
      this.pos = p + sp * rate * (this.zones.length > 0 ? this.zoneRate : 1)
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
