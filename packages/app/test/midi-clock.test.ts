import { describe, expect, it } from 'vitest'
import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { Session } from '../src/session/Session'
import { bpmToCps, cpsToBpm } from '@rondocode/pattern'
import {
  CLOCK_BYTE,
  DEFAULT_MAX_TRIM,
  MAX_BATCH,
  MidiClockFollower,
  MidiClockSender,
  TICKS_PER_CYCLE,
  TICKS_PER_QUARTER,
  parseClock,
} from '../src/midi/clock'

/* ------------------------------------------------------------------------- *
 * MIDI clock. The "master" here is a generated tick stream, so tempo
 * estimation, jitter rejection, transport handling and the send schedule are
 * all pinned without hardware.
 *
 * The bar that matters: a real USB or driver clock jitters by around a
 * millisecond per tick, and at 120 bpm a tick lands every 20.83 ms, so a naive
 * tick-to-tick reading wobbles by 5%. The fit below has to hold well inside a
 * FIFTH of a BPM on that same stream.
 * ------------------------------------------------------------------------- */

/** Deterministic pseudo-random jitter, so a failure is reproducible. */
const jitterer = (seed: number) => {
  let s = seed >>> 0
  return (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000 - 0.5 // [-0.5, 0.5)
  }
}

/** Feed `n` ticks at `bpm`, optionally jittered by +-`jitterMs`/2. Returns the
 *  time after the last tick. */
const feed = (
  f: MidiClockFollower,
  n: number,
  bpm: number,
  opts: { from?: number; jitterMs?: number; seed?: number } = {},
): number => {
  const period = 60000 / (bpm * TICKS_PER_QUARTER)
  const rnd = jitterer(opts.seed ?? 1)
  let t = opts.from ?? 0
  for (let i = 0; i < n; i++) {
    f.tick(t + (opts.jitterMs === undefined ? 0 : rnd() * opts.jitterMs))
    t += period
  }
  return t
}

describe('parseClock', () => {
  it('reads the four system realtime messages that drive a transport', () => {
    expect(parseClock([0xf8])).toBe('tick')
    expect(parseClock([0xfa])).toBe('start')
    expect(parseClock([0xfb])).toBe('continue')
    expect(parseClock([0xfc])).toBe('stop')
  })

  it('is not a note, a control change, active sensing or an empty message', () => {
    expect(parseClock([0x90, 60, 100])).toBeUndefined()
    expect(parseClock([0xb0, 74, 64])).toBeUndefined()
    expect(parseClock([0xfe])).toBeUndefined() // active sensing
    expect(parseClock([0xf2, 0, 4])).toBeUndefined() // song position
    expect(parseClock([])).toBeUndefined()
    expect(parseClock(null)).toBeUndefined()
  })

  it('round-trips through the send bytes', () => {
    for (const msg of ['tick', 'start', 'continue', 'stop'] as const) {
      expect(parseClock([CLOCK_BYTE[msg]])).toBe(msg)
    }
  })
})

describe('the tempo unit', () => {
  it('agrees with the app-wide bpm/cps conversion: one cycle is one bar of 4/4', () => {
    // 24 ticks a quarter x 4 quarters a bar. If this ever disagreed with
    // bpmToCps, a followed clock would play at the wrong tempo.
    expect(TICKS_PER_CYCLE).toBe(96)
    expect(cpsToBpm(0.5)).toBe(120)
    expect(bpmToCps(120)).toBe(0.5)
    expect(TICKS_PER_CYCLE / TICKS_PER_QUARTER).toBe(cpsToBpm(1) / 60)
  })
})

describe('tempo estimation', () => {
  it('reports nothing until it has heard a beat of clock', () => {
    const f = new MidiClockFollower()
    expect(f.locked).toBe(false)
    expect(f.bpm).toBeUndefined()
    feed(f, TICKS_PER_QUARTER, 120)
    expect(f.locked).toBe(false) // a beat exactly is not yet a beat PLUS one
    feed(f, 4, 120, { from: 500 })
    expect(f.locked).toBe(true)
  })

  it('reads a clean stream exactly', () => {
    for (const bpm of [60, 90, 120, 128, 174]) {
      const f = new MidiClockFollower()
      feed(f, 96, bpm)
      expect(f.bpm!).toBeCloseTo(bpm, 9)
      expect(f.cps!).toBeCloseTo(bpmToCps(bpm), 12)
    }
  })

  it('holds within a FIFTH of a BPM through +-1ms of per-tick jitter', () => {
    // 1ms of jitter is 5% of a single 120bpm tick interval, and reading one
    // interval on its own reports anywhere across a 12 BPM spread. Over 200
    // jitter streams the fit must not pass any of that through as audible
    // tempo wobble.
    let worst = 0
    for (let seed = 1; seed <= 200; seed++) {
      const f = new MidiClockFollower()
      feed(f, 96, 120, { jitterMs: 2, seed }) // +-1ms
      worst = Math.max(worst, Math.abs(f.bpm! - 120))
    }
    expect(worst).toBeLessThan(0.2)
  })

  it('stays inside a BPM even at +-5ms, which is worse than real gear', () => {
    let worst = 0
    for (let seed = 1; seed <= 200; seed++) {
      const f = new MidiClockFollower()
      feed(f, 96, 120, { jitterMs: 10, seed })
      worst = Math.max(worst, Math.abs(f.bpm! - 120))
    }
    expect(worst).toBeLessThan(1)
  })

  it('does not wobble tick to tick: successive readings of one stream barely move', () => {
    const f = new MidiClockFollower()
    const period = 60000 / (120 * TICKS_PER_QUARTER)
    const rnd = jitterer(7)
    let t = 0
    let prev: number | undefined
    let worstStep = 0
    for (let i = 0; i < 200; i++) {
      f.tick(t + rnd() * 2)
      t += period
      const bpm = f.bpm
      if (bpm === undefined) continue
      if (prev !== undefined) worstStep = Math.max(worstStep, Math.abs(bpm - prev))
      prev = bpm
    }
    expect(worstStep).toBeLessThan(0.05) // no step a listener could hear
  })

  it('follows a real tempo change, and settles on the new one', () => {
    const f = new MidiClockFollower()
    const end = feed(f, 96, 120)
    expect(f.bpm!).toBeCloseTo(120, 6)
    feed(f, 96, 140, { from: end })
    expect(f.bpm!).toBeCloseTo(140, 6)
  })

  it('rejects a stream that is not a musical tempo', () => {
    const slow = new MidiClockFollower()
    feed(slow, 96, 10) // 10 bpm
    expect(slow.bpm).toBeUndefined()
    const fast = new MidiClockFollower()
    feed(fast, 96, 600)
    expect(fast.bpm).toBeUndefined()
  })

  it('drops its history across a gap rather than averaging the silence in', () => {
    const f = new MidiClockFollower()
    const end = feed(f, 96, 120)
    expect(f.bpm!).toBeCloseTo(120, 6)
    // the cable comes out for three seconds, then the master returns at 90
    const back = end + 3000
    const resumed = feed(f, 10, 90, { from: back })
    expect(f.bpm).toBeUndefined() // history dropped: too few ticks to trust yet
    feed(f, 96, 90, { from: resumed })
    expect(f.bpm!).toBeCloseTo(90, 6) // and not a blend of 120 and the silence
  })
})

describe('start, stop and continue', () => {
  it('tracks whether the master transport is running', () => {
    const f = new MidiClockFollower()
    expect(f.running).toBe(false)
    f.start()
    expect(f.running).toBe(true)
    f.stop()
    expect(f.running).toBe(false)
    f.resume()
    expect(f.running).toBe(true)
  })

  it('start counts the bar from zero; ticks between stop and start do not count', () => {
    const f = new MidiClockFollower()
    feed(f, 48, 120) // clock running, transport stopped
    expect(f.tickCount).toBe(0)
    expect(f.phase).toBe(0)

    f.start()
    feed(f, 24, 120, { from: 1000 })
    expect(f.tickCount).toBe(24)
    expect(f.phase).toBeCloseTo(0.25, 12) // one beat into the bar

    f.stop()
    feed(f, 48, 120, { from: 2000 })
    expect(f.tickCount).toBe(24) // stopped means the position stands still
  })

  it('continue resumes the position, start restarts it', () => {
    const f = new MidiClockFollower()
    f.start()
    feed(f, 36, 120)
    f.stop()
    f.resume()
    expect(f.tickCount).toBe(36) // continue picks the position back up
    feed(f, 12, 120, { from: 2000 })
    expect(f.tickCount).toBe(48)
    f.start()
    expect(f.tickCount).toBe(0) // start is from the top
  })

  it('the tempo survives a stop: the clock keeps running even when the song does not', () => {
    const f = new MidiClockFollower()
    f.start()
    const end = feed(f, 96, 128)
    f.stop()
    feed(f, 24, 128, { from: end })
    expect(f.bpm!).toBeCloseTo(128, 6)
  })

  it('reset forgets everything, which is what switching following off means', () => {
    const f = new MidiClockFollower()
    f.start()
    feed(f, 96, 120)
    f.reset()
    expect(f.bpm).toBeUndefined()
    expect(f.running).toBe(false)
    expect(f.tickCount).toBe(0)
  })
})

describe('phase: staying in the bar, not just at the tempo', () => {
  const at = (ticks: number): MidiClockFollower => {
    const f = new MidiClockFollower()
    f.start()
    feed(f, ticks, 120)
    return f
  }

  it('measures the error the short way round', () => {
    const f = at(48) // master is half a bar in
    expect(f.phase).toBeCloseTo(0.5, 12)
    expect(f.phaseError(0.5)).toBeCloseTo(0, 12) // together
    expect(f.phaseError(0.25)).toBeCloseTo(0.25, 12) // master ahead
    expect(f.phaseError(0.75)).toBeCloseTo(-0.25, 12) // master behind
    // wrapping: master at 0.5 and us at 0.05 is the master 0.45 AHEAD, not
    // 0.45 behind through the long way
    expect(at(48).phaseError(0.05)).toBeCloseTo(0.45, 12)
    // and just past the top of the bar we are AHEAD of the master, not a bar behind
    expect(at(0).phaseError(0.02)).toBeCloseTo(-0.02, 12)
  })

  it('is the same at bar 1 as at bar 100 (the position is modulo the bar)', () => {
    expect(at(24).phaseError(0.25)).toBeCloseTo(0, 12)
    expect(at(24 + 96 * 99).phaseError(0.25 + 99)).toBeCloseTo(0, 12)
  })

  it('trims the rate to close a drift, and the trim is small', () => {
    const f = at(48)
    const rate = f.cps!
    expect(rate).toBeCloseTo(0.5, 9)
    // we have fallen a hundredth of a bar behind: speed up, barely
    const behind = f.targetCps(0.49)!
    expect(behind).toBeGreaterThan(rate)
    expect(behind / rate - 1).toBeCloseTo(0.25 * 0.01, 9)
    // running ahead: slow down by the same amount
    const ahead = f.targetCps(0.51)!
    expect(ahead / rate - 1).toBeCloseTo(-0.25 * 0.01, 9)
  })

  it('never trims further than the cap, however far out we are', () => {
    const f = at(48)
    const rate = f.cps!
    for (const ours of [0.01, 0.2, 0.8, 0.99]) {
      const target = f.targetCps(ours)!
      expect(Math.abs(target / rate - 1)).toBeLessThanOrEqual(DEFAULT_MAX_TRIM + 1e-12)
    }
  })

  it('a drift closes: simulating the loop walks the error to zero', () => {
    const f = new MidiClockFollower()
    f.start()
    let t = feed(f, 96, 120)
    let ours = 0.04 // we are running 4% of a bar ahead of the master
    expect(Math.abs(f.phaseError(ours))).toBeCloseTo(0.04, 9)
    for (let i = 0; i < 200; i++) {
      const target = f.targetCps(ours)!
      // one control period of a beat: the master advances a quarter bar, and
      // we advance a quarter bar scaled by the trim we just applied
      ours = (ours + 0.25 * (target / f.cps!)) % 1
      t = feed(f, TICKS_PER_QUARTER, 120, { from: t })
    }
    expect(Math.abs(f.phaseError(ours))).toBeLessThan(0.001)
  })

  it('does not chase a position while the master is stopped', () => {
    const f = new MidiClockFollower()
    feed(f, 96, 120) // clock only, transport stopped
    expect(f.targetCps(0.4)).toBe(f.cps)
  })

  it('reports no tempo at all before lock, trim or no trim', () => {
    const f = new MidiClockFollower()
    f.start()
    feed(f, 8, 120)
    expect(f.targetCps(0)).toBeUndefined()
  })
})

describe('sending clock', () => {
  it('schedules ticks at 96 to the cycle, on exact timestamps', () => {
    const s = new MidiClockSender({ lookaheadMs: 100 })
    s.start(1000)
    const ticks = s.due(1000, 0.5) // 120 bpm: a tick every 20.833ms
    expect(ticks[0]).toBe(1000) // the first tick is the downbeat itself
    expect(ticks).toHaveLength(5) // every tick in [1000, 1100], and no more
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBeCloseTo(1000 / (0.5 * 96), 9)
    }
  })

  it('never repeats or skips a tick across polls', () => {
    const s = new MidiClockSender({ lookaheadMs: 100 })
    s.start(0)
    const all: number[] = []
    for (let now = 0; now <= 1000; now += 50) all.push(...s.due(now, 0.5))
    // one second at 120 bpm is 48 ticks; the lookahead pulls a few extra in
    expect(all.length).toBeGreaterThanOrEqual(48)
    expect(new Set(all).size).toBe(all.length) // no repeats
    for (let i = 1; i < all.length; i++) {
      expect(all[i]! - all[i - 1]!).toBeCloseTo(1000 / 48, 6) // no gaps either
    }
  })

  it('emits nothing until started, and nothing after stopping', () => {
    const s = new MidiClockSender()
    expect(s.due(0, 0.5)).toEqual([])
    s.start(0)
    expect(s.due(0, 0.5).length).toBeGreaterThan(0)
    s.stop()
    expect(s.due(1000, 0.5)).toEqual([])
    expect(s.running).toBe(false)
  })

  it('changes rate with the tempo', () => {
    const s = new MidiClockSender({ lookaheadMs: 100 })
    s.start(0)
    s.due(0, 0.5)
    const fast = s.due(200, 1) // 240 bpm: half the period
    for (let i = 1; i < fast.length; i++) {
      expect(fast[i]! - fast[i - 1]!).toBeCloseTo(1000 / 96, 9)
    }
  })

  it('a stalled tab skips the backlog instead of firing it all at once', () => {
    const s = new MidiClockSender({ lookaheadMs: 100 })
    s.start(0)
    s.due(0, 0.5)
    const after = s.due(60000, 0.5) // the tab was frozen for a minute
    expect(after.length).toBeLessThan(10)
    expect(after[0]).toBeGreaterThanOrEqual(60000 - 100)
  })

  it('caps one batch, so an absurd tempo cannot queue forever', () => {
    const s = new MidiClockSender({ lookaheadMs: 100000 })
    s.start(0)
    expect(s.due(0, 4).length).toBe(MAX_BATCH)
  })

  it('ignores a nonsense tempo rather than looping forever', () => {
    const s = new MidiClockSender()
    s.start(0)
    expect(s.due(0, 0)).toEqual([])
    expect(s.due(0, Number.NaN)).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * Precedence, over a real Session: who owns the tempo when the document and an
 * external master disagree.
 * ------------------------------------------------------------------------- */

const sessionRig = () => {
  const sent: EngineMessage[] = []
  const audio = {
    send: (m: EngineMessage) => {
      sent.push(m)
    },
    onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
    currentTimeFrames: 0,
    sampleRate: 48000,
  }
  const intervals: { fn: () => void; cleared: boolean }[] = []
  const session = new Session({
    audio,
    startLead: 0,
    setIntervalImpl: (fn) => {
      const h = { fn, cleared: false }
      intervals.push(h)
      return h
    },
    clearIntervalImpl: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  })
  const engineCps = (): number[] =>
    sent.filter((m): m is Extract<EngineMessage, { kind: 'setCps' }> => m.kind === 'setCps').map((m) => m.cps)
  return { audio, sent, session, engineCps }
}

const SRC = (cps: number): string =>
  `const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate))\np('pat', note('60').sound('a'))\nsetCps(${cps})`

describe('tempo precedence: document versus external clock', () => {
  it('with no external master the document owns the tempo, as before', () => {
    const { session } = sessionRig()
    session.evalCode(SRC(0.75))
    expect(session.getState().cps).toBe(0.75)
    expect(session.followingExternalCps).toBe(false)
  })

  it('THE RULE: while following, the external clock wins and the document waits', () => {
    const { session } = sessionRig()
    session.evalCode(SRC(0.75))
    session.setExternalCps(bpmToCps(128))
    expect(session.getState().cps).toBeCloseTo(bpmToCps(128), 12)
    expect(session.followingExternalCps).toBe(true)

    // a live re-eval of the SAME tune must not yank the tempo off the master
    session.evalCode(SRC(0.75))
    expect(session.getState().cps).toBeCloseTo(bpmToCps(128), 12)
    // nor must editing the tempo line mid-set
    session.evalCode(SRC(0.25))
    expect(session.getState().cps).toBeCloseTo(bpmToCps(128), 12)
    expect(session.documentCps).toBe(0.25) // but it IS remembered
  })

  it('releasing the clock restores what the tune says, not the last master tempo', () => {
    const { session } = sessionRig()
    session.evalCode(SRC(0.75))
    session.setExternalCps(bpmToCps(128))
    session.evalCode(SRC(0.25))
    session.setExternalCps(undefined)
    expect(session.getState().cps).toBe(0.25)
    expect(session.followingExternalCps).toBe(false)
  })

  it('a tune with no setCps line keeps the tempo it was following, rather than jumping', () => {
    const { session } = sessionRig()
    session.evalCode(`const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate))`)
    session.setExternalCps(bpmToCps(140))
    session.setExternalCps(undefined)
    expect(session.getState().cps).toBeCloseTo(bpmToCps(140), 12)
  })

  it('the header tempo field obeys the same rule, and is remembered', () => {
    const { session } = sessionRig()
    session.evalCode(SRC(0.5))
    session.setExternalCps(bpmToCps(128))
    session.setCps(bpmToCps(90)) // typing in the BPM field while following
    expect(session.getState().cps).toBeCloseTo(bpmToCps(128), 12)
    session.setExternalCps(undefined)
    expect(session.getState().cps).toBeCloseTo(bpmToCps(90), 12)
  })

  it('an explicit transport cps obeys the same rule', () => {
    const { session } = sessionRig()
    session.setExternalCps(bpmToCps(128))
    session.transport('play', { cps: 0.25 })
    expect(session.getState().cps).toBeCloseTo(bpmToCps(128), 12)
    session.transport('stop')
    session.setExternalCps(undefined)
    expect(session.getState().cps).toBe(0.25)
  })

  it('the followed tempo reaches the ENGINE, so synced lfos and delays follow too', () => {
    const { session, engineCps } = sessionRig()
    session.evalCode(SRC(0.5))
    session.setExternalCps(bpmToCps(128))
    expect(engineCps().at(-1)).toBeCloseTo(bpmToCps(128), 12)
    session.setExternalCps(undefined)
    expect(engineCps().at(-1)).toBe(0.5)
  })

  it('an unchanged followed tempo is not resent to the engine every push', () => {
    const { session, engineCps } = sessionRig()
    session.evalCode(SRC(0.5))
    const before = engineCps().length
    for (let i = 0; i < 20; i++) session.setExternalCps(bpmToCps(128))
    expect(engineCps().length).toBe(before + 1)
  })

  it('refuses a nonsense external tempo instead of stopping the transport dead', () => {
    const { session } = sessionRig()
    session.evalCode(SRC(0.5))
    session.setExternalCps(0)
    session.setExternalCps(Number.NaN)
    session.setExternalCps(-1)
    expect(session.getState().cps).toBe(0.5)
    expect(session.followingExternalCps).toBe(false)
  })
})

describe('the transport position an external clock steers by', () => {
  it('is zero while stopped and advances with the audio clock at the current tempo', () => {
    const { audio, session } = sessionRig()
    session.evalCode(SRC(0.5))
    expect(session.cycle).toBe(0)
    audio.currentTimeFrames = 0
    session.transport('play')
    expect(session.cycle).toBeCloseTo(0, 9)
    audio.currentTimeFrames = 48000 // one second at cps 0.5 is half a cycle
    expect(session.cycle).toBeCloseTo(0.5, 9)
    session.transport('stop')
    expect(session.cycle).toBe(0)
  })

  it('is what makes the phase trim converge over a real session', () => {
    const { audio, session } = sessionRig()
    session.evalCode(SRC(0.5))
    audio.currentTimeFrames = 0
    session.transport('play')
    const f = new MidiClockFollower()
    f.start()
    feed(f, 96, 120)
    // the master is at the downbeat; we are a twentieth of a bar past it
    audio.currentTimeFrames = 0.1 * 48000 // 0.05 cycles at cps 0.5
    expect(f.phaseError(session.cycle)).toBeCloseTo(-0.05, 6)
    const target = f.targetCps(session.cycle)!
    expect(target).toBeLessThan(f.cps!) // slow down to let the master catch up
  })
})
