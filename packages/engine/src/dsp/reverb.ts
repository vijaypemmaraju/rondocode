import type { DspContext, Kernel } from './types'
import { clamp } from './util'

export interface ReverbConfig {
  /** Room size 0..1: sets the comb feedback (0.70..0.98), i.e. tail length.
   *  Default 0.7. */
  roomSize?: number
  /** Damping 0..1: a one-pole lowpass in each comb's feedback path. Higher =
   *  darker, faster high-frequency decay. Default 0.5. */
  damp?: number
}

// Freeverb tunings, in samples at 44100 Hz (Schroeder-Moorer). Scaled to the
// actual sample rate at construction so the room character holds at any sr.
const COMB_TUNINGS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNINGS = [556, 441, 341, 225]
const REF_SR = 44100
const FIXED_GAIN = 0.015
const AP_FEEDBACK = 0.5

const scaleLen = (len: number, sr: number): number => Math.max(1, Math.round((len * sr) / REF_SR))

// Inaudible-tail floor (~ -80 dBFS). When a block's input AND output both stay
// under this, the reverb is drained and everything is scrubbed to exact 0. A
// scalar flush (util.flush, 1e-15) can't do this: the tail energy lives spread
// across the comb ring buffers and decays only ~feedback per round trip, so an
// impulse still leaves a ~1e-6 tail after 2 s of silence. This higher,
// whole-reverb cutoff lets a silent tail settle to true zero within ~1 s of
// silence (so denormals never persist and CPU doesn't churn on sub-audible
// mush) at the cost of truncating the reverb below -80 dB — inaudible once the
// feeding voice itself has gone silent.
const SETTLE_FLOOR = 1e-4

/** Mono Freeverb (Schroeder-Moorer). Eight parallel comb filters — each with a
 *  one-pole lowpass in its feedback path ("damping") — are summed, then fed
 *  through four allpass filters in series. Output is the WET signal only; the
 *  graph mixes dry/wet via `.mix`.
 *
 *  Per sample, per comb:  out = buf[i]; store = out*damp2 + store*damp1;
 *  buf[i] = input + store*feedback; i = (i+1) % size.  The summed comb output
 *  is then chained through the allpasses:  bufout = buf[i]; out = -input +
 *  bufout; buf[i] = input + bufout*0.5; i = (i+1) % size.
 *
 *  Config (NOT per-sample inputs in v1): roomSize -> feedback =
 *  clamp(roomSize,0,1)*0.28 + 0.7 (0.70..0.98); damp -> damp1 =
 *  clamp(damp,0,1)*0.4, damp2 = 1 - damp1. To modulate these live would mean
 *  re-deriving them per sample; deferred (a per-synth post-chain concern).
 *
 *  Buffers: all comb/allpass ring buffers are allocated at construction from
 *  ctx.sampleRate (like delay.ts), so steady-state process() is
 *  allocation-free. Without ctx they allocate lazily on the first process()
 *  call (test symmetry with delay); construction sample rate is assumed to
 *  match the process-time ctx.
 *
 *  NaN/denormal hygiene: at block end each comb's filterstore is scrubbed with
 *  the flush idiom (sub-1e-15 or non-finite -> 0), catching the recirculating
 *  NaN path. Separately, when a whole block's input AND output are both below
 *  SETTLE_FLOOR (~ -80 dBFS) the reverb has drained, so every ring buffer +
 *  filterstore is zeroed — a silent tail reaches EXACT 0 within ~1 s (the comb
 *  buffers decay only ~feedback per round trip, so a scalar flush alone would
 *  leave a ~1e-6 tail after 2 s). See SETTLE_FLOOR.
 *
 *  Memory/placement: this is intended for a per-synth post-chain, but in v1 it
 *  runs PER VOICE. Ring-buffer storage is (sum of all tunings) * 4 bytes scaled
 *  by sr/44100 — the tunings sum to 12587 samples, so ~50 KB at 44.1 kHz and
 *  ~54 KB per instance at 48 kHz. One reverb per simultaneous voice adds up; a
 *  shared post-chain is future work. */
export class ReverbKernel implements Kernel {
  private readonly feedback: number
  private readonly damp1: number
  private readonly damp2: number
  private readonly combSizes: number[]
  private readonly apSizes: number[]

  private combBufs: Float32Array[] | null = null
  private apBufs: Float32Array[] | null = null
  private readonly combIdx = new Int32Array(COMB_TUNINGS.length)
  private readonly apIdx = new Int32Array(ALLPASS_TUNINGS.length)
  private readonly filterStore = new Float64Array(COMB_TUNINGS.length)
  /** Freeverb stereo-spread, in reference samples, added to every tuning (see
   *  DspContext.spread). 0 for the standard/left reverb; nonzero on the
   *  post-chain's right instance decorrelates the two channels. */
  private readonly spread: number

  constructor(config: ReverbConfig = {}, ctx?: DspContext) {
    this.feedback = clamp(config.roomSize ?? 0.7, 0, 1) * 0.28 + 0.7
    this.damp1 = clamp(config.damp ?? 0.5, 0, 1) * 0.4
    this.damp2 = 1 - this.damp1
    this.spread = Math.max(0, Math.round(ctx?.spread ?? 0))
    // Sizes depend on sr; when ctx is absent we still need placeholders, so
    // compute them lazily too. Store the reference tunings and resolve on alloc.
    const sr = ctx?.sampleRate ?? REF_SR
    this.combSizes = COMB_TUNINGS.map((t) => scaleLen(t + this.spread, sr))
    this.apSizes = ALLPASS_TUNINGS.map((t) => scaleLen(t + this.spread, sr))
    if (ctx) this.alloc(ctx.sampleRate)
  }

  private alloc(sr: number): void {
    const sp = this.spread
    for (let c = 0; c < COMB_TUNINGS.length; c++) this.combSizes[c] = scaleLen(COMB_TUNINGS[c]! + sp, sr)
    for (let a = 0; a < ALLPASS_TUNINGS.length; a++) this.apSizes[a] = scaleLen(ALLPASS_TUNINGS[a]! + sp, sr)
    this.combBufs = this.combSizes.map((s) => new Float32Array(s))
    this.apBufs = this.apSizes.map((s) => new Float32Array(s))
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const input = inputs['in']!
    // Lazy fallback (no-ctx construction only).
    const combBufs = this.combBufs ?? (this.alloc(ctx.sampleRate), this.combBufs!)
    const apBufs = this.apBufs!
    const combSizes = this.combSizes
    const apSizes = this.apSizes
    const combIdx = this.combIdx
    const apIdx = this.apIdx
    const filterStore = this.filterStore
    const feedback = this.feedback
    const damp1 = this.damp1
    const damp2 = this.damp2
    const numCombs = combBufs.length
    const numAp = apBufs.length

    let inPeak = 0
    let outPeak = 0
    for (let s = 0; s < n; s++) {
      const xin = input[s]!
      const ax = xin < 0 ? -xin : xin
      if (ax > inPeak) inPeak = ax
      const fed = xin * FIXED_GAIN
      // parallel comb bank
      let wet = 0
      for (let c = 0; c < numCombs; c++) {
        const buf = combBufs[c]!
        const size = combSizes[c]!
        let i = combIdx[c]!
        const o = buf[i]!
        const store = o * damp2 + filterStore[c]! * damp1
        filterStore[c] = store
        buf[i] = fed + store * feedback
        i++
        if (i >= size) i = 0
        combIdx[c] = i
        wet += o
      }
      // series allpass chain
      for (let a = 0; a < numAp; a++) {
        const buf = apBufs[a]!
        const size = apSizes[a]!
        let i = apIdx[a]!
        const bufout = buf[i]!
        const o = -wet + bufout
        buf[i] = wet + bufout * AP_FEEDBACK
        i++
        if (i >= size) i = 0
        apIdx[a] = i
        wet = o
      }
      out[s] = wet
      const aw = wet < 0 ? -wet : wet
      if (aw > outPeak) outPeak = aw
    }

    // Block-end hygiene: scrub each comb's filterstore (the recirculating
    // state) below 1e-15 or non-finite to exact 0, so a NaN cannot persist in
    // the feedback path.
    for (let c = 0; c < numCombs; c++) {
      const v = filterStore[c]!
      if (!Number.isFinite(v) || Math.abs(v) < 1e-15) filterStore[c] = 0
    }
    // Whole-reverb settle: nothing audible entering or leaving -> drain the
    // ring buffers to exact 0 so silent tails don't decay forever (see
    // SETTLE_FLOOR). Never fires while a voice is feeding the reverb, so it is
    // block-boundary invariant for any non-silent signal.
    if (inPeak < SETTLE_FLOOR && outPeak < SETTLE_FLOOR) {
      for (let c = 0; c < numCombs; c++) {
        combBufs[c]!.fill(0)
        filterStore[c] = 0
      }
      for (let a = 0; a < numAp; a++) apBufs[a]!.fill(0)
    }
  }

  reset(): void {
    this.combIdx.fill(0)
    this.apIdx.fill(0)
    this.filterStore.fill(0)
    this.combBufs?.forEach((b) => b.fill(0))
    this.apBufs?.forEach((b) => b.fill(0))
  }
}
