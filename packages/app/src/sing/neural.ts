/* ------------------------------------------------------------------------- *
 * renderNeural: the full text→singing pipeline as one call, used by both the
 * dev hook and the editor's sing() render manager. Both lyrics and notes are
 * mini-notation; `cps` sets the tempo (note durations resolve through the
 * pattern engine). Returns a mono clip + sample rate.
 *   Supertonic TTS → wav2vec2 phoneme CTC → vowel-aware warp → RVC(voice).
 * ------------------------------------------------------------------------- */
import { loadEngine, disposeEngine } from './supertonic'
import { parseLyrics, type WordSpan } from './lyrics'
import { loadPhonemes, disposePhonemes } from './phonemes'
import { assembleGuide, parseMelodyMini, type Seg } from './warp'
import { alignedSegments, type WordReq } from './segment'
import { psola, estimateF0 } from './psola'
import type { MelodyNote } from './warp'
import { loadRvc, rvcConvert, disposeRvc } from './rvc'
import { sequentialSingSessions } from './config'
import { runStages, type SingStage } from './lifecycle'
import { markPhase } from './bakephase'

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

/** One TTS phrase: the words it covers and the alignment requests for them. */
interface Phrase {
  words: WordSpan[]
  text: string
  reqs: WordReq[]
}

/** Best-of-N takes per phrase: Supertonic is non-deterministic and can render
 *  a syllable weakly, so we try a few takes and keep the strongest. */
const TAKES = 3

/** How many takes to synthesize per phrase. On the sequential (phone) path
 *  this is 1, not 3: alignment can't interleave with the TTS there, so every
 *  take is synthesized UP FRONT and held as raw audio across the stage
 *  boundary - N takes multiply both the peak TTS inference work and the held
 *  audio on exactly the device that is already at the memory kill line.
 *  The honest quality tradeoff: best-of-3 exists because Supertonic
 *  occasionally renders a syllable weakly, and with one take a weak take is
 *  used as-is. Forced alignment still assigns every syllable its region (no
 *  dropped words); a weak syllable just sings quieter. Desktop keeps
 *  best-of-3. Exported for tests. */
export function takeCount(sequential: boolean): number {
  return sequential ? 1 : TAKES
}

/** Split the song into TTS phrases at the sustained (>=1.4x median duration)
 *  notes = line ends, where a singer breathes. This is the sweet spot for
 *  Supertonic:
 *  - a whole verse is too long — the CTC/segmentation loses syllables;
 *  - a single word is too short — Supertonic renders isolated function words
 *    ("I", "a") and even "twinkle" as near-silence;
 *  - and SLOW speed makes it drop the second of a repeated word ("twinkle
 *    twinkle"). A normal-speed phrase keeps every syllable audible and gives
 *    the segmenter enough context. */
function splitPhrases(words: WordSpan[], melody: MelodyNote[]): Phrase[] {
  const sortedDurs = melody.map((n) => n.dur).sort((a, b) => a - b)
  const medDur = sortedDurs[sortedDurs.length >> 1] ?? 0
  const bounds: number[] = []
  for (let i = 0; i < melody.length; i++) {
    if (melody[i]!.dur >= medDur * 1.4 || i === melody.length - 1) bounds.push(i + 1)
  }
  const phrases: Phrase[] = []
  let from = 0
  for (const to of bounds) {
    // words whose syllable slots fall in [from,to) make this phrase
    const phraseWords = words.filter((w) => w.slots[0]! >= from && w.slots[0]! < to)
    from = to
    const text = phraseWords.map((w) => w.text).join(' ')
    if (!text) continue
    phrases.push({ words: phraseWords, text, reqs: phraseWords.map((w) => ({ text: w.text, syllableCount: w.syllableCount })) })
  }
  return phrases
}

/** BEST-OF-N: align takes in order and keep the one whose WEAKEST syllable is
 *  loudest, stopping early once a take clears a comfortable floor. (Forced
 *  alignment already prevents dropped words; this just favours a cleaner
 *  take.) `nextTake` yields successive takes and null when out: synthesized
 *  lazily on desktop (the early stop skips unneeded synthesis), pre-rendered
 *  on constrained devices (the TTS sessions are already disposed by then). */
async function pickBestTake(nextTake: () => Promise<Float32Array | null>, sr: number, reqs: WordReq[]): Promise<Seg[]> {
  let best: Seg[] | null = null
  let bestScore = -1
  for (;;) {
    const spoken = await nextTake()
    if (spoken === null) break
    markPhase('align')
    const ws = await alignedSegments(spoken, sr, reqs)
    let minRms = Infinity
    for (const s of ws) minRms = Math.min(minRms, rms(s.vowel))
    if (minRms > bestScore) { bestScore = minRms; best = ws }
    if (minRms > 0.02) break
  }
  return best ?? []
}

/** One segment per SLOT of a word: its real syllables, then its melisma
 *  continuations. A melisma HOLDS a vowel across notes, so a continuation
 *  must not re-articulate the syllable's consonants: repeating the whole
 *  segment sang "call-ing _" as "call ling ling". The onset consonant is
 *  dropped from every continuation, and the closing coda moves to the LAST
 *  note of the hold so the word closes once, at the end. Pure. */
export function melismaSegs(
  w: { slots: number[]; syllableCount: number },
  syllSegs: readonly Seg[],
  silent: Seg,
): Seg[] {
  const empty = new Float32Array(0)
  const out: Seg[] = []
  const held = w.slots.length > w.syllableCount // this word is sung across extra notes
  for (let s = 0; s < w.slots.length; s++) {
    const base = syllSegs[Math.min(s, w.syllableCount - 1)] ?? silent
    if (s < w.syllableCount) {
      // the syllable that begins a hold keeps its onset but defers its coda
      const startsHold = held && s === w.syllableCount - 1
      out.push(startsHold ? { onset: base.onset, vowel: base.vowel, coda: empty } : base)
      continue
    }
    // a continuation: vowel only, with the coda on the final note
    out.push({ onset: empty, vowel: base.vowel, coda: s === w.slots.length - 1 ? base.coda : empty })
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * SHARED SPEECH CACHE. A harmony arrangement sings the SAME WORDS in every
 * part - a barbershop quartet is four bakes of one lyric. The speech render
 * and the phoneme alignment depend only on the words and how they split into
 * phrases, never on the pitches or the RVC voice, so the second through
 * fourth parts can reuse the first part's segments and skip straight to the
 * warp + voice conversion. That is the whole TTS stage (three takes each on
 * desktop) plus the whole alignment stage, saved per extra part.
 *
 * Keyed by the phrase texts (which encode both the lyrics and the split), so
 * two parts only share when they really do sing the same thing the same way.
 * Small and FIFO: this exists to serve one arrangement's parts baked back to
 * back, not to be a long-lived store. */
const SEG_CACHE_MAX = 4
const segCache = new Map<string, Seg[]>()

const segCacheKey = (phrases: { text: string }[]): string => phrases.map((p) => p.text).join('\u0001')

function cacheSegs(key: string, segs: Seg[]): void {
  segCache.set(key, segs)
  while (segCache.size > SEG_CACHE_MAX) {
    const oldest = segCache.keys().next().value
    if (oldest === undefined) break
    segCache.delete(oldest)
  }
}

/** Drop the shared speech cache (a language/model change invalidates it). */
export function clearSegCache(): void {
  segCache.clear()
}

export async function renderNeural(
  lyrics: string,
  notes: string,
  cps: number,
  voice: string,
  onProgress?: (p: SingProgress) => void,
  cycles = 1,
): Promise<{ audio: Float32Array; sr: number }> {
  const parsed = parseLyrics(lyrics)
  const melody = parseMelodyMini(notes, cps, cycles)
  if (parsed.slots.length !== melody.length) {
    throw new Error(`sing(): ${parsed.slots.length} syllables but ${melody.length} notes`)
  }

  const phrases = splitPhrases(parsed.words, melody)
  const empty = new Float32Array(0)
  const silent: Seg = { onset: empty, vowel: empty, coda: empty }
  const segs: Seg[] = new Array<Seg>(parsed.slots.length).fill(silent)
  const applySegs = (phrase: Phrase, ws: Seg[]): void => {
    let k = 0
    for (const w of phrase.words) {
      const wordSegs = melismaSegs(w, ws.slice(k, k + w.syllableCount), silent)
      for (let s = 0; s < w.slots.length; s++) segs[w.slots[s]!] = wordSegs[s]!
      k += w.syllableCount
    }
  }

  // On constrained devices (sequential=true) the three model stages run one at
  // a time and each stage's sessions are DISPOSED before the next stage loads,
  // so peak session memory is the largest single stage, not the sum — the
  // model BYTES stay in the Cache API, so a later bake re-creates sessions
  // from disk without re-downloading. The price: TTS and alignment can't
  // interleave, so every phrase synthesizes its takeCount(sequential) takes up
  // front (ONE on phones - see takeCount for the tradeoff) and the aligner
  // scores them afterwards. On desktop the singletons persist and
  // TTS+alignment interleave exactly as before.
  const sequential = sequentialSingSessions()
  const nTakes = takeCount(sequential)
  // another part of the same arrangement may already have rendered these words
  const segKey = segCacheKey(phrases)
  const cached = segCache.get(segKey)
  if (cached !== undefined && cached.length === segs.length) {
    for (let i = 0; i < cached.length; i++) segs[i] = cached[i]!
    onProgress?.({ phase: 'align', label: 'reusing this arrangement\'s words', done: 1, total: 1 })
  }
  const haveSegs = cached !== undefined && cached.length === segs.length
  const takesByPhrase: Float32Array[][] = []
  let sr = 0
  let guide!: Float32Array
  let loopN = 0
  let audio!: Float32Array
  let osr = 0

  const stages: SingStage[] = [
    {
      name: 'tts',
      run: async (): Promise<void> => {
        if (haveSegs) return // words already rendered by a sibling part
        markPhase('create:tts')
        const engine = await loadEngine((p) => onProgress?.({ phase: p.phase, label: p.label, done: p.done, total: p.total }))
        sr = engine.sampleRate
        if (sequential) {
          // synth-only pass: every take now, alignment scores them later
          for (let pi = 0; pi < phrases.length; pi++) {
            onProgress?.({ phase: 'synthesize', label: `phrase ${pi + 1}/${phrases.length}`, done: pi, total: phrases.length })
            const takes: Float32Array[] = []
            for (let t = 0; t < nTakes; t++) {
              markPhase('render:tts')
              takes.push(trimSilence(await engine.synthesize(phrases[pi]!.text, { speed: 1.0 })))
            }
            takesByPhrase.push(takes)
          }
          return
        }
        // desktop: aligner alongside the TTS, synth/align interleaved so the
        // best-take early stop skips unneeded synthesis
        await loadPhonemes((p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))
        for (let pi = 0; pi < phrases.length; pi++) {
          const phrase = phrases[pi]!
          onProgress?.({ phase: 'synthesize', label: `phrase ${pi + 1}/${phrases.length}`, done: pi, total: phrases.length })
          let take = 0
          const ws = await pickBestTake(async () => {
            if (take++ >= nTakes) return null
            markPhase('render:tts')
            return trimSilence(await engine.synthesize(phrase.text, { speed: 1.0 }))
          }, sr, phrase.reqs)
          applySegs(phrase, ws)
        }
      },
      dispose: disposeEngine,
    },
    {
      name: 'align',
      run: async (): Promise<void> => {
        if (haveSegs) return // words already aligned by a sibling part
        if (!sequential) return // already aligned interleaved with the TTS
        await loadPhonemes((p) => onProgress?.({ phase: 'download', label: p.label, done: p.done, total: p.total }))
        for (let pi = 0; pi < phrases.length; pi++) {
          onProgress?.({ phase: 'align', label: `phrase ${pi + 1}/${phrases.length}`, done: pi, total: phrases.length })
          const takes = takesByPhrase[pi] ?? []
          let i = 0
          const ws = await pickBestTake(async () => {
            const t = takes[i]
            if (t === undefined) return null
            takes[i++] = empty // drop the reference once consumed
            return t
          }, sr, phrases[pi]!.reqs)
          applySegs(phrases[pi]!, ws)
        }
        takesByPhrase.length = 0
      },
      dispose: disposePhonemes,
    },
    {
      name: 'rvc',
      run: async (): Promise<void> => {
        if (!haveSegs) cacheSegs(segKey, segs.slice())
        markPhase('warp')
        const { guide: g, f0 } = assembleGuide(segs, melody, sr, cycles / cps)
        guide = g
        loopN = guide.length // samples at `sr` = the melody's `cycles` cycles

        // TAIL PAD: RVC's generator rolls its pitch off at the very END of the
        // clip, so the final held note renders ~50 cents flat (proven: the same
        // word mid-song is in tune). Repeat the last chunk of the guide + hold
        // its f0 so the roll-off lands on throwaway padding, then trim it back
        // to the exact loop length.
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
        markPhase('rvc')
        const out = await rvcConvert(gp, sr, fp, voice)
        audio = out.audio
        osr = out.sr
      },
      dispose: disposeRvc,
    },
  ]
  await runStages(stages, sequential)

  // HARD-TUNE off notes to the known melody. RVC leaks a little of the content's
  // own pitch, so some sustained notes (esp. phrase-final ones, low from
  // declination) render up to ~50 cents flat. We KNOW the exact target pitch per
  // note, so TD-PSOLA any note that lands >25 cents off back onto it (formants
  // preserved); in-tune notes are left untouched.
  hardTune(audio, osr, melody)

  // Trim the padding (+ the roll-off it absorbed) back to the loop length, then
  // MEASURE how far RVC shifted the vocal off the beat and cancel exactly that.
  // The `guide` we fed RVC is beat-aligned by construction (vowel-on-beat
  // assembly, tested), so cross-correlating the output's energy envelope
  // against the guide's recovers RVC's group delay per clip — no magic delay.
  // The loop is one cycle, so rotating wraps cleanly (a pickup off one edge
  // reappears at the other). `.late()`/`.early()` are then free for feel.
  const keep = Math.min(audio.length, Math.round((loopN / sr) * osr))
  const loop = audio.subarray(0, keep)
  const rotated = rotateLeft(loop, measureLagSamples(guide, sr, loop, osr))
  markPhase('done')
  return { audio: rotated, sr: osr }
}

/** Energy envelope of `x` sampled at `frameHz` frames/sec (RMS per hop). Sampling
 *  by TIME makes envelopes at different sample rates share one frame grid. */
function energyEnv(x: Float32Array, rate: number, frameHz: number): Float32Array {
  const hop = Math.max(1, Math.round(rate / frameHz))
  const nF = Math.floor(x.length / hop)
  const e = new Float32Array(nF)
  for (let f = 0; f < nF; f++) {
    let s = 0
    const a = f * hop
    for (let k = 0; k < hop; k++) {
      const v = x[a + k]!
      s += v * v
    }
    e[f] = Math.sqrt(s / hop)
  }
  return e
}

/** Zero-mean, unit-norm in place (so a dot product is a correlation, blind to
 *  the two envelopes' differing overall loudness). Returns the same array. */
function normEnv(e: Float32Array): Float32Array {
  const n = e.length || 1
  let mean = 0
  for (let i = 0; i < e.length; i++) mean += e[i]!
  mean /= n
  let norm = 0
  for (let i = 0; i < e.length; i++) {
    e[i]! -= mean
    norm += e[i]! * e[i]!
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < e.length; i++) e[i]! /= norm
  return e
}

/** How far `audio` (at `osr`) lags the beat-aligned `guide` (at `sr`), in
 *  `audio` samples — i.e. how much to rotate `audio` LEFT to seat it on the
 *  beat. Circular cross-correlation of their energy envelopes (both share a
 *  time-based frame grid), bounded to ±maxLagS since RVC's group delay is
 *  small; a flat/silent envelope yields 0 (no shift). Exported for testing. */
export function measureLagSamples(
  guide: Float32Array,
  sr: number,
  audio: Float32Array,
  osr: number,
  maxLagS = 0.2,
): number {
  const frameHz = 500
  const ge = normEnv(energyEnv(guide, sr, frameHz))
  const ae = normEnv(energyEnv(audio, osr, frameHz))
  const n = Math.min(ge.length, ae.length)
  if (n < 4) return 0
  const maxLag = Math.min(n - 1, Math.round(maxLagS * frameHz))
  const corr = (lag: number): number => {
    let s = 0
    for (let i = 0; i < n; i++) s += ge[i]! * ae[(((i + lag) % n) + n) % n]!
    return s
  }
  // Seed at lag 0 and only accept a STRICTLY better lag, so a flat/silent
  // envelope (all correlations equal) stays put instead of drifting to an edge.
  let bestLag = 0
  let best = corr(0)
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (lag === 0) continue
    const s = corr(lag)
    if (s > best) {
      best = s
      bestLag = lag
    }
  }
  return Math.round((bestLag / frameHz) * osr)
}
/** Guide tail repeated before RVC so its end-of-clip pitch roll-off falls on
 *  padding, not the final sung note; trimmed off afterwards. */
const RVC_TAILPAD_S = 0.8

/** Snap notes that RVC rendered off-pitch back onto the known melody, in place.
 *  Each note's output region is measured; if it's >25 cents off, TD-PSOLA retunes
 *  it to the exact target (formant-preserving, tiny jitter to avoid buzz), with a
 *  short crossfade at the edges so untouched neighbours don't click. */
function hardTune(audio: Float32Array, osr: number, notes: MelodyNote[]): void {
  const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)
  const edge = Math.floor(0.006 * osr)
  for (const n of notes) {
    const a = Math.round(n.start * osr)
    const b = Math.min(audio.length, Math.round((n.start + n.dur) * osr))
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
