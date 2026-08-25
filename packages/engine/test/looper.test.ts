import { describe, it, expect } from 'vitest'
import { LooperKernel } from '../src/dsp/looper'
import { synth, renderOffline } from '../src/index'
import { RealtimeEngine } from '../src/realtime'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/* Per-sample drive: each port is a function of the absolute sample index, so
 * a scenario reads as a timeline. Runs in `block`-sized chunks like the
 * engine does. */
interface Drive {
  in?: (i: number) => number
  rec?: (i: number) => number
  feedback?: (i: number) => number
  mix?: (i: number) => number
  clear?: (i: number) => number
}

const run = (k: LooperKernel, n: number, d: Drive, block = 128): Float32Array => {
  const out = new Float32Array(n)
  for (let at = 0; at < n; at += block) {
    const m = Math.min(block, n - at)
    const port = (f: ((i: number) => number) | undefined, def: number): Float32Array => {
      const a = new Float32Array(m)
      for (let i = 0; i < m; i++) a[i] = f ? f(at + i) : def
      return a
    }
    k.process(
      m,
      {
        in: port(d.in, 0),
        rec: port(d.rec, 0),
        feedback: port(d.feedback, 1),
        mix: port(d.mix, 1),
        clear: port(d.clear, 0),
      },
      out.subarray(at, at + m),
      ctx,
    )
  }
  return out
}

/** A recognizable 1000-sample phrase (bounded well inside the soft knee). */
const phrase = (i: number): number => 0.5 * Math.sin(i * 0.01) + 0.25 * Math.sin(i * 0.037)

describe('LooperKernel', () => {
  it('records while rec is high, then loops it back sample-exact, dry always passing', () => {
    const L = 1000
    const out = run(new LooperKernel(), 3 * L + 500, {
      in: (i) => (i < L ? phrase(i) : 0),
      rec: (i) => (i < L ? 1 : 0),
    })
    // during the first recording there is no loop yet: output is the dry input
    expect(out[300]!).toBeCloseTo(phrase(300), 6)
    // after release the loop plays from the top, sample-exact, pass after pass
    for (const pass of [1, 2, 3]) {
      for (const kk of [0, 1, 250, 999]) {
        const at = pass * L + kk
        if (at >= out.length) continue
        expect(out[at]!, `pass ${pass} sample ${kk}`).toBeCloseTo(phrase(kk), 6)
      }
    }
  })

  it('the dry input passes at unity on top of the loop (out = in + mix*loop)', () => {
    const L = 1000
    const out = run(new LooperKernel(), 2 * L, {
      in: (i) => (i < L ? 0.5 : i === L + 100 ? 0.25 : 0), // live playing over the loop
      rec: (i) => (i < L ? 1 : 0),
    })
    expect(out[L + 100]!).toBeCloseTo(0.5 + 0.25, 6) // loop layer + live layer
    expect(out[L + 101]!).toBeCloseTo(0.5, 6)
  })

  it('mix scales the LOOP only, never the dry path', () => {
    const L = 1000
    const out = run(new LooperKernel(), 2 * L, {
      in: (i) => (i < L ? 0.5 : i === L + 100 ? 0.25 : 0),
      rec: (i) => (i < L ? 1 : 0),
      mix: () => 0.5,
    })
    expect(out[L + 100]!).toBeCloseTo(0.5 * 0.5 + 0.25, 6)
  })

  it('overdub sums a new layer while the loop plays; playback alone never erodes it', () => {
    const L = 1000
    const out = run(new LooperKernel(), 5 * L, {
      in: (i) => (i === 0 ? 0.5 : i === 2 * L + 100 ? 0.25 : 0),
      // record the first pass, then punch in for exactly one later pass
      rec: (i) => (i < L ? 1 : i >= 2 * L && i < 3 * L ? 1 : 0),
    })
    // the original layer, before and after the overdub pass, at full strength
    expect(out[L]!).toBeCloseTo(0.5, 6)
    expect(out[4 * L]!).toBeCloseTo(0.5, 6)
    // the overdubbed hit plays on every later pass at slot 100
    expect(out[3 * L + 100]!).toBeCloseTo(0.25, 6)
    expect(out[4 * L + 100]!).toBeCloseTo(0.25, 6)
  })

  it('feedback fades earlier layers per overdub pass, and only then', () => {
    const L = 1000
    const out = run(new LooperKernel(), 5 * L, {
      in: (i) => (i === 0 ? 0.5 : 0),
      rec: (i) => (i < L ? 1 : i >= 2 * L && i < 3 * L ? 1 : 0),
      feedback: () => 0.5,
    })
    expect(out[L]!).toBeCloseTo(0.5, 6) // playback pass: untouched
    expect(out[3 * L]!).toBeCloseTo(0.25, 6) // one overdub pass at fb .5: halved
    expect(out[4 * L]!).toBeCloseTo(0.25, 6) // then stable again
  })

  it('clear wipes on a rising edge, and the next press defines a NEW length', () => {
    const L = 1000
    const L2 = 400
    const out = run(new LooperKernel(), 6 * L, {
      in: (i) => (i < L ? phrase(i) : i >= 3 * L && i < 3 * L + L2 ? 0.3 : 0),
      rec: (i) => (i < L ? 1 : i >= 3 * L && i < 3 * L + L2 ? 1 : 0),
      clear: (i) => (i >= 2 * L + 500 && i < 2 * L + 510 ? 1 : 0),
    })
    expect(out[2 * L + 250]!).toBeCloseTo(phrase(250), 6) // still looping before clear
    expect(out[2 * L + 600]!).toBe(0) // wiped: dry-only, and the dry is silent
    // the second take loops at ITS length (400), not the old 1000
    expect(out[3 * L + L2 + 50]!).toBeCloseTo(0.3, 6)
    expect(out[3 * L + 3 * L2 + 50]!).toBeCloseTo(0.3, 6)
  })

  it('a first recording that overruns maxTime closes the loop at the buffer, like a pedal', () => {
    const cap = Math.ceil(0.1 * sr) // 4800 samples: the smallest memory (maxTime clamps to 0.1 s)
    const out = run(new LooperKernel({ maxTime: 0.1 }), 4 * cap, {
      in: (i) => (i < cap ? phrase(i) : 0),
      rec: (i) => (i < 3 * cap ? 1 : 0), // held way past the memory
    })
    // loop closed at cap and repeats with period cap (rec-high tail overdubs
    // silence at feedback 1, which changes nothing)
    for (const kk of [0, 100, cap - 1]) {
      expect(out[cap + kk]!, `sample ${kk}`).toBeCloseTo(phrase(kk), 6)
      expect(out[3 * cap + kk]!, `sample ${kk}, later pass`).toBeCloseTo(phrase(kk), 6)
    }
  })

  it('is block-size invariant', () => {
    const scenario: Drive = {
      in: (i) => (i < 900 ? phrase(i) : i === 2000 ? 0.25 : 0),
      rec: (i) => (i < 900 ? 1 : i >= 1800 && i < 2700 ? 1 : 0),
      feedback: () => 0.7,
    }
    const a = run(new LooperKernel(), 4000, scenario, 128)
    const b = run(new LooperKernel(), 4000, scenario, 4000)
    expect(a).toEqual(b)
  })

  it('a NaN write zeroes the loop content at block end but keeps the length', () => {
    const L = 1000
    const out = run(new LooperKernel(), 3 * L, {
      in: (i) => (i < 500 ? 0.5 : i === 500 ? Number.NaN : 0),
      rec: (i) => (i < L ? 1 : 0),
    })
    for (let i = L; i < 3 * L; i++) {
      expect(Number.isFinite(out[i]!), `sample ${i} finite`).toBe(true)
      expect(out[i]!).toBe(0) // content wiped, loop silent — but still a loop
    }
  })

  it('reset returns to EMPTY', () => {
    const k = new LooperKernel()
    run(k, 2000, { in: (i) => (i < 1000 ? 0.5 : 0), rec: (i) => (i < 1000 ? 1 : 0) })
    k.reset()
    const out = run(k, 1000, {})
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

/* End to end: a mic loop pedal in a real synth graph, rec driven by a synced
 * square LFO — the transport quantizes the loop, no transport plumbing in the
 * kernel. lfo(2, 'square', {sync}) at the default 0.5 cps is a 4 s period,
 * high for the first 2 s: record two seconds of singing, then it loops. */
describe('looper end to end (mic -> looper in a synth graph)', () => {
  const DUR = 4
  const TOTAL = sr * DUR
  const take = new Float32Array(TOTAL)
  for (let i = 0; i < sr * 2; i++) take[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr)

  const rms = (a: Float32Array, from: number, to: number): number => {
    let s = 0
    for (let i = from; i < to; i++) s += a[i]! * a[i]!
    return Math.sqrt(s / (to - from))
  }

  it('what was sung in the first half plays again in the second', () => {
    const s = synth(({ mic, looper, lfo }: any) => looper(mic(), lfo(2, 'square', { sync: true })))
    const out = renderOffline(
      s,
      [{ time: 0, type: 'noteOn', note: 60 }, { time: DUR - 0.001, type: 'noteOff', note: 60 }],
      DUR,
      { mic: take },
    ).left
    const live = rms(out, Math.floor(0.5 * sr), Math.floor(1.5 * sr))
    const looped = rms(out, Math.floor(2.5 * sr), Math.floor(3.5 * sr))
    expect(live).toBeGreaterThan(0.15) // the dry mic passes while recording
    // the mic is silent after 2 s: everything here is the LOOP playing back
    expect(looped).toBeGreaterThan(0.15)
    expect(looped).toBeCloseTo(live, 1)
  })
})

/* bounceLoop: the pedal's loop, copied out of a REAL RealtimeEngine through
 * the message/event protocol. The looper lives in the POST chain — the right
 * home for a pedal (per-synth, survives voices) and the reason the bounce is
 * well-defined: a voice-graph looper registers once per voice and only the
 * last would win. */
describe('bounceLoop (realtime message -> loopBounced event)', () => {
  const SR = 48000
  const rig = () => {
    const events: import('../src/protocol').EngineEvent[] = []
    const eng = new RealtimeEngine({ sampleRate: SR })
    eng.onEvent = (ev) => events.push(ev)
    const def = synth(
      ({ mic }: any) => mic(),
      ({ input, looper, param }: any) => looper(input, param('rec', 0, { max: 1 }), { name: 'jam' }),
    )
    eng.handleMessage({ kind: 'defineSynth', name: 'pedal', graph: def.graph, post: def.post })
    eng.handleMessage({ kind: 'noteOn', synth: 'pedal', note: 60 })
    return { eng, events }
  }
  /** run `blocks` engine blocks, feeding a 440 Hz mic sine of amplitude 0.5. */
  const run = (eng: RealtimeEngine, blocks: number, from: number): number => {
    const outL = new Float32Array(128)
    const outR = new Float32Array(128)
    const mic = new Float32Array(128)
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 128; i++) mic[i] = 0.5 * Math.sin((2 * Math.PI * 440 * (from + b * 128 + i)) / SR)
      eng.writeMic(mic)
      eng.process(outL, outR, from + b * 128)
    }
    return from + blocks * 128
  }

  it('bounces exactly the recorded span, and honors a sample-name override', () => {
    const { eng, events } = rig()
    let at = run(eng, 4, 0) // pedal idle
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 1 })
    at = run(eng, 8, at) // record 8 blocks
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 0 })
    at = run(eng, 2, at) // play
    eng.handleMessage({ kind: 'bounceLoop', looper: 'jam', sample: 'take9' })
    const ev = events.find((e) => e.kind === 'loopBounced')
    expect(ev, `no loopBounced; errors: ${JSON.stringify(events.filter((e) => e.kind === 'error'))}`).toBeDefined()
    if (ev?.kind !== 'loopBounced') return
    expect(ev.looper).toBe('jam')
    expect(ev.sample).toBe('take9')
    expect(ev.sampleRate).toBe(SR)
    expect(ev.frames).toBe(8 * 128) // setParam applies at block edges: exact
    expect(ev.data.length).toBe(8 * 128)
    // content: the post chain hears the voice sum (equal-power center pan),
    // so the loop is the mic sine scaled by ~0.7071 — assert via RMS
    let sum = 0
    for (const v of ev.data) sum += v * v
    const rms = Math.sqrt(sum / ev.data.length)
    expect(rms).toBeCloseTo(0.5 * Math.SQRT1_2 * Math.SQRT1_2, 2)
  })

  it('an empty pedal and an unknown name each answer with an error event, not silence', () => {
    const { eng, events } = rig()
    run(eng, 2, 0)
    eng.handleMessage({ kind: 'bounceLoop', looper: 'jam' })
    eng.handleMessage({ kind: 'bounceLoop', looper: 'nope' })
    const errs = events.filter((e) => e.kind === 'error').map((e) => (e.kind === 'error' ? e.message : ''))
    expect(errs.some((m) => m.includes("'jam' is empty")), errs.join(' | ')).toBe(true)
    expect(errs.some((m) => m.includes("no looper named 'nope'")), errs.join(' | ')).toBe(true)
    expect(events.some((e) => e.kind === 'loopBounced')).toBe(false)
  })

  it('defaults the sample name to the looper name, and a re-bounce reflects the loop NOW', () => {
    const { eng, events } = rig()
    let at = 0
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 1 })
    at = run(eng, 4, at)
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 0 })
    at = run(eng, 1, at)
    eng.handleMessage({ kind: 'bounceLoop', looper: 'jam' })
    // overdub a pass of DC (orthogonal to the sine — a second sine at a later
    // absolute time lands at arbitrary phase and can partially CANCEL, which
    // is real pedal behavior but a useless assertion), then bounce again
    const outL = new Float32Array(128)
    const outR = new Float32Array(128)
    const dc = new Float32Array(128).fill(0.4)
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 1 })
    for (let b = 0; b < 4; b++) {
      eng.writeMic(dc)
      eng.process(outL, outR, at)
      at += 128
    }
    eng.handleMessage({ kind: 'setParam', synth: 'pedal', name: 'rec', value: 0 })
    eng.handleMessage({ kind: 'bounceLoop', looper: 'jam' })
    const evs = events.filter((e) => e.kind === 'loopBounced')
    expect(evs).toHaveLength(2)
    if (evs[0]?.kind !== 'loopBounced' || evs[1]?.kind !== 'loopBounced') return
    expect(evs[0].sample).toBe('jam')
    const rms = (d: Float32Array): number => {
      let s = 0
      for (const v of d) s += v * v
      return Math.sqrt(s / d.length)
    }
    expect(evs[1].data.length).toBe(evs[0].data.length) // same loop length
    // the difference between the two bounces IS the overdubbed DC layer,
    // scaled by the voice-sum center pan (0.7071)
    const diff = evs[1].data.map((v, i) => v - (evs[0].data[i] ?? 0))
    expect(rms(diff as Float32Array)).toBeCloseTo(0.4 * Math.SQRT1_2, 2)
  })
})
