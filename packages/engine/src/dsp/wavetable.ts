import type { DspContext, Kernel } from './types'
import { flush } from './util'
import { fft } from '../analysis'

/* ------------------------------------------------------------------------- *
 * Anti-aliased morphing wavetable oscillator (Serum-style).
 *
 * A table is a bank of single-cycle FRAMES (single-cycle waveforms). `pos`
 * (0..1) scans/morphs between adjacent frames; `freq` sets the pitch. The
 * output is band-limited: for every frame we precompute a set of MIPMAPS, one
 * per octave band, each keeping only the harmonics that stay below Nyquist for
 * that band. At runtime the current `freq` (and ctx.sampleRate) picks the
 * mipmap — higher notes read a mipmap with fewer harmonics, so a played note
 * never contains a harmonic above Nyquist and cannot alias.
 *
 * Why mipmaps beat polyblep here: an arbitrary single-cycle wave has no
 * closed-form band-limited step to correct (unlike saw/square). Building each
 * frame ADDITIVELY (sum of sine harmonics) makes band-limiting exact and free:
 * a mipmap is just the same frame resynthesised with the out-of-band harmonics
 * dropped. We synthesise via an inverse FFT (reusing analysis.ts's fft) rather
 * than a naive O(harmonics x samples) sum, so the whole bank builds in a few ms.
 *
 * Tables are pure data — generated procedurally on first use and cached at
 * module level, keyed by name. The harmonic CONTENT of the mipmaps is fixed
 * (defined by harmonic count, not sample rate); only the mipmap SELECTION uses
 * the runtime freq & ctx.sampleRate, so one cached bank serves any sample rate.
 *
 * Memory: FRAMES x MIPMAPS x FRAME_SIZE x 4 bytes ~= 8 x 11 x 2048 x 4 ~= 0.7 MB
 * per table. Read path is allocation-free; state is just the phase accumulator
 * (reset() zeros it), and — like the phase oscillators in osc.ts — the phase is
 * flushed at block end so a NaN freq poisons at most one block.
 * ------------------------------------------------------------------------- */

/** Samples per single-cycle frame. Power of two so phase->index wraps with a
 *  bit mask, and so the highest representable harmonic is FRAME_SIZE/2. */
export const WAVETABLE_FRAME_SIZE = 2048

/** Harmonics kept by the richest (lowest-band) mipmap. FRAME_SIZE/2 is the
 *  Nyquist of the frame itself. */
const MAX_HARMONICS = WAVETABLE_FRAME_SIZE / 2 // 1024
const LOG2_MAX_HARMONICS = Math.log2(MAX_HARMONICS) // 10
/** One mipmap per octave: harmonic count halves each step (1024,512,...,1). */
const NUM_MIPMAPS = LOG2_MAX_HARMONICS + 1 // 11

/** Built-in table names. */
export const WAVETABLE_TABLES = ['basic', 'harmonic', 'pwm'] as const
export type WavetableName = (typeof WAVETABLE_TABLES)[number]

/** frames[frame][mipmap] -> a single-cycle Float32Array of FRAME_SIZE samples.
 *  mipmap 0 holds all harmonics; mipmap m holds MAX_HARMONICS >> m of them. */
type Bank = Float32Array[][]

const isName = (name: string): name is WavetableName =>
  (WAVETABLE_TABLES as readonly string[]).includes(name)

/* --------------------------- frame construction --------------------------- *
 * Each frame is described by a harmonic-amplitude spectrum a[h] (h = 1..). We
 * synthesise band-limited versions by inverse-FFT of that spectrum truncated to
 * each mipmap's harmonic count.
 * ------------------------------------------------------------------------- */

/** Inverse real FFT of a pure-sine spectrum: given amplitudes a[h] for
 *  harmonic h, return the time signal sum_h a[h]*sin(2*pi*h*n/N). Uses the
 *  forward fft via ifft(X) = conj(fft(conj(X)))/N; only harmonics 1..maxH are
 *  used (the band limit). */
const synthFrame = (amps: Float64Array, maxH: number): Float32Array => {
  const N = WAVETABLE_FRAME_SIZE
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const limit = Math.min(maxH, N / 2 - 1)
  // A real sine sin(2*pi*h*n/N) has spectrum X[h] = -i*(N/2)*a, X[N-h] = +i*(N/2)*a.
  // We want the ifft, so pre-conjugate the input (negate im): the sign flips.
  for (let h = 1; h <= limit; h++) {
    const a = amps[h]!
    if (a === 0) continue
    im[h] = (N / 2) * a
    im[N - h] = -(N / 2) * a
  }
  fft(re, im)
  const frame = new Float32Array(N)
  for (let i = 0; i < N; i++) frame[i] = re[i]! / N
  return frame
}

/** Build every octave mipmap for one frame from its full harmonic spectrum,
 *  then normalise the whole frame so the peak magnitude across ALL its mipmaps
 *  is 1 (keeps morph output bounded and frames peak-matched). */
const buildFrameMipmaps = (amps: Float64Array): Float32Array[] => {
  const mips: Float32Array[] = []
  let peak = 0
  for (let m = 0; m < NUM_MIPMAPS; m++) {
    const frame = synthFrame(amps, MAX_HARMONICS >> m)
    for (let i = 0; i < frame.length; i++) {
      const a = Math.abs(frame[i]!)
      if (a > peak) peak = a
    }
    mips.push(frame)
  }
  const scale = peak > 0 ? 1 / peak : 1
  for (const frame of mips) {
    for (let i = 0; i < frame.length; i++) frame[i] = frame[i]! * scale
  }
  return mips
}

/* ------------------------------ table specs ------------------------------- */

const NUM_FRAMES = 8

/** Harmonic spectrum a[h] for a named classic wave (unnormalised; sign encodes
 *  phase, which shapes the waveform but not the magnitude spectrum). */
const classic = (kind: 'sine' | 'tri' | 'saw' | 'square'): Float64Array => {
  const a = new Float64Array(MAX_HARMONICS + 1)
  for (let h = 1; h <= MAX_HARMONICS; h++) {
    switch (kind) {
      case 'sine':
        a[h] = h === 1 ? 1 : 0
        break
      case 'tri':
        a[h] = h % 2 === 1 ? ((h - 1) / 2) % 2 === 0 ? 1 / (h * h) : -1 / (h * h) : 0
        break
      case 'saw':
        a[h] = 1 / h
        break
      case 'square':
        a[h] = h % 2 === 1 ? 1 / h : 0
        break
    }
  }
  return a
}

/** Linear blend of two spectra. */
const blend = (x: Float64Array, y: Float64Array, t: number): Float64Array => {
  const a = new Float64Array(x.length)
  for (let h = 0; h < a.length; h++) a[h] = x[h]! + t * (y[h]! - x[h]!)
  return a
}

/** 'basic': 8 frames sweeping sine -> triangle -> saw -> square, harmonics
 *  growing richer across the morph. */
const buildBasic = (): Float64Array[] => {
  const sine = classic('sine')
  const tri = classic('tri')
  const saw = classic('saw')
  const square = classic('square')
  const anchors = [sine, tri, saw, square]
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const t = (f / (NUM_FRAMES - 1)) * (anchors.length - 1) // 0..3
    const i = Math.min(anchors.length - 2, Math.floor(t))
    frames.push(blend(anchors[i]!, anchors[i + 1]!, t - i))
  }
  return frames
}

/** 'harmonic': a moving formant. Frame k rides a saw-ish base under a Gaussian
 *  emphasis whose centre harmonic climbs by octaves — an evolving, vocal sweep
 *  as different harmonic bands are foregrounded. */
const buildHarmonic = (): Float64Array[] => {
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const centre = Math.pow(2, (f / (NUM_FRAMES - 1)) * (LOG2_MAX_HARMONICS - 1)) // 1..512
    const width = Math.max(1, centre * 0.5)
    const a = new Float64Array(MAX_HARMONICS + 1)
    for (let h = 1; h <= MAX_HARMONICS; h++) {
      const bump = Math.exp(-0.5 * ((h - centre) / width) ** 2)
      // keep a little fundamental so the pitch is always present
      a[h] = (1 / h) * (0.2 + bump)
    }
    frames.push(a)
  }
  return frames
}

/** 'pwm': pulse waves of increasing width. Frame k has duty d going 0.5 (square)
 *  -> ~0.08 (thin pulse); harmonic k of a duty-d pulse is ~ sin(pi*k*d)/k. */
const buildPwm = (): Float64Array[] => {
  const frames: Float64Array[] = []
  for (let f = 0; f < NUM_FRAMES; f++) {
    const duty = 0.5 - (f / (NUM_FRAMES - 1)) * 0.42 // 0.5 .. 0.08
    const a = new Float64Array(MAX_HARMONICS + 1)
    for (let h = 1; h <= MAX_HARMONICS; h++) a[h] = Math.sin(Math.PI * h * duty) / h
    frames.push(a)
  }
  return frames
}

const SPECS: Record<WavetableName, () => Float64Array[]> = {
  basic: buildBasic,
  harmonic: buildHarmonic,
  pwm: buildPwm,
}

/** Module-level cache: each table's mipmapped bank is built once, on first use. */
const bankCache = new Map<WavetableName, Bank>()

const getBank = (name: WavetableName): Bank => {
  let bank = bankCache.get(name)
  if (!bank) {
    bank = SPECS[name]().map(buildFrameMipmaps)
    bankCache.set(name, bank)
  }
  return bank
}

/** The mipmapped bank for a named table: frames[frame][mipmap], a single-cycle
 *  Float32Array of WAVETABLE_FRAME_SIZE samples. Exposed for analysis/tests. */
export const getWavetable = (name: WavetableName): Bank => getBank(name)

/** Morphing, mipmapped wavetable oscillator. Inputs 'freq' (Hz, audio-rate,
 *  clamped to +/-Nyquist) and 'pos' (0..1, morph position, audio-rate, clamped);
 *  output the band-limited morphed waveform, ~[-1, 1]. Config { table } names a
 *  built-in table (default 'basic'); an unknown name throws at construction. */
export class WavetableKernel implements Kernel {
  private phase = 0
  private readonly bank: Bank
  private readonly lastFrame: number

  constructor(table?: string, _ctx?: DspContext) {
    const name = table ?? 'basic'
    if (!isName(name)) {
      throw new Error(`unknown wavetable '${name}' (known: ${WAVETABLE_TABLES.join(', ')})`)
    }
    this.bank = getBank(name)
    this.lastFrame = this.bank.length - 1
  }

  process(n: number, inputs: Record<string, Float32Array>, out: Float32Array, ctx: DspContext): void {
    const freq = inputs['freq']!
    const pos = inputs['pos']!
    const size = WAVETABLE_FRAME_SIZE
    const mask = size - 1
    const nyquist = ctx.sampleRate * 0.5
    const bank = this.bank
    const lastFrame = this.lastFrame

    for (let i = 0; i < n; i++) {
      const f = freq[i]!
      let dt = f / ctx.sampleRate
      if (dt > 0.5) dt = 0.5
      else if (dt < -0.5) dt = -0.5

      // --- mipmap by pitch: keep harmonics with h <= Nyquist/|freq| ---------
      // largest mipmap (most harmonics, count 2^(LOG2-m)) whose harmonics fit.
      const af = f < 0 ? -f : f
      let m = 0
      if (af > 0) {
        const allowed = nyquist / af // max non-aliasing harmonic
        m = Math.ceil(LOG2_MAX_HARMONICS - Math.log2(allowed))
        if (m < 0) m = 0
        else if (m > NUM_MIPMAPS - 1) m = NUM_MIPMAPS - 1
      }

      // --- morph between the two frames bracketing pos ----------------------
      let p = pos[i]!
      if (p < 0) p = 0
      else if (p > 1) p = 1
      const fp = p * lastFrame
      let f0 = fp | 0
      if (f0 > lastFrame) f0 = lastFrame
      const f1 = f0 < lastFrame ? f0 + 1 : f0
      const ffrac = fp - f0

      // --- read: linear interpolation within each frame's mipmap ------------
      const posf = this.phase * size
      const i0 = posf | 0
      const frac = posf - i0
      const i1 = (i0 + 1) & mask
      const tblA = bank[f0]![m]!
      const tblB = bank[f1]![m]!
      const sA = tblA[i0]! + frac * (tblA[i1]! - tblA[i0]!)
      const sB = tblB[i0]! + frac * (tblB[i1]! - tblB[i0]!)
      out[i] = sA + ffrac * (sB - sA)

      this.phase += dt
      this.phase -= Math.floor(this.phase)
    }
    this.phase = flush(this.phase)
  }

  reset(): void {
    this.phase = 0
  }
}
