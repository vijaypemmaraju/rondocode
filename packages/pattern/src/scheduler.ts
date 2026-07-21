import { Fraction } from './fraction'
import { TimeSpan, hasOnset } from './types'
import type { Pattern } from './pattern'
import type { ControlMap } from './controls'
import type { Loc } from './mini'

/* ------------------------------------------------------------------------- *
 * Lookahead scheduler: the bridge from pattern time (cycles, exact
 * Fractions) to wall/audio time (seconds, floats). Each tick() queries the
 * half-open cycle window [lastQueried, cycleAt(now + lookahead)) across all
 * registered patterns, fires the ONSET haps (whole.begin inside the window
 * — Tidal's rule; clipped tails and continuous samples never fire), and
 * advances the high-water mark.
 *
 * Correctness properties, all pinned in scheduler.test.ts:
 *
 * - NO DOUBLE-FIRE, NO GAP: windows are half-open and strictly monotonic —
 *   `queried` only ever advances, and window ends are computed as exact
 *   Fractions, so an onset exactly at a window end falls into the NEXT
 *   window, once. A stalled or backwards clock yields empty/no-op windows.
 * - PIECEWISE-LINEAR TIME: cycle↔seconds conversion goes through a
 *   (timeSec, cycle) anchor. setCps() pivots the anchor AT THE QUERIED
 *   BOUNDARY (not retroactively): everything already handed to onEvents
 *   keeps its old timing, everything after the boundary uses the new cps,
 *   and cycle position is preserved — tempo changes never jump back or
 *   re-fire.
 * - HOT-SWAP: setPattern/removePattern take effect at the next tick's
 *   window; the already-queried region is never revisited.
 *
 * The scheduler has NO internal timer by default: the host drives tick()
 * (an app from its audio-clock callback, tests from a fake clock). start()
 * is a convenience that drives tick() from setInterval (injectable).
 *
 * Transport is v1-simple: play() (re)starts at cycle 0 anchored at
 * getTime() now; stop() halts and discards the window state, so
 * stop→play restarts from cycle 0 rather than resuming.
 * ------------------------------------------------------------------------- */

export interface SchedulerEvent {
  /** Absolute event time in the getTime() clock's seconds. */
  timeSec: number
  /** Sounding length: whole × (1/cps) × (controls.dur ?? 1). */
  durSec: number
  /** The event's control bag, exactly as patterned (gain missing = 1). */
  controls: ControlMap
  /** Integer cycle the event's onset falls in. */
  cycle: number
  /** Source range of the originating mini-notation atom, when known. */
  loc?: Loc
}

export interface SchedulerOpts {
  /** Monotonic seconds (audio clock). Read once per tick. */
  getTime: () => number
  /** Receives each tick's onset events, sorted by timeSec. Only called
   *  when there is at least one event. */
  onEvents: (evs: SchedulerEvent[]) => void
  /** Seconds of future queried ahead of now each tick. Default 0.1. */
  lookahead?: number
  /** Tick period in seconds used by start()'s timer. Default 0.025. */
  interval?: number
  /**
   * Seconds to anchor cycle 0 AHEAD of getTime() in play(). Default 0.
   * A live audio host wants a small lead (e.g. one lookahead) so the very
   * first onset is a FUTURE-timestamped event that the engine queues and
   * fires precisely — rather than a past-due event that fires immediately
   * into an audio graph still spinning up (the classic "first note eaten").
   * Tests drive tick() off a fake clock and want 0 so event times are exact.
   */
  startLead?: number
  /**
   * Called when a pattern's query throws during tick(): the failing
   * pattern contributes no events THIS window but the other patterns (and
   * future ticks) proceed — one bad user pattern must not kill the set.
   * The engine philosophy applies: worth hearing about, not worth stopping
   * audio for; the app's Session layer surfaces these to the editor as
   * diagnostics. Omitted → failures are silently contained. Exceptions
   * thrown by the hook itself are swallowed.
   *
   * The sentinel name '*' reports a SCHEDULER-INTERNAL window failure
   * (e.g. a pathological clock overflowing exact-fraction range): that
   * tick fires nothing and does not advance, so a later sane tick resumes
   * cleanly.
   */
  onError?: (patternName: string, error: unknown) => void
}

const DEFAULT_CPS = 0.5
const DEFAULT_LOOKAHEAD = 0.1
const DEFAULT_INTERVAL = 0.025
/** Window-edge quantization grid, in fractions of a cycle (see cycleAt). */
const QUANT = 10_000

type SetIntervalImpl = (fn: () => void, ms: number) => unknown
type ClearIntervalImpl = (handle: unknown) => void

/** globalThis timers, typed loosely (this package's tsconfig pulls in no
 *  platform lib — the pattern layer is environment-agnostic). Throws only
 *  if start() is used somewhere without timers; tick()-driving hosts and
 *  injected impls never touch this. */
const defaultTimers = (): { setInterval: SetIntervalImpl; clearInterval: ClearIntervalImpl } => {
  const g = globalThis as {
    setInterval?: (fn: () => void, ms: number) => unknown
    clearInterval?: (h: unknown) => void
  }
  const si = g.setInterval
  const ci = g.clearInterval
  if (si === undefined || ci === undefined) {
    throw new Error('Scheduler.start(): no global setInterval; inject an implementation')
  }
  return { setInterval: (fn, ms) => si.call(g, fn, ms), clearInterval: (h) => ci.call(g, h) }
}

export class Scheduler {
  private readonly getTime: () => number
  private readonly onEvents: (evs: SchedulerEvent[]) => void
  private readonly lookahead: number
  private readonly interval: number
  private readonly startLead: number
  private readonly onError: ((patternName: string, error: unknown) => void) | undefined

  private readonly pats = new Map<string, Pattern<ControlMap>>()
  private _cps = DEFAULT_CPS
  private playing = false
  /** Piecewise-linear time anchor: cycle `anchorCycle` happens at
   *  `anchorTime` seconds; slope is `_cps` cycles per second. */
  private anchorTime = 0
  private anchorCycle = Fraction.ZERO
  /** Exclusive end of the last queried window, in cycles. */
  private queried = Fraction.ZERO
  private timerHandle: unknown
  private timerClear: ClearIntervalImpl | undefined

  constructor(opts: SchedulerOpts) {
    this.getTime = opts.getTime
    this.onEvents = opts.onEvents
    this.lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD
    this.interval = opts.interval ?? DEFAULT_INTERVAL
    this.startLead = opts.startLead ?? 0
    this.onError = opts.onError
  }

  /** Register or REPLACE the pattern under `name`; effective next tick. */
  setPattern(name: string, p: Pattern<ControlMap>): void {
    this.pats.set(name, p)
  }

  removePattern(name: string): void {
    this.pats.delete(name)
  }

  /** Names of the registered patterns (insertion order). */
  patterns(): string[] {
    return [...this.pats.keys()]
  }

  get cps(): number {
    return this._cps
  }

  /**
   * Change tempo (cycles per second, default 0.5). Takes effect at the
   * NEXT QUERY BOUNDARY: the anchor pivots to the current high-water mark
   * under the OLD mapping, so events already fired keep their timing and
   * cycle position is preserved across the change (piecewise-linear time).
   */
  setCps(cps: number): void {
    if (!Number.isFinite(cps) || cps <= 0) {
      throw new RangeError(`cps must be a positive finite number, got ${cps}`)
    }
    if (this.playing) {
      this.anchorTime = this.timeOfCycle(this.queried)
      this.anchorCycle = this.queried
    }
    this._cps = cps
  }

  /** Start (or restart) at cycle 0, anchored `startLead` seconds ahead of
   *  getTime() now (default 0) so the first onset lands in the future. */
  play(): void {
    this.anchorTime = this.getTime() + this.startLead
    this.anchorCycle = Fraction.ZERO
    this.queried = Fraction.ZERO
    this.playing = true
  }

  /** Halt: no further events; discards the window state (play() restarts
   *  from cycle 0). Also clears any timer installed by start(). */
  stop(): void {
    this.playing = false
    if (this.timerHandle !== undefined) {
      this.timerClear?.(this.timerHandle)
      this.timerHandle = undefined
      this.timerClear = undefined
    }
  }

  /**
   * Convenience self-driving mode: play(), then tick() every `interval`
   * seconds via the given setInterval (globalThis.setInterval by default).
   * stop() clears the timer. The injectable impls exist for tests and for
   * hosts with their own timer abstraction.
   */
  start(
    setIntervalImpl: SetIntervalImpl = defaultTimers().setInterval,
    clearIntervalImpl: ClearIntervalImpl = defaultTimers().clearInterval,
  ): void {
    this.stop() // never two timers
    this.play()
    this.timerClear = clearIntervalImpl
    this.timerHandle = setIntervalImpl(() => this.tick(), Math.round(this.interval * 1000))
  }

  /**
   * Query [queried, cycleAt(now + lookahead)) and fire onset haps. Safe to
   * call at any rate; a window that would not advance is a no-op.
   */
  tick(): void {
    if (!this.playing) return
    // Defense in depth: the window math above the per-pattern loop must
    // never throw INTO the host's audio callback. A failure here (e.g. a
    // pathological clock overflowing Fraction range) reports as
    // onError('*') and leaves `queried` unadvanced — a later sane tick
    // resumes exactly where this one left off.
    let span: TimeSpan
    try {
      const end = this.cycleAt(this.getTime() + this.lookahead)
      if (!end.gt(this.queried)) return // stalled/backwards clock: no-op
      span = new TimeSpan(this.queried, end)
      this.queried = end
    } catch (e) {
      try {
        this.onError?.('*', e)
      } catch {
        // a throwing error hook must not take down the scheduler
      }
      return
    }
    const evs: SchedulerEvent[] = []
    for (const [name, p] of this.pats) {
      // Per-pattern isolation: a throwing query loses ITS events for this
      // window only; the rest of the set keeps playing (see onError doc).
      try {
        for (const h of p.query(span)) {
          if (!hasOnset(h)) continue
          const whole = h.whole! // hasOnset guarantees it
          const controls = h.value
          const dur = typeof controls.dur === 'number' ? controls.dur : 1
          const ev: SchedulerEvent = {
            timeSec: this.timeOfCycle(whole.begin),
            durSec: (whole.length.valueOf() / this._cps) * dur,
            controls,
            cycle: whole.begin.sam().valueOf(),
          }
          if (controls.loc !== undefined) ev.loc = controls.loc
          evs.push(ev)
        }
      } catch (e) {
        try {
          this.onError?.(name, e)
        } catch {
          // a throwing error hook must not take down the scheduler
        }
      }
    }
    if (evs.length === 0) return
    evs.sort((a, b) => a.timeSec - b.timeSec)
    this.onEvents(evs)
  }

  /**
   * seconds → cycles through the current anchor: computed in FLOAT and
   * quantized once onto the fixed 1/QUANT grid.
   *
   * Why a fixed coarse grid and not Fraction.fromNumber — the same
   * overflow class, two layers deep (both reproduced by the longevity
   * test before being fixed):
   * 1. `anchorCycle.add(fromNumber(...))` COMPOUNDED denominators at every
   *    setCps pivot → overflow seconds after the second tempo change.
   * 2. fromNumber alone caps denominators at 1e6, but comparisons
   *    cross-multiply n1·d2 ≈ cycle·1e6·1e6, so `end.gt(queried)`
   *    overflowed MAX_SAFE_INTEGER at ~cycle 9000 (~2.5 h at cps 1) —
   *    preceded by silent per-pattern window drops as query-side math hit
   *    the same wall.
   * With the fixed grid, cross products stay ~cycle·QUANT² = cycle·1e8:
   * safe to ~9e7 cycles (years of continuous play).
   *
   * The ≤ 1/(2·QUANT) = 5e-5-cycle edge rounding is inaudible and only
   * decides WHICH WINDOW an onset lands in — a fired event's timeSec comes
   * from the exact pattern-side whole.begin, never from the edge. `queried`
   * stores the exact grid Fraction used, keeping windows half-open,
   * adjacent, and monotonic — every onset still fires exactly once.
   */
  private cycleAt(timeSec: number): Fraction {
    const c = this.anchorCycle.valueOf() + (timeSec - this.anchorTime) * this._cps
    return Fraction.of(Math.round(c * QUANT), QUANT)
  }

  /** cycles → seconds through the current anchor. */
  private timeOfCycle(cycle: Fraction): number {
    return this.anchorTime + cycle.sub(this.anchorCycle).valueOf() / this._cps
  }
}
