import { describe, expect, it } from 'vitest'
import { StereoStage, applyWidth } from '../src/dsp/midside'
import { goertzel } from './util/goertzel'

/* ------------------------------------------------------------------------- *
 * MID / SIDE.
 *
 * The one stereo move the engine could not make. Every kernel is mono, and a
 * post chain gets its stereo by compiling the same graph twice and running one
 * instance per side — so no node can form M = (L+R)/2. This is a MASTER-BUS
 * stage instead, in the one place both channels exist.
 *
 * MONO COMPATIBILITY IS THE LOAD-BEARING CLAIM, and it is a claim about
 * arithmetic rather than about taste, so it is tested exactly: scaling the
 * side must never change the mono sum, at any width, for any input. That is
 * what a Haas-style widener cannot promise, and the whole reason this exists
 * alongside `width`.
 * ------------------------------------------------------------------------- */

const sr = 48000

describe('applyWidth', () => {
  it('width 1 is a bit-exact passthrough', () => {
    for (const [l, r] of [[0.5, -0.3], [1, 1], [-0.7, 0.2]] as [number, number][]) {
      expect(applyWidth(l, r, 1)).toEqual([l, r])
    }
  })

  it('width 0 collapses to mono — both channels become the sum', () => {
    const [l, r] = applyWidth(0.8, -0.2, 0)
    expect(l).toBeCloseTo(0.3, 10)
    expect(r).toBeCloseTo(0.3, 10)
    expect(l).toBe(r)
  })

  it('above 1 widens: the difference grows, in proportion', () => {
    const diff = (w: number): number => { const [l, r] = applyWidth(0.6, -0.4, w); return l - r }
    expect(diff(2)).toBeCloseTo(diff(1) * 2, 10)
    expect(diff(4)).toBeCloseTo(diff(1) * 4, 10)
  })

  it('THE MONO SUM IS UNTOUCHED, at every width', () => {
    // the property the whole feature rests on
    for (const [l, r] of [[0.8, -0.3], [1, 1], [-0.5, 0.9], [0, 0.4]] as [number, number][]) {
      const dry = (l + r) / 2
      for (const w of [0, 0.5, 1, 2, 4]) {
        const [wl, wr] = applyWidth(l, r, w)
        expect((wl + wr) / 2, `width ${w} moved the mono sum`).toBeCloseTo(dry, 12)
      }
    }
  })

  it('a centred (mono) signal cannot be widened — there is no side to scale', () => {
    // honest: this rebalances what is there, it does not invent stereo
    for (const w of [0, 2, 4]) expect(applyWidth(0.5, 0.5, w)).toEqual([0.5, 0.5])
  })
})

describe('StereoStage', () => {
  const run = (st: StereoStage, l: Float32Array, r: Float32Array): [Float32Array, Float32Array] => {
    const ol = new Float32Array(l.length)
    const or = new Float32Array(l.length)
    for (let i = 0; i < l.length; i++) {
      const [a, b] = st.step(l[i]!, r[i]!)
      ol[i] = a
      or[i] = b
    }
    return [ol, or]
  }
  /** A stereo tone: `hz` panned hard apart, so it is pure SIDE content. */
  const sides = (hz: number, n = 8192): [Float32Array, Float32Array] => {
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr)
      l[i] = v
      r[i] = -v
    }
    return [l, r]
  }

  it('is idle by default, so an untouched project is unchanged', () => {
    const st = new StereoStage()
    expect(st.idle, 'a fresh stage would alter the mix').toBe(true)
    st.set({ width: 1, monoBelow: 0 }, sr)
    expect(st.idle).toBe(true)
    st.set({ width: 1.2 }, sr)
    expect(st.idle).toBe(false)
  })

  it('monoBelow collapses the LOW end and leaves the top alone', () => {
    /* The move that matters on a system with one sub. A hard-panned 60 Hz tone
     * should come out centred; a hard-panned 4 kHz tone should stay apart. */
    const st = new StereoStage()
    st.set({ monoBelow: 200 }, sr)
    const [ll, lr] = run(st, ...sides(60))
    const lowSide = goertzel(ll.map((v, i) => (v - lr[i]!) / 2) as never, 60, sr)
    // the input is PURE side (l = -r), so mid is 0 either way — the thing to
    // measure is how much of that side survived, not side against mid
    const drySide = goertzel(sides(60)[0].map((v, i) => (v - sides(60)[1][i]!) / 2) as never, 60, sr)
    expect(lowSide, 'the low end stayed stereo').toBeLessThan(drySide * 0.2)

    const st2 = new StereoStage()
    st2.set({ monoBelow: 200 }, sr)
    const [hl, hr] = run(st2, ...sides(4000))
    const hiSide = goertzel(hl.map((v, i) => (v - hr[i]!) / 2) as never, 4000, sr)
    expect(hiSide, 'the top was mono-ed too').toBeGreaterThan(0.1)
  })

  it('never emits a non-finite sample, even ON the NaN', () => {
    const st = new StereoStage()
    st.set({ width: 2, monoBelow: 120 }, sr)
    // the bad sample itself must come out clean, not just the ones after it:
    // a single NaN reaching the master output is a click at best
    const [na, nb] = st.step(NaN, NaN)
    expect(Number.isFinite(na) && Number.isFinite(nb), 'the NaN passed straight through').toBe(true)
    const [a, b] = st.step(0.4, -0.4)
    expect(Number.isFinite(a) && Number.isFinite(b), 'a NaN poisoned the filter state').toBe(true)
  })

  it('the mono-ed low end is the AVERAGE of the two channels, not one of them', () => {
    /* Collapsing to L would also read as "mono", so a test that only checks
     * for mono cannot tell the difference — and picking one channel would
     * throw away half the bass and shift the level. Feed asymmetric lows and
     * check the level that comes out. */
    const n = 16384
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * 60 * i) / sr
      l[i] = 0.8 * Math.sin(w)   // loud on the left
      r[i] = 0.2 * Math.sin(w)   // quiet on the right
    }
    const st = new StereoStage()
    st.set({ monoBelow: 200 }, sr)
    const [ol] = run(st, l, r)
    const got = goertzel(ol.subarray(n / 2), 60, sr)
    const avg = goertzel(l.subarray(n / 2).map((v, i) => (v + r[n / 2 + i]!) / 2) as never, 60, sr)
    const leftOnly = goertzel(l.subarray(n / 2), 60, sr)
    /* Not exactly the average, and it should not be: the crossover is one
     * pole, so at 60 Hz against a 200 Hz corner some of the tone stays in the
     * HIGH band and keeps its asymmetry. What must hold is the direction —
     * the result sits near the average and nowhere near either channel alone. */
    expect(Math.abs(got - avg), 'it kept one channel instead of averaging')
      .toBeLessThan(Math.abs(got - leftOnly))
    expect(got, 'the low end was not levelled at all').toBeLessThan(leftOnly * 0.85)
  })

  it('clamps rather than letting a bad value through', () => {
    const st = new StereoStage()
    st.set({ width: 999, monoBelow: 99999 }, sr)
    const [a, b] = st.step(0.5, -0.5)
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true)
    // width is capped at 4, so the difference cannot exceed 4x the input's
    expect(Math.abs(a - b)).toBeLessThanOrEqual(4 * 1 + 1e-6)
  })

  it('reset() clears the crossover state', () => {
    const st = new StereoStage()
    st.set({ monoBelow: 200 }, sr)
    run(st, ...sides(60, 4096))
    st.reset()
    const [a, b] = st.step(0, 0)
    expect(a).toBe(0)
    expect(b).toBe(0)
  })
})
