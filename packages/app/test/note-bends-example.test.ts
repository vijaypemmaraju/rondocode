import { describe, expect, it } from 'vitest'
import { Fraction as F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { renderOffline } from '@rondocode/engine'
import { goertzel } from '../../engine/test/util/goertzel'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { compile } from '@rondocode/rondo'
import { EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * THE "note bends" EXAMPLE, HELD TO ITS COMMENTS.
 *
 * It claims four things in the header: '1 scoops up, '0 plays straight, '-1
 * falls in from above, and fractional values morph rather than switch. It also
 * claims a value written on a note survives rests and subgroups.
 *
 * All five are measurable, so all five are measured — from rendered audio for
 * the bends, and from the queried pattern for the attachment.
 * ------------------------------------------------------------------------- */

const sr = 48000
const ex = EXAMPLES.find((e) => e.name === 'note bends')
const staged = ex === undefined ? undefined : evalCode(ex.code, baseScope)
const def = staged?.synths.get('lead')

/** Cents from `nominal` 60 ms into a note rendered at this expression value. */
function cents(expr: number, midi: number, nominal: number): number {
  const o = renderOffline(def!, [
    { time: 0, type: 'param', name: 'expr', value: expr },
    { time: 0.02, type: 'noteOn', note: midi },
    { time: 0.4, type: 'noteOff', note: midi },
  ] as never, 0.6, { sampleRate: sr }).left
  const w = o.slice(Math.floor(0.06 * sr), Math.floor(0.06 * sr) + Math.floor(0.04 * sr))
  let best = 0, bf = 0
  for (let hz = nominal * 0.8; hz <= nominal * 1.25; hz += 0.2) {
    const m = goertzel(w, hz, sr)
    if (m > best) { best = m; bf = hz }
  }
  return 1200 * Math.log2(bf / nominal)
}

describe('the "note bends" example does what its header says', () => {
  it('ships and stages (a rename makes everything below vacuous)', () => {
    expect(ex, 'the example is gone').toBeDefined()
    expect(staged?.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(def, 'the synth is not called `lead` any more').toBeDefined()
  })

  it("'1 scoops UP into the note", () => {
    expect(cents(1, 57, 220), 'no upward scoop').toBeGreaterThan(40)
  })

  it("'0 plays it straight", () => {
    expect(Math.abs(cents(0, 57, 220)), 'a note asking for nothing still bent').toBeLessThan(15)
  })

  it("'-1 falls INTO it from above", () => {
    expect(cents(-1, 57, 220), 'no downward fall').toBeLessThan(-40)
  })

  it('fractional values MORPH rather than switch', () => {
    // the claim in the header: `'.5` is half a scoop, not a different mode
    const half = cents(0.5, 57, 220)
    const full = cents(1, 57, 220)
    expect(half, 'half a scoop went the wrong way').toBeGreaterThan(10)
    expect(half, 'half a scoop was not smaller than a whole one').toBeLessThan(full * 0.8)
  })

  it('the values SURVIVE a subgroup — the second play block proves it', () => {
    // `~ ~ [12'1 11'-1] ~`: two notes inside one step, opposite values
    const pats = [...(staged?.patterns.values() ?? [])]
    const all = pats.flatMap((p) => p.query(new TimeSpan(new F(0), new F(1))).filter(hasOnset))
    const inSub = all
      .map((h) => h.value as Record<string, unknown>)
      .filter((v) => v['n'] === 12 || v['n'] === 11)
      .map((v) => [v['n'], v['expr']])
    expect(inSub, 'the subgroup notes lost their own values').toEqual([[12, 1], [11, -1]])
  })

  it('every bend resolves back to the written pitch', () => {
    // a bend that never comes home is a tuning bug, not an expression
    for (const v of [-1, 0, 1]) {
      const o = renderOffline(def!, [
        { time: 0, type: 'param', name: 'expr', value: v },
        { time: 0.02, type: 'noteOn', note: 57 },
        { time: 0.5, type: 'noteOff', note: 57 },
      ] as never, 0.8, { sampleRate: sr }).left
      const w = o.slice(Math.floor(0.35 * sr), Math.floor(0.35 * sr) + Math.floor(0.04 * sr))
      let best = 0, bf = 0
      for (let hz = 190; hz <= 260; hz += 0.2) { const m = goertzel(w, hz, sr); if (m > best) { best = m; bf = hz } }
      expect(Math.abs(1200 * Math.log2(bf / 220)), `'${v} never came home`).toBeLessThan(20)
    }
  })
})


describe('a lane name is not a pitch', () => {
  it('a degree line with named lanes still compiles to n(), not note()', () => {
    /* `'vel:` carries v, e, l and `'chance:` carries a, c, e — every one of
     * which reads as a note name to the entry-point heuristic. It flipped a
     * whole degree line to note(), which then read `0` as MIDI 0 and dropped
     * the scale silently: exactly the failure the accidental rule beside it
     * was already written to prevent. */
    const c = compile("synth lead\n  saw\n\nplay lead\n  0'vel:.5 7'chance:.5\n  scale: a-min\n\ncps .5\n")
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    // the emitted string escapes the quote: n('0\'vel:.5 …')
    expect(c.code, 'the line was read as note NAMES').toMatch(/\bn\('0/)
    expect(c.code).not.toMatch(/note\('0/)
  })

  it('and real note names still reach note()', () => {
    const c = compile('synth lead\n  saw\n\nplay lead\n  c4 e4\n\ncps .5\n')
    expect(c.ok && c.code.includes("note('c4 e4')")).toBe(true)
  })
})
