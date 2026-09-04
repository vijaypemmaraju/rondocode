import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { sectionAt, sectionRanges, slotAt, soundingAt, soundsAt } from '../src/sections'

/* The one rule every live view shares: an event belongs to a widget iff the
 * section that owns the widget's position is sounding at the event's cycle.
 * Two sections with IDENTICAL text is the case that broke every view that
 * matched by text or by synth name, so it is the case pinned here. */

const SONG = [
  'synth lead',
  '  saw',
  '',
  'section build 4',
  '  play lead',
  '    c4 e4 g4',
  '    # a comment at column 0 does not close the section',
  '# neither does this one',
  '',
  '    cutoff: 200..2000',
  '',
  'section main 4 with build',
  '  play lead',
  '    c4 e4 g4',
  '',
  'section drums 2',
  '  beat kick',
  '    x . x .',
  '',
  'song build main drums',
  '',
].join('\n')

const arrangementOf = (src: string) => {
  const r = compile(src)
  if (!r.ok) throw new Error('compile failed: ' + JSON.stringify(r.errors))
  return r.arrangement
}

describe('soundingAt', () => {
  it('names the slot at a global cycle, with what it pulls in `with`, wrapping the song', () => {
    const arr = arrangementOf(SONG)
    expect(arr).toBeDefined()
    expect([...soundingAt(arr, 0)!]).toEqual(['build'])
    expect([...soundingAt(arr, 3.99)!]).toEqual(['build'])
    expect([...soundingAt(arr, 4)!].sort()).toEqual(['build', 'main'])
    expect([...soundingAt(arr, 8)!]).toEqual(['drums'])
    expect([...soundingAt(arr, 9.5)!]).toEqual(['drums'])
    // the song is 10 cycles long and loops
    expect([...soundingAt(arr, 10)!]).toEqual(['build'])
    expect([...soundingAt(arr, 14)!].sort()).toEqual(['build', 'main'])
    expect([...soundingAt(arr, -1)!]).toEqual(['drums'])
    expect([0, 4, 8, 10, 14, -1].map((c) => slotAt(arr, c))).toEqual([0, 1, 2, 0, 1, 2])
  })

  it('has no opinion without a song', () => {
    expect(soundingAt(undefined, 3)).toBeUndefined()
    expect(soundingAt({ slots: [], included: {} }, 3)).toBeUndefined()
    expect(soundingAt(arrangementOf('synth a\n  saw\nplay a\n  c4\n'), 0)).toBeUndefined()
  })
})

describe('sectionRanges', () => {
  it('spans a header through its last indented line, blank and comment lines included', () => {
    const rs = sectionRanges(SONG)
    expect(rs.map((r) => r.name)).toEqual(['build', 'main', 'drums'])
    const [build, main, drums] = rs as [typeof rs[0], typeof rs[0], typeof rs[0]]
    expect(SONG.slice(build.from, build.to)).toBe([
      'section build 4',
      '  play lead',
      '    c4 e4 g4',
      '    # a comment at column 0 does not close the section',
      '# neither does this one',
      '',
      '    cutoff: 200..2000',
    ].join('\n'))
    expect(SONG.slice(main.from, main.to)).toBe('section main 4 with build\n  play lead\n    c4 e4 g4')
    expect(SONG.slice(drums.from, drums.to)).toBe('section drums 2\n  beat kick\n    x . x .')
  })

  it('places a position by section, and outside every one for top-level lines', () => {
    const rs = sectionRanges(SONG)
    const at = (needle: string, nth = 0): number => {
      let i = -1
      for (let k = 0; k <= nth; k++) i = SONG.indexOf(needle, i + 1)
      if (i < 0) throw new Error(`no "${needle}"`)
      return i
    }
    expect(sectionAt(rs, at('saw'))).toBeUndefined()
    expect(sectionAt(rs, at('section build'))).toBe('build')
    expect(sectionAt(rs, at('c4 e4 g4', 0))).toBe('build')
    expect(sectionAt(rs, at('cutoff:'))).toBe('build')
    expect(sectionAt(rs, at('c4 e4 g4', 1))).toBe('main')
    expect(sectionAt(rs, at('x . x .'))).toBe('drums')
    expect(sectionAt(rs, at('song build'))).toBeUndefined()
    expect(sectionAt(rs, SONG.length)).toBeUndefined()
  })

  it('agrees with the parser about the edges: a stray column-0 line ends the block', () => {
    const src = 'section a 4\n  play x\n    c4\nsynth x\n  saw\n  # indented comment\nsection b 2\n  play x\n    e4'
    const rs = sectionRanges(src)
    expect(rs.map((r) => [r.name, src.slice(r.from, r.to)])).toEqual([
      ['a', 'section a 4\n  play x\n    c4'],
      ['b', 'section b 2\n  play x\n    e4'],
    ])
    expect(sectionAt(rs, src.indexOf('saw'))).toBeUndefined()
    // a `#` after a letter is a note name, not a comment: the line is code
    const sharp = 'section a 4\n  play x\n    c#4\n'
    expect(sectionRanges(sharp)[0]!.to).toBe(sharp.indexOf('c#4') + 3)
  })

  it('ignores `section` written anywhere but column 0, like the parser', () => {
    expect(sectionRanges('  section a 4\n    play x\n      c4')).toEqual([])
    expect(sectionRanges('sections 4\n  x')).toEqual([])
    expect(sectionRanges('')).toEqual([])
  })
})

describe('soundsAt', () => {
  it('a line inside a section sounds only while its section does; top level always', () => {
    const arr = arrangementOf(SONG)
    const rs = sectionRanges(SONG)
    const inBuild = SONG.indexOf('cutoff:')
    const inMain = SONG.indexOf('section main')
    const top = SONG.indexOf('saw')
    expect(soundsAt(rs, arr, inBuild, 1)).toBe(true)
    expect(soundsAt(rs, arr, inMain, 1)).toBe(false)
    expect(soundsAt(rs, arr, inBuild, 5)).toBe(true) // main plays with build
    expect(soundsAt(rs, arr, inMain, 5)).toBe(true)
    expect(soundsAt(rs, arr, inBuild, 8)).toBe(false)
    expect(soundsAt(rs, arr, inMain, 8)).toBe(false)
    expect(soundsAt(rs, arr, top, 8)).toBe(true)
  })

  it('without a song every line sounds', () => {
    const rs = sectionRanges(SONG)
    expect(soundsAt(rs, undefined, SONG.indexOf('section main'), 1)).toBe(true)
  })
})
