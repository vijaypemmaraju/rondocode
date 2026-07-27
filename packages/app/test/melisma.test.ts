import { describe, expect, it } from 'vitest'
import { melismaSegs } from '../src/sing/neural'
import { parseLyrics } from '../src/sing/lyrics'
import type { Seg } from '../src/sing/warp'

/* A MELISMA holds one vowel across several notes. Repeating the syllable's
 * whole segment re-articulated its consonants, so "call-ing _" sang as
 * "call ling ling". A continuation must be vowel only, and the word's
 * closing consonant belongs on the LAST note of the hold. */

const seg = (tag: number): Seg => ({
  onset: new Float32Array([tag]),
  vowel: new Float32Array([tag + 0.5]),
  coda: new Float32Array([tag + 0.9]),
})
const silent: Seg = { onset: new Float32Array(0), vowel: new Float32Array(0), coda: new Float32Array(0) }

describe('melismaSegs', () => {
  it('a plain word is untouched (every syllable keeps onset + coda)', () => {
    const { words } = parseLyrics('call-ing')
    const out = melismaSegs(words[0]!, [seg(1), seg(2)], silent)
    expect(out).toHaveLength(2)
    expect(out[0]!.onset).toHaveLength(1)
    expect(out[1]!.onset).toHaveLength(1)
    expect(out[1]!.coda).toHaveLength(1)
  })

  it('"call-ing _" holds the vowel: no second consonant attack', () => {
    const { words } = parseLyrics('call-ing _')
    const out = melismaSegs(words[0]!, [seg(1), seg(2)], silent)
    expect(out).toHaveLength(3)
    // the held syllable keeps its onset...
    expect(out[1]!.onset).toHaveLength(1)
    // ...the continuation has NONE (this was the "ling ling" bug)
    expect(out[2]!.onset).toHaveLength(0)
    expect(out[2]!.vowel).toEqual(out[1]!.vowel)
  })

  it('the closing consonant lands once, on the last note of the hold', () => {
    const { words } = parseLyrics('call-ing _ _')
    const out = melismaSegs(words[0]!, [seg(1), seg(2)], silent)
    expect(out).toHaveLength(4)
    expect(out[1]!.coda).toHaveLength(0) // deferred
    expect(out[2]!.coda).toHaveLength(0) // still holding
    expect(out[3]!.coda).toHaveLength(1) // closes here
  })

  it('an earlier syllable of a held word keeps its own coda', () => {
    const { words } = parseLyrics('mon-day _')
    const out = melismaSegs(words[0]!, [seg(1), seg(2)], silent)
    expect(out[0]!.coda).toHaveLength(1) // "mon" still closes normally
    expect(out[1]!.coda).toHaveLength(0) // "day" defers to the hold
    expect(out[2]!.coda).toHaveLength(1)
  })

  it('a one-syllable word held over notes works the same', () => {
    const { words } = parseLyrics('boy _ _')
    const out = melismaSegs(words[0]!, [seg(1)], silent)
    expect(out.map((o) => o.onset.length)).toEqual([1, 0, 0])
    expect(out.map((o) => o.coda.length)).toEqual([0, 0, 1])
  })
})
