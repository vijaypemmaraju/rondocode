import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, expandScale } from '@rondocode/rondo'
import { RONDO_SCAN } from '../src/editor/rondo/widgets'
import { JS_SCAN } from '../src/editor/widgets/jsscan'
import type { WidgetScan } from '../src/editor/rondo/widgets'

/* ------------------------------------------------------------------------- *
 * Widget scanners: the two languages must SEE the same document.
 *
 * Nine families now exist twice, and the failure mode is quiet: a scanner that
 * classifies one case differently, or misses an argument, ships as "the widget
 * works" and only shows up as a control that does nothing in one language.
 *
 * So this compares them differentially. A rondo program is COMPILED, both
 * scanners run, and the results must agree — same music, same widgets. That is
 * a much stronger check than two independent expectations, because neither
 * side can drift without the other noticing.
 *
 * Positions and language-specific punctuation are excluded: `.005` and `0.005`
 * sit at different offsets and a JS enum is quoted. Everything that decides
 * WHAT a widget is and what it shows has to match.
 *
 * This is the test that caught `filters` and `enumSpans` still being stubs
 * after a PR claimed every family was covered.
 * ------------------------------------------------------------------------- */

/** Keys that legitimately differ between the languages. */
const POSITIONAL = new Set([
  'from', 'to', 'at', 'defFrom', 'defTo',
  'timeSpan', 'levelSpan', 'curveSpan', 'ranges', 'gainSpan', 'curveInsert',
  'srcOffset', 'srcFull', 'hadComment',
  // A switch's writes are WHERE the language spells its two values, and the
  // two languages spell a different NUMBER of them: JS repeats the resting
  // value as both the default and the first array element, rondo writes it
  // once. Excluded here and checked directly in switches.test.ts, the same
  // split `ranges` and `gainSpan` already use.
  'writes',
])

const semantic = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(semantic)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort()) {
      if (POSITIONAL.has(k)) continue
      const val = (v as Record<string, unknown>)[k]
      // rondo hands over `a-min`, JS `a minor`. Both are short forms the
      // preview expands, so compare the SCALE rather than the spelling —
      // requiring identical text would fail on a difference that changes
      // nothing, and comparing nothing would miss one that does.
      out[k] = k === 'scale' && typeof val === 'string' ? expandScale(val) : semantic(val)
    }
    return out
  }
  return v
}

/** Every family, filters included — the last one to cross. The test at the
 *  bottom asserts the rondo-only list is EMPTY, which is the claim this file
 *  exists to keep honest. */
const FAMILIES = [
  'knobs', 'envs', 'envPoints', 'plays', 'richPlays', 'beats',
  'unisonHeaders', 'wavetableCalls', 'wavedefs', 'enumSpans', 'filters', 'switches',
] as const

/** `filters` is the one scanner that takes a second argument (knob DEFs, for a
 *  signal-driven cutoff's fallback value), so it cannot go through the plain
 *  indexed call the rest share. */
const run = (scan: WidgetScan, fam: (typeof FAMILIES)[number], text: string): unknown[] =>
  fam === 'filters' ? scan.filters(text, scan.knobs(text)) : (scan as WidgetScan)[fam](text)

/* A bare `ladder 1200` is deliberately NOT here. rondo's codegen materialises
 * its res default into the output (`{ res: 0.5 }`), so the compiled JS has a
 * number to drag that the rondo source does not — a real difference between
 * two texts, not a disagreement between two scanners. The JS side's own
 * default is pinned directly in jsscan.test.ts, where compiled rondo cannot
 * reach: it is 0, the engine's, and NOT rondo's 0.5. */
const CASES: Record<string, string> = {
  'a knob': 'synth a\n  saw note\n  svf cut res:.3\n  cut = knob 900 100..8000 log\n',
  'an adsr': 'synth a\n  saw note\n  * e\n  e = adsr .005 .2 .3 .1\n',
  'env breakpoints': 'synth a\n  saw note\n  * e\n  e = env .005 1 .15 .4 .5 .6\n',
  'a per-segment curve': 'synth a\n  saw note\n  * e\n  e = env .005 1:3 .15 .4\n',
  'a step grid': 'synth a\n  saw note\n\nplay a\n  0 3 5 7\n',
  'a scaled grid': 'synth a\n  saw note\n\nplay a\n  0 3 5 7  scale:a-min\n',
  'negative degrees': 'synth a\n  saw note\n\nplay a\n  -1 0 ~ 3\n',
  'rich notation': 'synth a\n  saw note\n\nplay a\n  <0 3> 5 [7,9]\n',
  'a euclid figure': 'synth a\n  saw note\n\nplay a\n  0(3,8)\n',
  'a beat block': 'synth kick\n  sine 60\n\nbeat\n  kick ~ kick ~\n  ~ hat:.6 ~ hat\n',
  'unison options': 'synth a unison:5 detune:20 spread:.8\n  saw note\n',
  'a wavetable call': 'synth a\n  wavetable note .3 table:basic\n',
  'a custom wavetable': 'wavedef vox 1 .3 / .5 1\n\nsynth a\n  wavetable note .2 table:vox\n',
  'a filter mode': 'synth a\n  saw note\n  svf 900 res:.4 mode:lp\n',
  // switches: a synth-local one, a project-wide one, and a negative pair
  'a switch binding': 'synth a\n  saw note\n  * d\n  d = switch .2 .9\n',
  'a switch macro': 'switch fat 1 9\n\nsynth a\n  saw note\n  * fat / 9\n',
  'a negative switch': 'synth a\n  saw note\n  * b\n  b = switch -1 1\n',
  // filter curves: literal cutoff, knob-bound cutoff (value but no handle),
  // a rich expression (no curve at all), dual routing, and eq bands
  'a written res': 'synth a\n  saw note\n  ladder 1200 res:.7\n',
  'a knob-bound cutoff': 'synth a\n  saw note\n  svf cut\n  cut = knob 640 80..9000 log\n',
  'an expression cutoff': 'synth a\n  saw note\n  * e\n  ladder cut * 2\n  e = adsr .01 .1 .5 .1\n  cut = knob 900 100..8000\n',
  'a dual filter': 'synth a\n  saw note\n  dualsvf 400 4000 mode:parallel a:lp b:hp res:.3\n',
  'eq bands': 'synth a\n  saw note\n  eq peak 800 6 1.2 hp 120 highshelf 6000 -3\n',
}

describe('rondo and JS scanners see the same document', () => {
  for (const [label, rondo] of Object.entries(CASES)) {
    it(`agrees on ${label}`, () => {
      const c = compile(rondo)
      expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
      if (!c.ok) return
      for (const fam of FAMILIES) {
        const r = run(RONDO_SCAN, fam, rondo)
        const j = run(JS_SCAN, fam, c.code)
        expect(semantic(j), `${fam} differs`).toEqual(semantic(r))
      }
    })
  }

  it('finds SOMETHING for each family, so agreement is not two empty lists', () => {
    const seen = new Set<string>()
    for (const rondo of Object.values(CASES)) {
      const c = compile(rondo)
      if (!c.ok) continue
      for (const fam of FAMILIES) {
        if (run(RONDO_SCAN, fam, rondo).length > 0) seen.add(fam)
      }
    }
    expect([...FAMILIES].filter((f) => !seen.has(f))).toEqual([])
  })
})

describe('which families are still rondo-only', () => {
  it('is nothing — the list is empty and must stay that way', () => {
    // A PR claimed every family was covered while two were stubs. This started
    // life asserting `['filters']`; it now asserts nothing, which is a claim
    // that has to be re-earned by every future family.
    const src = 'synth a\n  saw note\n  svf 900 res:.4 mode:lp\n'
    const c = compile(src)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const stubbed = FAMILIES.filter(
      (fam) => run(RONDO_SCAN, fam, src).length > 0 && run(JS_SCAN, fam, c.code).length === 0,
    )
    expect(stubbed).toEqual([])
  })
})

describe('the README says which view is still rondo-only', () => {
  /* A PR claimed full coverage while two families were stubs, and the README
   * now makes the same kind of claim. Pinning it to the actual scan tables is
   * what stops the prose outliving the code — the failure this session
   * produced twice. */
  const readme = readFileSync(join(__dirname, '../../../README.md'), 'utf8')

  it('claims widget parity in both languages', () => {
    expect(readme).toMatch(/controls read the source rather than the\s*\n?\s*language/)
  })

  it('no longer carves out the filter curve, because it is no longer carved out', () => {
    expect(readme).not.toMatch(/still rondo-only/)
    const src = 'synth a\n  saw note\n  svf 900 res:.4 mode:lp\n'
    const c = compile(src)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    // both sides see the curve now — the README's unqualified claim is true
    expect(RONDO_SCAN.filters(src, RONDO_SCAN.knobs(src)).length).toBeGreaterThan(0)
    expect(JS_SCAN.filters(c.code, JS_SCAN.knobs(c.code)).length).toBeGreaterThan(0)
  })
})
