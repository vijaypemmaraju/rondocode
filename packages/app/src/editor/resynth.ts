import { fft } from '@rondocode/engine'

/* ------------------------------------------------------------------------- *
 * Sample -> wavetable resynthesis: FFT-analyze any recorded PCM (mic takes,
 * resampled bounces, loaded files) into frames of harmonic partial
 * amplitudes, the exact shape a `wavedef` line declares. Resynthesize
 * anything you recorded into a wavetable, as code.
 *
 * Method (deterministic, main-thread cheap: ~10 ms for a few seconds of PCM):
 * 1. f0 by normalized autocorrelation over a centered window, with
 *    octave-error correction (prefer the smallest lag whose local peak comes
 *    within 90% of the global max) and parabolic lag interpolation.
 * 2. N evenly spaced Hann-windowed segments, each through the engine's
 *    radix-2 FFT (~6 periods per window for clean partial separation).
 * 3. Partial k's amplitude read at k*f0 by quadratic interpolation of the
 *    log-magnitude peak around the expected bin; the whole frame set is
 *    normalized so its loudest partial is 1 (readable numbers; the engine
 *    peak-normalizes each synthesized frame anyway).
 *
 * Honest limits: the model is HARMONIC and phase-blind. Inharmonic input
 * (bells, chords, noise) gets projected onto the harmonic comb of whatever
 * period the autocorrelation locks onto, a musical caricature rather than a
 * transcription; phases are discarded, so the resynthesized wave SHAPE
 * differs while the magnitude spectrum matches (the classic resynthesis
 * sheen). `clarity` (0..1) reports how periodic the source really was;
 * below ~0.5 the table is a drone-flavored guess.
 * ------------------------------------------------------------------------- */

export interface ResynthOpts {
  /** number of wavetable frames to extract (default 8, max 64). */
  frames?: number
  /** harmonic partials per frame (default 16, max 32 = the wavedef cap). */
  partials?: number
  /** skip detection and analyze at this fundamental (Hz). */
  f0?: number
  /** f0 search range (Hz), defaults 40..2000. */
  minHz?: number
  maxHz?: number
}

export interface ResynthResult {
  /** detected (or given) fundamental, Hz; 0 when analysis failed. */
  f0: number
  /** normalized autocorrelation at the chosen period, 0..1: how periodic the
   *  source is (1 = perfectly pitched, < 0.5 = mostly noise). */
  clarity: number
  /** frames x partials; frames[i][k-1] = amplitude of harmonic k, the max
   *  across all frames normalized to 1. Empty when the input is too short. */
  frames: number[][]
}

/** f0 by normalized autocorrelation with octave-error correction. */
const detectF0 = (pcm: Float32Array, sr: number, minHz: number, maxHz: number): { f0: number; clarity: number } => {
  const N = Math.min(pcm.length, 8192)
  const start = Math.max(0, Math.floor((pcm.length - N) / 2)) // center: skip the attack transient
  const x = new Float64Array(N)
  let mean = 0
  for (let i = 0; i < N; i++) mean += pcm[start + i]!
  mean /= N
  for (let i = 0; i < N; i++) x[i] = pcm[start + i]! - mean

  const minLag = Math.max(2, Math.floor(sr / maxHz))
  const maxLag = Math.min(N - 2, Math.ceil(sr / minHz))
  if (minLag >= maxLag) return { f0: 0, clarity: 0 }

  // r(lag) = sum x[i]x[i+lag] / sqrt(e0*e1) — energy-normalized so a decaying
  // source (every real recording) still peaks near 1 at its true period
  const r = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0
    let e0 = 0
    let e1 = 0
    const M = N - lag
    for (let i = 0; i < M; i++) {
      num += x[i]! * x[i + lag]!
      e0 += x[i]! * x[i]!
      e1 += x[i + lag]! * x[i + lag]!
    }
    const den = Math.sqrt(e0 * e1)
    r[lag] = den > 0 ? num / den : 0
  }
  // global max, then prefer the SMALLEST lag whose local peak comes within
  // 90% of it: a strong sub-multiple is the true period, larger lags are its
  // octaves (this is what defeats the strong-2nd-harmonic octave error)
  let best = minLag
  for (let lag = minLag + 1; lag <= maxLag; lag++) if (r[lag]! > r[best]!) best = lag
  if (!(r[best]! > 0)) return { f0: 0, clarity: 0 }
  const rmax = r[best]!
  let chosen = best
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag]! >= 0.9 * rmax && r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!) {
      chosen = lag
      break
    }
  }
  // parabolic interpolation for a fractional lag (sub-sample pitch accuracy)
  let lagF = chosen
  if (chosen > minLag && chosen < maxLag) {
    const a = r[chosen - 1]!
    const b = r[chosen]!
    const c = r[chosen + 1]!
    const d = a - 2 * b + c
    if (d < 0) lagF = chosen + (0.5 * (a - c)) / d
  }
  return { f0: sr / lagF, clarity: Math.max(0, Math.min(1, r[chosen]!)) }
}

/** |X| at a fractional bin: quadratic interpolation of the log-magnitude
 *  peak within +-1 bin of the expected position (Hann leakage is symmetric,
 *  so the fitted peak recovers the true amplitude to well under 1%). */
const partialMag = (re: Float64Array, im: Float64Array, n: number, binPos: number): number => {
  const half = n / 2
  if (binPos < 1 || binPos >= half - 1) return 0
  const mag = (k: number): number => Math.hypot(re[k]!, im[k]!)
  let kb = Math.round(binPos)
  if (mag(kb - 1) > mag(kb)) kb -= 1
  else if (mag(kb + 1) > mag(kb)) kb += 1
  if (kb < 1 || kb >= half) return 0
  const a = mag(kb - 1)
  const b = mag(kb)
  const c = mag(kb + 1)
  if (b <= 0) return 0
  const la = Math.log(a + 1e-30)
  const lb = Math.log(b)
  const lc = Math.log(c + 1e-30)
  const d = la - 2 * lb + lc
  if (d >= 0) return b
  const off = (0.5 * (la - lc)) / d
  if (Math.abs(off) > 1) return b
  return Math.exp(lb - 0.25 * (la - lc) * off)
}

/** Analyze mono PCM into harmonic-partial frames (see the module comment). */
export function analyzePartials(pcm: Float32Array, sampleRate: number, opts: ResynthOpts = {}): ResynthResult {
  const nFrames = Math.max(2, Math.min(64, Math.round(opts.frames ?? 8)))
  const nPartials = Math.max(1, Math.min(32, Math.round(opts.partials ?? 16)))
  const minHz = opts.minHz ?? 40
  const maxHz = opts.maxHz ?? 2000
  if (pcm.length < 256 || !(sampleRate > 0)) return { f0: 0, clarity: 0, frames: [] }
  const det = opts.f0 !== undefined ? { f0: opts.f0, clarity: 1 } : detectF0(pcm, sampleRate, minHz, maxHz)
  const f0 = det.f0
  if (!(f0 > 0) || f0 >= sampleRate / 2) return { f0: 0, clarity: 0, frames: [] }

  // FFT window: ~6 periods for clean partial separation, power of two,
  // clamped to [1024, 8192] and to the signal length
  const period = sampleRate / f0
  let n = 1024
  while (n < period * 6 && n < 8192) n <<= 1
  while (n > pcm.length && n > 2) n >>= 1
  if (n < 256) return { f0, clarity: det.clarity, frames: [] }

  const win = new Float64Array(n)
  let winSum = 0
  for (let i = 0; i < n; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    winSum += win[i]!
  }
  const norm = 2 / winSum // a Hann-windowed unit-amplitude sine peaks at winSum/2

  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const frames: number[][] = []
  let peak = 0
  for (let f = 0; f < nFrames; f++) {
    // frame centers evenly spaced across the whole take, windows clamped to
    // the ends — a short sample yields heavily overlapping (similar) frames,
    // which is the right degeneration for a static timbre
    const center = ((f + 0.5) / nFrames) * pcm.length
    const s = Math.max(0, Math.min(pcm.length - n, Math.round(center - n / 2)))
    for (let i = 0; i < n; i++) {
      re[i] = pcm[s + i]! * win[i]!
      im[i] = 0
    }
    fft(re, im)
    const amps: number[] = []
    for (let k = 1; k <= nPartials; k++) {
      const freq = k * f0
      if (freq >= sampleRate / 2) {
        amps.push(0)
        continue
      }
      const a = partialMag(re, im, n, (freq * n) / sampleRate) * norm
      amps.push(a)
      if (a > peak) peak = a
    }
    frames.push(amps)
  }
  if (peak > 0) {
    for (const fr of frames) for (let k = 0; k < fr.length; k++) fr[k] = fr[k]! / peak
  }
  return { f0, clarity: det.clarity, frames }
}

/* ---- serialization: an analysis result as code --------------------------- */

/** 3-decimal amplitude, mobile-short (`0.35` -> `.35`, `0` stays `0`). */
const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  if (r === 0) return '0'
  return String(r).replace(/^(-?)0\./, '$1.')
}

/** Drop trailing partials that round to 0 (keep at least harmonic 1). */
const trimFrame = (fr: number[]): number[] => {
  let last = fr.length - 1
  while (last > 0 && Math.round(fr[last]! * 1000) === 0) last--
  return fr.slice(0, last + 1)
}

/** The rondo `wavedef NAME p p / p p …` line for an analysis result. */
export function toWavedefLine(name: string, result: ResynthResult): string {
  return `wavedef ${name} ${result.frames.map((fr) => trimFrame(fr).map(fmt).join(' ')).join(' / ')}`
}

/** The JS `defineWavetable('NAME', [[…], …])` call for an analysis result. */
export function toDefineWavetableCall(name: string, result: ResynthResult): string {
  const rows = result.frames.map((fr) => `[${trimFrame(fr).map(fmt).join(', ')}]`)
  return `defineWavetable('${name}', [${rows.join(', ')}])`
}

/** A sample name -> a legal wavetable name: word chars, letter first, `_wt`
 *  suffixed so the table reads as derived from (not identical to) the take. */
export function wavetableNameFor(sampleName: string): string {
  let base = sampleName.replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[a-zA-Z]/.test(base)) base = `wt${base}`
  return `${base}_wt`
}
