import { describe, it, expect } from 'vitest'
import { synth } from '../src/builder'
import type { Sig, SynthCtx, SynthDef } from '../src/builder'
import { GraphError } from '../src/graph'
import type { NodeSpec } from '../src/graph'
import { BLOCK, compileGraph } from '../src/compile'
import { VoicePool } from '../src/voice'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const SR = ctx.sampleRate

/** The design-doc acid example (destructured-context style). Body is
 *  verbatim; the destructuring extends the doc's `{ note, gate, param }` to
 *  all used constructor names. */
const acid = (): SynthDef =>
  synth(({ note, gate, param, saw, square, ladder, adsr }) => {
    const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
    const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
    const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
    return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
  })

const findByType = (def: SynthDef, type: string): NodeSpec[] =>
  def.graph.nodes.filter((n) => n.type === type)

describe('builder: acid example', () => {
  it('builds, validates, and compiles; params carry through', () => {
    const def = acid()
    expect(def.graph.params).toEqual([
      { name: 'cutoff', default: 800, min: 80, max: 8000, curve: 'log' },
    ])
    // synth() already validated+compiled internally; prove it again externally
    expect(() => compileGraph(def.graph, ctx)).not.toThrow()
  })

  it('numbers become constant inputs, not const nodes', () => {
    const def = acid()
    expect(findByType(def, 'const')).toHaveLength(0)
    // square's freq comes from note.freq.mul(0.5): the mul's b is the constant 0.5
    const muls = findByType(def, 'mul')
    expect(muls.some((m) => m.inputs['b'] === 0.5)).toBe(true)
  })

  it('end-to-end: noteOn(45) renders 110Hz-dominant audio with no NaN', () => {
    const def = acid()
    const pool = new VoicePool(def.graph, ctx, 2)
    pool.noteOn(45, 1) // midi 45 = 110 Hz

    const N = Math.floor(0.5 * SR)
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    const blockL = new Float32Array(BLOCK)
    const blockR = new Float32Array(BLOCK)
    for (let i = 0; i < N; i += BLOCK) {
      const n = Math.min(BLOCK, N - i)
      blockL.fill(0)
      blockR.fill(0)
      pool.process(blockL, blockR, n)
      L.set(blockL.subarray(0, n), i)
      R.set(blockR.subarray(0, n), i)
    }

    let sumSq = 0
    for (let i = 0; i < N; i++) {
      expect(Number.isNaN(L[i])).toBe(false)
      expect(Number.isNaN(R[i])).toBe(false)
      sumSq += L[i]! * L[i]!
    }
    expect(Math.sqrt(sumSq / N)).toBeGreaterThan(0.01)

    // 110 Hz fundamental dominates nearby non-harmonic bins
    const p110 = goertzel(L, 110, SR)
    expect(p110).toBeGreaterThan(3 * goertzel(L, 93, SR))
    expect(p110).toBeGreaterThan(3 * goertzel(L, 137, SR))
  })
})

describe('builder: fm operator', () => {
  it('wires freq/mod/feedback; omitted mod & feedback fall to PORTS defaults', () => {
    const withMod = synth(({ note, fm }) => fm(note.freq, fm(note.freq.mul(2)).mul(3), { feedback: 0.4 }))
    const ops = findByType(withMod, 'fm')
    expect(ops).toHaveLength(2)
    // the carrier (the one whose mod is wired) carries a mod + feedback edge
    const carrier = ops.find((o) => o.inputs['mod'] !== undefined)!
    expect(carrier.inputs['feedback']).toBe(0.4)

    const bare = synth(({ note, fm }) => fm(note.freq))
    const op = findByType(bare, 'fm')[0]!
    expect(op.inputs['mod']).toBeUndefined() // PORTS supplies the 0 default
    expect(op.inputs['feedback']).toBeUndefined()
    expect(() => compileGraph(bare.graph, ctx)).not.toThrow()
  })

  it('passes the wave option through config and rejects an unknown one', () => {
    const def = synth(({ note, fm }) => fm(note.freq, undefined, { wave: 'tri' }))
    expect(findByType(def, 'fm')[0]!.config).toEqual({ wave: 'tri' })
    // unknown wave is rejected at definition time (compile instantiates the kernel)
    expect(() => synth(({ note, fm }) => fm(note.freq, undefined, { wave: 'nope' as 'sine' }))).toThrow()
  })

  it('end-to-end: a 2-operator FM voice renders bounded audio with sidebands', () => {
    // carrier 110 Hz, modulator at 2:1 with a decaying index → inharmonic-ish
    // sidebands at 110 ± k·220 while the modulator is loud.
    const def = synth(({ note, gate, fm, adsr }) => {
      const mod = fm(note.freq.mul(2)).mul(adsr(gate, { a: 0.001, d: 0.3, s: 0, r: 0.1 }).mul(4))
      return fm(note.freq, mod).mul(adsr(gate, { a: 0.001, d: 0.4, s: 0.4, r: 0.1 }))
    })
    const pool = new VoicePool(def.graph, ctx, 2)
    pool.noteOn(45, 1) // 110 Hz

    const N = Math.floor(0.25 * SR)
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    for (let i = 0; i < N; i += BLOCK) {
      const n = Math.min(BLOCK, N - i)
      bl.fill(0)
      br.fill(0)
      pool.process(bl, br, n)
      L.set(bl.subarray(0, n), i)
      R.set(br.subarray(0, n), i)
    }
    let sumSq = 0
    let peak = 0
    for (let i = 0; i < N; i++) {
      expect(Number.isNaN(L[i])).toBe(false)
      sumSq += L[i]! * L[i]!
      peak = Math.max(peak, Math.abs(L[i]!))
    }
    expect(Math.sqrt(sumSq / N)).toBeGreaterThan(0.01) // audible
    expect(peak).toBeLessThan(1.2) // bounded (voice pan/gain aside)
    // upper sideband at 330 Hz (110 + 220) has real energy — FM, not a pure sine
    expect(goertzel(L, 330, SR)).toBeGreaterThan(goertzel(L, 110, SR) * 0.05)
  })
})

describe('builder: wavetable oscillator', () => {
  it('wires freq/pos and passes the table name through config', () => {
    const def = synth(({ note, wavetable }) => wavetable(note.freq, 0.5, { table: 'harmonic' }))
    const wt = findByType(def, 'wavetable')
    expect(wt).toHaveLength(1)
    expect(wt[0]!.config).toEqual({ table: 'harmonic' })
    expect(wt[0]!.inputs['pos']).toBe(0.5)
  })

  it('pos defaults away and omitted table leaves config absent', () => {
    const def = synth(({ note, wavetable }) => wavetable(note.freq))
    const wt = findByType(def, 'wavetable')[0]!
    expect(wt.inputs['pos']).toBeUndefined() // PORTS supplies the 0 default
    expect(wt.config).toBeUndefined()
    expect(() => compileGraph(def.graph, ctx)).not.toThrow()
  })

  it('rejects an unknown table name at definition time', () => {
    expect(() => synth(({ note, wavetable }) => wavetable(note.freq, 0, { table: 'nope' }))).toThrow()
  })

  it('end-to-end: renders a note-frequency tone with no NaN', () => {
    const def = synth(({ note, wavetable }) => wavetable(note.freq, 1, { table: 'basic' }))
    const pool = new VoicePool(def.graph, ctx, 2)
    pool.noteOn(45, 1) // midi 45 = 110 Hz
    const N = Math.floor(0.25 * SR)
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    const blockL = new Float32Array(BLOCK)
    const blockR = new Float32Array(BLOCK)
    for (let i = 0; i < N; i += BLOCK) {
      const n = Math.min(BLOCK, N - i)
      blockL.fill(0)
      blockR.fill(0)
      pool.process(blockL, blockR, n)
      L.set(blockL.subarray(0, n), i)
      R.set(blockR.subarray(0, n), i)
    }
    for (let i = 0; i < N; i++) expect(Number.isNaN(L[i])).toBe(false)
    const p110 = goertzel(L, 110, SR)
    expect(p110).toBeGreaterThan(3 * goertzel(L, 93, SR))
    expect(p110).toBeGreaterThan(3 * goertzel(L, 137, SR))
  })
})

describe('builder: Sig combinators', () => {
  it('a.mix(b, 0.3) produces a mix node with t = 0.3', () => {
    const def = synth(({ sine, saw }) => sine(440).mix(saw(220), 0.3))
    const sineId = findByType(def, 'sine')[0]!.id
    const sawId = findByType(def, 'saw')[0]!.id
    const mixes = findByType(def, 'mix')
    expect(mixes).toHaveLength(1)
    expect(mixes[0]!.inputs).toEqual({ a: { node: sineId }, b: { node: sawId }, t: 0.3 })
  })

  it('range(lo, hi) builds lo + this*(hi-lo) from mul/add nodes', () => {
    const def = synth(({ lfo, sine }) => sine(lfo(2).range(300, 2400)))
    const lfoId = findByType(def, 'lfo')[0]!.id
    const mul = findByType(def, 'mul')[0]!
    expect(mul.inputs).toEqual({ a: { node: lfoId }, b: 2100 })
    const add = findByType(def, 'add')[0]!
    expect(add.inputs).toEqual({ a: { node: mul.id }, b: 300 })
    // and the sine consumes the add
    expect(findByType(def, 'sine')[0]!.inputs['freq']).toEqual({ node: add.id })
  })

  it('range with Sig endpoints builds a sub node for the span', () => {
    const def = synth((c) => c.sine(c.lfo(2).range(c.param('lo', 200), 2000)))
    expect(findByType(def, 'sub')).toHaveLength(1)
    expect(() => compileGraph(def.graph, ctx)).not.toThrow()
  })
})

describe('builder: pan / stereo contract', () => {
  it('synth returning pan compiles with stereo out', () => {
    const def = synth(({ sine, pan }) => pan(sine(440), 0.25))
    const cg = compileGraph(def.graph, ctx)
    expect(cg.panPos).not.toBeNull()
  })

  it('pan mid-chain throws GraphError at synth() time', () => {
    expect(() => synth(({ sine, pan }) => pan(sine(440), 0.5).mul(2))).toThrow(GraphError)
    expect(() => synth(({ sine, pan }) => pan(sine(440), 0.5).mul(2))).toThrow(/pan/)
  })
})

describe('builder: params', () => {
  it('duplicate param name throws GraphError naming the param', () => {
    expect(() =>
      synth(({ param, sine }) => {
        param('cutoff', 800)
        param('cutoff', 900)
        return sine(440)
      }),
    ).toThrow(GraphError)
    expect(() =>
      synth(({ param, sine }) => {
        param('cutoff', 800)
        param('cutoff', 900)
        return sine(440)
      }),
    ).toThrow(/cutoff/)
  })

  it("default bounds: param('x', 100) -> min 0, max 400", () => {
    const def = synth(({ param, sine }) => sine(param('x', 100)))
    expect(def.graph.params).toEqual([{ name: 'x', default: 100, min: 0, max: 400 }])
  })

  it('default max is 1 when default is 0', () => {
    const def = synth(({ param, sine }) => sine(440).mul(param('amt', 0)))
    expect(def.graph.params).toEqual([{ name: 'amt', default: 0, min: 0, max: 1 }])
  })

  it('negative default with omitted min throws with guidance', () => {
    const build = ({ param, sine }: SynthCtx): Sig => sine(440).mul(param('off', -0.5))
    expect(() => synth(build)).toThrow(GraphError)
    expect(() => synth(build)).toThrow(
      "param 'off': negative default (-0.5) requires an explicit min (omitted min defaults to 0)",
    )
  })

  it('negative default with explicit min works (max may still default)', () => {
    const def = synth(({ param, sine }) => sine(440).mul(param('off', -0.5, { min: -1 })))
    expect(def.graph.params).toEqual([{ name: 'off', default: -0.5, min: -1, max: 1 }])
  })
})

describe('builder: input type and finiteness errors', () => {
  it('non-Sig, non-number input throws a type error naming the port', () => {
    expect(() => synth((c) => c.sine('440' as unknown as Sig))).toThrow(GraphError)
    expect(() => synth((c) => c.sine('440' as unknown as Sig))).toThrow(
      "sine freq: expected a Sig or number, got string ('440')",
    )
    expect(() => synth((c) => c.ladder(undefined as unknown as Sig, 500))).toThrow(
      'ladder in: expected a Sig or number, got undefined',
    )
    expect(() => synth((c) => c.svf(c.noise(), {} as unknown as Sig))).toThrow(
      /svf cutoff: expected a Sig or number, got object/,
    )
  })

  it('non-finite constants throw at definition time naming the port', () => {
    expect(() => synth((c) => c.sine(NaN))).toThrow(GraphError)
    expect(() => synth((c) => c.sine(NaN))).toThrow('sine freq: constant must be a finite number, got NaN')
    expect(() => synth((c) => c.sine(Infinity))).toThrow(/sine freq.*Infinity/)
    expect(() => synth((c) => c.sine(440).mul(-Infinity))).toThrow(/mul operand.*-Infinity/)
  })
})

describe('builder: reentrancy', () => {
  it('a build that throws does not poison the next synth()', () => {
    expect(() =>
      synth(() => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(() => synth((c) => c.sine(440))).not.toThrow()
  })

  it('nested synth() inside a build works, and the outer build continues', () => {
    const outer = synth((c) => {
      const inner = synth((ci) => ci.sine(220))
      expect(inner.graph.nodes.some((n) => n.type === 'sine')).toBe(true)
      // outer context must still be active after the inner build
      return c.sine(440)
    })
    expect(outer.graph.nodes.some((n) => n.type === 'sine')).toBe(true)
  })

  it('an outer Sig passed to an inner build throws', () => {
    synth((c) => {
      const s = c.sine(440)
      expect(() => synth((ci) => ci.ladder(s, 500))).toThrow(GraphError)
      expect(() => synth((ci) => ci.ladder(s, 500))).toThrow(/another synth/)
      return s
    })
  })
})

describe('builder: cross-synth Sig escape', () => {
  it('using a Sig from another synth() as an input throws', () => {
    let leaked!: Sig
    synth((c) => {
      leaked = c.sine(440)
      return leaked
    })
    expect(() => synth((c) => c.ladder(leaked, 500))).toThrow(GraphError)
    expect(() => synth((c) => c.ladder(leaked, 500))).toThrow(/another synth/)
  })

  it('calling Sig methods from another synth() build throws', () => {
    let leaked!: Sig
    synth((c) => {
      leaked = c.sine(440)
      return leaked
    })
    expect(() => synth(() => leaked.mul(2))).toThrow(GraphError)
    expect(() => synth(() => leaked.mul(2))).toThrow(/another synth/)
  })

  it('calling Sig methods after all builds complete (no active build) throws', () => {
    let leaked!: Sig
    synth((c) => {
      leaked = c.sine(440)
      return leaked
    })
    expect(() => leaked.mul(2)).toThrow(GraphError)
    expect(() => leaked.mul(2)).toThrow(/another synth/)
  })

  it('calling a captured ctx constructor after its build throws', () => {
    let leakedCtx!: SynthCtx
    synth((c) => {
      leakedCtx = c
      return c.sine(440)
    })
    expect(() => leakedCtx.sine(220)).toThrow(GraphError)
    expect(() => leakedCtx.sine(220)).toThrow(/another synth/)
    expect(() => leakedCtx.param('late', 1)).toThrow(GraphError)
  })
})

describe('builder: defaults', () => {
  it('noise() takes no inputs', () => {
    const def = synth(({ noise }) => noise())
    expect(findByType(def, 'noise')[0]!.inputs).toEqual({})
  })

  it('pulse default width is 0.5 (omitted -> port default)', () => {
    const def = synth(({ pulse }) => pulse(220))
    const p = findByType(def, 'pulse')[0]!
    expect(p.inputs['width']).toBeUndefined() // compile fills port default 0.5
    expect(() => compileGraph(def.graph, ctx)).not.toThrow()
  })

  it('adsr with no opts carries no config -> kernel defaults apply', () => {
    const def = synth(({ adsr, gate, sine }) => sine(440).mul(adsr(gate)))
    expect(findByType(def, 'adsr')[0]!.config).toBeUndefined()
  })

  it('delay default maxTime is 0.5', () => {
    const def = synth(({ noise, delay }) => delay(noise(), 0.1))
    expect(findByType(def, 'delay')[0]!.config).toEqual({ maxTime: 0.5 })
  })

  it('delay maxTime passes through', () => {
    const def = synth(({ noise, delay }) => delay(noise(), 0.1, 0.5, { maxTime: 2 }))
    expect(findByType(def, 'delay')[0]!.config).toEqual({ maxTime: 2 })
  })
})

describe('builder: every constructor satisfies the compile port table', () => {
  // Anti-drift test: each ctx constructor with minimal args must produce a
  // graph that compileGraph accepts (synth() compiles internally).
  const cases: Record<string, (c: SynthCtx) => Sig> = {
    'note.freq': (c) => c.note.freq,
    gate: (c) => c.gate,
    velocity: (c) => c.velocity,
    param: (c) => c.param('p', 1),
    sine: (c) => c.sine(440),
    saw: (c) => c.saw(440),
    square: (c) => c.square(440),
    tri: (c) => c.tri(440),
    pulse: (c) => c.pulse(440),
    'pulse+width': (c) => c.pulse(440, 0.2),
    syncsaw: (c) => c.syncsaw(440),
    'syncsaw+ratio': (c) => c.syncsaw(440, c.lfo(0.2).range(1, 5)),
    noise: (c) => c.noise(),
    svf: (c) => c.svf(c.noise(), 1000),
    'svf+opts': (c) => c.svf(c.noise(), 1000, { res: 0.5, mode: 'hp' }),
    'svf+notch': (c) => c.svf(c.noise(), 1000, { mode: 'notch' }),
    'svf+peak': (c) => c.svf(c.noise(), 1000, { mode: 'peak' }),
    ladder: (c) => c.ladder(c.noise(), 1000),
    'ladder+res': (c) => c.ladder(c.noise(), 1000, { res: 0.5 }),
    onepole: (c) => c.onepole(c.noise(), 1000),
    adsr: (c) => c.adsr(c.gate),
    'adsr+opts': (c) => c.adsr(c.gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 }),
    lfo: (c) => c.lfo(2),
    'lfo+shape': (c) => c.lfo(2, 'tri'),
    'lfo+rand': (c) => c.lfo(2, 'rand'),
    delay: (c) => c.delay(c.noise(), 0.1),
    'delay+feedback': (c) => c.delay(c.noise(), 0.1, 0.4),
    pan: (c) => c.pan(c.sine(440), 0.5),
    mix: (c) => c.mix(c.sine(440), c.saw(220), 0.5),
    mul: (c) => c.sine(440).mul(2),
    add: (c) => c.sine(440).add(0.1),
    sub: (c) => c.sine(440).sub(0.1),
    div: (c) => c.sine(440).div(2),
    pow: (c) => c.adsr(c.gate).pow(2),
    clip: (c) => c.sine(440).clip(),
    'clip+bounds': (c) => c.sine(440).clip(-0.5, 0.5),
    'clip+sig-bounds': (c) => c.sine(440).clip(c.lfo(2).mul(-1), c.lfo(2)),
    tanh: (c) => c.sine(440).tanh(),
    fold: (c) => c.sine(440).fold(),
    'sig.mix': (c) => c.sine(440).mix(c.saw(220), 0.3),
    range: (c) => c.lfo(2).range(300, 2400),
  }

  for (const [name, build] of Object.entries(cases)) {
    it(`${name} compiles`, () => {
      expect(() => synth(build)).not.toThrow()
    })
  }
})

// Delay-free feedback cycles are structurally inexpressible in this DSL: a Sig
// can only reference already-created nodes, so no test for them exists here.
// Delayed feedback (e.g. Karplus-Strong) needs a dedicated feedback()
// combinator — deferred to v2. See the note in builder.ts.
