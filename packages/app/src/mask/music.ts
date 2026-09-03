/* ------------------------------------------------------------------------- *
 * The music, as a `draw` painter sees it.
 *
 * A `draw N` block in the program is a function of one band: it is called 24
 * times a frame, once per column of the mask's visualizer, with the band
 * index, the band count and this frame's music, and answers how tall that
 * band is (0..1). What it can read is the same model the shader visualizer
 * has (shaderviz/renderer.ts), reduced to what fits in a closure:
 *
 *   t       seconds, a wall clock; for anything that should just move
 *   phase   0..1 through the current cycle, locked to the transport
 *   cycle   the transport's cycle number, fractional
 *   cps     cycles a second
 *   beat    a bass onset envelope 0..1, from the spectrum's lowest bands
 *   duck    the sidechain duck 0..1 (1 = not ducking)
 *   level   the master meter, eased
 *   spec    the 24 spectrum bands 0..1, what `viz:` alone would draw
 *   hit     per synth, a note-onset envelope 0..1 (`hit.kick`)
 *   lvl     per synth, its channel meter 0..1, eased (`lvl.bass`)
 *
 * Two clocks, for the reason spelled out in the shader renderer: events are
 * stamped on the AUDIO clock, so that decides WHEN a hit lands and where the
 * cycle is anchored; the WALL clock drives the decays and the easing, because
 * the audio clock only advances per render quantum and a decay scaled by it
 * runs in bursts.
 * ------------------------------------------------------------------------- */

import type { SchedulerEvent } from '@rondocode/pattern'
import { follow } from '../shaderviz/api'
import { MASK_SOUND, RHYTHM_BANDS, RHYTHM_LEVEL_MAX } from './protocol'
import type { MaskSpectrum } from './spectrum'

export interface MusicFrame {
  t: number
  phase: number
  cycle: number
  cps: number
  beat: number
  duck: number
  level: number
  spec: Float32Array
  hit: Record<string, number>
  lvl: Record<string, number>
}

/** What a `draw N` block compiles to: band index, band count, the music. */
export type MaskDrawFn = (i: number, n: number, m: MusicFrame) => unknown

/** Onset envelopes fade over this; the shader's constant, so the two agree. */
const HIT_DECAY_S = 0.12
const BEAT_DECAY_S = 0.18
/** `beat` listens to the bands below about 130 Hz. */
const BEAT_BANDS = 6

export interface MaskMusicOpts {
  /** audio-clock now, in seconds: the timeline events are stamped in */
  now: () => number
  /** wall-clock now, in seconds; performance.now unless a test says otherwise */
  wall?: () => number
  /** the master tap; null means `spec` and `beat` stay at 0 */
  spectrum?: MaskSpectrum | null
}

interface Pending {
  at: number
  amp: number
  name: string
  cycle: number
}

/** A frame of silence: what a painter gets with no music model behind it. */
export const silentFrame = (): MusicFrame => ({
  t: 0, phase: 0, cycle: 0, cps: 0, beat: 0, duck: 1, level: 0, spec: new Float32Array(RHYTHM_BANDS), hit: {}, lvl: {},
})

export class MaskMusic {
  private readonly wall: () => number
  private readonly spectrum: MaskSpectrum | null
  private readonly t0: number
  private prevT = 0
  private pending: Pending[] = []
  private readonly hitEnvs = new Map<string, number>()
  private readonly chanLevels = new Map<string, number>()
  private synths: string[] = []
  private chanTarget: Record<string, number> = {}
  private masterTarget = 0
  private masterLevel = 0
  private duckTarget = 1
  private duckLevel = 1
  private beatEnv = 0
  private cps = 0
  private playing = false
  private cycleAt = 0
  private cycleAtT = 0

  constructor(private readonly opts: MaskMusicOpts) {
    this.wall = opts.wall ?? (() => performance.now() / 1000)
    this.spectrum = opts.spectrum ?? null
    this.t0 = this.wall()
  }

  /** Scheduler events, with lookahead; a hit lands when its time comes. */
  pushEvents(evs: readonly SchedulerEvent[]): void {
    for (const ev of evs) {
      const name = typeof ev.controls.sound === 'string' ? ev.controls.sound : ''
      const note = typeof ev.controls.note === 'number' ? ev.controls.note : NaN
      // a hit is a NOTE on a synth: automation opens no gate, and the mask's
      // own lane is what is being drawn, not part of the music
      if (name === '' || name === MASK_SOUND || Number.isNaN(note)) continue
      const amp = typeof ev.controls.gain === 'number' ? ev.controls.gain : 1
      const cycle = typeof ev.cycle === 'number' ? ev.cycle : -1
      this.pending.push({ at: ev.timeSec, amp, name, cycle })
    }
    if (this.pending.length > 512) this.pending.splice(0, this.pending.length - 512)
  }

  /** The engine's meters; targets the frame eases toward. */
  setMeters(m: { channels: Record<string, number>; master?: number; duck?: number }): void {
    this.chanTarget = m.channels
    this.masterTarget = m.master ?? 0
    this.duckTarget = m.duck ?? 1
  }

  /** The program's synths, so `hit.x` and `lvl.x` read 0 before x has played
   *  rather than nothing at all. */
  setSynths(names: readonly string[]): void {
    this.synths = [...names]
  }

  setCps(v: number): void {
    this.cps = v
  }

  setPlaying(v: boolean): void {
    // a stop freezes the cycle counter where it is (not back at the last
    // event); a fresh start re-bases it and clears what was ringing
    if (!v && this.playing) {
      this.cycleAt = this.cycleNow(this.opts.now())
      this.cycleAtT = this.opts.now()
    }
    if (v && !this.playing) {
      this.cycleAt = 0
      this.cycleAtT = this.opts.now()
      this.pending = []
      this.hitEnvs.clear()
      this.beatEnv = 0
      this.spectrum?.reset()
    }
    this.playing = v
  }

  /** The transport's cycle: anchored to the last scheduled event's own
   *  cycle number and advanced by the clock, so it tracks the transport
   *  rather than wall time (a time*cps cycle drifts across a stop/start). */
  private cycleNow(tAudio: number): number {
    return this.playing ? this.cycleAt + Math.max(0, (tAudio - this.cycleAtT) * this.cps) : this.cycleAt
  }

  /** The music right now. Call once per visualizer frame: the decays and the
   *  easing advance by the wall time since the last call. */
  frame(): MusicFrame {
    const tAudio = this.opts.now()
    const tWall = this.wall()
    // clamped: a backgrounded tab returns after seconds, and one step with
    // dt = 4 would snap every envelope to its target at once
    const dt = this.prevT === 0 ? 0.016 : Math.min(0.1, Math.max(0.0005, tWall - this.prevT))
    this.prevT = tWall
    while (this.pending.length > 0 && this.pending[0]!.at <= tAudio) {
      const o = this.pending.shift()!
      this.hitEnvs.set(o.name, Math.max(this.hitEnvs.get(o.name) ?? 0, o.amp))
      if (o.cycle >= 0) { this.cycleAt = o.cycle; this.cycleAtT = o.at }
    }
    const decay = Math.exp(-dt / HIT_DECAY_S)
    const hit: Record<string, number> = {}
    const lvl: Record<string, number> = {}
    for (const name of this.synths) { hit[name] = 0; lvl[name] = 0 }
    for (const [name, v] of this.hitEnvs) {
      const nv = v * decay
      this.hitEnvs.set(name, nv)
      hit[name] = Math.min(1, nv)
    }
    for (const name of new Set([...this.synths, ...Object.keys(this.chanTarget)])) {
      const lv = follow(this.chanLevels.get(name) ?? 0, this.chanTarget[name] ?? 0, dt, 22, 110)
      this.chanLevels.set(name, lv)
      lvl[name] = lv
    }
    this.masterLevel = follow(this.masterLevel, this.masterTarget, dt, 22, 110)
    // the duck's snap DOWN is the punch, so it is followed almost immediately
    this.duckLevel = follow(this.duckLevel, this.duckTarget, dt, 45, 3)
    const spec = new Float32Array(RHYTHM_BANDS)
    let bass = 0
    if (this.spectrum !== null) {
      const levels = this.spectrum.levels()
      for (let i = 0; i < RHYTHM_BANDS; i++) {
        const v = (levels[i] ?? 0) / RHYTHM_LEVEL_MAX
        spec[i] = v
        if (i < BEAT_BANDS && v > bass) bass = v
      }
    }
    this.beatEnv = Math.max(this.beatEnv * Math.exp(-dt / BEAT_DECAY_S), bass)
    const cps = this.cps
    const phase = cps > 0 ? (tAudio * cps) % 1 : 0
    const cycle = this.cycleNow(tAudio)
    return {
      t: tWall - this.t0, phase, cycle, cps, beat: this.beatEnv, duck: this.duckLevel, level: this.masterLevel, spec, hit, lvl,
    }
  }
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0) // NaN reads 0

/** 0..1 to the mask's 0..9. */
export const levelOf = (v: number): number => Math.round(clamp01(v) * RHYTHM_LEVEL_MAX)

/** The 24 levels a painter draws for this frame. A number is the band's
 *  height 0..1; `true`/`false` a full or empty band; nothing is dark. Any
 *  other answer is a mistake worth hearing about, so it throws with the band
 *  that returned it, and the caller decides how loudly to say so. */
export function runDraw(fn: MaskDrawFn, m: MusicFrame, out: Uint8Array = new Uint8Array(RHYTHM_BANDS)): Uint8Array {
  for (let i = 0; i < RHYTHM_BANDS; i++) {
    const v = fn(i, RHYTHM_BANDS, m)
    if (typeof v === 'number') out[i] = levelOf(v)
    else if (typeof v === 'boolean') out[i] = v ? RHYTHM_LEVEL_MAX : 0
    else if (v === null || v === undefined) out[i] = 0
    else throw new TypeError(`band ${i} returned ${typeof v === 'object' ? 'an object' : `a ${typeof v}`}; a band is a number 0..1, true/false or nothing`)
  }
  return out
}

/** `spec` as the mask draws it: the levels behind `viz:`. */
export function levelsOf(values: ArrayLike<number>, out: Uint8Array = new Uint8Array(RHYTHM_BANDS)): Uint8Array {
  for (let i = 0; i < RHYTHM_BANDS; i++) out[i] = levelOf(values[i] ?? 0)
  return out
}
