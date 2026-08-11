import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { EXAMPLES } from '../src/examples'
import { runnableCodeBlocks } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * VOICE STACKING: the arithmetic bug that reads as correct code.
 *
 * `dur` MULTIPLIES a note's own length. It is not a count of bars. So this,
 * which looks like "a chord held for four cycles":
 *
 *     play pad
 *       <c3 a2 f2 g2>
 *       dur: 4
 *
 * is actually "a NEW chord every cycle, each held for four" — four voicings
 * sounding at once, for ever, each one adding its own gain. On a pad with a
 * sustaining envelope the level climbs until the master stage clips it, and
 * the sidechain the recipe was written to demonstrate disappears under the
 * mush. Two shipped recipes had exactly this (`pump`, `wavetable-morph`); the
 * fix in both was `<...>/4`, which slows the pattern so one chord actually
 * lasts four cycles.
 *
 * Nothing about it is visible in the source. It is only visible in the event
 * stream, which is why this is a test and not a review checklist.
 *
 * WHAT IS MEASURED: per synth, the largest number of distinct ONSET TIMES
 * whose notes are still sounding at once. A chord is one voicing however many
 * notes it holds; two chords overlapping is two. That distinction is the whole
 * point — polyphony is not the bug, accumulation is.
 * ------------------------------------------------------------------------- */

const CYCLES = 8

/** Largest number of simultaneously-sounding voicings, per synth. */
function stacking(code: string): Map<string, number> {
  const out = new Map<string, number>()
  const st = stageCode(code)
  if (!st.ok) return out
  const evs = runPatterns(st.patterns, { cycles: CYCLES, cps: st.cps ?? 0.5 }) as unknown as Map<
    string,
    { time: number; type: string; note?: number }[]
  >
  for (const [synth, list] of evs) {
    // pair each noteOn with the noteOff that closes it
    const open = new Map<number, number>()
    const spans: [number, number][] = []
    for (const e of [...list].sort((a, b) => a.time - b.time)) {
      const note = e.note ?? 0
      if (e.type === 'noteOn') open.set(note, e.time)
      else if (e.type === 'noteOff') {
        const started = open.get(note)
        if (started !== undefined) {
          spans.push([started, e.time])
          open.delete(note)
        }
      }
    }
    let peak = 0
    for (const [t] of spans) {
      // distinct onsets alive at this instant
      const alive = new Set(spans.filter(([a, b]) => a <= t && b > t).map(([a]) => a)).size
      if (alive > peak) peak = alive
    }
    if (peak > 0) out.set(synth, peak)
  }
  return out
}

/** Every doc surface that ships code a reader can run. */
function surfaces(): { label: string; code: string }[] {
  const out: { label: string; code: string }[] = []
  const add = (label: string, src: string, isRondo: boolean): void => {
    if (!isRondo) return void out.push({ label, code: src })
    const c = compile(src)
    if (c.ok) out.push({ label, code: c.code })
  }
  for (const r of RECIPES) add(`recipe: ${r.id}`, r.code, true)
  for (const e of EXAMPLES) add(`example: ${e.name}`, e.rondo ?? e.code, e.rondo !== undefined)
  // ids are not unique across the guide, so index them — otherwise two
  // different blocks share a label and an anchor below points at both
  runnableCodeBlocks().forEach((b, i) => add(`guide: ${b.id} #${i}`, b.text, b.lang === 'rondo'))
  return out
}

/* The one place three voicings overlap on purpose. `gong` holds each strike
 * for two cycles (`.dur(2)`) while `lead` plays a run on the same bell synth —
 * a bell ringing into the next strike is what a bell does, and its envelope
 * decays to zero so nothing accumulates.
 *
 * This is an anchor, not an allowlist: the test below fails if the entry ever
 * stops overlapping, so it cannot quietly rot into a blanket exemption the way
 * a hand-maintained skip list does.
 *
 * Keyed by a MARKER IN THE CODE rather than by its position. It used to be
 * `guide: notes #7`, an index into the flattened block list, so adding a code
 * block anywhere earlier in the guide silently moved the exemption onto an
 * unrelated snippet and failed this suite for a section nobody had touched.
 * Adding one to the patterns guide is exactly what exposed it. */
const INTENDED: readonly { marker: string; synth: string }[] = [
  { marker: "p('gong'", synth: 'bell' },
]

describe('no doc surface stacks voices', () => {
  const measured = surfaces().map((s) => ({ ...s, stack: stacking(s.code) }))

  it('measures something — an empty sweep would pass every assertion below', () => {
    const total = measured.reduce((n, m) => n + m.stack.size, 0)
    expect(measured.length, 'no runnable doc surfaces were collected').toBeGreaterThan(20)
    expect(total, 'no synth produced any notes — the detector is broken').toBeGreaterThan(30)
  })

  it('detects stacking when it is there', () => {
    /* The harness is worthless until it has been seen to fail. This is the
     * exact shape that shipped, kept as a fixture. */
    const bug = stacking(
      compile(`synth pad
  saw note
  * adsr .4 .3 .8 .6

play pad
  <c3 a2 f2 g2>
  dur: 4

cps .5`).code!,
    )
    expect(bug.get('pad'), 'the detector no longer sees the bug it was built for').toBe(4)
  })

  it('and the fix — slowing the pattern — reads as one voicing', () => {
    const fixed = stacking(
      compile(`synth pad
  saw note
  * adsr .4 .3 .8 .6

play pad
  <c3 a2 f2 g2>/4

cps .5`).code!,
    )
    expect(fixed.get('pad')).toBe(1)
  })

  it('every INTENDED marker still matches exactly one surface', () => {
    /* A marker that stops matching would exempt nothing and read as if it
     * still did; one that matches twice would exempt a surface silently. */
    for (const { marker } of INTENDED) {
      const hits = measured.filter((m) => m.code.includes(marker))
      expect(hits.length, `INTENDED marker ${marker} matches ${hits.length} surfaces, want 1`).toBe(1)
    }
  })

  for (const { label, code, stack } of measured) {
    it(`${label}`, () => {
      const exempt = INTENDED.find((x) => code.includes(x.marker))?.synth
      for (const [synth, peak] of stack) {
        if (synth === exempt) continue
        expect(
          peak,
          `\`${synth}\` has ${peak} voicings sounding at once. If that is a `
            + `\`dur:\` meant as a bar count, it is not one — \`dur\` multiplies the `
            + `note's own length. Slow the pattern instead (\`<...>/${peak}\`).`,
        ).toBeLessThanOrEqual(2)
      }
      if (exempt !== undefined) {
        expect(stack.get(exempt), `${label}/${exempt} no longer overlaps — drop it from INTENDED`)
          .toBeGreaterThan(2)
      }
    })
  }
})
