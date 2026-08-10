import { describe, expect, it } from 'vitest'
import { compile } from '@rondocode/rondo'
import { stageCode, runPatterns } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'

/* ------------------------------------------------------------------------- *
 * TWO KINDS OF HARMONY, AND THE COOKBOOK CLAIMS THE DIFFERENCE.
 *
 * `pitchshift` works on AUDIO, where the note and the scale are already gone,
 * so it can only move everything by the same number of semitones — a third
 * above every note, not a third in the key.
 *
 * `superimpose: add 2` works on the PATTERN, where the scale is still known.
 * `add` counts SCALE DEGREES, so two steps up the scale is a minor third above
 * some notes and a major third above others. That difference is the entire
 * reason both recipes exist, and it is measurable: count the semitones between
 * the two notes sounding at each step and see whether the number moves.
 *
 * Without this, `superimpose: add 2` could silently become a fixed shift (or
 * stop superimposing at all) and both recipes would still render, still make
 * sound, and still pass every other check in the suite.
 * ------------------------------------------------------------------------- */

/** The semitone gap at every step where two notes sound together. */
function intervals(rondo: string, patternName: string): number[] {
  const c = compile(rondo)
  expect(c.ok, `does not compile: ${JSON.stringify(c.errors?.[0])}`).toBe(true)
  if (!c.ok) return []
  const st = stageCode(c.code)
  expect(st.ok, 'does not stage').toBe(true)
  if (!st.ok) return []
  const cps = st.cps ?? 0.5
  const evs = runPatterns(st.patterns, { cycles: 1, cps }) as unknown as Map<
    string,
    { time: number; type: string; note?: number }[]
  >
  const byOnset = new Map<number, number[]>()
  for (const e of evs.get(patternName) ?? []) {
    if (e.type !== 'noteOn') continue
    const k = Math.round(e.time * 1000)
    const at = byOnset.get(k) ?? []
    at.push(e.note ?? 0)
    byOnset.set(k, at)
  }
  const out: number[] = []
  for (const [, notes] of [...byOnset.entries()].sort((a, b) => a[0] - b[0])) {
    if (notes.length < 2) continue
    notes.sort((a, b) => a - b)
    out.push(notes[1]! - notes[0]!)
  }
  return out
}

describe('the diatonic-harmony recipe really follows the key', () => {
  const recipe = RECIPES.find((r) => r.id === 'diatonic-harmony')

  it('ships', () => {
    expect(recipe, 'the diatonic-harmony recipe is gone').toBeDefined()
  })

  it('sounds TWO notes at every step — superimpose keeps the original', () => {
    const ivs = intervals(recipe!.code, 'lead')
    expect(ivs.length, 'nothing was superimposed').toBeGreaterThan(4)
  })

  it('and the interval CHANGES, which is what "in the key" means', () => {
    /* The claim the recipe is built on. A fixed shift would give one number
     * here; a diatonic one gives minor thirds on some degrees and major on
     * others. Measured on this line: 3 4 3 4 3 4 3 3. */
    const ivs = intervals(recipe!.code, 'lead')
    const distinct = [...new Set(ivs)].sort()
    expect(distinct, `every interval was the same (${ivs.join(' ')}) — this is not diatonic`)
      .toEqual([3, 4])
  })

  it('a CONSTANT interval is what failure looks like', () => {
    /* The control that makes the test above mean something. Seven degrees is
     * an octave in a 7-note scale, so every step is exactly 12 semitones — one
     * distinct interval, which is precisely the shape `pitchshift` is stuck
     * with and precisely what this recipe must not produce. */
    const octave = recipe!.code.replace('superimpose: add 2', 'superimpose: add 7')
    const ivs = intervals(octave, 'lead')
    expect(ivs.length).toBeGreaterThan(4)
    expect([...new Set(ivs)], `expected one interval, got ${ivs.join(' ')}`).toEqual([12])
  })

  it('works in a MAJOR key too, with the thirds the other way round', () => {
    const major = recipe!.code.replace('scale:a-min', 'scale:c-maj')
    const ivs = intervals(major, 'lead')
    expect([...new Set(ivs)].sort(), `major-key intervals: ${ivs.join(' ')}`).toEqual([3, 4])
  })
})
