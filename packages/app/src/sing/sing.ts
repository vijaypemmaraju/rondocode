/* ------------------------------------------------------------------------- *
 * sing(text, melody) — the vocaloid pipeline, in the browser:
 *   Supertonic speaks the text → segment into syllables → TD-PSOLA retunes +
 *   retimes each syllable onto its melody note (formants preserved) → concat.
 * Keeps the real voice, so the words stay intelligible (a vocoder would blur
 * them). Segmentation is energy-nucleus + force-to-count, ported from the
 * offline prototype; Whisper word-alignment is a later robustness upgrade.
 * ------------------------------------------------------------------------- */
import { psola, estimateF0, olaStretch } from './psola'
import type { SupertonicEngine } from './supertonic'
import { parseLyrics, type ParsedLyrics } from './lyrics'
import { loadAligner, alignWords } from './align'

/** One melody note: MIDI number + duration in seconds. */
export interface Note {
  midi: number
  dur: number
}

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

/** Windowed-RMS envelope. */
function envelope(x: Float32Array, w: number): Float32Array {
  const e = new Float32Array(x.length)
  let acc = 0
  for (let i = 0; i < x.length; i++) {
    acc += x[i]! * x[i]!
    if (i >= w) acc -= x[i - w]! * x[i - w]!
    e[i] = Math.sqrt(Math.max(acc / w, 1e-12))
  }
  return e
}

function trim(x: Float32Array, sr: number, th = 0.05): Float32Array {
  const e = envelope(x, Math.floor(0.01 * sr))
  let peak = 0
  for (let i = 0; i < e.length; i++) peak = Math.max(peak, e[i]!)
  const t = peak * th
  let a = 0
  let b = x.length - 1
  while (a < b && e[a]! < t) a++
  while (b > a && e[b]! < t) b--
  return x.subarray(Math.max(0, a - 220), Math.min(x.length, b + 220))
}

/** Local maxima above `height`, keeping the taller of any pair closer than
 *  `minDist` (a lightweight scipy.find_peaks). */
function findPeaks(en: Float32Array, minDist: number, height: number): number[] {
  const peaks: number[] = []
  for (let i = 1; i < en.length - 1; i++) {
    if (en[i]! > height && en[i]! >= en[i - 1]! && en[i]! > en[i + 1]!) {
      const last = peaks[peaks.length - 1]
      if (last !== undefined && i - last < minDist) {
        if (en[i]! > en[last]!) peaks[peaks.length - 1] = i
      } else peaks.push(i)
    }
  }
  return peaks
}

function splitAtValley(en: Float32Array, from: number, to: number): number {
  const lo = from + Math.floor((to - from) * 0.3)
  const hi = from + Math.floor((to - from) * 0.7)
  let m = lo
  for (let i = lo; i < hi; i++) if (en[i]! < en[m]!) m = i
  return m
}

/** Split `x` into exactly `n` syllable segments at energy valleys between the
 *  nearest-to-n energy peaks; force the count by splitting the longest / merging
 *  the shortest. */
function segmentToN(x: Float32Array, sr: number, n: number): Float32Array[] {
  const en = envelope(x, Math.floor(0.035 * sr))
  let emax = 0
  for (let i = 0; i < en.length; i++) emax = Math.max(emax, en[i]!)
  for (let i = 0; i < en.length; i++) en[i]! /= emax || 1
  const minDist = Math.floor(0.11 * sr)
  let peaks: number[] = []
  for (const h of [0.12, 0.1, 0.14, 0.08, 0.16, 0.06]) {
    const p = findPeaks(en, minDist, h)
    if (peaks.length === 0 || Math.abs(p.length - n) < Math.abs(peaks.length - n)) peaks = p
    if (p.length === n) break
  }
  // boundaries → segments
  let bounds: number[] = [0]
  for (let i = 0; i < peaks.length - 1; i++) bounds.push(splitAtValley(en, peaks[i]!, peaks[i + 1]!))
  bounds.push(x.length)
  let segs = bounds.slice(0, -1).map((_, i) => ({ from: bounds[i]!, to: bounds[i + 1]! }))
  if (segs.length === 0) segs = [{ from: 0, to: x.length }]
  while (segs.length < n) {
    let li = 0
    for (let i = 1; i < segs.length; i++) if (segs[i]!.to - segs[i]!.from > segs[li]!.to - segs[li]!.from) li = i
    const s = segs[li]!
    const m = splitAtValley(en, s.from, s.to)
    segs.splice(li, 1, { from: s.from, to: m }, { from: m, to: s.to })
  }
  while (segs.length > n) {
    let si = 0
    for (let i = 1; i < segs.length; i++) if (segs[i]!.to - segs[i]!.from < segs[si]!.to - segs[si]!.from) si = i
    const j = si === segs.length - 1 ? si - 1 : si + 1
    const lo = Math.min(si, j)
    const hi = Math.max(si, j)
    segs.splice(lo, 2, { from: segs[lo]!.from, to: segs[hi]!.to })
  }
  return segs.map((s) => x.slice(s.from, s.to))
}

/** Target per-note RMS: every syllable is scaled toward this so no single note
 *  (a plosive onset, a loud vowel) dominates the phrase. Gain is clamped so a
 *  quiet/unvoiced syllable isn't boosted into noise. */
const NOTE_RMS = 0.16

/** RMS of a signal's voiced core: the loudest contiguous ~60% by energy, so
 *  leading/trailing quiet doesn't drag the estimate down (used for level-evening
 *  so every note lands at a similar loudness). */
function coreRms(x: Float32Array): number {
  const n = x.length
  if (n < 8) {
    let s = 0
    for (let i = 0; i < n; i++) s += x[i]! * x[i]!
    return Math.sqrt(s / Math.max(1, n))
  }
  // prefix energy → energy in a sliding 60%-width window, keep the max
  const w = Math.max(1, Math.floor(n * 0.6))
  const pre = new Float32Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + x[i]! * x[i]!
  let best = 0
  for (let i = 0; i + w <= n; i++) best = Math.max(best, pre[i + w]! - pre[i]!)
  return Math.sqrt(best / w)
}

/** Beyond this stretch, uniform PSOLA time-stretch turns to static-grain buzz
 *  (and smears any consonant in the syllable). Past it we hold the note by
 *  looping the vowel instead — see sustainVowel(). */
const MAX_UNIFORM_STRETCH = 2.4

/** The voiced vowel nucleus of a (pitched) syllable: the loudest ~period-stable
 *  run. Returns [start,end) sample indices — the region safe to loop for a
 *  sustain (consonants live outside it). */
function vowelNucleus(x: Float32Array, sr: number, f0: number): [number, number] {
  const P = Math.max(1, Math.floor(sr / f0))
  const win = Math.max(2 * P, Math.floor(0.03 * sr))
  const e = envelope(x, win)
  let peak = 0
  let pi = 0
  for (let i = 0; i < e.length; i++)
    if (e[i]! > peak) {
      peak = e[i]!
      pi = i
    }
  // grow outward from the energy peak while we stay above 55% of it
  const th = peak * 0.55
  let a = pi
  let b = pi
  while (a > 0 && e[a - 1]! > th) a--
  while (b < x.length - 1 && e[b + 1]! > th) b++
  return [a, b + 1]
}

/** Hold a pitched syllable out to `target` samples by looping its vowel nucleus
 *  (period-aligned, equal-power crossfades) between the natural onset and coda —
 *  so consonants keep their length and only the vowel sustains. Avoids the
 *  static-grain buzz of stretching the whole syllable uniformly. */
function sustainVowel(x: Float32Array, sr: number, target: number, f0: number): Float32Array {
  const n = x.length
  if (n >= target) return x.slice(0, target)
  const P = Math.max(2, Math.floor(sr / f0))
  const [ns, ne] = vowelNucleus(x, sr, f0)
  // The loop source is strictly INSIDE the nucleus [ns, ne) — never past it (that
  // was reading zeros/coda). Need at least ~2 periods to loop cleanly.
  const nucLen = ne - ns
  if (nucLen < 3 * P) {
    // nucleus too short to loop — fall back to a plain OLA stretch (no buzz-repeat)
    return olaStretch(x, target, sr)
  }
  const periods = Math.max(2, Math.min(6, Math.floor(nucLen / P) - 1))
  const loopLen = Math.min(nucLen - P, periods * P) // fits inside nucleus
  const loopStart = ne - loopLen // loop the END of the vowel (steadiest)
  const coda = Math.min(n - ne, Math.floor(0.05 * sr))
  const xf = Math.min(P, loopLen >> 1)
  const out = new Float32Array(target)
  // 1) everything up to the loop region, verbatim (onset consonant + vowel start)
  let w = Math.min(loopStart, target)
  for (let i = 0; i < w; i++) out[i] = x[i]!
  // 2) loop the steady vowel tail (period-aligned, equal-power crossfade at seams)
  const codaRoom = Math.max(w + 1, target - coda)
  let guard = 0
  while (w < codaRoom && guard++ < 100000) {
    const start = w - xf
    for (let i = 0; i < loopLen && start + i < target; i++) {
      const s = x[loopStart + i]! // guaranteed in-bounds: loopStart+loopLen = ne ≤ n
      const oi = start + i
      if (oi < 0) continue
      if (i < xf && oi < w) out[oi] = out[oi]! * Math.cos((Math.PI / 2) * (i / xf)) + s * Math.sin((Math.PI / 2) * (i / xf))
      else out[oi] = s
    }
    w = start + loopLen
  }
  // 3) crossfade the natural coda back on at the very end
  const codaSrc = n - coda
  const cStart = target - coda
  for (let i = 0; i < coda && cStart + i < target; i++) {
    const s = x[codaSrc + i]!
    const oi = cStart + i
    if (oi < 0) continue
    if (i < xf) out[oi] = out[oi]! * Math.cos((Math.PI / 2) * (i / xf)) + s * Math.sin((Math.PI / 2) * (i / xf))
    else out[oi] = s
  }
  return out
}

/** Retune+retime a syllable onto a note, rendered exactly `note.dur` long. Up to
 *  a moderate stretch, uniform PSOLA; for long held notes, pitch to natural
 *  length then loop the vowel (sustainVowel) so consonants don't smear and the
 *  sustain doesn't buzz. Then level-even and articulate. */
function singSyllable(seg: Float32Array, sr: number, note: Note, globalF0: number): Float32Array {
  const f0in = estimateF0(seg, sr) || globalF0
  const f0out = mtof(note.midi)
  const target = Math.floor(note.dur * sr)
  const stretch = target / Math.max(1, seg.length)
  let y: Float32Array
  if (stretch <= MAX_UNIFORM_STRETCH) {
    y = psola(seg, sr, target / Math.max(1, seg.length), f0out, f0in)
  } else {
    // pitch to ~natural length, then hold the vowel out to the note length
    const natural = psola(seg, sr, 1, f0out, f0in)
    y = sustainVowel(natural, sr, target, f0out)
  }
  const out = new Float32Array(target)
  out.set(y.length >= target ? y.subarray(0, target) : y)
  // even the level: scale toward NOTE_RMS measured over the VOICED CORE (the
  // loudest run), so a syllable's quiet edges/silence don't skew the estimate.
  // Clamped so a near-unvoiced syllable isn't boosted into noise.
  const rms = coreRms(out)
  if (rms > 1e-4) {
    const g = Math.min(8, Math.max(0.12, NOTE_RMS / rms))
    for (let i = 0; i < out.length; i++) out[i]! *= g
  }
  // articulate
  const a = Math.min(Math.floor(0.008 * sr), out.length >> 1)
  const r = Math.min(Math.floor(0.04 * sr), out.length >> 1)
  for (let i = 0; i < a; i++) out[i]! *= i / a
  for (let i = 0; i < r; i++) out[out.length - 1 - i]! *= i / r
  return out
}

/** Place each note at its EXACT cumulative onset (∑dur, so nothing drifts). Notes
 *  abut rather than overlap — each already attacks from and releases to zero, so
 *  the joins are click-free without a crossfade that would blur articulation.
 *  Final pass peak-normalizes the whole phrase. */
function placeNotes(parts: Float32Array[], durs: number[], sr: number): Float32Array {
  const onsets: number[] = []
  let acc = 0
  for (let i = 0; i < durs.length; i++) {
    onsets.push(Math.round(acc * sr))
    acc += durs[i]!
  }
  const total = Math.round(acc * sr)
  const out = new Float32Array(Math.max(1, total))
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!
    const base = onsets[k]!
    for (let i = 0; i < p.length; i++) {
      const oi = base + i
      if (oi >= 0 && oi < out.length) out[oi]! += p[i]!
    }
  }
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!))
  const norm = peak > 1e-6 ? 0.9 / peak : 1
  for (let i = 0; i < out.length; i++) out[i]! *= norm
  return out
}

/** Split a segment into exactly `k` pieces at energy valleys near the even
 *  divisions — reliable inside a single Whisper-bounded word. */
function splitK(seg: Float32Array, sr: number, k: number): Float32Array[] {
  if (k <= 1 || seg.length < 2) return [seg]
  const e = envelope(seg, Math.floor(0.02 * sr))
  const n = seg.length
  const b = [0]
  for (let j = 1; j < k; j++) {
    const lo = Math.max(1, Math.floor(n * (j / k - 0.12)))
    const hi = Math.min(n - 1, Math.floor(n * (j / k + 0.12)))
    let m = lo
    for (let i = lo; i < hi; i++) if (e[i]! < e[m]!) m = i
    b.push(hi > lo ? m : Math.floor((n * j) / k))
  }
  b.push(n)
  return b.slice(0, -1).map((_, i) => seg.slice(b[i]!, b[i + 1]!))
}

/** Sing lyrics (mini-notation, see lyrics.ts) on a melody using Whisper word
 *  alignment: Supertonic speaks the words → Whisper places each word → split it
 *  into its hyphen-specified syllables → PSOLA each onto its note (melisma holds
 *  the syllable, ~ is a silent note). One slot per note. */
export async function singWithLyrics(
  engine: SupertonicEngine,
  lyrics: string,
  melody: Note[],
  opts: {
    voice?: string
    onProgress?: (p: { phase: string; done: number; total: number }) => void
    /** DEV: capture the (non-deterministic) TTS + alignment result so the pure
     *  DSP stage can be re-run on the SAME spoken audio while tuning. */
    capture?: (c: AlignedSpeech) => void
  } = {},
): Promise<{ audio: Float32Array; sr: number }> {
  const parsed = parseLyrics(lyrics)
  if (parsed.slots.length !== melody.length) {
    throw new Error(`lyrics has ${parsed.slots.length} syllables but melody has ${melody.length} notes`)
  }
  const sr = engine.sampleRate
  const spoken = trim(await engine.synthesize(parsed.text, { voice: opts.voice, onProgress: (p) => opts.onProgress?.({ phase: p.phase, done: p.done, total: p.total }) }), sr)
  const gf0 = estimateF0(spoken, sr) || 180
  await loadAligner()
  const words = await alignWords(spoken, sr)
  const cap: AlignedSpeech = { spoken, words, gf0, sr }
  opts.capture?.(cap)
  return { audio: renderSung(cap, parsed, melody), sr }
}

/** A captured TTS+alignment result — everything the pure DSP stage needs, so it
 *  can be re-rendered deterministically (TTS + Whisper are non-deterministic). */
export interface AlignedSpeech {
  spoken: Float32Array
  words: { text: string; start: number; end: number }[]
  gf0: number
  sr: number
}

/** Pure, deterministic DSP stage: slice each Whisper-bounded word into its
 *  hyphen syllables → PSOLA each onto its note (melisma holds, ~ is silent) →
 *  place at exact onsets. Split out from singWithLyrics so it can be re-run on a
 *  captured `AlignedSpeech` while tuning, with no fresh TTS/alignment noise. */
export function renderSung(cap: AlignedSpeech, parsed: ParsedLyrics, melody: Note[]): Float32Array {
  const { spoken, words, gf0, sr } = cap
  const slotAudio: (Float32Array | null)[] = new Array(parsed.slots.length).fill(null)
  for (let wi = 0; wi < parsed.words.length; wi++) {
    const w = parsed.words[wi]!
    const t = words[wi]
    let seg = t
      ? spoken.slice(Math.floor(t.start * sr), Math.floor(t.end * sr))
      : spoken.slice(Math.floor((spoken.length * wi) / parsed.words.length), Math.floor((spoken.length * (wi + 1)) / parsed.words.length))
    if (seg.length < 8) seg = spoken.slice(0, Math.min(spoken.length, Math.floor(0.2 * sr)))
    const sylls = splitK(seg, sr, w.syllableCount)
    let si = 0
    for (const slotIdx of w.slots) {
      if (parsed.slots[slotIdx]!.melisma) slotAudio[slotIdx] = sylls[Math.max(0, si - 1)]!
      else {
        slotAudio[slotIdx] = sylls[Math.min(si, sylls.length - 1)]!
        si++
      }
    }
  }
  const parts = melody.map((note, i) => {
    const seg = slotAudio[i]
    if (parsed.slots[i]!.rest || !seg || seg.length < 8) return new Float32Array(Math.floor(note.dur * sr))
    return singSyllable(seg, sr, note, gf0)
  })
  return placeNotes(parts, melody.map((n) => n.dur), sr)
}

/** Speak `text`, then sing it on `melody` (one syllable per note). Returns a mono
 *  Float32Array at the engine's sample rate. */
export async function sing(
  engine: SupertonicEngine,
  text: string,
  melody: Note[],
  opts: { voice?: string; onProgress?: (p: { phase: string; done: number; total: number }) => void } = {},
): Promise<{ audio: Float32Array; sr: number }> {
  const sr = engine.sampleRate
  const spoken = trim(await engine.synthesize(text, { voice: opts.voice, onProgress: (p) => opts.onProgress?.({ phase: p.phase, done: p.done, total: p.total }) }), sr)
  const globalF0 = estimateF0(spoken, sr) || 180
  const segs = segmentToN(spoken, sr, melody.length)

  const parts = melody.map((note, i) => singSyllable(segs[i]!, sr, note, globalF0))
  return { audio: placeNotes(parts, melody.map((n) => n.dur), sr), sr }
}
