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
  it('every recipe appears in SECTIONS, on a cookbook shelf', () => {
    const cook = SECTIONS.filter((s) => s.group.startsWith('cookbook'))
    expect(cook).toHaveLength(RECIPES.length)
    for (const r of RECIPES) {
      expect(cook.some((s) => s.id === `recipe-${r.id}`), r.id).toBe(true)
    }
  })

  it('sits after the guide and before the reference in the nav', () => {
    const groups = orderedSections().map((s) => s.group)
    const first = groups.findIndex((g) => g.startsWith('cookbook'))
    expect(first).toBeGreaterThan(0)
    // and the shelves are one contiguous run, not scattered through the guide
    const last = groups.length - 1 - [...groups].reverse().findIndex((g) => g.startsWith('cookbook'))
    expect(last - first).toBe(RECIPES.length - 1)
  })

  it('carries the code as a RONDO block, so it opens in the right language', () => {
    for (const s of SECTIONS.filter((x) => x.group.startsWith('cookbook'))) {
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

describe('the endless drone does what its title claims', () => {
  /* Every recipe is checked for "makes sound". This one promises something
   * stronger and more falsifiable -- that it EVOLVES and never ends -- and a
   * drone that renders a steady tone would pass the generic bar while failing
   * the reader completely.
   *
   * The measurements below are the ones that shaped the recipe. An earlier
   * draft moved so slowly that the first forty seconds were flat; another was
   * hot enough that the offline render silently normalised it down 2 dB, which
   * hides exactly the kind of level mistake a reader would then copy. */
  const r = RECIPES.find((x) => x.id === 'endless-drone')!
  const SR = 11025
  const SECS = 60

  const render = (): Float32Array => {
    const c = compile(r.code)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(JSON.stringify(st.diagnostics))
    const cps = st.cps ?? 0.5
    const evs = runPatterns(st.patterns, { cycles: Math.ceil(SECS * cps), cps })
    const mix = renderMix(st.synths, evs, SECS, mixOptsFor(st, { cps, sampleRate: SR }))
    expect(mix.normalized, 'the render had to turn it DOWN: the recipe ships a level a reader would copy').toBe(false)
    return mix.left
  }

  /** Share of energy in the fast-changing part of the signal: brightness. */
  const bright = (x: Float32Array, from: number, to: number): number => {
    let hi = 0, all = 0, prev = 0
    for (let i = from; i < to; i++) {
      const v = x[i]!
      const d = v - prev
      prev = v
      hi += d * d
      all += v * v
    }
    return all === 0 ? 0 : hi / all
  }

  /* Computed on first use, not in the describe body: an assertion that throws
   * during collection aborts the whole FILE rather than failing one test, so
   * the level check below reported "no tests" instead of naming itself. */
  let cached: { rms: number; bright: number }[] | undefined
  const windowsOf = (): { rms: number; bright: number }[] => {
    if (cached !== undefined) return cached
    const mix = render()
    const win = 5 * SR
    const out: { rms: number; bright: number }[] = []
    for (let w = 0; w + win <= mix.length; w += win) {
      let e = 0
      for (let i = w; i < w + win; i++) e += mix[i]! * mix[i]!
      out.push({ rms: Math.sqrt(e / win), bright: bright(mix, w, w + win) })
    }
    cached = out
    return out
  }

  it('ships a level the offline render does not have to turn down', () => {
    render() // the normalized assertion lives in here
  })

  it('EVOLVES: the timbre keeps moving', () => {
    const b = windowsOf().map((w) => w.bright)
    const lo = Math.min(...b)
    const hi = Math.max(...b)
    expect(hi / lo, `brightness barely moved (${lo.toFixed(4)}..${hi.toFixed(4)})`).toBeGreaterThan(2)
  })

  it('and it WANDERS rather than sweeping once and settling', () => {
    /* A single slow filter sweep would pass the range check above while
     * sounding like one gesture and then nothing. Direction has to change. */
    const b = windowsOf().map((w) => w.bright)
    let turns = 0
    for (let i = 2; i < b.length; i++) {
      const a = b[i - 1]! - b[i - 2]!
      const c = b[i]! - b[i - 1]!
      if (a !== 0 && c !== 0 && Math.sign(a) !== Math.sign(c)) turns++
    }
    expect(turns, 'the brightness only went one way').toBeGreaterThan(3)
  })

  it('NEVER ENDS: no window falls silent', () => {
    /* TWO mechanisms hold this up and either one alone is enough, which the
     * sabotage pass is what revealed: shortening `dur:` changes nothing
     * measurable, and shortening the release changes nothing either (with a
     * long `dur:` the gate never closes, so the release is never reached).
     * Shorten BOTH and the quietest second goes to 0.0000. So this assertion
     * only bites on the combination, and the recipe's prose says so instead of
     * crediting `dur:` alone, which is what it used to claim. */
    const quietest = Math.min(...windowsOf().map((w) => w.rms))
    expect(quietest, 'the drone gapped').toBeGreaterThan(0.01)
  })

  it('and both of the things holding it up are still in the code', () => {
    // because the measurement above cannot see either one going missing alone
    expect([...r.code.matchAll(/dur: (\d+)/g)].map((m) => m[1]), 'both dur lines, each longer than its step').toEqual(['7', '11'])
    expect(r.code, 'a release measured in seconds').toMatch(/adsr [\d.]+ [\d.]+ [\d.]+ [4-9]/)
  })

  it('the arithmetic in `why` is the arithmetic in the code', () => {
    /* The claim is "924 cycles and not once before". That is lcm(4x7, 3x11),
     * and it is only true while the code says 7 and 11 -- a later tweak to
     * either number would leave the prose quietly wrong. */
    const steps = [...r.code.matchAll(/<([^>]+)>\/(\d+)/g)]
      .map((m) => [m[1]!.trim().split(/\s+/).length, Number(m[2])] as const)
    expect(steps.length, 'two figures').toBe(2)
    const periods = steps.map(([n, slow]) => n * slow)
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
    const lcm = periods[0]! * periods[1]! / gcd(periods[0]!, periods[1]!)
    expect(periods).toEqual([28, 33])
    expect(lcm).toBe(924)
    expect(r.why, 'the number in the prose').toContain('924')
  })
})

describe('the generative beat does what its title claims', () => {
  /* "Makes sound" would pass a loop. This recipe promises a bar that is never
   * the same twice AND still a beat, and those two pull against each other:
   * pure probability wanders into near-silence, which is why one voice is
   * certain. Both halves are measured here, because the second one is the part
   * that gets tuned away by accident. */
  const r = RECIPES.find((x) => x.id === 'generative-beat')!
  const CYCLES = 16

  const staged = (): { st: Extract<ReturnType<typeof stageCode>, { ok: true }>; cps: number } => {
    const c = compile(r.code)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(JSON.stringify(st.diagnostics))
    return { st, cps: st.cps ?? 0.5 }
  }

  /** Per voice: the note-on slot fingerprint of each cycle. */
  const fingerprints = (): Map<string, string[]> => {
    const { st, cps } = staged()
    const evs = runPatterns(st.patterns, { cycles: CYCLES, cps })
    const out = new Map<string, string[]>()
    for (const [name, list] of evs) {
      const byCycle = new Map<number, number[]>()
      for (const e of list as { time: number; type: string }[]) {
        if (e.type !== 'noteOn') continue
        const pos = e.time * cps // events are in SECONDS; the grid is in cycles
        const cyc = Math.floor(pos + 1e-6)
        const slot = Math.round((pos - cyc) * 16)
        if (!byCycle.has(cyc)) byCycle.set(cyc, [])
        byCycle.get(cyc)!.push(slot)
      }
      out.set(String(name), [...byCycle.keys()].sort((a, b) => a - b)
        .map((k) => byCycle.get(k)!.join(',')))
    }
    return out
  }

  it('NEVER THE SAME BAR TWICE for the probabilistic voices', () => {
    const fp = fingerprints()
    for (const voice of ['thud', 'tick', 'bowl']) {
      const bars = fp.get(voice) ?? []
      expect(bars.length, `${voice}: no bars`).toBeGreaterThan(10)
      const uniq = new Set(bars).size
      expect(uniq / bars.length, `${voice}: ${uniq}/${bars.length} bars differ`).toBeGreaterThan(0.75)
    }
  })

  it('and the surviving hits still land ON the grid, never between', () => {
    /* Probability chooses WHICH hits, not where they fall. A drop that shifted
     * timing would be a different (and much worse) recipe. */
    const { st, cps } = staged()
    const evs = runPatterns(st.patterns, { cycles: CYCLES, cps })
    for (const [, list] of evs) {
      for (const e of list as { time: number; type: string }[]) {
        if (e.type !== 'noteOn') continue
        const pos = e.time * cps
        const off = Math.abs(pos * 16 - Math.round(pos * 16))
        expect(off, `hit at cycle ${pos.toFixed(4)} is off the 16th grid`).toBeLessThan(0.01)
      }
    }
  })

  it('but ONE voice is certain, which is what keeps it a beat', () => {
    // the measured failure without it: a bar at a twentieth of the loudest
    const bars = fingerprints().get('pulse') ?? []
    expect(bars.length).toBe(CYCLES)
    expect(new Set(bars).size, 'the anchor must not be probabilistic').toBe(1)
  })

  it('so no second falls away to nothing', () => {
    const { st, cps } = staged()
    const SR = 11025
    const SECS = 48
    const evs = runPatterns(st.patterns, { cycles: Math.ceil(SECS * cps), cps })
    const mix = renderMix(st.synths, evs, SECS, mixOptsFor(st, { cps, sampleRate: SR }))
    expect(mix.normalized, 'the render had to turn it down: ships a level a reader would copy').toBe(false)
    const rms: number[] = []
    for (let a = 0; a + SR <= mix.left.length; a += SR) {
      let e = 0
      for (let i = a; i < a + SR; i++) e += mix.left[i]! * mix.left[i]!
      rms.push(Math.sqrt(e / SR))
    }
    const lo = Math.min(...rms)
    const hi = Math.max(...rms)
    expect(lo, `quietest second was ${lo.toFixed(4)} against ${hi.toFixed(4)}`).toBeGreaterThan(0.02)
  })
})

describe('the generative melody does what its title claims', () => {
  /* The third generative recipe, and deliberately the INVERSE of the beat one:
   * `generative-beat` randomises which hits survive and keeps the pitch fixed;
   * this randomises the pitch and writes the rhythm down. Both claims are
   * measured, because either one drifts away silently under editing. */
  const r = RECIPES.find((x) => x.id === 'generative-melody')!
  const CYCLES = 24

  const perBar = (): Map<string, { rhythms: Set<string>; pitches: Set<string> }> => {
    const c = compile(r.code)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(JSON.stringify(st.diagnostics))
    const cps = st.cps ?? 0.5
    const evs = runPatterns(st.patterns, { cycles: CYCLES, cps })
    const out = new Map<string, { rhythms: Set<string>; pitches: Set<string> }>()
    for (const [name, list] of evs) {
      const bars = new Map<number, { slots: number[]; notes: number[] }>()
      for (const e of list as { time: number; type: string; note: number }[]) {
        if (e.type !== 'noteOn') continue
        const pos = e.time * cps
        const cyc = Math.floor(pos + 1e-6)
        if (!bars.has(cyc)) bars.set(cyc, { slots: [], notes: [] })
        bars.get(cyc)!.slots.push(Math.round((pos - cyc) * 8))
        bars.get(cyc)!.notes.push(e.note)
      }
      const ks = [...bars.keys()].sort((a, b) => a - b)
      out.set(String(name), {
        rhythms: new Set(ks.map((k) => bars.get(k)!.slots.join(','))),
        pitches: new Set(ks.map((k) => bars.get(k)!.notes.join(','))),
      })
    }
    return out
  }

  it('the rhythm is a FIGURE you wrote, not just a constant one', () => {
    /* Constancy alone proves nothing, which the sabotage pass is what showed:
     * strip `struct` and `irand` plays flat eighths, so the rhythm is still
     * identical in every bar while sounding exactly like the machine the
     * recipe exists to avoid. What `struct` buys is that the figure has RESTS
     * in it, so both halves are asserted. */
    for (const voice of ['lead', 'echo']) {
      const v = perBar().get(voice)!
      expect(v.rhythms.size, `${voice}: the figure moved between bars`).toBe(1)
      const slots = [...v.rhythms][0]!.split(',').length
      expect(slots, `${voice}: every slot is filled, so this is a grid not a figure`).toBeLessThan(8)
    }
  })

  it('and the NOTES are different nearly every bar', () => {
    const lead = perBar().get('lead')!
    expect(lead.pitches.size, 'the melody repeated itself').toBeGreaterThan(CYCLES * 0.75)
  })

  it('no roll of the dice can produce a semitone clash', () => {
    /* The other half of the move. Measured while writing it: the same
     * generator on a 7-note scale gave nine minor 2nds over 24 bars, and the
     * pentatonic gave zero -- there is no semitone IN the scale, so random
     * degrees cannot find one. */
    const c = compile(r.code)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error('stage')
    const cps = st.cps ?? 0.5
    const evs = runPatterns(st.patterns, { cycles: CYCLES, cps })
    const notes = new Set<number>()
    for (const [, list] of evs) {
      for (const e of list as { type: string; note: number }[]) if (e.type === 'noteOn') notes.add(e.note)
    }
    const pcs = [...new Set([...notes].map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b)
    for (let i = 0; i < pcs.length; i++) {
      for (let j = i + 1; j < pcs.length; j++) {
        const d = Math.min(pcs[j]! - pcs[i]!, 12 - (pcs[j]! - pcs[i]!))
        expect(d, `pitch classes ${pcs[i]} and ${pcs[j]} are a semitone apart`).not.toBe(1)
      }
    }
    expect(pcs.length, 'a pentatonic, so five pitch classes').toBe(5)
  })

  it('sits at a level the render does not have to touch', () => {
    const c = compile(r.code)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error('stage')
    const cps = st.cps ?? 0.5
    const SECS = 48
    const evs = runPatterns(st.patterns, { cycles: Math.ceil(SECS * cps), cps })
    const mix = renderMix(st.synths, evs, SECS, mixOptsFor(st, { cps, sampleRate: 11025 }))
    expect(mix.normalized, 'ships a level a reader would copy').toBe(false)
    let peak = 0
    for (const v of mix.left) peak = Math.max(peak, Math.abs(v))
    expect(peak, `wastes headroom at ${peak.toFixed(3)}`).toBeGreaterThan(0.5)
  })
})

describe('the mic harmony recipe proves its own move', () => {
  /* A `mic` recipe is exempt from the "makes sound" check, because a test
   * process has no microphone: the generic guard renders it and asserts only
   * that nothing throws. That leaves the actual claim unchecked, and the claim
   * here is the whole recipe -- that the `iv:` lane moves the interval while a
   * note is held.
   *
   * So the mic is swapped for a known tone and the output measured. By ENERGY
   * at the expected frequency, not by autocorrelation: the first attempt used
   * autocorrelation and reported 110 Hz for a 330 Hz harmony, because 110 is
   * the common subharmonic of the shifted tone and the residual dry, and the
   * detector locked onto it. The recipe was right and the measurement was
   * wrong, which is the easier of the two to believe and the harder to notice.
   */
  const r = RECIPES.find((x) => x.id === 'mic-harmony')!

  /** Magnitude at `hz` over a window, by direct correlation. */
  const energyAt = (x: Float32Array, from: number, to: number, sr: number, hz: number): number => {
    let re = 0
    let im = 0
    for (let i = from; i < to; i++) {
      const t = (2 * Math.PI * hz * i) / sr
      re += x[i]! * Math.cos(t)
      im += x[i]! * Math.sin(t)
    }
    return Math.sqrt(re * re + im * im) / (to - from)
  }

  const render = (): { left: Float32Array; step: number; sr: number } => {
    // a known tone where the microphone would be, fully wet so the harmony
    // stands alone
    /* Target the pitchshift LINE, not the first `mix:.5` in the file: the
     * recipe explains itself in a comment one line above, and replacing that
     * left the shifter at half dry. Which is what a harmoniser is meant to do,
     * so the render looked wrong rather than the substitution. */
    const src = r.code
      .replace('  mic\n', '  saw 220\n')
      .replace(/^( *pitchshift .*)mix:\.5/m, '$1mix:1')
    const c = compile(src)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) throw new Error('compile')
    const st = stageCode(c.code)
    if (!st.ok) throw new Error(JSON.stringify(st.diagnostics))
    const cps = st.cps ?? 0.5
    const sr = 22050
    const evs = runPatterns(st.patterns, { cycles: 2, cps })
    const mix = renderMix(st.synths, evs, 2 / cps, mixOptsFor(st, { cps, sampleRate: sr }))
    return { left: mix.left, step: Math.floor(mix.left.length / 8), sr }
  }

  /** The strongest of the candidate pitches in step `k`. */
  const winner = (k: number, candidates: number[]): number => {
    const { left, step, sr } = render()
    const a = k * step + Math.floor(step * 0.4)
    const b = a + Math.floor(step * 0.3)
    let best = candidates[0]!
    let bestE = -1
    for (const hz of candidates) {
      const e = energyAt(left, a, b, sr, hz)
      if (e > bestE) { bestE = e; best = hz }
    }
    return best
  }

  const semis = (n: number): number => Math.round(220 * Math.pow(2, n / 12))

  it('shifts the voice up by the interval the lane asks for', () => {
    // the lane opens on 7 semitones: a fifth above 220 is 330
    expect(winner(0, [semis(7), semis(5), semis(3), semis(0)])).toBe(semis(7))
  })

  it('and MOVES when the lane does, which is the whole recipe', () => {
    /* Steps 2 and 3 of `<[7 7 5 5] …>` ask for 5, not 7. Before `semitones`
     * became a signal this was impossible: the interval was fixed at build
     * time and a lane on the play line was silently dropped. */
    expect(winner(2, [semis(7), semis(5), semis(3), semis(0)])).toBe(semis(5))
  })

  it('and the fifth is gone once the lane stops asking for it', () => {
    /* The pair that matters: the interval the lane names is present, and the
     * one it has moved OFF is not. Asserted against the other INTERVALS rather
     * than against the dry voice, which at the shipped `mix:.5` is meant to be
     * there and is what makes this a harmony rather than a transposition. */
    const { left, step, sr } = render()
    const at = (k: number, hz: number): number => {
      const a = k * step + Math.floor(step * 0.4)
      return energyAt(left, a, a + Math.floor(step * 0.3), sr, hz)
    }
    expect(at(0, semis(7)), 'a fifth on step 0').toBeGreaterThan(at(0, semis(5)) * 2)
    expect(at(2, semis(5)), 'a fourth on step 2').toBeGreaterThan(at(2, semis(7)) * 2)
  })
})
