import { describe, expect, it } from 'vitest'
import { THROTTLE_MS, rmsToMeterPercent, throttleTrailing } from '../src/viz/mixer'
import type { ThrottleClock } from '../src/viz/mixer'

/* The throttle is the piece of the mixer that MUST be right: a dragged
 * slider fires dozens of input events per second, and the engine should see
 * at most one setChannel per control per 30ms — with the trailing edge
 * guaranteed, so releasing a slider always lands on its final value. */

const fakeClock = () => {
  let t = 0
  const timers: { at: number; fn: () => void; dead: boolean }[] = []
  const clock: ThrottleClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn, dead: false }
      timers.push(h)
      return h
    },
    clearTimeout: (h) => {
      ;(h as { dead: boolean }).dead = true
    },
  }
  const advance = (ms: number): void => {
    t += ms
    for (const h of timers) {
      if (!h.dead && h.at <= t) {
        h.dead = true
        h.fn()
      }
    }
  }
  return { clock, advance }
}

describe('throttleTrailing', () => {
  it('burst → one immediate call plus one trailing call with the LATEST value', () => {
    const calls: number[] = []
    const { clock, advance } = fakeClock()
    const send = throttleTrailing((v: number) => calls.push(v), 30, clock)
    send(1)
    expect(calls).toEqual([1]) // leading edge fires immediately
    advance(5)
    send(2)
    advance(5)
    send(3)
    expect(calls).toEqual([1]) // burst coalesced
    advance(20) // 30ms since the leading call
    expect(calls).toEqual([1, 3]) // trailing edge, latest value only
  })

  it('a quiet period resets the window: the next call is immediate again', () => {
    const calls: number[] = []
    const { clock, advance } = fakeClock()
    const send = throttleTrailing((v: number) => calls.push(v), 30, clock)
    send(1)
    advance(100)
    send(2)
    expect(calls).toEqual([1, 2])
  })

  it('a trailing fire starts a new window (no immediate call right after it)', () => {
    const calls: number[] = []
    const { clock, advance } = fakeClock()
    const send = throttleTrailing((v: number) => calls.push(v), 30, clock)
    send(1)
    advance(10)
    send(2)
    advance(20) // trailing fires at t=30
    expect(calls).toEqual([1, 2])
    advance(10) // t=40: only 10ms since the trailing fire
    send(3)
    expect(calls).toEqual([1, 2]) // deferred, not immediate
    advance(20) // t=60: 30ms after the trailing fire
    expect(calls).toEqual([1, 2, 3])
  })

  it('cancel drops a pending trailing call', () => {
    const calls: number[] = []
    const { clock, advance } = fakeClock()
    const send = throttleTrailing((v: number) => calls.push(v), 30, clock)
    send(1)
    advance(5)
    send(2)
    send.cancel()
    advance(100)
    expect(calls).toEqual([1])
  })

  it('exports the shared 30ms default', () => {
    expect(THROTTLE_MS).toBe(30)
  })
})

describe('rmsToMeterPercent', () => {
  it('maps RMS to a clamped 0..100 fill percentage', () => {
    expect(rmsToMeterPercent(0)).toBe(0)
    expect(rmsToMeterPercent(0.25)).toBe(40) // same 160x scale as the master meter
    expect(rmsToMeterPercent(1)).toBe(100) // clamped
    expect(rmsToMeterPercent(-1)).toBe(0) // garbage in, silence out
    expect(rmsToMeterPercent(Number.NaN)).toBe(0)
  })
})
