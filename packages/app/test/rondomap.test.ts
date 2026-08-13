import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { mapToRondo } from '../src/editor/rondomap'
import type { Diagnostic } from '../src/session/evalCode'

/* ------------------------------------------------------------------------- *
 * In rondo the thing that RUNS is transpiled JavaScript, so every diagnostic
 * the eval produces carried a position in a file the musician never sees. All
 * of them were dropped from the buffer and printed as a line of text under the
 * editor: unknown `.ctrl` param, a note longer than its step, a chord on a mono
 * synth, a bad staging target, any runtime throw.
 *
 * Measured in a browser before this: `nosuchparam: .5` on a play line produced
 * zero squiggles and one strip line. After: one squiggle, on `play lead`.
 * ------------------------------------------------------------------------- */

const diag = (line: number, col = 1): Diagnostic =>
  ({ line, col, message: 'x', severity: 'error', source: 'eval' })

describe('the compiler says which rondo line each JS line came from', () => {
  const src = [
    'synth lead',        // 1
    '  saw note',        // 2
    '  * adsr .01 .2 .6 .3', // 3
    '',                  // 4
    'synth pad',         // 5
    '  sine note',       // 6
    '',                  // 7
    'play lead',         // 8
    '  0 3 5 7',         // 9
    '',                  // 10
  ].join('\n')
  const r = compile(src)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))

  it('maps every generated line to the BLOCK that produced it', () => {
    const js = r.code.split('\n')
    // each emitted line either belongs to a block, or is the blank between them
    for (let i = 0; i < js.length; i++) {
      const from = r.lineMap[i] ?? 0
      if (js[i] === '') continue
      expect(from, `js line ${i + 1}: ${js[i]}`).toBeGreaterThan(0)
      expect(src.split('\n')[from - 1], `js line ${i + 1}`).toMatch(/^(synth|play)/)
    }
  })

  it('sends each block to its OWN header, not to the first one', () => {
    const js = r.code.split('\n')
    const lineOf = (needle: string): number =>
      r.lineMap[js.findIndex((l) => l.includes(needle))] ?? 0
    expect(lineOf('const lead')).toBe(1)
    expect(lineOf('const pad')).toBe(5)
    expect(lineOf("p('lead'")).toBe(8)
  })

  it('the blank between statements stands for nothing', () => {
    const js = r.code.split('\n')
    for (let i = 0; i < js.length; i++) if (js[i] === '') expect(r.lineMap[i] ?? 0).toBe(0)
  })

  it('a HOISTED definition still points where it was written', () => {
    /* scaledefs, wavedefs and macros are emitted first whatever order they were
     * written in, because the things that use them resolve eagerly. The map is
     * built alongside the reordering, so it follows the text rather than the
     * source order -- which is the one thing a naive "nth statement" map gets
     * wrong. */
    const doc = 'synth a\n  saw note\n\nscaledef weird cents 0 133 400\n'
    const c = compile(doc)
    expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
    if (!c.ok) return
    const js = c.code.split('\n')
    const i = js.findIndex((l) => l.includes('weird'))
    expect(i, 'the scaledef hoists to the top').toBe(0)
    expect(c.lineMap[i], 'but it was written on line 4').toBe(4)
  })

  it('is empty when the compile failed, so nothing can be placed', () => {
    const bad = compile('synth\n')
    expect(bad.ok).toBe(false)
    expect(bad.lineMap).toEqual([])
  })
})

describe('mapToRondo', () => {
  it('moves a diagnostic onto the rondo line', () => {
    expect(mapToRondo(diag(3), [7, 7, 7])?.line).toBe(7)
  })

  it('DROPS the column and covers the whole line', () => {
    /* A column into generated JavaScript means nothing in a rondo line of a
     * different length: `p('lead', n('0 3 5 7')…)` col 22 is somewhere in the
     * middle of `  0 3 5 7`, pointing at a space. */
    const m = mapToRondo(diag(1, 22), [4])
    expect(m?.col).toBe(1)
    expect(m?.endLine).toBe(4)
    expect(m?.endCol).toBeGreaterThan(1000)
  })

  it('keeps the message and severity', () => {
    const m = mapToRondo({ line: 1, col: 1, message: 'unknown param', severity: 'warning', source: 'eval' }, [2])
    expect(m?.message).toBe('unknown param')
    expect(m?.severity).toBe('warning')
  })

  it('returns NULL rather than guessing, for anything it cannot place', () => {
    expect(mapToRondo(diag(1), []), 'no map at all (JS mode, or a failed compile)').toBeNull()
    expect(mapToRondo(diag(9), [1, 1]), 'past the end of the generated code').toBeNull()
    expect(mapToRondo(diag(2), [1, 0, 1]), 'the blank between statements').toBeNull()
    expect(mapToRondo(diag(0), [1]), 'a position-less diagnostic').toBeNull()
  })

  it('end to end: an unknown ctrl param lands on its play block', () => {
    const src = 'synth lead\n  saw note\n\nplay lead\n  0 3\n  nosuchparam: .5\n'
    const r = compile(src)
    expect(r.ok, JSON.stringify(r.ok ? [] : r.errors)).toBe(true)
    if (!r.ok) return
    // the eval reports it against the generated p('lead', …) line
    const js = r.code.split('\n')
    const at = js.findIndex((l) => l.includes('nosuchparam'))
    expect(at, 'the ctrl call should be in the output').toBeGreaterThanOrEqual(0)
    const m = mapToRondo(diag(at + 1, 30), r.lineMap)
    expect(src.split('\n')[(m?.line ?? 0) - 1]).toBe('play lead')
  })
})
