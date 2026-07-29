import { describe, expect, it } from 'vitest'
import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { Session } from '../src/session/Session'
import {
  CcRouter,
  MIN_MODE_CC,
  PAIR_WINDOW_MS,
  cc14ToValue,
  ccToValue,
  loadMappings,
  mappingsKey,
  parseCc,
  parseMappings,
  saveMappings,
  serializeMappings,
} from '../src/midi/cc'
import type { CcMapping, ParamRange, StorageLike } from '../src/midi/cc'

/* ------------------------------------------------------------------------- *
 * MIDI CC -> param mapping. Everything here is simulated: a "controller" is a
 * sequence of {channel, cc, value} objects, so the rules are pinned without
 * hardware and without Web MIDI.
 * ------------------------------------------------------------------------- */

const LIN: ParamRange = { min: 0, max: 1 }
const GAIN: ParamRange = { min: -24, max: 6 }
const FILTER: ParamRange = { min: 80, max: 8000, curve: 'log' }

/** A router over a fixed param surface, recording every hold/release. */
const rig = (
  params: Record<string, ParamRange> = { 'bass.cutoff': FILTER, 'bass.drive': LIN },
) => {
  const holds: { synth: string; param: string; value: number }[] = []
  const releases: { synth: string; param: string }[] = []
  const changes: number[] = []
  let live = { ...params }
  let t = 0
  const router = new CcRouter({
    hold: (synth, param, value) => holds.push({ synth, param, value }),
    release: (synth, param) => releases.push({ synth, param }),
    lookup: (synth, param) => live[`${synth}.${param}`],
    onChange: () => changes.push(changes.length),
    now: () => t,
  })
  return {
    router,
    holds,
    releases,
    changes,
    /** the value of the last hold */
    last: () => holds[holds.length - 1],
    /** rewrite the document's param surface (a rename, a deletion) */
    setLive: (next: Record<string, ParamRange>) => {
      live = { ...next }
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('ccToValue', () => {
  it('maps a linear range across the full 7-bit span, endpoints exact', () => {
    expect(ccToValue(0, LIN)).toBe(0)
    expect(ccToValue(127, LIN)).toBe(1)
    expect(ccToValue(64, LIN)).toBeCloseTo(64 / 127, 12)
  })

  it('maps a linear range that does not start at zero', () => {
    expect(ccToValue(0, GAIN)).toBe(-24)
    expect(ccToValue(127, GAIN)).toBe(6)
    expect(ccToValue(64, GAIN)).toBeCloseTo(-24 + 30 * (64 / 127), 12)
  })

  it('maps a log range by RATIO, so equal knob steps are equal intervals', () => {
    expect(ccToValue(0, FILTER)).toBe(80)
    expect(ccToValue(127, FILTER)).toBe(8000)
    // the midpoint of a log sweep is the geometric mean, not the arithmetic one
    const mid = ccToValue(63.5, FILTER)
    expect(mid).toBeCloseTo(Math.sqrt(80 * 8000), 6)
    expect(mid).toBeLessThan((80 + 8000) / 2)
    // every step multiplies by the same ratio (the musical property)
    const step = ccToValue(1, FILTER) / ccToValue(0, FILTER)
    for (const cc of [1, 40, 90, 126]) {
      expect(ccToValue(cc + 1, FILTER) / ccToValue(cc, FILTER)).toBeCloseTo(step, 10)
    }
    expect(step).toBeCloseTo((8000 / 80) ** (1 / 127), 12)
  })

  it('clamps out-of-range controller values rather than extrapolating', () => {
    expect(ccToValue(-5, LIN)).toBe(0)
    expect(ccToValue(999, LIN)).toBe(1)
  })

  it('falls back to linear for a log range that is not strictly positive', () => {
    // the engine rejects such a param, but a stored mapping must not make NaN
    const bad: ParamRange = { min: 0, max: 10, curve: 'log' }
    expect(ccToValue(0, bad)).toBe(0)
    expect(ccToValue(127, bad)).toBe(10)
    expect(Number.isFinite(ccToValue(64, bad))).toBe(true)
  })
})

describe('cc14ToValue', () => {
  it('spans the same range with 128x the steps, endpoints exact', () => {
    expect(cc14ToValue(0, FILTER)).toBe(80)
    expect(cc14ToValue(16383, FILTER)).toBe(8000)
    expect(cc14ToValue(8191.5, FILTER)).toBeCloseTo(Math.sqrt(80 * 8000), 6)
  })

  it('refines WITHIN the MSB, never past its 7-bit neighbours', () => {
    // Full scale differs slightly between the two resolutions (127 steps vs
    // 16383), so an MSB alone does not land exactly on its 7-bit value; what
    // must hold is that adding an LSB never drags the value past the knob
    // positions either side of it.
    for (const lsb of [0, 1, 64, 127]) {
      const v = cc14ToValue(64 * 128 + lsb, FILTER)
      expect(v).toBeGreaterThan(ccToValue(63, FILTER))
      expect(v).toBeLessThan(ccToValue(65, FILTER))
    }
  })

  it('clamps out-of-range pair values', () => {
    expect(cc14ToValue(-1, LIN)).toBe(0)
    expect(cc14ToValue(99999, LIN)).toBe(1)
  })
})

describe('parseCc', () => {
  it('reads a control change on its channel', () => {
    expect(parseCc([0xb0, 74, 100])).toEqual({ channel: 0, cc: 74, value: 100 })
    expect(parseCc([0xb9, 1, 0])).toEqual({ channel: 9, cc: 1, value: 0 })
  })

  it('is not a note, a clock byte or a short message', () => {
    expect(parseCc([0x90, 60, 100])).toBeUndefined()
    expect(parseCc([0xf8])).toBeUndefined()
    expect(parseCc([0xb0, 74])).toBeUndefined()
    expect(parseCc(null)).toBeUndefined()
  })

  it('rejects channel mode messages (120..127), which are not knobs', () => {
    expect(parseCc([0xb0, MIN_MODE_CC, 0])).toBeUndefined()
    expect(parseCc([0xb0, 123, 0])).toBeUndefined() // all notes off
    expect(parseCc([0xb0, 119, 0])).toEqual({ channel: 0, cc: 119, value: 0 })
  })
})

describe('learn', () => {
  it('is not armed until asked, and then the NEXT control claims the param', () => {
    const { router, holds } = rig()
    expect(router.learning()).toBeUndefined()
    expect(router.handle({ channel: 0, cc: 74, value: 64 })).toBe('ignored')
    expect(holds).toEqual([])

    router.arm('bass', 'cutoff')
    expect(router.learning()).toEqual({ synth: 'bass', param: 'cutoff' })
    expect(router.handle({ channel: 2, cc: 74, value: 64 })).toBe('learned')
    expect(router.learning()).toBeUndefined() // learn is one-shot
    expect(router.mappings()).toEqual([{ channel: 2, cc: 74, synth: 'bass', param: 'cutoff' }])
  })

  it('the learning message itself does not jump the param', () => {
    // the knob is wherever the hardware left it; jerking the sound on the
    // binding turn would be a nasty surprise mid-set
    const { router, holds } = rig()
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 127 })
    expect(holds).toEqual([])
    router.handle({ channel: 0, cc: 74, value: 127 })
    expect(holds).toEqual([{ synth: 'bass', param: 'cutoff', value: 8000 }])
  })

  it('cancels, leaving the rig untouched', () => {
    const { router } = rig()
    router.arm('bass', 'cutoff')
    router.cancelLearn()
    expect(router.learning()).toBeUndefined()
    expect(router.handle({ channel: 0, cc: 74, value: 10 })).toBe('ignored')
    expect(router.mappings()).toEqual([])
  })

  it('arming again retargets rather than queueing', () => {
    const { router } = rig()
    router.arm('bass', 'cutoff')
    router.arm('bass', 'drive')
    router.handle({ channel: 0, cc: 74, value: 10 })
    expect(router.mappings()).toEqual([{ channel: 0, cc: 74, synth: 'bass', param: 'drive' }])
  })

  it('one control drives one param: rebinding a knob drops its old param and hands it back', () => {
    const { router, releases } = rig()
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 10 })
    router.handle({ channel: 0, cc: 74, value: 20 }) // the knob takes the param
    router.arm('bass', 'drive')
    router.handle({ channel: 0, cc: 74, value: 30 })
    expect(router.mappings()).toEqual([{ channel: 0, cc: 74, synth: 'bass', param: 'drive' }])
    expect(releases).toEqual([{ synth: 'bass', param: 'cutoff' }])
  })

  it('one param is driven by one control: learning it onto a second knob moves it', () => {
    const { router } = rig()
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 10 })
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 21, value: 10 })
    expect(router.mappings()).toEqual([{ channel: 0, cc: 21, synth: 'bass', param: 'cutoff' }])
  })

  it('an armed learn claims a control that is already bound, without moving the old param', () => {
    const { router, holds } = rig()
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 10 })
    router.handle({ channel: 0, cc: 74, value: 40 })
    holds.length = 0
    router.arm('bass', 'drive')
    expect(router.handle({ channel: 0, cc: 74, value: 90 })).toBe('learned')
    expect(holds).toEqual([]) // the rebinding turn moved neither param
  })

  it('channel matters: the same cc on another channel is a different control', () => {
    const { router } = rig()
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 10 })
    expect(router.handle({ channel: 1, cc: 74, value: 10 })).toBe('ignored')
    expect(router.handle({ channel: 0, cc: 74, value: 10 })).toBe('applied')
  })
})

describe('routing', () => {
  it('a mapped CC holds its param at the scaled value, exactly like a finger', () => {
    const { router, holds } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    expect(router.handle({ channel: 0, cc: 74, value: 0 })).toBe('applied')
    expect(router.handle({ channel: 0, cc: 74, value: 127 })).toBe('applied')
    expect(holds).toEqual([
      { synth: 'bass', param: 'cutoff', value: 80 },
      { synth: 'bass', param: 'cutoff', value: 8000 },
    ])
  })

  it('the hold is STICKY: nothing releases it while the mapping stands', () => {
    const { router, releases } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    for (const v of [0, 30, 60, 127]) router.handle({ channel: 0, cc: 74, value: v })
    expect(releases).toEqual([])
  })

  it('unmapping hands the param back to the pattern', () => {
    const { router, releases } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    router.handle({ channel: 0, cc: 74, value: 60 })
    router.unmap(0, 74)
    expect(router.mappings()).toEqual([])
    expect(releases).toEqual([{ synth: 'bass', param: 'cutoff' }])
  })

  it('unmapping a control that never moved releases nothing (it held nothing)', () => {
    const { router, releases } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    router.unmap(0, 74)
    expect(releases).toEqual([])
  })

  it('releaseHeld gives every param back but keeps the rig (MIDI switched off)', () => {
    const { router, releases } = rig()
    router.setMappings([
      { channel: 0, cc: 74, synth: 'bass', param: 'cutoff' },
      { channel: 0, cc: 75, synth: 'bass', param: 'drive' },
    ])
    router.handle({ channel: 0, cc: 74, value: 60 })
    router.handle({ channel: 0, cc: 75, value: 60 })
    router.releaseHeld()
    expect(releases).toEqual([
      { synth: 'bass', param: 'cutoff' },
      { synth: 'bass', param: 'drive' },
    ])
    expect(router.mappings()).toHaveLength(2)
    // and a further turn takes it back
    router.handle({ channel: 0, cc: 74, value: 60 })
    expect(releases).toHaveLength(2)
  })

  it('loading another project releases what the old rig held', () => {
    const { router, releases } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    router.handle({ channel: 0, cc: 74, value: 60 })
    router.setMappings([])
    expect(releases).toEqual([{ synth: 'bass', param: 'cutoff' }])
  })
})

describe('stale mappings', () => {
  it('rows report liveness alongside the binding, for the UI to show', () => {
    const { router } = rig()
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    expect(router.rows()).toEqual([
      { channel: 0, cc: 74, synth: 'bass', param: 'cutoff', stale: false },
    ])
  })

  it('renaming the synth makes the row stale, and rewriting it makes it live again', () => {
    const r = rig()
    r.router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    expect(r.router.rows()[0]!.stale).toBe(false)

    r.setLive({ 'lead.cutoff': FILTER }) // the synth was renamed
    expect(r.router.rows()[0]!.stale).toBe(true)
    expect(r.router.handle({ channel: 0, cc: 74, value: 60 })).toBe('stale')
    expect(r.holds).toEqual([]) // no crash, no hold, no engine message
    expect(r.router.mappings()).toHaveLength(1) // the mapping SURVIVES

    r.setLive({ 'bass.cutoff': FILTER }) // renamed back
    expect(r.router.rows()[0]!.stale).toBe(false)
    expect(r.router.handle({ channel: 0, cc: 74, value: 127 })).toBe('applied')
    expect(r.holds).toEqual([{ synth: 'bass', param: 'cutoff', value: 8000 }])
  })

  it('an empty document (nothing evaluated yet) is stale, not a crash', () => {
    const r = rig({})
    r.router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    expect(r.router.rows()[0]!.stale).toBe(true)
    expect(r.router.handle({ channel: 0, cc: 74, value: 60 })).toBe('stale')
  })
})

describe('14-bit MSB/LSB pairs', () => {
  const MAP: CcMapping[] = [{ channel: 0, cc: 10, synth: 'bass', param: 'cutoff' }]

  it('an LSB right after its MSB refines the value to 14 bits', () => {
    const r = rig()
    r.router.setMappings(MAP)
    expect(r.router.handle({ channel: 0, cc: 10, value: 64 })).toBe('applied')
    expect(r.last()!.value).toBeCloseTo(ccToValue(64, FILTER), 10)
    r.advance(2)
    expect(r.router.handle({ channel: 0, cc: 42, value: 100 })).toBe('refined')
    expect(r.last()!.value).toBeCloseTo(cc14ToValue(64 * 128 + 100, FILTER), 10)
    // the refinement is a real gain in resolution, not a rounding artifact
    expect(r.last()!.value).toBeGreaterThan(ccToValue(64, FILTER))
    expect(r.last()!.value).toBeLessThan(ccToValue(65, FILTER))
  })

  it('a late LSB is a control of its own, not a partner', () => {
    const r = rig()
    r.router.setMappings(MAP)
    r.router.handle({ channel: 0, cc: 10, value: 64 })
    r.advance(PAIR_WINDOW_MS + 1)
    expect(r.router.handle({ channel: 0, cc: 42, value: 100 })).toBe('ignored')
  })

  it('an LSB that is ITSELF mapped stays an ordinary knob (most gear uses 32..63 that way)', () => {
    const r = rig()
    r.router.setMappings([...MAP, { channel: 0, cc: 42, synth: 'bass', param: 'drive' }])
    r.router.handle({ channel: 0, cc: 10, value: 64 })
    r.advance(1)
    expect(r.router.handle({ channel: 0, cc: 42, value: 127 })).toBe('applied')
    expect(r.last()).toEqual({ synth: 'bass', param: 'drive', value: 1 })
  })

  it('an LSB whose MSB is on another channel is not a partner', () => {
    const r = rig()
    r.router.setMappings(MAP)
    r.router.handle({ channel: 0, cc: 10, value: 64 })
    expect(r.router.handle({ channel: 1, cc: 42, value: 100 })).toBe('ignored')
  })

  it('an LSB for an unmapped MSB is ignored, not applied to a neighbour', () => {
    const r = rig()
    r.router.setMappings(MAP)
    r.router.handle({ channel: 0, cc: 11, value: 64 }) // unmapped MSB
    expect(r.router.handle({ channel: 0, cc: 43, value: 100 })).toBe('ignored')
  })

  it('a stale partner refuses the refinement instead of throwing', () => {
    const r = rig()
    r.router.setMappings(MAP)
    r.router.handle({ channel: 0, cc: 10, value: 64 })
    r.setLive({})
    expect(r.router.handle({ channel: 0, cc: 42, value: 100 })).toBe('stale')
  })
})

describe('persistence', () => {
  const memStorage = (): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v)
      },
      removeItem: (k) => {
        data.delete(k)
      },
    }
  }

  const RIG: CcMapping[] = [
    { channel: 0, cc: 74, synth: 'bass', param: 'cutoff' },
    { channel: 3, cc: 21, synth: 'pad', param: 'shimmer' },
  ]

  it('round-trips a rig through storage, per project', () => {
    const s = memStorage()
    saveMappings(s, 'proj-a', RIG)
    saveMappings(s, 'proj-b', [{ channel: 1, cc: 1, synth: 'kick', param: 'snap' }])
    expect(loadMappings(s, 'proj-a')).toEqual(RIG)
    expect(loadMappings(s, 'proj-b')).toEqual([{ channel: 1, cc: 1, synth: 'kick', param: 'snap' }])
    expect(loadMappings(s, 'proj-c')).toEqual([]) // a project with no rig
  })

  it('an empty rig clears its key rather than storing "[]"', () => {
    const s = memStorage()
    saveMappings(s, 'proj-a', RIG)
    saveMappings(s, 'proj-a', [])
    expect(s.data.has(mappingsKey('proj-a'))).toBe(false)
    expect(loadMappings(s, 'proj-a')).toEqual([])
  })

  it('serialize drops anything that is not part of a mapping', () => {
    const fat = [{ ...RIG[0]!, stale: true, lastValue: 0.5 }]
    expect(JSON.parse(serializeMappings(fat))).toEqual([RIG[0]])
  })

  it('corrupt or foreign storage reads as an empty rig, never a throw', () => {
    expect(parseMappings('not json')).toEqual([])
    expect(parseMappings('{"channel":0}')).toEqual([]) // not an array
    expect(parseMappings('')).toEqual([])
    expect(parseMappings(null)).toEqual([])
  })

  it('drops individual malformed entries and keeps the good ones', () => {
    const raw = JSON.stringify([
      RIG[0],
      { channel: 16, cc: 1, synth: 'a', param: 'b' }, // channel out of range
      { channel: 0, cc: 200, synth: 'a', param: 'b' }, // cc out of range
      { channel: 0, cc: MIN_MODE_CC, synth: 'a', param: 'b' }, // channel mode, not a knob
      { channel: 0, cc: 1, synth: '', param: 'b' }, // no synth
      { channel: 0.5, cc: 1, synth: 'a', param: 'b' }, // not an integer
      null,
      'nope',
      RIG[1],
    ])
    expect(parseMappings(raw)).toEqual(RIG)
  })

  it('a blocked storage (private mode) neither throws nor loses the live rig', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadMappings(blocked, 'proj-a')).toEqual([])
    expect(() => saveMappings(blocked, 'proj-a', RIG)).not.toThrow()
  })

  it('the router reports every rig change so the caller can persist it', () => {
    const s = memStorage()
    const holds: number[] = []
    const router = new CcRouter({
      hold: (_s, _p, v) => holds.push(v),
      release: () => {},
      lookup: () => LIN,
      onChange: () => saveMappings(s, 'proj-a', router.mappings()),
    })
    router.arm('bass', 'drive')
    router.handle({ channel: 0, cc: 74, value: 64 })
    expect(loadMappings(s, 'proj-a')).toEqual([{ channel: 0, cc: 74, synth: 'bass', param: 'drive' }])
    router.handle({ channel: 0, cc: 74, value: 64 })
    expect(holds).toEqual([ccToValue(64, LIN)]) // the next turn drives the param
    router.unmap(0, 74)
    expect(loadMappings(s, 'proj-a')).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * End to end over a REAL Session: a simulated knob turn must reach the same
 * holdParam path a finger uses, land the right value on the wire, and take the
 * param away from the pattern for as long as it owns it.
 * ------------------------------------------------------------------------- */

const SRC = [
  `const bass = synth(({ sine, note, gate, param, svf }) =>`,
  `  svf(sine(note.freq), param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })).mul(gate))`,
  `p('pat', note('60 62').sound('bass').ctrl('cutoff', 500))`,
].join('\n')

const sessionRig = () => {
  const sent: EngineMessage[] = []
  const audio = {
    sent,
    send: (m: EngineMessage) => {
      sent.push(m)
    },
    onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
    currentTimeFrames: 0,
    sampleRate: 48000,
  }
  const intervals: { fn: () => void; cleared: boolean }[] = []
  const session = new Session({
    audio,
    startLead: 0,
    setIntervalImpl: (fn) => {
      const h = { fn, cleared: false }
      intervals.push(h)
      return h
    },
    clearIntervalImpl: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  })
  const router = new CcRouter({
    hold: (synth, param, value) => session.holdParam(synth, param, value, 'midi'),
    release: (synth, param) => session.releaseParam(synth, param, 'midi'),
    lookup: (synth, param) => {
      const t = session.paramTargets().find((p) => p.synth === synth && p.param === param)
      return t === undefined ? undefined : { min: t.min, max: t.max, curve: t.curve }
    },
  })
  const tick = (): void => {
    for (const i of intervals) if (!i.cleared) i.fn()
  }
  const setParams = (name: string): Extract<EngineMessage, { kind: 'setParam' }>[] =>
    sent.filter((m): m is Extract<EngineMessage, { kind: 'setParam' }> => m.kind === 'setParam' && m.name === name)
  return { audio, session, router, tick, setParams }
}

describe('Session.paramTargets', () => {
  it('reports each live synth param with the range and curve a knob needs', () => {
    const { session } = sessionRig()
    expect(session.paramTargets()).toEqual([]) // nothing evaluated yet
    expect(session.evalCode(SRC).ok).toBe(true)
    expect(session.paramTargets()).toEqual([
      { synth: 'bass', param: 'cutoff', default: 800, min: 80, max: 8000, curve: 'log' },
    ])
  })

  it('includes POST-chain params, marked, since setParam reaches them too', () => {
    const { session } = sessionRig()
    const src = [
      `const pad = synth(`,
      `  ({ sine, note, gate }) => sine(note.freq).mul(gate),`,
      `  ({ input, param }) => input.mul(param('trim', 0.5, { min: 0, max: 1 })))`,
      `p('pat', note('60').sound('pad'))`,
    ].join('\n')
    expect(session.evalCode(src).ok).toBe(true)
    expect(session.paramTargets()).toEqual([
      { synth: 'pad', param: 'trim', default: 0.5, min: 0, max: 1, curve: 'lin', post: true },
    ])
  })

  it('drops a param the moment its synth leaves the document (what makes a row stale)', () => {
    const { session, router } = sessionRig()
    session.evalCode(SRC)
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    expect(router.rows()[0]!.stale).toBe(false)
    session.evalCode(`p('pat', note('60'))`) // the synth is gone
    expect(session.paramTargets()).toEqual([])
    expect(router.rows()[0]!.stale).toBe(true)
  })
})

describe('a mapped knob over a real Session', () => {
  it('sends the scaled value as setParam, and full scale is the param maximum', () => {
    const { session, router, setParams } = sessionRig()
    session.evalCode(SRC)
    router.arm('bass', 'cutoff')
    router.handle({ channel: 0, cc: 74, value: 0 }) // the learning turn binds only
    router.handle({ channel: 0, cc: 74, value: 64 })
    router.handle({ channel: 0, cc: 74, value: 127 })
    const values = setParams('cutoff').map((m) => m.value)
    expect(values).toHaveLength(2)
    expect(values[0]).toBeCloseTo(80 * (8000 / 80) ** (64 / 127), 9)
    expect(values[1]).toBe(8000)
  })

  it('takes the param off the pattern for as long as the mapping stands', () => {
    const { audio, session, router, tick, setParams } = sessionRig()
    session.evalCode(SRC)
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })

    router.handle({ channel: 0, cc: 74, value: 127 })
    const held = setParams('cutoff').length
    tick()
    expect(setParams('cutoff')).toHaveLength(held) // the .ctrl(500) sweep stood down

    // unmap: the pattern takes its param back on the next event
    router.unmap(0, 74)
    audio.currentTimeFrames = 48000
    tick()
    expect(setParams('cutoff').slice(held).some((m) => m.value === 500)).toBe(true)
  })

  it('a finger and a knob are peers: last mover wins, and the finger hands back to the KNOB', () => {
    const { audio, session, router, tick, setParams } = sessionRig()
    session.evalCode(SRC)
    router.setMappings([{ channel: 0, cc: 74, synth: 'bass', param: 'cutoff' }])
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })

    router.handle({ channel: 0, cc: 74, value: 127 }) // the knob owns cutoff
    session.holdParam('bass', 'cutoff', 1234) // a finger grabs the same knob
    expect(setParams('cutoff').at(-1)!.value).toBe(1234) // last mover wins
    session.releaseParam('bass', 'cutoff') // the finger lifts

    // the knob still owns it, so the pattern does NOT come back
    const before = setParams('cutoff').length
    audio.currentTimeFrames = 48000
    tick()
    expect(setParams('cutoff')).toHaveLength(before)

    // only when the knob lets go too does the sweep resume
    router.releaseHeld()
    audio.currentTimeFrames = 96000
    tick()
    expect(setParams('cutoff').slice(before).some((m) => m.value === 500)).toBe(true)
  })

  it('a stale mapping over a live session is silent, not an engine message', () => {
    const { session, router, setParams } = sessionRig()
    session.evalCode(SRC)
    router.setMappings([{ channel: 0, cc: 74, synth: 'ghost', param: 'cutoff' }])
    expect(router.handle({ channel: 0, cc: 74, value: 127 })).toBe('stale')
    expect(setParams('cutoff')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------- *
 * A knob edit must not rebuild the synth.
 *
 * Dragging a knob rewrites its DEFAULT, and a params difference used to be
 * rejected wholesale by the constant patcher — so every knob edit rebuilt the
 * voice pool AND the post chain. That is inaudible on a filter, which
 * re-settles in milliseconds, and very audible on a DELAY: a new kernel gets a
 * zeroed ring buffer, so the echo tail vanishes and takes a delay time per
 * repeat to build back. At a synced eighth with feedback that is the reported
 * "second or two" before the change seems to land.
 * ------------------------------------------------------------------------- */
describe('a moved knob default is a VALUE change, not a rebuild', () => {
  const withCut = (v: number): string => [
    `const lead = synth(({ note, gate, param, saw, svf }) =>`,
    `  svf(saw(note.freq), param('cut', ${v}, { min: 100, max: 8000 })).mul(gate))`,
    `p('a', note('60').sound('lead'))`,
  ].join('\n')

  const withPostMix = (v: number): string => [
    `const lead = synth(({ note, gate, saw }) => saw(note.freq).mul(gate),`,
    `  ({ input, param, delay }) => delay(input, 0.125, 0.4, { sync: true, mix: param('wet', ${v}, { min: 0, max: 1 }) }))`,
    `p('a', note('60').sound('lead'))`,
  ].join('\n')

  const rig = () => {
    const sent: EngineMessage[] = []
    const session = new Session({
      audio: { send: (m: EngineMessage) => void sent.push(m), onEvent: undefined, currentTimeFrames: 0, sampleRate: 48000 },
      startLead: 0,
      setIntervalImpl: () => ({}),
      clearIntervalImpl: () => {},
    })
    return { session, sent }
  }

  it('a VOICE knob moves by setParam, with no redefine', () => {
    const { session, sent } = rig()
    session.evalCode(withCut(900))
    sent.length = 0
    expect(session.evalCode(withCut(1200), { live: true }).ok).toBe(true)
    expect(sent.some((m) => m.kind === 'defineSynth')).toBe(false)
    expect(sent).toContainEqual({ kind: 'setParam', synth: 'lead', name: 'cut', value: 1200 })
  })

  it('a POST knob does too — the case that cost the delay its tail', () => {
    const { session, sent } = rig()
    session.evalCode(withPostMix(0.3))
    sent.length = 0
    expect(session.evalCode(withPostMix(0.9), { live: true }).ok).toBe(true)
    expect(sent.some((m) => m.kind === 'defineSynth')).toBe(false)
    expect(sent).toContainEqual({ kind: 'setParam', synth: 'lead', name: 'wet', value: 0.9 })
  })

  it('a hand on the knob outranks the text it is mid-way through writing', () => {
    const { session, sent } = rig()
    session.evalCode(withCut(900))
    session.holdParam('lead', 'cut', 5000)
    sent.length = 0
    session.evalCode(withCut(1200), { live: true })
    // the eval must not yank the param back to the document under the finger
    expect(sent.filter((m) => m.kind === 'setParam')).toEqual([])
  })

  it('a REAL structural change still rebuilds', () => {
    // renaming the param, changing its bounds, or editing the graph is not a
    // value change and must not be smuggled through as one
    const { session, sent } = rig()
    session.evalCode(withCut(900))
    sent.length = 0
    const renamed = withCut(900).replace(/'cut'/g, "'brightness'")
    // NOT live: a live rebuild is deliberately coalesced behind a debounce, so
    // asserting on it would pin the timer rather than the decision
    session.evalCode(renamed)
    expect(sent.some((m) => m.kind === 'defineSynth')).toBe(true)
  })
})
