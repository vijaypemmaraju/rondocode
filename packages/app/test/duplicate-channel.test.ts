import { describe, expect, it } from 'vitest'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * TWO BLOCKS, ONE CHANNEL — the silent replacement.
 *
 * `p(name, …)` registers by NAME, so a second call with the same name replaces
 * the first. Silently, which is the worst possible behaviour: the earlier
 * block is still on screen, still highlighted, still flashing its notes in the
 * roll, and completely inaudible.
 *
 * It cost a shipped example. The "note bends" example had two `play lead`
 * blocks and the first one never played; nothing said a word, and the tests
 * missed it because they queried ALL patterns and found the survivor.
 * ------------------------------------------------------------------------- */

const SYNTH = "const lead = synth(({ saw }) => saw(220))\n"

describe('a second block on the same channel warns', () => {
  it('warns, and names the channel', () => {
    const r = evalCode(`${SYNTH}p('lead', n('0 3').sound('lead'))\np('lead', n('5 7').sound('lead'))\nsetCps(0.5)`, baseScope)
    const warns = r.diagnostics.filter((d) => d.severity === 'warning')
    expect(warns.length, 'no warning for a replaced block').toBe(1)
    expect(warns[0]!.message).toContain("'lead'")
  })

  it('is a WARNING, not an error — the program still runs', () => {
    // last-wins is legitimate when a later eval deliberately redefines a
    // channel; refusing to run would break that
    const r = evalCode(`${SYNTH}p('lead', n('0').sound('lead'))\np('lead', n('5').sound('lead'))\nsetCps(0.5)`, baseScope)
    expect(r.ok).toBe(true)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(r.patterns.size).toBe(1)
  })

  it('says nothing when the channels differ', () => {
    const r = evalCode(`${SYNTH}p('a', n('0').sound('lead'))\np('b', n('5').sound('lead'))\nsetCps(0.5)`, baseScope)
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toEqual([])
    expect(r.patterns.size).toBe(2)
  })

  it('says nothing for LAYERS — two notation lines in one block', () => {
    // the fix it should point people at: one p() call, a stacked pattern
    const r = evalCode(`${SYNTH}p('lead', stack(n('0 3'), n('5 7')).sound('lead'))\nsetCps(0.5)`, baseScope)
    expect(r.diagnostics.filter((d) => d.severity === 'warning')).toEqual([])
  })
})

describe('no shipped example silently drops a block', () => {
  it('registers each pattern name at most once, in every example', () => {
    const bad: string[] = []
    for (const ex of EXAMPLES) {
      const names = [...ex.code.matchAll(/\bp\(\s*'([^']+)'/g)].map((m) => m[1]!)
      const seen = new Set<string>()
      for (const nm of names) {
        if (seen.has(nm)) bad.push(`${ex.name}: p('${nm}') twice`)
        seen.add(nm)
      }
    }
    expect(bad, 'an example has a block that never sounds').toEqual([])
  })

  it('and none of them EVALS with a replacement warning', () => {
    // the static check above reads the source; this one asks the evaluator,
    // which is what actually decides
    const bad: string[] = []
    for (const ex of EXAMPLES) {
      const r = evalCode(ex.code, baseScope)
      for (const d of r.diagnostics) {
        if (d.severity === 'warning' && d.message.includes('REPLACES the first')) bad.push(ex.name)
      }
    }
    expect(bad).toEqual([])
  })
})
