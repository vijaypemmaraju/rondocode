/* ------------------------------------------------------------------------- *
 * renderNeural: the full text→singing pipeline as one call, used by both the
 * dev hook and the editor's sing() render manager. Both lyrics and notes are
 * mini-notation; `cps` sets the tempo (note durations resolve through the
 * pattern engine). Returns a mono clip + sample rate.
 *   Supertonic TTS → wav2vec2 phoneme CTC → vowel-aware warp → RVC(voice).
 * ------------------------------------------------------------------------- */
import { loadEngine } from './supertonic'
import { parseLyrics } from './lyrics'
import { loadPhonemes, extractPhonemes } from './phonemes'
import { buildGuide, parseMelodyMini } from './warp'
import { loadRvc, rvcConvert } from './rvc'

/** Coarse progress for the render dialog. `phase` names the stage; when a model
 *  is downloading, done/total are bytes. */
export interface SingProgress {
  phase: string
  label: string
  done: number
  total: number
}

export async function renderNeural(
  lyrics: string,
  notes: string,
  cps: number,
  voice: string,
  onProgress?: (p: SingProgress) => void,
): Promise<{ audio: Float32Array; sr: number }> {
  const parsed = parseLyrics(lyrics)
  const melody = parseMelodyMini(notes, cps)
  if (parsed.slots.length !== melody.length) {
    throw new Error(`sing(): ${parsed.slots.length} syllables but ${melody.length} notes`)
  }

  const engine = await loadEngine((p) => onProgress?.({ phase: p.phase, label: p.label, done: p.done, total: p.total }))
  const sr = engine.sampleRate
  await loadPhonemes((p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))

  // CHUNK into short phrases (≤ MAX_SYL syllables) at word boundaries. The
  // phoneme CTC drops/duplicates phonemes on long takes (a whole 42-syllable
  // verse mangles), so synthesize + align each phrase separately — short takes
  // are reliable AND let us speak a touch slower for clarity — then concatenate
  // the guide tracks. Slot ranges (word.slots) drive the per-chunk note slice so
  // melisma/rests ride along.
  const MAX_SYL = 9
  const groups: { text: string; from: number; to: number }[] = []
  let curWords: string[] = []
  let curSyl = 0
  let curFrom = 0
  for (const w of parsed.words) {
    if (curWords.length === 0) curFrom = w.slots[0]!
    if (curSyl + w.syllableCount > MAX_SYL && curWords.length > 0) {
      const prev = parsed.words[parsed.words.indexOf(w) - 1]!
      groups.push({ text: curWords.join(' '), from: curFrom, to: prev.slots[prev.slots.length - 1]! + 1 })
      curWords = []
      curSyl = 0
      curFrom = w.slots[0]!
    }
    curWords.push(w.text)
    curSyl += w.syllableCount
  }
  if (curWords.length > 0) {
    const last = parsed.words[parsed.words.length - 1]!
    groups.push({ text: curWords.join(' '), from: curFrom, to: last.slots[last.slots.length - 1]! + 1 })
  }

  const guides: Float32Array[] = []
  const f0s: Float32Array[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!
    const chunkNotes = melody.slice(g.from, g.to)
    // slower TTS is safe here (short chunk = reliable CTC) → crisper phonemes
    const speed = chunkNotes.length <= 12 ? 0.7 : 0.9
    onProgress?.({ phase: 'synthesize', label: `phrase ${gi + 1}/${groups.length}`, done: gi, total: groups.length })
    const spoken = await engine.synthesize(g.text, { speed })
    const phones = await extractPhonemes(spoken, sr)
    const built = buildGuide(spoken, sr, phones, chunkNotes)
    guides.push(built.guide)
    f0s.push(built.f0)
  }

  let gl = 0
  let fl = 0
  for (const x of guides) gl += x.length
  for (const x of f0s) fl += x.length
  const guide = new Float32Array(gl)
  const f0 = new Float32Array(fl)
  let go = 0
  let fo = 0
  for (const x of guides) {
    guide.set(x, go)
    go += x.length
  }
  for (const x of f0s) {
    f0.set(x, fo)
    fo += x.length
  }

  await loadRvc(voice, (p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))
  onProgress?.({ phase: 'sing', label: 'singing', done: 0, total: 1 })
  return rvcConvert(guide, sr, f0, voice)
}
