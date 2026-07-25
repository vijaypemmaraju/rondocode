import { describe, expect, it, vi } from 'vitest'

/* segmentWithEmissions is the pure core of the forced-alignment syllable
 * segmenter: lyrics → (mocked) G2P → tokens → CTC forced-align against a
 * FABRICATED emission matrix (the forcedalign.test.ts pattern) → syllable
 * regions cut from the spoken buffer. G2P normally runs eSpeak WASM, so it is
 * mocked with canned per-word IPA; the vocab comes from installVocab (the
 * hook phonemes.ts exports exactly for tests). Everything downstream —
 * grouping vowels per word, merge/split reconciliation to the note count,
 * consonant-midpoint cuts — runs for real. */

vi.mock('../src/sing/g2p', () => ({
  phonemizeWords: async (text: string) => {
    const IPA: Record<string, string> = {
      tikul: 'tɪkəl', // 2 vowels: ɪ, ə
      naia: 'nɪə', // 2 vowels: ɪ, ə (diphthong-ish pair for the merge path)
      ta: 'tɑ', // 1 vowel
    }
    const ipa = IPA[text]
    if (ipa === undefined) throw new Error(`no canned IPA for '${text}'`)
    return [ipa]
  },
}))

import { segmentWithEmissions } from '../src/sing/segment'
import { installVocab } from '../src/sing/phonemes'

installVocab({ '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, t: 4, k: 5, l: 6, n: 7, ɪ: 8, ə: 9, ɑ: 10 })
const V = 11

const SR = 16000
const FPS = 100 // 1 frame = 10 ms, so frames/FPS = seconds

/** One second of audio + a T×V log-prob matrix with each token id planted in
 *  its frame range (blank=0 favoured elsewhere), like forcedalign.test.ts. */
function fabricate(plan: [id: number, startFrame: number, endFrame: number][]) {
  const T = 100
  const logits = new Float32Array(T * V).fill(Math.log(0.01))
  for (let t = 0; t < T; t++) {
    logits[t * V + 0] = Math.log(0.3) // blank
    for (const [tok, a, b] of plan) if (t >= a && t < b) logits[t * V + tok] = Math.log(0.9)
  }
  const spoken = new Float32Array(SR) // exactly 1 s ⇒ sample offset = sec × SR
  return { spoken, em: { logits, T, V, fps: FPS } }
}

/** ±5 frames of alignment slack, in samples. */
const TOL = 5 * (SR / FPS)
const close = (actual: number, expectedSec: number, label: string) => {
  expect(Math.abs(actual - expectedSec * SR), `${label}: got ${actual}, want ~${expectedSec * SR}`).toBeLessThanOrEqual(TOL)
}

describe('segmentWithEmissions (synthetic emissions)', () => {
  it('cuts one Seg per syllable with the vowel where it was planted', async () => {
    // tɪkəl planted: t 0-10, ɪ 10-30, k 30-40, ə 40-60, l 60-80
    const { spoken, em } = fabricate([[4, 0, 10], [8, 10, 30], [5, 30, 40], [9, 40, 60], [6, 60, 80]])
    const segs = await segmentWithEmissions(spoken, SR, [{ text: 'tikul', syllableCount: 2 }], em)
    expect(segs).toHaveLength(2)
    // the segs tile the buffer exactly: onset|vowel|coda per syllable, no gaps
    const total = segs.reduce((n, s) => n + s.onset.length + s.vowel.length + s.coda.length, 0)
    expect(total).toBe(spoken.length)
    // syllable 1 starts at 0; its vowel is the planted ɪ span [0.10, 0.30]
    close(segs[0]!.onset.length, 0.1, 'onset 1 ends at vowel start')
    close(segs[0]!.vowel.length, 0.2, 'vowel 1 is the ɪ span')
    // the cut between syllables is the consonant midpoint (0.30+0.40)/2 = 0.35
    close(segs[0]!.onset.length + segs[0]!.vowel.length + segs[0]!.coda.length, 0.35, 'syllable cut at consonant midpoint')
    // syllable 2's vowel is the planted ə span [0.40, 0.60]
    close(segs[1]!.vowel.length, 0.2, 'vowel 2 is the ə span')
  })

  it('MERGES surplus vowel groups when a word has more vowels than notes', async () => {
    // nɪə with syllableCount 1: two vowel spans must merge into one nucleus
    const { spoken, em } = fabricate([[7, 0, 10], [8, 10, 40], [9, 40, 80]])
    const segs = await segmentWithEmissions(spoken, SR, [{ text: 'naia', syllableCount: 1 }], em)
    expect(segs).toHaveLength(1)
    // merged nucleus spans ɪ start → ə end: [0.10, 0.80]
    close(segs[0]!.onset.length, 0.1, 'onset ends at first vowel start')
    close(segs[0]!.vowel.length, 0.7, 'merged vowel spans both nuclei')
    expect(segs[0]!.onset.length + segs[0]!.vowel.length + segs[0]!.coda.length).toBe(spoken.length)
  })

  it('SPLITS a lone vowel when a word must fill more notes than it has vowels', async () => {
    // tɑ with syllableCount 2: the single ɑ nucleus [0.20, 0.80] splits at its middle
    const { spoken, em } = fabricate([[4, 0, 20], [10, 20, 80]])
    const segs = await segmentWithEmissions(spoken, SR, [{ text: 'ta', syllableCount: 2 }], em)
    expect(segs).toHaveLength(2)
    // both halves carry a vowel of ~equal width (0.3 s each)
    close(segs[0]!.vowel.length, 0.3, 'first half-vowel')
    close(segs[1]!.vowel.length, 0.3, 'second half-vowel')
    const total = segs.reduce((n, s) => n + s.onset.length + s.vowel.length + s.coda.length, 0)
    expect(total).toBe(spoken.length)
  })

  it('keeps syllables in word order across multiple words', async () => {
    // 'ta' then 'tikul': ta's ɑ at [0.05,0.20]; tikul's ɪ [0.35,0.50], ə [0.60,0.75]
    const { spoken, em } = fabricate([
      [4, 0, 5], [10, 5, 20], // t ɑ
      [4, 25, 35], [8, 35, 50], [5, 50, 60], [9, 60, 75], [6, 75, 85], // t ɪ k ə l
    ])
    const segs = await segmentWithEmissions(
      spoken,
      SR,
      [
        { text: 'ta', syllableCount: 1 },
        { text: 'tikul', syllableCount: 2 },
      ],
      em,
    )
    expect(segs).toHaveLength(3)
    // reconstruct each vowel's absolute start from the tiling and check order
    let cursor = 0
    const vowelStarts: number[] = []
    for (const s of segs) {
      vowelStarts.push(cursor + s.onset.length)
      cursor += s.onset.length + s.vowel.length + s.coda.length
    }
    expect(cursor).toBe(spoken.length)
    close(vowelStarts[0]!, 0.05, 'ɑ start')
    close(vowelStarts[1]!, 0.35, 'ɪ start')
    close(vowelStarts[2]!, 0.6, 'ə start')
  })
})
