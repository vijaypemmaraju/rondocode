import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset, n, note } from '../src/index'
import type { ControlMap, Loc } from '../src/index'

/* ------------------------------------------------------------------------- *
 * ANYWHERE MINI-NOTATION IS SUPPORTED, IT LIGHTS UP.
 *
 * Modifier patterns used to be parsed WITHOUT source locations, on the
 * reasoning that "the event's loc belongs to the atom that created it, not to
 * a modifier". That is true about the PRIMARY loc and was the wrong
 * conclusion: a `dur: <1 .5>` line is notation the reader wrote and watches,
 * and it sat dark while the notes beside it flashed.
 *
 * So `loc` stays the note atom's — nothing downstream that wants "the one
 * place this came from" has to change — and `locs` collects every modifier
 * that contributed. The editor flashes all of them.
 * ------------------------------------------------------------------------- */

const first = (p: { query: (s: TimeSpan) => { value: ControlMap }[] }): ControlMap =>
  (p.query(new TimeSpan(F(0), F(1))) as { value: ControlMap }[]).filter(hasOnset as never)[0]!.value

const srcs = (c: ControlMap): string[] => (c.locs ?? []).map((l: Loc) => l.src ?? '?')

describe('every mini-notation modifier contributes a loc', () => {
  it('dur', () => {
    expect(srcs(first(n('0 3').dur('<1 .5>')))).toContain('<1 .5>')
  })

  it('gain', () => {
    expect(srcs(first(n('0 3').gain('.8 .4')))).toContain('.8 .4')
  })

  it('pan', () => {
    expect(srcs(first(n('0 3').pan('0 1')))).toContain('0 1')
  })

  it('sound', () => {
    expect(srcs(first(n('0 3').sound('acid')))).toContain('acid')
  })

  it('an arbitrary param via ctrl', () => {
    // the open namespace: a synth param driven per note is notation too
    expect(srcs(first(n('0 3').ctrl('scrub', '<0 1>')))).toContain('<0 1>')
  })

  it('several at once, each keeping its own source', () => {
    const c = first(n('0 3').sound('x').dur('<1 .5>').ctrl('scrub', '<0 1>'))
    expect(srcs(c).sort()).toEqual(['<0 1>', '<1 .5>', 'x'])
  })
})

describe('the primary loc is still the note atom', () => {
  it('n', () => {
    expect(first(n('0 3').dur('<1 .5>')).loc?.src).toBe('0 3')
  })

  it('note', () => {
    expect(first(note('c4 e4').gain('.5')).loc?.src).toBe('c4 e4')
  })
})

describe('a modifier loc points at the atom that actually applied', () => {
  it('a finer value pattern gives each sub-part its own atom', () => {
    /* `0.25 0.75` against one note produces two parts, and each must point at
     * the half that produced it — otherwise the editor would flash the whole
     * modifier line twice instead of following it. */
    const parts = n('0').gain('0.25 0.75').query(new TimeSpan(F(0), F(1))) as { value: ControlMap }[]
    expect(parts).toHaveLength(2)
    const [a, b] = parts.map((p) => p.value.locs![0]!)
    expect(a!.start).not.toBe(b!.start)
    expect('0.25 0.75'.slice(a!.start, a!.end)).toBe('0.25')
    expect('0.25 0.75'.slice(b!.start, b!.end)).toBe('0.75')
  })
})

describe('what does NOT get a loc', () => {
  it('a bare number has no place in the document to point at', () => {
    expect(first(n('0 3').gain(0.5)).locs).toBeUndefined()
  })

  it('and neither does a Pattern built in code', () => {
    const p = n('0 3').gain(n('0.5').withValue((c) => (c as ControlMap).n as number))
    expect(first(p).locs).toBeUndefined()
  })
})
