/* ------------------------------------------------------------------------- *
 * The mask as a pattern output: scheduler events in, mask state out.
 *
 * A pattern routed to the sound `mask` never reaches the engine (the Session
 * skips it, see EXTERNAL_OUTPUTS); it lands here. Each event is read as a
 * STATE the mask should be in from that moment:
 *
 *   n / frame   show the DIY picture in that slot (what `play mask` notation
 *               gives: `1 2 3 4` steps through four uploaded pictures)
 *   face        show built-in picture n
 *   anim        run built-in animation n
 *   gain        brightness 0..1, the same word the rest of a pattern uses
 *
 * A picture control wins over an animation on the same event, and a slot
 * over a face, because the mask can only show one thing. A slot outside
 * 1..MASK_SLOT_MAX is not a slot: `0 0 0 0` is four beats with no picture of
 * their own, for a `face:` or `anim:` lane to land on. An event with none of
 * them (a `gain` sweep) changes only the brightness.
 *
 * Three consequences of "state, not trigger", all deliberate:
 *
 *   SCHEDULED. Events arrive with lookahead. Sending on arrival would run the
 *   face changes early by it, so each is timed against the audio clock, the
 *   way NoteOut times MIDI (desktop/midiout.ts).
 *
 *   DEDUPED. Only a CHANGE is sent. `1 1 2 2` sends two commands, not four,
 *   and a 16-a-cycle gain sweep that holds a value sends nothing for it. The
 *   radio has ~22 commands a second in it; a busy pattern should not spend
 *   them repeating itself.
 *
 *   COALESCED. A picture upload owns the radio for about five seconds. State
 *   changes during it are folded into one desired state and sent when the
 *   upload ends, so a pattern that ran through an upload leaves the mask
 *   where the pattern currently is, not five seconds behind it.
 *
 * Pictures come from maskFrame() in the program. On every eval the wanted set
 * is diffed against what this device has been sent; changed slots upload one
 * at a time, and a slot that is showing is re-shown when its picture lands.
 * ------------------------------------------------------------------------- */

import type { SchedulerEvent } from '@rondocode/pattern'
import type { MaskDevice, UploadReport } from './device'
import { MASK_SLOT_MAX, MASK_SLOT_MIN, sameFrame } from './frame'
import type { MaskFrame } from './frame'
import { MASK_SOUND, cmdAnim, cmdImage, cmdLight, cmdPlaySlot, lightByte, packFrame } from './protocol'

/** What the mask is showing: one of the three kinds of picture. */
export type MaskPicture = { kind: 'slot' | 'face' | 'anim'; n: number }

export interface MaskState {
  picture?: MaskPicture
  /** brightness byte 0..255 */
  light?: number
}

/** The picture and brightness one event asks for. Exported for the tests
 *  and for anything that wants to describe an event. */
export function eventState(controls: Record<string, unknown>): MaskState {
  const num = (k: string): number | undefined => {
    const v = controls[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const st: MaskState = {}
  const raw = num('frame') ?? num('n')
  const slot = raw !== undefined && Math.round(raw) >= MASK_SLOT_MIN && Math.round(raw) <= MASK_SLOT_MAX ? Math.round(raw) : undefined
  const face = num('face')
  const anim = num('anim')
  if (slot !== undefined) st.picture = { kind: 'slot', n: slot }
  else if (face !== undefined) st.picture = { kind: 'face', n: Math.round(face) }
  else if (anim !== undefined) st.picture = { kind: 'anim', n: Math.round(anim) }
  const gain = num('gain')
  if (gain !== undefined) st.light = lightByte(gain)
  return st
}

const samePicture = (a: MaskPicture | undefined, b: MaskPicture | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.kind === b.kind && a.n === b.n)

export interface UploadProgress {
  slot: number
  done: number
  total: number
  /** slots still to go after this one */
  remaining: number
}

export interface MaskStatus {
  /** connected device name, or null */
  device: string | null
  /** what the mask is showing, as last sent */
  shown: MaskState
  upload: UploadProgress | null
  /** uploads that finished with dropped chunks or a missing confirmation */
  torn: UploadReport[]
}

export interface MaskOutputOpts {
  /** audio-clock now, in seconds */
  now: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  onStatus?: (s: MaskStatus) => void
  /** something went wrong talking to the mask; the UI shows it */
  onError?: (message: string) => void
}

export class MaskOutput {
  private device: MaskDevice | null = null
  /** what the pattern currently asks for */
  private desired: MaskState = {}
  /** what this device has been told */
  private sent: MaskState = {}
  private wanted = new Map<number, MaskFrame>()
  /** what this device holds in each slot, as far as we have sent it */
  private uploaded = new Map<number, MaskFrame>()
  private syncing = false
  private flushPending = false
  private readonly timers = new Set<unknown>()
  private readonly torn: UploadReport[] = []
  private upload: UploadProgress | null = null
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (h: unknown) => void

  constructor(private readonly opts: MaskOutputOpts) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The connected mask, or null when it went away. A new device knows
   *  nothing of what the last one was told: every slot re-uploads and the
   *  current state is re-sent. */
  attach(device: MaskDevice | null): void {
    this.device = device
    this.sent = {}
    this.uploaded.clear()
    this.torn.length = 0
    this.upload = null
    if (device !== null) {
      device.onClose(() => {
        if (this.device === device) this.attach(null)
      })
      this.flush()
      void this.syncFrames()
    }
    this.emit()
  }

  /** The pictures the program declares, by slot; from each good eval. */
  setFrames(frames: ReadonlyMap<number, MaskFrame>): void {
    this.wanted = new Map(frames)
    void this.syncFrames()
  }

  /** Scheduler events; anything not routed to the mask is ignored. */
  send(evs: readonly SchedulerEvent[]): void {
    for (const ev of evs) {
      if (ev.controls.sound !== MASK_SOUND) continue
      const st = eventState(ev.controls)
      if (st.picture === undefined && st.light === undefined) continue
      this.at((ev.timeSec - this.opts.now()) * 1000, () => {
        if (st.picture !== undefined) this.desired.picture = st.picture
        if (st.light !== undefined) this.desired.light = st.light
        this.flush()
      })
    }
  }

  /** Transport stop: drop what is queued. The mask keeps showing whatever it
   *  shows; a face is not a note that needs releasing. */
  stop(): void {
    for (const h of this.timers) this.clearTimer(h)
    this.timers.clear()
  }

  status(): MaskStatus {
    return { device: this.device?.name ?? null, shown: { ...this.sent }, upload: this.upload, torn: [...this.torn] }
  }

  /** Send the difference between desired and sent, unless an upload has the
   *  radio, in which case it happens when the upload finishes. */
  private flush(): void {
    const dev = this.device
    if (dev === null || !dev.connected) return
    if (dev.uploading) {
      this.flushPending = true
      return
    }
    this.flushPending = false
    const want = this.desired
    if (want.light !== undefined && want.light !== this.sent.light) {
      this.sent.light = want.light
      this.fire(dev.command(cmdLight(want.light)), 'brightness')
    }
    if (want.picture !== undefined && !samePicture(want.picture, this.sent.picture)) {
      const p = want.picture
      this.sent.picture = p
      const cmd = p.kind === 'slot' ? cmdPlaySlot(p.n) : p.kind === 'face' ? cmdImage(p.n) : cmdAnim(p.n)
      this.fire(dev.command(cmd), `${p.kind} ${p.n}`)
    }
    this.emit()
  }

  private async syncFrames(): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      for (;;) {
        const dev = this.device
        if (dev === null || !dev.connected) break
        const todo = [...this.wanted].filter(([slot, f]) => {
          const have = this.uploaded.get(slot)
          return have === undefined || !sameFrame(have, f)
        })
        const next = todo[0]
        if (next === undefined) break
        const [slot, frame] = next
        this.upload = { slot, done: 0, total: 1, remaining: todo.length - 1 }
        this.emit()
        try {
          const report = await dev.uploadFrame(slot, packFrame(frame), (done, total) => {
            this.upload = { slot, done, total, remaining: todo.length - 1 }
            this.emit()
          })
          if (report.acked < report.chunks || !report.framed) this.torn.push(report)
          this.uploaded.set(slot, frame)
          // the mask keeps showing the OLD bytes of a slot until told again
          if (this.sent.picture?.kind === 'slot' && this.sent.picture.n === slot) this.sent.picture = undefined
        } catch (e) {
          this.opts.onError?.(`upload of slot ${slot} failed: ${e instanceof Error ? e.message : String(e)}`)
          break
        }
      }
    } finally {
      this.syncing = false
      this.upload = null
      if (this.device !== null) this.flush()
      this.emit()
    }
  }

  private fire(p: Promise<void>, what: string): void {
    p.catch((e: unknown) => this.opts.onError?.(`${what}: ${e instanceof Error ? e.message : String(e)}`))
  }

  private at(ms: number, fn: () => void): void {
    if (ms <= 1) {
      fn()
      return
    }
    const h = this.setTimer(() => {
      this.timers.delete(h)
      fn()
    }, ms)
    this.timers.add(h)
  }

  private emit(): void {
    this.opts.onStatus?.(this.status())
  }
}
