import { describe, expect, it } from 'vitest'
import { findMacroNumber, formatMacroNumber } from '../src/editor/macrotext'

const RONDO = [
  '# energy: not a declaration, only a comment about macro energy 9',
  'macro energy .35 0..1',
  'macro energy2 0.8 0..1',
  'macro depth -2 -6..6',
  'synth pad',
  '  saw',
].join('\n')

const JS = [
  "macro('energy2', 0.8, { min: 0, max: 1 })",
  'macro("energy", 0.35, { min: 0, max: 1 })',
].join('\n')

describe('findMacroNumber', () => {
  it('finds the written default in rondo, and the offsets cover exactly the number', () => {
    const at = findMacroNumber(RONDO, 'energy', 'rondo')!
    expect(at.value).toBe(0.35)
    expect(RONDO.slice(at.from, at.to)).toBe('.35')
  })

  it('matches the whole name: energy and energy2 are different macros', () => {
    expect(findMacroNumber(RONDO, 'energy', 'rondo')!.value).toBe(0.35)
    expect(findMacroNumber(RONDO, 'energy2', 'rondo')!.value).toBe(0.8)
  })

  it('ignores a rondo macro that is only mentioned in a comment', () => {
    // the comment line also contains "macro energy 9"; the declaration must win
    expect(findMacroNumber(RONDO, 'energy', 'rondo')!.value).not.toBe(9)
  })

  it('reads a negative default and stops before the range that follows it', () => {
    const at = findMacroNumber(RONDO, 'depth', 'rondo')!
    expect(at.value).toBe(-2)
    expect(RONDO.slice(at.from, at.to)).toBe('-2')
  })

  it('finds the default in a JavaScript macro() call, with either quote', () => {
    const at = findMacroNumber(JS, 'energy', 'rondocode')!
    expect(JS.slice(at.from, at.to)).toBe('0.35')
    expect(findMacroNumber(JS, 'energy2', 'rondocode')!.value).toBe(0.8)
  })

  it('answers undefined for a macro the text does not declare, in either language', () => {
    expect(findMacroNumber(RONDO, 'nope', 'rondo')).toBeUndefined()
    expect(findMacroNumber(JS, 'nope', 'rondocode')).toBeUndefined()
    // a rondo declaration is not a JavaScript one
    expect(findMacroNumber(RONDO, 'energy', 'rondocode')).toBeUndefined()
  })
})

describe('formatMacroNumber', () => {
  it('keeps three decimals at most and drops trailing zeros', () => {
    expect(formatMacroNumber(0.123456)).toBe('0.123')
    expect(formatMacroNumber(0.5)).toBe('0.5')
    expect(formatMacroNumber(1)).toBe('1')
    expect(formatMacroNumber(0.9996)).toBe('1')
  })
})
