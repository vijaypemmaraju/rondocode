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

const EXAMPLES = ['acid', 'pad', 'wob', 'club', 'drums'].map((name) => ({
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

  it('decompiles a play chain with ctrls, fn combinators, and struct', () => {
    const js = `const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.1 })))

p('s', n('0 2 4').scale('a minor').sound('s').ctrl('cutoff', sine.range(200, 2400).slow(4)).gain(0.8).every(4, x => x.rev()).struct(mini('~ t ~ t')))
`
    const r = decompile(js)
    expect(r).toContain('cutoff: sine 200..2400 slow:4')
    expect(r).toContain('gain: 0.8')
    expect(r).toContain('every 4: rev')
    expect(r).toContain('struct ~ t ~ t')
  })
})
