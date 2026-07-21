/* ------------------------------------------------------------------------- *
 * Lyrics mini-notation for sing(). One SLOT per melody note, in order:
 *   'twin-kle twin-kle lit-tle star'   spaces = words, hyphens = syllables
 *   'la _ _'                           _  = melisma (hold prev syllable a note)
 *   '~ ooh ~ ooh'                      ~  = a note sung with no lyric (hum)
 * Hyphens carry the WORD grouping the aligner needs: 'twinkle' is one Whisper
 * word split into its two syllables, not two separate words. The slot count
 * must equal the melody's note count.
 * ------------------------------------------------------------------------- */

export interface Slot {
  /** The syllable text, or '' for a hum/rest, or the carried syllable on a
   *  melisma continuation. */
  syllable: string
  /** Index of the word this slot belongs to (shared by a word's syllables and
   *  its melisma continuations); -1 for a bare hum/rest. */
  word: number
  /** true when this note continues the previous slot's syllable (melisma). */
  melisma: boolean
  /** true for '~' — a note with no lyric. */
  rest: boolean
}

/** A word = the contiguous slots sharing one `word` index (its syllables +
 *  trailing melisma notes). Used to drive per-word alignment. */
export interface WordSpan {
  text: string
  /** slot indices covered (syllables then any melisma notes), in order. */
  slots: number[]
  /** how many of those slots are real syllables (vs melisma holds). */
  syllableCount: number
}

export interface ParsedLyrics {
  slots: Slot[]
  words: WordSpan[]
  /** The plain text to hand the TTS (words space-joined). */
  text: string
}

/** Parse a lyrics mini-notation string. Throws on a stray leading '_' (nothing
 *  to hold) so mistakes surface early. */
export function parseLyrics(src: string): ParsedLyrics {
  const tokens = src.trim().split(/\s+/).filter((t) => t.length > 0)
  const slots: Slot[] = []
  const words: WordSpan[] = []
  let curWord = -1

  for (const tok of tokens) {
    if (tok === '~') {
      slots.push({ syllable: '', word: -1, melisma: false, rest: true })
      curWord = -1
      continue
    }
    if (tok === '_') {
      const prev = slots[slots.length - 1]
      if (!prev || prev.rest) throw new Error("lyrics: '_' (melisma) has no preceding syllable")
      slots.push({ syllable: prev.syllable, word: prev.word, melisma: true, rest: false })
      if (prev.word >= 0) words[prev.word]!.slots.push(slots.length - 1)
      continue
    }
    // a word: split into syllables on hyphens
    const sylls = tok.split('-').filter((s) => s.length > 0)
    const wi = words.length
    const span: WordSpan = { text: sylls.join(''), slots: [], syllableCount: sylls.length }
    for (const syl of sylls) {
      slots.push({ syllable: syl, word: wi, melisma: false, rest: false })
      span.slots.push(slots.length - 1)
    }
    words.push(span)
    curWord = wi
  }
  void curWord

  return { slots, words, text: words.map((w) => w.text).join(' ') }
}
