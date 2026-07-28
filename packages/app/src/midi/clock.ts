/* ------------------------------------------------------------------------- *
 * MIDI clock: play in time with other gear.
 *
 * WHY NOT ABLETON LINK. Link is a native C++ library that speaks UDP multicast
 * on 224.76.78.75:20808, joining and leaving the group over IGMP. A web page
 * cannot open a raw or multicast UDP socket at all: WebRTC only gives you an
 * ICE-negotiated unicast association, and Chrome's Direct Sockets API (the one
 * web API with real UDP, multicast included) is restricted to signed, installed
 * Isolated Web Apps, which a page on the open web is not. Every "Link in the
 * browser" project works the same way: a NATIVE helper process joins the Link
 * session and relays over a WebSocket. So there is nothing to build here
 * without shipping a native binary.
 *
 * MIDI clock, on the other hand, is just bytes on a MIDI port, and Web MIDI
 * carries it in both directions. It is what a drum machine, a groovebox, a
 * DAW and a DJ mixer all speak.
 *
 * THE PROTOCOL. Three single-byte system-realtime messages plus the tick:
 * 0xF8 clock tick at 24 per quarter note, 0xFA start, 0xFB continue, 0xFC
 * stop. Ticks carry no tempo number: the tempo IS the tick rate, so following
 * a master means measuring it.
 *
 * THE UNIT. One rondocode cycle is one bar of 4/4 (the same convention the
 * MIDI export writes), so a cycle is 96 ticks and cps = bpm / 240. A cps of
 * 0.5, the default, is 120 bpm.
 *
 * MEASURING IT WITHOUT WOBBLE. Raw tick-to-tick intervals are useless: at 120
 * bpm a tick lands every 20.83 ms, and a millisecond of USB or driver jitter
 * on a single interval is a 5% tempo error. So the tempo is a LEAST-SQUARES
 * FIT of the last WINDOW tick timestamps against tick index, whose noise falls
 * as roughly window^-1.5 rather than window^-0.5: over 48 ticks (two beats) a
 * millisecond of per-tick jitter comes out as 0.03 BPM rms, against 12 BPM for
 * reading one interval. The fit is also unbiased under a tempo ramp, which a
 * plain moving average is not.
 *
 * AND WITHOUT DRIFT. Tracking the rate alone still drifts: a tenth of a
 * percent of tempo error is a tenth of a beat every hundred beats. So the
 * follower also compares the master's phase WITHIN THE BAR (an exact tick
 * count, no estimation involved) against ours, and trims the rate
 * proportionally to close it. The trim is clamped hard: it exists to cancel
 * drift, not to yank a misaligned downbeat into place.
 *
 * This module is PURE: timestamps in, numbers out. The editor layer feeds it
 * Web MIDI events and applies the result, so every rule here is tested against
 * a synthetic tick stream.
 * ------------------------------------------------------------------------- */

import { cpsToBpm } from '@rondocode/pattern'

/** MIDI clock resolution: ticks per quarter note. Fixed by the spec. */
export const TICKS_PER_QUARTER = 24
/** One cycle is one bar of 4/4, matching the MIDI export and the bpm/cps
 *  conversion the rest of the app uses (see @rondocode/pattern's bpmToCps). */
export const QUARTERS_PER_CYCLE = 4
/** 96. The number that turns a tick rate into cps. */
export const TICKS_PER_CYCLE = TICKS_PER_QUARTER * QUARTERS_PER_CYCLE

/** Tempos outside this band are not a musical clock: a stream that estimates
 *  outside it is treated as unlocked rather than reported. */
export const MIN_BPM = 20
export const MAX_BPM = 400

/** Ticks fitted for the tempo estimate (two beats). */
export const DEFAULT_WINDOW = 48
/** Ticks required before the estimate is trusted (one beat). */
export const DEFAULT_MIN_TICKS = 24
/** Rate trim per cycle of phase error. */
export const DEFAULT_PHASE_GAIN = 0.25
/** Hard cap on the trim, as a fraction of the rate. 2% is inaudible as a
 *  tempo change and still removes drift far faster than it accumulates. */
export const DEFAULT_MAX_TRIM = 0.02
/** A tick this many times later than expected means the stream broke (cable
 *  out, master paused mid-bar): the history is dropped rather than averaged
 *  with the gap. */
export const GAP_FACTOR = 4

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** The system-realtime messages that matter to a transport. */
export type ClockMessage = 'tick' | 'start' | 'continue' | 'stop'

/** Read a raw MIDI message as a clock message, or undefined for anything else
 *  (notes, control changes, active sensing, song position). */
export const parseClock = (data: ArrayLike<number> | null | undefined): ClockMessage | undefined => {
  if (!data || data.length < 1) return undefined
  switch (data[0]) {
    case 0xf8:
      return 'tick'
    case 0xfa:
      return 'start'
    case 0xfb:
      return 'continue'
    case 0xfc:
      return 'stop'
    default:
      return undefined
  }
}

/** Raw byte for each clock message, for the sending side. */
export const CLOCK_BYTE: Record<ClockMessage, number> = {
  tick: 0xf8,
  start: 0xfa,
  continue: 0xfb,
  stop: 0xfc,
}

export interface FollowerOpts {
  /** Tick timestamps fitted for the tempo. Default 48. */
  window?: number
  /** Ticks required before `cps` reports anything. Default 24. */
  minTicks?: number
  /** Rate trim per cycle of phase error. Default 0.25. */
  phaseGain?: number
  /** Cap on the trim as a fraction of the rate. Default 0.02. */
  maxTrim?: number
}

/**
 * Follows an external MIDI clock: feed it ticks and transport messages, ask it
 * for a tempo.
 *
 * Ticks are counted for the tempo whether or not the master's transport is
 * running (most gear sends clock continuously), but the bar position only
 * advances while it is, since that is what the position means.
 */
export class MidiClockFollower {
  private readonly window: number
  private readonly minTicks: number
  private readonly phaseGain: number
  private readonly maxTrim: number
  /** Tick timestamps, oldest first, at most window+1 of them. */
  private readonly times: number[] = []
  /** Ticks since the master last started (or continued). */
  private ticks = 0
  private isRunning = false

  constructor(opts: FollowerOpts = {}) {
    this.window = opts.window ?? DEFAULT_WINDOW
    this.minTicks = opts.minTicks ?? DEFAULT_MIN_TICKS
    this.phaseGain = opts.phaseGain ?? DEFAULT_PHASE_GAIN
    this.maxTrim = opts.maxTrim ?? DEFAULT_MAX_TRIM
  }

  /** A 0xF8 at `timeMs` on a monotonic clock (MIDIMessageEvent.timeStamp). */
  tick(timeMs: number): void {
    const prev = this.times[this.times.length - 1]
    const period = this.periodMs()
    if (prev !== undefined && period !== undefined && timeMs - prev > period * GAP_FACTOR) {
      // the stream broke: start the estimate over rather than averaging the gap
      this.times.length = 0
    }
    this.times.push(timeMs)
    if (this.times.length > this.window + 1) this.times.shift()
    if (this.isRunning) this.ticks++
  }

  /** 0xFA: the master starts from the top. */
  start(): void {
    this.ticks = 0
    this.isRunning = true
  }

  /** 0xFB: the master resumes from where it stopped, so the bar position keeps
   *  counting from where it was rather than restarting. */
  resume(): void {
    this.isRunning = true
  }

  /** 0xFC. */
  stop(): void {
    this.isRunning = false
  }

  /** The master's transport is running. */
  get running(): boolean {
    return this.isRunning
  }

  /** Ticks counted since the master started. */
  get tickCount(): number {
    return this.ticks
  }

  /** Forget the measurement (the port closed, or following was switched off).
   *  The transport state goes with it: we no longer know what the master does. */
  reset(): void {
    this.times.length = 0
    this.ticks = 0
    this.isRunning = false
  }

  /** Milliseconds per tick from the least-squares fit, or undefined before
   *  lock. */
  private periodMs(): number | undefined {
    const n = this.times.length
    if (n <= this.minTicks) return undefined
    // slope of t against tick index; indices are 0..n-1, so their mean and
    // their variance are closed forms.
    const meanI = (n - 1) / 2
    let meanT = 0
    for (const t of this.times) meanT += t
    meanT /= n
    let cov = 0
    let varI = 0
    for (let i = 0; i < n; i++) {
      const di = i - meanI
      cov += di * (this.times[i]! - meanT)
      varI += di * di
    }
    if (varI === 0) return undefined
    const slope = cov / varI
    return slope > 0 ? slope : undefined
  }

  /** True once the tempo is measured and musically plausible. */
  get locked(): boolean {
    return this.cps !== undefined
  }

  /** The master's tempo in cycles per second, or undefined before lock. */
  get cps(): number | undefined {
    const period = this.periodMs()
    if (period === undefined) return undefined
    const cps = 1000 / (period * TICKS_PER_CYCLE)
    const bpm = cpsToBpm(cps)
    if (bpm < MIN_BPM || bpm > MAX_BPM) return undefined // not a musical clock
    return cps
  }

  /** The master's tempo in bpm, or undefined before lock. */
  get bpm(): number | undefined {
    const cps = this.cps
    return cps === undefined ? undefined : cpsToBpm(cps)
  }

  /** Where the master is in its bar, in [0, 1). Exact: it is a tick count. */
  get phase(): number {
    return (this.ticks % TICKS_PER_CYCLE) / TICKS_PER_CYCLE
  }

  /** How far the master's bar position is AHEAD of ours, in cycles, taking the
   *  short way round: in (-0.5, 0.5]. */
  phaseError(ourCycle: number): number {
    const ours = ((ourCycle % 1) + 1) % 1
    const d = (((this.phase - ours) % 1) + 1.5) % 1 - 0.5
    return d
  }

  /**
   * The tempo to actually run at: the measured rate, trimmed to close the
   * phase error. Undefined before lock, and untrimmed while the master's
   * transport is stopped (there is no position to chase).
   */
  targetCps(ourCycle: number): number | undefined {
    const cps = this.cps
    if (cps === undefined) return undefined
    if (!this.isRunning) return cps
    const trim = clamp(this.phaseGain * this.phaseError(ourCycle), -this.maxTrim, this.maxTrim)
    return cps * (1 + trim)
  }
}

/* ---- sending -------------------------------------------------------------- */

/** Cap on one batch, so a stalled tab or an absurd tempo cannot queue
 *  thousands of ticks at once. */
export const MAX_BATCH = 256

export interface SenderOpts {
  /** How far ahead ticks are scheduled, in ms. Default 150. Web MIDI delivers
   *  a timestamped send at that exact time, which is far steadier than firing
   *  each tick from a timer; the cost is that a tempo change takes up to this
   *  long to reach the wire, since a queued send cannot be recalled. */
  lookaheadMs?: number
}

/**
 * Generates the tick timestamps to hand to MIDIOutput.send, so other gear
 * follows rondocode. Pure: it knows nothing about ports.
 */
export class MidiClockSender {
  private readonly lookaheadMs: number
  /** Timestamp of the next tick to schedule, or undefined when stopped. */
  private next: number | undefined

  constructor(opts: SenderOpts = {}) {
    this.lookaheadMs = opts.lookaheadMs ?? 150
  }

  get running(): boolean {
    return this.next !== undefined
  }

  /** Begin at `nowMs`: the first tick lands on the downbeat, together with the
   *  0xFA the caller sends at the same timestamp. */
  start(nowMs: number): void {
    this.next = nowMs
  }

  stop(): void {
    this.next = undefined
  }

  /** Tick timestamps due to be scheduled now, and advance past them. Call it
   *  from a timer more often than the lookahead. */
  due(nowMs: number, cps: number): number[] {
    if (this.next === undefined || !Number.isFinite(cps) || cps <= 0) return []
    const period = 1000 / (cps * TICKS_PER_CYCLE)
    // A long stall (backgrounded tab) would otherwise emit the whole backlog
    // at once: skip to now instead, since those ticks are in the past.
    if (this.next < nowMs - this.lookaheadMs) this.next = nowMs
    const out: number[] = []
    const until = nowMs + this.lookaheadMs
    while (this.next <= until && out.length < MAX_BATCH) {
      out.push(this.next)
      this.next += period
    }
    return out
  }
}
