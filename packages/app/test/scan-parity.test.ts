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

/** Families compared. `filters` is absent because the JS side is still a stub
 *  — listing it here would be the honest place to notice that, and it is:
 *  see the test at the bottom, which asserts exactly which ones are missing so
 *  the gap cannot be forgotten again. */
const FAMILIES = [
  'knobs', 'envs', 'envPoints', 'plays', 'richPlays', 'beats',
  'unisonHeaders', 'wavetableCalls', 'wavedefs', 'enumSpans',
] as const

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
}

describe('rondo and JS scanners see the same document', () => {
  for (const [label, rondo] of Object.entries(CASES)) {
    it(`agrees on ${label}`, () => {
      const c = compile(rondo)
      expect(c.ok, JSON.stringify(c.ok ? [] : c.errors)).toBe(true)
      if (!c.ok) return
      for (const fam of FAMILIES) {
        const r = (RONDO_SCAN as WidgetScan)[fam](rondo)
        const j = (JS_SCAN as WidgetScan)[fam](c.code)
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
        if ((RONDO_SCAN as WidgetScan)[fam](rondo).length > 0) seen.add(fam)
      }
    }
    expect([...FAMILIES].filter((f) => !seen.has(f))).toEqual([])
  })
})

describe('which families are still rondo-only', () => {
  it('is exactly this list — shrink it, never grow it', () => {
    // A PR claimed every family was covered while two were stubs. Naming them
    // here means the next such claim has to edit this line to be true.
    const src = 'synth a\n  saw note\n  svf 900 res:.4 mode:lp\n'
    const c = compile(src)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const stubbed = ([...FAMILIES, 'filters'] as const).filter((fam) => {
      const r = fam === 'filters'
        ? RONDO_SCAN.filters(src, RONDO_SCAN.knobs(src))
        : (RONDO_SCAN as WidgetScan)[fam](src)
      const j = fam === 'filters'
        ? JS_SCAN.filters(c.code, JS_SCAN.knobs(c.code))
        : (JS_SCAN as WidgetScan)[fam](c.code)
      return r.length > 0 && j.length === 0
    })
    expect(stubbed).toEqual(['filters'])
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

  it('names the filter curve as the exception, and it still IS the exception', () => {
    expect(readme).toMatch(/filter response\s*\n?\s*curve is the one view still rondo-only/)
    const src = 'synth a\n  saw note\n  svf 900 res:.4 mode:lp\n'
    const c = compile(src)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(RONDO_SCAN.filters(src, RONDO_SCAN.knobs(src)).length).toBeGreaterThan(0)
    expect(JS_SCAN.filters(c.code, JS_SCAN.knobs(c.code))).toEqual([])
  })
})
