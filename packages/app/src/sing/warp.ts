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

// Sustained-note vibrato (see assembleGuide). Delay so short notes get none.
const VIB_DELAY = 0.18 // s before vibrato starts
const VIB_RAMP = 0.18 // s to ease it in
const VIB_RATE = 5.5 // Hz
const VIB_DEPTH = 0.0105 // ≈ 18 cents peak

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
function placeSyllables(prob: Float32Array, energy: Float32Array, fps: number, n: number): Span[] {
  const T = prob.length
  if (T === 0 || n <= 0) return []
  // Nucleus strength = vowel-probability WEIGHTED BY LOUDNESS. Weighting by energy
  // is what keeps a centre from snapping into a silent gap between repeated words
  // (e.g. the 2nd "twinkle"), which used to give that syllable a silent held vowel
  // — i.e. a dropped word. 3-frame smoothing so single-frame spikes don't win.
  let emax = 1e-9
  for (let i = 0; i < T; i++) emax = Math.max(emax, energy[i] ?? 0)
  const raw = new Float32Array(T)
  for (let i = 0; i < T; i++) raw[i] = prob[i]! * (0.25 + 0.75 * Math.sqrt((energy[i] ?? 0) / emax))
  const sm = new Float32Array(T)
  for (let i = 0; i < T; i++) {
    let s = 0
    let c = 0
    for (let d = -1; d <= 1; d++) {
      const j = i + d
      if (j >= 0 && j < T) { s += raw[j]!; c++ }
    }
    sm[i] = s / c
  }
  // Snap each syllable to the strongest nucleus WITHIN A WINDOW around its evenly
  // spaced position. TTS syllables are close to equal-length, so this prior keeps
  // a centre from wandering across a pause into the wrong word (which is what put
  // a whole region — and its held vowel — into the silence between two "twinkle"s).
  const segW = T / n
  const win = 0.45 * segW
  const centers = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const even = (i + 0.5) * segW
    const lo = Math.max(0, Math.floor(even - win))
    const hi = Math.min(T, Math.ceil(even + win) + 1)
    let bi = Math.min(T - 1, Math.floor(even))
    let bv = -1
    for (let t = lo; t < hi; t++) {
      if (sm[t]! > bv) { bv = sm[t]!; bi = t }
    }
    centers[i] = bi
  }
  const bounds = new Array<number>(n + 1)
  bounds[0] = 0
  bounds[n] = T
  for (let i = 1; i < n; i++) bounds[i] = Math.floor((centers[i - 1]! + centers[i]!) / 2)
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
    // floor the vowel width so a mis-centred syllable never holds near-silence:
    // at least ~40% of the region, centred on c.
    const minW = Math.max(2, Math.floor(0.4 * (segHi - segLo)))
    if (ve - vs + 1 < minW) {
      const half = minW >> 1
      vs = Math.max(segLo, c - half)
      ve = Math.min(segHi - 1, c + half)
    }
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
  return assembleGuide(syllableSegments(spoken, sr, prob, probFps, notes.length), notes, sr)
}

/** One syllable, split into onset (consonants before the vowel) / vowel / coda. */
export interface Seg {
  onset: Float32Array
  vowel: Float32Array
  coda: Float32Array
}

/** Cut `n` syllables out of a spoken clip using its vowel-probability curve.
 *  Returned segments feed assembleGuide — collect them across phrase chunks and
 *  assemble the whole song in one pass so cross-chunk placement stays on-grid. */
export function syllableSegments(spoken: Float32Array, sr: number, prob: Float32Array, probFps: number, n: number): Seg[] {
  // RMS energy per prob frame, so the segmenter can weight vowel-probability by
  // loudness (silent gaps between repeated words no longer attract a centre).
  const T = prob.length
  const energy = new Float32Array(T)
  const hop = sr / probFps
  for (let f = 0; f < T; f++) {
    const a = Math.floor(f * hop)
    const b = Math.min(spoken.length, Math.floor((f + 1) * hop))
    let s = 0
    for (let i = a; i < b; i++) s += spoken[i]! * spoken[i]!
    energy[f] = b > a ? Math.sqrt(s / (b - a)) : 0
  }
  return placeSyllables(prob, energy, probFps, n).map((sp) => ({
    onset: spoken.subarray(Math.floor(sp.s * sr), Math.floor(sp.vs * sr)),
    vowel: new Float32Array(spoken.subarray(Math.floor(sp.vs * sr), Math.floor(sp.ve * sr))),
    coda: spoken.subarray(Math.floor(sp.ve * sr), Math.floor(sp.e * sr)),
  }))
}

/** Assemble the full guide + melody f0 from per-syllable segments, placing EVERY
 *  vowel's onset exactly on its note's beat. Each syllable's leading consonants
 *  are borrowed from BEFORE the beat (overlapping the previous syllable's tail
 *  with a short equal-power crossfade), so consonants lead into the beat and the
 *  vowel lands on it — like a real singer — with no per-chunk drift. Only the very
 *  first syllable of the whole song keeps a natural lead-in (nothing precedes it).
 *  f0 sits on the exact beat grid, so pitch and words stay locked together. */
export function assembleGuide(segs: Seg[], notes: MelodyNote[], sr: number): GuideResult {
  const n = notes.length
  const tgt = notes.map((nn) => Math.floor(nn.dur * sr))
  const beat = [0]
  for (let i = 0; i < n; i++) beat.push(beat[i]! + tgt[i]!)
  const total = beat[n]!
  const guide = new Float32Array(total)
  const xf = Math.floor(0.008 * sr)
  for (let i = 0; i < n; i++) {
    const { onset, vowel, coda } = segs[i]!
    // onset ends on the beat; if it can't fit before t=0 (first syllable), it
    // becomes a lead-in and the vowel starts just after it instead.
    let oStart = beat[i]! - onset.length
    let vPos = beat[i]!
    if (oStart < 0) { oStart = 0; vPos = onset.length }
    // hold the vowel to fill until the NEXT syllable's onset must begin
    const nextOnsetLen = i < n - 1 ? segs[i + 1]!.onset.length : 0
    const budgetEnd = i < n - 1 ? beat[i + 1]! - nextOnsetLen : total
    const vHeldLen = Math.max(Math.floor(tgt[i]! * 0.2), budgetEnd - vPos - coda.length)
    const held = holdVowel(vowel, vHeldLen, sr)
    // write onset: equal-power crossfade over its first xf samples against
    // whatever is already there (the previous syllable's held tail), then overwrite
    for (let k = 0; k < onset.length; k++) {
      const gi = oStart + k
      if (gi < 0 || gi >= total) continue
      const s = onset[k]!
      if (k < xf) {
        const a = Math.sin((Math.PI / 2) * (k / xf))
        guide[gi] = guide[gi]! * Math.cos((Math.PI / 2) * (k / xf)) + s * a
      } else guide[gi] = s
    }
    for (let k = 0; k < held.length; k++) { const gi = vPos + k; if (gi < total) guide[gi] = held[k]! }
    for (let k = 0; k < coda.length; k++) { const gi = vPos + held.length + k; if (gi < total) guide[gi] = coda[k]! }
  }
  // gentle fade in/out at the very ends only
  const edge = Math.floor(0.006 * sr)
  for (let k = 0; k < edge && k < total; k++) {
    guide[k]! *= k / edge
    guide[total - 1 - k]! *= k / edge
  }

  // f0 on a 100 Hz grid, exactly on the beat grid (slides = log-glide, first 35%).
  const fps = 100
  const nf = Math.max(1, Math.ceil((total / sr) * fps))
  const f0 = new Float32Array(nf)
  let prev: number | null = null
  for (let i = 0; i < n; i++) {
    const a = Math.floor((beat[i]! / sr) * fps)
    const b = Math.floor((beat[i + 1]! / sr) * fps)
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
    // Gentle vibrato on the SUSTAINED part of a note. A held vowel rendered from
    // a looped window comes out as a dead-flat tone (worst on the final long note
    // — "...you arrre"); a delayed, ramped ±~18-cent / 5.5 Hz vibrato makes it
    // breathe like a real singer. Short notes never reach the delay, so attacks
    // stay clean. (This is f0-level vibrato through RVC — smooth, unlike the old
    // PSOLA vibrato.)
    for (let f = a; f < b && f < nf; f++) {
      const t = (f - a) / fps
      if (t <= VIB_DELAY) continue
      const env = Math.min(1, (t - VIB_DELAY) / VIB_RAMP)
      f0[f]! *= 1 + VIB_DEPTH * env * Math.sin(2 * Math.PI * VIB_RATE * (t - VIB_DELAY))
    }
    prev = notes[i]!.midi
  }
  return { guide, sr, f0, fps }
}
