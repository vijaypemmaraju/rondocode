import { describe, expect, it, vi } from 'vitest'
import {
  LIT_MAX_MS,
  LIT_MIN_MS,
  MAX_FIRES,
  activate,
  scheduleFires,
} from '../src/editor/rondo/activation'
import type { FireEv, Sched } from '../src/editor/rondo/activation'

/* Six widgets animated to the playhead and seven did not, and every live one
 * had hand-rolled the same subscribe/schedule/teardown triple. This module is
 * that rule written once.
 *
 * The failures here are all SILENT — nothing throws when a widget lights early,
 * lights for someone else's note, or never goes dark again. So the timing and
 * the ownership are pinned directly rather than through a rendered widget. */

const ev = (timeSec: number, durSec = 0.5, sound?: string): FireEv =>
  sound === undefined ? { timeSec, durSec } : { timeSec, durSec, sound }

describe('scheduleFires', () => {
  it('delays by how far AHEAD of the clock the event is', () => {
    // the scheduler runs a lookahead, so events arrive before they sound. This
    // is the bug that does not throw: firing at 0 lights every widget early
    // and in a clump, which reads as a glitch rather than as a mistake.
    const [f] = scheduleFires([ev(10.25)], 10, undefined)
    expect(f!.delayMs).toBeCloseTo(250)
  })

  it('fires a LATE event immediately instead of dropping it', () => {
    expect(scheduleFires([ev(9.5)], 10, undefined)[0]!.delayMs).toBe(0)
  })

  it('lights only the notes belonging to its synth', () => {
    const evs = [ev(1, 0.5, 'kick'), ev(1, 0.5, 'lead'), ev(2, 0.5, 'kick')]
    expect(scheduleFires(evs, 0, 'kick')).toHaveLength(2)
  })

  it('with no synth of its own, every note lights it', () => {
    // a bus or master widget has no one owning voice — that is the whole point
    const evs = [ev(1, 0.5, 'kick'), ev(1, 0.5, 'lead')]
    expect(scheduleFires(evs, 0, undefined)).toHaveLength(2)
  })

  it('holds for the note duration, floored and capped', () => {
    // a 16th-note hat would be a flicker nobody sees; a two-bar pad would leave
    // the widget lit long enough to read as stuck on rather than as playing
    expect(scheduleFires([ev(0, 0.002)], 0, undefined)[0]!.holdMs).toBe(LIT_MIN_MS)
    expect(scheduleFires([ev(0, 8)], 0, undefined)[0]!.holdMs).toBe(LIT_MAX_MS)
    expect(scheduleFires([ev(0, 0.4)], 0, undefined)[0]!.holdMs).toBe(400)
  })

  it('caps a dense batch rather than queueing hundreds of timers', () => {
    const evs = Array.from({ length: 500 }, (_, i) => ev(i * 0.01))
    expect(scheduleFires(evs, 0, undefined)).toHaveLength(MAX_FIRES)
  })

  it('skips an event with no finite time', () => {
    expect(scheduleFires([{ timeSec: Number.NaN, durSec: 0.5 }], 0, undefined)).toEqual([])
  })
})

/** A Sched that runs by hand, so the timing is asserted rather than waited on. */
function fakeSched(): Sched & { tick: (ms: number) => void; pending: () => number } {
  let at = 0
  let q: { due: number; fn: () => void }[] = []
  return {
    at: (delayMs, fn) => { q.push({ due: at + Math.max(0, delayMs), fn }) },
    clear: () => { q = [] },
    pending: () => q.length,
    tick(ms) {
      const end = at + ms
      // Step to each due time IN ORDER rather than running the backlog at the
      // end of the window: a fire schedules its own un-fire relative to `at`,
      // so processing it late would date the un-fire from the wrong moment.
      for (;;) {
        const next = q.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0]
        if (next === undefined) break
        at = next.due
        q = q.filter((t) => t !== next)
        next.fn()
      }
      at = end
    },
  }
}

function harness(synth?: string) {
  const classes = new Set<string>()
  const el = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } }
  const sched = fakeSched()
  let emit: (evs: FireEv[]) => void = () => {}
  const unsub = vi.fn()
  const stop = activate(el, {
    now: () => 0,
    onNoteEvents: (fn) => { emit = fn; return unsub },
  }, { synth, sched, className: 'firing' })
  return { lit: () => classes.has('firing'), emit: (evs: FireEv[]) => emit(evs), sched, stop, unsub }
}

describe('activate', () => {
  it('lights when the note SOUNDS, not when the event arrives', () => {
    const h = harness()
    h.emit([ev(0.25, 0.3)])
    expect(h.lit(), 'the event arrived 250ms early').toBe(false)
    h.sched.tick(250)
    expect(h.lit()).toBe(true)
  })

  it('goes dark again after the hold', () => {
    const h = harness()
    h.emit([ev(0, 0.3)])
    h.sched.tick(0)
    expect(h.lit()).toBe(true)
    h.sched.tick(300)
    expect(h.lit()).toBe(false)
  })

  it('OVERLAPPING notes do not black it out early', () => {
    // the bug a bare on/off has: the first note's end arrives while the second
    // is still sounding, and the widget goes dark mid-note
    const h = harness()
    h.emit([ev(0, 0.3), ev(0.1, 0.3)])
    h.sched.tick(0)
    expect(h.lit()).toBe(true)
    h.sched.tick(300) // note 1 ends at 300, note 2 not until 400
    expect(h.lit(), 'note 2 is still sounding').toBe(true)
    h.sched.tick(100)
    expect(h.lit()).toBe(false)
  })

  it('ignores another synth entirely', () => {
    const h = harness('kick')
    h.emit([ev(0, 0.3, 'lead')])
    h.sched.tick(500)
    expect(h.lit()).toBe(false)
  })

  it('teardown unsubscribes, drops pending timers and clears the class', () => {
    // widgets die on EVERY rebuild — a leak here piles up fast, and a widget
    // torn down while lit would leave the class on a recycled element
    const h = harness()
    h.emit([ev(0, 0.3), ev(1, 0.3)])
    h.sched.tick(0)
    expect(h.lit()).toBe(true)
    h.stop()
    expect(h.unsub).toHaveBeenCalled()
    expect(h.lit()).toBe(false)
    expect(h.sched.pending()).toBe(0)
  })

  it('ARMS only when a transport is actually wired up', () => {
    // the resting style is dimmer than the lit one, so a widget that can never
    // fire must not be dimmed — on the docs page there is no transport, and a
    // permanently half-lit curve reads as broken rather than as idle
    const classes = new Set<string>()
    const el = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } }
    activate(el, {})
    expect(classes.has('armed'), 'no transport: nothing to dim for').toBe(false)
    const stop = activate(el, { now: () => 0, onNoteEvents: () => () => {} })
    expect(classes.has('armed')).toBe(true)
    stop()
    expect(classes.has('armed'), 'teardown un-arms it too').toBe(false)
  })

  it('is an inert no-op without a clock or an event feed', () => {
    // the docs page and any test that renders a widget with no transport
    const el = { classList: { add: () => { throw new Error('must not light') }, remove: () => {} } }
    expect(() => activate(el, {})()).not.toThrow()
    expect(() => activate(el, { now: () => 0 })()).not.toThrow()
  })

  it('calls onFire with the hold, and onIdle when it ends', () => {
    const fires: number[] = []
    let idles = 0
    const sched = fakeSched()
    let emit: (evs: FireEv[]) => void = () => {}
    activate(
      { classList: { add: () => {}, remove: () => {} } },
      { now: () => 0, onNoteEvents: (fn) => { emit = fn; return () => {} } },
      { sched, onFire: (ms) => fires.push(ms), onIdle: () => { idles++ } },
    )
    emit([ev(0, 0.4)])
    sched.tick(0)
    expect(fires).toEqual([400])
    expect(idles).toBe(0)
    sched.tick(400)
    expect(idles).toBe(1)
  })
})
