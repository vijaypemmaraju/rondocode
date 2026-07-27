import { describe, it, expect } from 'vitest'
import { LfoKernel } from '../src/dsp/lfo'
import { DelayKernel } from '../src/dsp/delay'
import { cpsOf, DEFAULT_CPS } from '../src/dsp/util'
import { synth } from '../src/builder'
import { renderOffline } from '../src/render'
import { RealtimeEngine } from '../src/realtime'
import { BLOCK } from '../src/compile'
import type { EngineEvent, EngineMessage } from '../src/protocol'
import type { DspContext } from '../src/dsp/types'

/* ------------------------------------------------------------------------- *
 * TEMPO SYNC: `sync` turns an lfo's rate and a delay's time from absolute
 * units (Hz / seconds) into MUSICAL ones (transport cycles), read off
 * ctx.cps per block. Everything here is measured — periods counted between
 * phase wraps, echo positions read off an impulse response — never eyeballed.
 * ------------------------------------------------------------------------- */

const SR = 48000

/** Sample index of every phase wrap of a synced/unsynced SAW lfo: the saw's
 *  only descending step per period, so consecutive gaps ARE the period in
 *  samples. Blocks let a test change ctx.cps mid-run. */
const runLfo = (
  k: LfoKernel,
  ctx: DspContext,
  rate: number,
  n: number,
  onBlock?: (blockStart: number) => void,
  block = 128,
): Float32Array => {
  const out = new Float32Array(n)
  const freq = new Float32Array(block).fill(rate)
  for (let i = 0; i < n; i += block) {
    const len = Math.min(block, n - i)
    onBlock?.(i)
    k.process(len, { freq: freq.subarray(0, len) }, out.subarray(i, i + len), ctx)
  }
  return out
}

const wraps = (out: Float32Array): number[] => {
  const at: number[] = []
  for (let i = 1; i < out.length; i++) if (out[i]! < out[i - 1]!) at.push(i)
  return at
}

/** Sample index of the loudest sample — the echo tap of an impulse response. */
const peakIndex = (out: Float32Array): number => {
  let peak = 0
  let at = -1
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i]!)
    if (v > peak) {
      peak = v
      at = i
    }
  }
  return at
}

/** Impulse response of one delay kernel: a single 1.0 at sample 0, no feedback. */
const delayImpulse = (
  k: DelayKernel,
  ctx: DspContext,
  time: number,
  n: number,
  onBlock?: (blockStart: number) => void,
  block = 128,
): Float32Array => {
  const out = new Float32Array(n)
  const inp = new Float32Array(block)
  const timeBuf = new Float32Array(block).fill(time)
  const fb = new Float32Array(block)
  for (let i = 0; i < n; i += block) {
    const len = Math.min(block, n - i)
    onBlock?.(i)
    inp.fill(0)
    if (i === 0) inp[0] = 1
    k.process(
      len,
      { in: inp.subarray(0, len), time: timeBuf.subarray(0, len), feedback: fb.subarray(0, len) },
      out.subarray(i, i + len),
      ctx,
    )
  }
  return out
}

describe('cpsOf', () => {
  it('falls back to 0.5 cps for a ctx with no tempo, and for garbage', () => {
    expect(DEFAULT_CPS).toBe(0.5)
    expect(cpsOf({ })).toBe(DEFAULT_CPS)
    expect(cpsOf({ cps: NaN })).toBe(DEFAULT_CPS)
    expect(cpsOf({ cps: 0 })).toBe(DEFAULT_CPS)
    expect(cpsOf({ cps: -2 })).toBe(DEFAULT_CPS)
    expect(cpsOf({ cps: Infinity })).toBe(DEFAULT_CPS)
    expect(cpsOf({ cps: 0.8 })).toBe(0.8)
  })
})

describe('synced LFO: rate is a length in cycles', () => {
  it('rate 1 at cps 0.5 completes exactly one period per 2 seconds', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const out = runLfo(new LfoKernel('saw', undefined, true), ctx, 1, SR * 9)
    const at = wraps(out)
    expect(at.length).toBe(4) // 9 s of a 2 s period: wraps at 2, 4, 6, 8 s
    for (let i = 0; i < at.length; i++) {
      // period = 1 cycle / 0.5 cps = 2.000 s; within one sample of it
      expect(Math.abs(at[i]! - (i + 1) * 2 * SR)).toBeLessThanOrEqual(1)
    }
  })

  it('a quarter-note rate (0.25 cycles) at cps 0.5 is a 0.5 s period', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    // 2.05 s, so the four wraps (0.5, 1.0, 1.5, 2.0) all land strictly inside
    const at = wraps(runLfo(new LfoKernel('saw', undefined, true), ctx, 0.25, Math.round(SR * 2.05)))
    expect(at.length).toBe(4)
    expect(at[0]! / SR).toBeCloseTo(0.5, 4)
    expect((at[3]! - at[2]!) / SR).toBeCloseTo(0.5, 4)
  })

  it('halving cps doubles the period (2.0 s -> 4.0 s), same kernel, same rate', () => {
    const fast = wraps(runLfo(new LfoKernel('saw', undefined, true), { sampleRate: SR, cps: 0.5 }, 1, SR * 9))
    const slow = wraps(runLfo(new LfoKernel('saw', undefined, true), { sampleRate: SR, cps: 0.25 }, 1, SR * 9))
    expect(fast[0]! / SR).toBeCloseTo(2, 3)
    expect(slow[0]! / SR).toBeCloseTo(4, 3)
    expect(slow[0]! / fast[0]!).toBeCloseTo(2, 3)
  })

  it('an UNSYNCED lfo is bit-identical at any tempo (rate stays Hz)', () => {
    const a = runLfo(new LfoKernel('sine'), { sampleRate: SR, cps: 0.5 }, 3, SR)
    const b = runLfo(new LfoKernel('sine'), { sampleRate: SR, cps: 2 }, 3, SR)
    const c = runLfo(new LfoKernel('sine'), { sampleRate: SR }, 3, SR)
    expect(Array.from(b)).toEqual(Array.from(a))
    expect(Array.from(c)).toEqual(Array.from(a))
    // and it really is 3 Hz: three wraps per second
    expect(wraps(runLfo(new LfoKernel('saw'), { sampleRate: SR, cps: 4 }, 3, Math.round(SR * 1.05))).length).toBe(3)
  })

  it('a tempo change re-rates the LFO live, with NO phase discontinuity', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const n = SR * 4
    // tri (continuous, unlike saw) so a phase jump would show up as a step
    const out = runLfo(new LfoKernel('tri', undefined, true), ctx, 1, n, (i) => {
      if (i >= SR) ctx.cps = 1 // double the tempo one second in
    })
    // The steepest legal step is one period's worth of slope per sample at the
    // FASTER tempo (1 cps / rate 1 -> 1 Hz tri, slope 2 per period).
    const maxStep = (2 * 1) / SR
    let worst = 0
    for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(out[i]! - out[i - 1]!))
    // 1% of headroom for the float32 quantization of the output buffer; a
    // phase JUMP would be orders of magnitude over this, not 1%.
    expect(worst).toBeLessThanOrEqual(maxStep * 1.01)
    // and the rate really did double: first period 2 s, later periods 1 s
    const at = wraps(runLfo(new LfoKernel('saw', undefined, true), { sampleRate: SR, cps: 0.5 }, 1, n, () => {}))
    expect(at[0]! / SR).toBeCloseTo(2, 3)
    const ctx2: DspContext = { sampleRate: SR, cps: 0.5 }
    const at2 = wraps(runLfo(new LfoKernel('saw', undefined, true), ctx2, 1, n, (i) => {
      if (i >= SR * 2.5) ctx2.cps = 1
    }))
    expect(at2[0]! / SR).toBeCloseTo(2, 3) // wrapped before the change
    // The period spanning the change is PART-OLD, PART-NEW, exactly as a
    // phase-continuous re-rate must be: 0.5 s of the 2 s period elapses at the
    // old tempo (a quarter of the way round), the remaining 0.75 of a turn
    // runs at 1 Hz — 0.5 + 0.75 = 1.25 s.
    expect((at2[1]! - at2[0]!) / SR).toBeCloseTo(1.25, 2)
    expect(at2.length).toBe(2) // the next wrap (4.25 s) is past the 4 s buffer
  })

  it('rate 0 parks the LFO (holds its level) instead of emitting NaN', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const k = new LfoKernel('sine', undefined, true)
    const out = runLfo(k, ctx, 0, SR)
    for (let i = 0; i < out.length; i++) {
      expect(Number.isFinite(out[i]!)).toBe(true)
      expect(out[i]!).toBe(out[0]!) // frozen, not drifting
    }
  })

  it('a NaN rate costs at most one block: the phase flushes and recovers', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const k = new LfoKernel('saw', undefined, true)
    const bad = new Float32Array(128).fill(NaN)
    const out = new Float32Array(128)
    k.process(128, { freq: bad }, out, ctx)
    const good = runLfo(k, ctx, 0.25, Math.round(SR * 1.05))
    for (let i = 0; i < good.length; i++) expect(Number.isFinite(good[i]!)).toBe(true)
    expect(wraps(good).length).toBe(2) // 1.05 s of a 0.5 s period
  })

  it('44.1 kHz: the musical period is the same wall-clock time', () => {
    const ctx: DspContext = { sampleRate: 44100, cps: 0.5 }
    const at = wraps(runLfo(new LfoKernel('saw', undefined, true), ctx, 0.25, Math.round(44100 * 2.05)))
    expect(at.length).toBe(4)
    expect(at[0]! / 44100).toBeCloseTo(0.5, 4)
  })
})

describe('synced delay: time is a length in cycles', () => {
  it('a quarter note (0.25 cycles) at cps 0.5 echoes at 0.500 s', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const k = new DelayKernel({ maxTime: 2, sync: true }, ctx)
    const at = peakIndex(delayImpulse(k, ctx, 0.25, SR))
    expect(at / SR).toBeCloseTo(0.5, 3)
  })

  it('a dotted eighth (0.1875 cycles) at cps 0.55 echoes at 0.341 s', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.55 }
    const k = new DelayKernel({ maxTime: 2, sync: true }, ctx)
    const at = peakIndex(delayImpulse(k, ctx, 0.1875, SR))
    expect(at / SR).toBeCloseTo(0.1875 / 0.55, 3)
  })

  it('halving cps doubles the echo time; an UNSYNCED delay does not move', () => {
    const slowCtx: DspContext = { sampleRate: SR, cps: 0.25 }
    const synced = new DelayKernel({ maxTime: 4, sync: true }, slowCtx)
    expect(peakIndex(delayImpulse(synced, slowCtx, 0.25, SR * 2)) / SR).toBeCloseTo(1, 3)

    const plain = new DelayKernel({ maxTime: 4 }, slowCtx)
    expect(peakIndex(delayImpulse(plain, slowCtx, 0.25, SR * 2)) / SR).toBeCloseTo(0.25, 3)
    const fastCtx: DspContext = { sampleRate: SR, cps: 2 }
    const plain2 = new DelayKernel({ maxTime: 4 }, fastCtx)
    expect(peakIndex(delayImpulse(plain2, fastCtx, 0.25, SR * 2)) / SR).toBeCloseTo(0.25, 3)
  })

  it('a tempo change GLIDES the read head: an order of magnitude smoother than a jump', () => {
    // Same tone, same 0.5 s -> 0.25 s move, two ways: synced (tempo doubles,
    // the kernel glides) vs unsynced (the time input jumps). Measure the worst
    // sample-to-sample step in each — a jumped read head splices unrelated
    // buffer content and steps by most of a peak-to-peak.
    // 23 Hz: smooth (tiny per-sample slope) and deliberately NOT a whole
    // number of periods per 0.25 s, so a spliced tap lands on a different
    // phase instead of accidentally lining up.
    const tone = (n: number): Float32Array => {
      const b = new Float32Array(n)
      for (let i = 0; i < n; i++) b[i] = 0.5 * Math.sin((2 * Math.PI * 23 * i) / SR)
      return b
    }
    const n = SR * 2
    const src = tone(n)
    const block = 128
    const run = (sync: boolean): Float32Array => {
      const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
      const k = new DelayKernel({ maxTime: 2, sync }, ctx)
      const out = new Float32Array(n)
      const timeBuf = new Float32Array(block)
      const fb = new Float32Array(block)
      for (let i = 0; i < n; i += block) {
        const moved = i >= SR
        if (sync) {
          ctx.cps = moved ? 1 : 0.5 // 0.25 cycles: 0.5 s -> 0.25 s
          timeBuf.fill(0.25)
        } else {
          timeBuf.fill(moved ? 0.25 : 0.5) // the same move, in seconds
        }
        k.process(block, { in: src.subarray(i, i + block), time: timeBuf, feedback: fb }, out.subarray(i, i + block), ctx)
      }
      return out
    }
    const worstStep = (b: Float32Array): number => {
      let worst = 0
      for (let i = SR - 1000; i < b.length; i++) worst = Math.max(worst, Math.abs(b[i]! - b[i - 1]!))
      return worst
    }
    const glided = worstStep(run(true))
    const jumped = worstStep(run(false))
    expect(jumped).toBeGreaterThan(0.3) // a splice: a big fraction of peak-to-peak
    expect(glided).toBeLessThan(jumped / 4)
    for (const v of run(true)) expect(Number.isFinite(v)).toBe(true)
  })

  it('the glide settles: after a tempo change the echo lands at the NEW musical time', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const k = new DelayKernel({ maxTime: 2, sync: true }, ctx)
    // warm the follower up at 0.5 cps, then change tempo and let it settle
    delayImpulse(k, ctx, 0.25, SR)
    ctx.cps = 1
    const settle = new Float32Array(128)
    for (let i = 0; i < SR; i += 128) {
      k.process(128, { in: new Float32Array(128), time: new Float32Array(128).fill(0.25), feedback: new Float32Array(128) }, settle, ctx)
    }
    const at = peakIndex(delayImpulse(k, ctx, 0.25, SR))
    expect(at / SR).toBeCloseTo(0.25, 3) // 0.25 cycles at 1 cps
  })

  it('maxTime is still SECONDS: a synced time past it saturates instead of running away', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.1 } // 1 cycle = 10 s
    const k = new DelayKernel({ maxTime: 0.5, sync: true }, ctx)
    // 0.25 cycles = 2.5 s, well past the 0.5 s buffer
    const at = peakIndex(delayImpulse(k, ctx, 0.25, SR))
    expect(at / SR).toBeCloseTo(0.5, 2)
  })

  it('a NaN time falls back to the 1-sample minimum and never poisons the line', () => {
    const ctx: DspContext = { sampleRate: SR, cps: 0.5 }
    const k = new DelayKernel({ maxTime: 2, sync: true }, ctx)
    const out = new Float32Array(256)
    k.process(
      256,
      { in: new Float32Array(256).fill(0.5), time: new Float32Array(256).fill(NaN), feedback: new Float32Array(256) },
      out,
      ctx,
    )
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    // recovers on the next, sane block
    const good = delayImpulse(k, ctx, 0.25, SR)
    expect(peakIndex(good) / SR).toBeCloseTo(0.5, 3)
  })
})

describe('tempo sync end to end: graph, render and engine', () => {
  /** A synth whose OUTPUT is the synced LFO itself, as a bipolar saw ramp:
   *  wraps in the rendered audio are the LFO's periods, so a bounce can be
   *  measured with the same wraps() the kernel tests use. */
  const rampSynth = () => synth(({ lfo }) => lfo(0.25, 'saw', { sync: true }).mul(2).sub(1))

  const wobble = () =>
    synth(({ note, gate, adsr, saw, svf, lfo }) =>
      svf(saw(note.freq), lfo(0.25, 'tri', { sync: true }).range(300, 4000), { res: 0.2 }).mul(adsr(gate, { a: 0.005, d: 0.1, s: 1, r: 0.05 })))

  it('the builder puts sync in the node config, and only when asked', () => {
    const plain = synth(({ note, lfo, delay }) => delay(lfo(2).range(-1, 1), 0.25, 0.2).add(note.freq.mul(0)))
    for (const n of plain.graph.nodes) {
      if (n.type === 'lfo' || n.type === 'delay') expect(n.config?.['sync']).toBeUndefined()
    }
    const synced = synth(({ note, lfo, delay }) =>
      delay(lfo(0.25, { sync: true }).range(-1, 1), 0.1875, 0.2, { sync: true }).add(note.freq.mul(0)))
    const lfoNode = synced.graph.nodes.find((n) => n.type === 'lfo')!
    const delayNode = synced.graph.nodes.find((n) => n.type === 'delay')!
    expect(lfoNode.config).toMatchObject({ sync: true })
    expect(lfoNode.config?.['shape']).toBeUndefined() // opts in the shape slot
    expect(delayNode.config).toMatchObject({ sync: true, maxTime: 0.5 })
  })

  it('renderOffline rejects a nonsense cps rather than rendering silence', () => {
    const def = wobble()
    const ev = [{ time: 0, type: 'noteOn' as const, note: 48 }]
    expect(() => renderOffline(def, ev, 0.1, { cps: 0 })).toThrow(/cps must be > 0/)
    expect(() => renderOffline(def, ev, 0.1, { cps: NaN })).toThrow(/cps must be > 0/)
  })

  it('renderOffline rates a synced LFO off the cps it was given', () => {
    // The synth IS the LFO: a bipolar saw ramp, so wraps in the rendered audio
    // are the LFO's periods, measured straight off the bounce.
    const ev = [{ time: 0, type: 'noteOn' as const, note: 60, velocity: 1 }]
    const fast = renderOffline(rampSynth(), ev, 2.05, { cps: 0.5, sampleRate: SR })
    const slow = renderOffline(rampSynth(), ev, 2.05, { cps: 0.25, sampleRate: SR })
    const dflt = renderOffline(rampSynth(), ev, 2.05, { sampleRate: SR })
    // 0.25 cycles at 0.5 cps = a 0.5 s period; at 0.25 cps = 1 s
    expect(wraps(fast.left).length).toBe(4)
    expect(wraps(slow.left).length).toBe(2)
    expect(wraps(fast.left)[0]! / SR).toBeCloseTo(0.5, 3)
    expect(wraps(slow.left)[0]! / SR).toBeCloseTo(1, 3)
    // no cps passed = the documented 0.5 default, sample-identical to passing it
    expect(Array.from(dflt.left)).toEqual(Array.from(fast.left))
  })

  it('the LIVE engine sweeps at the same musical rate the offline bounce does', () => {
    const events: EngineEvent[] = []
    const ctx: DspContext = { sampleRate: SR }
    const eng = new RealtimeEngine(ctx)
    eng.onEvent = (e) => events.push(e)
    const send = (m: EngineMessage): void => eng.handleMessage(m)
    send({ kind: 'defineSynth', name: 'r', graph: rampSynth().graph, maxVoices: 1 })
    send({ kind: 'setCps', cps: 0.25 })
    expect(ctx.cps).toBe(0.25)
    send({ kind: 'setChannel', synth: 'r', gain: 1, pan: 0 }) // hard left, full level
    send({ kind: 'setMaster', gain: 1 })
    send({ kind: 'noteOn', synth: 'r', note: 60, velocity: 1 })
    const n = Math.round(SR * 2.05)
    const render = (from: number): Float32Array => {
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      for (let i = 0; i + BLOCK <= n; i += BLOCK) {
        eng.process(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK), from + i)
      }
      // Skip the FIRST block: setChannel/setMaster ramp their strip over one
      // block, which walks the level and is not the LFO's doing.
      return L.subarray(BLOCK, n - (n % BLOCK))
    }
    const first = render(0)
    expect(events.filter((e) => e.kind === 'error')).toEqual([])
    // the 1 s period the offline render produces at this tempo, live
    expect(wraps(first).length).toBe(2)
    expect(wraps(first)[0]! / SR).toBeCloseTo(1, 2)
    // and the tempo is LIVE: a setCps mid-note re-rates the sweep with no
    // redefine and no retrigger — the same voice, four times faster.
    send({ kind: 'setCps', cps: 1 })
    expect(wraps(render(n)).length).toBe(8) // 0.25 s period
    expect(events.filter((e) => e.kind === 'error')).toEqual([])
  })

  it('setCps validates and clamps; a bad one errors without disturbing the tempo', () => {
    const events: EngineEvent[] = []
    const ctx: DspContext = { sampleRate: SR }
    const eng = new RealtimeEngine(ctx)
    eng.onEvent = (e) => events.push(e)
    expect(ctx.cps).toBe(DEFAULT_CPS) // the engine publishes a default
    eng.handleMessage({ kind: 'setCps', cps: 0.8 })
    expect(ctx.cps).toBe(0.8)
    eng.handleMessage({ kind: 'setCps', cps: NaN } as unknown as EngineMessage)
    expect(ctx.cps).toBe(0.8)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'error', context: 'setCps' })
    eng.handleMessage({ kind: 'setCps', cps: 1e9 })
    expect(ctx.cps).toBe(100)
    eng.handleMessage({ kind: 'setCps', cps: -3 })
    expect(ctx.cps).toBe(0.001)
  })
})
