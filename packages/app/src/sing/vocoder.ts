/* ------------------------------------------------------------------------- *
 * A compact WORLD-style source-filter vocoder for the singing pipeline.
 *
 * The problem with TD-PSOLA (see psola.ts): to sustain a note it repeats a real
 * glottal-pulse GRAIN, and repeating one waveform grain hundreds of times makes
 * an exactly-periodic super-structure — the "static buzz". Stretching a
 * consonant duplicates a non-periodic burst — the "smear".
 *
 * The fix every mature singing synth (Vocaloid, WORLD/moresampler) uses is to
 * separate SOURCE (excitation) from FILTER (spectral envelope): analyze the
 * spoken syllable into a per-frame smooth spectral ENVELOPE + f0, then resynth
 * by driving a FRESH excitation (a pitch pulse-train at the target f0, plus a
 * shaped-noise bed for breath) through the envelope. To hold a vowel we freeze /
 * slowly wander the ENVELOPE frame while the excitation keeps regenerating from
 * a continuous f0 — so nothing in the waveform ever repeats and it can't buzz.
 * Pitch lives only in f0, so shifting it keeps the formants (no chipmunk).
 *
 * This is a from-scratch, dependency-free TS implementation (no WASM): cepstral
 * spectral envelope, min-phase impulse resynthesis, harmonic pulses + shaped
 * noise. Not full WORLD (no CheapTrick/D4C), but the same architecture, and it
 * structurally removes the buzz + smear.
 * ------------------------------------------------------------------------- */

const FFT_N = 1024
const HOP = 256
const HALF = FFT_N >> 1

/** In-place radix-2 Cooley–Tukey FFT (forward, no normalization). Length must be
 *  a power of two. Mirrors packages/engine analysis.fft — inlined so the sing
 *  module stays self-contained. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
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

/** Inverse FFT via conjugation: ifft(x) = conj(fft(conj(x)))/n. */
function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 0; i < n; i++) im[i] = -im[i]!
  fft(re, im)
  const inv = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * inv
    im[i] = -im[i]! * inv
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}
const WIN = hann(FFT_N)

/** Per-frame autocorrelation f0 over a window centered on `center`. 0 = unvoiced.
 *  Returns [f0Hz, confidence 0..1]. */
function frameF0(x: Float32Array, center: number, sr: number): [number, number] {
  const fmin = 80
  const fmax = 500
  const minLag = Math.floor(sr / fmax)
  const maxLag = Math.floor(sr / fmin)
  const frame = Math.min(2 * maxLag, FFT_N)
  const s = center - (frame >> 1)
  let e0 = 0
  const buf = new Float64Array(frame)
  for (let i = 0; i < frame; i++) {
    const xi = s + i
    buf[i] = xi >= 0 && xi < x.length ? x[xi]! : 0
    e0 += buf[i]! * buf[i]!
  }
  if (e0 < 1e-6) return [0, 0]
  let best = 0
  let bestLag = 0
  for (let lag = minLag; lag <= maxLag && lag < frame; lag++) {
    let acc = 0
    for (let i = 0; i + lag < frame; i++) acc += buf[i]! * buf[i + lag]!
    const nc = acc / e0
    if (nc > best) {
      best = nc
      bestLag = lag
    }
  }
  if (best < 0.3 || bestLag === 0) return [0, best]
  return [sr / bestLag, best]
}

/** One analyzed frame: smooth spectral ENVELOPE (magnitude, HALF+1 bins), the
 *  fundamental (0 = unvoiced), and an aperiodicity 0..1 (noise fraction). */
export interface VoiceFrame {
  env: Float32Array
  f0: number
  ap: number
}

export interface VoiceAnalysis {
  frames: VoiceFrame[]
  hop: number
  fftSize: number
  sr: number
}

/** Analyze a voice segment into per-frame (envelope, f0, aperiodicity). The
 *  envelope is a cepstrally-smoothed magnitude spectrum (pitch harmonics
 *  liftered out) — the vocal-tract filter, decoupled from f0. */
export function analyzeVoice(x: Float32Array, sr: number): VoiceAnalysis {
  const numFrames = Math.max(1, Math.ceil(x.length / HOP))
  const frames: VoiceFrame[] = []
  const re = new Float64Array(FFT_N)
  const im = new Float64Array(FFT_N)
  for (let f = 0; f < numFrames; f++) {
    const center = f * HOP
    const start = center - HALF
    for (let i = 0; i < FFT_N; i++) {
      const xi = start + i
      re[i] = (xi >= 0 && xi < x.length ? x[xi]! : 0) * WIN[i]!
      im[i] = 0
    }
    fft(re, im)
    // log-magnitude (full symmetric spectrum)
    const logmag = new Float64Array(FFT_N)
    for (let k = 0; k < FFT_N; k++) logmag[k] = Math.log(Math.hypot(re[k]!, im[k]!) + 1e-7)
    const [f0, conf] = frameF0(x, center, sr)
    // cepstral lifter: keep quefrencies below ~0.6 of the pitch period so the
    // harmonic ripple is removed but formants survive.
    const period = f0 > 0 ? sr / f0 : sr / 150
    const cut = Math.max(4, Math.floor(period * 0.6))
    const cre = logmag.slice()
    const cim = new Float64Array(FFT_N)
    ifft(cre, cim) // real cepstrum in cre
    for (let q = cut; q <= FFT_N - cut; q++) cre[q] = 0
    cim.fill(0)
    fft(cre, cim) // back to smoothed log-spectrum in cre
    const env = new Float32Array(HALF + 1)
    for (let k = 0; k <= HALF; k++) env[k] = Math.exp(cre[k]!)
    // aperiodicity: low when clearly voiced, high when noisy/unvoiced
    const ap = Math.max(0.02, Math.min(0.98, 1 - conf))
    frames.push({ env, f0, ap })
  }
  return { frames, hop: HOP, fftSize: FFT_N, sr }
}

/** Min-phase impulse response for a magnitude envelope (HALF+1 bins). Min-phase
 *  concentrates energy at the start so pulse-train OLA stays crisp + causal. */
function minPhaseImpulse(env: Float32Array, gain: number): Float64Array {
  const logmag = new Float64Array(FFT_N)
  for (let k = 0; k <= HALF; k++) logmag[k] = Math.log(env[k]! * gain + 1e-7)
  for (let k = HALF + 1; k < FFT_N; k++) logmag[k] = logmag[FFT_N - k]!
  const cre = logmag
  const cim = new Float64Array(FFT_N)
  ifft(cre, cim) // real cepstrum
  // fold to min-phase: double 1..HALF-1, keep 0 & HALF, zero the rest
  const mp = new Float64Array(FFT_N)
  mp[0] = cre[0]!
  for (let q = 1; q < HALF; q++) mp[q] = 2 * cre[q]!
  mp[HALF] = cre[HALF]!
  const mpim = new Float64Array(FFT_N)
  fft(mp, mpim) // log min-phase spectrum
  const hre = new Float64Array(FFT_N)
  const him = new Float64Array(FFT_N)
  for (let k = 0; k < FFT_N; k++) {
    const e = Math.exp(mp[k]!)
    hre[k] = e * Math.cos(mpim[k]!)
    him[k] = e * Math.sin(mpim[k]!)
  }
  ifft(hre, him)
  return hre // real min-phase impulse response
}

/** Interpolate a magnitude envelope between source frames at fractional index. */
function interpEnv(frames: VoiceFrame[], idx: number): Float32Array {
  const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(idx)))
  const i1 = Math.min(frames.length - 1, i0 + 1)
  const t = idx - i0
  const a = frames[i0]!.env
  const b = frames[i1]!.env
  const out = new Float32Array(HALF + 1)
  for (let k = 0; k <= HALF; k++) out[k] = a[k]! * (1 - t) + b[k]! * t
  return out
}

export interface Vibrato {
  depth: number // semitones (peak)
  rate: number // Hz
  delay: number // seconds before it eases in
  ease: number // seconds to ramp to full depth
}

export interface ResynthOpts {
  /** Source-frame index for each OUTPUT frame — the time-map. Consonants map
   *  ~1:1, the vowel is stretched or HELD (for a sustain) with slow wander. */
  frameMap: Float32Array
  /** Target f0 (Hz) for the whole note. */
  f0: number
  vibrato?: Vibrato
  /** f0 random-walk depth (semitones RMS) for micro-liveness. */
  jitter?: number
  /** Extra breath: adds to each frame's aperiodicity (0..1). */
  breath?: number
}

/** Resynthesize `target` samples from an analysis + a per-output-frame time-map,
 *  at the target f0 (with vibrato/jitter). Voiced excitation = min-phase pulses
 *  at the f0 phase; aperiodic excitation = envelope-shaped noise. */
export function resynth(an: VoiceAnalysis, target: number, opts: ResynthOpts): Float32Array {
  const { frames, sr } = an
  const { frameMap, f0, vibrato, jitter = 0, breath = 0 } = opts
  const out = new Float32Array(target)
  const numOut = frameMap.length

  // per-output-frame: interpolated envelope, aperiodicity, and a cached
  // min-phase impulse for the periodic part.
  const periodicImp: Float64Array[] = new Array(numOut)
  const aps = new Float32Array(numOut)
  const noiseEnv: Float32Array[] = new Array(numOut)
  for (let j = 0; j < numOut; j++) {
    const idx = frameMap[j]!
    const env = interpEnv(frames, idx)
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.round(idx)))
    const ap = Math.max(0.02, Math.min(0.98, frames[i0]!.ap + breath))
    aps[j] = ap
    periodicImp[j] = minPhaseImpulse(env, Math.sqrt(1 - ap))
    noiseEnv[j] = env
  }

  // --- voiced excitation: min-phase pulses at the (vibrato'd) f0 phase --------
  // jitter as a slow random walk (low-passed white)
  let jv = 0
  const jitterAt = (): number => {
    if (jitter <= 0) return 0
    jv = 0.92 * jv + 0.08 * (Math.random() * 2 - 1)
    return jv * jitter
  }
  let phase = 0
  for (let t = 0; t < target; t++) {
    const tSec = t / sr
    let semis = 0
    if (vibrato) {
      const g = tSec <= vibrato.delay ? 0 : Math.min(1, (tSec - vibrato.delay) / Math.max(1e-4, vibrato.ease))
      semis += vibrato.depth * g * Math.sin(2 * Math.PI * vibrato.rate * tSec)
    }
    semis += jitterAt()
    const fInst = f0 * Math.pow(2, semis / 12)
    phase += fInst / sr
    if (phase >= 1) {
      phase -= 1
      const j = Math.min(numOut - 1, Math.floor(t / HOP))
      const imp = periodicImp[j]!
      const L = Math.min(FFT_N, target - t + HALF)
      // impulse is causal but centered at HALF after ifft of a symmetric log —
      // place so its energy peak lands at t.
      for (let k = 0; k < L; k++) {
        const oi = t + k - 0
        if (oi >= 0 && oi < target) out[oi]! += imp[k]!
      }
    }
  }

  // --- aperiodic excitation: envelope-shaped noise, OLA per frame ------------
  const re = new Float64Array(FFT_N)
  const im = new Float64Array(FFT_N)
  const nwin = WIN
  for (let j = 0; j < numOut; j++) {
    const ap = aps[j]!
    const env = noiseEnv[j]!
    // white noise frame
    for (let i = 0; i < FFT_N; i++) {
      re[i] = (Math.random() * 2 - 1) * nwin[i]!
      im[i] = 0
    }
    fft(re, im)
    // shape by env*sqrt(ap): keep noise phase, set magnitude
    const gAp = Math.sqrt(ap)
    for (let k = 0; k <= HALF; k++) {
      const mag = Math.hypot(re[k]!, im[k]!) || 1e-9
      const scale = (env[k]! * gAp) / mag
      re[k] = re[k]! * scale
      im[k] = im[k]! * scale
      if (k > 0 && k < HALF) {
        re[FFT_N - k] = re[k]!
        im[FFT_N - k] = -im[k]!
      }
    }
    ifft(re, im)
    const base = j * HOP - HALF
    for (let i = 0; i < FFT_N; i++) {
      const oi = base + i
      if (oi >= 0 && oi < target) out[oi]! += re[i]! * nwin[i]! * 0.5
    }
  }

  return out
}

/** Build a source-frame time-map for one note: keep the onset consonant near
 *  1:1, stretch or HOLD the vowel to fill `outFrames`. `vowelStart` is the
 *  source frame where the steady vowel begins. For a long hold the vowel index
 *  parks near the steady region with a slow wander so the timbre "breathes"
 *  instead of freezing dead-static. */
export function buildFrameMap(numSrc: number, vowelStart: number, outFrames: number): Float32Array {
  const map = new Float32Array(outFrames)
  const vs = Math.max(0, Math.min(numSrc - 1, vowelStart))
  const vowelSrc = Math.max(1, numSrc - vs) // frames of vowel available
  for (let j = 0; j < outFrames; j++) {
    if (j < vs) {
      map[j] = j // consonant / onset: 1:1
    } else {
      const into = j - vs
      const outVowel = Math.max(1, outFrames - vs)
      if (outVowel <= vowelSrc) {
        // note shorter than the vowel: linear compress
        map[j] = vs + (into / outVowel) * (vowelSrc - 1)
      } else {
        // note longer: advance partway then HOLD near the steady end, wandering
        const settle = Math.min(vowelSrc - 1, vowelSrc * 0.6)
        if (into < vowelSrc) {
          map[j] = vs + (into / vowelSrc) * settle
        } else {
          const wander = Math.sin(into * 0.12) * (vowelSrc * 0.12)
          map[j] = Math.max(vs, Math.min(numSrc - 1, vs + settle + wander))
        }
      }
    }
  }
  return map
}
