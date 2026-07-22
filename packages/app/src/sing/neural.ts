/* ------------------------------------------------------------------------- *
 * renderNeural: the full text→singing pipeline as one call, used by both the
 * dev hook and the editor's sing() render manager. Both lyrics and notes are
 * mini-notation; `cps` sets the tempo (note durations resolve through the
 * pattern engine). Returns a mono clip + sample rate.
 *   Supertonic TTS → wav2vec2 phoneme CTC → vowel-aware warp → RVC(voice).
 * ------------------------------------------------------------------------- */
import { loadEngine } from './supertonic'
import { parseLyrics } from './lyrics'
import { loadPhonemes } from './phonemes'
import { assembleGuide, parseMelodyMini, type Seg } from './warp'
import { alignedSegments } from './segment'
import { psola, estimateF0 } from './psola'
import type { MelodyNote } from './warp'
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
    // words whose syllable slots fall in [from,to) make this phrase
    const phraseWords = parsed.words.filter((w) => w.slots[0]! >= from && w.slots[0]! < to)
    const text = phraseWords.map((w) => w.text).join(' ')
    if (!text) { from = to; continue }
    const reqs = phraseWords.map((w) => ({ text: w.text, syllableCount: w.syllableCount }))
    onProgress?.({ phase: 'synthesize', label: `phrase ${bi + 1}/${bounds.length}`, done: bi, total: bounds.length })
    // BEST-OF-N: Supertonic is non-deterministic and can render a syllable weakly.
    // Synthesize a few takes and keep the one whose WEAKEST syllable is loudest.
    // (Forced alignment already prevents dropped words; this just favours a
    // cleaner take.) Stop early once a take clears a comfortable floor.
    let best: Seg[] | null = null
    let bestScore = -1
    for (let take = 0; take < 3; take++) {
      const spoken = trimSilence(await engine.synthesize(text, { speed: 1.0 }))
      const ws = await alignedSegments(spoken, sr, reqs)
      let minRms = Infinity
      for (const s of ws) minRms = Math.min(minRms, rms(s.vowel))
      if (minRms > bestScore) { bestScore = minRms; best = ws }
      if (minRms > 0.02) break
    }
    const ws = best ?? []
    // map each word's syllable segments onto its slots (melisma slots repeat the
    // last syllable so it holds across those notes; rests stay silent).
    let k = 0
    for (const w of phraseWords) {
      for (let s = 0; s < w.slots.length; s++) {
        segs[w.slots[s]!] = ws[k + Math.min(s, w.syllableCount - 1)] ?? silent
      }
      k += w.syllableCount
    }
    from = to
  }
  const { guide, f0 } = assembleGuide(segs, melody, sr)
  const loopN = guide.length // samples at `sr` = one musical cycle

  // TAIL PAD: RVC's generator rolls its pitch off at the very END of the clip, so
  // the final held note renders ~50 cents flat (proven: the same word mid-song is
  // in tune). Repeat the last chunk of the guide + hold its f0 so the roll-off
  // lands on throwaway padding, then trim it back to the exact loop length.
  const padN = Math.floor(RVC_TAILPAD_S * sr)
  const padF = Math.floor(RVC_TAILPAD_S * 100)
  const gp = new Float32Array(loopN + padN)
  gp.set(guide)
  gp.set(guide.subarray(Math.max(0, loopN - padN)), loopN)
  const fp = new Float32Array(f0.length + padF)
  fp.set(f0)
  fp.fill(f0[f0.length - 1] ?? 0, f0.length)

  await loadRvc(voice, (p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))
  onProgress?.({ phase: 'sing', label: 'singing', done: 0, total: 1 })
  const { audio, sr: osr } = await rvcConvert(gp, sr, fp, voice)

  // HARD-TUNE off notes to the known melody. RVC leaks a little of the content's
  // own pitch, so some sustained notes (esp. phrase-final ones, low from
  // declination) render up to ~50 cents flat. We KNOW the exact target pitch per
  // note, so TD-PSOLA any note that lands >25 cents off back onto it (formants
  // preserved); in-tune notes are left untouched.
  hardTune(audio, osr, melody)

  // Trim the padding (+ the roll-off it absorbed) back to the loop length, then
  // compensate RVC's small output latency by rotating this CLEAN loop LEFT so the
  // first syllable's pickup wraps to the tail ahead of the looped downbeat.
  const keep = Math.min(audio.length, Math.round((loopN / sr) * osr))
  const rotated = rotateLeft(audio.subarray(0, keep), Math.floor(RVC_LATENCY_S * osr))
  return { audio: rotated, sr: osr }
}

/** How much to advance the vocal to cancel RVC's output latency (rotate the
 *  finished loop left). Tuned by ear so the vocal sits with the arrangement. */
const RVC_LATENCY_S = 0.06
/** Guide tail repeated before RVC so its end-of-clip pitch roll-off falls on
 *  padding, not the final sung note; trimmed off afterwards. */
const RVC_TAILPAD_S = 0.8

/** Snap notes that RVC rendered off-pitch back onto the known melody, in place.
 *  Each note's output region is measured; if it's >25 cents off, TD-PSOLA retunes
 *  it to the exact target (formant-preserving, tiny jitter to avoid buzz), with a
 *  short crossfade at the edges so untouched neighbours don't click. */
function hardTune(audio: Float32Array, osr: number, notes: MelodyNote[]): void {
  const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)
  let cum = 0
  const edge = Math.floor(0.006 * osr)
  for (const n of notes) {
    const a = Math.round(cum * osr)
    cum += n.dur
    const b = Math.min(audio.length, Math.round(cum * osr))
    if (b - a < Math.floor(0.06 * osr)) continue
    const region = audio.slice(a, b)
    const target = mtof(n.midi)
    const f0In = estimateF0(region, osr, 90, 700)
    if (f0In <= 0) continue
    const cents = 1200 * Math.log2(f0In / target)
    if (Math.abs(cents) < 25) continue
    const tuned = psola(region, osr, 1, target, f0In, 0.02)
    const L = Math.min(tuned.length, b - a)
    for (let k = 0; k < L; k++) {
      const g = k < edge ? k / edge : k > L - edge ? (L - k) / edge : 1
      audio[a + k] = audio[a + k]! * (1 - g) + tuned[k]! * g
    }
  }
}

/** RMS of a buffer (0 for empty), used to score synthesis takes. */
function rms(a: Float32Array): number {
  if (a.length === 0) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!
  return Math.sqrt(s / a.length)
}

/** Rotate a looped buffer left by k samples (wraps front→back). */
function rotateLeft(a: Float32Array, k: number): Float32Array {
  const n = a.length
  if (n === 0) return a
  const s = ((k % n) + n) % n
  if (s === 0) return a
  const out = new Float32Array(n)
  out.set(a.subarray(s), 0)
  out.set(a.subarray(0, s), n - s)
  return out
}
