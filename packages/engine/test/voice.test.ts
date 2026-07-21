import { describe, it, expect } from 'vitest'
import { BLOCK, compileGraph } from '../src/compile'
import { Voice, VoicePool } from '../src/voice'
import { GraphSpec } from '../src/graph'
import type { DspContext } from '../src/dsp/types'
import { goertzel } from './util/goertzel'

const ctx: DspContext = { sampleRate: 48000 }
const SR = ctx.sampleRate

const node = (id: number, type: any, inputs = {}, config?: Record<string, unknown>): any => ({
  id,
  type,
  inputs,
  ...(config ? { config } : {}),
})

/** saw -> ladder (param cutoff) -> mul by adsr -> out. Fast release (0.01) so
 *  decay tests stay short. */
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
  params: [{ name: 'cutoff', default: 1000, min: 80, max: 8000, curve: 'log' }],
})

/** sine * adsr -> out: clean spectrum for multi-note Goertzel checks. */
const sineAdsrSpec = (): GraphSpec => ({
  nodes: [
    node(0, 'notefreq'),
    node(1, 'sine', { freq: { node: 0 } }),
    node(2, 'gate'),
    node(3, 'adsr', { gate: { node: 2 } }, { a: 0.005, d: 0.05, s: 0.8, r: 0.01 }),
    node(4, 'mul', { a: { node: 1 }, b: { node: 3 } }),
    node(5, 'out', { in: { node: 4 } }),
  ],
  out: 5,
  params: [],
})

const sinePanSpec = (pos: number): GraphSpec => ({
  nodes: [
    node(0, 'notefreq'),
    node(1, 'sine', { freq: { node: 0 } }),
    node(2, 'pan', { in: { node: 1 }, pos }),
    node(3, 'out', { in: { node: 2 } }),
  ],
  out: 3,
  params: [],
})

interface Processor {
  process(outL: Float32Array, outR: Float32Array, n: number): void
}

/** Render `samples` (rounded up to whole blocks) into fresh stereo arrays. */
const render = (p: Processor, samples: number): { L: Float32Array; R: Float32Array } => {
  const blocks = Math.ceil(samples / BLOCK)
  const L = new Float32Array(blocks * BLOCK)
  const R = new Float32Array(blocks * BLOCK)
  for (let b = 0; b < blocks; b++) {
    p.process(L.subarray(b * BLOCK, (b + 1) * BLOCK), R.subarray(b * BLOCK, (b + 1) * BLOCK), BLOCK)
  }
  return { L, R }
}

const rms = (x: Float32Array): number => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / x.length)
}

const assertFinite = (x: Float32Array): void => {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]!)) throw new Error(`non-finite sample at ${i}: ${x[i]}`)
  }
}

const midiHz = (n: number): number => 440 * 2 ** ((n - 69) / 12)

describe('Voice', () => {
  it('renders the acid graph: audible, finite, dominant near 110Hz', () => {
    const pool = new VoicePool(acidSpec(), ctx, 4)
    pool.noteOn(45, 1) // 110 Hz
    const { L, R } = render(pool, SR) // 1s
    assertFinite(L)
    assertFinite(R)
    expect(rms(L)).toBeGreaterThan(0.01)
    // skip the attack, analyze the sustained half
    const win = L.subarray(SR / 2)
    const p110 = goertzel(win, 110, SR)
    for (const f of [55, 165, 220, 330, 440]) {
      expect(p110).toBeGreaterThan(goertzel(win, f, SR))
    }
  })

  it('noteOff decays below 1e-4 within r + 0.1s, then goes inactive after 8 silent blocks', () => {
    const pool = new VoicePool(acidSpec(), ctx, 2)
    pool.noteOn(45, 1)
    render(pool, Math.floor(0.3 * SR)) // settle into sustain
    pool.noteOff(45)
    const L = new Float32Array(BLOCK)
    const R = new Float32Array(BLOCK)
    const maxBlocks = Math.ceil(((0.01 + 0.1) * SR) / BLOCK) // r + 0.1s
    let quietAt = -1
    for (let b = 0; b < maxBlocks; b++) {
      L.fill(0)
      R.fill(0)
      pool.process(L, R, BLOCK)
      if (rms(L) < 1e-4 && rms(R) < 1e-4) {
        quietAt = b
        break
      }
    }
    expect(quietAt).toBeGreaterThanOrEqual(0)
    expect(pool.voices.some((v) => v.active)).toBe(true) // hysteresis not elapsed yet
    // tail below 1e-4 rms takes ~9 more blocks to cross the 1e-5 silence
    // threshold, then the 8-block hysteresis must elapse
    for (let b = 0; b < 30; b++) pool.process(L.fill(0), R.fill(0), BLOCK)
    expect(pool.voices.some((v) => v.active)).toBe(false)
  })

  it('auto-scales output by note velocity (no manual .mul(velocity) needed)', () => {
    // The graph does NOT touch the velocity signal — amplitude scaling is
    // applied by the Voice itself as it sums into the bus. A note at velocity
    // 0.5 is ~half the RMS of one at velocity 1.
    const spec = sineAdsrSpec()
    const loud = new VoicePool(spec, ctx, 1)
    loud.noteOn(69, 1)
    const quiet = new VoicePool(spec, ctx, 1)
    quiet.noteOn(69, 0.5)
    const a = rms(render(loud, SR / 2).L.subarray(SR / 4))
    const b = rms(render(quiet, SR / 2).L.subarray(SR / 4))
    expect(b).toBeGreaterThan(0.01)
    expect(a / b).toBeCloseTo(2, 1)
  })

  it('the velocity signal is for TIMBRE and does NOT itself scale amplitude — using it multiplies velocity in a SECOND time', () => {
    // A graph that multiplies by the velocity signal double-applies: the
    // Voice already scales by velocity, so quiet is velocity^2 of loud.
    const spec = sineAdsrSpec()
    spec.nodes.push(node(6, 'velocity'), node(7, 'mul', { a: { node: 4 }, b: { node: 6 } }))
    spec.nodes.find((n) => n.type === 'out')!.inputs = { in: { node: 7 } }
    const loud = new VoicePool(spec, ctx, 1)
    loud.noteOn(69, 1)
    const quiet = new VoicePool(spec, ctx, 1)
    quiet.noteOn(69, 0.5)
    const a = rms(render(loud, SR / 2).L.subarray(SR / 4))
    const b = rms(render(quiet, SR / 2).L.subarray(SR / 4))
    expect(a / b).toBeCloseTo(4, 1) // 0.5^2 = 0.25 -> ratio 4 (double-applied)
  })

  it('setParam clamps to the spec range; log curve takes the raw value; unknown names are ignored', () => {
    const g = compileGraph(acidSpec(), ctx)
    const v = new Voice(g, ctx)
    v.setParam('cutoff', 99999)
    expect(g.params.get('cutoff')!.buf[0]).toBe(8000)
    v.setParam('cutoff', 1)
    expect(g.params.get('cutoff')!.buf[0]).toBe(80)
    v.setParam('cutoff', 200) // log curve: value IS the real cutoff, not a 0..1 position
    expect(g.params.get('cutoff')!.buf[0]).toBe(200)
    expect(() => v.setParam('nope', 1)).not.toThrow()
  })

  it('supports partial blocks (n < BLOCK)', () => {
    const pool = new VoicePool(sineAdsrSpec(), ctx, 1)
    pool.noteOn(69, 1)
    const L = new Float32Array(64)
    const R = new Float32Array(64)
    for (let b = 0; b < 200; b++) pool.process(L, R, 64)
    L.fill(0)
    R.fill(0)
    pool.process(L, R, 64)
    assertFinite(L)
    expect(rms(L)).toBeGreaterThan(0.1)
  })

  it('rejects n > BLOCK', () => {
    const pool = new VoicePool(sineAdsrSpec(), ctx, 1)
    pool.noteOn(69, 1)
    const big = new Float32Array(BLOCK * 2)
    expect(() => pool.process(big, big, BLOCK + 1)).toThrow(RangeError)
  })
})

describe('pan', () => {
  it('pos 0 puts all energy left', () => {
    const v = new Voice(compileGraph(sinePanSpec(0), ctx), ctx)
    v.noteOn(69, 1)
    const { L, R } = render(v, SR / 4)
    expect(rms(L)).toBeGreaterThan(0.5)
    expect(rms(R)).toBe(0)
  })

  it('pos 0.5 splits equally at equal power', () => {
    const v = new Voice(compileGraph(sinePanSpec(0.5), ctx), ctx)
    v.noteOn(69, 1)
    const { L, R } = render(v, SR / 4)
    for (let i = 0; i < L.length; i++) {
      expect(Math.abs(L[i]! - R[i]!)).toBeLessThan(1e-6)
    }
    // sine rms is 1/sqrt(2) ~ 0.707; each channel carries cos(pi/4) of it -> 0.5
    expect(rms(L)).toBeCloseTo(0.5, 1)
  })

  it('mono terminal gets equal-power center (0.7071 both sides)', () => {
    const spec: GraphSpec = {
      nodes: [node(0, 'notefreq'), node(1, 'sine', { freq: { node: 0 } }), node(2, 'out', { in: { node: 1 } })],
      out: 2,
      params: [],
    }
    const v = new Voice(compileGraph(spec, ctx), ctx)
    v.noteOn(69, 1)
    const { L, R } = render(v, SR / 4)
    for (let i = 0; i < L.length; i++) {
      expect(L[i]).toBe(R[i])
    }
    expect(rms(L)).toBeCloseTo(Math.SQRT1_2 * Math.SQRT1_2, 1) // 0.5
  })

})

describe('delay feedback loop', () => {
  it('an impulse produces bounded, periodic echoes', () => {
    // gate impulse -> add -> delay(15ms) -> *0.5 -> back into add
    const spec: GraphSpec = {
      nodes: [
        node(0, 'gate'),
        node(1, 'add', { a: { node: 0 }, b: { node: 3 } }),
        node(2, 'delay', { in: { node: 1 }, time: 0.015, feedback: 0 }, { maxTime: 0.5 }),
        node(3, 'mul', { a: { node: 2 }, b: 0.5 }),
        node(4, 'out', { in: { node: 1 } }),
      ],
      out: 4,
      params: [],
    }
    const v = new Voice(compileGraph(spec, ctx), ctx)
    v.noteOn(60, 1)
    const blocks = Math.ceil((0.5 * SR) / BLOCK)
    const L = new Float32Array(blocks * BLOCK)
    const R = new Float32Array(blocks * BLOCK)
    // one block of gate=1, then off -> a 128-sample rectangular impulse
    v.process(L.subarray(0, BLOCK), R.subarray(0, BLOCK), BLOCK)
    v.noteOff()
    for (let b = 1; b < blocks; b++) {
      v.process(L.subarray(b * BLOCK, (b + 1) * BLOCK), R.subarray(b * BLOCK, (b + 1) * BLOCK), BLOCK)
    }
    assertFinite(L)
    let peak = 0
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]!))
    expect(peak).toBeLessThan(2)

    // cluster per-block RMS into bursts; expect echoes at the loop period:
    // delay time (720 samples) + one block of feedback latency (128) = 848
    const burstStarts: number[] = []
    let inBurst = false
    for (let b = 0; b < blocks; b++) {
      const r = rms(L.subarray(b * BLOCK, (b + 1) * BLOCK))
      if (r > 0.02 && !inBurst) {
        burstStarts.push(b)
        inBurst = true
      } else if (r <= 0.02 && inBurst) {
        inBurst = false
      }
    }
    expect(burstStarts.length).toBeGreaterThanOrEqual(4)
    // 848-sample period = 6.625 blocks -> spacings alternate 6/7. This pins
    // the one-block feedback latency: a zero-latency loop (720 samples =
    // 5.625 blocks) would produce spacings of 5, which must fail here.
    for (let k = 1; k < Math.min(burstStarts.length, 5); k++) {
      const spacing = burstStarts[k]! - burstStarts[k - 1]!
      expect(spacing).toBeGreaterThanOrEqual(6)
      expect(spacing).toBeLessThanOrEqual(7)
    }
  })
})

describe('VoicePool', () => {
  it('steals the oldest voice when full', () => {
    const pool = new VoicePool(acidSpec(), ctx, 2)
    pool.noteOn(60, 1)
    pool.noteOn(62, 1)
    pool.noteOn(64, 1) // steals the voice playing 60
    pool.noteOn(65, 1) // steals the voice playing 62
    const active = pool.voices.filter((v) => v.active)
    expect(active).toHaveLength(2)
    expect(active.map((v) => v.note).sort()).toEqual([64, 65])
    const { L } = render(pool, SR / 10)
    assertFinite(L)
  })

  it('retriggering the same note reuses its voice', () => {
    const pool = new VoicePool(acidSpec(), ctx, 4)
    pool.noteOn(60, 1)
    render(pool, SR / 10)
    pool.noteOn(60, 1)
    expect(pool.voices.filter((v) => v.active)).toHaveLength(1)
    expect(pool.voices.filter((v) => v.note === 60)).toHaveLength(1)
  })

  it('noteOff releases the voice playing that note, not others', () => {
    const pool = new VoicePool(sineAdsrSpec(), ctx, 4)
    pool.noteOn(45, 1) // 110 Hz
    pool.noteOn(57, 1) // 220 Hz
    render(pool, Math.floor(0.2 * SR))
    pool.noteOff(45)
    const { L } = render(pool, Math.floor(0.5 * SR))
    const win = L.subarray(Math.floor(0.25 * SR)) // well past the 10ms release
    const p110 = goertzel(win, 110, SR)
    const p220 = goertzel(win, 220, SR)
    expect(p220).toBeGreaterThan(0.1)
    expect(p220).toBeGreaterThan(100 * Math.max(p110, 1e-12))
  })

  it('plays two simultaneous notes with both fundamentals present', () => {
    const pool = new VoicePool(sineAdsrSpec(), ctx, 4)
    pool.noteOn(45, 1) // 110.00 Hz
    pool.noteOn(49, 1) // 138.59 Hz
    const { L } = render(pool, SR / 2)
    const win = L.subarray(SR / 4)
    const p45 = goertzel(win, midiHz(45), SR)
    const p49 = goertzel(win, midiHz(49), SR)
    const pBetween = goertzel(win, 124, SR)
    expect(p45).toBeGreaterThan(20 * pBetween)
    expect(p49).toBeGreaterThan(20 * pBetween)
  })

  it('setParam("cutoff", ...) audibly moves the filter', () => {
    const dark = new VoicePool(acidSpec(), ctx, 2)
    dark.setParam('cutoff', 200)
    dark.noteOn(45, 1)
    const darkWin = render(dark, SR).L.subarray(SR / 2)
    const bright = new VoicePool(acidSpec(), ctx, 2)
    bright.setParam('cutoff', 5000)
    bright.noteOn(45, 1)
    const brightWin = render(bright, SR).L.subarray(SR / 2)
    // spectral centroid proxy: high-harmonic to fundamental power ratio
    const ratioDark = goertzel(darkWin, 880, SR) / goertzel(darkWin, 110, SR)
    const ratioBright = goertzel(brightWin, 880, SR) / goertzel(brightWin, 110, SR)
    expect(ratioBright).toBeGreaterThan(10 * ratioDark)
  })

  it('noteOff for a stolen note does not release the thief', () => {
    const pool = new VoicePool(acidSpec(), ctx, 1)
    pool.noteOn(60, 1)
    pool.noteOn(64, 1) // steals the only voice
    pool.noteOff(60) // stale noteOff for the note that was stolen away
    expect(pool.voices[0]!.active).toBe(true)
    expect(pool.voices[0]!.note).toBe(64)
    const { L } = render(pool, Math.floor(0.3 * SR))
    // still sustaining — the 64 gate must not have been released
    expect(rms(L.subarray(L.length - 10 * BLOCK))).toBeGreaterThan(0.01)
  })

  it('resets kernels when reusing an INACTIVE voice, clearing stale delay energy', () => {
    // 25ms feedback loop: the post-release echo gap (~9 blocks) exceeds the
    // 8-block reclaim hysteresis, so the voice goes inactive while the delay
    // line still holds loud energy (the documented v1 reclaim limitation) —
    // exactly the state where reuse without a reset would replay the old note.
    const spec: GraphSpec = {
      nodes: [
        node(0, 'gate'),
        node(1, 'add', { a: { node: 0 }, b: { node: 3 } }),
        node(2, 'delay', { in: { node: 1 }, time: 0.025, feedback: 0 }, { maxTime: 0.5 }),
        node(3, 'mul', { a: { node: 2 }, b: 0.9 }),
        node(4, 'out', { in: { node: 1 } }),
      ],
      out: 4,
      params: [],
    }
    const pool = new VoicePool(spec, ctx, 1)
    const L = new Float32Array(BLOCK)
    const R = new Float32Array(BLOCK)
    pool.noteOn(60, 1)
    pool.process(L, R, BLOCK) // one-block gate impulse into the loop
    pool.noteOff(60)
    for (let b = 0; b < 16; b++) pool.process(L.fill(0), R.fill(0), BLOCK)
    expect(pool.voices[0]!.active).toBe(false) // reclaimed mid-tail

    pool.noteOn(64, 1) // inactive-voice allocation -> must reset kernels
    const reused = render(pool, 12 * BLOCK)
    const fresh = new VoicePool(spec, ctx, 1)
    fresh.noteOn(64, 1)
    const ref = render(fresh, 12 * BLOCK)
    for (let i = 0; i < reused.L.length; i++) {
      expect(Math.abs(reused.L[i]! - ref.L[i]!)).toBeLessThan(1e-6)
    }
  })

  it('zero-length process calls do not disturb the silence hysteresis', () => {
    const pool = new VoicePool(acidSpec(), ctx, 1)
    pool.noteOn(45, 1)
    render(pool, Math.floor(0.3 * SR))
    pool.noteOff(45)
    const L = new Float32Array(BLOCK)
    const R = new Float32Array(BLOCK)
    for (let b = 0; b < 60; b++) {
      pool.process(L.fill(0), R.fill(0), BLOCK)
      pool.process(L, R, 0) // interleaved n = 0 call must not reset the count
    }
    expect(pool.voices[0]!.active).toBe(false)
  })

  it('allNotesOff releases everything and voices go inactive', () => {
    const pool = new VoicePool(acidSpec(), ctx, 4)
    pool.noteOn(45, 1)
    pool.noteOn(52, 1)
    render(pool, Math.floor(0.2 * SR))
    pool.allNotesOff()
    render(pool, Math.floor(0.3 * SR)) // > release + 8-block hysteresis
    expect(pool.voices.every((v) => !v.active)).toBe(true)
  })
})
