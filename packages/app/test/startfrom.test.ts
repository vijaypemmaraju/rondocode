import { compile, sectionRanges } from '@rondocode/rondo'
import { cycleToMeasure, measureToCycle } from '@rondocode/pattern'
import { describe, expect, it } from 'vitest'
import { cursorStartCycle, parseMeasure } from '../src/editor/startfrom'

/* "Take it from bar 9": the pure half of the header's start-measure field and
 * of the cursor shortcut that fills it in. The DOM half is thin wiring over
 * these (same split as the tempo field). */

const SONG = [
  'synth lead',
  '  saw',
  '',
  'section intro 4',
  '  play lead',
  '    c4 e4 g4',
  '',
  'section main 8',
  '  play lead',
  '    c4 e4 g4',
  '',
  'section outro 2',
  '  play lead',
  '    c4',
  '',
  'song intro main outro',
  '',
].join('\n')

const arrangementOf = (src: string) => {
  const r = compile(src)
  if (!r.ok) throw new Error('compile failed: ' + JSON.stringify(r.errors))
  return r.arrangement
}

describe('parseMeasure', () => {
  it('reads a measure, and treats a cleared field as the top', () => {
    expect(parseMeasure('9')).toBe(9)
    expect(parseMeasure('  12  ')).toBe(12)
    expect(parseMeasure('1')).toBe(1)
    expect(parseMeasure(''), 'clearing the field is how you undo it').toBe(1)
    expect(parseMeasure('   ')).toBe(1)
  })

  it('refuses what is not a measure, so the last good value stands', () => {
    // null means "keep what Run will actually do" — never silently start
    // somewhere the person did not ask for.
    expect(parseMeasure('0'), 'no bar zero in music').toBeNull()
    expect(parseMeasure('-3')).toBeNull()
    expect(parseMeasure('9.5'), 'a measure is whole').toBeNull()
    expect(parseMeasure('nine')).toBeNull()
    expect(parseMeasure('1e3'), 'still not digits').toBeNull()
    expect(parseMeasure('100000')).toBeNull()
  })
})

describe('measures and cycles are one subtraction apart, in one place', () => {
  it('measure 1 is the top, and the pair round-trips', () => {
    expect(measureToCycle(1)).toBe(0)
    expect(measureToCycle(9)).toBe(8)
    expect(cycleToMeasure(0)).toBe(1)
    expect(cycleToMeasure(8)).toBe(9)
    for (const m of [1, 2, 9, 64, 9999]) expect(cycleToMeasure(measureToCycle(m))).toBe(m)
    // anywhere inside a bar reads as that bar
    expect(cycleToMeasure(8.75)).toBe(9)
  })
})

describe('cursorStartCycle', () => {
  const ranges = sectionRanges(SONG)
  const arr = arrangementOf(SONG)

  it('answers with the first cycle of the section the cursor is in', () => {
    expect(cursorStartCycle('rondo', ranges, arr, SONG.indexOf('section intro'))).toBe(0)
    expect(cursorStartCycle('rondo', ranges, arr, SONG.indexOf('section main'))).toBe(4)
    // anywhere inside the block, not just its header
    expect(cursorStartCycle('rondo', ranges, arr, SONG.indexOf('c4', SONG.indexOf('section outro')))).toBe(12)
  })

  it('declines when the cursor is not pointing at a section', () => {
    // A top-level line belongs to the whole piece. startCycleAt would answer
    // 0 for it, which is right for "when does this sound" and wrong as an
    // answer to "which section did you point at" — a stray cursor must not
    // silently reset the field to the top.
    expect(cursorStartCycle('rondo', ranges, arr, SONG.indexOf('saw'))).toBeUndefined()
    expect(cursorStartCycle('rondo', ranges, arr, SONG.indexOf('song intro'))).toBeUndefined()
  })

  it('declines for JavaScript, where a section is not a block the editor can see', () => {
    expect(cursorStartCycle('rondocode', ranges, arr, SONG.indexOf('section main'))).toBeUndefined()
  })

  it('declines when there are no sections to start at', () => {
    const plain = 'synth lead\n  saw\n\nplay lead\n  c4 e4\n'
    expect(cursorStartCycle('rondo', sectionRanges(plain), arrangementOf(plain), plain.indexOf('c4'))).toBeUndefined()
  })

  it('still works without a `song` line, because sections then play in the order they are written', () => {
    // rondo's own rule (codegen's sectionOrder), so the bar this jumps to is
    // the bar that sounds.
    const noSong = SONG.replace('song intro main outro\n', '')
    const rs = sectionRanges(noSong)
    const a = arrangementOf(noSong)
    expect(cursorStartCycle('rondo', rs, a, noSong.indexOf('section main'))).toBe(4)
    expect(cursorStartCycle('rondo', rs, a, noSong.indexOf('section outro'))).toBe(12)
  })

  it('the measure a musician reads off it is the section they clicked in', () => {
    // the whole point, stated in the units the field shows
    const at = (needle: string): number =>
      cycleToMeasure(cursorStartCycle('rondo', ranges, arr, SONG.indexOf(needle))!)
    expect(at('section intro')).toBe(1)
    expect(at('section main')).toBe(5)
    expect(at('section outro')).toBe(13)
  })
})
