import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { renderOffline } from '@rondocode/engine'
import { goertzel } from '../../engine/test/util/goertzel'
import { Fraction as F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* ------------------------------------------------------------------------- *
 * A PER-NOTE PITCH CURVE.
 *
 * `0'2` gives a note its own number (see note-expression.test.ts). This is
 * what that number is FOR: the synth declares curve shapes, and the note's own
 * value chooses between them — so two notes in the same line can bend in
 * opposite directions.
 *
 * No engine change was needed for this. An envelope is a signal like any
 * other, so blending two of them by a per-note param is ordinary arithmetic,
 * and it MORPHS rather than switching: a note at 0.5 gets half of each. That
 * is a better fit for music than a discrete pick, and it falls out of the
 * primitives rather than being designed in.
 *
 * Everything here is measured from rendered audio, because a pitch curve that
 * is not in the audio is not a pitch curve.
 * ------------------------------------------------------------------------- */

const sr = 48000
const SRC = `synth lead
  saw note*bend
  * amp
  amp = adsr .01 .1 .8 .2
  expr = knob 0 0..1
  scoop = env .06 .06 .18 0 .3 0
  fall = env .04 -.05 .25 0 .3 0
  bend = scoop * (1 - expr) + fall * expr + 1

play lead
  a3
  dur: .5

cps .5
`

const compiled = compile(SRC)
const staged = compiled.ok ? evalCode(compiled.code, baseScope) : undefined
const def = staged?.synths.get('lead')

/** Cents from 220 Hz at `t` seconds into a note rendered with this `expr`. */
function centsAt(expr: number, t: number): number {
  const o = renderOffline(def!, [
    { time: 0, type: 'param', name: 'expr', value: expr },
    { time: 0.02, type: 'noteOn', note: 57 },
    { time: 0.5, type: 'noteOff', note: 57 },
  ] as never, 0.8, { sampleRate: sr }).left
  const w = o.slice(Math.floor(t * sr), Math.floor(t * sr) + Math.floor(0.04 * sr))
  let best = 0, bf = 0
  // scan for the strongest fundamental; an F0 tracker octave-errors on a saw
  for (let hz = 180; hz <= 270; hz += 0.2) { const m = goertzel(w, hz, sr); if (m > best) { best = m; bf = hz } }
  return 1200 * Math.log2(bf / 220)
}

describe('a per-note value chooses the note\'s pitch curve', () => {
  it('compiles and stages (everything below is vacuous otherwise)', () => {
    expect(compiled.ok, compiled.ok ? '' : JSON.stringify(compiled.errors)).toBe(true)
    expect(staged?.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(def, 'the synth is gone').toBeDefined()
  })

  it('bends UP when the note asks for the scoop', () => {
    expect(centsAt(0, 0.05), 'the scoop did not scoop').toBeGreaterThan(50)
  })

  it('bends DOWN when the note asks for the fall — the SAME synth', () => {
    // two notes in one line can now go opposite ways, which is the feature
    expect(centsAt(1, 0.05), 'the fall did not fall').toBeLessThan(-50)
  })

  it('MORPHS between them rather than switching', () => {
    /* An envelope is a signal, so blending two is ordinary arithmetic — a note
     * at 0.5 gets half of each. Monotonic across the range: more `expr` is
     * always further toward the fall, never a jump. */
    const at = [0, 0.25, 0.5, 0.75, 1].map((v) => centsAt(v, 0.05))
    for (let i = 1; i < at.length; i++) {
      expect(at[i]!, `expr ${i / 4} did not continue the morph`).toBeLessThan(at[i - 1]!)
    }
    expect(at[2]!, 'the midpoint should be near neutral').toBeGreaterThan(-25)
    expect(at[2]!, 'the midpoint should be near neutral').toBeLessThan(25)
  })

  it('every note settles back to the written pitch', () => {
    // a bend that does not resolve is a tuning bug, not an expression
    for (const v of [0, 0.5, 1]) {
      expect(Math.abs(centsAt(v, 0.3)), `expr ${v} never came home`).toBeLessThan(15)
    }
  })

  it('the curve is IN THE NOTE: `0\'2` reaches it end to end', () => {
    // the notation half, joined to the audio half
    const src = SRC.replace('play lead\n  a3', "play lead\n  a3'1 a3'0")
    const c = compile(src)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const r = evalCode(c.code, baseScope)
    const pat = [...r.patterns.values()][0]!
    const vals = pat.query(new TimeSpan(new F(0), new F(1)))
      .filter(hasOnset)
      .map((h) => (h.value as Record<string, unknown>)['expr'])
    expect(vals, 'the two notes did not carry their own values').toEqual([1, 0])
  })
})
