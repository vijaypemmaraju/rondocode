import { describe, expect, it } from 'vitest'
import { parseSingCalls } from '../src/editor/karaoke'

/* Pure parsing for karaoke highlighting: find each sing(voice, lyrics, notes)
 * call, tokenize the lyrics into per-syllable doc ranges and the notes into
 * per-note doc ranges + normalized phase boundaries. Offsets must map back to
 * the exact source text (so the highlight lands on the right characters). */

describe('parseSingCalls', () => {
  const at = (src: string, r: { from: number; to: number }): string => src.slice(r.from, r.to)

  it('maps syllable + note slots to exact source offsets', () => {
    const src = "sing('barbara', 'twin-kle star', 'c4 c4 g4')"
    const [call] = parseSingCalls(src)
    expect(call).toBeDefined()
    expect(call!.lyr.map((r) => at(src, r))).toEqual(['twin', 'kle', 'star'])
    expect(call!.notes.map((r) => at(src, r))).toEqual(['c4', 'c4', 'g4'])
  })

  it('normalizes phase boundaries from note @-weights', () => {
    // 3 notes, the middle one held x2 → weights 1,2,1 (total 4)
    const src = "sing('v', 'a b c', 'c4 d4@2 e4')"
    const [call] = parseSingCalls(src)
    expect(call!.bounds).toEqual([0, 0.25, 0.75, 1])
  })

  it('handles a multi-line no-substitution template literal', () => {
    const src = 'sing(`v`, `twin-kle\n  lit-tle`, `c4 c4\n  g4 g4`)'
    const [call] = parseSingCalls(src)
    expect(call!.lyr.map((r) => at(src, r))).toEqual(['twin', 'kle', 'lit', 'tle'])
    expect(call!.notes.map((r) => at(src, r))).toEqual(['c4', 'c4', 'g4', 'g4'])
  })

  it('keeps ~ and _ sustain tokens as their own slots', () => {
    const src = "sing('v', 'la ~ _ la', 'c4 c4 c4 c4')"
    const [call] = parseSingCalls(src)
    expect(call!.lyr.map((r) => at(src, r))).toEqual(['la', '~', '_', 'la'])
  })

  it('skips a call whose syllable count ≠ note count (cannot align)', () => {
    const src = "sing('v', 'a b c', 'c4 d4')"
    expect(parseSingCalls(src)).toEqual([])
  })

  it('returns [] for unparseable source instead of throwing', () => {
    expect(parseSingCalls('sing(')).toEqual([])
  })

  it('ignores non-string-literal args (dynamic text is not highlightable)', () => {
    const src = "sing('v', lyricsVar, 'c4 c4')"
    expect(parseSingCalls(src)).toEqual([])
  })
})
