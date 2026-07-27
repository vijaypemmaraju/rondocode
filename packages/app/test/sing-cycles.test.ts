import { describe, expect, it } from 'vitest'
import { parseMelodyMini } from '../src/sing/warp'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { TimeSpan, F, hasOnset } from '@rondocode/pattern'

/* Multi-cycle singing: melodies carry mini-notation @weights (so a dotted
 * tune keeps its lilt) and a sing can span N cycles (so a phrase is bars
 * long, not one bar). Timing is asserted numerically - the house rule is
 * measurement, never ear. */

describe('melody @weights', () => {
  it('splits a cycle in proportion to the weights', () => {
    const m = parseMelodyMini('a4@6 g4@2 c5@2', 0.5) // 1 cycle = 2s at cps .5
    expect(m.map((n) => n.midi)).toEqual([69, 67, 72])
    // 6:2:2 of 2 seconds
    expect(m[0]!.dur).toBeCloseTo(1.2, 6)
    expect(m[1]!.dur).toBeCloseTo(0.4, 6)
    expect(m[2]!.dur).toBeCloseTo(0.4, 6)
    expect(m.reduce((t, n) => t + n.dur, 0)).toBeCloseTo(2, 6)
  })

  it('unweighted notes stay even (backward compatible)', () => {
    const m = parseMelodyMini('c4 e4 g4 c5', 0.5)
    for (const n of m) expect(n.dur).toBeCloseTo(0.5, 6)
  })

  it('cycles: N unrolls the melody over N cycles, total = N/cps seconds', () => {
    const m = parseMelodyMini('<[a4@6 g4@2] [c5@4 d5@4]>', 0.5, 2)
    expect(m.map((n) => n.midi)).toEqual([69, 67, 72, 74])
    expect(m.reduce((t, n) => t + n.dur, 0)).toBeCloseTo(2 / 0.5, 6)
    // the first cycle keeps its 6:2 lilt, the second is even
    expect(m[0]!.dur).toBeCloseTo(1.5, 6)
    expect(m[1]!.dur).toBeCloseTo(0.5, 6)
    expect(m[2]!.dur).toBeCloseTo(1, 6)
  })

  it('a long phrase spans its cycles in order (16-cycle case)', () => {
    const bars = Array.from({ length: 16 }, (_, i) => `c${3 + (i % 2)}`).join(' ')
    const m = parseMelodyMini(`<${bars}>`, 0.5, 16)
    expect(m).toHaveLength(16)
    expect(m.reduce((t, n) => t + n.dur, 0)).toBeCloseTo(32, 6)
  })
})

describe('sing({ cycles })', () => {
  const src = (opts: string): string =>
    `p('v', sing('la la', 'c4@3 e4', { name: 'v'${opts} }))`

  it('defaults to 1 cycle: the trigger fires every cycle', () => {
    const r = evalCode(src(''), baseScope)
    expect(r.ok).toBe(true)
    expect(r.sings[0]!.cycles).toBe(1)
    const haps = r.patterns.get('v')!.query(new TimeSpan(F(0), F(4))).filter(hasOnset)
    expect(haps).toHaveLength(4)
  })

  it('cycles: 4 stages the span AND fires the trigger once per 4 cycles', () => {
    const r = evalCode(src(', cycles: 4'), baseScope)
    expect(r.ok).toBe(true)
    expect(r.sings[0]!.cycles).toBe(4)
    const haps = r.patterns.get('v')!.query(new TimeSpan(F(0), F(8))).filter(hasOnset)
    expect(haps).toHaveLength(2) // one per 4 cycles
    expect(haps[0]!.whole!.begin.valueOf()).toBe(0)
    expect(haps[1]!.whole!.begin.valueOf()).toBe(4)
  })

  it('a different cycles count is a DIFFERENT clip (bake keys cannot collide)', () => {
    const a = evalCode(src(''), baseScope)
    const b = evalCode(src(', cycles: 2'), baseScope)
    expect(a.sings[0]!.sampleName).not.toBe(b.sings[0]!.sampleName)
  })

  it('rejects a nonsense cycles value with a diagnostic, not a bad bake', () => {
    for (const bad of [', cycles: 0', ', cycles: 2.5', ", cycles: 'four'", ', cycles: 999']) {
      expect(evalCode(src(bad), baseScope).ok).toBe(false)
    }
  })
})
