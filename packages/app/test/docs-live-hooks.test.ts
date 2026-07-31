import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* ------------------------------------------------------------------------- *
 * The docs page's live-control surface must not be a SUBSET of the editor's.
 *
 * A macro knob on the docs page dragged and rewrote its number and made no
 * sound, while an ordinary knob beside it worked. The cause was three layers
 * that each forward the live hooks by hand — docs.ts, doceditor.ts, player.ts
 * — and every one of them had learned holdParam/releaseParam and none had
 * learned holdMacro/releaseMacro. A macro cannot go through holdParam: it is
 * keyed by synth, and a macro has no single synth.
 *
 * Checked as source text rather than behaviour because the wiring is three
 * hand-written passthroughs, and it is the OMISSION that bites. A behavioural
 * test would need a browser and would still only cover the hook it thought to
 * exercise.
 * ------------------------------------------------------------------------- */
const src = (rel: string): string => readFileSync(join(__dirname, '../src', rel), 'utf8')

/** Every live-control hook a rondo widget can call. */
const LIVE_HOOKS = ['holdParam', 'releaseParam', 'holdMacro', 'releaseMacro'] as const

describe('the docs page forwards every live hook', () => {
  it.each(LIVE_HOOKS)('docs.ts passes %s to the editor', (hook) => {
    expect(src('docs.ts')).toContain(`${hook}:`)
  })

  it.each(LIVE_HOOKS)('doceditor.ts declares and forwards %s', (hook) => {
    const s = src('docs/doceditor.ts')
    expect(s, 'not in the rondoLive contract').toContain(`${hook}(`)
    expect(s, 'declared but not forwarded to the widgets').toContain(`${hook}:`)
  })

  it.each(LIVE_HOOKS)('the preview player exposes %s', (hook) => {
    expect(src('docs/player.ts')).toMatch(new RegExp(`^\\s{2}${hook}\\(`, 'm'))
  })

  it('and the widget layer really does call the macro pair', () => {
    // if the widgets stopped using these, the checks above would pass while
    // testing nothing
    const w = src('editor/rondo/widgets.ts')
    expect(w).toContain('holdMacro?.(')
    expect(w).toContain('releaseMacro?.(')
  })

  it('names every hook the editor offers, so this list cannot fall behind', () => {
    // Hooks is the declaration; a new live hook added there without being
    // added here would let the docs page silently miss it, which is exactly
    // how holdMacro went missing.
    const hooks = src('editor/rondo/widgets.ts')
    const block = /export interface Hooks \{([\s\S]*?)\n\}/.exec(hooks)![1]!
    const declared = [...block.matchAll(/^\s{2}(hold|release)(\w+)\??:/gm)].map((m) => `${m[1]}${m[2]}`)
    expect(new Set(declared)).toEqual(new Set(LIVE_HOOKS))
  })
})
