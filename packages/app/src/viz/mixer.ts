/* ------------------------------------------------------------------------- *
 * Mixer strip: one row per live synth inside the viz panel — name, channel
 * meter (fed by engine meters events), a gain slider and a small pan slider,
 * both driving Session.setChannel.
 *
 * Below the synths, a BUS section: one block per shared send bus (bus() in the
 * code), with a meter and a fader for every send amount plus the bus gain.
 * Unlike the channel faders (ephemeral live controls), the bus faders EDIT THE
 * CODE: dragging one rewrites the matching number literal in the bus() call via
 * editor.rewrite, so the text stays the single source of truth (same contract
 * as the inline widgets). Their ranges come from buses.ts detection and are
 * reconciled after every doc change; a fader that is being dragged is never
 * overwritten from the code.
 *
 * Slider traffic is throttled per control: a drag fires dozens of input
 * events a second, but the engine sees at most one setChannel per control
 * per THROTTLE_MS — leading edge immediately (sliders feel live), trailing
 * edge guaranteed (releasing a slider always lands on its final value).
 *
 * Rows are reconciled, not rebuilt, on refresh(): a re-eval that keeps a
 * synth must not recreate its slider mid-drag.
 * ------------------------------------------------------------------------- */

import { tooltip } from '../ui/tooltip'
import { numberChange } from '../editor/widgets/rewrite'
import type { BusDesc } from '../editor/buses'

export const THROTTLE_MS = 30

/** Engine channel-strip defaults (see protocol.ts setChannel). */
const DEFAULT_GAIN = 0.8
const DEFAULT_PAN = 0.5

// ---- throttle (pure, injectable clock — unit tested) --------------------

export interface ThrottleClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface Throttled<A extends unknown[]> {
  (...args: A): void
  /** Drop any pending trailing call (row removed / dispose). */
  cancel(): void
}

/** Rate-limit fn to one call per `ms`: leading edge fires immediately when
 *  the window is clear; calls inside a window coalesce into ONE trailing
 *  call carrying the latest arguments. A trailing fire opens a new window. */
export function throttleTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  clock: ThrottleClock = realClock,
): Throttled<A> {
  let lastFire = Number.NEGATIVE_INFINITY
  let timer: unknown
  let pending: A | undefined
  const fire = (args: A): void => {
    lastFire = clock.now()
    fn(...args)
  }
  const throttled = (...args: A): void => {
    const now = clock.now()
    if (timer === undefined && now - lastFire >= ms) {
      fire(args)
      return
    }
    pending = args
    if (timer === undefined) {
      timer = clock.setTimeout(
        () => {
          timer = undefined
          if (pending !== undefined) {
            const p = pending
            pending = undefined
            fire(p)
          }
        },
        Math.max(0, lastFire + ms - now),
      )
    }
  }
  throttled.cancel = (): void => {
    if (timer !== undefined) clock.clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  return throttled
}

// ---- meter formatting (unit tested) -------------------------------------

/** Channel RMS → meter fill percent, clamped to [0, 100]. Same 160× scale
 *  as the master meter in editor.ts: a full sine at gain 0.8 (~0.57 RMS)
 *  lands around 91%. Non-finite/negative input paints silence. */
export const rmsToMeterPercent = (rms: number): number =>
  Number.isFinite(rms) ? Math.min(100, Math.max(0, rms * 160)) : 0

// ---- DOM strip ----------------------------------------------------------

/** The one Session method the mixer needs — injectable for tests. */
export interface MixerSession {
  setChannel(synth: string, opts: { gain?: number; pan?: number }): void
}

/** Apply a literal rewrite to the editor doc and re-eval — the seam the bus
 *  faders use to edit the source (see editor.rewrite). */
export type RewriteFn = (change: { from: number; to: number; insert: string }, immediate: boolean) => void

export interface MixerHandle {
  el: HTMLElement
  /** Reconcile rows against the live synth list + detected buses. `buses`
   *  defaults to [] (no bus section). Call on session state AND on doc change
   *  (the bus literal ranges must stay in sync with the text). */
  refresh(synths: string[], buses?: BusDesc[]): void
  /** Paint channel + bus meters from a meters event. */
  paintMeters(channels: Record<string, number>, buses?: Record<string, number>): void
  dispose(): void
}

interface Row {
  el: HTMLElement
  fill: HTMLElement
  sendGain: Throttled<[number]>
  sendPan: Throttled<[number]>
}

/** A bus fader bound to one number literal in the source. `from`/`to` are the
 *  literal's current range (reconciled after each edit); `push` is the
 *  throttled rewrite that reads the LATEST range at fire time. */
interface Fader {
  el: HTMLElement
  slider: HTMLInputElement
  from: number
  to: number
  push: Throttled<[number]>
}

interface BusBlock {
  el: HTMLElement
  fill: HTMLElement
  sendsWrap: HTMLElement
  sends: Map<string, Fader>
  gain?: Fader
}

export function createMixer(session: MixerSession, rewrite?: RewriteFn, clock?: ThrottleClock): MixerHandle {
  const el = document.createElement('div')
  el.className = 'mixer'
  const rows = new Map<string, Row>()
  const busBlocks = new Map<string, BusBlock>()
  // The bus section lives after the synth rows; re-appended on refresh so it
  // stays below any synth row added since.
  const busSection = document.createElement('div')
  busSection.className = 'mixer-buses'

  const slider = (className: string, value: number, label: string, max = 1): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'range'
    input.className = className
    input.min = '0'
    input.max = String(max)
    input.step = '0.01'
    input.value = String(value)
    input.setAttribute('aria-label', label)
    return input
  }

  const addRow = (name: string): void => {
    const row = document.createElement('div')
    row.className = 'mixer-row'
    const nameEl = document.createElement('span')
    nameEl.className = 'mixer-name'
    nameEl.textContent = name
    tooltip(nameEl, name)
    const meter = document.createElement('div')
    meter.className = 'mixer-meter'
    const fill = document.createElement('div')
    fill.className = 'mixer-meter-fill'
    meter.append(fill)
    const gain = slider('mixer-gain', DEFAULT_GAIN, `${name} gain`)
    const pan = slider('mixer-pan', DEFAULT_PAN, `${name} pan`)
    row.append(nameEl, meter, gain, pan)
    const sendGain = throttleTrailing((g: number) => session.setChannel(name, { gain: g }), THROTTLE_MS, clock)
    const sendPan = throttleTrailing((p: number) => session.setChannel(name, { pan: p }), THROTTLE_MS, clock)
    gain.addEventListener('input', () => sendGain(Number(gain.value)))
    pan.addEventListener('input', () => sendPan(Number(pan.value)))
    el.append(row)
    rows.set(name, { el: row, fill, sendGain, sendPan })
  }

  const removeRow = (name: string): void => {
    const row = rows.get(name)
    if (row === undefined) return
    row.sendGain.cancel()
    row.sendPan.cancel()
    row.el.remove()
    rows.delete(name)
  }

  // ---- bus faders (edit the source) ------------------------------------

  /** Build a fader wired to rewrite the literal it currently points at. The
   *  push reads `fader.from/to` at fire time, so a shifted range (an edit
   *  above it moved the literal) still rewrites the right span. */
  const makeFader = (label: string, value: number, max: number): Fader => {
    const wrap = document.createElement('div')
    wrap.className = 'mixer-send'
    const lab = document.createElement('span')
    lab.className = 'mixer-send-label'
    lab.textContent = label
    const s = slider('mixer-gain', value, label, max)
    wrap.append(lab, s)
    const fader: Fader = {
      el: wrap,
      slider: s,
      from: 0,
      to: 0,
      push: throttleTrailing(
        (v: number) => rewrite?.(numberChange({ from: fader.from, to: fader.to }, v, { step: 0.01, min: 0 }), false),
        THROTTLE_MS,
        clock,
      ),
    }
    s.addEventListener('input', () => fader.push(Number(s.value)))
    return fader
  }

  /** Sync a fader to a detected literal WITHOUT fighting an active drag: the
   *  range always tracks the text; the value only follows the code when the
   *  user is not holding this exact slider. */
  const syncFader = (fader: Fader, value: number, from: number, to: number): void => {
    fader.from = from
    fader.to = to
    if (fader.slider !== fader.slider.ownerDocument.activeElement) fader.slider.value = String(value)
  }

  const addBusBlock = (name: string): BusBlock => {
    const block = document.createElement('div')
    block.className = 'mixer-bus'
    const head = document.createElement('div')
    head.className = 'mixer-bus-head'
    const nameEl = document.createElement('span')
    nameEl.className = 'mixer-name mixer-bus-name'
    nameEl.textContent = name
    tooltip(nameEl, `send bus: ${name}`)
    const meter = document.createElement('div')
    meter.className = 'mixer-meter'
    const fill = document.createElement('div')
    fill.className = 'mixer-meter-fill'
    meter.append(fill)
    head.append(nameEl, meter)
    const sendsWrap = document.createElement('div')
    sendsWrap.className = 'mixer-bus-sends'
    block.append(head, sendsWrap)
    busSection.append(block)
    const busBlock: BusBlock = { el: block, fill, sendsWrap, sends: new Map() }
    busBlocks.set(name, busBlock)
    return busBlock
  }

  const removeFader = (fader: Fader): void => {
    fader.push.cancel()
    fader.el.remove()
  }

  const removeBusBlock = (name: string): void => {
    const block = busBlocks.get(name)
    if (block === undefined) return
    for (const f of block.sends.values()) removeFader(f)
    if (block.gain !== undefined) removeFader(block.gain)
    block.el.remove()
    busBlocks.delete(name)
  }

  const reconcileBus = (desc: BusDesc): void => {
    const block = busBlocks.get(desc.name) ?? addBusBlock(desc.name)
    // sends
    const seen = new Set<string>()
    for (const send of desc.sends) {
      seen.add(send.synth)
      let fader = block.sends.get(send.synth)
      if (fader === undefined) {
        fader = makeFader(`→ ${send.synth}`, send.amount, 1)
        block.sendsWrap.append(fader.el)
        block.sends.set(send.synth, fader)
      }
      syncFader(fader, send.amount, send.from, send.to)
    }
    for (const [synth, fader] of [...block.sends]) {
      if (!seen.has(synth)) {
        removeFader(fader)
        block.sends.delete(synth)
      }
    }
    // gain (only when the code carries an explicit numeric gain literal)
    if (desc.gain !== undefined) {
      if (block.gain === undefined) {
        block.gain = makeFader('gain', desc.gain.value, 1)
        block.sendsWrap.append(block.gain.el)
      }
      syncFader(block.gain, desc.gain.value, desc.gain.from, desc.gain.to)
    } else if (block.gain !== undefined) {
      removeFader(block.gain)
      block.gain = undefined
    }
  }

  return {
    el,
    refresh(synths: string[], buses: BusDesc[] = []): void {
      for (const name of synths) if (!rows.has(name)) addRow(name)
      for (const name of [...rows.keys()]) if (!synths.includes(name)) removeRow(name)
      // buses reconcile against the detected list
      const names = new Set(buses.map((b) => b.name))
      for (const desc of buses) reconcileBus(desc)
      for (const name of [...busBlocks.keys()]) if (!names.has(name)) removeBusBlock(name)
      // keep the bus section last, and out of the DOM entirely when empty
      if (busBlocks.size > 0) el.append(busSection)
      else busSection.remove()
    },
    paintMeters(channels: Record<string, number>, buses: Record<string, number> = {}): void {
      for (const [name, row] of rows) {
        row.fill.style.width = `${rmsToMeterPercent(channels[name] ?? 0)}%`
      }
      for (const [name, block] of busBlocks) {
        block.fill.style.width = `${rmsToMeterPercent(buses[name] ?? 0)}%`
      }
    },
    dispose(): void {
      for (const name of [...rows.keys()]) removeRow(name)
      for (const name of [...busBlocks.keys()]) removeBusBlock(name)
      busSection.remove()
      el.remove()
    },
  }
}
