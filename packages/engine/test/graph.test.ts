import { describe, it, expect } from 'vitest'
import { validateGraph, GraphSpec, GraphError } from '../src/graph'

const node = (id: number, type: any, inputs = {}): any => ({ id, type, inputs })

describe('validateGraph', () => {
  it('accepts a simple chain', () => {
    const g: GraphSpec = {
      nodes: [node(0, 'sine', { freq: 440 }), node(1, 'out', { in: { node: 0 } })],
      out: 1,
      params: [],
    }
    expect(() => validateGraph(g)).not.toThrow()
  })

  it('rejects delay-free cycles', () => {
    const g: GraphSpec = {
      nodes: [
        node(0, 'mul', { a: { node: 1 }, b: 0.5 }),
        node(1, 'add', { a: { node: 0 }, b: 0 }),
      ],
      out: 1,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/cycle/)
  })

  it('accepts a diamond DAG (source feeding two paths that reconverge)', () => {
    const g: GraphSpec = {
      nodes: [
        node(0, 'sine', { freq: 440 }),
        node(1, 'mul', { a: { node: 0 }, b: 0.5 }),
        node(2, 'tanh', { in: { node: 0 } }),
        node(3, 'add', { a: { node: 1 }, b: { node: 2 } }),
      ],
      out: 3,
      params: [],
    }
    expect(() => validateGraph(g)).not.toThrow()
  })

  it('accepts cycles through delay', () => {
    const g: GraphSpec = {
      nodes: [
        node(0, 'add', { a: 0, b: { node: 1 } }),
        node(1, 'delay', { in: { node: 0 }, time: 0.25 }),
      ],
      out: 0,
      params: [],
    }
    expect(() => validateGraph(g)).not.toThrow()
  })

  it('rejects unknown node references', () => {
    const g: GraphSpec = {
      nodes: [node(0, 'sine', { freq: { node: 99 } })],
      out: 0,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/nonexistent/)
  })

  it('rejects duplicate node ids', () => {
    const g: GraphSpec = {
      nodes: [node(0, 'sine', { freq: 440 }), node(0, 'saw', { freq: 220 })],
      out: 0,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/duplicate/)
  })

  it('rejects out referencing a nonexistent node', () => {
    const g: GraphSpec = {
      nodes: [node(0, 'sine', { freq: 440 })],
      out: 5,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/nonexistent/)
  })

  it('rejects a delay-free self-loop', () => {
    const g: GraphSpec = {
      nodes: [node(0, 'add', { a: { node: 0 }, b: 1 })],
      out: 0,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/cycle/)
  })

  it('rejects cycles into a delay port other than "in"', () => {
    // edge into delay's `time` port does NOT break the cycle
    const g: GraphSpec = {
      nodes: [
        node(0, 'add', { a: 0, b: { node: 1 } }),
        node(1, 'delay', { in: 0, time: { node: 0 } }),
      ],
      out: 0,
      params: [],
    }
    expect(() => validateGraph(g)).toThrow(GraphError)
    expect(() => validateGraph(g)).toThrow(/cycle/)
  })
})
