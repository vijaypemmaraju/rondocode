import { describe, expect, it } from 'vitest'
import { diffGraphConstants } from '../src/patch'
import { VoicePool } from '../src/voice'
import { BLOCK } from '../src/compile'
import type { DspContext } from '../src/dsp/types'
import type { GraphSpec, InputSource, NodeSpec, NodeType } from '../src/graph'

const ctx: DspContext = { sampleRate: 48000 }

const node = (id: number, type: NodeType, inputs: Record<string, InputSource>, config?: Record<string, unknown>): NodeSpec =>
  config ? { id, type, inputs, config } : { id, type, inputs }

const g = (nodes: NodeSpec[], out: number, params: GraphSpec['params'] = []): GraphSpec => ({ nodes, out, params })

describe('diffGraphConstants', () => {
  const base = g(
    [node(1, 'sine', { freq: 220 }), node(2, 'mul', { a: { node: 1 }, b: 0.3 }), node(3, 'out', { in: { node: 2 } })],
    3,
  )

  it('returns [] for identical graphs', () => {
    expect(diffGraphConstants(base, structuredClone(base))).toEqual([])
  })

  it('returns the changed input constant on a kernel node', () => {
    const next = structuredClone(base)
    ;(next.nodes[1]!.inputs as Record<string, InputSource>)['b'] = 0.9
    expect(diffGraphConstants(base, next)).toEqual([{ node: 2, port: 'b', value: 0.9 }])
  })

  it('collects multiple changed constants', () => {
    const next = structuredClone(base)
    next.nodes[0]!.inputs['freq'] = 440
    next.nodes[1]!.inputs['b'] = 0.5
    expect(diffGraphConstants(base, next)).toEqual([
      { node: 1, port: 'freq', value: 440 },
      { node: 2, port: 'b', value: 0.5 },
    ])
  })

  it('returns null when kernel CONFIG changed (rebuild needed)', () => {
    const a = g([node(1, 'adsr', { gate: 1 }, { d: 0.2 }), node(3, 'out', { in: { node: 1 } })], 3)
    const b = g([node(1, 'adsr', { gate: 1 }, { d: 0.5 }), node(3, 'out', { in: { node: 1 } })], 3)
    expect(diffGraphConstants(a, b)).toBeNull()
  })

  it('returns null on a structural (edge) change', () => {
    const next = structuredClone(base)
    next.nodes[1]!.inputs['b'] = { node: 1 } // constant → edge
    expect(diffGraphConstants(base, next)).toBeNull()
  })

  it('returns null when params changed', () => {
    const next = structuredClone(base)
    next.params = [{ name: 'cutoff', default: 800, min: 80, max: 8000 }]
    expect(diffGraphConstants(base, next)).toBeNull()
  })

  it('returns null when a changed constant feeds a non-kernel node (pan.pos)', () => {
    const a = g([node(1, 'sine', { freq: 220 }), node(2, 'pan', { in: { node: 1 }, pos: 0.5 }), node(3, 'out', { in: { node: 2 } })], 3)
    const b = structuredClone(a)
    b.nodes[1]!.inputs['pos'] = 0.8
    expect(diffGraphConstants(a, b)).toBeNull()
  })

  it('returns null when the node set changed', () => {
    const next = structuredClone(base)
    next.nodes.push(node(4, 'tanh', { in: { node: 2 } }))
    expect(diffGraphConstants(base, next)).toBeNull()
  })
})

const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

const renderRms = (pool: VoicePool, blocks: number): number => {
  const L = new Float32Array(BLOCK)
  const R = new Float32Array(BLOCK)
  const acc = new Float32Array(blocks * BLOCK)
  for (let b = 0; b < blocks; b++) {
    L.fill(0)
    R.fill(0)
    pool.process(L, R, BLOCK)
    acc.set(L, b * BLOCK)
  }
  return rms(acc)
}

describe('VoicePool.patchConstants', () => {
  it('changes a RINGING voice live (no retrigger) — gain 0.3 → 0.9 gets louder', () => {
    const spec = g(
      [node(1, 'sine', { freq: 220 }), node(2, 'mul', { a: { node: 1 }, b: 0.3 }), node(3, 'out', { in: { node: 2 } })],
      3,
    )
    const pool = new VoicePool(spec, ctx, 2)
    pool.noteOn(45, 1)
    renderRms(pool, 4) // let it get going
    const before = renderRms(pool, 8)

    const next = structuredClone(spec)
    next.nodes[1]!.inputs['b'] = 0.9
    const patches = diffGraphConstants(spec, next)!
    expect(patches).toEqual([{ node: 2, port: 'b', value: 0.9 }])
    pool.patchConstants(patches)

    const after = renderRms(pool, 8)
    // ~3x louder, and crucially the SAME voice kept ringing (never retriggered)
    expect(after).toBeGreaterThan(before * 2)
  })
})
