/* ------------------------------------------------------------------------- *
 * Loudness measurement: ITU-R BS.1770-4 integrated loudness (LUFS) and true
 * peak (dBTP). Pure functions over stereo Float32Array pairs, no audio
 * device and no state, so the offline bounce, the MCP render tools and the
 * browser export can all ask the same question of the same samples.
 *
 * This MEASURES and never processes. Nothing here normalizes, limits or
 * touches the audio; the numbers are for the human deciding what to do.
 *
 * The chain, per BS.1770-4:
 *   1. K-weighting: a +4 dB high shelf at ~1.68 kHz, then the RLB high-pass
 *      at ~38 Hz, per channel.
 *   2. Mean square of each 400 ms block, hopping 100 ms (75% overlap).
 *   3. Block loudness l = -0.691 + 10·log10(Σ_ch G_ch · z_ch); G = 1 for the
 *      left and right of a stereo pair.
 *   4. Two gates: absolute (drop blocks below -70 LUFS), then relative (drop
 *      blocks below the loudness of what survived, minus 10 LU).
 *   5. Integrated loudness = the block loudness formula over the mean of the
 *      surviving blocks' z.
 *
 * The -0.691 offset is what makes a 1 kHz sine calibrate: K-weighting has
 * +0.691 dB of gain at 1 kHz, so a 1 kHz sine of peak amplitude 0.1 in both
 * channels measures -20.0 LUFS (pinned in loudness.test.ts, and the same
 * calibration EBU Tech 3341 case 1 uses at -23).
 * ------------------------------------------------------------------------- */

/** Reference targets a producer is usually aiming at, for UI copy. */
export const LOUDNESS_TARGETS = {
  /** What streaming platforms normalize to. */
  streaming: -14,
  /** Club and DJ delivery: loud, and mastered for a big system. */
  club: -9,
  /** The true-peak ceiling that survives lossy encoding. */
  ceilingDbTp: -1,
} as const

interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * The two K-weighting biquads for `sampleRate`, normalized so a0 = 1.
 *
 * BS.1770-4 tabulates coefficients at 48 kHz only. These come from the
 * analog prototypes behind that table (a high shelf at 1681.97 Hz, +3.9998
 * dB, Q 0.70718, then a high-pass at 38.135 Hz, Q 0.50033) run through the
 * bilinear transform, which reproduces the tabulated 48 kHz numbers to ~1e-13
 * (pinned in the tests) and generalizes to 44.1 kHz, 96 kHz and anything
 * else the renderer is asked for.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`kWeightingFilters: sampleRate must be > 0, got ${sampleRate}`)
  }
  // stage 1: high shelf
  const f0 = 1681.974450955533
  const G = 3.999843853973347
  const Q1 = 0.7071752369554196
  const K1 = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const s0 = 1 + K1 / Q1 + K1 * K1
  const shelf: Biquad = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / s0,
    b1: (2 * (K1 * K1 - Vh)) / s0,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / s0,
    a1: (2 * (K1 * K1 - 1)) / s0,
    a2: (1 - K1 / Q1 + K1 * K1) / s0,
  }
  // stage 2: RLB high-pass
  const f1 = 38.13547087602444
  const Q2 = 0.5003270373238773
  const K2 = Math.tan((Math.PI * f1) / sampleRate)
  const h0 = 1 + K2 / Q2 + K2 * K2
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / h0,
    a2: (1 - K2 / Q2 + K2 * K2) / h0,
  }
  return [shelf, hp]
}

/** Run one channel through a biquad chain (direct form I), returning a new array. */
const filterChain = (x: Float32Array, stages: Biquad[]): Float64Array => {
  const y = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = x[i]!
  for (const s of stages) {
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let i = 0; i < y.length; i++) {
      const x0 = y[i]!
      const out = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = out
      y[i] = out
    }
  }
  return y
}

const ABSOLUTE_GATE = -70
const RELATIVE_GATE_LU = 10
const BLOCK_SEC = 0.4
const HOP_SEC = 0.1
/** Block loudness from the summed per-channel mean squares. */
const blockLoudness = (z: number): number => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity)

/**
 * Integrated loudness of a stereo pair, in LUFS (equivalently LKFS).
 *
 * Returns -Infinity when nothing survives the gates: digital silence, or
 * audio quieter than the absolute -70 LUFS gate, or shorter than one 400 ms
 * block (there is no honest integrated loudness for 200 ms of audio).
 */
export function integratedLufs(left: Float32Array, right: Float32Array, sampleRate: number): number {
  if (left.length !== right.length) {
    throw new RangeError(`integratedLufs: channel length mismatch (${left.length} vs ${right.length})`)
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`integratedLufs: sampleRate must be > 0, got ${sampleRate}`)
  }
  const stages = kWeightingFilters(sampleRate)
  const kl = filterChain(left, stages)
  const kr = filterChain(right, stages)
  const blockLen = Math.round(BLOCK_SEC * sampleRate)
  const hop = Math.round(HOP_SEC * sampleRate)
  if (kl.length < blockLen) return -Infinity

  // z per block: the summed mean square of both K-weighted channels.
  const zs: number[] = []
  for (let start = 0; start + blockLen <= kl.length; start += hop) {
    let sl = 0
    let sr = 0
    for (let i = start; i < start + blockLen; i++) {
      sl += kl[i]! * kl[i]!
      sr += kr[i]! * kr[i]!
    }
    zs.push(sl / blockLen + sr / blockLen)
  }
  // absolute gate, then the relative gate computed from what survived it
  const abs = zs.filter((z) => blockLoudness(z) > ABSOLUTE_GATE)
  if (abs.length === 0) return -Infinity
  const meanOf = (list: number[]): number => list.reduce((a, z) => a + z, 0) / list.length
  const relativeGate = blockLoudness(meanOf(abs)) - RELATIVE_GATE_LU
  const kept = abs.filter((z) => blockLoudness(z) > relativeGate)
  if (kept.length === 0) return -Infinity
  return blockLoudness(meanOf(kept))
}

/** Taps per phase of the 4x oversampling interpolator (BS.1770-4 attachment 1
 *  specifies 12 per phase; more taps only sharpen the estimate). */
const TP_TAPS = 16
const TP_OVERSAMPLE = 4

/** Polyphase windowed-sinc interpolator: `TP_OVERSAMPLE` phases of
 *  `TP_TAPS` taps. Phase 0 is exactly a unit impulse (the prototype is
 *  centered on a multiple of the ratio), so the original samples are carried
 *  through untouched and only the inter-sample phases need convolving. */
const interpolatorPhases = (): Float64Array[] => {
  const L = TP_OVERSAMPLE
  const n = L * TP_TAPS + 1
  const center = (n - 1) / 2
  const proto = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const t = (k - center) / L
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    // Blackman window over the prototype
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1))
    proto[k] = sinc * w
  }
  const phases: Float64Array[] = []
  for (let p = 0; p < L; p++) {
    const taps: number[] = []
    for (let q = 0; p + q * L < n; q++) taps.push(proto[p + q * L]!)
    phases.push(Float64Array.from(taps))
  }
  return phases
}

const PHASES = interpolatorPhases()

/** Peak of one channel after 4x oversampling (linear amplitude). */
const channelTruePeak = (x: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!)
    if (a > peak) peak = a // phase 0 of the interpolator is the sample itself
  }
  for (let p = 1; p < PHASES.length; p++) {
    const taps = PHASES[p]!
    // run past the end so a peak in the final samples' interpolation is seen
    for (let n = 0; n < x.length + taps.length; n++) {
      let acc = 0
      for (let q = 0; q < taps.length; q++) {
        const j = n - q
        if (j >= 0 && j < x.length) acc += taps[q]! * x[j]!
      }
      const a = Math.abs(acc)
      if (a > peak) peak = a
    }
  }
  return peak
}

const toDb = (amp: number): number => (amp > 0 ? 20 * Math.log10(amp) : -Infinity)

/**
 * True peak of a stereo pair in dBTP: the largest inter-sample peak either
 * channel reaches, found by 4x oversampling (BS.1770-4). It is >= the sample
 * peak by definition, and the gap is what clips a converter or a lossy
 * encoder even when every stored sample sits under 0 dBFS.
 *
 * Silence returns -Infinity.
 */
export function truePeakDb(left: Float32Array, right: Float32Array, sampleRate?: number): number {
  if (left.length !== right.length) {
    throw new RangeError(`truePeakDb: channel length mismatch (${left.length} vs ${right.length})`)
  }
  void sampleRate // 4x is specified for material up to 96 kHz; rate does not change the filter
  return toDb(Math.max(channelTruePeak(left), channelTruePeak(right)))
}

/** Largest stored sample magnitude of a stereo pair, in dBFS. */
export function samplePeakDb(left: Float32Array, right: Float32Array): number {
  let peak = 0
  for (let i = 0; i < left.length; i++) {
    const a = Math.max(Math.abs(left[i]!), Math.abs(right[i]!))
    if (a > peak) peak = a
  }
  return toDb(peak)
}

export interface LoudnessReport {
  /** BS.1770-4 integrated loudness, LUFS. -Infinity when fully gated. */
  integratedLufs: number
  /** 4x oversampled inter-sample peak, dBTP. -Infinity for silence. */
  truePeakDb: number
  /** Largest stored sample, dBFS. -Infinity for silence. */
  samplePeakDb: number
}

/** Measure a stereo render: integrated loudness plus true and sample peak. */
export function measureLoudness(left: Float32Array, right: Float32Array, sampleRate: number): LoudnessReport {
  return {
    integratedLufs: integratedLufs(left, right, sampleRate),
    truePeakDb: truePeakDb(left, right, sampleRate),
    samplePeakDb: samplePeakDb(left, right),
  }
}

/** One decimal, or 'silent' for a gated/empty measurement. Shared by the
 *  export popover and the render tools so both read the same way. */
export const formatLufs = (lufs: number): string => (Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : 'silent')

/** One decimal, or 'silent'. */
export const formatDbTp = (db: number): string => (Number.isFinite(db) ? `${db.toFixed(1)} dBTP` : 'silent')
