import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { decompile } from '../src/decompile'
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'

/* ------------------------------------------------------------------------- *
 * `macro NAME DEF lo..hi curve` — one control across the whole project.
 *
 * The thing worth pinning is that the ratios need NO syntax: a macro name is
 * an ordinary value in any expression, so `bright * 0.5` and
 * `0.6 - bright / 7300 * 0.55` are the existing binding grammar doing its job.
 * ------------------------------------------------------------------------- */

const ok = (src: string): string => {
  const c = compile(src)
  expect(c.ok, JSON.stringify(c.errors)).toBe(true)
  return c.ok ? c.code : ''
}

const SRC = `macro bright 1480 500..7300 log

synth lead
  saw note
  svf bright res:.3
  * env
  env = adsr .003 .2 .3 .1

synth pad
  saw note
  svf bright * 0.5 res:.2
  * env
  env = adsr .4 .5 .7 .8
  post
    delay .25 fb sync:1
    fb = 0.6 - bright / 7300 * 0.55

play lead
  0 3 5 7  scale:a-min

play pad
  0  scale:a-min
`

describe('macro: the declaration', () => {
  it('compiles to a macro() call carrying the range and curve', () => {
    expect(ok('macro bright 1480 500..7300 log')).toContain(
      `macro('bright', 1480, { min: 500, max: 7300, curve: 'log' })`,
    )
  })

  it('the range is optional — the engine’s param defaults apply without it', () => {
    expect(ok('macro drive 2')).toContain(`macro('drive', 2)`)
  })

  it('hoists above the synths, because param() resolves while synth() compiles', () => {
    const code = ok(`synth lead\n  saw note\n  * amt\n  amt = 1\n\nmacro amt2 1 0..2\n`)
    expect(code.indexOf('macro(')).toBeLessThan(code.indexOf('const lead'))
  })

  it('refuses a name that would collide with a builtin', () => {
    const c = compile('macro saw 1 0..2')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]!.message).toMatch(/collides with the builtin/)
  })

  it('reports a missing default at the macro line, not somewhere downstream', () => {
    const c = compile('macro bright\n')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]!.message).toMatch(/needs a default value/)
  })
})

describe('macro: references', () => {
  it('a bare reference becomes param() with no default — one set of numbers', () => {
    const code = ok(SRC)
    // once per chain that uses it, and never with a default of its own
    expect([...code.matchAll(/const bright = param\('bright'\)/g)]).toHaveLength(3)
    expect(code).not.toMatch(/param\('bright', /)
  })

  it('drives several destinations at DIFFERENT ratios, with no macro syntax', () => {
    const code = ok(SRC)
    expect(code).toContain('svf(saw(note.freq), bright, { res: 0.3 })')       // 1:1
    expect(code).toContain('svf(saw(note.freq), bright.mul(0.5), { res: 0.2 })') // half
    expect(code).toContain('bright.div(7300).mul(0.55).mul(-1).add(0.6)')     // inverted
  })

  it('reaches a post chain, which is where a synth’s effects live', () => {
    const code = ok(SRC)
    const post = code.slice(code.indexOf('({ input'))
    expect(post).toContain(`const bright = param('bright')`)
  })

  it('a LOCAL binding of the same name wins — ordinary scoping', () => {
    const code = ok('macro bright 1000 0..2000\n\nsynth lead\n  saw note\n  * bright\n  bright = 0.5\n')
    expect(code).toContain('const bright = 0.5')
    expect(code).not.toContain(`param('bright')`)
  })

  it('a macro in a BUS is an error, since a bus can never change', () => {
    const c = compile('macro air 0.5 0..1\n\nbus verb\n  reverb\n  * amt\n  amt = air * 0.5\n')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.errors[0]!.message).toMatch(/a bus has no notes or .ctrl route/)
  })
})

describe('macro: end to end', () => {
  it('evals clean, and every synth declares the macro’s range', () => {
    const result = evalCode(ok(SRC), baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    for (const name of ['lead', 'pad']) {
      const p = result.synths.get(name)!.graph.params.find((x) => x.name === 'bright')!
      expect(p).toMatchObject({ default: 1480, min: 500, max: 7300, curve: 'log', macro: true })
    }
    // and the pad's POST chain has it too
    expect(result.synths.get('pad')!.post!.params[0]).toMatchObject({ name: 'bright', macro: true })
  })
})

describe('macro: decompile round-trips', () => {
  it('JS → rondo → JS is a fixed point, macro line and references alike', () => {
    const code = ok(SRC)
    const back = decompile(code)
    expect(back).toContain('macro bright 1480 500..7300 log')
    // the reference has NO binding line: the bare name in the spine is it
    expect(back).not.toContain('bright = param')
    expect(back).toContain('svf bright * 0.5')
    expect(ok(back)).toBe(code)
  })

  it('a range-less macro round-trips too', () => {
    const code = ok('macro drive 2\n\nsynth lead\n  saw note\n  * drive\n')
    expect(decompile(code)).toContain('macro drive 2')
    expect(ok(decompile(code))).toBe(code)
  })

  it('a local under a different name is RENAMED to its param, not bailed on', () => {
    // `const b = param('bright')` has no rondo spelling as `b`: in rondo the
    // binding name IS the param name. Renaming the local to `bright` says the
    // same thing, so this converts instead of falling back to a js block.
    const js = [
      `macro('bright', 1000, { min: 0, max: 2000 })`,
      `const lead = synth(({ note, saw, param }) => {`,
      `  const b = param('bright')`,
      `  return saw(note.freq).mul(b)`,
      `})`,
    ].join('\n')
    const back = decompile(js)
    expect(back, 'no js escape hatch left').not.toContain('js')
    expect(back).toContain('macro bright 1000 0..2000')
    // a macro reference needs no binding line at all — the bare name is it
    expect(back).toContain('* bright')
    // and it is the SAME program: the local is back, under the param's name
    expect(ok(back)).toContain("const bright = param('bright')")
    expect(ok(back)).toContain('saw(note.freq).mul(bright)')
  })

  it('a rename that would collide is left alone', () => {
    // `cut` is already a binding here, so renaming `c` to `cut` would merge
    // two different values into one name. The synth keeps its js block.
    const js = [
      `const lead = synth(({ note, saw, svf, param }) => {`,
      `  const cut = param('cut', 800, { min: 100, max: 9000 })`,
      `  const c = param('cut')`,
      `  return svf(saw(note.freq), cut).mul(c)`,
      `})`,
    ].join('\n')
    expect(decompile(js)).toContain('js')
  })
})
