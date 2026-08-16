import { describe, expect, it } from 'vitest'
import { compile } from '../../rondo/src/index'
import { quoteForTemplate, exampleModule } from '../scripts/pull-local'

/* ------------------------------------------------------------------------- *
 * Writing the running buffer back to a local example file.
 *
 * The generated module is a TEMPLATE LITERAL wrapping somebody's tune, and a
 * tune is arbitrary text: it can contain a backslash, a backtick, or `${`.
 * Miss one and the file either fails to parse or, far worse, silently
 * interpolates and writes a DIFFERENT tune than the one that was playing.
 *
 * So these do not check the escaping by eye. They EVALUATE the module text and
 * compare what comes back out against what went in, which is the only claim
 * that matters: what you pull is what you were playing.
 * ------------------------------------------------------------------------- */

const HEADER = '/* test */\n\n'

/** Evaluate the generated module and hand back its default export. */
const evalModule = (src: string): { name: string; code: string; rondo?: string } => {
  const body = src.replace(/^\/\*[\s\S]*?\*\/\s*/, '').replace('export default', 'return')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(body)() as { name: string; code: string; rondo?: string }
}

const RONDO = `synth pad
  saw note
  * adsr .01 .2 .6 .3

play pad
  0 3 5

cps .5
`

describe('quoteForTemplate', () => {
  it('survives every character that can escape a template literal', () => {
    // all three in one string, which is what a real tune looks like
    const nasty = 'a \\ backslash, a `backtick`, and ${an.interpolation}'
    const round = new Function(`return \`${quoteForTemplate(nasty)}\``)() as string
    expect(round).toBe(nasty)
  })

  it('does not interpolate, which is the failure that would be silent', () => {
    const src = 'gain ${1 + 1}'
    const round = new Function(`return \`${quoteForTemplate(src)}\``)() as string
    expect(round).toBe('gain ${1 + 1}')
    expect(round).not.toContain('gain 2')
  })
})

describe('exampleModule', () => {
  it('round-trips a rondo buffer: the file gives back the same source', () => {
    const mod = evalModule(exampleModule('demo', { text: RONDO, lang: 'rondo' }, HEADER))
    expect(mod.rondo).toBe(RONDO.trimEnd() + '\n')
    expect(mod.name).toBe('demo (local)')
  })

  it('the JS beside it is COMPILED from that rondo, not written twice', () => {
    const mod = evalModule(exampleModule('demo', { text: RONDO, lang: 'rondo' }, HEADER))
    const fresh = compile(mod.rondo!)
    expect(fresh.ok).toBe(true)
    expect(mod.code.trim()).toBe(fresh.ok ? fresh.code.trim() : '')
  })

  it('carries a tune whose COMMENTS contain template syntax', () => {
    // the real levels.ts hit this: a comment mentioning `'drop:1` in backticks
    const tricky = `# a \`backtick\` comment, a \\ backslash, and \${nope}\n${RONDO}`
    const mod = evalModule(exampleModule('demo', { text: tricky, lang: 'rondo' }, HEADER))
    expect(mod.rondo).toBe(tricky.trimEnd() + '\n')
  })

  it('a rondocode buffer is stored as-is, with no rondo twin invented for it', () => {
    const js = "const a = synth(({ saw, note }) => saw(note.freq))\np('a', note('c3'))\nsetCps(0.5)\n"
    const mod = evalModule(exampleModule('demo', { text: js, lang: 'rondocode' }, HEADER))
    expect(mod.code).toBe(js.trimEnd() + '\n')
    expect(mod.rondo).toBeUndefined()
  })

  it('refuses to write a buffer that does not compile', () => {
    // silently writing a broken example is how the file stops being loadable
    // at IMPORT time, which takes the whole example list down with it
    expect(() => exampleModule('demo', { text: 'synth\n  nope nope nope\n', lang: 'rondo' }, HEADER))
      .toThrow(/does not compile/)
  })
})
