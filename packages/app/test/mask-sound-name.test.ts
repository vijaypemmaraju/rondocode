import { describe, expect, it } from 'vitest'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { MASK_SOUND } from '../src/mask/protocol'
import { EXTERNAL_OUTPUTS } from '../src/session/Session'

/* ------------------------------------------------------------------------- *
 * THE SOUND NAME `mask` IS TAKEN. A pattern routed to it goes to the LED mask
 * and the session never turns its events into engine messages, so a synth
 * that happens to be called `mask` compiles, shows up in the editor, flashes
 * its notes in the roll, and is never heard. That is the silent-replacement
 * shape again (see duplicate-channel.test.ts), and the eval has to say so.
 * ------------------------------------------------------------------------- */

describe('a synth named after an external output', () => {
  it('is refused with a message that says why, at eval', () => {
    const r = evalCode(`const ${MASK_SOUND} = synth(({ saw }) => saw(220))\np('m', n('0').sound('${MASK_SOUND}'))\nsetCps(0.5)`, baseScope)
    expect(r.ok).toBe(false)
    const errs = r.diagnostics.filter((d) => d.severity === 'error')
    expect(errs.length).toBe(1)
    expect(errs[0]!.message).toMatch(/'mask'.*LED mask/)
    expect(errs[0]!.message).toMatch(/never be heard/)
  })

  it('leaves every other synth name alone', () => {
    const r = evalCode(`const masked = synth(({ saw }) => saw(220))\np('m', n('0').sound('masked'))\nsetCps(0.5)`, baseScope)
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toEqual([])
  })

  it('checks the same list the session skips, not a retyped copy', () => {
    // one list, many copies: the guard and the skip must be the SAME set
    expect(EXTERNAL_OUTPUTS.has(MASK_SOUND)).toBe(true)
    for (const name of EXTERNAL_OUTPUTS) {
      const r = evalCode(`const ${name} = synth(({ saw }) => saw(220))\nsetCps(0.5)`, baseScope)
      expect(r.ok, `synth '${name}' was accepted`).toBe(false)
    }
  })
})
