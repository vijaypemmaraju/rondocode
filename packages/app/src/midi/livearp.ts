/* ------------------------------------------------------------------------- *
 * Live arpeggiator, Cthulhu-style.
 *
 * The idea worth copying from Cthulhu is not "up/down/updown" — the pattern
 * `.arp()` already does those. It is that a step names a CHORD DEGREE, not a
 * note. Step 2 means "the third voice of whatever is held", so one step
 * pattern re-voices itself onto every chord you play: hold Am, get Am; hold
 * F, the same rhythm and shape comes out as F. That is the whole trick, and it
 * is what makes a step pattern reusable rather than a transcription.
 *
 * Degrees past the end of the chord WRAP UP AN OCTAVE rather than clamping, so
 * a 4-step pattern over a 3-note triad climbs instead of repeating its top
 * note — degree 3 of [60, 64, 67] is 72, not 67.
 *
 * Pure and clock-agnostic: it is fed a step index and returns notes. The
 * transport, the MIDI plumbing and the sound live elsewhere, so the sequencing
 * can be tested without an audio context or a keyboard.
 * ------------------------------------------------------------------------- */

import { ARP_ORDERS } from '@rondocode/pattern'

/** One step of the sequence. */
export interface ArpStep {
  /** Chord degrees this step sounds, 0 = lowest held note. Several = a stab.
   *  Empty = a rest, which is how you write rhythm into the pattern. */
  degrees: number[]
  /** Fraction of the step the note is held, 0..1. Default 0.5. Values over 1
   *  overlap into the next step, which is how a legato line is written. */
  gate?: number
  /** 0..1, scaled onto MIDI velocity. Default 1. */
  velocity?: number
  /** Whole octaves added on top of the degree's own wrapping. Default 0. */
  octave?: number
  /** Hold the PREVIOUS step's notes through this one instead of retriggering.
   *  A tie on a rest step is what makes a note longer than one step. */
  tie?: boolean
}

/**
 * Parse a step pattern the way you would write one on paper.
 *
 *   0 2 1 4        four steps, chord degrees (0 = lowest note held)
 *   0 ~ 2 ~        `~` is a rest — this is how rhythm gets written
 *   0 _ _ 2        `_` ties: the note keeps ringing instead of retriggering
 *   [0,2] 1        a stab: several degrees on one step
 *   0:.6           velocity, 0..1
 *   0^1  0^-1      whole octaves on top of the degree's own wrapping
 *   -1             negative degrees reach BELOW the chord
 *
 * The degrees are the point: the same pattern re-voices itself onto whatever
 * chord you hold, which is what makes it reusable rather than a transcription.
 *
 * Anything unparseable is DROPPED rather than guessed at, and an empty result
 * leaves the caller on its default — a bad character in the middle of a
 * pattern should cost you that step, not silence the arp.
 */
export function parseArpSteps(text: string): ArpStep[] {
  const out: ArpStep[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '') continue
    if (tok === '~') { out.push({ degrees: [] }); continue }
    if (tok === '_') { out.push({ degrees: [], tie: true }); continue }
    // strip the suffixes first, so `[0,2]:.6^1` works like `0:.6^1`
    let body = tok
    let velocity: number | undefined
    let octave: number | undefined
    const oct = /\^(-?\d+)$/.exec(body)
    if (oct !== null) { octave = Number(oct[1]); body = body.slice(0, oct.index) }
    const vel = /:(\d*\.?\d+)$/.exec(body)
    if (vel !== null) { velocity = Number(vel[1]); body = body.slice(0, vel.index) }
    const inner = /^\[(.*)\]$/.exec(body)
    const parts = (inner !== null ? inner[1]! : body).split(',')
    const degrees: number[] = []
    let bad = parts.length === 0
    for (const part of parts) {
      const t = part.trim()
      if (!/^-?\d+$/.test(t)) { bad = true; break }
      degrees.push(Number(t))
    }
    if (bad || degrees.length === 0) continue // drop the step, keep the pattern
    const step: ArpStep = { degrees }
    if (velocity !== undefined && velocity >= 0 && velocity <= 1) step.velocity = velocity
    if (octave !== undefined) step.octave = octave
    out.push(step)
  }
  return out
}

/** Render steps back to the notation above — so the panel can show what it
 *  parsed, and a saved pattern round-trips instead of drifting. */
export function formatArpSteps(steps: readonly ArpStep[]): string {
  return steps.map((s) => {
    if (s.tie === true && s.degrees.length === 0) return '_'
    if (s.degrees.length === 0) return '~'
    let t = s.degrees.length > 1 ? `[${s.degrees.join(',')}]` : String(s.degrees[0])
    if (s.velocity !== undefined && s.velocity !== 1) t += `:${s.velocity}`
    if (s.octave !== undefined && s.octave !== 0) t += `^${s.octave}`
    return t
  }).join(' ')
}

/** A note the arp wants sounded. */
export interface ArpNote {
  note: number
  velocity: number
  /** how long to hold it, in steps (gate x 1, or longer across ties) */
  steps: number
}

/** Map a degree onto a held chord, wrapping past the top an octave at a time.
 *  Negative degrees wrap DOWN, so a pattern can reach below the chord. */
export function degreeToNote(held: readonly number[], degree: number, octave = 0): number | null {
  const n = held.length
  if (n === 0) return null
  // floorDiv/floorMod so negatives wrap downward instead of toward zero
  const oct = Math.floor(degree / n)
  const idx = degree - oct * n
  return held[idx]! + (oct + octave) * 12
}

/** The set of notes currently held, kept sorted so a degree is stable.
 *
 *  LATCH is a real feature, not a nicety: without it an arp stops the instant
 *  you lift your hand, which makes it useless for playing anything else at the
 *  same time. Latched, the chord persists until a NEW chord is started. */
export class HeldNotes {
  private readonly down = new Set<number>()
  private latched: number[] = []
  /** True once every key is released while latching — the next press starts a
   *  fresh chord rather than adding to the old one. */
  private stale = false

  constructor(public latch = false) {}

  noteOn(note: number): void {
    if (this.latch && this.stale) {
      this.latched = []
      this.stale = false
    }
    this.down.add(note)
    if (this.latch && !this.latched.includes(note)) {
      this.latched.push(note)
      this.latched.sort((a, b) => a - b)
    }
  }

  noteOff(note: number): void {
    this.down.delete(note)
    // latched notes survive the release; the chord only ends when a new one
    // begins, which is what lets you take your hand off the keys
    if (this.latch && this.down.size === 0) this.stale = true
  }

  /** Sorted ascending — degree 0 is always the lowest note. */
  notes(): number[] {
    if (this.latch) return [...this.latched]
    return [...this.down].sort((a, b) => a - b)
  }

  clear(): void {
    this.down.clear()
    this.latched = []
    this.stale = false
  }

  setLatch(on: boolean): void {
    this.latch = on
    if (!on) this.latched = []
    this.stale = false
  }
}

export interface LiveArpOpts {
  /** The step pattern. Empty falls back to one step of degree 0. */
  steps?: ArpStep[]
  /** When set, degrees are ignored and the chord is walked in this mode
   *  instead ('up', 'down', 'updown', …) — the simple arp, sharing the exact
   *  order table the pattern `.arp()` uses so the two cannot disagree. */
  mode?: string
  /** Octave range: the whole pattern repeats this many times, transposed up an
   *  octave each pass. Default 1 (no extra octaves). */
  octaves?: number
}

/** The sequencer. Feed it a monotonically increasing step index; it returns
 *  what to sound. Holds no clock of its own so it can be driven by the
 *  transport, a test, or an offline render identically. */
export class LiveArp {
  private steps: ArpStep[]
  private mode: string | undefined
  private octaves: number

  constructor(opts: LiveArpOpts = {}) {
    this.steps = opts.steps?.length ? opts.steps : [{ degrees: [0] }]
    this.mode = opts.mode
    this.octaves = Math.max(1, Math.floor(opts.octaves ?? 1))
  }

  configure(opts: LiveArpOpts): void {
    if (opts.steps !== undefined) this.steps = opts.steps.length ? opts.steps : [{ degrees: [0] }]
    if (opts.mode !== undefined) this.mode = opts.mode
    if (opts.octaves !== undefined) this.octaves = Math.max(1, Math.floor(opts.octaves))
  }

  /** Steps in one full pass, octaves included. */
  get length(): number {
    return (this.mode !== undefined ? this.modeLength() : this.steps.length) * this.octaves
  }

  private modeLength(): number {
    // mode length depends on the CHORD size, so it is resolved per call
    return this.steps.length
  }

  /** What sounds at `tick`. Empty when nothing is held or the step is a rest.
   *  A tie returns nothing: the previous note is still sounding. */
  at(tick: number, held: readonly number[]): ArpNote[] {
    if (held.length === 0) return []

    if (this.mode !== undefined) {
      const order = (ARP_ORDERS[this.mode] ?? ARP_ORDERS['up']!)(held.length)
      if (order.length === 0) return []
      const span = order.length * this.octaves
      const i = ((tick % span) + span) % span
      const oct = Math.floor(i / order.length)
      const note = degreeToNote(held, order[i % order.length]!, oct)
      return note === null ? [] : [{ note, velocity: 100, steps: 1 }]
    }

    const span = this.steps.length * this.octaves
    const i = ((tick % span) + span) % span
    const oct = Math.floor(i / this.steps.length)
    const step = this.steps[i % this.steps.length]!
    if (step.tie === true || step.degrees.length === 0) return []

    const gate = step.gate ?? 0.5
    const vel = Math.max(1, Math.min(127, Math.round((step.velocity ?? 1) * 127)))
    // a tie on the FOLLOWING steps extends this note rather than retriggering
    let heldSteps = gate
    for (let k = 1; k < this.steps.length; k++) {
      const nxt = this.steps[(i + k) % this.steps.length]!
      if (nxt.tie !== true) break
      heldSteps += 1
    }
    const out: ArpNote[] = []
    for (const d of step.degrees) {
      const note = degreeToNote(held, d, oct + (step.octave ?? 0))
      if (note !== null && note >= 0 && note <= 127) out.push({ note, velocity: vel, steps: heldSteps })
    }
    return out
  }
}
