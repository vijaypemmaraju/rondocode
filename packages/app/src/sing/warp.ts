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
import { note, TimeSpan, Fraction, hasOnset, type Pattern, type ControlMap } from '@rondocode/pattern'

/** One melody note. */
export interface MelodyNote {
  midi: number
  dur: number
  /** portamento: glide from the previous note's pitch into this one. */
  slide: boolean
}

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

/** Parse a MELODY from note mini-notation ("c4 e4 g4", "c4@2 e4", "[c4 e4] g4",
 *  "c4 ~ g4") through the real pattern engine — so pitch + rhythm are grid-locked
 *  and tempo-aware exactly like the rest of rondocode. Durations are converted to
 *  seconds via `cps` (cycles/sec). A note tagged with `slide:true` in a companion
 *  control isn't expressible in bare note mini-notation yet, so slides default off
 *  (portamento is applied separately, see buildGuide). `cycles` = how many cycles
 *  of the pattern to unroll (a one-line sequence is 1 cycle). */
export function parseMelodyMini(src: string, cps = 0.5, cycles = 1): MelodyNote[] {
  const pat = note(src) as Pattern<ControlMap>
  const span = new TimeSpan(new Fraction(0), new Fraction(cycles))
  return pat
    .query(span)
    .filter(hasOnset)
    .sort((a, b) => a.whole!.begin.valueOf() - b.whole!.begin.valueOf())
    .map((h) => ({ midi: h.value.note!, dur: h.whole!.length.valueOf() / cps, slide: false }))
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

/** Segment `n` syllables from a per-frame VOWEL-PROBABILITY curve (phonemes.ts),
 *  given the KNOWN syllable count `n`. Snaps exactly n vowel centres to the curve's
 *  peaks by Lloyd iteration (even-split regions → argmax per region → re-split at
 *  midpoints, repeat), so it can never drop or duplicate a syllable the way the
 *  greedy phoneme decode does. Each syllable's vowel extent grows out from its
 *  centre while the curve stays above a fraction of its peak; the rest of the
 *  region is onset (before) / coda (after). Times are in seconds. */
function placeSyllables(prob: Float32Array, fps: number, n: number): Span[] {
  const T = prob.length
  if (T === 0 || n <= 0) return []
  // light 3-frame smoothing so single-frame spikes don't win a region
  const sm = new Float32Array(T)
  for (let i = 0; i < T; i++) {
    let s = 0
    let c = 0
    for (let d = -1; d <= 1; d++) {
      const j = i + d
      if (j >= 0 && j < T) {
        s += prob[j]!
        c++
      }
    }
    sm[i] = s / c
  }
  let centers = Array.from({ length: n }, (_, i) => Math.min(T - 1, Math.floor((i + 0.5) * T / n)))
  const bounds = new Array<number>(n + 1)
  for (let iter = 0; iter < 4; iter++) {
    bounds[0] = 0
    bounds[n] = T
    for (let i = 1; i < n; i++) bounds[i] = Math.floor((centers[i - 1]! + centers[i]!) / 2)
    for (let i = 0; i < n; i++) {
      const lo = bounds[i]!
      const hi = Math.max(lo + 1, bounds[i + 1]!)
      let bi = lo
      let bv = -1
      for (let t = lo; t < hi; t++) {
        if (sm[t]! > bv) {
          bv = sm[t]!
          bi = t
        }
      }
      centers[i] = bi
    }
  }
  const spans: Span[] = []
  for (let i = 0; i < n; i++) {
    const segLo = bounds[i]!
    const segHi = Math.max(segLo + 1, bounds[i + 1]!)
    const c = Math.min(Math.max(centers[i]!, segLo), segHi - 1)
    const thr = Math.max(0.12, sm[c]! * 0.4)
    let vs = c
    while (vs > segLo && sm[vs - 1]! >= thr) vs--
    let ve = c
    while (ve < segHi - 1 && sm[ve + 1]! >= thr) ve++
    spans.push({ s: segLo / fps, e: segHi / fps, vs: vs / fps, ve: (ve + 1) / fps })
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
 *  (with slides) for the given spoken line, its per-frame vowel-probability curve
 *  (phonemes.ts `vowelActivity`) and the melody. The KNOWN note count drives the
 *  syllable segmentation, so alignment never miscounts. */
export function buildGuide(spoken: Float32Array, sr: number, prob: Float32Array, probFps: number, notes: MelodyNote[]): GuideResult {
  const spans = placeSyllables(prob, probFps, notes.length)
  // Split every syllable into onset (consonants before the vowel) / vowel / coda
  // up front, so the hold pass can see the NEXT syllable's onset length.
  const seg = notes.map((_, i) => {
    const sp = spans[i]!
    return {
      onset: spoken.subarray(Math.floor(sp.s * sr), Math.floor(sp.vs * sr)),
      vowel: spoken.slice(Math.floor(sp.vs * sr), Math.floor(sp.ve * sr)),
      coda: spoken.subarray(Math.floor(sp.ve * sr), Math.floor(sp.e * sr)),
    }
  })
  const parts: Float32Array[] = []
  const noteLens: number[] = []
  const edge = Math.floor(0.006 * sr)
  for (let i = 0; i < notes.length; i++) {
    const tgt = Math.floor(notes[i]!.dur * sr)
    const { onset, vowel, coda } = seg[i]!
    const nextOnset = i + 1 < notes.length ? seg[i + 1]!.onset.length : 0
    // VOWEL-ON-BEAT: hold this vowel so it fills the note UP TO the point where
    // the next syllable's onset consonants must begin — those consonants lead
    // INTO the next beat and end exactly on it. Net effect: every vowel (the
    // pitched, perceptually-timed part) lands on its note's beat, and consonants
    // sit ahead of the beat like a real singer. (Was `tgt - onset - coda`, which
    // put THIS onset inside the slot so the vowel started late by its length.)
    const vT = Math.max(Math.floor(tgt * 0.2), tgt - coda.length - nextOnset)
    const held = holdVowel(vowel, vT, sr)
    const note = new Float32Array(onset.length + held.length + coda.length)
    note.set(onset, 0)
    note.set(held, onset.length)
    note.set(coda, onset.length + held.length)
    for (let k = 0; k < edge && k < note.length; k++) {
      note[k]! *= k / edge
      note[note.length - 1 - k]! *= k / edge
    }
    parts.push(note)
    noteLens.push(note.length)
  }
  let total = 0
  for (const p of parts) total += p.length
  const raw = new Float32Array(total)
  let pos = 0
  for (const p of parts) {
    raw.set(p, pos)
    pos += p.length
  }
  // Trim (or pad) to the EXACT musical length (sum of note durations). The
  // vowel-on-beat hold makes each slot onset+vowel+coda, so the buffer runs
  // long by the first syllable's lead-in consonant; left unclipped, that lead-in
  // would push every following chunk — and the whole vocal — progressively late.
  // The excess we drop is tail off the final (held) vowel: inaudible.
  let musical = 0
  for (const n of notes) musical += Math.floor(n.dur * sr)
  const guide = new Float32Array(musical)
  guide.set(total >= musical ? raw.subarray(0, musical) : raw)

  // f0 contour on a 100 Hz grid over the guide (slides = log-glide, first 35%).
  const fps = 100
  const nf = Math.max(1, Math.ceil(musical / sr * fps))
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
