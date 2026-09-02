import { describe, expect, it } from 'vitest'
import { isSingTrigger, parseSingCalls } from '../src/editor/karaoke'

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

  it('normalizes phase spans from note @-weights', () => {
    // 3 notes, the middle one held x2 → weights 1,2,1 (total 4). Spans now
    // come from the real mini parser (see karaoke-mini.test.ts), so they are
    // per-note [start,end) rather than cumulative boundaries.
    const src = "sing('v', 'a b c', 'c4 d4@2 e4')"
    const [call] = parseSingCalls(src)
    expect(call!.spans.map((s) => [s.start, s.end])).toEqual([[0, 0.25], [0.25, 0.75], [0.75, 1]])
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

describe('isSingTrigger', () => {
  const isSing = (s: string) => s === 'vox'
  const ev = (controls: Record<string, unknown>, durSec = 2) => ({ timeSec: 0, durSec, cycle: 0, controls })

  it('the phrase trigger: a note on a sing sound with a duration', () => {
    expect(isSingTrigger(ev({ sound: 'vox', note: 60 }), isSing)).toBe(true)
  })

  it('NOT the automation grid under it (same sound, no note), nor another synth, nor a zero-length event', () => {
    expect(isSingTrigger(ev({ sound: 'vox', mix: 0.3 }), isSing)).toBe(false)
    expect(isSingTrigger(ev({ sound: 'bass', note: 60 }), isSing)).toBe(false)
    expect(isSingTrigger(ev({ sound: 'vox', note: 60 }, 0), isSing)).toBe(false)
  })
})
