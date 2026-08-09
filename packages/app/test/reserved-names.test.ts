import { describe, expect, it } from 'vitest'
import { RESERVED_TOP_LEVEL, compile } from '@rondocode/rondo'
import { stageCode } from '../../server/src/render-runner'
import { baseScope } from '../src/session/scope'
import { STAGING_NAMES } from '../src/session/evalCode'

/* ------------------------------------------------------------------------- *
 * `synth lead` compiles to `const lead = synth(…)` in a scope where the
 * pattern functions already live. So `synth note` produced
 *
 *     Identifier 'note' has already been declared
 *
 * with no line, no column, and no mention of the word that caused it. Nine
 * names did this and `synth note` is a thing anyone would type.
 *
 * rondo now says so itself, which needs the list of scope names — and rondo
 * cannot import it, because app depends on rondo and not the reverse. So
 * RESERVED_TOP_LEVEL is a COPY, and this file is what makes a copy safe: it
 * fails the moment app adds a scope name rondo does not know about.
 * ------------------------------------------------------------------------- */

/** Every identifier a staged program already has in scope. */
const inScope = (): string[] =>
  [...new Set([...Object.keys(baseScope), ...STAGING_NAMES])].filter((n) => !n.startsWith('__'))

describe('rondo knows every name a synth would collide with', () => {
  it('covers the whole live scope', () => {
    const missing = inScope().filter((n) => !RESERVED_TOP_LEVEL.has(n))
    expect(
      missing,
      `these names exist in the live scope but rondo does not reserve them, so `
        + `\`synth <name>\` will still die with a raw JS redeclaration: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('does not reserve names that are NOT in scope', () => {
    // an over-long list would refuse perfectly good synth names forever
    const scope = new Set(inScope())
    const extra = [...RESERVED_TOP_LEVEL].filter((n) => !scope.has(n))
    expect(extra, `reserved for no reason: ${extra.join(', ')}`).toEqual([])
  })

  it('there is actually something in it', () => {
    expect(RESERVED_TOP_LEVEL.size).toBeGreaterThan(40)
  })
})

describe('a colliding synth name is a rondo error, not a JS crash', () => {
  const program = (name: string): string =>
    `synth ${name}\n  saw note\n\nplay ${name}\n  c3\n\ncps .5`

  for (const name of ['note', 'p', 'n', 'chord', 'sound', 'sine', 'stack', 'bus']) {
    it(`synth ${name}`, () => {
      const c = compile(program(name))
      expect(c.ok, `\`synth ${name}\` compiled — it will crash at eval instead`).toBe(false)
      const err = c.errors[0]!
      expect(err.line, 'the error has no line number').toBe(1)
      expect(err.message).toContain(name)
      expect(err.message.toLowerCase()).toContain('built-in')
    })
  }

  it('and an ordinary name is still fine', () => {
    for (const name of ['lead', 'pad', 'wah', 'kick2', 'my_synth']) {
      expect(compile(program(name)).ok, `\`synth ${name}\` was rejected`).toBe(true)
    }
  })

  it('the JS these guard against really would have crashed', () => {
    /* The control. Without it this file could pass while the underlying
     * collision had quietly stopped being a problem, and the reservation
     * would be pure superstition. */
    const st = stageCode(`const note = synth(({ saw }) => saw(220))\np('note', n('0').sound('note'))`)
    expect(st.ok, 'a colliding const no longer crashes — the reservation may be obsolete').toBe(false)
  })
})
