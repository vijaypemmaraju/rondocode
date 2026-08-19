import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import type { ControlMap, SchedulerEvent } from '@rondocode/pattern'
import { stageCode } from '../../server/src/render-runner'
import { EventFlasher, rondoNoteLiterals } from '../src/editor/flash'

/* ------------------------------------------------------------------------- *
 * ANYWHERE MINI-NOTATION IS SUPPORTED, IT LIGHTS UP.
 *
 * A `dur: <1 .5>` line sat dark while the notes beside it flashed, and it took
 * TWO halves to fix because it was broken in two places:
 *
 *   the pattern layer threw modifier locs away — only the note atom's `loc`
 *     survived onto an event, so there was nothing to flash
 *   the rondo compiler never reported the modifier spans, so even with a loc
 *     the editor had no literal in the buffer to map it onto
 *
 * Fixing either alone changes nothing visible, which is exactly why this test
 * drives the WHOLE chain: rondo source -> compiled spans -> staged pattern ->
 * scheduler-shaped events -> the flasher's dispatched ranges. It asserts on
 * the text that ends up highlighted, so a break anywhere in the middle shows
 * up as the wrong words lighting.
 * ------------------------------------------------------------------------- */

const SRC = `synth lead
  saw note
  * adsr .01 .1 .7 .2

play lead
  0 2 4 5
  scale: c-maj
  dur: <1 .5 1 .5>
  gain: <.9 .5>

cps .5`

/** Every stretch of the document the flasher lights for the first event. */
function flashedText(src: string): string[] {
  const c = compile(src)
  expect(c.ok, `compile failed: ${JSON.stringify(c.errors?.[0])}`).toBe(true)
  if (!c.ok) return []
  const st = stageCode(c.code)
  expect(st.ok, 'stage failed').toBe(true)
  if (!st.ok) return []

  // the first onset, with whatever locs the pattern layer put on it
  const pat = [...st.patterns.values()][0]!
  const haps = pat.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
  expect(haps.length, 'no events').toBeGreaterThan(0)
  const controls = haps[0]!.value as ControlMap
  const ev: SchedulerEvent = {
    timeSec: 0,
    durSec: 0.25,
    cycle: 0,
    controls,
    ...(controls.loc !== undefined ? { loc: controls.loc } : {}),
    ...(controls.locs !== undefined ? { locs: controls.locs } : {}),
  }

  const dispatched: { from: number; to: number }[] = []
  const timers: (() => void)[] = []
  const flasher = new EventFlasher(
    {
      dispatch: (spec: { effects: unknown[] }) => {
        for (const e of spec.effects as { value?: { from: number; to: number } }[]) {
          if (e.value !== undefined && typeof e.value.from === 'number') dispatched.push(e.value)
        }
      },
      state: { doc: { length: src.length } },
    },
    () => 0,
    () => false,
    { setTimeoutImpl: (fn) => { timers.push(fn); return timers.length }, clearTimeoutImpl: () => {} },
  )
  flasher.onGoodEvalLiterals(rondoNoteLiterals(c.notes))
  flasher.onEvents([ev])
  // fire the scheduling timer so the marks go up
  for (const t of timers.splice(0)) t()
  return dispatched.map((r) => src.slice(r.from, r.to))
}

describe('a modifier line lights up when it fires', () => {
  const lit = flashedText(SRC)

  it('lights something at all', () => {
    expect(lit.length, 'nothing flashed').toBeGreaterThan(0)
  })

  it('lights the NOTE atom, as it always did', () => {
    expect(lit).toContain('0')
  })

  it('lights the dur atom that applied', () => {
    // first event: `<1 .5 1 .5>` is on its first arm
    expect(lit, `flashed: ${lit.join(' ')}`).toContain('1')
  })

  it('lights the gain atom that applied', () => {
    expect(lit, `flashed: ${lit.join(' ')}`).toContain('.9')
  })

  it('does NOT light the arms that did not fire', () => {
    /* The whole point of following the notation rather than lighting the line:
     * `.5` is the second arm of both modifiers and must stay dark on cycle 0. */
    const offsets = lit.join(' ')
    expect(offsets).not.toContain('.5 1 .5')
  })
})

describe('the two halves are both load-bearing', () => {
  it('the compiler reports a span for every mini modifier', () => {
    const c = compile(SRC)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const contents = c.notes.map((n) => n.content)
    expect(contents).toContain('0 2 4 5')
    expect(contents, 'dur span missing — the editor has nothing to light').toContain('<1 .5 1 .5>')
    expect(contents, 'gain span missing').toContain('<.9 .5>')
  })

  it('and every reported span sits where it says in the buffer', () => {
    // an offset that is off by even one puts the highlight on the wrong text
    const c = compile(SRC)
    if (!c.ok) return
    for (const nspan of c.notes) {
      expect(SRC.slice(nspan.from, nspan.from + nspan.content.length), `span '${nspan.content}' is misplaced`)
        .toBe(nspan.content)
    }
  })

  it('the pattern layer puts the modifier locs on the event', () => {
    const c = compile(SRC)
    if (!c.ok) return
    const st = stageCode(c.code)
    if (!st.ok) return
    const pat = [...st.patterns.values()][0]!
    const controls = pat.query(new TimeSpan(F(0), F(1))).filter(hasOnset)[0]!.value as ControlMap
    const srcs = (controls.locs ?? []).map((l) => l.src)
    expect(srcs).toContain('<1 .5 1 .5>')
    expect(srcs).toContain('<.9 .5>')
  })
})
