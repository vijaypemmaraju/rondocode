import { describe, it, expect } from 'vitest'
import { AdsrKernel, EnvKernel } from '../src/dsp/env'
import type { DspContext } from '../src/dsp/types'

const ctx: DspContext = { sampleRate: 48000 }
const sr = ctx.sampleRate

/** Run an ADSR over a gate buffer in one block; returns the envelope. */
const runEnv = (k: AdsrKernel, gate: Float32Array): Float32Array => {
  const out = new Float32Array(gate.length)
  k.process(gate.length, { gate }, out, ctx)
  return out
}

/** Gate buffer: on (1) for [0, onSeconds), off (0) after, total length n. */
const gateOnOff = (n: number, onSeconds: number): Float32Array => {
  const g = new Float32Array(n)
  g.fill(1, 0, Math.min(n, Math.round(onSeconds * sr)))
  return g
}

describe('AdsrKernel', () => {
  const make = (): AdsrKernel => new AdsrKernel({ a: 0.01, d: 0.1, s: 0.5, r: 0.1 })

  it('traces attack peak, decay-to-sustain, and release', () => {
    const out = runEnv(make(), gateOnOff(Math.round(0.8 * sr), 0.5))
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
    const out = runEnv(make(), gateOnOff(Math.round(2 * sr), 0.5))
    expect(out[Math.round(0.8 * sr)]!).toBeLessThan(0.05)
    // Idle snap: below 1e-4 the release lands on exactly 0, not 1e-30.
    expect(out[out.length - 1]).toBe(0)
  })

  it('retriggers from the current level mid-release (no click to 0)', () => {
    // Gate on [0, 0.5s), off [0.5, 0.55s), on again from 0.55s.
    const n = Math.round(0.6 * sr)
    const gate = gateOnOff(n, 0.5)
    gate.fill(1, Math.round(0.55 * sr))
    const out = runEnv(make(), gate)
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
    const out = runEnv(make(), gateOnOff(n, 0.005))
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
    const k = new AdsrKernel({ a: 0, d: 0, s: 0.7, r: 0 })
    const out = runEnv(k, gateOnOff(sr, 0.5))
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(0)
      expect(out[i]!).toBeLessThanOrEqual(1)
    }
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
    // gate on 0.05s (partway up), off, then on again quickly
    const g = new Float32Array(sr)
    g.fill(1, 0, Math.round(0.05 * sr))
    g.fill(1, Math.round(0.1 * sr), Math.round(0.2 * sr))
    const out = run(k, g)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true)
    k.reset()
    const idle = run(k, new Float32Array(256))
    for (let i = 0; i < idle.length; i++) expect(idle[i]).toBe(0)
  })

  it('rejects an empty breakpoint list at construction', () => {
    expect(() => new EnvKernel({ points: [] })).toThrow()
  })
})
