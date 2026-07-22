import { describe, it, expect } from 'vitest'
import { forcedAlign } from '../src/sing/forcedalign'
import { installVocab, ipaToTokens } from '../src/sing/phonemes'

describe('CTC forced alignment', () => {
  it('places each target token in its planted frame range, incl. repeats', () => {
    const V = 8
    const T = 60
    // token, [startFrame, endFrame): note token 7 REPEATS (the "twinkle twinkle" case)
    const plan: [number, number, number][] = [
      [4, 0, 20],
      [7, 20, 35],
      [5, 35, 45],
      [7, 45, 60],
    ]
    const lp = new Float32Array(T * V).fill(Math.log(0.02))
    for (let t = 0; t < T; t++) {
      lp[t * V + 0] = Math.log(0.3) // blank
      for (const [tok, a, b] of plan) if (t >= a && t < b) lp[t * V + tok] = Math.log(0.7)
    }
    const tokens = [4, 7, 5, 7]
    const spans = forcedAlign(lp, T, V, tokens)
    expect(spans.length).toBe(4)
    spans.forEach((s, i) => {
      const [, a, b] = plan[i]!
      const mid = (s.start + s.end) / 2
      expect(mid).toBeGreaterThanOrEqual(a - 3)
      expect(mid).toBeLessThanOrEqual(b + 3)
    })
    // the two "7" tokens get DISTINCT, ordered spans (no collapse)
    expect(spans[1]!.start).toBeLessThan(spans[3]!.start)
  })

  it('never drops a token — every target gets a non-negative span', () => {
    const V = 6
    const T = 12
    const lp = new Float32Array(T * V).fill(Math.log(0.1))
    const tokens = [4, 5, 4, 5, 3] // more tokens than obvious peaks
    const spans = forcedAlign(lp, T, V, tokens)
    expect(spans.length).toBe(tokens.length)
    for (const s of spans) expect(s.end).toBeGreaterThanOrEqual(s.start)
  })
})

describe('eSpeak IPA tokenization', () => {
  it('greedy-matches multi-char symbols and strips stress marks', () => {
    // minimal vocab incl. multi-char diphthong/length symbols
    installVocab({ '<pad>': 0, '<s>': 1, '</s>': 2, '<unk>': 3, t: 4, w: 5, ɪ: 6, ŋ: 7, k: 8, ə: 9, l: 10, ɑː: 11, ɹ: 12, s: 13, aɪ: 14 })
    const toks = ipaToTokens('twˈɪŋkəl stˈɑːɹ') // stress mark + space + length mark
    expect(toks.map((x) => x.sym)).toEqual(['t', 'w', 'ɪ', 'ŋ', 'k', 'ə', 'l', 's', 't', 'ɑː', 'ɹ'])
    // ɑː matched as ONE token (not ɑ + ː), and marked a vowel
    expect(toks.find((x) => x.sym === 'ɑː')!.vowel).toBe(true)
    expect(toks.find((x) => x.sym === 't')!.vowel).toBe(false)
  })
})
