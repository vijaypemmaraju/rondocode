import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_INK, paintOnAttach, pickInk } from '../src/editor/rondo/paint'

/* ------------------------------------------------------------------------- *
 * "svf curve editor is black on gray background."
 *
 * Not a colour choice — a timing bug. A canvas cannot use `currentColor`, so
 * these widgets read their ink with getComputedStyle. That returns INITIAL
 * values for a detached node, and `color`'s initial value is black. CodeMirror
 * builds a widget in toDOM() before inserting it, so a widget that paints
 * there paints black and keeps it: nothing redraws a curve nobody touches.
 * ------------------------------------------------------------------------- */
describe('pickInk', () => {
  it('ignores a detached element entirely — that reading is not an answer', () => {
    // the shipped code trusted `rgb(0, 0, 0)` here, which is where black came from
    expect(pickInk(false, 'rgb(0, 0, 0)', '#ff8800')).toBe('#ff8800')
  })

  it('trusts the cascade once connected, so .active can recolour the curve', () => {
    expect(pickInk(true, 'rgb(10, 20, 30)', '#ff8800')).toBe('rgb(10, 20, 30)')
  })

  it('allows a connected element to be genuinely black', () => {
    // the fix must not be "never paint black" — a theme may mean it
    expect(pickInk(true, 'rgb(0, 0, 0)', '#ff8800')).toBe('rgb(0, 0, 0)')
  })

  it('falls back to the CSS fallback when the palette has not been applied', () => {
    expect(pickInk(false, '', '')).toBe(FALLBACK_INK)
    expect(pickInk(false, '', '   ')).toBe(FALLBACK_INK)
  })

  it('tolerates a connected element with no computed colour at all', () => {
    expect(pickInk(true, '', '#ff8800')).toBe('#ff8800')
  })

  it('trims the palette value, which comes back with whitespace from CSS', () => {
    expect(pickInk(false, '', ' #abcdef ')).toBe('#abcdef')
  })
})

describe('paintOnAttach', () => {
  it('paints immediately, so a scroll rebuild shows no blank frame', () => {
    const draw = vi.fn()
    paintOnAttach(draw, () => undefined)
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('paints again on the next frame, which is when the cascade exists', () => {
    const draw = vi.fn()
    const frames: (() => void)[] = []
    paintOnAttach(draw, (cb) => frames.push(cb))
    expect(draw).toHaveBeenCalledTimes(1)
    frames.forEach((f) => { f() })
    expect(draw).toHaveBeenCalledTimes(2)
  })

  it('still paints once where rAF does not exist', () => {
    const draw = vi.fn()
    expect(() => paintOnAttach(draw, undefined)).not.toThrow()
    expect(draw).toHaveBeenCalledTimes(1)
  })
})
