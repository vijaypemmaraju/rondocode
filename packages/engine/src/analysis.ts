import type { RenderResult } from './render'

/* ------------------------------------------------------------------------- *
 * Audio analysis: turn rendered audio into a compact, READABLE set of
 * numbers. This is the primary feedback channel for AI sound-design agents
 * (over MCP later): an agent renders a patch, reads this JSON, and decides
 * "too dark, open the filter" or "clipping, drop the gain" without ever
 * hearing a sample. Every field is documented in musical terms.
 *
 * Scope (v1, deliberate):
 * - Level is plain RMS, not LUFS. K-weighted loudness matters for mastering
 *   across program material; for judging a single synth patch RMS is
 *   equivalent feedback at a fraction of the complexity.
 * - No mel spectrogram yet. v1.1 adds a log-mel summary for MCP patch
 *   comparison ("does A sound like B"); the scalar spectral stats below are
 *   enough for directional feedback on one patch.
 * - No streaming analysis: analyze() takes a finished offline render. It is
 *   intended to run off the audio thread (worker), so clarity beats
 *   allocation thrift throughout.
 * ------------------------------------------------------------------------- */

/** FFT frame length (samples). ~21 ms at 48k: fine enough for bass
 *  fundamentals (bin width ~47 Hz), short enough to track note-level change. */
const FFT_SIZE = 1024
/** Hop between frames: 50% overlap. */
const HOP = 512
/** Number of envelope points. */
const ENV_POINTS = 50
/** Below this RMS a signal (or a single FFT frame) counts as silent. */
const SILENCE_RMS = 1e-5
/** Amplitude floor for "the sound has started" when measuring attack. */
const ATTACK_FLOOR = 1e-4
/** Low/mid boundary (Hz): below this is bass weight ("low"). */
const LOW_HZ = 250
/** Mid/high boundary (Hz): above this is brightness/air ("high"). */
const HIGH_HZ = 4000

export interface Analysis {
  /** Length of the analyzed audio in seconds. */
  durationSec: number
  /** Sample rate the audio was rendered at (Hz). */
  sampleRate: number
  /** Root-mean-square level over both channels, 0..~1. Perceived overall
   *  loudness proxy: ~0.35 is a full-scale sine, ~0.1 a healthy synth line,
   *  < 0.01 very quiet. (v1 uses RMS, not LUFS — see module doc.) */
  rms: number
  /** Largest absolute sample value across both channels. 1.0 is digital
   *  full scale; headroom = 1 - peak. */
  peak: number
  /** True when rms < 1e-5: effectively no audio. If a patch renders silent,
   *  check gate wiring and envelope times before anything else. */
  isSilent: boolean
  /** True if any sample is non-finite (NaN or ±Infinity) — the patch's math
   *  blew up (divide by zero, runaway feedback). The audio is garbage; fix
   *  the graph, not the mix. */
  hasNaN: boolean
  /** True when peak > 0.99: the render touches digital full scale and will
   *  distort on playback. Lower the patch's output gain. */
  clipped: boolean
  /** 50-point amplitude envelope: max-abs per equal time slice (max, not
   *  mean, so one-sample clicks and transients stay visible). Read it as the
   *  waveform's outline: index 0 = start, 49 = end, values 0..peak. */
  envelope: number[]
  /** Milliseconds from the first audible sample (|x| > 1e-4) to the first
   *  sample reaching 90% of peak. < 10 ms feels like a click/pluck, 10-100 ms
   *  a soft attack, > 500 ms a swell. null when no attack is measurable —
   *  i.e. peak <= 1e-4, nothing ever crosses the audible floor (null rather
   *  than a numeric sentinel so the meaning survives JSON transport). */
  attackTimeMs: number | null
  /** Energy-weighted mean frequency (Hz) of the spectrum — the single best
   *  "brightness" number. ~200 Hz = dark/bassy/muffled, ~800 Hz = warm,
   *  ~2-4 kHz = present/cutting, > 5 kHz = bright to harsh. Averaged over
   *  non-silent 1024-pt Hann frames of the mid (L+R)/2 signal; 0 if silent. */
  spectralCentroidHz: number
  /** Frequency (Hz) below which 95% of the energy sits. Where the spectrum
   *  effectively ends: a dull bass patch rolls off < 1 kHz, an open sawtooth
   *  reaches 8-15 kHz. Same framing as the centroid; 0 if silent. */
  spectralRolloffHz: number
  /** Geometric/arithmetic mean ratio of the power spectrum, 0..1. Tonal vs
   *  noisy: < 0.1 = clear pitch (sine/saw through a filter), > 0.5 =
   *  noise-like (hiss, cymbals, heavy distortion). Averaged over non-silent
   *  frames; 0 if silent. */
  spectralFlatness: number
  /** Energy split [low < 250 Hz, mid 250-4000 Hz, high > 4 kHz], normalized
   *  to sum to 1 ([0,0,0] if silent). The tonal balance at a glance:
   *  [0.8, 0.2, 0] is a sub-heavy bass, [0.1, 0.6, 0.3] a bright lead,
   *  roughly [0.2, 0.5, 0.3] reads as "full range". */
  lowMidHighRatio: [number, number, number]
  /** 1 - |pearson correlation(L, R)|, clamped to 0..1. 0 = mono (identical
   *  or simply gain-scaled channels), ~1 = fully decorrelated wide stereo.
   *  Note |corr| means an out-of-phase copy also reads as 0 (it IS narrow —
   *  and mono-sums to silence). 0 when either channel is silent/constant. */
  stereoWidth: number
  /** Time (seconds) of the loudest single sample. Tells an agent WHERE to
   *  look/listen: is the peak the initial transient (near 0) or a resonance
   *  blowing up mid-note? */
  loudestMomentSec: number
}

/** In-place iterative radix-2 Cooley-Tukey FFT on complex input (re, im).
 *  Length must be a power of two. Forward transform, no normalization:
 *  a unit impulse yields magnitude 1 in every bin; a full-scale real tone
 *  yields magnitude n/2 in its bin and its conjugate. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) {
    throw new RangeError(`fft: length must be a power of two >= 2 with re/im equal, got ${n}/${im.length}`)
  }
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j |= bit
    if (i < j) {
      const tr = re[i]!
      re[i] = re[j]!
      re[j] = tr
      const ti = im[i]!
      im[i] = im[j]!
      im[j] = ti
    }
  }
  // butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = -Math.PI / half
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vRe = re[b]! * curRe - im[b]! * curIm
        const vIm = re[b]! * curIm + im[b]! * curRe
        re[b] = re[a]! - vRe
        im[b] = im[a]! - vIm
        re[a] = re[a]! + vRe
        im[a] = im[a]! + vIm
        const nRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nRe
      }
    }
  }
}

/** Analyze a stereo render into the Analysis metrics above. Spectral metrics
 *  are computed on the mid channel (L+R)/2; stereoWidth on L vs R. */
export function analyze(result: RenderResult): Analysis {
  const { left: L, right: R, sampleRate: sr } = result
  const n = L.length
  if (n === 0 || R.length !== n) {
    throw new RangeError(`analyze: channels must be non-empty and equal length, got ${n}/${R.length}`)
  }

  // ---- time-domain pass: level, peak, NaN, envelope, correlation ----------
  const envelope = new Array<number>(ENV_POINTS).fill(0)
  let sumSq = 0
  let peak = 0
  let peakIdx = 0
  let hasNaN = false
  let sumL = 0
  let sumR = 0
  let sumLL = 0
  let sumRR = 0
  let sumLR = 0
  for (let i = 0; i < n; i++) {
    const l = L[i]!
    const r = R[i]!
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      hasNaN = true
      continue // keep level/peak meaningful for the finite part
    }
    sumSq += l * l + r * r
    const amp = Math.max(Math.abs(l), Math.abs(r))
    if (amp > peak) {
      peak = amp
      peakIdx = i
    }
    const e = Math.floor((i * ENV_POINTS) / n)
    if (amp > envelope[e]!) envelope[e] = amp
    sumL += l
    sumR += r
    sumLL += l * l
    sumRR += r * r
    sumLR += l * r
  }
  const rms = Math.sqrt(sumSq / (2 * n))
  const isSilent = rms < SILENCE_RMS

  // ---- attack time --------------------------------------------------------
  // first audible sample -> first sample at 90% of peak (see field doc);
  // null when the peak itself never clears the audible floor
  let attackTimeMs: number | null = null
  if (peak > ATTACK_FLOOR) {
    let start = -1
    const target = 0.9 * peak
    for (let i = 0; i < n; i++) {
      const amp = Math.max(Math.abs(L[i]!), Math.abs(R[i]!))
      if (start < 0 && amp > ATTACK_FLOOR) start = i
      if (start >= 0 && amp >= target) {
        attackTimeMs = ((i - start) / sr) * 1000
        break
      }
    }
  }

  // ---- stereo width -------------------------------------------------------
  // pearson correlation of L and R; constant/silent channels have zero
  // variance -> undefined correlation -> report 0 (mono) rather than NaN
  let stereoWidth = 0
  const varL = n * sumLL - sumL * sumL
  const varR = n * sumRR - sumR * sumR
  const denom = Math.sqrt(varL * varR)
  if (denom > 0) {
    const corr = (n * sumLR - sumL * sumR) / denom
    if (Number.isFinite(corr)) stereoWidth = Math.min(1, Math.max(0, 1 - Math.abs(corr)))
  }

  // ---- spectral pass over the mid channel ---------------------------------
  const window = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))) // Hann
  }
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  const nyquistBin = FFT_SIZE / 2
  const binHz = sr / FFT_SIZE

  let frames = 0 // non-silent frames
  let centroidSum = 0
  let rolloffSum = 0
  let flatnessSum = 0
  let lowE = 0
  let midE = 0
  let highE = 0

  // hop through the signal; a shorter-than-FFT_SIZE render gets one
  // zero-padded frame so tiny snippets still produce spectral numbers.
  // Tail caveat: trailing samples past the last full frame (< HOP of them)
  // fall outside every frame and are excluded from the spectral metrics —
  // time-domain metrics (rms/peak/envelope/...) still see every sample
  const lastStart = Math.max(0, n - FFT_SIZE)
  for (let start = 0; start <= lastStart; start += HOP) {
    let frameSumSq = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = start + i
      const mid = j < n ? (L[j]! + R[j]!) / 2 : 0
      frameSumSq += mid * mid
      re[i] = mid * window[i]!
      im[i] = 0
    }
    // skip silent frames: a long tail of near-zeros would otherwise drag the
    // averages toward numerical noise instead of describing the sound
    if (!(Math.sqrt(frameSumSq / FFT_SIZE) >= SILENCE_RMS)) continue
    fft(re, im)

    let total = 0
    let weighted = 0
    let logSum = 0
    for (let k = 0; k <= nyquistBin; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]! // power
      const f = k * binHz
      total += p
      weighted += f * p
      if (k > 0) logSum += Math.log(p + 1e-30) // flatness skips DC
      if (f < LOW_HZ) lowE += p
      else if (f <= HIGH_HZ) midE += p
      else highE += p
    }
    if (total <= 0) continue
    frames++
    centroidSum += weighted / total
    // rolloff: frequency below which 95% of this frame's energy sits
    const target = 0.95 * total
    let cum = 0
    for (let k = 0; k <= nyquistBin; k++) {
      cum += re[k]! * re[k]! + im[k]! * im[k]!
      if (cum >= target) {
        rolloffSum += k * binHz
        break
      }
    }
    const arithMean = (total - (re[0]! * re[0]! + im[0]! * im[0]!)) / nyquistBin
    const geoMean = Math.exp(logSum / nyquistBin)
    flatnessSum += arithMean > 0 ? Math.min(1, geoMean / arithMean) : 0
  }

  const totalE = lowE + midE + highE
  const lowMidHighRatio: [number, number, number] =
    totalE > 0 ? [lowE / totalE, midE / totalE, highE / totalE] : [0, 0, 0]

  return {
    durationSec: n / sr,
    sampleRate: sr,
    rms,
    peak,
    isSilent,
    hasNaN,
    clipped: peak > 0.99,
    envelope,
    attackTimeMs,
    spectralCentroidHz: frames > 0 ? centroidSum / frames : 0,
    spectralRolloffHz: frames > 0 ? rolloffSum / frames : 0,
    spectralFlatness: frames > 0 ? flatnessSum / frames : 0,
    lowMidHighRatio,
    stereoWidth,
    loudestMomentSec: peakIdx / sr,
  }
}
