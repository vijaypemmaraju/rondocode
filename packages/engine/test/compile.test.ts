import { describe, it, expect } from 'vitest'
import { BLOCK, compileGraph } from '../src/compile'
import { GraphError, GraphSpec, ParamSpec } from '../src/graph'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }

const node = (id: number, type: any, inputs = {}, config?: Record<string, unknown>): any => ({
  id,
  type,
  inputs,
  ...(config ? { config } : {}),
})

const cutoffParam: ParamSpec = { name: 'cutoff', default: 1000, min: 80, max: 8000, curve: 'log' }

/** saw -> ladder (cutoff param) -> mul by adsr -> out */
const acidSpec = (): GraphSpec => ({
  nodes: [
    node(0, 'notefreq'),
    node(1, 'saw', { freq: { node: 0 } }),
    node(2, 'param', {}, { name: 'cutoff' }),
    node(3, 'ladder', { in: { node: 1 }, cutoff: { node: 2 }, res: 0.3 }),
    node(4, 'gate'),
    node(5, 'adsr', { gate: { node: 4 } }, { a: 0.01, d: 0.1, s: 0.8, r: 0.01 }),
    node(6, 'mul', { a: { node: 3 }, b: { node: 5 } }),
    node(7, 'out', { in: { node: 6 } }),
  ],
  out: 7,
  params: [cutoffParam],
})

describe('compileGraph', () => {
  it('exports BLOCK = 128', () => {
    expect(BLOCK).toBe(128)
  })

  it('compiles the acid graph with kernel steps in topological order', () => {
    const g = compileGraph(acidSpec(), ctx)
    const ids = g.steps.map((s) => s.id)
    // kernel-backed nodes only (saw, ladder, adsr, mul), producers before consumers
    expect(ids).toHaveLength(4)
    expect(ids.indexOf(1)).toBeLessThan(ids.indexOf(3))
    expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(6))
    expect(ids.indexOf(5)).toBeLessThan(ids.indexOf(6))
  })

  it('wires param nodes to voice-owned param buffers pre-filled with the default', () => {
    const g = compileGraph(acidSpec(), ctx)
    const cutoff = g.params.get('cutoff')!
    expect(cutoff).toBeDefined()
    const ladder = g.steps.find((s) => s.id === 3)!
    expect(ladder.inputs['cutoff']).toBe(cutoff.buf)
    expect(cutoff.buf[0]).toBeCloseTo(1000, 6)
    expect(cutoff.buf[BLOCK - 1]).toBeCloseTo(1000, 6)
  })

  it('dedupes identical constant inputs into one shared buffer', () => {
    const spec: GraphSpec = {
      nodes: [
        node(0, 'sine', { freq: 440 }),
        node(1, 'sine', { freq: 440 }),
        node(2, 'add', { a: { node: 0 }, b: { node: 1 } }),
      ],
      out: 2,
      params: [],
    }
    const g = compileGraph(spec, ctx)
    const s0 = g.steps.find((s) => s.id === 0)!
    const s1 = g.steps.find((s) => s.id === 1)!
    expect(s0.inputs['freq']).toBe(s1.inputs['freq'])
    expect(s0.inputs['freq']![0]).toBeCloseTo(440, 6)
  })

  it('allocates delay buffers eagerly at compile time, not on first process', () => {
    const spec: GraphSpec = {
      nodes: [
        node(0, 'gate'),
        node(1, 'delay', { in: { node: 0 }, time: 0.1, feedback: 0.5 }, { maxTime: 0.5 }),
      ],
      out: 1,
      params: [],
    }
    const g = compileGraph(spec, ctx)
    const delay = g.steps.find((s) => s.id === 1)!
    // white-box on purpose: the audio thread must never pay the ring-buffer
    // allocation; the compiler path passes ctx so the kernel allocates now
    expect((delay.kernel as any).buf).toBeInstanceOf(Float32Array)
  })

  it('compiles a delay feedback loop (add -> delay -> back to add)', () => {
    const spec: GraphSpec = {
      nodes: [
        node(0, 'gate'),
        node(1, 'add', { a: { node: 0 }, b: { node: 3 } }),
        node(2, 'delay', { in: { node: 1 }, time: 0.015, feedback: 0 }),
        node(3, 'mul', { a: { node: 2 }, b: 0.5 }),
      ],
      out: 1,
      params: [],
    }
    const g = compileGraph(spec, ctx)
    const ids = g.steps.map((s) => s.id)
    // the delay->mul->add chain is real edges; only add->delay.in is broken
    expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(3))
    expect(ids.indexOf(3)).toBeLessThan(ids.indexOf(1))
  })

  describe('param spec validation', () => {
    const withParams = (params: ParamSpec[]): GraphSpec => ({
      nodes: [node(0, 'sine', { freq: 440 })],
      out: 0,
      params,
    })

    it('rejects duplicate param names', () => {
      const p: ParamSpec = { name: 'x', default: 0.5, min: 0, max: 1 }
      expect(() => compileGraph(withParams([p, { ...p }]), ctx)).toThrow(GraphError)
      expect(() => compileGraph(withParams([p, { ...p }]), ctx)).toThrow(/duplicate param/)
    })

    it('rejects min >= max', () => {
      expect(() =>
        compileGraph(withParams([{ name: 'x', default: 1, min: 1, max: 1 }]), ctx),
      ).toThrow(/min/)
    })

    it('rejects default outside [min, max]', () => {
      expect(() =>
        compileGraph(withParams([{ name: 'x', default: 2, min: 0, max: 1 }]), ctx),
      ).toThrow(/default/)
    })

    it('rejects log curve with min <= 0', () => {
      expect(() =>
        compileGraph(withParams([{ name: 'x', default: 0.5, min: 0, max: 1, curve: 'log' }]), ctx),
      ).toThrow(/log/)
    })

    it('rejects a param node naming an undeclared param', () => {
      const spec: GraphSpec = {
        nodes: [node(0, 'param', {}, { name: 'nope' }), node(1, 'sine', { freq: { node: 0 } })],
        out: 1,
        params: [cutoffParam],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
      expect(() => compileGraph(spec, ctx)).toThrow(/nope/)
    })

    it('rejects a param node with no name config', () => {
      const spec: GraphSpec = {
        nodes: [node(0, 'param'), node(1, 'sine', { freq: { node: 0 } })],
        out: 1,
        params: [cutoffParam],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
    })
  })

  describe('input port validation', () => {
    it('rejects a missing required port (svf without cutoff)', () => {
      const spec: GraphSpec = {
        nodes: [node(0, 'sine', { freq: 440 }), node(1, 'svf', { in: { node: 0 } })],
        out: 1,
        params: [],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
      expect(() => compileGraph(spec, ctx)).toThrow(/cutoff/)
    })

    it('applies defaults for defaultable ports (svf res omitted)', () => {
      const spec: GraphSpec = {
        nodes: [
          node(0, 'sine', { freq: 440 }),
          node(1, 'svf', { in: { node: 0 }, cutoff: 1000 }),
        ],
        out: 1,
        params: [],
      }
      const g = compileGraph(spec, ctx)
      const svf = g.steps.find((s) => s.id === 1)!
      expect(svf.inputs['res']![0]).toBe(0)
    })

    it('rejects an unknown port', () => {
      const spec: GraphSpec = {
        nodes: [node(0, 'sine', { freq: 440, wobble: 3 })],
        out: 0,
        params: [],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
      expect(() => compileGraph(spec, ctx)).toThrow(/wobble/)
    })

    it('rejects a const node without a numeric value', () => {
      const spec: GraphSpec = {
        nodes: [node(0, 'const'), node(1, 'sine', { freq: { node: 0 } })],
        out: 1,
        params: [],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
    })
  })

  describe('stereo contract', () => {
    it('accepts a single terminal pan node', () => {
      const spec: GraphSpec = {
        nodes: [
          node(0, 'sine', { freq: 440 }),
          node(1, 'pan', { in: { node: 0 }, pos: 0.25 }),
          node(2, 'out', { in: { node: 1 } }),
        ],
        out: 2,
        params: [],
      }
      const g = compileGraph(spec, ctx)
      expect(g.panPos).not.toBeNull()
    })

    it('mono terminal compiles with no pan position (center)', () => {
      const g = compileGraph(acidSpec(), ctx)
      expect(g.panPos).toBeNull()
    })

    it('rejects a pan node that is not the terminal out-feeding node', () => {
      const spec: GraphSpec = {
        nodes: [
          node(0, 'sine', { freq: 440 }),
          node(1, 'pan', { in: { node: 0 }, pos: 0.25 }),
          node(2, 'tanh', { in: { node: 1 } }),
          node(3, 'out', { in: { node: 2 } }),
        ],
        out: 3,
        params: [],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
      expect(() => compileGraph(spec, ctx)).toThrow(/pan/)
    })

    it('rejects more than one pan node', () => {
      const spec: GraphSpec = {
        nodes: [
          node(0, 'sine', { freq: 440 }),
          node(1, 'pan', { in: { node: 0 }, pos: 0 }),
          node(2, 'pan', { in: { node: 1 }, pos: 1 }),
          node(3, 'out', { in: { node: 2 } }),
        ],
        out: 3,
        params: [],
      }
      expect(() => compileGraph(spec, ctx)).toThrow(GraphError)
    })
  })
})
