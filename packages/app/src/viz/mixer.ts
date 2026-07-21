/* ------------------------------------------------------------------------- *
 * Mixer strip: one row per live synth inside the viz panel — name, channel
 * meter (fed by engine meters events), a gain slider and a small pan slider,
 * both driving Session.setChannel.
 *
 * Slider traffic is throttled per control: a drag fires dozens of input
 * events a second, but the engine sees at most one setChannel per control
 * per THROTTLE_MS — leading edge immediately (sliders feel live), trailing
 * edge guaranteed (releasing a slider always lands on its final value).
 *
 * Rows are reconciled, not rebuilt, on refresh(): a re-eval that keeps a
 * synth must not recreate its slider mid-drag.
 * ------------------------------------------------------------------------- */

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

export interface MixerHandle {
  el: HTMLElement
  /** Reconcile rows against the live synth list (call on session state). */
  refresh(synths: string[]): void
  /** Paint channel meters from a meters event's channels record. */
  paintMeters(channels: Record<string, number>): void
  dispose(): void
}

interface Row {
  el: HTMLElement
  fill: HTMLElement
  sendGain: Throttled<[number]>
  sendPan: Throttled<[number]>
}

export function createMixer(session: MixerSession, clock?: ThrottleClock): MixerHandle {
  const el = document.createElement('div')
  el.className = 'mixer'
  const rows = new Map<string, Row>()

  const slider = (className: string, value: number, label: string): HTMLInputElement => {
    const input = document.createElement('input')
    input.type = 'range'
    input.className = className
    input.min = '0'
    input.max = '1'
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
    nameEl.title = name
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

  return {
    el,
    refresh(synths: string[]): void {
      for (const name of synths) if (!rows.has(name)) addRow(name)
      for (const name of [...rows.keys()]) if (!synths.includes(name)) removeRow(name)
    },
    paintMeters(channels: Record<string, number>): void {
      for (const [name, row] of rows) {
        row.fill.style.width = `${rmsToMeterPercent(channels[name] ?? 0)}%`
      }
    },
    dispose(): void {
      for (const name of [...rows.keys()]) removeRow(name)
      el.remove()
    },
  }
}
