import { afterEach, describe, expect, it } from 'vitest'
import { synth } from '../src/builder'
import { GraphError, resolveParamValue } from '../src/graph'
import type { ParamSpec } from '../src/graph'
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

/* ------------------------------------------------------------------------- *
 * Switches: a knob with two fixed values instead of a range.
 *
 * Same machinery as a param on purpose — MIDI mapping, setParam, the editor
 * scanners and the macro registry all already understand params, and a switch
 * that were its own kind of thing would need a new case in every one of them.
 * ------------------------------------------------------------------------- */
describe('switch params', () => {
  it('derives its bounds from the pair, in either order', () => {
    const s = synth(({ param, sine }) => sine(param('fat', 1, { values: [9, 1] })))
    const spec = s.graph.params.find((p) => p.name === 'fat')!
    expect(spec.values).toEqual([9, 1])
    expect([spec.min, spec.max]).toEqual([1, 9]) // bounds sort; the PAIR does not
    expect(spec.default).toBe(1)
  })

  it('snaps to the nearer value rather than clamping into the gap', () => {
    // the gap is not somewhere the control can be. A clamped switch would rest
    // on a number the source cannot spell, and the source would stop
    // describing what you hear.
    const spec: ParamSpec = { name: 'fat', default: 1, min: 1, max: 9, values: [1, 9] }
    expect(resolveParamValue(spec, 4)).toBe(1)
    expect(resolveParamValue(spec, 6)).toBe(9)
    expect(resolveParamValue(spec, -100)).toBe(1)
    expect(resolveParamValue(spec, 100)).toBe(9)
  })

  it('breaks ties toward the first value, so the pair order is meaningful', () => {
    const spec: ParamSpec = { name: 'x', default: 0, min: 0, max: 10, values: [0, 10] }
    expect(resolveParamValue(spec, 5)).toBe(0)
  })

  it('still clamps an ordinary ranged param', () => {
    const spec: ParamSpec = { name: 'cut', default: 800, min: 80, max: 8000 }
    expect(resolveParamValue(spec, 40)).toBe(80)
    expect(resolveParamValue(spec, 9000)).toBe(8000)
    expect(resolveParamValue(spec, 900)).toBe(900)
  })

  it('takes a negative value without demanding an explicit min', () => {
    // the range rule exists because an omitted min defaults to 0; a switch has
    // no omitted min to get wrong
    const s = synth(({ param, sine }) => sine(param('bend', -1, { values: [-1, 1] })))
    expect(s.graph.params.find((p) => p.name === 'bend')!.min).toBe(-1)
  })

  it('rejects a default that is not one of the two', () => {
    expect(() => synth(({ param, sine }) => sine(param('fat', 5, { values: [1, 9] }))))
      .toThrow(/not one of the switch values/)
  })

  it('rejects anything but exactly two values', () => {
    expect(() => synth(({ param, sine }) => sine(param('x', 1, { values: [1] })))).toThrow(/exactly two/)
    expect(() => synth(({ param, sine }) => sine(param('x', 1, { values: [1, 2, 3] })))).toThrow(/exactly two/)
  })

  it('rejects two equal values, which is a control that cannot do anything', () => {
    expect(() => synth(({ param, sine }) => sine(param('x', 1, { values: [1, 1] })))).toThrow(/two DIFFERENT/)
  })

  it('rejects min/max/curve, rather than ignoring them', () => {
    expect(() => synth(({ param, sine }) => sine(param('x', 1, { values: [1, 9], min: 0 }))))
      .toThrow(/no range/)
    expect(() => synth(({ param, sine }) => sine(param('x', 1, { values: [1, 9], curve: 'log' }))))
      .toThrow(/no range to warp/)
  })
})

describe('switch macros', () => {
  it('registers as a switch and reaches every use site as one', () => {
    macro('fat', 1, { values: [1, 9] })
    const spec = getMacros().get('fat')!
    expect(spec.values).toEqual([1, 9])
    const s = synth(({ param, sine }) => sine(param('fat')))
    // a switch macro must not become a dial once it is referenced
    expect(s.graph.params.find((p) => p.name === 'fat')!.values).toEqual([1, 9])
    expect(s.graph.params.find((p) => p.name === 'fat')!.macro).toBe(true)
  })

  it('applies the same rules as a param switch', () => {
    expect(() => { macro('bad', 5, { values: [1, 9] }) }).toThrow(/not one of the switch values/)
    expect(() => { macro('bad', 1, { values: [1, 9], max: 20 }) }).toThrow(/no range/)
  })
})

describe('a switch reaches the audio, and reaches it snapped', () => {
  it('sounds at the value it rests on, not at some average of the pair', () => {
    const def = synth(({ gate, param }) => gate.mul(param('lvl', 0.25, { values: [0.25, 0.9] })))
    const pool = new VoicePool(def.graph, ctx, 1)
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    pool.noteOn(60, 1)
    pool.process(l, r, BLOCK)
    expect(l[BLOCK - 1]).toBeCloseTo(0.25 * Math.SQRT1_2, 4)
  })

  /** Second block of a held note, after setting `lvl` to `set` (if given).
   *  The SECOND block, because the first carries the note's own onset ramp —
   *  comparing two runs at the same block index is what makes these about the
   *  param and not about the envelope. */
  const held = (set?: number): number => {
    const def = synth(({ gate, param }) => gate.mul(param('lvl', 0.25, { values: [0.25, 0.9] })))
    const pool = new VoicePool(def.graph, ctx, 1)
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    pool.noteOn(60, 1)
    pool.process(l, r, BLOCK)
    if (set !== undefined) pool.setParam('lvl', set)
    // several blocks, so the reading is the SETTLED level: the voice ramps its
    // own gain across a block, and one block after the set is still mid-ramp
    for (let i = 0; i < 8; i++) pool.process(l, r, BLOCK)
    return l[BLOCK - 1]!
  }

  it('flips to the other value when it is set', () => {
    // the path the widget uses on a tap: audible before the debounced eval
    // makes the new default permanent. Asserted as a RATIO band rather than an
    // exact level because the voice's own gain ramp is still settling here —
    // the point is that setting the switch moves the output by roughly the
    // ratio of its two values, not that it lands on a particular sample.
    const ratio = held(0.9) / held()
    expect(ratio).toBeGreaterThan(3)
    expect(ratio).toBeLessThan(0.9 / 0.25 + 0.1)
  })

  it('snaps a value from BETWEEN the pair, where a knob would have held it', () => {
    // a MIDI CC or a stray setParam lands anywhere; a switch has no in-between
    // to rest on, and resting there would be a state the source cannot spell
    expect(held(0.8)).toBeCloseTo(held(0.9), 6) // 0.8 is nearer 0.9
    expect(held(0.4)).toBeCloseTo(held(0.25), 6) // 0.4 is nearer 0.25
  })
})
