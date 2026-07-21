import { describe, it, expect } from 'vitest'
import { BLOCK } from '../src/compile'
import { synth } from '../src/builder'
import type { GraphSpec } from '../src/graph'
import type { DspContext } from '../src/dsp/types'
import { softClipTanh } from '../src/dsp/util'
import {
  RealtimeEngine,
  masterSafety,
  CLIP_THRESHOLD,
  MAX_PENDING_EVENTS,
  MAX_TOTAL_VOICES,
} from '../src/realtime'
import type { EngineEvent, EngineMessage } from '../src/protocol'

const ctx: DspContext = { sampleRate: 48000 }
const SR = ctx.sampleRate

/* ------------------------------------------------------------------------- *
 * Level bookkeeping for DC test synths (gate.mul(k) emits constant k while
 * the gate is on):
 *   per-side output = k * CENTER(voice) * chanGain * cos|sin(pan*pi/2) * master
 * With defaults (chanGain 0.8, pan 0.5, master 0.8):
 *   k * 0.7071 * 0.8 * 0.7071 * 0.8 = k * 0.32
 * so k = 0.5 lands at 0.16 per side.
 * ------------------------------------------------------------------------- */
const DC_HALF = 0.16

const dcGraph = (): GraphSpec => synth((c) => c.gate.mul(0.5)).graph

const acidGraph = (): GraphSpec =>
  synth((c) => {
    const cutoff = c.param('cutoff', 1200, { min: 80, max: 8000 })
    const env = c.adsr(c.gate, { a: 0.005, d: 0.1, s: 0.8, r: 0.05 })
    return c.ladder(c.saw(c.note.freq), cutoff, { res: 0.3 }).mul(env)
  }).graph

/** gate * level param: RMS is directly proportional to the param — the
 *  "param drives gain" trick for observing ramps. */
const levelGraph = (): GraphSpec =>
  synth((c) => c.gate.mul(c.param('level', 0.1, { min: 0, max: 1 }))).graph

/** Massively over-driven sine: hits the master soft-clip hard. */
const loudGraph = (): GraphSpec => synth((c) => c.sine(220).mul(50)).graph

const makeEngine = (opts?: { maxSynths?: number }) => {
  const events: EngineEvent[] = []
  const eng = new RealtimeEngine(ctx, opts)
  eng.onEvent = (ev) => events.push(ev)
  return { eng, events }
}

const errors = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { kind: 'error' }> => e.kind === 'error')

const send = (eng: RealtimeEngine, msg: EngineMessage) => eng.handleMessage(msg)

const define = (eng: RealtimeEngine, name: string, graph: GraphSpec, maxVoices?: number) =>
  send(eng, maxVoices === undefined
    ? { kind: 'defineSynth', name, graph }
    : { kind: 'defineSynth', name, graph, maxVoices })

/** Process `blocks` blocks (passing eng.currentFrame as the block start) and
 *  return the concatenated stereo output. */
const walk = (eng: RealtimeEngine, blocks: number): { L: Float32Array; R: Float32Array } => {
  const L = new Float32Array(blocks * BLOCK)
  const R = new Float32Array(blocks * BLOCK)
  const bl = new Float32Array(BLOCK)
  const br = new Float32Array(BLOCK)
  for (let b = 0; b < blocks; b++) {
    eng.process(bl, br, eng.currentFrame)
    L.set(bl, b * BLOCK)
    R.set(br, b * BLOCK)
  }
  return { L, R }
}

const rms = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / (to - from))
}

const firstNonZero = (x: Float32Array, eps = 1e-7): number => {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > eps) return i
  return -1
}

describe('softClipTanh / masterSafety (master bus safety stage)', () => {
  it('is the identity below the threshold', () => {
    expect(softClipTanh(0.5, CLIP_THRESHOLD)).toBe(0.5)
    expect(softClipTanh(-0.9, CLIP_THRESHOLD)).toBe(-0.9)
    expect(softClipTanh(0, CLIP_THRESHOLD)).toBe(0)
  })

  it('is value- and slope-matched at the knee and bounded by ±1', () => {
    const t = CLIP_THRESHOLD
    expect(softClipTanh(t, t)).toBeCloseTo(t, 12)
    // slope ~1 just above the knee
    const eps = 1e-4
    expect(softClipTanh(t + eps, t) - t).toBeCloseTo(eps, 6)
    // asymptote: huge inputs land just under 1, symmetric
    expect(softClipTanh(1e6, t)).toBeLessThanOrEqual(1)
    expect(softClipTanh(1e6, t)).toBeGreaterThan(0.999)
    expect(softClipTanh(-1e6, t)).toBeGreaterThanOrEqual(-1)
    expect(softClipTanh(-1e6, t)).toBeLessThan(-0.999)
  })

  it('is monotonic across the knee', () => {
    let prev = -Infinity
    for (let v = -3; v <= 3; v += 0.001) {
      const y = softClipTanh(v, CLIP_THRESHOLD)
      expect(y).toBeGreaterThanOrEqual(prev)
      prev = y
    }
  })

  it('masterSafety scrubs non-finite samples to 0 and clips the rest', () => {
    expect(masterSafety(NaN)).toBe(0)
    expect(masterSafety(Infinity)).toBe(0)
    expect(masterSafety(-Infinity)).toBe(0)
    expect(masterSafety(0.5)).toBe(0.5)
    expect(masterSafety(50)).toBeLessThanOrEqual(1)
    expect(masterSafety(50)).toBeGreaterThan(0.99)
    expect(masterSafety(-50)).toBeGreaterThanOrEqual(-1)
  })
})

describe('RealtimeEngine: define + play', () => {
  it('defineSynth + noteOn produces sound in the same block, RMS grows through the attack', () => {
    const { eng, events } = makeEngine()
    define(eng, 'acid', acidGraph())
    send(eng, { kind: 'noteOn', synth: 'acid', note: 48 })
    const { L } = walk(eng, 3)
    const b0 = rms(L, 0, BLOCK)
    const b2 = rms(L, 2 * BLOCK, 3 * BLOCK)
    expect(b0).toBeGreaterThan(1e-6)
    expect(b2).toBeGreaterThan(b0)
    expect(errors(events)).toHaveLength(0)
  })

  it('applies a future noteOn sample-accurately within a block (±1 sample)', () => {
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: eng.currentFrame + 1000 })
    const { L, R } = walk(eng, 16)
    expect(Math.abs(firstNonZero(L) - 1000)).toBeLessThanOrEqual(1)
    expect(Math.abs(firstNonZero(R) - 1000)).toBeLessThanOrEqual(1)
    expect(L[1005]).toBeCloseTo(DC_HALF, 3)
  })

  it('is sample-accurate on a worklet-style timeline that does not start at 0', () => {
    // A real AudioWorklet host passes the context's global currentFrame,
    // which is far past 0 by the time the engine spins up.
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    const base = 10_000
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: base + 1000 })
    const blocks = 16
    const L = new Float32Array(blocks * BLOCK)
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    for (let b = 0; b < blocks; b++) {
      eng.process(bl, br, base + b * BLOCK)
      L.set(bl, b * BLOCK)
    }
    expect(Math.abs(firstNonZero(L) - 1000)).toBeLessThanOrEqual(1)
  })

  it('applies a future noteOff sample-accurately within a block', () => {
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    send(eng, { kind: 'noteOff', synth: 'dc', note: 60, atFrame: 1500 })
    const { L } = walk(eng, 16)
    expect(Math.abs(L[1499]!)).toBeGreaterThan(0.1)
    expect(Math.abs(L[1500]!)).toBeLessThan(1e-7)
  })

  it('currentFrame advances BLOCK per process call', () => {
    const { eng } = makeEngine()
    expect(eng.currentFrame).toBe(0)
    walk(eng, 3)
    expect(eng.currentFrame).toBe(3 * BLOCK)
  })
})

describe('RealtimeEngine: unified timeline (first startFrame is the origin)', () => {
  it('adopts the first process() startFrame: currentFrame and meters.frame report worklet frames', () => {
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    const base = 10_000
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    eng.process(bl, br, base)
    expect(eng.currentFrame).toBe(base + BLOCK)
    eng.process(bl, br, base + BLOCK)
    expect(eng.currentFrame).toBe(base + 2 * BLOCK)
    const m = eng.collectMeters()
    expect(m.kind === 'meters' && m.frame).toBe(base + 2 * BLOCK)
  })

  it('an atFrame stamped from currentFrame after a non-zero origin fires at the exact offset', () => {
    // The scheduler learns "now" from meters.frame / currentFrame and stamps
    // atFrame = now + delta. Pre-reconciliation the internal counter started
    // at 0 while the worklet clock was at base, so such an event fired
    // immediately (late) instead of delta frames later.
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    const base = 10_000
    const blocks = 16
    const L = new Float32Array(blocks * BLOCK)
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    eng.process(bl, br, base)
    L.set(bl, 0)
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: eng.currentFrame + 500 })
    for (let b = 1; b < blocks; b++) {
      eng.process(bl, br, base + b * BLOCK)
      L.set(bl, b * BLOCK)
    }
    expect(Math.abs(firstNonZero(L) - (BLOCK + 500))).toBeLessThanOrEqual(1)
  })

  it('a noteOn queued BEFORE the first process still fires on the worklet timeline', () => {
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    const base = 10_000
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: base + 500 })
    const blocks = 8
    const L = new Float32Array(blocks * BLOCK)
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    for (let b = 0; b < blocks; b++) {
      eng.process(bl, br, base + b * BLOCK)
      L.set(bl, b * BLOCK)
    }
    expect(Math.abs(firstNonZero(L) - 500)).toBeLessThanOrEqual(1)
  })

  it('a non-finite startFrame does not latch: the first FINITE one adopts the origin', () => {
    const { eng, events } = makeEngine()
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    eng.process(bl, br, NaN) // garbage first: origin not adopted yet
    expect(eng.currentFrame).toBe(BLOCK)
    expect(errors(events)).toHaveLength(1)
    eng.process(bl, br, 5000) // first finite frame: adopt it
    expect(eng.currentFrame).toBe(5000 + BLOCK)
    eng.process(bl, br, 5000 + BLOCK) // and stay adopted
    expect(eng.currentFrame).toBe(5000 + 2 * BLOCK)
  })
})

describe('RealtimeEngine: defineSynth last-good-version', () => {
  it('a bad graph emits an error and leaves the existing synth untouched', () => {
    const { eng, events } = makeEngine()
    define(eng, 'lead', dcGraph())
    // out references a node that doesn't exist -> compile/validate throws
    define(eng, 'lead', { nodes: [], out: 42, params: [] })
    expect(errors(events).length).toBe(1)
    expect(errors(events)[0]!.kind === 'error' && errors(events)[0]!.message).toContain('lead')
    send(eng, { kind: 'noteOn', synth: 'lead', note: 60 })
    const { L } = walk(eng, 2)
    expect(L[0]).toBeCloseTo(DC_HALF, 3)
  })
})

describe('RealtimeEngine: removeSynth', () => {
  it('silences the synth immediately; later noteOn errors without throwing', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    const a = walk(eng, 2)
    expect(rms(a.L)).toBeGreaterThan(0.1)
    send(eng, { kind: 'removeSynth', name: 'dc' })
    const b = walk(eng, 2)
    expect(rms(b.L)).toBe(0)
    expect(rms(b.R)).toBe(0)
    expect(() => send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })).not.toThrow()
    expect(errors(events).length).toBe(1)
    const c = walk(eng, 1)
    expect(rms(c.L)).toBe(0)
  })

  it('purges queued events for the removed synth (no stale fires, no fire-time errors)', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: 600 })
    send(eng, { kind: 'removeSynth', name: 'dc' })
    define(eng, 'dc', dcGraph()) // same name again: purged event must NOT revive
    const { L } = walk(eng, 8)
    expect(rms(L)).toBe(0)
    expect(errors(events)).toHaveLength(0)
  })
})

describe('RealtimeEngine: allNotesOff', () => {
  it('releases all sounding notes and drops queued note events', () => {
    const { eng } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'dc', note: 64, atFrame: 2000 })
    const a = walk(eng, 1)
    expect(rms(a.L)).toBeGreaterThan(0.1)
    send(eng, { kind: 'allNotesOff' })
    const b = walk(eng, 20) // covers frame 2000: the queued noteOn must be gone
    expect(rms(b.L)).toBe(0)
  })
})

describe('RealtimeEngine: setParam ramps', () => {
  it('rampMs=100 walks the value monotonically from A to B over ~100ms', () => {
    const { eng, events } = makeEngine()
    define(eng, 'lvl', levelGraph())
    send(eng, { kind: 'noteOn', synth: 'lvl', note: 60 })
    walk(eng, 4) // settle at level=0.1 -> per-side 0.032
    send(eng, { kind: 'setParam', synth: 'lvl', name: 'level', value: 0.9, rampMs: 100 })
    const blocks = 40 // 100ms = 4800 frames = 37.5 blocks
    const { L } = walk(eng, blocks)
    const perBlock: number[] = []
    for (let b = 0; b < blocks; b++) perBlock.push(rms(L, b * BLOCK, (b + 1) * BLOCK))
    // start at the old value, end at the new one (level * 0.32 per side)
    expect(perBlock[0]!).toBeCloseTo(0.1 * 0.32, 3)
    expect(perBlock[blocks - 1]!).toBeCloseTo(0.9 * 0.32, 3)
    // monotonic, and genuinely mid-flight at the midpoint
    for (let b = 1; b < blocks; b++) expect(perBlock[b]!).toBeGreaterThanOrEqual(perBlock[b - 1]! - 1e-6)
    expect(perBlock[19]!).toBeGreaterThan(0.1)
    expect(perBlock[19]!).toBeLessThan(0.25)
    expect(errors(events)).toHaveLength(0)
  })

  it('rampMs=0 (default) applies instantly at the next block', () => {
    const { eng } = makeEngine()
    define(eng, 'lvl', levelGraph())
    send(eng, { kind: 'noteOn', synth: 'lvl', note: 60 })
    walk(eng, 2)
    send(eng, { kind: 'setParam', synth: 'lvl', name: 'level', value: 0.9 })
    const { L } = walk(eng, 1)
    expect(rms(L)).toBeCloseTo(0.9 * 0.32, 3)
  })
})

describe('RealtimeEngine: channel strips', () => {
  it('pan hard left puts all of a synth\'s energy in L', () => {
    const { eng } = makeEngine()
    define(eng, 'a', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'a', pan: 0 })
    send(eng, { kind: 'noteOn', synth: 'a', note: 60 })
    const { L, R } = walk(eng, 3) // pan change ramps over one block; measure the last
    const last = 2 * BLOCK
    // 0.5 * CENTER(voice) * 0.8(gain) * cos(0)=1 * 0.8(master) = 0.2263
    expect(rms(L, last)).toBeCloseTo(0.5 * Math.SQRT1_2 * 0.8 * 0.8, 3)
    expect(rms(R, last)).toBeLessThan(1e-6)
  })

  it('channel gain 0 silences one synth and leaves the other untouched', () => {
    const { eng } = makeEngine()
    define(eng, 'a', dcGraph())
    define(eng, 'b', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'a', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'b', note: 60 })
    const both = walk(eng, 2)
    expect(rms(both.L, BLOCK)).toBeCloseTo(2 * DC_HALF, 3)
    send(eng, { kind: 'setChannel', synth: 'a', gain: 0 })
    const { L, R } = walk(eng, 3)
    const last = 2 * BLOCK
    expect(rms(L, last)).toBeCloseTo(DC_HALF, 3)
    expect(rms(R, last)).toBeCloseTo(DC_HALF, 3)
  })
})

describe('RealtimeEngine: master bus safety', () => {
  it('soft-clips an exploding patch: bounded ≤1, no hard discontinuities', () => {
    const { eng } = makeEngine()
    define(eng, 'loud', loudGraph())
    send(eng, { kind: 'noteOn', synth: 'loud', note: 60 })
    const { L } = walk(eng, 10)
    let peak = 0
    let maxDiff = 0
    for (let i = 0; i < L.length; i++) {
      peak = Math.max(peak, Math.abs(L[i]!))
      if (i > 0) maxDiff = Math.max(maxDiff, Math.abs(L[i]! - L[i - 1]!))
    }
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.99) // it IS clipping
    // input to master is a 220Hz sine of amplitude 16 -> max slope/sample
    // = 16 * 2*pi*220/48000 = 0.46; a slope-matched knee never steepens it
    expect(maxDiff).toBeLessThan(0.5)
  })
})

describe('RealtimeEngine: handleMessage never throws', () => {
  it('emits an error event per malformed message and keeps processing', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    const bad: unknown[] = [
      null,
      42,
      'noteOn',
      {},
      { kind: 'bogus' },
      [], // an array is object-typed but has no 'kind'
      { kind: 'noteOn' }, // missing synth
      { kind: 'noteOn', synth: 'dc' }, // missing note
      { kind: 'noteOn', synth: 'nope', note: 60 }, // unknown synth
      { kind: 'noteOn', synth: 'dc', note: 'sixty' }, // wrong type
      { kind: 'noteOn', synth: 'dc', note: 60, atFrame: 'later' },
      { kind: 'noteOn', synth: 'dc', note: 60, velocity: NaN },
      { kind: 'noteOff', synth: 'nope', note: 60 },
      { kind: 'setParam', synth: 'dc', name: 'nope', value: 1 }, // unknown param
      { kind: 'setParam', synth: 'dc', name: 5, value: 1 },
      { kind: 'setChannel', synth: 'nope', gain: 0.5 },
      { kind: 'setChannel', synth: 'dc', gain: 'loud' },
      { kind: 'setMaster' },
      { kind: 'removeSynth', name: 'nope' },
      { kind: 'defineSynth', name: 7, graph: dcGraph() },
      { kind: 'defineSynth', name: 'bad', graph: { nodes: [], out: 0, params: [] } },
    ]
    for (const m of bad) {
      expect(() => eng.handleMessage(m as EngineMessage)).not.toThrow()
    }
    expect(errors(events).length).toBe(bad.length)
    // engine is still alive and audible
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    const { L } = walk(eng, 2)
    expect(rms(L, BLOCK)).toBeCloseTo(DC_HALF, 3)
  })

  it('process with wrong-size buffers emits an error instead of corrupting', () => {
    const { eng, events } = makeEngine()
    const small = new Float32Array(BLOCK - 1)
    expect(() => eng.process(small, small, 0)).not.toThrow()
    expect(errors(events).length).toBe(1)
  })

  it('non-finite startFrame emits a rate-limited error and keeps rendering', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    const bl = new Float32Array(BLOCK)
    const br = new Float32Array(BLOCK)
    expect(() => eng.process(bl, br, NaN)).not.toThrow()
    expect(errors(events).length).toBe(1)
    expect(errors(events)[0]!.message).toMatch(/startFrame/)
    expect(rms(bl)).toBeCloseTo(DC_HALF, 3) // audio survived the host bug
    expect(eng.currentFrame).toBe(BLOCK)
    // rate-limited: a second bad call within a second is silent
    eng.process(bl, br, NaN)
    expect(errors(events).length).toBe(1)
  })

  it('a throwing onEvent listener is swallowed', () => {
    const eng = new RealtimeEngine(ctx)
    eng.onEvent = () => {
      throw new Error('host listener boom')
    }
    expect(() => send(eng, { kind: 'noteOn', synth: 'nope', note: 60 })).not.toThrow()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    const { L } = walk(eng, 2)
    expect(rms(L, BLOCK)).toBeCloseTo(DC_HALF, 3)
  })

  it('echoes the message id on error events (and omits it when absent)', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'nope', note: 60, id: 'req-7' })
    send(eng, { kind: 'defineSynth', name: 'bad', graph: { nodes: [], out: 0, params: [] }, id: 'def-1' })
    send(eng, { kind: 'bogus', id: 'b-2' } as unknown as EngineMessage)
    send(eng, { kind: 'noteOn', synth: 'nope', note: 60 }) // no id
    const errs = errors(events)
    expect(errs.map((e) => (e.kind === 'error' ? e.id : '?'))).toEqual(['req-7', 'def-1', 'b-2', undefined])
  })

  it('setChannel is atomic: one invalid field means nothing is applied', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    walk(eng, 2)
    send(eng, { kind: 'setChannel', synth: 'dc', gain: 0, pan: 'left' } as unknown as EngineMessage)
    expect(errors(events).length).toBe(1)
    const { L } = walk(eng, 3)
    expect(rms(L, 2 * BLOCK)).toBeCloseTo(DC_HALF, 3) // gain 0 was NOT applied
  })
})

describe('RealtimeEngine: meters', () => {
  it('reflects relative channel levels and master ≈ mix', () => {
    const { eng } = makeEngine()
    define(eng, 'a', dcGraph())
    define(eng, 'b', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'b', gain: 0.4 })
    send(eng, { kind: 'noteOn', synth: 'a', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'b', note: 60 })
    walk(eng, 3)
    const m = eng.collectMeters()
    expect(m.kind).toBe('meters')
    if (m.kind !== 'meters') return
    expect(m.frame).toBe(eng.currentFrame) // scheduler heartbeat
    // a: 0.5*CENTER*0.8*CENTER = 0.2 per side; b at gain 0.4 -> 0.1
    expect(m.channels['a']).toBeCloseTo(0.2, 3)
    expect(m.channels['b']).toBeCloseTo(0.1, 3)
    expect(m.channels['a']! / m.channels['b']!).toBeCloseTo(2, 2)
    // master = (0.2 + 0.1) * 0.8
    expect(m.master).toBeCloseTo(0.24, 3)
  })

  it('meters a synth named __proto__ like any other', () => {
    const { eng } = makeEngine()
    define(eng, '__proto__', dcGraph())
    send(eng, { kind: 'noteOn', synth: '__proto__', note: 60 })
    walk(eng, 2)
    const m = eng.collectMeters()
    if (m.kind !== 'meters') return
    expect(m.channels['__proto__']).toBeCloseTo(0.2, 3)
  })
})

describe('RealtimeEngine: sidechain ducking', () => {
  /* kick (source) hard-left, pad (target) hard-right, so each channel isolates
   * one synth. Both DC synths hold a constant 0.5 while gated. The pad's R
   * level = 0.5 * CENTER(voice) * 0.8(gain) * 1(sin) * duck * 0.8(master)
   * = 0.2263 * duck; the kick's L level is the same 0.2263 and is NEVER
   * ducked (it is the source). */
  const PAD_FULL = 0.5 * Math.SQRT1_2 * 0.8 * 0.8

  /** Held pad + held kick, panned apart, with a sidechain armed. Kick
   *  retriggers at atFrame N1 and N2 drive the duck. */
  const arm = (opts: { depth: number; releaseMs: number; n1: number; n2: number }) => {
    const { eng, events } = makeEngine()
    define(eng, 'kick', dcGraph())
    define(eng, 'pad', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'kick', pan: 0 })
    send(eng, { kind: 'setChannel', synth: 'pad', pan: 1 })
    send(eng, { kind: 'setSidechain', source: 'kick', depth: opts.depth, releaseMs: opts.releaseMs })
    send(eng, { kind: 'noteOn', synth: 'pad', note: 60 }) // held target
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60 }) // held source
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: opts.n1 })
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: opts.n2 })
    return { eng, events }
  }

  it('ducks the target right after a source noteOn and recovers before the next; source stays full', () => {
    const n1 = 6000
    const n2 = 14000
    const { eng, events } = arm({ depth: 0.6, releaseMs: 40, n1, n2 })
    const { L, R } = walk(eng, 130) // 130*128 = 16640 frames, covers n2
    // window just AFTER n1 (target ducked) vs just BEFORE n2 (target recovered)
    const afterN1 = rms(R, n1 + 20, n1 + 520)
    const beforeN2 = rms(R, n2 - 520, n2 - 20)
    expect(afterN1).toBeLessThan(beforeN2 * 0.75) // clearly ducked
    expect(beforeN2).toBeCloseTo(PAD_FULL, 2) // recovered to full
    // the SOURCE channel (kick, in L) is never ducked: full both windows
    expect(rms(L, n1 + 20, n1 + 520)).toBeCloseTo(PAD_FULL, 2)
    expect(rms(L, n2 - 520, n2 - 20)).toBeCloseTo(PAD_FULL, 2)
    expect(errors(events)).toHaveLength(0)
  })

  it('snaps the target down to 1 - depth at the trigger sample', () => {
    const n1 = 6000
    const { eng } = arm({ depth: 0.6, releaseMs: 200, n1, n2: 40000 })
    const { R } = walk(eng, 130)
    // right at the trigger the duck is at 1 - depth = 0.4 (before much recovery)
    expect(R[n1 + 2]!).toBeCloseTo(PAD_FULL * 0.4, 2)
  })

  it('depth 0 = no duck', () => {
    const n1 = 6000
    const { eng } = arm({ depth: 0, releaseMs: 40, n1, n2: 40000 })
    const { R } = walk(eng, 130)
    expect(rms(R, n1 + 20, n1 + 520)).toBeCloseTo(PAD_FULL, 2)
  })

  it('clearSidechain restores full level', () => {
    const n1 = 6000
    const { eng } = arm({ depth: 0.6, releaseMs: 40, n1, n2: 40000 })
    send(eng, { kind: 'clearSidechain' })
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: 9000 })
    const { R } = walk(eng, 130)
    // after the clear the pad is at full level even right after a kick hit
    expect(rms(R, 9020, 9520)).toBeCloseTo(PAD_FULL, 2)
  })

  it('advances the duck once per output sample regardless of channel count', () => {
    // Adding a silent (gain 0) target channel must NOT speed up recovery: the
    // duck advances per sample, not per channel. Measure the recovery level a
    // fixed distance after a trigger with 1 vs 2 ducked channels.
    const n1 = 6000
    const probe = 3000
    const one = arm({ depth: 0.6, releaseMs: 60, n1, n2: 40000 })
    const rOne = walk(one.eng, 130).R[n1 + probe]!

    const { eng } = makeEngine()
    define(eng, 'kick', dcGraph())
    define(eng, 'pad', dcGraph())
    define(eng, 'ghost', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'kick', pan: 0 })
    send(eng, { kind: 'setChannel', synth: 'pad', pan: 1 })
    send(eng, { kind: 'setChannel', synth: 'ghost', gain: 0 }) // silent but ducked
    send(eng, { kind: 'setSidechain', source: 'kick', depth: 0.6, releaseMs: 60 })
    send(eng, { kind: 'noteOn', synth: 'pad', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'ghost', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: n1 })
    const rTwo = walk(eng, 130).R[n1 + probe]!
    expect(rTwo).toBeCloseTo(rOne, 5) // identical recovery, channel-count-independent
  })

  it('per-channel sidechain amount: a low-amount channel dips less than a full-amount one', () => {
    // Two ducked channels, panned to opposite legs so each isolates: padFull
    // in R ducks fully (amount 1), padLite in L ducks lightly (amount 0.3).
    // The kick (silent, gain 0) still triggers the duck. depth 0.8 →
    // full mult = 0.2, lite mult = 1 - 0.3*(1-0.2) = 0.76 right at the hit.
    const { eng } = makeEngine()
    define(eng, 'kick', dcGraph())
    define(eng, 'padFull', dcGraph())
    define(eng, 'padLite', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'kick', gain: 0 }) // silent source, still triggers
    send(eng, { kind: 'setChannel', synth: 'padFull', pan: 1, sidechain: 1 })
    send(eng, { kind: 'setChannel', synth: 'padLite', pan: 0, sidechain: 0.3 })
    send(eng, { kind: 'setSidechain', source: 'kick', depth: 0.8, releaseMs: 200 })
    send(eng, { kind: 'noteOn', synth: 'padFull', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'padLite', note: 60 })
    const n1 = 6000
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: n1 })
    const { L, R } = walk(eng, 130)
    // Before the hit both sit at PAD_FULL on their own leg.
    expect(R[n1 - 2]!).toBeCloseTo(PAD_FULL, 2)
    expect(L[n1 - 2]!).toBeCloseTo(PAD_FULL, 2)
    // Right at the hit: full ducks to ~0.2, lite only to ~0.76.
    expect(R[n1 + 2]!).toBeCloseTo(PAD_FULL * 0.2, 2)
    expect(L[n1 + 2]!).toBeCloseTo(PAD_FULL * 0.76, 2)
    // and the lite channel is clearly less ducked than the full one
    expect(L[n1 + 2]!).toBeGreaterThan(R[n1 + 2]!)
  })

  it('setChannel clamps the sidechain amount to [0, 1]; non-finite is atomic-rejected', () => {
    const { eng, events } = makeEngine()
    define(eng, 'kick', dcGraph())
    define(eng, 'pad', dcGraph())
    send(eng, { kind: 'setChannel', synth: 'kick', gain: 0 })
    send(eng, { kind: 'setChannel', synth: 'pad', pan: 1, sidechain: 5 }) // clamps to 1
    send(eng, { kind: 'setSidechain', source: 'kick', depth: 0.8, releaseMs: 200 })
    send(eng, { kind: 'noteOn', synth: 'pad', note: 60 })
    send(eng, { kind: 'noteOn', synth: 'kick', note: 60, atFrame: 6000 })
    const { R } = walk(eng, 130)
    // amount clamped to 1 → full duck to 1 - depth = 0.2 right at the hit
    expect(R[6002]!).toBeCloseTo(PAD_FULL * 0.2, 2)
    // a non-finite amount is rejected with an error (atomic, like gain/pan)
    send(eng, { kind: 'setChannel', synth: 'pad', sidechain: NaN } as unknown as EngineMessage)
    expect(errors(events).length).toBe(1)
  })

  it('malformed setSidechain emits an error and the engine keeps processing', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    expect(() =>
      send(eng, { kind: 'setSidechain', source: 42 as unknown as string }),
    ).not.toThrow()
    expect(errors(events).length).toBe(1)
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60 })
    const { L } = walk(eng, 2)
    expect(rms(L, BLOCK)).toBeCloseTo(DC_HALF, 3)
  })
})

describe('RealtimeEngine: budgets and queue bounds', () => {
  it('drops beyond MAX_PENDING_EVENTS with ONE coalesced error, stays alive', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    const n = 5000
    for (let i = 0; i < n; i++) {
      send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: 10_000_000 + i })
    }
    // 904 drops, but exactly one rate-limited report — not an event flood
    expect(errors(events).length).toBe(1)
    expect(errors(events)[0]!.message).toMatch(/queue full/)
    const { L } = walk(eng, 2)
    expect(rms(L)).toBe(0) // all queued events are far in the future
  })

  it('coalesces overflow drops: the next report carries the accumulated count', () => {
    const { eng, events } = makeEngine()
    define(eng, 'dc', dcGraph())
    const n = 5000
    for (let i = 0; i < n; i++) {
      send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: 10_000_000 + i })
    }
    expect(errors(events).length).toBe(1)
    expect(errors(events)[0]!.message).toMatch(/dropped 1 event/)
    // advance past the 1-second rate window, then overflow once more:
    // the report includes the 903 silent drops plus this one
    walk(eng, Math.ceil(SR / BLOCK) + 1)
    send(eng, { kind: 'noteOn', synth: 'dc', note: 60, atFrame: 20_000_000 })
    expect(errors(events).length).toBe(2)
    expect(errors(events)[1]!.message).toMatch(new RegExp(`dropped ${n - MAX_PENDING_EVENTS - 1 + 1} event`))
  })

  it('enforces the total voice budget across synths', () => {
    const { eng, events } = makeEngine()
    // Two synths each claiming half the budget fill it exactly (few enough
    // synths to test the VOICE budget, not the synth-count limit)...
    define(eng, 'a', dcGraph(), MAX_TOTAL_VOICES / 2)
    define(eng, 'b', dcGraph(), MAX_TOTAL_VOICES / 2)
    expect(errors(events)).toHaveLength(0)
    // ...so a third finds nothing left.
    define(eng, 'overflow', dcGraph(), 1)
    expect(errors(events).length).toBe(1)
    expect(errors(events)[0]!.kind === 'error' && errors(events)[0]!.message).toMatch(/budget/i)
  })

  it('enforces maxSynths', () => {
    const { eng, events } = makeEngine({ maxSynths: 2 })
    define(eng, 'a', dcGraph())
    define(eng, 'b', dcGraph())
    expect(errors(events)).toHaveLength(0)
    define(eng, 'c', dcGraph())
    expect(errors(events).length).toBe(1)
    // redefining an existing name is still allowed at the cap
    define(eng, 'a', dcGraph())
    expect(errors(events).length).toBe(1)
  })
})

describe('RealtimeEngine: per-synth FX post-chain', () => {
  // A short percussive pluck: dry decays fast so a shared reverb TAIL is easy
  // to isolate after noteOff. Built via synth(voiceFn, postFn).
  const pluckDef = (withPost: boolean) =>
    synth(
      ({ note, gate, sine, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.002, d: 0.06, s: 0, r: 0.02 })),
      withPost ? ({ input, reverb }) => input.mix(reverb(input), 0.6) : undefined,
    )

  const definePost = (eng: RealtimeEngine, name: string, def: { graph: GraphSpec; post?: GraphSpec }) =>
    send(eng, def.post !== undefined
      ? { kind: 'defineSynth', name, graph: def.graph, post: def.post }
      : { kind: 'defineSynth', name, graph: def.graph })

  it('a post reverb leaves a shared tail after noteOff (dry synth decays away)', () => {
    const dry = makeEngine()
    const wet = makeEngine()
    definePost(dry.eng, 'p', pluckDef(false))
    definePost(wet.eng, 'p', pluckDef(true))
    for (const e of [dry, wet]) {
      send(e.eng, { kind: 'noteOn', synth: 'p', note: 60 })
      send(e.eng, { kind: 'noteOff', synth: 'p', note: 60, atFrame: e.eng.currentFrame + 3000 })
    }
    // ~0.25s: the pluck (dry) has long decayed; only the post reverb tail lasts
    const blocks = Math.ceil((0.25 * SR) / BLOCK)
    const dOut = walk(dry.eng, blocks)
    const wOut = walk(wet.eng, blocks)
    const from = Math.floor(0.18 * SR)
    const dryTail = rms(dOut.L, from)
    const wetTail = rms(wOut.L, from)
    expect(wetTail).toBeGreaterThan(dryTail * 5)
    expect(wetTail).toBeGreaterThan(1e-4)
    expect(errors(dry.events)).toHaveLength(0)
    expect(errors(wet.events)).toHaveLength(0)
  })

  it('the post reverb widens the stereo image (L != R) of a centered synth', () => {
    const { eng } = makeEngine()
    definePost(eng, 'p', pluckDef(true))
    send(eng, { kind: 'noteOn', synth: 'p', note: 55 })
    const blocks = Math.ceil((0.3 * SR) / BLOCK)
    const { L, R } = walk(eng, blocks)
    // the two channels diverge (post reverb decorrelates); a no-post centered
    // synth would keep L == R exactly
    let diff = 0
    for (let i = 0; i < L.length; i++) diff += Math.abs(L[i]! - R[i]!)
    expect(diff / L.length).toBeGreaterThan(1e-5)
  })

  it('a bad post graph is rejected, leaving the prior synth untouched', () => {
    const { eng, events } = makeEngine()
    definePost(eng, 'p', pluckDef(false))
    // hand-roll a structurally invalid post graph (out references a missing node)
    send(eng, {
      kind: 'defineSynth',
      name: 'p',
      graph: pluckDef(false).graph,
      post: { nodes: [{ id: 0, type: 'businput', inputs: {} }], out: 99, params: [] },
    })
    expect(errors(events).length).toBe(1)
    // the good (no-post) synth still plays
    send(eng, { kind: 'noteOn', synth: 'p', note: 60 })
    const { L } = walk(eng, 3)
    expect(rms(L, 0, BLOCK)).toBeGreaterThan(1e-6)
  })
})

describe('RealtimeEngine: master glue compressor', () => {
  // a steady tone above the comp threshold, held while the note is on
  const toneGraph = (): GraphSpec => synth((c) => c.sine(220).mul(0.7).mul(c.gate)).graph
  const settledRms = (opts?: { comp?: EngineMessage }): number => {
    const { eng } = makeEngine()
    define(eng, 's', toneGraph())
    if (opts?.comp) send(eng, opts.comp)
    send(eng, { kind: 'noteOn', synth: 's', note: 60, velocity: 1 })
    walk(eng, 30) // let the tone + comp settle
    return rms(walk(eng, 20).L)
  }

  it('reduces a hot master vs bypass', () => {
    const baseline = settledRms()
    const comped = settledRms({
      comp: { kind: 'setMasterComp', threshold: -24, ratio: 10, attack: 5, release: 50 },
    })
    expect(comped).toBeLessThan(baseline * 0.9)
    expect(comped).toBeGreaterThan(0)
  })

  it('clearMasterComp restores the level', () => {
    const { eng } = makeEngine()
    define(eng, 's', toneGraph())
    send(eng, { kind: 'setMasterComp', threshold: -24, ratio: 10 })
    send(eng, { kind: 'noteOn', synth: 's', note: 60, velocity: 1 })
    walk(eng, 30)
    const comped = rms(walk(eng, 20).L)
    send(eng, { kind: 'clearMasterComp' })
    walk(eng, 30)
    const cleared = rms(walk(eng, 20).L)
    expect(cleared).toBeGreaterThan(comped)
  })

  it('malformed setMasterComp emits an error, engine keeps running', () => {
    const { eng, events } = makeEngine()
    define(eng, 's', toneGraph())
    send(eng, { kind: 'setMasterComp', ratio: NaN } as unknown as EngineMessage)
    expect(errors(events).length).toBeGreaterThan(0)
    send(eng, { kind: 'noteOn', synth: 's', note: 60, velocity: 1 })
    expect(() => walk(eng, 3)).not.toThrow()
  })
})

describe('RealtimeEngine: redefine retires the old pool (no voice cut)', () => {
  it('a sustaining voice keeps ringing across a redefine; new notes use the new pool', () => {
    const { eng, events } = makeEngine()
    define(eng, 'pad', acidGraph()) // adsr sustain 0.8
    send(eng, { kind: 'noteOn', synth: 'pad', note: 48 })
    walk(eng, 24) // reach sustain
    const before = rms(walk(eng, 24).L)
    expect(before).toBeGreaterThan(0.001)

    // Redefine WITHOUT a note-off: the old sustaining voice must ring on
    // (retired), not be cut to silence.
    define(eng, 'pad', acidGraph())
    const after = rms(walk(eng, 24).L)
    expect(after).toBeGreaterThan(before * 0.5)

    // A NEW note now plays on the new pool, adding to the still-ringing old one.
    send(eng, { kind: 'noteOn', synth: 'pad', note: 60 })
    const withNew = rms(walk(eng, 24).L)
    expect(withNew).toBeGreaterThan(after)
    expect(errors(events)).toEqual([])
  })

  it('reaps a retired pool after its voice is released and decays', () => {
    const { eng, events } = makeEngine()
    define(eng, 'pad', acidGraph())
    send(eng, { kind: 'noteOn', synth: 'pad', note: 48 })
    walk(eng, 12)
    define(eng, 'pad', acidGraph()) // retire old (note still gated on old pool)
    // note-off routes to the retired pool too, so the old voice releases…
    send(eng, { kind: 'noteOff', synth: 'pad', note: 48 })
    const L = walk(eng, 400).L // long enough for release + reap
    const tail = rms(L, L.length - 10 * BLOCK) // measure only the END of the window
    expect(tail).toBeLessThan(0.001) // fully silent (reaped, nothing stuck)
    expect(errors(events)).toEqual([])
  })
})
