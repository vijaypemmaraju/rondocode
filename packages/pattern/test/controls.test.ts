import { describe, expect, it } from 'vitest'
import { MiniError, Pattern, mini, n, note, s, sine, sound } from '../src/index'
import type { ControlMap } from '../src/index'
import { q, qw } from './helpers'

describe('note()', () => {
  it('lifts a bare number to a one-event {note} pattern', () => {
    expect(q(note(60), 0, 1)).toEqual([[0, 1, { note: 60 }]])
  })

  it('lifts a Pattern<number> to {note} per event', () => {
    expect(q(note(mini('0 12') as Pattern<number>), 0, 1)).toEqual([
      [0, 0.5, { note: 0 }],
      [0.5, 1, { note: 12 }],
    ])
  })

  it('parses a mini string of numbers, threading source locs', () => {
    expect(q(note('0 12'), 0, 1)).toEqual([
      [0, 0.5, { note: 0, loc: { start: 0, end: 1 } }],
      [0.5, 1, { note: 12, loc: { start: 2, end: 4 } }],
    ])
  })

  it('parses note names (letter+accidental+octave, c4=60) in mini strings', () => {
    expect(q(note('c4 e4 f#3'), 0, 1)).toEqual([
      [0, 1 / 3, { note: 60, loc: { start: 0, end: 2 } }],
      [1 / 3, 2 / 3, { note: 64, loc: { start: 3, end: 5 } }],
      [2 / 3, 1, { note: 54, loc: { start: 6, end: 9 } }],
    ])
  })

  it('rejects words that are not note names with a MiniError pointing at them', () => {
    expect(() => note('c4 xyz')).toThrowError(MiniError)
    expect(() => note('c4 xyz')).toThrowError(/note name|midi/i)
    try {
      note('c4 xyz')
    } catch (e) {
      expect((e as MiniError).pos).toBe(3)
    }
  })
})

describe('n() dual export', () => {
  it('as a tagged template stays mini-compatible: Pattern<number>', () => {
    expect(q(n`0 3 5`, 0, 1)).toEqual([
      [0, 1 / 3, 0],
      [1 / 3, 2 / 3, 3],
      [2 / 3, 1, 5],
    ])
  })

  it('as a tagged template still rejects words', () => {
    expect(() => n`0 bd`).toThrowError(MiniError)
  })

  it('as a function on a string yields Pattern<ControlMap> with {n} and locs', () => {
    expect(q(n('0 3'), 0, 1)).toEqual([
      [0, 0.5, { n: 0, loc: { start: 0, end: 1 } }],
      [0.5, 1, { n: 3, loc: { start: 2, end: 3 } }],
    ])
  })

  it('as a function accepts numbers and Pattern<number>', () => {
    expect(q(n(7), 0, 1)).toEqual([[0, 1, { n: 7 }]])
    expect(q(n(mini('1 2') as Pattern<number>), 0, 1)).toEqual([
      [0, 0.5, { n: 1 }],
      [0.5, 1, { n: 2 }],
    ])
  })

  it('as a function rejects word atoms (degrees are numbers)', () => {
    expect(() => n('0 bd')).toThrowError(MiniError)
  })
})

describe('sound() / s()', () => {
  it('parses a mini word pattern into {sound} with locs', () => {
    expect(q(sound('acid sn:2'), 0, 1)).toEqual([
      [0, 0.5, { sound: 'acid', loc: { start: 0, end: 4 } }],
      [0.5, 1, { sound: 'sn:2', loc: { start: 5, end: 9 } }],
    ])
  })

  it('stringifies numeric atoms (a sound name is always a string)', () => {
    expect(q(sound('808'), 0, 1)).toEqual([
      [0, 1, { sound: '808', loc: { start: 0, end: 3 } }],
    ])
  })

  it('s is an alias of sound', () => {
    expect(s).toBe(sound)
  })
})

describe('control methods on Pattern<ControlMap>', () => {
  it('.sound() merges a name into every event, keeping structure and locs from the left', () => {
    const p = n('0 3').sound('acid')
    expect(q(p, 0, 1)).toEqual([
      [0, 0.5, { n: 0, loc: { start: 0, end: 1 }, sound: 'acid' }],
      [0.5, 1, { n: 3, loc: { start: 2, end: 3 }, sound: 'acid' }],
    ])
  })

  it('.gain() with a mini string patterns the value, structure from the left (appLeft)', () => {
    const p = n('0 1 2 3').gain('0.5 1')
    const gains = q(p, 0, 1).map(([, , c]) => (c as ControlMap).gain)
    expect(gains).toEqual([0.5, 0.5, 1, 1])
    // still four events: value pattern contributes values, not structure
    expect(q(p, 0, 1)).toHaveLength(4)
  })

  it('.ctrl() sets arbitrary params; later sets overwrite earlier ones', () => {
    const p = n('0').ctrl('wobble', 3).ctrl('wobble', 5)
    expect((q(p, 0, 1)[0]![2] as ControlMap)['wobble']).toBe(5)
  })

  it('.ctrl() keeps string values (word params like mode)', () => {
    const c1 = q(n('0').ctrl('mode', 'lp'), 0, 1)[0]![2] as ControlMap
    expect(c1['mode']).toBe('lp')
    const c2 = q(n('0 1').ctrl('mode', 'lp hp'), 0, 1).map(
      ([, , c]) => (c as ControlMap)['mode'],
    )
    expect(c2).toEqual(['lp', 'hp'])
  })

  it('.ctrl() rejects reserved keys with a pointer to the dedicated API', () => {
    for (const key of ['loc', 'n', 'note', 'sound']) {
      expect(() => n('0').ctrl(key, 1)).toThrowError(/reserved/)
    }
    expect(() => n('0').ctrl('note', 60)).toThrowError(/note\(\)/)
  })

  it('.ctrl() samples a continuous pattern over each event whole (midpoint)', () => {
    const p = n('0 1').ctrl('cutoff', sine)
    const cs = q(p, 0, 1).map(([, , c]) => (c as ControlMap)['cutoff'] as number)
    expect(cs[0]).toBeCloseTo(1, 12) // sine midpoint of [0,.5) = t .25 -> 1
    expect(cs[1]).toBeCloseTo(0, 12) // midpoint of [.5,1) = t .75 -> 0
  })

  it('.pan() / .dur() / .cutoff() / .res() conveniences exist', () => {
    const c = q(n('0').pan(0.2).dur(0.5).cutoff(800).res(0.8), 0, 1)[0]![2] as ControlMap
    expect(c.pan).toBe(0.2)
    expect(c.dur).toBe(0.5)
    expect(c['cutoff']).toBe(800)
    expect(c['res']).toBe(0.8)
  })

  it('.slide() sets the per-note slide control (patternable)', () => {
    const evs = q(note('a2 c3 e3 g3').slide('0 1 0 1'), 0, 1)
    expect((evs[0]![2] as ControlMap).slide).toBe(0)
    expect((evs[1]![2] as ControlMap).slide).toBe(1)
    expect((evs[2]![2] as ControlMap).slide).toBe(0)
    expect((evs[3]![2] as ControlMap).slide).toBe(1)
  })

  it('a finer-grained value pattern subdivides values but keeps left wholes', () => {
    const p = n('0').gain('0.25 0.75')
    expect(qw(p, 0, 1)).toEqual([
      {
        whole: [0, 1],
        part: [0, 0.5],
        value: { n: 0, loc: { start: 0, end: 1 }, gain: 0.25 },
      },
      {
        whole: [0, 1],
        part: [0.5, 1],
        value: { n: 0, loc: { start: 0, end: 1 }, gain: 0.75 },
      },
    ])
  })
})

describe('.scale()', () => {
  it('maps n through the scale to an absolute midi note, keeping n', () => {
    const p = n('0 1 2 7 -1').scale('c major')
    expect(q(p, 0, 1).map(([, , c]) => (c as ControlMap).note)).toEqual([
      60, 62, 64, 72, 59,
    ])
    expect(q(p, 0, 1).map(([, , c]) => (c as ControlMap).n)).toEqual([0, 1, 2, 7, -1])
  })

  it('resolves against the root: a minor', () => {
    const p = n('0 3 5').scale('a minor')
    expect(q(p, 0, 1).map(([, , c]) => (c as ControlMap).note)).toEqual([57, 62, 65])
  })

  it('leaves events without n untouched', () => {
    const p = sound('bd').scale('c major')
    expect((q(p, 0, 1)[0]![2] as ControlMap).note).toBeUndefined()
  })

  it('throws on an unknown scale name', () => {
    expect(() => n('0').scale('c nope')).toThrow()
  })
})

describe('jux / juxBy', () => {
  it('jux pans the dry copy hard left and the transformed copy hard right', () => {
    const p = n('0').sound('a').jux((x) => x.ctrl('flip', 1))
    const haps = q(p, 0, 1).map(([, , c]) => c as ControlMap)
    expect(haps).toHaveLength(2)
    const left = haps.find((c) => c['flip'] === undefined)!
    const right = haps.find((c) => c['flip'] === 1)!
    expect(left.pan).toBe(0)
    expect(right.pan).toBe(1)
    expect(left.sound).toBe('a')
    expect(right.sound).toBe('a')
  })

  it('juxBy spreads by amount around center', () => {
    const p = n('0').juxBy(0.5, (x) => x.ctrl('flip', 1))
    const haps = q(p, 0, 1).map(([, , c]) => c as ControlMap)
    const left = haps.find((c) => c['flip'] === undefined)!
    const right = haps.find((c) => c['flip'] === 1)!
    expect(left.pan).toBeCloseTo(0.25, 12)
    expect(right.pan).toBeCloseTo(0.75, 12)
  })

  it('juxBy rejects amounts outside [0, 1]', () => {
    const p = n('0')
    const id = (x: typeof p) => x
    expect(() => p.juxBy(-0.1, id)).toThrowError(RangeError)
    expect(() => p.juxBy(1.5, id)).toThrowError(RangeError)
    expect(() => p.juxBy(NaN, id)).toThrowError(RangeError)
  })

  it('jux overrides any pan the transform sets (pan applied after f)', () => {
    const p = n('0').jux((x) => x.pan(0.5))
    const pans = q(p, 0, 1)
      .map(([, , c]) => (c as ControlMap).pan)
      .sort()
    expect(pans).toEqual([0, 1])
  })
})
