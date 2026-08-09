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
  // The count lives in the assertion ONLY. It used to be in the title too
  // ("twenty-eight") and the two had already drifted apart from each other,
  // which is the same one-list-many-copies shape this suite exists to catch.
  it('ships a fixed set of distinctly named examples (local ones may add more)', () => {
    expect(SHIPPED_EXAMPLES).toHaveLength(35)
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

    it("'over a chord' plays exactly what its JS twin plays", () => {
      // The last example to get a twin, and the one where a difference would be
      // easiest to miss: `overchord:` rewrites the NOTES, so a wrong modifier
      // order still sounds musical while playing something else. Compare the
      // event streams rather than trusting that both merely run.
      const ex = EXAMPLES.find((e) => e.name === 'over a chord')!
      const c = compile(ex.rondo!)
      expect(c.ok).toBe(true)
      if (!c.ok) return
      const span = new TimeSpan(F(0), F(4))
      const stream = (src: string): Record<string, string[]> => {
        const r = evalCode(src, baseScope)
        expect(r.ok).toBe(true)
        const out: Record<string, string[]> = {}
        for (const [name, pat] of r.patterns) {
          out[name] = pat.query(span).filter(hasOnset).map(
            (h) => `${h.whole!.begin.valueOf()}|${String(h.value.note)}|${String(h.value.sound)}|${String(h.value.dur)}`,
          )
        }
        return out
      }
      const js = stream(ex.code)
      const rondo = stream(c.code)
      expect(Object.keys(rondo).sort()).toEqual(Object.keys(js).sort())
      for (const k of Object.keys(js)) {
        expect(js[k]!.length, `${k} is not empty`).toBeGreaterThan(0)
        expect(rondo[k], `${k} differs between the languages`).toEqual(js[k])
      }
    })
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

/* An example's comments are the first documentation anyone reads, and they were
 * overclaiming: `macros` billed an eight second, four voice loop as "ONE KNOB,
 * A WHOLE TRACK"; `club` called three voices "a full club track". Everything
 * else audited clean (chord progressions, euclid counts, bpm, slice counts all
 * verified against the code), so the failure was specifically SIZE language —
 * which is the easy thing to inflate and the hard thing to notice. */
describe('example descriptions do not oversell the example', () => {
  /* Allow words BETWEEN the adjective and the noun: club's original claim was
   * "a full CLUB track", which a literal /full track/ never matches — the
   * guard would have missed the very thing that prompted it. */
  const INFLATED = [
    /\b(full|whole|complete|entire)\b[\w\s]{0,14}?\b(track|song|album|band)\b/i,
    /\ba whole lot of\b/i,
  ]
  it('no example calls itself a full/whole track or a full band', () => {
    const bad: string[] = []
    for (const ex of SHIPPED_EXAMPLES) {
      for (const src of [ex.code, ex.rondo ?? '']) {
        const comments = src
          .split('\n')
          .filter((l) => /^\s*(#|\/\/)/.test(l))
          .join(' ')
        for (const re of INFLATED) if (re.test(comments)) bad.push(`${ex.name}: ${re.source}`)
      }
    }
    expect(
      [...new Set(bad)],
      'say what it actually is: how many voices, how many bars, whether it loops',
    ).toEqual([])
  })
})
