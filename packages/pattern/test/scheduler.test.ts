import { describe, expect, it } from 'vitest'
import { Pattern, n, sine } from '../src/index'
import { Scheduler } from '../src/scheduler'
import type { SchedulerEvent } from '../src/scheduler'
import type { ControlMap } from '../src/index'

/** Fake-clock rig: manual time, manual tick(), flattened event capture. */
const rig = (opts?: { lookahead?: number; cps?: number; startLead?: number }) => {
  const clock = { now: 0 }
  const batches: SchedulerEvent[][] = []
  const s = new Scheduler({
    getTime: () => clock.now,
    onEvents: (evs) => batches.push(evs),
    lookahead: opts?.lookahead ?? 0.1,
    startLead: opts?.startLead ?? 0,
  })
  if (opts?.cps !== undefined) s.setCps(opts.cps)
  const events = () => batches.flat()
  const times = () => events().map((e) => e.timeSec)
  /** tick at successive times (mutates clock). */
  const run = (...ts: number[]) => {
    for (const t of ts) {
      clock.now = t
      s.tick()
    }
  }
  return { clock, batches, s, events, times, run }
}

describe('Scheduler basics', () => {
  it('fires "0 1 2 3" at cps=1 at 0/0.25/0.5/0.75 (±1e-9)', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0, 0.2, 0.4, 0.65, 0.95)
    const evs = events().filter((e) => e.timeSec < 1)
    expect(evs).toHaveLength(4)
    const expected = [0, 0.25, 0.5, 0.75]
    evs.forEach((e, i) => {
      expect(Math.abs(e.timeSec - expected[i]!)).toBeLessThan(1e-9)
      expect(Math.abs(e.durSec - 0.25)).toBeLessThan(1e-9)
      expect(e.cycle).toBe(0)
      expect((e.controls as ControlMap).n).toBe(i)
    })
  })

  it('startLead anchors cycle 0 ahead of now (first onset lands in the future)', () => {
    // Press play at t=0.5, first tick fires a bit later at t=0.52. Without a
    // lead the cycle-0 onset would be timed at 0.5 — already past, so the
    // engine fires it immediately into a spinning-up graph (missing first
    // note). With startLead=0.1 the onset is timed at 0.6, still ahead of the
    // 0.52 dispatch, so it queues and fires cleanly.
    const { s, events, run, clock } = rig({ cps: 1, startLead: 0.1 })
    s.setPattern('a', n('0 1 2 3'))
    clock.now = 0.5
    s.play() // anchored at getTime()=0.5 + startLead 0.1 = cycle 0 at t=0.6
    run(0.52)
    const first = events().find((e) => (e.controls as ControlMap).n === 0)!
    expect(Math.abs(first.timeSec - 0.6)).toBeLessThan(1e-9)
    expect(first.timeSec).toBeGreaterThan(0.52) // in the future at dispatch
  })

  it('default cps is 0.5 (a cycle takes 2 seconds)', () => {
    const { s, times, run } = rig()
    expect(s.cps).toBe(0.5)
    s.setPattern('a', n('0 1'))
    s.play()
    run(0, 0.5, 0.95, 1.5, 1.95)
    expect(times().filter((t) => t < 2)).toEqual([0, 1])
  })

  it('threads loc and cycle onto events', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1'))
    s.play()
    run(0, 0.45, 0.95, 1.2)
    const evs = events()
    expect(evs[0]!.loc).toEqual({ start: 0, end: 1, src: '0 1' })
    expect(evs[1]!.loc).toEqual({ start: 2, end: 3, src: '0 1' })
    expect(evs[2]!.cycle).toBe(1)
  })

  it('does not fire before play()', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    run(0, 0.5)
    expect(events()).toHaveLength(0)
  })

  it('never fires continuous signals (no onset, nothing to schedule)', () => {
    const { s, batches, run } = rig({ cps: 1 })
    s.setPattern('sig', sine.withValue((v): ControlMap => ({ cutoff: v })))
    s.play()
    run(0, 0.5, 1.0)
    expect(batches).toHaveLength(0)
  })

  it('setPattern/removePattern/patterns manage the registry', () => {
    const { s } = rig()
    s.setPattern('a', n('0'))
    s.setPattern('b', n('1'))
    expect(s.patterns().sort()).toEqual(['a', 'b'])
    s.removePattern('a')
    expect(s.patterns()).toEqual(['b'])
  })

  it('stacks multiple patterns and sorts each batch by timeSec', () => {
    const { s, batches, run } = rig({ cps: 1 })
    s.setPattern('late', n('10 11').ctrl('who', 1))
    s.setPattern('early', n('0 1 2 3').ctrl('who', 2))
    s.play()
    run(0.85) // one big window [0, 0.95): events from both patterns
    expect(batches).toHaveLength(1)
    const evs = batches[0]!
    const ts = evs.map((e) => e.timeSec)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
    expect(evs).toHaveLength(6)
  })
})

describe('Scheduler window edges (the double-fire bug class)', () => {
  it('an onset exactly at the window end fires in the NEXT tick, exactly once', () => {
    const { s, times, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    // window 1: [0, 0.25) — the event AT 0.25 must not fire yet
    run(0.15)
    expect(times()).toEqual([0])
    // window 2: [0.25, 0.35) — now it fires, once
    run(0.25)
    expect(times()).toEqual([0, 0.25])
    // re-ticking at the same time must not re-fire the window
    run(0.25, 0.25)
    expect(times()).toEqual([0, 0.25])
  })

  it('never re-queries a window even when time stalls or goes backwards', () => {
    const { s, times, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0.2, 0.1, 0.0, 0.2)
    expect(times()).toEqual([0, 0.25]) // [0, 0.3) queried once; nothing refired
  })

  it('a long gap between ticks fires everything missed exactly once', () => {
    const { s, times, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0, 1.9) // second tick covers (0.1, 2.0): rest of cycle 0 + cycle 1
    expect(times()).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75])
  })
})

describe('Scheduler hot-swap', () => {
  it('setPattern mid-cycle takes effect at the next tick: no double-fire, no gap', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0.2) // queried [0, 0.3): fired 0, 0.25 from the old pattern
    s.setPattern('a', n('10 11 12 13'))
    run(0.9) // queried [0.3, 1.0): 0.5, 0.75 from the NEW pattern
    const evs = events()
    expect(evs.map((e) => e.timeSec)).toEqual([0, 0.25, 0.5, 0.75])
    expect(evs.map((e) => (e.controls as ControlMap).n)).toEqual([0, 1, 12, 13])
  })
})

describe('Scheduler cps changes', () => {
  it('setCps pivots at the queried boundary: continuity, no jump-back, no refire', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0) // queried [0, 0.1): fired the event at 0
    s.setCps(2) // pivot at cycle 0.1 = 0.1s; beyond it, cycles take 0.5s
    run(0.1, 0.3, 0.5)
    const evs = events().filter((e) => e.cycle === 0)
    // cycle positions 0.25/0.5/0.75 → 0.1 + (pos - 0.1)/2 seconds
    const expected = [0, 0.175, 0.3, 0.425]
    expect(evs).toHaveLength(4)
    evs.forEach((e, i) => expect(Math.abs(e.timeSec - expected[i]!)).toBeLessThan(1e-9))
    // durations after the pivot reflect the new cps
    expect(Math.abs(evs[1]!.durSec - 0.125)).toBeLessThan(1e-9)
    // monotonic: no jump-back across the change
    const ts = events().map((e) => e.timeSec)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
  })

  it('rejects non-positive or non-finite cps', () => {
    const { s } = rig()
    expect(() => s.setCps(0)).toThrow()
    expect(() => s.setCps(-1)).toThrow()
    expect(() => s.setCps(NaN)).toThrow()
    expect(() => s.setCps(Infinity)).toThrow()
  })
})

describe('Scheduler error isolation', () => {
  it('a throwing pattern does not kill the others; onError reports it by name', () => {
    const clock = { now: 0 }
    const batches: SchedulerEvent[][] = []
    const errors: [string, unknown][] = []
    const s = new Scheduler({
      getTime: () => clock.now,
      onEvents: (evs) => batches.push(evs),
      onError: (name, err) => errors.push([name, err]),
      lookahead: 0.1,
    })
    s.setCps(1)
    const boom = new Error('boom')
    s.setPattern('bad', new Pattern(() => {
      throw boom
    }))
    s.setPattern('good', n('0 1 2 3'))
    s.play()
    clock.now = 0
    s.tick()
    clock.now = 0.2
    s.tick()
    // the good pattern fired normally
    expect(batches.flat().map((e) => e.timeSec)).toEqual([0, 0.25])
    // every failing tick reported the bad pattern
    expect(errors).toHaveLength(2)
    expect(errors[0]![0]).toBe('bad')
    expect(errors[0]![1]).toBe(boom)
  })

  it('window-math failure reports as onError("*"), fires nothing, and resumes on a sane clock', () => {
    // Honest forcing: no spies or subclassing — a clock excursion to 1e300
    // genuinely overflows the exact-fraction window math (cycle * QUANT is
    // not a safe integer), exercising the real defensive path in tick().
    const clock = { now: 0 }
    const batches: SchedulerEvent[][] = []
    const errors: [string, unknown][] = []
    const s = new Scheduler({
      getTime: () => clock.now,
      onEvents: (evs) => batches.push(evs),
      onError: (name, err) => errors.push([name, err]),
      lookahead: 0.1,
    })
    s.setCps(1)
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    s.tick() // sane: fires the event at 0
    clock.now = 1e300 // pathological clock
    expect(() => s.tick()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]![0]).toBe('*')
    clock.now = 0.2 // clock sane again: resumes where it left off
    s.tick()
    expect(batches.flat().map((e) => e.timeSec)).toEqual([0, 0.25])
  })

  it('without onError a throwing pattern is still contained (no throw out of tick)', () => {
    const clock = { now: 0 }
    const batches: SchedulerEvent[][] = []
    const s = new Scheduler({
      getTime: () => clock.now,
      onEvents: (evs) => batches.push(evs),
      lookahead: 0.1,
    })
    s.setCps(1)
    s.setPattern('bad', new Pattern(() => {
      throw new Error('boom')
    }))
    s.setPattern('good', n('0'))
    s.play()
    expect(() => s.tick()).not.toThrow()
    expect(batches.flat()).toHaveLength(1)
  })
})

describe('Scheduler longevity (fraction growth stays bounded)', () => {
  it('survives ~10 hours of perturbed-clock ticks across several cps changes, with zero dropped windows', () => {
    // Regression, two layers of the same overflow class:
    // 1. DENOMINATORS: cycleAt used to ADD a fresh fromNumber fraction onto
    //    the anchor cycle, compounding denominators at every setCps pivot —
    //    RangeError seconds after the second tempo change.
    // 2. NUMERATORS: with fromNumber's denominators merely CAPPED at 1e6,
    //    window-edge comparisons cross-multiply n1*d2 ≈ cycle*1e12 — tick()
    //    overflowed at ~cycle 9000 (~2.5 h at cps 1), preceded by silent
    //    per-pattern window drops (query-side overflows caught by the
    //    per-pattern guard → onError).
    // Now window edges are quantized to the FIXED 1/10000 grid, so cross
    // products stay ~cycle*1e8: no throw, no drops, for ~9e7 cycles.
    const clock = { now: 0 }
    const times: number[] = []
    const errors: [string, unknown][] = []
    const s = new Scheduler({
      getTime: () => clock.now,
      onEvents: (b) => {
        for (const e of b) times.push(e.timeSec)
      },
      onError: (name, err) => errors.push([name, err]),
      lookahead: 0.1,
    })
    s.setPattern('a', n('0 1 2 3'))
    s.setCps(1)
    s.play()
    // Deterministic LCG jitter: irregular float tick steps ~1s (coarse to
    // keep the test fast), ~10 simulated hours (~36k cycles — 4x past the
    // old numerator cliff), a cps change every 20 min.
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const cpsSteps = [0.55, 1.7, 0.61, 1.13, 0.97]
    const TICKS = 36_000 // ~10 h simulated at ~1 s per tick
    for (let i = 1; i <= TICKS; i++) {
      clock.now += 1 + (rand() - 0.5) * 1e-3
      s.tick() // must never throw
      if (i % 1200 === 0) s.setCps(cpsSteps[((i / 1200) - 1) % cpsSteps.length]!)
    }
    // no silent window drops: every query succeeded
    expect(errors).toEqual([])
    // events stay monotonic across every pivot
    let violation = -1
    for (let i = 1; i < times.length; i++) {
      if (times[i]! < times[i - 1]!) {
        violation = i
        break
      }
    }
    expect(violation).toBe(-1)
    expect(times.length).toBeGreaterThan(100_000) // ~4 events/cycle for 10 h
  })
})

describe('Scheduler transport', () => {
  it('stop() halts firing; play() restarts at cycle 0 anchored at now', () => {
    const { s, times, events, run, clock } = rig({ cps: 1 })
    s.setPattern('a', n('0 1 2 3'))
    s.play()
    run(0.2)
    expect(times()).toEqual([0, 0.25])
    s.stop()
    run(0.5, 1.0)
    expect(times()).toEqual([0, 0.25]) // nothing while stopped
    clock.now = 10
    s.play()
    run(10, 10.2)
    const after = events().slice(2)
    expect(after.map((e) => e.timeSec)).toEqual([10, 10.25])
    expect(after.map((e) => e.cycle)).toEqual([0, 0]) // restarted at cycle 0
  })

  it('dur control scales durSec (legato), timeSec unchanged', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern('a', n('0 1').dur(0.5))
    s.play()
    run(0, 0.45, 0.9)
    const evs = events()
    expect(Math.abs(evs[0]!.durSec - 0.25)).toBeLessThan(1e-9)
    expect(Math.abs(evs[1]!.durSec - 0.25)).toBeLessThan(1e-9)
    expect(evs.map((e) => e.timeSec)).toEqual([0, 0.5])
  })

  it('start(intervalImpl) drives tick on the interval; stop clears it', () => {
    const cbs: (() => void)[] = []
    const cleared: unknown[] = []
    const clock = { now: 0 }
    const batches: SchedulerEvent[][] = []
    const s = new Scheduler({
      getTime: () => clock.now,
      onEvents: (evs) => batches.push(evs),
      lookahead: 0.1,
      interval: 0.025,
    })
    s.setCps(1)
    s.setPattern('a', n('0 1 2 3'))
    const setIntervalImpl = (fn: () => void, ms: number): unknown => {
      expect(ms).toBe(25)
      cbs.push(fn)
      return 'handle'
    }
    const clearIntervalImpl = (h: unknown): void => {
      cleared.push(h)
    }
    s.start(setIntervalImpl, clearIntervalImpl)
    expect(cbs).toHaveLength(1)
    cbs[0]!() // t=0: window [0, 0.1)
    clock.now = 0.2
    cbs[0]!() // window [0.1, 0.3)
    expect(batches.flat().map((e) => e.timeSec)).toEqual([0, 0.25])
    s.stop()
    expect(cleared).toEqual(['handle'])
    clock.now = 0.6
    cbs[0]!() // stale timer callback after stop: no effect
    expect(batches.flat()).toHaveLength(2)
  })
})

describe('Scheduler with controls end to end', () => {
  it('carries the full ControlMap through (sound, scale, params)', () => {
    const { s, events, run } = rig({ cps: 1 })
    s.setPattern(
      'acid',
      n('0 3').scale('a minor').sound('acid').ctrl('cutoff', 800),
    )
    s.play()
    run(0.9)
    const evs = events()
    expect(evs).toHaveLength(2)
    expect(evs[0]!.controls.note).toBe(57)
    expect(evs[1]!.controls.note).toBe(62)
    expect(evs[0]!.controls.sound).toBe('acid')
    expect(evs[0]!.controls['cutoff']).toBe(800)
  })

  it('silence produces no batches at all (onEvents only called with events)', () => {
    const { s, batches, run } = rig({ cps: 1 })
    s.setPattern('a', Pattern.silence)
    s.play()
    run(0, 0.5, 1.0)
    expect(batches).toHaveLength(0)
  })
})
