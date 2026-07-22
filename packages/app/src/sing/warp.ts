/* ------------------------------------------------------------------------- *
 * Phoneme-driven time-warp + melody f0 (pure TS). Given the spoken line, its
 * phoneme timeline (phonemes.ts) and the melody, builds:
 *   - a GUIDE track: each syllable placed on its note, consonants kept natural,
 *     the vowel held out to the note length by looping its STEADIEST window
 *     (clean even for diphthongs — no phase-vocoder pulsing), and
 *   - the exact melody F0 contour (with slides) on a fixed frame grid.
 * The guide + f0 feed RVC (rvc.ts), which supplies pitch + singer timbre. This
 * replaces PSOLA/the cepstral vocoder entirely — RVC does the hard part.
 * ------------------------------------------------------------------------- */
import type { Phone } from './phonemes'

/** One melody note. */
export interface MelodyNote {
  midi: number
  dur: number
  /** portamento: glide from the previous note's pitch into this one. */
  slide: boolean
}

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

/** Parse a melody spec: comma-separated `midi:dur[:s]`, `:s` = slide.
 *  e.g. "62:0.32,67:0.72,71:0.34:s". */
export function parseMelody(spec: string): MelodyNote[] {
  return spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const parts = p.split(':')
      return { midi: parseInt(parts[0]!, 10), dur: parseFloat(parts[1]!), slide: parts[2] === 's' }
    })
}

/* ------------------------------ tiny FFT -------------------------------- */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j |= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = -Math.PI / half
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vr = re[b]! * cr - im[b]! * ci
        const vi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - vr
        im[b] = im[a]! - vi
        re[a] = re[a]! + vr
        im[a] = im[a]! + vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** Center (sample) of the most STATIONARY `win`-sample window of `v` — min
 *  spectral flux, so we loop one vowel colour even inside a moving diphthong. */
function steadiestWindow(v: Float32Array, win: number): number {
  const N = 1024
  const hop = 256
  if (v.length < N * 2) return (v.length / 2) | 0
  const nf = Math.floor((v.length - N) / hop) + 1
  const mags: Float64Array[] = []
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  for (let f = 0; f < nf; f++) {
    const s = f * hop
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
      re[i] = (v[s + i] ?? 0) * w
      im[i] = 0
    }
    fft(re, im)
    const m = new Float64Array(N / 2)
    for (let k = 0; k < N / 2; k++) m[k] = Math.log(Math.hypot(re[k]!, im[k]!) + 1e-6)
    mags.push(m)
  }
  const flux = new Float64Array(nf)
  for (let f = 1; f < nf; f++) {
    let s = 0
    for (let k = 0; k < N / 2; k++) s += Math.abs(mags[f]![k]! - mags[f - 1]![k]!)
    flux[f] = s
  }
  const fw = Math.max(1, Math.floor(win / hop))
  const pre = new Float64Array(nf + 1)
  for (let f = 0; f < nf; f++) pre[f + 1] = pre[f]! + flux[f]!
  let best = Infinity
  let bi = 0
  for (let f = 0; f + fw <= nf; f++) {
    const tot = pre[f + fw]! - pre[f]!
    if (tot < best) {
      best = tot
      bi = f
    }
  }
  return Math.floor((bi + fw / 2) * hop)
}

/** Hold a vowel to `target` samples by looping its steadiest ~50ms window with
 *  equal-power crossfades (clean for diphthongs), keeping natural onset + tail. */
function holdVowel(v: Float32Array, target: number, sr: number): Float32Array {
  if (v.length >= target) return v.slice(0, target)
  if (v.length < 700) return stretchTo(v, target)
  const xf = Math.max(64, Math.floor(0.014 * sr))
  const winL = Math.max(Math.floor(0.05 * sr), xf * 3)
  const c = steadiestWindow(v, winL)
  const ls = Math.max(0, Math.min(v.length - winL, c - (winL >> 1)))
  const loop = v.subarray(ls, ls + winL)
  const onsetEnd = Math.min(ls + winL, v.length)
  const tailLen = Math.min(v.length - onsetEnd, Math.floor(0.05 * sr))
  const fin = (i: number): number => Math.sin((Math.PI / 2) * (i / xf))
  const fout = (i: number): number => Math.cos((Math.PI / 2) * (i / xf))
  let cur = Array.from(v.subarray(0, onsetEnd))
  const spliceLoop = (piece: Float32Array | number[]): void => {
    const n = cur.length
    for (let i = 0; i < xf && n - xf + i < n; i++) cur[n - xf + i] = cur[n - xf + i]! * fout(i) + (piece[i] as number) * fin(i)
    for (let i = xf; i < piece.length; i++) cur.push(piece[i] as number)
  }
  while (cur.length < target - tailLen - xf) spliceLoop(loop as unknown as number[])
  if (tailLen > xf) spliceLoop(v.subarray(v.length - tailLen))
  const out = new Float32Array(target)
  out.set(cur.slice(0, target))
  return out
}

/** Linear-interpolation resample of `v` to exactly `target` samples (used only
 *  to gently COMPRESS a vowel; holding is done by holdVowel). */
function stretchTo(v: Float32Array, target: number): Float32Array {
  const out = new Float32Array(target)
  if (v.length < 2) return out
  for (let i = 0; i < target; i++) {
    const t = (i / target) * (v.length - 1)
    const i0 = Math.floor(t)
    const f = t - i0
    out[i] = (v[i0] ?? 0) * (1 - f) + (v[i0 + 1] ?? 0) * f
  }
  return out
}

interface Span {
  s: number
  e: number
  vs: number
  ve: number
}

/** Group the phoneme stream into `n` syllables (one vowel each). Boundaries fall
 *  at the phone nearest the midpoint between consecutive vowels. */
function groupSyllables(phones: Phone[], n: number): Span[] {
  let vi = phones.map((p, i) => (p.vowel ? i : -1)).filter((i) => i >= 0)
  if (vi.length !== n) {
    // fall back to an even split over all phones
    vi = Array.from({ length: n }, (_, k) => Math.round((k * (phones.length - 1)) / Math.max(1, n - 1)))
  }
  const vStart = vi.map((k) => phones[k]!.start)
  const nearest = (time: number): number => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < phones.length; i++) {
      const d = Math.abs(phones[i]!.start - time)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return bi
  }
  const spans: Span[] = []
  for (let si = 0; si < n; si++) {
    const lo = si === 0 ? 0 : nearest((vStart[si - 1]! + vStart[si]!) / 2)
    const hi = si === n - 1 ? phones.length : nearest((vStart[si]! + vStart[si + 1]!) / 2)
    const grp = hi > lo ? phones.slice(lo, hi) : [phones[vi[si]!]!]
    const v = phones[vi[si]!]!
    spans.push({ s: grp[0]!.start, e: grp[grp.length - 1]!.end, vs: v.start, ve: v.end })
  }
  return spans
}

export interface GuideResult {
  guide: Float32Array
  sr: number
  /** f0 (Hz) per frame at `fps`, aligned to the guide (0 = unvoiced). */
  f0: Float32Array
  fps: number
}

/** Build the guide track (phoneme-warped, vowels held) + the melody f0 contour
 *  (with slides) for the given spoken line, phonemes and melody. */
export function buildGuide(spoken: Float32Array, sr: number, phones: Phone[], notes: MelodyNote[]): GuideResult {
  const spans = groupSyllables(phones, notes.length)
  const parts: Float32Array[] = []
  const noteLens: number[] = []
  const edge = Math.floor(0.006 * sr)
  for (let i = 0; i < notes.length; i++) {
    const sp = spans[i]!
    const tgt = Math.floor(notes[i]!.dur * sr)
    const onset = spoken.subarray(Math.floor(sp.s * sr), Math.floor(sp.vs * sr))
    const vowel = spoken.slice(Math.floor(sp.vs * sr), Math.floor(sp.ve * sr))
    const coda = spoken.subarray(Math.floor(sp.ve * sr), Math.floor(sp.e * sr))
    const vT = Math.max(Math.floor(tgt * 0.25), tgt - onset.length - coda.length)
    const held = holdVowel(vowel, vT, sr)
    const note = new Float32Array(onset.length + held.length + coda.length)
    note.set(onset, 0)
    note.set(held, onset.length)
    note.set(coda, onset.length + held.length)
    const fit = note.length >= tgt ? note.slice(0, tgt) : (() => { const p = new Float32Array(tgt); p.set(note); return p })()
    for (let k = 0; k < edge && k < fit.length; k++) {
      fit[k]! *= k / edge
      fit[fit.length - 1 - k]! *= k / edge
    }
    parts.push(fit)
    noteLens.push(fit.length)
  }
  let total = 0
  for (const p of parts) total += p.length
  const guide = new Float32Array(total)
  let pos = 0
  for (const p of parts) {
    guide.set(p, pos)
    pos += p.length
  }

  // f0 contour on a 100 Hz grid over the guide (slides = log-glide, first 35%).
  const fps = 100
  const nf = Math.max(1, Math.ceil(total / sr * fps))
  const f0 = new Float32Array(nf)
  let accSamp = 0
  let prev: number | null = null
  for (let i = 0; i < notes.length; i++) {
    const a = Math.floor((accSamp / sr) * fps)
    accSamp += noteLens[i]!
    const b = Math.floor((accSamp / sr) * fps)
    const hz = mtof(notes[i]!.midi)
    if (notes[i]!.slide && prev !== null && b > a) {
      const tr = Math.max(1, Math.floor((b - a) * 0.35))
      const from = Math.log(mtof(prev))
      const to = Math.log(hz)
      for (let f = a; f < a + tr && f < nf; f++) f0[f] = Math.exp(from + ((to - from) * (f - a)) / tr)
      for (let f = a + tr; f < b && f < nf; f++) f0[f] = hz
    } else {
      for (let f = a; f < b && f < nf; f++) f0[f] = hz
    }
    prev = notes[i]!.midi
  }
  return { guide, sr, f0, fps }
}
