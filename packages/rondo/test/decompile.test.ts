import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'

/* The decompiler's contract:
 * 1. ROUND-TRIP — for real rondo programs: compile → decompile → compile
 *    again yields the SAME JavaScript (semantics + sugar both survive).
 * 2. TOTALITY — arbitrary JS decompiles to something that compiles back to
 *    equivalent code, with unrecognized statements wrapped verbatim in js
 *    blocks (never lost, never mangled). */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const EXAMPLES = ['acid', 'pad', 'wob', 'club', 'drums', 'poly'].map((name) => ({
  name,
  src: read(`../examples/${name}.rondo`),
}))

describe('decompile round-trips', () => {
  it('env/eq/vocoder sugar survives the round trip', () => {
    const src = [
      'synth talk',
      '  supersaw detune:.4',
      '  vocoder m bands:20 response:0.02',
      '  eq hp 170 peak 300 -3 2 highshelf 7000 4',
      '  * e',
      '  m = noise',
      '  e = env 0.005 1 0.15 0.4 0.5 0.6 release:0.3 curve:3 loop:1',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('beat blocks and irand notation survive the round trip', () => {
    const src = [
      'synth kick',
      '  sine 55',
      '  * env',
      '  env = adsr 0.001 0.12 0 0.05',
      '',
      'beat',
      '  kick ~ kick ~',
      '  every 4: rev',
      '',
      'beat fills',
      '  ~ kick ~ kick',
      '',
      'play kick',
      '  irand 4 seg:8',
      '  scale: e-min',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('beat\n')
    expect(rondo2).toContain('beat fills')
    expect(rondo2).toContain('irand 4 seg:8')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('beat velocity suffixes survive the round trip (flat rows zip back)', () => {
    const src = 'beat\n  kick ~ kick:0.6 ~\n  ~ hat:0.3 ~ hat\n'
    const first = compile(src)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('kick ~ kick:0.6 ~')
    expect(rondo2).toContain('~ hat:0.3 ~ hat')
    const second = compile(rondo2)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.code).toBe(first.code)
    // a STRUCTURED gain bails to a js block — totality holds
    const rich = compile('beat\n  [hat:0.9 hat]*2 ~\n')
    expect(rich.ok, JSON.stringify(rich.ok ? [] : rich.errors)).toBe(true)
    if (!rich.ok) return
    const d2 = decompile(rich.code)
    expect(d2).toContain('js\n')
    const back = compile(d2)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toBe(rich.code)
  })

  it('sing blocks survive the round trip (pairs come back as one joined pair)', () => {
    const src = [
      'sing vox voice:barbara',
      '  twin-kle twin-kle lit-tle star',
      '  c4 c4 g4 g4 a4 a4 g4@2',
      '  how I won-der what you are',
      '  f4 f4 e4 e4 d4 d4 c4@2',
      '  gain: .95',
      '  post',
      '    reverb room:.8 mix:.25',
      '',
    ].join('\n')
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('sing vox voice:barbara')
    expect(rondo2).toContain('twin-kle twin-kle lit-tle star how I won-der what you are')
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) return
    expect(second.code).toBe(first.code)
  })

  it('a sing() without opts.name bails to a js block (hash-named vocal — totality holds)', () => {
    const js = "p('vox', sing('barbara', 'la la', 'c4 e4'))\n"
    const r = decompile(js)
    expect(r).toContain('js\n')
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain("sing('barbara', 'la la', 'c4 e4')")
  })

  it('a channel routed to a different synth round-trips via play synth:', () => {
    const src = 'synth keys\n  saw\n\nplay pad synth:keys\n  <Dm7 G7>\n  dur: 0.95\n'
    const first = compile(src)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const rondo2 = decompile(first.code)
    expect(rondo2).toContain('play pad synth:keys')
    const second = compile(rondo2)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.code).toBe(first.code)
  })

  for (const { name, src } of EXAMPLES) {
    it(`${name}.rondo: compile → decompile → compile is a fixed point`, () => {
      const first = compile(src)
      expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
      if (!first.ok) return
      const rondo2 = decompile(first.code)
      const second = compile(rondo2)
      expect(second.ok, `${name} re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
      if (!second.ok) return
      expect(second.code).toBe(first.code)
    })
  }
})

describe('decompile round-trips (audit additions)', () => {
  /** compile → decompile → compile must be byte-identical. */
  function fixedPoint(src: string): { rondo2: string; code: string } {
    const first = compile(src)
    expect(first.ok, JSON.stringify(first.ok ? [] : first.errors)).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    const rondo2 = decompile(first.code)
    const second = compile(rondo2)
    expect(second.ok, `re-compile: ${JSON.stringify(second.ok ? [] : second.errors)}\n--- decompiled ---\n${rondo2}`).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.code).toBe(first.code)
    return { rondo2, code: first.code }
  }

  it('visual blocks survive the round trip (WGSL verbatim)', () => {
    const { rondo2 } = fixedPoint(
      'synth s\n  saw\n\nplay s\n  0\n\nvisual\n  fn render(uv: vec2f) -> vec4f {\n    return vec4f(uv, 0.0, 1.0);\n  }\n',
    )
    expect(rondo2).toContain('visual\n')
    expect(rondo2).toContain('  fn render(uv: vec2f) -> vec4f {')
    expect(rondo2).toContain('    return vec4f(uv, 0.0, 1.0);') // nested indent kept
  })

  it('fast: ctrl values and pan: method modifiers round-trip', () => {
    const { rondo2 } = fixedPoint(
      'synth s\n  saw\n\nplay s\n  0 2\n  cutoff: sine 200..2400 fast:2\n  pan: sine slow:4\n',
    )
    expect(rondo2).toContain('cutoff: sine 200..2400 fast:2')
    expect(rondo2).toContain('pan: sine slow:4')
  })

  it('sing modifiers beyond gain round-trip: ctrl, dur, fn-comb', () => {
    const { rondo2 } = fixedPoint('sing v\n  la la\n  c4 e4\n  air: .3\n  dur: .9\n  every 2: rev\n')
    expect(rondo2).toContain('air: 0.3')
    expect(rondo2).toContain('dur: 0.9')
    expect(rondo2).toContain('every 2: rev')
  })

  it('a bare `master` line round-trips through masterCompress()', () => {
    const { rondo2 } = fixedPoint('synth s\n  saw\n\nplay s\n  0\n\nmaster\n')
    expect(rondo2).toContain('\nmaster\n')
  })
})

describe('decompile cosmetics', () => {
  it('emits SHORT scale names (a-min, not a-minor)', () => {
    // REGRESSION: SCALE_MODE's identity entries (minor→minor) overwrote the
    // short forms when inverted, so decompile emitted `scale: a-minor`
    const r = compile('synth s1\n  saw\n\nplay s1\n  0 3 5  scale:a-min\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(decompile(r.code)).toContain('scale: a-min\n')
  })
})

describe('decompile totality', () => {
  it('wraps unrecognized statements verbatim in js blocks', () => {
    const js = `const weird = [1, 2, 3].map((x) => x * 2)\nconsole.log(weird)\n\nsetCps(0.5)\n`
    const r = decompile(js)
    expect(r).toContain('js\n')
    expect(r).toContain('const weird = [1, 2, 3].map((x) => x * 2)')
    expect(r).toContain('cps 0.5')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) {
      expect(c.code).toContain('const weird = [1, 2, 3].map((x) => x * 2)')
      expect(c.code).toContain('setCps(0.5)')
    }
  })

  it('a JS binding reusing a builtin name (const delay) still decompiles — JS scoping guarantees the builtin is unused', () => {
    const js = `const ok = synth(({ note, gate, adsr, saw }) => {
  const delay = adsr(gate, { a: 0.1, d: 0.1, s: 0.5, r: 0.1 })
  return saw(note.freq).mul(delay)
})
`
    const r = decompile(js)
    expect(r).toContain('delay = adsr 0.1 0.1 0.5 0.1')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) expect(() => new Function(c.code)).not.toThrow()
  })

  it('bails a synth whose binding name is a reserved special ref', () => {
    // `const knob = 2` is fine in JS, but a rondo binding named `knob`
    // shadows the grammar's own keyword — the synth must stay a js block
    // instead of round-tripping into a compile error.
    const js = `const bad = synth(({ note, saw }) => {
  const knob = 2
  return saw(note.freq).mul(knob)
})
`
    const r = decompile(js)
    expect(r).toContain('js\n')
    const c = compile(r)
    expect(c.ok).toBe(true)
    if (c.ok) expect(() => new Function(c.code)).not.toThrow()
  })

  it('non-JS input comes back wrapped, not lost', () => {
    const r = decompile('this is not (valid js')
    expect(r).toContain('js\n')
    expect(r).toContain('this is not (valid js')
  })

  it('a hand-written JS synth with an inexpressible chain falls back per-expression', () => {
    // a.add(b).mul(c) is left-assoc — rondo infix would re-associate it, so
    // the decompiler must NOT sugar it into `a + b * c`
    const js = `const x = synth(({ note, gate, adsr, sine, saw }) => {
  const env = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.1 })
  return sine(note.freq).add(saw(note.freq)).mul(env)
})

p('x', n('0 3').scale('c major').sound('x'))

setCps(0.5)
`
    const r = decompile(js)
    const c = compile(r)
    expect(c.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!c.ok) return
    // pipeline peeling makes this expressible: `* env` line over `sine + saw`
    expect(r).toContain('play x')
    expect(r).toContain('scale: c-maj')
  })

  it('an orphan __sec_ const (no matching arrange) is restored as a js block', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n"
    const r = decompile(js)
    expect(r).toContain('js\n')
    expect(r).toContain("const __sec_a = n('0 3').scale('c major').sound('s1')")
    expect(r).not.toContain('section') // never a half-formed section block
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain('__sec_a')
  })

  it('an arrange referencing an unknown section bails BOTH statements to js blocks', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n\np('song', arrange([4, __sec_a], [2, __sec_b]))\n"
    const r = decompile(js)
    expect(r).not.toContain('section a')
    expect(r).not.toContain('song ')
    expect(r).toContain("const __sec_a = n('0 3').scale('c major').sound('s1')")
    expect(r).toContain("p('song', arrange([4, __sec_a], [2, __sec_b]))")
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) {
      expect(back.code).toContain("p('song', arrange([4, __sec_a], [2, __sec_b]))")
    }
  })

  it('an arrange with INCONSISTENT lens for one section bails to js blocks', () => {
    const js = "const __sec_a = n('0 3').scale('c major').sound('s1')\n\np('song', arrange([4, __sec_a], [8, __sec_a]))\n"
    const r = decompile(js)
    expect(r).not.toContain('section a')
    expect(r).toContain("p('song', arrange([4, __sec_a], [8, __sec_a]))")
    const back = compile(r)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.code).toContain('arrange([4, __sec_a], [8, __sec_a])')
  })

  it('an inexpressible binding RHS falls back to an inline js{ … }', () => {
    const js = 'const x = synth(({ note, saw }) => {\n  const amt = Math.min(0.5, 0.9)\n  return saw(note.freq).mul(amt)\n})\n'
    const r = decompile(js)
    expect(r).toContain('amt = js{ Math.min(0.5, 0.9) }')
    const back = compile(r)
    expect(back.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!back.ok) return
    expect(back.code).toContain('const amt = Math.min(0.5, 0.9)')
    // and the recompile is a fixed point from here on
    const again = compile(decompile(back.code))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.code).toBe(back.code)
  })

  it('decompiles a play chain with ctrls, fn combinators, and struct', () => {
    const js = `const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.1 })))

p('s', n('0 2 4').scale('a minor').sound('s').ctrl('cutoff', sine.range(200, 2400).slow(4)).gain(0.8).every(4, x => x.rev()).struct(mini('~ t ~ t')))
`
    const r = decompile(js)
    expect(r).toContain('cutoff: sine 200..2400 slow:4')
    expect(r).toContain('gain: 0.8')
    expect(r).toContain('every 4: rev')
    expect(r).toContain('struct ~ t ~ t')
    // and the decompiled rondo COMPILES, reaching a fixed point: hand-written
    // JS normalizes on the first recompile, and from there decompile → compile
    // is byte-identical
    const back = compile(r)
    expect(back.ok, `--- decompiled ---\n${r}`).toBe(true)
    if (!back.ok) return
    expect(back.code).toContain(".ctrl('cutoff', sine.range(200, 2400).slow(4))")
    const again = compile(decompile(back.code))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.code).toBe(back.code)
  })
})
