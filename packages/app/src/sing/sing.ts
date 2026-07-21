/* ------------------------------------------------------------------------- *
 * sing(text, melody) — the vocaloid pipeline, in the browser:
 *   Supertonic speaks the text → segment into syllables → TD-PSOLA retunes +
 *   retimes each syllable onto its melody note (formants preserved) → concat.
 * Keeps the real voice, so the words stay intelligible (a vocoder would blur
 * them). Segmentation is energy-nucleus + force-to-count, ported from the
 * offline prototype; Whisper word-alignment is a later robustness upgrade.
 * ------------------------------------------------------------------------- */
import { psola, estimateF0 } from './psola'
import type { SupertonicEngine } from './supertonic'
import { parseLyrics } from './lyrics'
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

/** Retune+retime a syllable onto a note (PSOLA) with a per-note amp envelope. */
function singSyllable(seg: Float32Array, sr: number, note: Note, globalF0: number): Float32Array {
  const f0in = estimateF0(seg, sr) || globalF0
  const target = Math.floor(note.dur * sr)
  const y = psola(seg, sr, target / Math.max(1, seg.length), mtof(note.midi), f0in)
  const out = y.length >= target ? y.slice(0, target) : (() => {
    const p = new Float32Array(target)
    p.set(y)
    return p
  })()
  const a = Math.floor(0.02 * sr)
  const r = Math.floor(0.05 * sr)
  for (let i = 0; i < a; i++) out[i]! *= i / a
  for (let i = 0; i < r; i++) out[out.length - 1 - i]! *= i / r
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

/** Equal-power crossfade concat + peak-normalize. */
function concatNormalize(parts: Float32Array[], sr: number): Float32Array {
  const xf = Math.floor(0.02 * sr)
  let total = 0
  for (const p of parts) total += p.length
  total -= xf * Math.max(0, parts.length - 1)
  const out = new Float32Array(Math.max(1, total))
  let pos = 0
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!
    for (let i = 0; i < p.length; i++) {
      let g = 1
      if (k > 0 && i < xf) g = i / xf
      if (k < parts.length - 1 && i > p.length - xf) g = (p.length - i) / xf
      const oi = pos + i
      if (oi < out.length) out[oi]! += p[i]! * g
    }
    pos += p.length - xf
  }
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!))
  const norm = peak > 1e-6 ? 0.9 / peak : 1
  for (let i = 0; i < out.length; i++) out[i]! *= norm
  return out
}

/** Sing lyrics (mini-notation, see lyrics.ts) on a melody using Whisper word
 *  alignment: Supertonic speaks the words → Whisper places each word → split it
 *  into its hyphen-specified syllables → PSOLA each onto its note (melisma holds
 *  the syllable, ~ is a silent note). One slot per note. */
export async function singWithLyrics(
  engine: SupertonicEngine,
  lyrics: string,
  melody: Note[],
  opts: { voice?: string; onProgress?: (p: { phase: string; done: number; total: number }) => void } = {},
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

  // audio per slot: split each word (Whisper-bounded) into its syllables;
  // melisma slots hold the last real syllable's audio.
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
  return { audio: concatNormalize(parts, sr), sr }
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
  return { audio: concatNormalize(parts, sr), sr }
}
