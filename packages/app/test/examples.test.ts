import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '@rondocode/rondo'
import { EXAMPLES, SHIPPED_EXAMPLES } from '../src/examples'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* End-to-end smoke tests for the shipped examples: every one must eval
 * clean against the REAL scope + staging (the exact path the Run button
 * takes) and its patterns must produce sounding events — an event needs a
 * numeric note and a sound to reach the engine (Session.dispatchEvents
 * skips anything else), so that is what "would make sound" means here.
 * EXAMPLES may also include gitignored ./local/ examples locally, so the
 * count assertion pins SHIPPED_EXAMPLES; the eval loop covers whatever's loaded. */

describe('examples', () => {
  it('ships twenty-one distinctly named examples (local ones may add more)', () => {
    expect(SHIPPED_EXAMPLES).toHaveLength(21)
    expect(new Set(EXAMPLES.map((e) => e.name)).size).toBe(EXAMPLES.length) // all unique
    for (const s of SHIPPED_EXAMPLES) expect(EXAMPLES).toContainEqual(s)
  })

  // Rondo example twins: whichever examples carry a `rondo` source must
  // transpile and then eval exactly like the JS version does. This guards the
  // "every example gets a rondo version" goal as it fills in.
  const rondoTwins = EXAMPLES.filter((e) => e.rondo !== undefined)
  describe('rondo twins', () => {
    it('has at least one rondo example twin', () => {
      expect(rondoTwins.length).toBeGreaterThanOrEqual(1)
    })
    for (const ex of rondoTwins) {
      it(`'${ex.name}' rondo source transpiles + evals clean + sounds`, () => {
        const c = compile(ex.rondo!)
        expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
        if (!c.ok) return
        const result = evalCode(c.code, baseScope)
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
        expect(result.ok).toBe(true)
        const span = new TimeSpan(F(0), F(2))
        for (const [, pat] of result.patterns) {
          const sounding = pat.query(span).filter(hasOnset).filter(
            (h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string',
          )
          expect(sounding.length).toBeGreaterThanOrEqual(1)
        }
      })
    }
  })

  for (const ex of EXAMPLES) {
    describe(ex.name, () => {
      const result = evalCode(ex.code, baseScope)

      it('evals ok with zero error diagnostics', () => {
        expect(result.ok).toBe(true)
        expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      })

      it('registers at least one synth and one pattern', () => {
        expect(result.synths.size).toBeGreaterThanOrEqual(1)
        expect(result.patterns.size).toBeGreaterThanOrEqual(1)
      })

      it('every pattern produces sounding events over 2 cycles', () => {
        const span = new TimeSpan(F(0), F(2))
        for (const [name, pat] of result.patterns) {
          const sounding = pat
            .query(span)
            .filter(hasOnset)
            .filter(
              (h) =>
                typeof h.value.note === 'number' && typeof h.value.sound === 'string',
            )
          expect(sounding.length, `pattern '${name}'`).toBeGreaterThanOrEqual(1)
          // Routed sounds must be synths the same example defines.
          for (const h of sounding) {
            expect(result.synths.has(h.value.sound as string), `sound '${String(h.value.sound)}'`).toBe(true)
          }
        }
      })
    })
  }
})
