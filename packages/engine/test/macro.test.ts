import { afterEach, describe, expect, it } from 'vitest'
import { synth } from '../src/builder'
import { GraphError } from '../src/graph'
import { clearMacros, getMacros, lookupMacro, macro, restoreMacros, snapshotMacros } from '../src/macro'
import { BLOCK, compileGraph } from '../src/compile'
import { VoicePool } from '../src/voice'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

afterEach(() => clearMacros())

describe('macro(): the declaration owns the numbers', () => {
  it('a use site carries the macro’s default and bounds, not its own', () => {
    macro('bright', 1480, { min: 500, max: 7300, curve: 'log' })
    const def = synth(({ note, saw, svf, param }) => svf(saw(note.freq), param('bright')))
    expect(def.graph.params).toEqual([
      { name: 'bright', default: 1480, min: 500, max: 7300, curve: 'log', macro: true },
    ])
  })

  it('marks the param as a macro, which is what makes one knob move all of them', () => {
    // the flag, not the NAME, is the truth: two synths may each declare their
    // own `cutoff` and mean two different controls (that is the default), so a
    // control surface groups on this flag
    macro('bright', 1000)
    const shared = synth(({ note, saw, svf, param }) => svf(saw(note.freq), param('bright')))
    const own = synth(({ note, saw, svf, param }) => svf(saw(note.freq), param('bright', 400)))
    expect(shared.graph.params[0]!.macro).toBe(true)
    expect(own.graph.params[0]!.macro).toBeUndefined()
    expect(own.graph.params[0]!.default).toBe(400) // an explicit default still wins
  })

  it('reaches a POST chain too, so a macro can span voice and effects', () => {
    macro('bright', 0.5, { min: 0, max: 1 })
    const def = synth(
      ({ note, saw, param }) => saw(note.freq).mul(param('bright')),
      ({ input, delay, param }) => delay(input, 0.25, param('bright')),
    )
    expect(def.graph.params[0]!.macro).toBe(true)
    expect(def.post!.params[0]!.macro).toBe(true)
  })

  it('one macro drives several targets at DIFFERENT ratios — the point of it', () => {
    // The macro is a value, so each site scales it however it likes. Nothing
    // in the registry knows about the ratios; they are ordinary Sig maths.
    macro('bright', 4000, { min: 500, max: 7300 })
    const def = synth(({ note, saw, svf, param }) => {
      const bright = param('bright')
      // 1:1 on the filter, inverted-and-rescaled on the level
      return svf(saw(note.freq), bright).mul(bright.div(7300).mul(-0.55).add(0.6))
    })
    // ONE declared param feeding two differently-scaled destinations
    expect(def.graph.params).toHaveLength(1)
    expect(def.graph.nodes.filter((n) => n.type === 'param')).toHaveLength(1)
  })

  it('sounds: the compiled param buffer holds the macro’s default', () => {
    macro('level', 0.25, { min: 0, max: 1 })
    const def = synth(({ gate, param }) => gate.mul(param('level')))
    const c = compileGraph(def.graph, ctx)
    expect(c.params.get('level')!.spec.default).toBe(0.25)
    const pool = new VoicePool(def.graph, ctx, 1)
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    pool.noteOn(60, 1)
    pool.process(l, r, BLOCK)
    // gate * level, so a held note holds the macro's default exactly
    // (centre pan is equal-power, hence the 1/sqrt(2) per side)
    expect(l[BLOCK - 1]).toBeCloseTo(0.25 * Math.SQRT1_2, 4)
  })
})

describe('macro(): declaration errors point at the line that owns the numbers', () => {
  it('an undeclared name is a clear error, not a silent zero', () => {
    expect(() => synth(({ param }) => param('nope'))).toThrow(/no macro named 'nope'/)
  })

  it('validates bounds at the declaration, before any synth uses it', () => {
    expect(() => macro('x', 5, { min: 10, max: 1 })).toThrow(GraphError)
    expect(() => macro('x', 50, { min: 0, max: 10 })).toThrow(/outside \[0, 10\]/)
    expect(() => macro('x', 5, { min: 0, max: 10, curve: 'log' })).toThrow(/log curve requires min > 0/)
    expect(() => macro('x', -3)).toThrow(/requires an explicit min/)
  })

  it('refuses a structural control key, which could never be driven', () => {
    expect(() => macro('gain', 1)).toThrow(/structural control key/)
  })

  it('refuses a name that is not an identifier — both languages reference it bare', () => {
    expect(() => macro('two words', 1)).toThrow(/must be an identifier/)
  })
})

describe('macro(): registry lifecycle mirrors wavetables and scales', () => {
  it('redefining replaces, because an eval re-runs the whole program', () => {
    macro('x', 1)
    macro('x', 2, { min: 0, max: 4 })
    expect(lookupMacro('x')!.default).toBe(2)
  })

  it('snapshot/restore gives the eval layer all-or-nothing staging', () => {
    macro('kept', 1)
    const snap = snapshotMacros()
    macro('added', 2)
    expect(getMacros().size).toBe(2)
    restoreMacros(snap)
    expect([...getMacros().keys()]).toEqual(['kept'])
  })

  it('getMacros() hands back a copy — a caller cannot edit the registry', () => {
    macro('x', 1)
    ;(getMacros() as Map<string, never>).clear()
    expect(lookupMacro('x')).toBeDefined()
  })
})
