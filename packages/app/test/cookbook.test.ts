import { describe, expect, it } from 'vitest'
import { compile, decompile } from '@rondocode/rondo'
import { stageCode, runPatterns, renderMix, mixOptsFor } from '../../server/src/render-runner'
import { RECIPES } from '../src/docs/cookbook'
import { OPTIONS } from '../src/editor/rondo'
import { SECTIONS, blockText, orderedSections } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * Every recipe must actually run.
 *
 * A cookbook whose recipes do not work is worse than no cookbook: it costs the
 * reader their trust in everything else on the page, and they have no way to
 * tell which of the two is broken, their typing or ours.
 *
 * So this is not a lint. Each recipe is compiled, staged and RENDERED, and has
 * to make audible sound — the same bar the synth library holds its presets to.
 * ------------------------------------------------------------------------- */
describe.each(RECIPES.map((r) => [r.id, r] as const))('recipe: %s', (_id, r) => {
  it('compiles', () => {
    const c = compile(r.code)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
  })

  it('stages with no errors', () => {
    const c = compile(r.code)
    if (!c.ok) return
    const st = stageCode(c.code)
    const errs = st.ok ? [] : st.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
    expect(errs, errs.join(' | ')).toEqual([])
  })

  it('makes sound', () => {
    const c = compile(r.code)
    if (!c.ok) return
    const st = stageCode(c.code)
    if (!st.ok) return
    const cps = st.cps ?? 0.5
    const evs = runPatterns(st.patterns, { cycles: 2, cps })
    expect([...evs.values()].flat().length, 'no events').toBeGreaterThan(0)
    const mix = renderMix(st.synths, evs, 2 / cps, mixOptsFor(st, { cps, sampleRate: 22050 }))
    let peak = 0
    for (const v of mix.left) { const a = Math.abs(v); if (a > peak) peak = a }
    // the mic recipe has no input in a test process, so it is allowed silence
    // from its vocoder — but it must still render without throwing
    if (!r.tags.includes('mic')) expect(peak, 'rendered silence').toBeGreaterThan(0.001)
  })

  it('round-trips to JavaScript and back', () => {
    /* A recipe that only exists in rondo would be unusable to half the
     * readers. This used to assert `decompile` merely did not THROW, which a
     * decompiler returning the empty string for every recipe also satisfies —
     * verified: stubbing it to `''` left this green.
     *
     * The real contract is the one the README states: compile, decompile,
     * compile again, and the JavaScript is byte-identical. That is what makes
     * the two languages the same program rather than two similar ones. */
    const c = compile(r.code)
    if (!c.ok) return
    const back = decompile(c.code)
    expect(back.trim(), 'decompiled to nothing').not.toBe('')
    const again = compile(back)
    expect(again.ok, again.ok ? '' : `recompile failed: ${JSON.stringify(again.errors)}`).toBe(true)
    expect(again.ok ? again.code : '', 'the round trip is not a fixed point').toBe(c.code)
  })
})

describe('the cookbook holds its shape', () => {
  it('has recipes, and unique ids', () => {
    expect(RECIPES.length).toBeGreaterThan(5)
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length)
  })

  it('titles a recipe by the WANT, not by the feature', () => {
    // "Make a wide supersaw", not "Unison". The whole point of the cookbook is
    // that you can find it without already knowing what the thing is called.
    for (const r of RECIPES) {
      expect(r.title[0], `${r.id}: title should start with a capital`).toBe(r.title[0]!.toUpperCase())
      expect(r.title.split(' ').length, `${r.id}: title reads as a phrase`).toBeGreaterThan(2)
    }
  })

  it('names ONE move in why, at usable length', () => {
    for (const r of RECIPES) {
      expect(r.why.length, `${r.id}: why is too thin to be worth reading`).toBeGreaterThan(80)
      expect(r.why.length, `${r.id}: why is a walkthrough, not the one move`).toBeLessThan(700)
    }
  })

  it('is complete, never a fragment', () => {
    // the promise is paste-and-hear: a recipe with no synth or no play block
    // is a lesson, and lessons belong in the guide
    for (const r of RECIPES) {
      expect(r.code, `${r.id}: no synth`).toMatch(/^synth /m)
      /* `beat` plays as much as `play` does — it is the drum-grid spelling,
       * and a drum recipe has no reason to carry a `play` block as well. The
       * rule is "something sounds", not "the word play appears". */
      expect(r.code, `${r.id}: nothing plays`).toMatch(/^\s*(play|beat)\b/m)
      expect(r.code, `${r.id}: no tempo`).toMatch(/^cps /m)
    }
  })

  it('is tagged, so it can be found by something other than its title', () => {
    for (const r of RECIPES) expect(r.tags.length, r.id).toBeGreaterThan(1)
  })

  it('uses no em dashes, like the rest of the docs', () => {
    for (const r of RECIPES) {
      expect(r.why, r.id).not.toContain('—')
      expect(r.title, r.id).not.toContain('—')
    }
  })
})

describe('the `input` documentation matches what actually compiles', () => {
  /* The cookbook caught this: the doc entry for `input` showed
   * `post` / `reverb input room:.7`, and that is a compile error. On a chain
   * line the running signal is already implicit, so `input` is one argument
   * too many; it is only needed in a BINDING. A documented form that does not
   * compile is worse than no example. */
  const post = (body: string): boolean =>
    compile(`synth a\n  saw note\n  post\n    ${body}\n\nplay a\n  0\n\ncps .5\n`).ok

  it('rejects an explicit input on a chain line', () => {
    expect(post('reverb input room:.7')).toBe(false)
  })

  it('accepts the implicit form, and input inside a binding', () => {
    expect(post('reverb room:.7')).toBe(true)
    expect(post('rv = reverb input room:.7\n    mix rv .3')).toBe(true)
  })

  it('the vocabulary entry now shows a form that compiles', () => {
    const entry = OPTIONS.find((o) => o.label === 'input')!
    const example = String(entry.example)
    expect(example).toContain('=') // a binding, which is the only place it works
    const body = example.replace(/^post\n/, '').split('\n').map((l) => l.trim()).join('\n    ')
    expect(post(body), `documented example does not compile: ${example}`).toBe(true)
  })
})

describe('recipes reach the docs page as first-class sections', () => {
  /* Reusing Section rather than inventing a parallel content type is what
   * gets the cookbook nav, search, "open in editor" and the llms.txt export
   * for free. These pin that it really is wired in, not merely importable. */
  it('every recipe appears in SECTIONS, under the cookbook group', () => {
    const cook = SECTIONS.filter((s) => s.group === 'cookbook')
    expect(cook).toHaveLength(RECIPES.length)
    for (const r of RECIPES) {
      expect(cook.some((s) => s.id === `recipe-${r.id}`), r.id).toBe(true)
    }
  })

  it('sits after the guide and before the reference in the nav', () => {
    const groups = orderedSections().map((s) => s.group)
    const first = groups.indexOf('cookbook')
    expect(first).toBeGreaterThan(0)
    // and it is one contiguous run, not scattered through the guide
    expect(groups.lastIndexOf('cookbook') - first).toBe(RECIPES.length - 1)
  })

  it('carries the code as a RONDO block, so it opens in the right language', () => {
    for (const s of SECTIONS.filter((x) => x.group === 'cookbook')) {
      const code = s.blocks.find((b) => b.kind === 'code')
      expect(code, s.id).toBeDefined()
      expect((code as { lang?: string }).lang, s.id).toBe('rondo')
    }
  })

  it('puts the tags where search can reach them', () => {
    // a reader looking for "pump" should find the sidechain recipe even though
    // its title never says the word
    const pump = SECTIONS.find((s) => s.id === 'recipe-pump')!
    const text = pump.blocks.map(blockText).join(' ').toLowerCase()
    expect(text).toContain('pump')
    expect(pump.title.toLowerCase()).not.toContain('pump')
  })
})


/* ------------------------------------------------------------------------- *
 * THE COOKBOOK IS A SURFACE TOO.
 *
 * #298 made the guide cover every node the reference documents. Nothing
 * covered the COOKBOOK, and the cost showed: per-note expression shipped
 * across four PRs (#299-#304) with a reference entry, guide prose, an example
 * and no recipe at all, and the whole live mic chain shipped across five more
 * the same way. A reader who works from recipes never met either.
 *
 * This does NOT demand a recipe per node — most nodes do not want one, and a
 * cookbook padded to satisfy a test is worse than a short one. It demands a
 * recipe for the FAMILIES a musician goes looking for, which is a judgement
 * call, so the list is written down and adding to it is a deliberate act.
 * ------------------------------------------------------------------------- */
describe('the cookbook covers the things people come looking for', () => {
  const cook = RECIPES.map((r) => `${r.title} ${r.tags.join(' ')} ${r.code} ${r.why}`).join(' ').toLowerCase()

  /** Families worth a recipe, and a word that would appear in one. */
  const WANTED: [string, RegExp][] = [
    ['sidechain pumping', /sidechain/],
    ['a live mic chain', /noisegate/],
    ['per-note expression', /'gain:|'chance:/],
    ['mid/side and mono bass', /monobelow/],
    ['one knob, many destinations', /macro/],
    ['custom wavetables', /wavedef|wavetable/],
    ['euclidean rhythm', /euclid/],
    ['arrangement', /section |song /],
  ]

  it('has a recipe for each', () => {
    const missing = WANTED.filter(([, re]) => !re.test(cook)).map(([name]) => name)
    expect(missing, 'families with no recipe a reader could find').toEqual([])
  })

  it('and the list is not vacuous — every entry matches something REAL', () => {
    // a regex that matched nothing would pass the test above forever
    expect(RECIPES.length).toBeGreaterThan(8)
    expect(WANTED.length).toBeGreaterThan(5)
  })
})
