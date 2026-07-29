/* ------------------------------------------------------------------------- *
 * Driving the live arp from the transport.
 *
 * The arp core (livearp.ts) is pure: given a step index and a held chord it
 * says what should sound. This is the part that decides WHEN, and it is kept
 * separate because the timing rules are where the bugs live.
 *
 * Two of those rules were learned the hard way elsewhere in this app:
 *
 *   - The step index comes from the TRANSPORT (Session.cycleAt), never from
 *     wall-clock time. Wall clock keeps running through a stop and does not
 *     reset on play, so an arp driven by it resumes mid-figure after a restart
 *     instead of starting at step 0 — exactly the bug the roll playhead had.
 *   - A stop must RELEASE what is sounding. A synth left gated is the
 *     stuck-note failure, and here it would be a chord held down forever.
 * ------------------------------------------------------------------------- */

import { HeldNotes, LiveArp } from './livearp'
import type { LiveArpOpts } from './livearp'

export interface ArpHost {
  /** audio-clock now, in seconds. */
  now: () => number
  /** seconds -> transport cycle position. The whole reason the arp restarts
   *  cleanly: this resets with the transport, wall clock does not. */
  cycleAt: (timeSec: number) => number
  /** is the transport running? */
  isPlaying: () => boolean
  noteOn: (note: number, velocity: number) => void
  noteOff: (note: number) => void
}

export interface ArpDriverOpts extends LiveArpOpts {
  /** steps per cycle. 16 = sixteenths at four beats to the bar. Default 16. */
  stepsPerCycle?: number
  latch?: boolean
}

/** Sequences a held chord against the transport. */
export class ArpDriver {
  readonly held: HeldNotes
  private readonly arp: LiveArp
  private stepsPerCycle: number
  /** the step index last acted on; -1 = nothing yet this run */
  private lastStep = -1
  /** notes currently gated BY THE ARP, so a stop can release exactly those */
  private sounding = new Set<number>()
  private running = false

  constructor(private readonly host: ArpHost, opts: ArpDriverOpts = {}) {
    this.held = new HeldNotes(opts.latch ?? false)
    this.arp = new LiveArp(opts)
    this.stepsPerCycle = Math.max(1, Math.floor(opts.stepsPerCycle ?? 16))
  }

  configure(opts: ArpDriverOpts): void {
    this.arp.configure(opts)
    if (opts.stepsPerCycle !== undefined) this.stepsPerCycle = Math.max(1, Math.floor(opts.stepsPerCycle))
    if (opts.latch !== undefined) this.held.setLatch(opts.latch)
  }

  /** Poll. Safe to call at any rate: a step is acted on once, and a rate
   *  faster than the step grid simply finds nothing to do. */
  tick(): void {
    if (!this.host.isPlaying()) {
      // the transport stopped: release and re-arm for a clean restart at 0
      if (this.running) this.stop()
      return
    }
    this.running = true
    const step = Math.floor(this.host.cycleAt(this.host.now()) * this.stepsPerCycle)
    if (step === this.lastStep) return
    this.lastStep = step
    this.fire(step)
  }

  private fire(step: number): void {
    // Release the previous step first. Monophonic-per-step by design: an arp
    // that let every step ring would turn a fast figure into a chord.
    for (const n of this.sounding) this.host.noteOff(n)
    this.sounding.clear()
    const notes = this.arp.at(step, this.held.notes())
    for (const n of notes) {
      this.host.noteOn(n.note, n.velocity / 127)
      this.sounding.add(n.note)
    }
  }

  /** Transport stop, arp switched off, or the panel closing. Releases every
   *  note the ARP started (and no others) and re-arms so the next run begins
   *  at step 0 rather than wherever it left off. */
  stop(): void {
    for (const n of this.sounding) this.host.noteOff(n)
    this.sounding.clear()
    this.lastStep = -1
    this.running = false
  }

  /** Keyboard input. Held notes accumulate whether or not the transport is
   *  running, so you can build a chord before pressing play. */
  noteOn(note: number): void {
    this.held.noteOn(note)
  }

  noteOff(note: number): void {
    this.held.noteOff(note)
    // unlatched, releasing the last key should silence the arp immediately
    // rather than leaving the final step hanging until the next tick
    if (!this.held.latch && this.held.notes().length === 0) {
      for (const n of this.sounding) this.host.noteOff(n)
      this.sounding.clear()
    }
  }

  /** What the arp is currently gating — for tests and for a UI readout. */
  active(): number[] {
    return [...this.sounding]
  }
}
