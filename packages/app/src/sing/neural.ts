/* ------------------------------------------------------------------------- *
 * renderNeural: the full text→singing pipeline as one call, used by both the
 * dev hook and the editor's sing() render manager. Both lyrics and notes are
 * mini-notation; `cps` sets the tempo (note durations resolve through the
 * pattern engine). Returns a mono clip + sample rate.
 *   Supertonic TTS → wav2vec2 phoneme CTC → vowel-aware warp → RVC(voice).
 * ------------------------------------------------------------------------- */
import { loadEngine } from './supertonic'
import { parseLyrics } from './lyrics'
import { loadPhonemes, vowelActivity } from './phonemes'
import { syllableSegments, assembleGuide, parseMelodyMini, type Seg } from './warp'
import { loadRvc, rvcConvert } from './rvc'

/** Coarse progress for the render dialog. `phase` names the stage; when a model
 *  is downloading, done/total are bytes. */
export interface SingProgress {
  phase: string
  label: string
  done: number
  total: number
}

/** Trim leading/trailing near-silence (TTS pre/post-roll). Left in, the leading
 *  silence rides the first syllable's onset and pushes its vowel — hence the
 *  whole chunk — late off the beat. */
function trimSilence(x: Float32Array): Float32Array {
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!))
  if (peak < 1e-6) return x
  const thr = peak * 0.02
  let a = 0
  while (a < x.length && Math.abs(x[a]!) < thr) a++
  let b = x.length
  while (b > a && Math.abs(x[b - 1]!) < thr) b--
  // keep a touch of pre-onset so a hard consonant isn't clipped at the very edge
  a = Math.max(0, a - 32)
  return x.subarray(a, b)
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

  // Synthesize per PHRASE (split at the sustained @2 notes = line ends, where a
  // singer breathes), at NORMAL speed. This is the sweet spot for Supertonic:
  //  - a whole verse is too long — the CTC/segmentation loses syllables;
  //  - a single word is too short — Supertonic renders isolated function words
  //    ("I", "a") and even "twinkle" as near-silence;
  //  - and SLOW speed makes it drop the second of a repeated word ("twinkle
  //    twinkle"). A normal-speed phrase keeps every syllable audible and gives the
  //    segmenter enough context. We segment each phrase into its syllables, then
  //    assemble the whole song vowel-on-beat in one pass so nothing drifts.
  const sortedDurs = melody.map((n) => n.dur).sort((a, b) => a - b)
  const medDur = sortedDurs[sortedDurs.length >> 1] ?? 0
  const bounds: number[] = []
  for (let i = 0; i < melody.length; i++) {
    if (melody[i]!.dur >= medDur * 1.4 || i === melody.length - 1) bounds.push(i + 1)
  }
  const empty = new Float32Array(0)
  const silent: Seg = { onset: empty, vowel: empty, coda: empty }
  const segs: Seg[] = new Array<Seg>(parsed.slots.length).fill(silent)
  let from = 0
  for (let bi = 0; bi < bounds.length; bi++) {
    const to = bounds[bi]!
    // words whose syllable slots fall in [from,to) make this phrase's text
    const text = parsed.words.filter((w) => w.slots[0]! >= from && w.slots[0]! < to).map((w) => w.text).join(' ')
    if (!text) { from = to; continue }
    onProgress?.({ phase: 'synthesize', label: `phrase ${bi + 1}/${bounds.length}`, done: bi, total: bounds.length })
    const spoken = trimSilence(await engine.synthesize(text, { speed: 1.0 }))
    const { prob, fps } = await vowelActivity(spoken, sr)
    const ws = syllableSegments(spoken, sr, prob, fps, to - from)
    for (let k = 0; k < to - from; k++) segs[from + k] = ws[k] ?? silent
    from = to
  }
  const { guide, f0 } = assembleGuide(segs, melody, sr)

  await loadRvc(voice, (p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))
  onProgress?.({ phase: 'sing', label: 'singing', done: 0, total: 1 })
  return rvcConvert(guide, sr, f0, voice)
}
