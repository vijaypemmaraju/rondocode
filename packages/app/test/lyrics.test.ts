import { describe, it, expect } from 'vitest'
import { parseLyrics } from '../src/sing/lyrics'

describe('lyrics mini-notation', () => {
  it('splits words on spaces and syllables on hyphens', () => {
    const p = parseLyrics('twin-kle twin-kle lit-tle star')
    expect(p.slots.map((s) => s.syllable)).toEqual(['twin', 'kle', 'twin', 'kle', 'lit', 'tle', 'star'])
    expect(p.slots.length).toBe(7) // 7 slots ↔ 7 notes
    expect(p.words.map((w) => w.text)).toEqual(['twinkle', 'twinkle', 'little', 'star'])
    expect(p.text).toBe('twinkle twinkle little star') // TTS input
    // 'twinkle' = one word, two syllables, no melisma
    expect(p.words[0]!.syllableCount).toBe(2)
    expect(p.words[0]!.slots).toEqual([0, 1])
  })

  it('handles melisma (_) as holding the previous syllable over more notes', () => {
    const p = parseLyrics('la _ _ men')
    expect(p.slots.length).toBe(4) // one "la" over 3 notes + "men"
    expect(p.slots[1]!.melisma).toBe(true)
    expect(p.slots[2]!.melisma).toBe(true)
    expect(p.slots[1]!.syllable).toBe('la') // carries the syllable
    // the melisma notes belong to the same word span as 'la'
    expect(p.words[0]!.slots).toEqual([0, 1, 2])
    expect(p.words[0]!.syllableCount).toBe(1)
    expect(p.text).toBe('la men')
  })

  it('handles ~ as a lyric-less (hum) note', () => {
    const p = parseLyrics('~ ooh ~ ooh')
    expect(p.slots[0]!.rest).toBe(true)
    expect(p.slots.length).toBe(4)
    expect(p.text).toBe('ooh ooh')
  })

  it('rejects a leading melisma with nothing to hold', () => {
    expect(() => parseLyrics('_ la')).toThrow()
  })
})
