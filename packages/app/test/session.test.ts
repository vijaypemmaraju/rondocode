import { describe, expect, it, vi } from 'vitest'
import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import type { SchedulerEvent } from '@rondocode/pattern'
import { Session } from '../src/session/Session'
import type { SessionState } from '../src/session/Session'
import type { Diagnostic } from '../src/session/evalCode'

/* Session tests run in plain Node: AudioSessionLike is mocked with a message
 * log and a settable frame clock; ticking is driven through an injected
 * setInterval capturing the callback (mirroring Scheduler's own tests). */

const SYNTH_SRC = 'synth(({ sine, note, gate }) => sine(note.freq).mul(gate))'
const GOOD_SRC = `const a = ${SYNTH_SRC}\np('pat', note('60 62').sound('a'))`

const rig = (overrides?: { onPatternEvents?: (evs: SchedulerEvent[]) => void }) => {
  const sent: EngineMessage[] = []
  const audio = {
    sent,
    send(m: EngineMessage) {
      sent.push(m)
    },
    onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
    currentTimeFrames: 0,
    sampleRate: 48000,
  }
  const intervals: { fn: () => void; ms: number; cleared: boolean }[] = []
  const diags: Diagnostic[][] = []
  const states: SessionState[] = []
  const engineEvents: EngineEvent[] = []
  const patternEvents: SchedulerEvent[][] = []
  const session = new Session({
    audio,
    // Exact-frame assertions below assume cycle 0 == audio-clock 0; the
    // production 0.1s first-note lead is covered by scheduler.test.ts.
    startLead: 0,
    onDiagnostics: (d) => diags.push(d),
    onState: (s) => states.push(s),
    onEngineEvent: (ev) => engineEvents.push(ev),
    onPatternEvents: overrides?.onPatternEvents ?? ((evs) => patternEvents.push(evs)),
    setIntervalImpl: (fn, ms) => {
      const h = { fn, ms, cleared: false }
      intervals.push(h)
      return h
    },
    clearIntervalImpl: (h) => {
      ;(h as { cleared: boolean }).cleared = true
    },
  })
  /** Fire every live interval callback once (one scheduler tick). */
  const tick = () => {
    for (const i of intervals) if (!i.cleared) i.fn()
  }
  const ofKind = <K extends EngineMessage['kind']>(kind: K) =>
    sent.filter((m): m is Extract<EngineMessage, { kind: K }> => m.kind === kind)
  return { audio, sent, intervals, diags, states, engineEvents, patternEvents, session, tick, ofKind }
}

describe('Session.evalCode: apply-on-ok', () => {
  it('ok eval sends defineSynth and registers the pattern', () => {
    const { session, ofKind } = rig()
    const r = session.evalCode(GOOD_SRC)
    expect(r.ok).toBe(true)
    const defs = ofKind('defineSynth')
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe('a')
    expect(defs[0]!.graph).toHaveProperty('nodes')
    const st = session.getState()
    expect(st.synths).toEqual(['a'])
    expect(st.patterns).toEqual(['pat'])
    expect(st.playing).toBe(false)
    expect(session.code).toBe(GOOD_SRC)
  })

  it('re-eval with an unchanged synth does NOT resend defineSynth', () => {
    const { session, ofKind } = rig()
    session.evalCode(GOOD_SRC)
    session.evalCode(GOOD_SRC)
    expect(ofKind('defineSynth')).toHaveLength(1)
  })

  it('a changed synth graph IS resent', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const a = ${SYNTH_SRC}`)
    session.evalCode(`const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate).mul(0.5))`)
    expect(ofKind('defineSynth')).toHaveLength(2)
  })

  it('vanished synths get removeSynth; vanished patterns leave the scheduler', () => {
    const { session, ofKind } = rig()
    session.evalCode(GOOD_SRC)
    session.evalCode(`const b = ${SYNTH_SRC}`)
    expect(ofKind('removeSynth').map((m) => m.name)).toEqual(['a'])
    const st = session.getState()
    expect(st.synths).toEqual(['b'])
    expect(st.patterns).toEqual([])
  })

  it('a bad eval sends nothing and leaves prior state intact', () => {
    const { session, sent } = rig()
    session.evalCode(GOOD_SRC)
    const before = { count: sent.length, state: session.getState() }
    const r = session.evalCode(`p('other', n('0'))\nthrow new Error('mid-eval')`)
    expect(r.ok).toBe(false)
    expect(sent.length).toBe(before.count)
    const after = session.getState()
    expect(after.synths).toEqual(before.state.synths)
    expect(after.patterns).toEqual(before.state.patterns)
    expect(session.code).toBe(GOOD_SRC) // last GOOD source
    expect(session.lastAttempted).toContain('mid-eval')
  })

  it('forwards eval diagnostics, then clears them on the next ok eval', () => {
    const { session, diags } = rig()
    session.evalCode('throw new Error("nope")')
    expect(diags.at(-1)![0]!.message).toContain('nope')
    session.evalCode(`p('pat', n('0'))`)
    expect(diags.at(-1)).toEqual([])
  })

  it('staged setCps applies to the scheduler', () => {
    const { session } = rig()
    expect(session.getState().cps).toBe(0.5)
    session.evalCode('setCps(2)')
    expect(session.getState().cps).toBe(2)
  })
})

describe('Session.evalCode: sidechain diff & send', () => {
  it('sends setSidechain with the right payload when a config appears', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const kick = ${SYNTH_SRC}\nsidechain('kick', { depth: 0.7 })\n${GOOD_SRC}`)
    const scs = ofKind('setSidechain')
    expect(scs).toHaveLength(1)
    expect(scs[0]).toMatchObject({ kind: 'setSidechain', source: 'kick', depth: 0.7, releaseMs: 180 })
  })

  it('does not resend an unchanged sidechain', () => {
    const { session, ofKind } = rig()
    const src = `const kick = ${SYNTH_SRC}\nsidechain('kick', { depth: 0.7 })\n${GOOD_SRC}`
    session.evalCode(src)
    session.evalCode(src)
    expect(ofKind('setSidechain')).toHaveLength(1)
  })

  it('resends when the config changes', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const kick = ${SYNTH_SRC}\nsidechain('kick', { depth: 0.7 })\n${GOOD_SRC}`)
    session.evalCode(`const kick = ${SYNTH_SRC}\nsidechain('kick', { depth: 0.5 })\n${GOOD_SRC}`)
    expect(ofKind('setSidechain')).toHaveLength(2)
  })

  it('sends clearSidechain when the config vanishes', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const kick = ${SYNTH_SRC}\nsidechain('kick')\n${GOOD_SRC}`)
    session.evalCode(GOOD_SRC)
    expect(ofKind('setSidechain')).toHaveLength(1)
    expect(ofKind('clearSidechain')).toHaveLength(1)
  })

  it('a failed eval sends no sidechain message', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const kick = ${SYNTH_SRC}\nsidechain('kick')\nthrow new Error('x')`)
    expect(ofKind('setSidechain')).toHaveLength(0)
    expect(ofKind('clearSidechain')).toHaveLength(0)
  })

  it('sends setMasterComp on appear, not again unchanged, clears on vanish', () => {
    const { session, ofKind } = rig()
    session.evalCode(`masterCompress({ ratio: 3 })\n${GOOD_SRC}`)
    session.evalCode(`masterCompress({ ratio: 3 })\n${GOOD_SRC}`) // unchanged
    expect(ofKind('setMasterComp')).toHaveLength(1)
    expect(ofKind('setMasterComp')[0]).toMatchObject({ kind: 'setMasterComp', ratio: 3, threshold: -18 })
    session.evalCode(GOOD_SRC) // vanished
    expect(ofKind('clearMasterComp')).toHaveLength(1)
  })

  it('sends setChannel(sidechain: amount) for each duck-map entry', () => {
    const { session, ofKind } = rig()
    session.evalCode(`sidechain('a', { duck: { a: 0.5 } })\n${GOOD_SRC}`)
    const setChans = ofKind('setChannel')
    expect(setChans).toContainEqual({ kind: 'setChannel', synth: 'a', sidechain: 0.5 })
  })

  it('does not resend unchanged duck amounts, resets a dropped one to 1', () => {
    const { session, ofKind } = rig()
    const src = (amt: string) => `const k = ${SYNTH_SRC}\nsidechain('k', { duck: { a: ${amt} } })\n${GOOD_SRC}`
    session.evalCode(src('0.5'))
    session.evalCode(src('0.5')) // unchanged -> no new setChannel
    expect(ofKind('setChannel').filter((m) => m.sidechain !== undefined)).toHaveLength(1)
    // drop the duck map entirely -> reset 'a' back to full duck (1)
    session.evalCode(`const k = ${SYNTH_SRC}\nsidechain('k')\n${GOOD_SRC}`)
    expect(ofKind('setChannel')).toContainEqual({ kind: 'setChannel', synth: 'a', sidechain: 1 })
  })
})

describe('Session.evalCode: bus & send diff', () => {
  const REVERB = "({ input, reverb }) => reverb(input, { roomSize: 0.8 })"
  const busSrc = (sends = '{ a: 0.4 }') => `const a = ${SYNTH_SRC}\nbus('space', ${REVERB}, ${sends})`

  it('sends defineBus with graph + gain and setSend for the routes', () => {
    const { session, ofKind } = rig()
    session.evalCode(busSrc())
    const defs = ofKind('defineBus')
    expect(defs).toHaveLength(1)
    expect(defs[0]).toMatchObject({ kind: 'defineBus', name: 'space', gain: 1 })
    expect(defs[0]!.graph).toHaveProperty('nodes')
    expect(ofKind('setSend')).toContainEqual({ kind: 'setSend', synth: 'a', bus: 'space', amount: 0.4 })
  })

  it('does not resend an unchanged bus or send', () => {
    const { session, ofKind } = rig()
    session.evalCode(busSrc())
    session.evalCode(busSrc())
    expect(ofKind('defineBus')).toHaveLength(1)
    expect(ofKind('setSend')).toHaveLength(1)
  })

  it('resends setSend when the amount changes', () => {
    const { session, ofKind } = rig()
    session.evalCode(busSrc('{ a: 0.4 }'))
    session.evalCode(busSrc('{ a: 0.7 }'))
    const sends = ofKind('setSend')
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ amount: 0.7 })
  })

  it('resets a dropped send to 0 while the bus lives on', () => {
    const { session, ofKind } = rig()
    session.evalCode(busSrc('{ a: 0.4 }'))
    session.evalCode(busSrc('{}')) // route dropped, bus still present
    expect(ofKind('setSend')).toContainEqual({ kind: 'setSend', synth: 'a', bus: 'space', amount: 0 })
    expect(ofKind('removeBus')).toHaveLength(0)
  })

  it('sends removeBus when the bus vanishes and does NOT reset its sends (engine drops them)', () => {
    const { session, ofKind } = rig()
    session.evalCode(busSrc('{ a: 0.4 }'))
    session.evalCode(`const a = ${SYNTH_SRC}`) // no bus() at all
    expect(ofKind('removeBus').map((m) => m.name)).toEqual(['space'])
    // no setSend(...,0): removeBus already dropped the routing engine-side
    expect(ofKind('setSend').filter((m) => m.amount === 0)).toHaveLength(0)
  })

  it('a failed eval sends no bus message', () => {
    const { session, ofKind } = rig()
    session.evalCode(`bus('space', ${REVERB})\nthrow new Error('x')`)
    expect(ofKind('defineBus')).toHaveLength(0)
    expect(ofKind('setSend')).toHaveLength(0)
  })
})

describe('Session.transport', () => {
  it('play starts a 25ms tick interval; stop clears it and panics notes', () => {
    const { session, intervals, ofKind } = rig()
    session.transport('play', { cps: 1 })
    expect(intervals).toHaveLength(1)
    expect(intervals[0]!.ms).toBe(25)
    expect(intervals[0]!.cleared).toBe(false)
    const st = session.getState()
    expect(st.playing).toBe(true)
    expect(st.cps).toBe(1)
    session.transport('stop')
    expect(intervals[0]!.cleared).toBe(true)
    expect(ofKind('silenceAll')).toHaveLength(1) // hard cut on stop (also stops sung vocal clips)
    expect(session.getState().playing).toBe(false)
  })

  it('transport cps is clamped like setCps', () => {
    const { session } = rig()
    session.transport('play', { cps: 99 })
    expect(session.getState().cps).toBe(4)
  })
})

describe('Session: scheduler events → engine messages', () => {
  it('fires noteOn/noteOff with atFrame from the audio clock', () => {
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(GOOD_SRC)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick() // window [0, 0.1): note 60 at t=0
    const ons = ofKind('noteOn')
    expect(ons).toHaveLength(1)
    expect(ons[0]).toMatchObject({ synth: 'a', note: 60, velocity: 1, atFrame: 0 })
    const offs = ofKind('noteOff')
    // dur 0.5s minus the 5ms gate gap (guarantees ADSR re-attack when the
    // next same-note event abuts this one — see GATE_GAP_SEC)
    expect(offs[0]).toMatchObject({ synth: 'a', note: 60, atFrame: 23760 })
    audio.currentTimeFrames = 24000 // t = 0.5s
    tick() // window advances past 0.5: note 62
    expect(ofKind('noteOn').at(-1)).toMatchObject({ synth: 'a', note: 62, atFrame: 24000 })
  })

  it('adaptive slide: defers a slide note release until its next note lands (bridging a gap)', () => {
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(`const a = ${SYNTH_SRC}\np('m', note('60 ~ ~ 67').slide('1 0 0 0').sound('a'))`)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick() // window [0, 0.1): note 60 (slide) at t=0
    // the slide note's release is DEFERRED — no early cut near its own end
    // (~0.25s = 12000 frames); only a far-out safety noteOff exists so far.
    expect(ofKind('noteOff').filter((o) => o.note === 60 && o.atFrame < 24000)).toHaveLength(0)
    audio.currentTimeFrames = 36000 // t = 0.75s, when note 67 fires
    tick()
    const on67 = ofKind('noteOn').find((o) => o.note === 67)!
    // note 60 is now cut just as 67 lands — bridging the 3-rest gap
    const cut60 = ofKind('noteOff').filter((o) => o.note === 60).sort((a, b) => a.atFrame - b.atFrame)[0]!
    expect(cut60.atFrame).toBeGreaterThanOrEqual(on67.atFrame)
    expect(cut60.atFrame - on67.atFrame).toBeLessThan(2000)
  })

  it('gate gap: back-to-back same-note events leave a low-gate window', () => {
    // Regression for the "four-on-the-floor kick plays once" bug: with
    // full-length gates the noteOff landed on the SAME frame as the next
    // noteOn, the retriggered voice's gate never dropped, and s=0
    // envelopes never re-attacked. Every noteOff must precede the next
    // same-note noteOn by at least one frame.
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(`const a = ${SYNTH_SRC}\np('k', note('60 60 60 60').sound('a'))`)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick() // window [0, 0.1): first event
    audio.currentTimeFrames = 24000 // t = 0.5s
    tick() // events at 0.25, 0.5 enter the window
    const ons = ofKind('noteOn')
    const offs = ofKind('noteOff')
    expect(ons.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < ons.length; i++) {
      expect((offs[i - 1]! as { atFrame: number }).atFrame).toBeLessThan(
        (ons[i]! as { atFrame: number }).atFrame,
      )
    }
  })

  it('onPatternEvents receives each batch after message sending, locs intact', () => {
    // Post-send ordering is pinned INSIDE the hook: when it runs, the
    // batch's noteOn must already be in the message log.
    let noteOnsAtCallback = -1
    const batches: SchedulerEvent[][] = []
    const r = rig({
      onPatternEvents: (evs) => {
        batches.push(evs)
        noteOnsAtCallback = r.sent.filter((m) => m.kind === 'noteOn').length
      },
    })
    r.session.evalCode(GOOD_SRC) // pattern source: note('60 62').sound('a')
    r.audio.currentTimeFrames = 0
    r.session.transport('play', { cps: 1 })
    r.tick() // window [0, 0.1): the '60' atom fires
    expect(batches).toHaveLength(1)
    expect(noteOnsAtCallback).toBe(1) // noteOn already sent when the hook ran
    const ev = batches[0]![0]!
    expect(ev.timeSec).toBe(0)
    expect(ev.controls).toMatchObject({ note: 60, sound: 'a' })
    // loc is the '60' atom's range within the mini string "60 62"
    expect(ev.loc).toEqual({ start: 0, end: 2, src: '60 62' })
  })

  it('a throwing onPatternEvents hook is swallowed: messages sent, ticking continues', () => {
    const { session, audio, tick, ofKind } = rig({
      onPatternEvents: () => {
        throw new Error('ui bug')
      },
    })
    session.evalCode(GOOD_SRC)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    expect(() => tick()).not.toThrow()
    expect(ofKind('noteOn')).toHaveLength(1) // note 60: sent despite the throw
    audio.currentTimeFrames = 24000 // t = 0.5s
    expect(() => tick()).not.toThrow()
    expect(ofKind('noteOn')).toHaveLength(2) // note 62: later ticks unaffected
  })

  it('numeric non-transport controls become setParam; gain maps to velocity', () => {
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(
      // synth 'a' declares a 'cutoff' voice param so the .ctrl target is valid
      // (eval-time ctrl validation now rejects unknown params — see evalCode).
      `const a = synth(({ sine, note, gate, param, svf }) => svf(sine(note.freq), param('cutoff', 500)).mul(gate))\np('pat', note('60').sound('a').ctrl('cutoff', 500).gain(0.5))`,
    )
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick()
    const params = ofKind('setParam')
    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({ synth: 'a', name: 'cutoff', value: 500 })
    expect(ofKind('noteOn')[0]).toMatchObject({ velocity: 0.5 })
  })

  it('touch-to-override: a held param suppresses the pattern drive until release', () => {
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(
      `const a = synth(({ sine, note, gate, param, svf }) => svf(sine(note.freq), param('cutoff', 500)).mul(gate))\np('pat', note('60 62').sound('a').ctrl('cutoff', 500))`,
    )
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })

    // the hand grabs the knob: applies immediately…
    session.holdParam('a', 'cutoff', 1234)
    const immediate = ofKind('setParam')
    expect(immediate[immediate.length - 1]).toMatchObject({ synth: 'a', name: 'cutoff', value: 1234 })

    // …and the pattern's ctrl for that param is suppressed while held
    const before = ofKind('setParam').length
    tick()
    const during = ofKind('setParam').slice(before)
    expect(during.filter((m) => (m as { name?: string }).name === 'cutoff')).toHaveLength(0)
    expect(ofKind('noteOn').length).toBeGreaterThan(0) // notes still play

    // release: the drive resumes on its next event
    session.releaseParam('a', 'cutoff')
    audio.currentTimeFrames = 48000 // next cycle
    const afterRelease = ofKind('setParam').length
    tick()
    const resumed = ofKind('setParam').slice(afterRelease)
    expect(resumed.filter((m) => (m as { name?: string }).name === 'cutoff').length).toBeGreaterThan(0)
  })

  it('events without sound or note are skipped silently', () => {
    const { session, audio, tick, ofKind } = rig()
    session.evalCode(`p('nosound', note('60'))\np('nonote', n('0 1').sound('a'))`)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick()
    expect(ofKind('noteOn')).toHaveLength(0)
    expect(ofKind('setParam')).toHaveLength(0)
  })

  it('a pattern that throws at query time surfaces on the diagnostics channel', () => {
    const { session, audio, tick, diags } = rig()
    session.evalCode(
      `p('bad', reify(0).withValue(() => { throw new Error('qfail') }))`,
    )
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    tick()
    const last = diags.at(-1)![0]!
    expect(last.source).toBe('scheduler')
    expect(last.message).toContain("pattern 'bad'")
    expect(last.message).toContain('qfail')
    expect(session.getState().lastError).toContain('qfail')
  })

  it('a persistently throwing pattern reports once, not per tick', () => {
    const { session, audio, tick, diags, states } = rig()
    session.evalCode(`p('bad', reify(0).withValue(() => { throw new Error('qfail') }))`)
    audio.currentTimeFrames = 0
    session.transport('play', { cps: 1 })
    const diagsBefore = diags.length
    const statesBefore = states.length
    for (let i = 0; i < 5; i++) {
      audio.currentTimeFrames += 1200 // 25ms
      tick()
    }
    expect(diags.length).toBe(diagsBefore + 1) // first failure only
    expect(states.length).toBe(statesBefore + 1)
    // A successful eval clears runtime diagnostics; the next failure re-reports.
    session.evalCode(`p('bad', reify(0).withValue(() => { throw new Error('qfail') }))`)
    expect(diags.at(-1)).toEqual([])
    audio.currentTimeFrames += 1200
    tick()
    expect(diags.at(-1)![0]!.message).toContain('qfail')
  })
})

describe('Session: engine events and params', () => {
  it('takes ownership of audio.onEvent and maps engine errors to diagnostics', () => {
    const { session, audio, diags } = rig()
    expect(audio.onEvent).toBeTypeOf('function')
    audio.onEvent!({ kind: 'error', message: 'bad graph' })
    const d = diags.at(-1)![0]!
    expect(d.message).toBe('bad graph')
    expect(d.source).toBe('engine')
    expect(d.severity).toBe('error')
    expect(session.getState().lastError).toContain('bad graph')
  })

  it('passes every engine event through onEngineEvent (errors included)', () => {
    const { audio, engineEvents } = rig()
    const meters = { kind: 'meters', frame: 128, master: 0.5, channels: {} } as const
    audio.onEvent!(meters)
    audio.onEvent!({ kind: 'error', message: 'oops' })
    expect(engineEvents).toEqual([meters, { kind: 'error', message: 'oops' }])
  })

  it('merges runtime diagnostics with a failed eval; ok eval clears them', () => {
    const { session, audio, diags } = rig()
    audio.onEvent!({ kind: 'error', message: 'stuck voice' })
    session.evalCode('throw new Error("boom")')
    const merged = diags.at(-1)!
    expect(merged).toHaveLength(2)
    expect(merged.map((d) => d.source)).toEqual(['eval', 'engine'])
    session.evalCode(`p('pat', n('0'))`)
    expect(diags.at(-1)).toEqual([])
  })

  it('a failed eval fires onState with lastError set', () => {
    const { session, states } = rig()
    const before = states.length
    session.evalCode('throw new Error("bad code")')
    expect(states.length).toBe(before + 1)
    expect(states.at(-1)!.lastError).toContain('bad code')
  })

  it('setParam parses "synth.param" addresses', () => {
    const { session, ofKind } = rig()
    session.setParam('a.cutoff', 800, 30)
    expect(ofKind('setParam')[0]).toEqual({
      kind: 'setParam',
      synth: 'a',
      name: 'cutoff',
      value: 800,
      rampMs: 30,
    })
    expect(() => session.setParam('nodot', 1)).toThrow(/synth\.param/)
    expect(() => session.setParam('.x', 1)).toThrow()
    expect(() => session.setParam('x.', 1)).toThrow()
  })

  it('setChannel sends only the provided fields', () => {
    const { session, ofKind } = rig()
    session.evalCode(`const a = ${SYNTH_SRC}`)
    session.setChannel('a', { gain: 0.5 })
    session.setChannel('a', { pan: 0.25 })
    session.setChannel('a', { gain: 1, pan: 0 })
    expect(ofKind('setChannel')).toEqual([
      { kind: 'setChannel', synth: 'a', gain: 0.5 },
      { kind: 'setChannel', synth: 'a', pan: 0.25 },
      { kind: 'setChannel', synth: 'a', gain: 1, pan: 0 },
    ])
  })

  it('setChannel for an unknown synth is a silent no-op (console.warn only)', () => {
    // Live-coding forgiveness: a mixer slider bound to a just-removed synth
    // must not throw mid-performance — see the method doc.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { session, ofKind } = rig()
      expect(() => session.setChannel('ghost', { gain: 0.5 })).not.toThrow()
      expect(ofKind('setChannel')).toHaveLength(0)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('dispose stops ticking, panics, and empties the session (terminal)', () => {
    const { session, intervals, ofKind, audio } = rig()
    session.evalCode(GOOD_SRC)
    session.transport('play')
    session.dispose()
    expect(intervals[0]!.cleared).toBe(true)
    expect(ofKind('allNotesOff').length).toBeGreaterThan(0)
    expect(audio.onEvent).toBeUndefined()
    const st = session.getState()
    expect(st.playing).toBe(false)
    expect(st.synths).toEqual([])
    expect(st.patterns).toEqual([])
  })

  it('rejects a lone timer impl (both or neither)', () => {
    const audio = {
      send: () => {},
      currentTimeFrames: 0,
      sampleRate: 48000,
    }
    expect(() => new Session({ audio, setIntervalImpl: () => 0 })).toThrow(/both/)
    expect(() => new Session({ audio, clearIntervalImpl: () => {} })).toThrow(/both/)
  })
})

describe('Session.evalCode: live constant patch vs rebuild', () => {
  const GAIN = (g: number) =>
    `const a = synth(({ sine, note }) => sine(note.freq).mul(${g}))\np('p', note('60').sound('a'))`
  const CFG = (d: number) =>
    `const a = synth(({ sine, note, gate, adsr }) => sine(note.freq).mul(adsr(gate, { a: 0.01, d: ${d}, s: 0.3, r: 0.1 })))\np('p', note('60').sound('a'))`

  it('hot-patches a live constant-only change (no rebuild)', () => {
    const { session, ofKind } = rig()
    session.evalCode(GAIN(0.5)) // Run: initial defineSynth
    expect(ofKind('defineSynth')).toHaveLength(1)
    session.evalCode(GAIN(0.9), { live: true }) // scrub: only a constant changed
    expect(ofKind('defineSynth')).toHaveLength(1) // NOT rebuilt
    const patches = ofKind('patchConstants')
    expect(patches).toHaveLength(1)
    expect(patches[0]!.name).toBe('a')
    expect(patches[0]!.patches.some((p) => p.value === 0.9)).toBe(true)
  })

  it('debounces a live rebuild (config change) instead of glitch-spamming', () => {
    const { session, ofKind } = rig()
    session.evalCode(CFG(0.2)) // Run: initial defineSynth
    expect(ofKind('defineSynth')).toHaveLength(1)
    session.evalCode(CFG(0.5), { live: true }) // scrub: kernel config (adsr d) changed
    expect(ofKind('defineSynth')).toHaveLength(1) // deferred (debounced), not immediate
    expect(ofKind('patchConstants')).toHaveLength(0) // config isn't patchable
  })

  it('rebuilds immediately on a non-live (Run) config change', () => {
    const { session, ofKind } = rig()
    session.evalCode(CFG(0.2))
    session.evalCode(CFG(0.5)) // Run (not live): apply now
    expect(ofKind('defineSynth')).toHaveLength(2)
  })
})
