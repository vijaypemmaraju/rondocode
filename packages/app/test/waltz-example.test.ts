import { describe, expect, it } from 'vitest'
import { SHIPPED_EXAMPLES } from '../src/examples'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { runPatterns, stageCode } from '../../server/src/render-runner'

/* The waltz is the shipped example that DEMONSTRATES the meter, so the thing
 * worth pinning is not that it evals (examples.test.ts covers that for every
 * example) but that it is genuinely in three: a bar of three quarter notes,
 * with the oom on beat one and the pah-pah on two and three. If someone
 * "tidies" the timesig line away, the notes still play — they just stop being
 * a waltz, and only this test would notice. */

const ex = SHIPPED_EXAMPLES.find((e) => e.name === 'waltz')!

describe('the waltz example', () => {
  it('exists in both languages, with the meter written in the rondo source', () => {
    expect(ex, 'no example named waltz').toBeDefined()
    expect(ex.rondo).toContain('timesig 3 4')
    expect(ex.code).toContain('setTimeSig(3, 4)')
  })

  it('is in 3/4, so a bar is three quarters and 150 bpm is 0.8333 cps', () => {
    const r = evalCode(ex.code, baseScope)
    expect(r.ok, r.diagnostics.map((d) => d.message).join('; ')).toBe(true)
    expect(r.timeSig).toEqual({ num: 3, den: 4 })
    // 150 / 60 / 3 quarters — in 4/4 the same bpm line would be 0.625
    expect(r.cps).toBeCloseTo(150 / 60 / 3, 6)
  })

  it('puts the bass on beat one and the chords on two and three', () => {
    const staged = stageCode(ex.code)
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const cps = staged.cps!
    const events = runPatterns(staged.patterns, { cycles: 4, cps })
    /** Which of the three beats an onset lands on, 0-based, deduped. */
    const beats = (synth: string): number[] => {
      const evs = events.get(synth) ?? []
      const at = evs
        .filter((e) => e.type === 'noteOn')
        .map((e) => Math.round(((e.time * cps) % 1) * 3 * 100) / 100)
      return [...new Set(at)].sort((a, b) => a - b)
    }
    // the oom: beat one only
    expect(beats('bass')).toEqual([0])
    // the pah-pah: beats two and three, and never on one
    expect(beats('comp')).toEqual([1, 2])
  })

  it('fills the bar rather than leaving a limp: the lead plays across all three beats', () => {
    const staged = stageCode(ex.code)
    if (!staged.ok) return
    const cps = staged.cps!
    const events = runPatterns(staged.patterns, { cycles: 4, cps })
    const lead = (events.get('lead') ?? []).filter((e) => e.type === 'noteOn')
    const onBeat = new Set(lead.map((e) => Math.floor(((e.time * cps) % 1) * 3)))
    expect([...onBeat].sort()).toEqual([0, 1, 2])
  })
})
