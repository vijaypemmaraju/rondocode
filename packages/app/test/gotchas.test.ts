import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns, renderMix } from '../../server/src/render-runner'
import { GOTCHAS } from '../src/docs/gotchas'
import type { Gotcha } from '../src/docs/gotchas'
import { SECTIONS, orderedSections } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * A troubleshooting page has to be kept honest from BOTH ends.
 *
 * The fix must work — that much is the same bar the cookbook holds. The
 * interesting half is the other one: the broken version must still be broken,
 * in the specific way the entry claims. If the language later closes one of
 * these traps, this suite fails and says to delete the entry.
 *
 * That matters because a troubleshooting page which has outlived its problems
 * is worse than not having one: it teaches workarounds for bugs that are gone,
 * and the reader has no way to know which advice is stale.
 * ------------------------------------------------------------------------- */

interface Run {
  compiled: boolean
  staged: boolean
  events: number
  peak: number
  /** the whole event stream. Notes alone are not enough: two bars STACKED and
   *  the same two bars in SEQUENCE contain identical pitches and differ only
   *  in when they happen. */
  key: string
}

const run = (src: string): Run => {
  const c = compile(src)
  if (!c.ok) return { compiled: false, staged: false, events: 0, peak: 0, key: '' }
  const st = stageCode(c.code)
  const errs = st.ok ? [] : st.diagnostics.filter((d) => d.severity === 'error')
  if (!st.ok || errs.length > 0) return { compiled: true, staged: false, events: 0, peak: 0, key: '' }
  const cps = st.cps ?? 0.5
  const evs = runPatterns(st.patterns, { cycles: 2, cps })
  const flat = [...evs.values()].flat()
  const key = JSON.stringify(flat)
  const mix = renderMix(st.synths, evs, 2 / cps, { cps, sampleRate: 22050 })
  let peak = 0
  for (const v of mix.left) { const a = Math.abs(v); if (a > peak) peak = a }
  return { compiled: true, staged: true, events: flat.length, peak, key }
}

describe.each(GOTCHAS.map((g) => [g.id, g] as const))('gotcha: %s', (_id, g: Gotcha) => {
  it('the FIX works: it compiles, stages and makes sound', () => {
    const r = run(g.fixed)
    expect(r.compiled, 'fixed does not compile').toBe(true)
    expect(r.staged, 'fixed does not stage').toBe(true)
    expect(r.events, 'fixed produces no events').toBeGreaterThan(0)
    expect(r.peak, 'fixed renders silence').toBeGreaterThan(0.001)
  })

  it(`the TRAP is still a trap (${g.fails})`, () => {
    const b = run(g.broken)
    switch (g.fails) {
      case 'compile':
        expect(b.compiled, 'broken now compiles — has this been fixed? delete the entry').toBe(false)
        break
      case 'stage':
        expect(b.compiled, 'broken no longer even compiles — the entry is describing the wrong failure').toBe(true)
        expect(b.staged, 'broken now stages — has this been fixed? delete the entry').toBe(false)
        break
      case 'silent':
        expect(b.staged, 'broken should be accepted, that is what makes it a trap').toBe(true)
        expect(b.peak, 'broken now makes sound — has this been fixed? delete the entry').toBeLessThan(0.001)
        break
      case 'wrong': {
        // it must RUN — a trap you cannot hear is just an error message — and
        // it must differ audibly from the fix, or the entry is describing a
        // distinction that does not exist
        expect(b.staged, 'broken should run; that is the whole problem').toBe(true)
        expect(b.peak, 'broken should make sound').toBeGreaterThan(0.001)
        const f = run(g.fixed)
        const identical = b.key === f.key && Math.abs(b.peak - f.peak) < 1e-9
        expect(identical, 'broken and fixed behave identically — the entry claims a difference that is not there').toBe(false)
        break
      }
    }
  })
})

describe('the troubleshooting page holds its shape', () => {
  it('has entries with unique ids', () => {
    expect(GOTCHAS.length).toBeGreaterThan(4)
    expect(new Set(GOTCHAS.map((g) => g.id)).size).toBe(GOTCHAS.length)
  })

  it('is titled by the SYMPTOM, in the first person', () => {
    // you arrive here from what you saw, not from the feature you did not
    // know you needed
    for (const g of GOTCHAS) {
      expect(g.symptom.length, g.id).toBeGreaterThan(15)
      expect(g.symptom, `${g.id}: symptom should not end in a question mark`).not.toMatch(/\?$/)
    }
  })

  it('always shows a pair, and they differ', () => {
    for (const g of GOTCHAS) {
      expect(g.broken.trim(), g.id).not.toBe(g.fixed.trim())
      expect(g.broken, `${g.id}: broken is not a whole program`).toMatch(/^synth |^switch |^macro /m)
    }
  })

  it('explains the MECHANISM, not just the fix', () => {
    for (const g of GOTCHAS) {
      expect(g.why.length, `${g.id}: why is too thin`).toBeGreaterThan(120)
      expect(g.why.length, `${g.id}: why has become an essay`).toBeLessThan(750)
    }
  })

  it('uses no em dashes, like the rest of the docs', () => {
    for (const g of GOTCHAS) {
      expect(g.why, g.id).not.toContain('—')
      expect(g.symptom, g.id).not.toContain('—')
    }
  })
})

describe('the input entry is precise about WHY, not just that it fails', () => {
  /* The first draft said "naming input is one argument too many", full stop.
   * That is wrong: it is about ARITY. `vocoder` takes two signals, so
   * `vocoder input` is correct and fills the modulator slot. A troubleshooting
   * page that over-generalises teaches a rule the reader will then trip over
   * in the opposite direction. */
  const bus = (body: string): boolean =>
    compile(`synth p\n  saw note\n\nbus b\n  ${body}\n  send p 1\n\nplay p\n  c3\n\ncps .5\n`).ok

  it('a one-signal processor rejects an explicit input', () => {
    expect(bus('reverb input room:.7')).toBe(false)
  })

  it('a TWO-signal processor accepts one, which is the nuance the entry states', () => {
    expect(bus('vocoder input bands:32')).toBe(true)
  })

  it('and the entry says so', () => {
    const g = GOTCHAS.find((x) => x.id === 'input-on-a-chain-line')!
    expect(g.why).toMatch(/vocoder/)
    expect(g.why).toMatch(/two signals/i)
  })
})

describe('troubleshooting reaches the docs page', () => {
  it('every gotcha appears as a section, last in the nav', () => {
    const fix = SECTIONS.filter((s) => s.group === 'troubleshooting')
    expect(fix).toHaveLength(GOTCHAS.length)
    const groups = orderedSections().map((s) => s.group)
    expect(groups[groups.length - 1]).toBe('troubleshooting')
  })

  it('shows the pair in the order broken-then-fixed', () => {
    // the fix has to come second: reading the broken one first is what makes
    // the diff explain itself
    for (const g of GOTCHAS) {
      const s = SECTIONS.find((x) => x.id === `fix-${g.id}`)!
      const codes = s.blocks.filter((b) => b.kind === 'code') as { text: string; caption?: string }[]
      expect(codes, g.id).toHaveLength(2)
      expect(codes[0]!.text).toBe(g.broken)
      expect(codes[1]!.text).toBe(g.fixed)
    }
  })

  it('captions the broken one, so it cannot be mistaken for the answer', () => {
    for (const g of GOTCHAS) {
      const s = SECTIONS.find((x) => x.id === `fix-${g.id}`)!
      const first = s.blocks.find((b) => b.kind === 'code') as { caption?: string }
      expect(first.caption, g.id).toMatch(/^this looks right and is not/)
    }
  })

  it('is titled by the symptom, so search finds it from what you saw', () => {
    const s = SECTIONS.find((x) => x.id === 'fix-silent-kick-still-pumps')!
    expect(s.title.toLowerCase()).toContain('pump')
  })
})
