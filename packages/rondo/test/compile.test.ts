import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'

/** unwrap a successful compile or fail loudly with the diagnostics. */
function ok(src: string): string {
  const r = compile(src)
  if (!r.ok) throw new Error('compile failed: ' + JSON.stringify(r.errors))
  return r.code
}

describe('rondo → rondocode codegen', () => {
  it('compiles a bare oscillator synth + degree pattern + cps', () => {
    const out = ok(`synth blip\n  saw\n\nplay blip\n  0 2 4 2\n\ncps .5\n`)
    expect(out).toContain('const blip = synth(({ note, saw }) => {')
    expect(out).toContain('return saw(note.freq)')
    expect(out).toContain("p('blip', n('0 2 4 2').sound('blip'))")
    expect(out).toContain('setCps(0.5)')
  })

  it('threads the audio spine: source, filter (running signal first), VCA', () => {
    const out = ok(`synth acid\n  saw + square note/2\n  ladder cutoff * env^2 res:.85\n  * env\n  env    = adsr .003 .2 .3 .1\n  cutoff = knob 800 80..8000 log\n`)
    // oscillator blend
    expect(out).toContain('saw(note.freq).add(square(note.freq.div(2)))')
    // filter takes the running signal as its first arg, cutoff*env^2 as second
    expect(out).toContain('ladder(saw(note.freq).add(square(note.freq.div(2))), cutoff.mul(env.pow(2)), { res: 0.85 })')
    // final VCA multiply by env
    expect(out).toContain('.mul(env)')
    // bindings emitted (decay + knob param)
    expect(out).toContain('const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })')
    expect(out).toContain("const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })")
    // destructure includes exactly what's used
    expect(out).toContain('synth(({ note, gate, param, adsr, ladder, saw, square }) =>')
  })

  it('expands short scale names and picks note() for note-name patterns', () => {
    expect(ok(`synth p\n  saw\n\nplay p\n  0 3 5  scale:c-maj\n`)).toContain(".scale('c major')")
    expect(ok(`synth p\n  saw\n\nplay p\n  c4 e4 g4\n`)).toContain("note('c4 e4 g4')")
  })

  it('topologically orders bindings so each const precedes its use', () => {
    const out = ok(`synth s\n  sine mod\n  mod = sine base\n  base = adsr .01 .1 .5 .1\n`)
    expect(out.indexOf('const base =')).toBeLessThan(out.indexOf('const mod ='))
  })

  it('reports a positioned error for an unknown top-level block', () => {
    const r = compile(`wobble foo\n  saw\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.line).toBe(1)
  })

  it('rejects a binding cycle', () => {
    const r = compile(`synth s\n  saw\n  a = b\n  b = a\n`)
    expect(r.ok).toBe(false)
  })

  it('compiles play modifier lines: ctrl signal sweep, every, gain', () => {
    const out = ok(
      `synth s\n  saw\n  cutoff = knob 800 80..8000\n\n` +
      `play s\n  0 2 4  scale:a-min\n  cutoff: sine 200..2400 slow:4\n  gain: .8\n  every 4: rev\n`,
    )
    expect(out).toContain(".ctrl('cutoff', sine.range(200, 2400).slow(4))")
    expect(out).toContain('.gain(0.8)')
    expect(out).toContain('.every(4, x => x.rev())')
  })

  it('reports notation spans whose offset exactly matches the source substring', () => {
    // this invariant is what lets note-play flash light the rondo buffer: a
    // mini-notation Loc is an offset into `content`, and content sits at
    // [from, from+len) in the source, so from+loc.start is the buffer position.
    const src = `synth s\n  saw\n\nplay s\n  0 3 5 7  scale:c-maj\n`
    const r = compile(src)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.notes).toHaveLength(1)
    const { content, from } = r.notes[0]!
    expect(content).toBe('0 3 5 7')
    expect(src.slice(from, from + content.length)).toBe(content)
  })

  it('js{ … } escape hatch: inline expression destructures the ctx it names', () => {
    const out = ok(`synth s\n  js{ saw(note.freq).tanh() }\n`)
    expect(out).toContain('return saw(note.freq).tanh()')
    expect(out).toContain('synth(({ note, saw }) =>')
  })

  it('js{ … } escape hatch: a top-level one-liner passes through verbatim', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3 5\n\njs{ sidechain('kick', { depth: 0.7 }) }\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.7 })")
  })

  it('js block is truly verbatim: `#` inside strings and nested indent survive', () => {
    // REGRESSION: body lines were taken from the comment-stripped lexer text,
    // so a '#' inside a JS string got truncated and nested indent flattened.
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3\n\njs\n  bus('space', ({ input, reverb }) => reverb(input), {\n    s: 0.4, // send #1 stays intact\n  })\n`)
    expect(out).toContain('// send #1 stays intact')
    expect(out).toContain('  s: 0.4,') // nested indent preserved relative to the block
  })

  it('js escape hatch: a `js` block emits its indented body verbatim', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3 5\n\njs\n  sidechain('kick', { depth: 0.6 })\n  masterCompress({ threshold: -6 })\n`)
    expect(out).toContain("sidechain('kick', { depth: 0.6 })")
    expect(out).toContain('masterCompress({ threshold: -6 })')
  })

  it('numeric-LHS arithmetic: folds constants, rewrites num−sig, rejects the rest', () => {
    // REGRESSION: `1 - env` emitted `1.sub(env)` — a JS SyntaxError
    const out = ok(`synth s\n  saw\n  * inv\n  inv = 1 - env\n  env = adsr .01 .1 .5 .1\n`)
    expect(out).toContain('env.mul(-1).add(1)')
    // number⊗number folds to a constant
    expect(ok(`synth s\n  saw\n  * g\n  g = 2 * 3\n`)).toContain('const g = 6')
    // num / sig and num ^ sig have no Sig form → positioned error, not garbage
    expect(compile(`synth s\n  saw\n  * x\n  x = 2 / env\n  env = adsr .01 .1 .5 .1\n`).ok).toBe(false)
  })

  it('`->` binds at statement level, not inside call arguments', () => {
    // REGRESSION: parsed as sine(2 -> 200..2000) → invalid `2.range(…)`
    const out = ok(`synth s\n  sine\n  * env\n  env = adsr .01 .1 .5 .1\n  lfo = sine 2 -> 200..2000\n`)
    expect(out).toContain('sine(2).range(200, 2000)')
  })

  it('rejects a duplicate binding instead of silently dropping the second', () => {
    const r = compile(`synth s\n  saw\n  * env\n  env = adsr .01 .1 .7 .2\n  env = adsr .5 .5 .5 .5\n`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]!.message).toContain('duplicate')
  })

  it('rejects a near-miss scale instead of shipping it inside the notation', () => {
    expect(compile(`synth s\n  saw\n\nplay s\n  0 3 5  scale:minor\n`).ok).toBe(false)
  })

  it('supports negative number literals (sign glued, space-preceded)', () => {
    const out = ok(`synth s\n  saw\n  * g\n  g = knob -6 -12..0\n`)
    expect(out).toContain("param('g', -6, { min: -12, max: 0 })")
    // subtraction still works, spaced or glued
    expect(ok(`synth s\n  saw\n  * x\n  x = env - 1\n  env = adsr .01 .1 .5 .1\n`)).toContain('env.sub(1)')
  })

  it('js{ … } one-liner survives a `#` inside a string', () => {
    // REGRESSION: comment stripping ran quote-blind and truncated the line
    const out = ok(`synth s\n  saw\n\nplay s\n  0 3\n\njs{ p('x', sound('bd # sn')) }\n`)
    expect(out).toContain("sound('bd # sn')")
  })

  it('routes bare combinators and a mini-string ctrl value', () => {
    const out = ok(`synth s\n  saw\n\nplay s\n  0 2 4\n  struct t ~ t t\n  fast 2\n  index: <1 2.5>\n`)
    expect(out).toContain(".struct(mini('t ~ t t'))")
    expect(out).toContain('.fast(2)')
    expect(out).toContain(".ctrl('index', '<1 2.5>')")
  })

  it('emits a post chain as the synth() second arg, with mix wet/dry sugar', () => {
    const out = ok(`synth pad\n  saw\n  * env\n  env = adsr .3 .5 .8 1\n  post\n    reverb room:.85 mix:.35\n`)
    // two-function synth(): voice then post (post ctx destructures `input`)
    expect(out).toContain('}, ({ input')
    // reverb is wet-only, so mix: blends it back over the dry input
    expect(out).toContain('input.mix(reverb(input, { roomSize: 0.85 }), 0.35)')
  })

  it('supports a drivable POST param (knob in post → param, driven by .ctrl)', () => {
    const out = ok(
      `synth pad\n  saw\n  post\n    reverb room:.85 mix:wet\n    wet = knob .35 0..0.7\n\n` +
      `play pad\n  0 3 5\n  wet: sine 0..0.7 slow:8\n`,
    )
    expect(out).toContain("const wet = param('wet', 0.35, { min: 0, max: 0.7 })")
    expect(out).toContain('input.mix(reverb(input, { roomSize: 0.85 }), wet)')
    expect(out).toContain(".ctrl('wet', sine.range(0, 0.7).slow(8))")
  })
})
