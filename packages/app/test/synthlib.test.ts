import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stageCode, runPatterns, renderMix } from '../../server/src/render-runner'
import { compile, decompile } from '@rondocode/rondo'
import { SYNTHS, presetFor } from '../src/editor/synthlib'
import { highlightFor } from '../src/docs/highlight'

/* Every preset in the synth library must EVAL and SOUND.
 *
 * These are the first thing a new user clicks, and a broken one is invisible
 * until someone tries it: the panel inserts the code and the track goes quiet.
 * Three of the six added here were wrong on the first attempt — a post chain
 * takes one ctx object rather than (input, ctx), width() takes its amount
 * positionally, and granular() takes the sample NAME as its second argument,
 * not a key in opts. None of that is caught by a typecheck of this file, since
 * the presets are strings. */

const src = readFileSync(join(__dirname, '../src/editor/synthlib.ts'), 'utf8')
const presets = [...src.matchAll(/name: '([a-z]+)',[\s\S]*?code: `([\s\S]*?)`,\n\s+demoTail: `([\s\S]*?)`,/g)]
  .map((m) => ({ name: m[1]!, code: m[2]!, tail: m[3]! }))

/** The demo samples the preview player loads, so a sampler preset is not
 *  silent for the wrong reason. */
const demoSamples = (sr: number) => {
  const pcm = new Float32Array(sr)
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5
  return { pad: { data: pcm, sampleRate: sr }, vox: { data: pcm, sampleRate: sr }, break: { data: pcm, sampleRate: sr } }
}

const unescape = (s: string): string => s.replace(/\\n/g, '\n').replace(/\\`/g, '`').replace(/\\\$\{/g, '${')

describe('the synth library', () => {
  it('found the presets to test (guards against the regex silently matching none)', () => {
    expect(presets.length).toBeGreaterThanOrEqual(18)
  })

  it.each(presets.map((p) => [p.name, p] as const))('%s evaluates and makes sound', (_name, p) => {
    const program = `${unescape(p.code)}\n${unescape(p.tail)}`
    const staged = stageCode(program)
    const errs = staged.ok ? [] : staged.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message)
    expect(errs, errs.join('; ')).toEqual([])
    if (!staged.ok) return

    const cps = staged.cps ?? 0.5
    const sr = 22050
    const events = runPatterns(staged.patterns, { cycles: 2, cps })
    expect([...events.values()].flat().length, 'demo produced no events').toBeGreaterThan(0)
    const mix = renderMix(staged.synths, events, 2 / cps, { cps, sampleRate: sr, samples: demoSamples(sr) })
    let peak = 0
    for (const v of mix.left) { const a = Math.abs(v); if (a > peak) peak = a }
    expect(peak, 'rendered silence').toBeGreaterThan(0.001)
    for (const v of mix.left) expect(Number.isFinite(v)).toBe(true)
  })

  it('every preset inserts a synth whose name matches its entry', () => {
    // the panel inserts `code` at the cursor; a mismatched const name would
    // leave the demo's .sound() pointing at nothing
    for (const p of presets) {
      expect(unescape(p.code), p.name).toMatch(new RegExp(`const ${p.name}\\s*=\\s*synth\\(`))
    }
  })
})

describe('a rondo project gets rondo', () => {
  /* The panel used to insert JavaScript whatever the project was written in,
   * so a rondo user got a block of the other dialect sitting in their file as
   * a syntax error. Every preset must therefore have a rondo form that
   * COMPILES — hand-written where the terse version is worth reading, and
   * decompiled otherwise (which is always valid, if sometimes wrapped in
   * `js{ … }`). */

  /** Each preset's own source block, bounded by the next entry — searching
   *  from a name to the first `rondo:` would find a LATER preset's twin. */
  const blockOf = (name: string): string => {
    const start = src.indexOf(`name: '${name}',`)
    const next = src.indexOf("\n  {\n    name: '", start)
    return src.slice(start, next === -1 ? undefined : next)
  }

  it.each(presets.map((p) => [p.name, p] as const))('%s has a rondo form that compiles', (name, p) => {
    const block = blockOf(name)
    const hand = /rondo: `([\s\S]*?)`,\n/.exec(block)
    const rondo = hand !== null ? unescape(hand[1]!) : decompile(unescape(p.code))
    const c = compile(rondo)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    expect(c.code).toMatch(new RegExp(`const ${name}\\s*=\\s*synth\\(`))
  })

  it('presetFor hands JS to a JS project and rondo to a rondo one', () => {
    const sy = { code: 'const x = 1', rondo: 'synth x\n  saw' }
    expect(presetFor(sy, 'rondocode')).toBe('const x = 1')
    expect(presetFor(sy, 'rondo')).toBe('synth x\n  saw')
  })

  it('falls back to decompiling when no twin is written', () => {
    const js = "const p = synth(({ saw, note }) => saw(note.freq))"
    const out = presetFor({ code: js }, 'rondo')
    expect(out).not.toBe(js)
    expect(compile(out).ok).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * The card must show what INSERT will hand you.
 *
 * It rendered `sy.code` unconditionally, so a rondo project previewed every
 * preset in a dialect it would never receive — while presetFor, right beside
 * it, already knew the answer.
 * ------------------------------------------------------------------------- */
describe('the preview matches the insert, in both languages', () => {
  it('previews rondo for a rondo project and JS for a JS one', () => {
    for (const sy of SYNTHS) {
      expect(highlightFor('rondo')(presetFor(sy, 'rondo'))).toContain('synth')
      // the JS form is the one with a paren-call; the rondo form never is
      expect(presetFor(sy, 'js')).toBe(sy.code)
    }
  })

  it('has a readable rondo form for EVERY preset, hand-written or decompiled', () => {
    // seven presets have no hand-written rondo. That is fine only while the
    // decompiler produces something worth reading — a `js{ … }` blob on a
    // library card is a preset you cannot learn from.
    for (const sy of SYNTHS) {
      const r = presetFor(sy, 'rondo')
      expect(r, `${sy.name} decompiled to a js{} blob`).not.toContain('js{')
      expect(r, `${sy.name} is not rondo`).toMatch(/^synth /)
    }
  })

  it('colours rondo with rondo words, not JavaScript ones', () => {
    // `const`/`return` are JS keywords and must not light up; `synth`/`ladder`
    // must, and they come from the tokenizer's own list
    const html = highlightFor('rondo')('synth a\n  ladder 900 res:.4  # a comment\n')
    expect(html).toContain('<span class="tok-kw">synth</span>')
    expect(html).toContain('<span class="tok-fn">ladder</span>') // a builtin, not a block word
    expect(html).toContain('<span class="tok-com"># a comment</span>')
    expect(html).toContain('<span class="tok-num">900</span>')
  })

  it('treats # as the comment marker, not //', () => {
    expect(highlightFor('rondo')('# hi')).toContain('tok-com')
    expect(highlightFor('js')('// hi')).toContain('tok-com')
    // a rondo doc has no strings to find, so a bare word stays a bare word
    expect(highlightFor('rondo')('0 3 5 7')).not.toContain('tok-str')
  })

  it('escapes before it colours, in both languages', () => {
    for (const lang of ['rondo', 'js']) {
      expect(highlightFor(lang)('<script>')).not.toContain('<script>')
      expect(highlightFor(lang)('<script>')).toContain('&lt;script&gt;')
    }
  })
})

/* A PRESET WITH TWO FORMS MUST BE ONE INSTRUMENT.
 *
 * The tests above prove each form compiles and makes sound. They do not prove
 * the JS and its rondo twin AGREE, and the crash preset did not: measured side
 * by side it came out mono and near-silent in JS while the rondo twin was wide
 * and rang for half a second. Nothing failed, because both "made sound".
 *
 * Two effects are the reason, and both are easy to get wrong again:
 *   - `chorus` runs per stereo side only in a POST chain; inside synth() it is
 *     mono, so all the width silently disappears.
 *   - `reverb` returns the WET TAIL ONLY. Returning it directly throws the dry
 *     signal away.
 *
 * Both forms run through the SAME demo — the rondo twin is compiled to JS
 * first — so this compares the instruments and not the patterns. `noise` is
 * stochastic, so the comparison is statistical rather than sample-for-sample:
 * loudness and stereo image, which are exactly what the crash bug moved. */
describe('a preset and its rondo twin are the same instrument', () => {
  /* Split into ENTRY BLOCKS first, then read the fields out of each. One big
   * regex cannot do this: a preset with no twin (hat, sub, pluck…) matched its
   * own name and then ran past its demoTail into a LATER entry to find a
   * `rondo:`, so the test compared one preset's JS against another's rondo and
   * blamed the wrong name. */
  const twins = src
    .split(/\n  \{\n(?=\s+name: ')/)
    .map((block) => {
      const name = /^\s+name: '([a-z_]+)',/m.exec(block)?.[1]
      const js = /\n\s+code: `([\s\S]*?)`,\n/.exec(block)?.[1]
      const tail = /\n\s+demoTail: `([\s\S]*?)`,\n/.exec(block)?.[1]
      const rondo = /\n\s+rondo: `([\s\S]*?)`,\n/.exec(block)?.[1]
      return name && js && tail && rondo
        ? { name, js: unescape(js), tail: unescape(tail), rondo: unescape(rondo) }
        : null
    })
    .filter((t): t is { name: string; js: string; tail: string; rondo: string } => t !== null)

  it('found the twinned presets', () => {
    expect(twins.length).toBeGreaterThanOrEqual(10)
  })

  const measure = (program: string): { rms: number; corr: number } | null => {
    const staged = stageCode(program)
    if (!staged.ok) return null
    const cps = staged.cps ?? 0.5
    const sr = 22050
    const mix = renderMix(staged.synths, runPatterns(staged.patterns, { cycles: 2, cps }), 2 / cps, {
      cps, sampleRate: sr, samples: demoSamples(sr),
    })
    let s = 0, ll = 0, rr = 0, lr = 0
    for (let i = 0; i < mix.left.length; i++) {
      const l = mix.left[i]!, r = mix.right[i]!
      s += l * l; ll += l * l; rr += r * r; lr += l * r
    }
    return { rms: Math.sqrt(s / mix.left.length), corr: lr / (Math.sqrt(ll * rr) || 1e-9) }
  }

  it.each(twins.map((t) => [t.name, t] as const))('%s: both forms sound alike', (_name, t) => {
    const c = compile(`${t.rondo}\n\nplay ${t.name}\n  c3\n\ncps .5\n`)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const a = measure(`${t.js}\n${t.tail}`)
    const b = measure(`${c.code}\n${t.tail}`)
    expect(a, 'the JS form did not stage').not.toBeNull()
    expect(b, 'the rondo twin did not stage').not.toBeNull()
    if (a === null || b === null) return

    // NEITHER may be silent while the other sounds — the crash failure exactly
    expect(a.rms, 'JS form is silent').toBeGreaterThan(1e-4)
    expect(b.rms, 'rondo twin is silent').toBeGreaterThan(1e-4)

    // Loudness within 8x. Wide on purpose: `noise` is stochastic and the two
    // forms round differently, and a tripwire that flaps is worse than none.
    // The crash was ~1e8 apart, so this still catches the failure it exists for.
    const ratio = Math.max(a.rms, b.rms) / Math.min(a.rms, b.rms)
    expect(ratio, `loudness differs ${ratio.toFixed(1)}x`).toBeLessThan(5)

    // STEREO IMAGE, which is where the crash actually diverged: one form mono
    // at 1.000 while the other was 0.687. Nothing else here would notice.
    /* 0.15, and the number is load-bearing. Measured across the shelf the
     * honest pairs sit at 0.052 and below; the crash bug moved this by 0.304.
     * The first version of this test allowed 0.4 — above the failure it was
     * written to catch — and went green on it. Two presets forced that: `lead`
     * and `snare` were not translations of their JS at all but different
     * synths, so no threshold could have separated a defect from the fixture
     * until they were fixed. */
    expect(Math.abs(a.corr - b.corr), `stereo image differs (${a.corr.toFixed(3)} vs ${b.corr.toFixed(3)})`).toBeLessThan(0.15)
  })
})
