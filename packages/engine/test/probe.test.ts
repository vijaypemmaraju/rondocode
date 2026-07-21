import { describe, it, expect } from 'vitest'
import { BLOCK } from '../src/compile'
import { synth } from '../src/builder'
import type { GraphSpec } from '../src/graph'
import type { DspContext } from '../src/dsp/types'
import { RealtimeEngine } from '../src/realtime'
import type { EngineEvent } from '../src/protocol'

/* Value-probe runtime tap (layer 2): setProbes registers voice-graph node ids;
 * collectProbes samples each from an active voice on the meter cadence. These
 * drive the REAL engine — define, note-on, process, read. */

const ctx: DspContext = { sampleRate: 48000 }

/** gate * 0.7 through a kernel `mul` node: while the note is held the mul node's
 *  output is a steady 0.7 (gate = 1), independent of pitch — a value we can
 *  assert exactly. Returns the graph + the mul node's id (the probe target). */
const levelGraph = (): { graph: GraphSpec; mulId: number } => {
  const def = synth((c) => c.gate.mul(0.7))
  const mul = def.graph.nodes.find((n) => n.type === 'mul')!
  return { graph: def.graph, mulId: mul.id }
}

const walk = (eng: RealtimeEngine, blocks: number): void => {
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)
  for (let b = 0; b < blocks; b++) eng.process(bl, br, eng.currentFrame)
}

const probeEvent = (eng: RealtimeEngine): Extract<EngineEvent, { kind: 'probe' }> | null =>
  (eng.collectProbes() as Extract<EngineEvent, { kind: 'probe' }> | null)

describe('value-probe: runtime tap', () => {
  it('reads a probed node value from an active voice', () => {
    const { graph, mulId } = levelGraph()
    const eng = new RealtimeEngine(ctx)
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph })
    eng.handleMessage({ kind: 'setProbes', synth: 'lead', nodes: [mulId] })
    eng.handleMessage({ kind: 'noteOn', synth: 'lead', note: 60 })
    walk(eng, 10) // let the note settle
    const ev = probeEvent(eng)
    expect(ev).not.toBeNull()
    expect(ev!.kind).toBe('probe')
    expect(ev!.values['lead']![mulId]).toBeCloseTo(0.7, 2)
  })

  it('returns null when no probes are set', () => {
    const { graph } = levelGraph()
    const eng = new RealtimeEngine(ctx)
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph })
    eng.handleMessage({ kind: 'noteOn', synth: 'lead', note: 60 })
    walk(eng, 4)
    expect(eng.collectProbes()).toBeNull()
  })

  it('reports NaN for a silent synth (no active voice)', () => {
    const { graph, mulId } = levelGraph()
    const eng = new RealtimeEngine(ctx)
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph })
    eng.handleMessage({ kind: 'setProbes', synth: 'lead', nodes: [mulId] })
    walk(eng, 4) // never played a note
    const ev = probeEvent(eng)
    expect(ev).not.toBeNull()
    expect(Number.isNaN(ev!.values['lead']![mulId]!)).toBe(true)
  })

  it('clears probes when set to an empty list', () => {
    const { graph, mulId } = levelGraph()
    const eng = new RealtimeEngine(ctx)
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph })
    eng.handleMessage({ kind: 'setProbes', synth: 'lead', nodes: [mulId] })
    eng.handleMessage({ kind: 'setProbes', synth: 'lead', nodes: [] })
    walk(eng, 4)
    expect(eng.collectProbes()).toBeNull()
  })

  it('ignores an unknown synth and reads NaN for a stale node id', () => {
    const { graph } = levelGraph()
    const eng = new RealtimeEngine(ctx)
    eng.handleMessage({ kind: 'defineSynth', name: 'lead', graph })
    eng.handleMessage({ kind: 'setProbes', synth: 'lead', nodes: [9999] }) // no such node
    eng.handleMessage({ kind: 'noteOn', synth: 'lead', note: 60 })
    walk(eng, 4)
    const ev = probeEvent(eng)
    expect(Number.isNaN(ev!.values['lead']![9999]!)).toBe(true)
  })
})
