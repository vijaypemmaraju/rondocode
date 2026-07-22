/* ------------------------------------------------------------------------- *
 * Grapheme→phoneme for the lyrics, via eSpeak-NG compiled to WASM (`phonemizer`,
 * the same eSpeak the wav2vec2-espeak phoneme model was trained against). Gives
 * the KNOWN target phoneme sequence that CTC forced alignment (forcedalign.ts)
 * places onto the sung audio — so a repeated or unstressed word can never be
 * dropped the way an audio-only segmenter drops it.
 * ------------------------------------------------------------------------- */
import { phonemize } from 'phonemizer'

/** Per-WORD eSpeak IPA strings for a line of text (word order preserved). */
export async function phonemizeWords(text: string): Promise<string[]> {
  const parts = await phonemize(text, 'en-us')
  return parts.join(' ').trim().split(/\s+/).filter((w) => w.length > 0)
}
