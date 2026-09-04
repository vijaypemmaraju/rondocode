import type { SchedulerEvent } from '@rondocode/pattern'
import { compile, sectionRanges, soundsAt } from '@rondocode/rondo'
import { describe, expect, it, vi } from 'vitest'
import { activate } from '../src/editor/rondo/activation'
import { ownedNoteFeed } from '../src/editor/rondo/owned'
import { toNoteEvs } from '../src/editor/rondo/widgets'
import type { NoteEv } from '../src/editor/rondo/widgets'

/* THE bug: two sections that hold the same line. `build` and `main` both
 * `play lead` over the same notes and the same `cutoff:` lane, so every
 * widget in the silent section matched the sounding section's events by text
 * or by synth and animated along. The feed is now scoped to the subscriber's
 * section, by where it sits in the document, and the widgets never see what
 * their part of the song could not have made. */

const SONG = [
  'synth lead',
  '  saw',
  '',
  'section build 4',
  '  play lead',
  '    c4 e4 g4',
  '    cutoff: 200..2000',
  '',
  'section main 4',
  '  play lead',
  '    c4 e4 g4',
  '    cutoff: 200..2000',
  '',
  'song build main',
  '',
].join('\n')

const ev = (cycle: number, timeSec = cycle): SchedulerEvent =>
  ({ timeSec, durSec: 0.5, controls: { sound: 'lead', note: 60 }, cycle, loc: { src: 'c4 e4 g4', start: 0 } }) as unknown as SchedulerEvent

/** The editor's wiring, with the document positions of two widgets standing
 *  in for the elements: one in `build`, one in `main`, both looking alike. */
const rig = () => {
  const c = compile(SONG)
  if (!c.ok) throw new Error(JSON.stringify(c.errors))
  const ranges = sectionRanges(SONG)
  const listeners = new Set<(evs: SchedulerEvent[]) => void>()
  const inBuild = { pos: SONG.indexOf('cutoff:') }
  const inMain = { pos: SONG.indexOf('cutoff:', inBuild.pos + 1) }
  const detached = {}
  const onNoteEvents = ownedNoteFeed({
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    posOf: (owner) => (owner as { pos?: number }).pos,
    sounds: (pos, cycle) => soundsAt(ranges, c.arrangement, pos, cycle),
  })
  const emit = (evs: SchedulerEvent[]): void => { for (const fn of listeners) fn(evs) }
  return { onNoteEvents, emit, inBuild, inMain, detached, listeners }
}

describe('ownedNoteFeed', () => {
  it('two widgets with identical lines in two sections each see only their own section playing', () => {
    const r = rig()
    const build: NoteEv[][] = []
    const main: NoteEv[][] = []
    r.onNoteEvents((evs) => build.push(evs), r.inBuild)
    r.onNoteEvents((evs) => main.push(evs), r.inMain)
    r.emit([ev(1)]) // build is playing
    expect(build).toHaveLength(1)
    expect(main, 'main is silent during build').toHaveLength(0)
    r.emit([ev(5)]) // main is playing
    expect(build, 'build is silent during main').toHaveLength(1)
    expect(main).toHaveLength(1)
    // the song loops: cycle 9 is build again
    r.emit([ev(9), ev(13)])
    expect(build[1]!.map((e) => e.cycle)).toEqual([9])
    expect(main[1]!.map((e) => e.cycle)).toEqual([13])
  })

  it('a batch is filtered, not dropped whole: the same batch is split between the two', () => {
    const r = rig()
    const build: number[] = []
    const main: number[] = []
    r.onNoteEvents((evs) => build.push(...evs.map((e) => e.cycle!)), r.inBuild)
    r.onNoteEvents((evs) => main.push(...evs.map((e) => e.cycle!)), r.inMain)
    r.emit([ev(3), ev(4), ev(4), ev(7), ev(8)])
    expect(build).toEqual([3, 8])
    expect(main).toEqual([4, 4, 7])
  })

  it('no owner, or an owner outside the document, is not scoped', () => {
    const r = rig()
    const all: number[] = []
    const det: number[] = []
    r.onNoteEvents((evs) => all.push(...evs.map((e) => e.cycle!)))
    r.onNoteEvents((evs) => det.push(...evs.map((e) => e.cycle!)), r.detached)
    r.emit([ev(1), ev(5)])
    expect(all).toEqual([1, 5])
    expect(det).toEqual([1, 5])
  })

  it('reads the owner position per batch, so a widget that moved keeps its section', () => {
    const r = rig()
    const seen: number[] = []
    const owner = { pos: r.inBuild.pos }
    r.onNoteEvents((evs) => seen.push(...evs.map((e) => e.cycle!)), owner)
    r.emit([ev(1), ev(5)])
    owner.pos = r.inMain.pos // an edit above it pushed the widget into... well, here: another section
    r.emit([ev(1), ev(5)])
    expect(seen).toEqual([1, 5])
  })

  it('stays silent when nothing survives, and unsubscribes cleanly', () => {
    const r = rig()
    const fn = vi.fn()
    const off = r.onNoteEvents(fn, r.inMain)
    r.emit([ev(1)])
    expect(fn).not.toHaveBeenCalled()
    off()
    expect(r.listeners.size).toBe(0)
  })
})

describe('toNoteEvs', () => {
  it('carries the cycle through, the number that places an event in the song', () => {
    const [n] = toNoteEvs([ev(7, 2.5)])
    expect(n!.cycle).toBe(7)
    expect(n!.timeSec).toBe(2.5)
    // a source without cycles (the docs page's fake feed) simply has none
    const [m] = toNoteEvs([{ loc: { start: 0 }, timeSec: 0, durSec: 1, controls: {} }])
    expect(m!.cycle).toBeUndefined()
  })
})

describe('activate', () => {
  it('subscribes as the element it lights, so the feed can scope it to its section', () => {
    const owners: unknown[] = []
    const el = { classList: { add: () => {}, remove: () => {} } }
    activate(el, { now: () => 0, onNoteEvents: (_fn, owner) => { owners.push(owner); return () => {} } })
    expect(owners).toEqual([el])
  })
})
