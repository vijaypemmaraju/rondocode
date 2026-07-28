import { describe, it, expect } from 'vitest'
import { AdsrKernel, EnvKernel } from '../src/dsp/env'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** a/d/s/r are input PORTS, so a test supplies either a constant or a
 *  per-sample buffer for each. */
type Stage = number | Float32Array
const buf = (n: number, v: Stage): Float32Array =>
  v instanceof Float32Array ? v : new Float32Array(n).fill(v)

/** Run an ADSR over a gate buffer in one block; returns the envelope. Stage
 *  values default to the port defaults in compile.ts's PORTS table. */
const runEnv = (
  k: AdsrKernel,
  gate: Float32Array,
  st: { a?: Stage; d?: Stage; s?: Stage; r?: Stage } = {},
): Float32Array => {
  const n = gate.length
  const out = new Float32Array(n)
  k.process(
    n,
    {
      gate,
      a: buf(n, st.a ?? 0.01),
      d: buf(n, st.d ?? 0.1),
      s: buf(n, st.s ?? 0.7),
      r: buf(n, st.r ?? 0.2),
    },
    out,
    ctx,
  )
  return out
}

/** Gate buffer: on (1) for [0, onSeconds), off (0) after, total length n. */
const gateOnOff = (n: number, onSeconds: number): Float32Array => {
  const g = new Float32Array(n)
  g.fill(1, 0, Math.min(n, Math.round(onSeconds * sr)))
  return g
}

describe('AdsrKernel', () => {
  const make = (): AdsrKernel => new AdsrKernel()
  /** The spec the assertions in this block are written against. */
  const SPEC = { a: 0.01, d: 0.1, s: 0.5, r: 0.1 }

  it('traces attack peak, decay-to-sustain, and release', () => {
    const out = runEnv(make(), gateOnOff(Math.round(0.8 * sr), 0.5), SPEC)
    // End of the 10ms linear attack: at (or within a sample of) 1.
    expect(out[Math.round(0.01 * sr)]!).toBeGreaterThan(0.9)
    expect(out[Math.round(0.01 * sr)]!).toBeLessThanOrEqual(1)
    // 0.35s = 3.4 decay time constants after attack: settled near s = 0.5.
    expect(out[Math.round(0.35 * sr)]!).toBeGreaterThan(0.45)
    expect(out[Math.round(0.35 * sr)]!).toBeLessThan(0.55)
    // NOTE: at t=0.7s the release (one-pole, tau = r = 0.1s) has run for
    // exactly 2 time constants, so level = 0.5*exp(-2) ~ 0.068 by design —
    // a 0.05 bound there is unattainable. Assert 0.08 at 2 tau and the
    // stricter 0.05 at 3 tau (0.5*exp(-3) ~ 0.025).
    expect(out[Math.round(0.7 * sr)]!).toBeLessThan(0.08)
    expect(out[Math.round(0.7 * sr)]!).toBeGreaterThan(0)
  })

  it('release reaches < 0.05 by 3 time constants and exact 0 after a long tail', () => {
    const out = runEnv(make(), gateOnOff(Math.round(2 * sr), 0.5), SPEC)
    expect(out[Math.round(0.8 * sr)]!).toBeLessThan(0.05)
    // Idle snap: below 1e-4 the release lands on exactly 0, not 1e-30.
    expect(out[out.length - 1]).toBe(0)
  })

  it('retriggers from the current level mid-release (no click to 0)', () => {
    // Gate on [0, 0.5s), off [0.5, 0.55s), on again from 0.55s.
    const n = Math.round(0.6 * sr)
    const gate = gateOnOff(n, 0.5)
    gate.fill(1, Math.round(0.55 * sr))
    const out = runEnv(make(), gate, SPEC)
    const retrig = Math.round(0.55 * sr)
    // Level at retrigger: 0.5*exp(-0.5) ~ 0.30. The attack must resume from
    // there — never dipping toward 0 (no click) ...
    for (let i = retrig; i < n; i++) {
      expect(out[i]!).toBeGreaterThan(0.25)
    }
    // ... rising monotonically until it peaks at 1. From ~0.30 the linear
    // attack needs (1-0.30)*0.01s ~ 7ms; after the peak decay takes over,
    // so only assert monotonicity up to the peak.
    let peak = retrig
    while (peak < n && out[peak]! < 1) peak++
    expect(peak - retrig).toBeLessThan(Math.round(0.008 * sr))
    for (let i = retrig; i <= peak; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
    }
  })

  it('gate-off during attack releases from the current level', () => {
    // Attack is 10ms; drop the gate at 5ms, mid-ramp (level ~ 0.5).
    const n = Math.round(0.1 * sr)
    const out = runEnv(make(), gateOnOff(n, 0.005), SPEC)
    const off = Math.round(0.005 * sr)
    // No jump: the first release sample is within one one-pole step of the
    // last attack sample, and the tail decays monotonically from there.
    expect(Math.abs(out[off]! - out[off - 1]!)).toBeLessThan(0.01)
    expect(out[off - 1]!).toBeGreaterThan(0.4)
    for (let i = off + 1; i < n; i++) {
      expect(out[i]!).toBeLessThanOrEqual(out[i - 1]!)
    }
  })

  it('stays in [0, 1] and clamps degenerate config times', () => {
    // a=0 clamps to 0.0005s: attack still takes >= 1 sample and never exceeds 1.
    const k = new AdsrKernel()
    const out = runEnv(k, gateOnOff(sr, 0.5), { a: 0, d: 0, s: 0.7, r: 0 })
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(0)
      expect(out[i]!).toBeLessThanOrEqual(1)
    }
  })

  describe('modulated stages (a/d/s/r are signals)', () => {
    /** A buffer that holds `from` until `atSec`, then `to`. */
    const step = (n: number, from: number, to: number, atSec: number): Float32Array => {
      const b = new Float32Array(n).fill(from)
      b.fill(to, Math.round(atSec * sr))
      return b
    }

    it('reads the attack per sample: shortening it mid-ramp speeds the ramp up', () => {
      const n = Math.round(0.2 * sr)
      // 1s attack (barely moving) that becomes a 10ms attack at 5ms in
      const out = runEnv(make(), gateOnOff(n, 0.15), { a: step(n, 1, 0.01, 0.005) })
      const before = Math.round(0.004 * sr)
      const slowStep = out[before]! - out[before - 1]!
      const after = Math.round(0.006 * sr)
      const fastStep = out[after]! - out[after - 1]!
      // 1s -> 0.01s is 100x the per-sample increment
      expect(fastStep / slowStep).toBeGreaterThan(50)
      // and it still reaches the peak, rather than stalling on the old rate
      expect(Math.max(...out)).toBeCloseTo(1, 2)
    })

    it('a constant signal matches passing the same plain number', () => {
      const n = Math.round(0.5 * sr)
      const g = gateOnOff(n, 0.3)
      const asNum = runEnv(make(), g, { a: 0.02, d: 0.05, s: 0.4, r: 0.08 })
      const asBuf = runEnv(make(), g, {
        a: new Float32Array(n).fill(0.02),
        d: new Float32Array(n).fill(0.05),
        s: new Float32Array(n).fill(0.4),
        r: new Float32Array(n).fill(0.08),
      })
      // bit-identical, so the cheap path and the modulated path agree
      expect([...asBuf]).toEqual([...asNum])
    })

    it('a moving sustain level is followed, not frozen at the decay handover', () => {
      const n = Math.round(0.6 * sr)
      // sustain jumps 0.3 -> 0.8 well after the decay has settled
      const out = runEnv(make(), gateOnOff(n, 0.55), { a: 0.005, d: 0.02, s: step(n, 0.3, 0.8, 0.3) })
      expect(out[Math.round(0.25 * sr)]!).toBeCloseTo(0.3, 2)
      expect(out[Math.round(0.5 * sr)]!).toBeCloseTo(0.8, 2)
    })

    it('a swept decay keeps its coefficient in step with the input', () => {
      const n = Math.round(0.4 * sr)
      // d ramps 0.005 -> 0.4 across the note; the cached coefficient must track
      const d = new Float32Array(n)
      for (let i = 0; i < n; i++) d[i] = 0.005 + (0.395 * i) / n
      const out = runEnv(make(), gateOnOff(n, 0.35), { a: 0.002, d, s: 0 })
      // decaying toward 0 the whole time: monotone after the attack peak, and
      // still well above 0 at the end because d got long
      const peak = out.indexOf(Math.max(...out))
      for (let i = peak + 1; i < Math.round(0.3 * sr); i++) {
        expect(out[i]!).toBeLessThanOrEqual(out[i - 1]!)
      }
      expect(out[Math.round(0.3 * sr)]!).toBeGreaterThan(0.01)
    })

    it('NaN or garbage on a stage input cannot silence the voice', () => {
      // the old code clamped once at construction, so a Sig object reaching a
      // number slot produced NaN forever and the synth went silent
      const n = Math.round(0.2 * sr)
      const nan = new Float32Array(n).fill(NaN)
      const out = runEnv(make(), gateOnOff(n, 0.15), { a: nan, d: nan, s: nan, r: nan })
      for (let i = 0; i < n; i++) expect(Number.isNaN(out[i]!)).toBe(false)
      expect(Math.max(...out)).toBeGreaterThan(0.5) // it still sounds
    })
  })

  it('reset() returns to idle at level 0', () => {
    const k = make()
    runEnv(k, gateOnOff(1024, 1))
    k.reset()
    const out = runEnv(k, new Float32Array(1024)) // gate off, idle
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0)
  })
})

describe('EnvKernel (multi-segment)', () => {
  const gate = (n: number, onSec: number): Float32Array => {
    const g = new Float32Array(n)
    g.fill(1, 0, Math.min(n, Math.round(onSec * sr)))
    return g
  }
  const run = (k: EnvKernel, g: Float32Array): Float32Array => {
    const out = new Float32Array(g.length)
    k.process(g.length, { gate: g }, out, ctx)
    return out
  }
  const at = (out: Float32Array, sec: number): number => out[Math.round(sec * sr)]!

  it('ramps through the breakpoints then holds the last level while gated', () => {
    // 0 -> 1 over 0.1s, then 1 -> 0.5 over 0.1s, hold 0.5
    const k = new EnvKernel({ points: [[0.1, 1], [0.1, 0.5]] })
    const out = run(k, gate(sr, 1)) // 1s, gate on the whole time
    expect(at(out, 0)).toBeCloseTo(0, 2)
    expect(at(out, 0.1)).toBeCloseTo(1, 1) // end of first segment
    expect(at(out, 0.2)).toBeCloseTo(0.5, 1) // end of second
    expect(at(out, 0.8)).toBeCloseTo(0.5, 2) // holding the sustain
  })

  it('releases from the current level to 0 after gate-off', () => {
    const k = new EnvKernel({ points: [[0.05, 1]], release: 0.1 })
    const out = run(k, gate(sr, 0.3)) // gate off at 0.3s
    expect(at(out, 0.2)).toBeCloseTo(1, 2) // sustaining at 1
    expect(at(out, 0.3 + 0.1 + 0.02)).toBeCloseTo(0, 2) // fully released after ~release
    expect(at(out, 0.35)).toBeGreaterThan(0) // mid-release, still ringing
    expect(at(out, 0.35)).toBeLessThan(1)
  })

  it('loops the breakpoints while held instead of holding', () => {
    // a 0->1->0 triangle looping every 0.2s
    const k = new EnvKernel({ points: [[0.1, 1], [0.1, 0]], loop: true })
    const out = run(k, gate(sr, 1))
    // peaks recur ~0.1, 0.3, 0.5...; troughs ~0.2, 0.4...
    expect(at(out, 0.1)).toBeGreaterThan(0.9)
    expect(at(out, 0.2)).toBeLessThan(0.1)
    expect(at(out, 0.3)).toBeGreaterThan(0.9)
    expect(at(out, 0.4)).toBeLessThan(0.1)
  })

  it('curve > 0 bends a rising segment above its linear midpoint (fast-then-slow)', () => {
    const lin = new EnvKernel({ points: [[0.2, 1]], curve: 0 })
    const exp = new EnvKernel({ points: [[0.2, 1]], curve: 4 })
    const half = 0.1 // halfway through a 0.2s attack
    const l = at(run(lin, gate(sr, 1)), half)
    const e = at(run(exp, gate(sr, 1)), half)
    expect(l).toBeCloseTo(0.5, 1) // linear midpoint
    expect(e).toBeGreaterThan(l + 0.1) // curved rises faster early
  })

  it('retriggers from the current level (no click) and reset() idles', () => {
    const k = new EnvKernel({ points: [[0.1, 1]], release: 0.5 })
    // gate on 0.05s (partway up, level ~0.5), off (release from 0.5, slow),
    // then on again at 0.1s — by then the release has only fallen to ~0.45.
    const g = new Float32Array(sr)
    g.fill(1, 0, Math.round(0.05 * sr))
    g.fill(1, Math.round(0.1 * sr), Math.round(0.2 * sr))
    const out = run(k, g)
    const retrig = Math.round(0.1 * sr)
    const gateEnd = Math.round(0.2 * sr)
    // Level continuity: the retriggered segment resumes from the mid-release
    // level (~0.45) — it must never snap toward 0 (that IS the click). Pin a
    // floor across the whole retriggered span, like the AdsrKernel test above.
    expect(out[retrig]!).toBeGreaterThan(0.4)
    expect(out[retrig]!).toBeLessThan(0.55)
    for (let i = retrig; i < gateEnd; i++) {
      expect(out[i]!).toBeGreaterThan(0.4)
    }
    // ...and ramps monotonically from there toward 1 (reached as the 0.1s
    // segment completes right at the end of the gate window).
    for (let i = retrig + 1; i < gateEnd; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!)
    }
    expect(out[gateEnd - 1]!).toBeGreaterThan(0.97)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    k.reset()
    const idle = run(k, new Float32Array(256))
    for (let i = 0; i < idle.length; i++) expect(idle[i]).toBe(0)
  })

  it('rejects an empty breakpoint list at construction', () => {
    expect(() => new EnvKernel({ points: [] })).toThrow()
  })
})
