import { describe, expect, it } from 'vitest'
import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { Session } from '../src/session/Session'
import { MemoryDb, ProjectStore } from '../src/session/projects'
import { forkName } from '../src/editor/library'

/* ------------------------------------------------------------------------- *
 * Project-wide macros, over a real Session.
 *
 * The feature is "one knob controls things across the whole project, each at
 * its own ratio". Two halves, tested separately because they fail differently:
 *
 *   - the RATIOS are ordinary arithmetic at each use site, so nothing has to
 *     know about them. What the macro guarantees is that every site reads ONE
 *     declaration, so the numbers cannot drift.
 *   - the BROADCAST is Session's job: one move, one message per live site.
 * ------------------------------------------------------------------------- */

const rig = () => {
  const sent: EngineMessage[] = []
  const audio = {
    send: (m: EngineMessage) => void sent.push(m),
    onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
    currentTimeFrames: 0,
    sampleRate: 48000,
  }
  // the scheduler tick is captured, not real: without driving it by hand no
  // pattern event is ever dispatched, and every "the pattern takes back over"
  // assertion below would pass vacuously
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
  const tick = (): void => {
    for (const i of intervals) if (!i.cleared) i.fn()
  }
  const setParams = (name: string): Extract<EngineMessage, { kind: 'setParam' }>[] =>
    sent.filter((m): m is Extract<EngineMessage, { kind: 'setParam' }> => m.kind === 'setParam' && m.name === name)
  return { session, sent, setParams, tick }
}

/** Three destinations, three different formulas, one declaration. */
const SRC = [
  `macro('bright', 1480, { min: 500, max: 7300, curve: 'log' })`,
  ``,
  `const lead = synth(({ note, gate, saw, svf, param }) =>`,
  `  svf(saw(note.freq), param('bright')).mul(gate))`,
  ``,
  `const pad = synth(({ note, gate, saw, svf, param }) =>`,
  `  svf(saw(note.freq), param('bright').mul(0.5)).mul(gate))`,
  ``,
  `const sub = synth(({ note, gate, sine, param }) => {`,
  `  const bright = param('bright')`,
  `  return sine(note.freq).mul(gate).mul(bright.div(7300).mul(-0.4).add(1))`,
  `})`,
  `p('a', note('60').sound('lead'))`,
  `p('b', note('48').sound('pad'))`,
  `p('c', note('36').sound('sub'))`,
].join('\n')

describe('a macro declaration is the single source of the numbers', () => {
  it('every site carries the declared range, so nothing can drift', () => {
    const { session } = rig()
    expect(session.evalCode(SRC).ok).toBe(true)
    const sites = session.paramTargets().filter((t) => t.param === 'bright')
    expect(sites.map((t) => t.synth).sort()).toEqual(['lead', 'pad', 'sub'])
    for (const t of sites) {
      expect(t).toMatchObject({ default: 1480, min: 500, max: 7300, curve: 'log', macro: true })
    }
  })

  it('groups into ONE control, and reports the sites it reaches', () => {
    const { session } = rig()
    session.evalCode(SRC)
    const macros = session.macroTargets()
    expect(macros).toHaveLength(1)
    expect(macros[0]).toMatchObject({ name: 'bright', default: 1480, min: 500, max: 7300, curve: 'log' })
    expect(macros[0]!.sites).toHaveLength(3)
  })

  it('a macro declared but never referenced is a knob with no sites, not a crash', () => {
    const { session } = rig()
    expect(session.evalCode(`macro('unused', 1)\nconst a = synth(({ gate }) => gate)`).ok).toBe(true)
    expect(session.macroTargets()).toEqual([])
  })

  it('a synth’s OWN param of the same name stays separate — the flag is the truth', () => {
    // this is the decision that keeps two `cutoff` knobs in two synths from
    // silently fusing: only a macro() reference opts in
    const { session } = rig()
    const src = [
      `macro('cutoff', 1000, { min: 100, max: 8000 })`,
      `const a = synth(({ gate, sine, param }) => sine(param('cutoff')).mul(gate))`,
      `const b = synth(({ gate, sine, param }) => sine(param('cutoff', 400)).mul(gate))`,
      `p('x', note('60').sound('a'))`,
      `p('y', note('60').sound('b'))`,
    ].join('\n')
    expect(session.evalCode(src).ok).toBe(true)
    expect(session.macroTargets()[0]!.sites.map((s) => s.synth)).toEqual(['a'])
    expect(session.paramTargets().find((t) => t.synth === 'b')!.default).toBe(400)
  })

  it('reaches POST chains, which no pattern .ctrl can', () => {
    const { session } = rig()
    const src = [
      `macro('air', 0.4, { min: 0, max: 1 })`,
      `const lead = synth(`,
      `  ({ gate, sine, note, param }) => sine(note.freq).mul(gate).mul(param('air')),`,
      `  ({ input, delay, param }) => delay(input, 0.25, param('air').mul(0.9)))`,
      `p('x', note('60').sound('lead'))`,
    ].join('\n')
    expect(session.evalCode(src).ok).toBe(true)
    const sites = session.macroTargets()[0]!.sites
    expect(sites).toHaveLength(2)
    expect(sites.filter((s) => s.post === true)).toHaveLength(1)
  })
})

describe('moving a macro moves every site at once', () => {
  it('one hold sends one setParam per site, all with the same value', () => {
    const { session, setParams } = rig()
    session.evalCode(SRC)
    session.holdMacro('bright', 3000)
    const msgs = setParams('bright')
    expect(msgs.map((m) => m.synth).sort()).toEqual(['lead', 'pad', 'sub'])
    expect(msgs.every((m) => m.value === 3000)).toBe(true)
  })

  it('holding outranks a pattern driving one of the copies', () => {
    // the macro knob is a performer's hand: while held, the sequencer's
    // .ctrl for that param is suppressed on exactly the held sites
    const { session, setParams, tick } = rig()
    const src = [
      `macro('bright', 1000, { min: 100, max: 8000 })`,
      `const lead = synth(({ gate, note, sine, svf, param }) => svf(sine(note.freq), param('bright')).mul(gate))`,
      `p('a', note('60 62').sound('lead').ctrl('bright', 500))`,
    ].join('\n')
    session.evalCode(src)
    session.holdMacro('bright', 4000)
    const held = setParams('bright').length
    session.transport('play')
    tick()
    expect(setParams('bright')).toHaveLength(held) // the pattern stood down
    session.releaseMacro('bright')
  })

  it('releases every site it HELD, even after an eval changed what is a macro', () => {
    // A drag re-evals continuously, so the target list moves under it. Release
    // computed from the CURRENT list misses a site that opted OUT mid-drag,
    // and that site then ignores its pattern for the rest of the session.
    const { session, setParams, tick } = rig()
    const withMacro = [
      `macro('bright', 1000, { min: 100, max: 8000 })`,
      `const lead = synth(({ gate, note, sine, svf, param }) => svf(sine(note.freq), param('bright')).mul(gate))`,
      `p('a', note('60 62').sound('lead').ctrl('bright', 500))`,
    ].join('\n')
    session.evalCode(withMacro)
    session.holdMacro('bright', 4000)

    // mid-drag edit: lead now declares its OWN bright, so it is no longer a
    // macro site — but it IS still held from a moment ago
    const optedOut = withMacro.replace(`param('bright')`, `param('bright', 900, { min: 100, max: 8000 })`)
    expect(session.evalCode(optedOut).ok).toBe(true)
    session.releaseMacro('bright')

    // the hold is gone, so the pattern drives it again on the next event
    const before = setParams('bright').length
    session.transport('play')
    tick()
    expect(setParams('bright').slice(before).some((m) => m.value === 500)).toBe(true)
  })

  it('setMacro reports how many sites it reached, so "moved nothing" is visible', () => {
    const { session } = rig()
    session.evalCode(SRC)
    expect(session.setMacro('bright', 2000)).toBe(3)
    expect(session.setMacro('nosuch', 1)).toBe(0)
  })

  it('a macro deleted by the next eval simply stops having sites', () => {
    const { session } = rig()
    session.evalCode(SRC)
    expect(session.macroTargets()).toHaveLength(1)
    expect(session.evalCode(`const lead = synth(({ gate }) => gate)\np('a', note('60').sound('lead'))`).ok).toBe(true)
    expect(session.macroTargets()).toEqual([])
    expect(session.setMacro('bright', 2000)).toBe(0) // forgiven, not thrown
  })
})

describe('macro errors are the user’s errors, reported not thrown', () => {
  it('referencing an undeclared macro fails the eval with a pointed message', () => {
    const { session } = rig()
    const r = session.evalCode(`const a = synth(({ param, gate }) => gate.mul(param('nope')))`)
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0]!.message).toMatch(/no macro named 'nope'/)
  })

  it('a failed eval rolls the registry back, so last-good keeps its macros', () => {
    const { session } = rig()
    session.evalCode(SRC)
    expect(session.evalCode(`macro('bright', 99, { min: 0, max: 1 })\nthrow new Error('boom')`).ok).toBe(false)
    // the previous program is still live and still holds the OLD declaration
    expect(session.macroTargets()[0]).toMatchObject({ default: 1480, min: 500, max: 7300 })
  })
})

/* ------------------------------------------------------------------------- *
 * A tab must not fork over its OWN writes.
 *
 * Reported as a project called "language (this tab) (this tab) (this tab)".
 * The name was the symptom; the cause was that setProjectLang and
 * renameProject move `updatedAt` without telling the caller, so a tab that
 * toggled js/rondo made its own next autosave look like a foreign write and
 * forked the project it was editing. Every toggle.
 * ------------------------------------------------------------------------- */
describe('own writes move the base version', () => {
  const store = (): ProjectStore => {
    let clock = 1000
    return new ProjectStore(new MemoryDb(), { now: () => ++clock, uid: (() => { let n = 0; return () => `id${++n}` })() })
  }

  it('setProjectLang hands back the new version', async () => {
    const s = store()
    const p = await s.createProject('language', 'saw', 'rondocode')
    const at = await s.setProjectLang(p.id, 'rondo')
    expect(at).toBeDefined()
    expect((await s.getProject(p.id))!.updatedAt).toBe(at)
    // and a save against THAT version is not a conflict
    expect((await s.saveCode(p.id, 'saw note', at)).kind).toBe('saved')
  })

  it('a save against the PRE-toggle version is what used to fork', async () => {
    const s = store()
    const p = await s.createProject('language', 'saw', 'rondocode')
    await s.setProjectLang(p.id, 'rondo')
    expect((await s.saveCode(p.id, 'saw note', p.updatedAt)).kind).toBe('conflict')
  })

  it('an unchanged language is not a write at all', async () => {
    const s = store()
    const p = await s.createProject('language', 'saw', 'rondo')
    expect(await s.setProjectLang(p.id, 'rondo')).toBeUndefined()
    expect((await s.saveCode(p.id, 'x', p.updatedAt)).kind).toBe('saved')
  })

  it('renameProject hands back its version too', async () => {
    const s = store()
    const p = await s.createProject('language', 'saw')
    const at = await s.renameProject(p.id, 'tune')
    expect((await s.saveCode(p.id, 'y', at)).kind).toBe('saved')
  })
})

describe('the fork name does not compound', () => {
  it('numbers instead of stacking suffixes', () => {
    // "(copy)", not "(this tab)": a name is read from every tab and outlives
    // all of them, so "this tab" was never true of anything in the list
    expect(forkName('language')).toBe('language (copy)')
    expect(forkName('language (copy)')).toBe('language (copy 2)')
    expect(forkName('language (copy 2)')).toBe('language (copy 3)')
    // a project already carrying the OLD suffix numbers up rather than
    // growing a second, different one
    expect(forkName('language (this tab)')).toBe('language (copy 2)')
    expect(forkName('language (this tab 2)')).toBe('language (copy 3)')
    expect(forkName('language (this tab 9)')).toBe('language (copy 10)')
  })

  it('leaves a name that merely mentions the suffix words alone', () => {
    expect(forkName('two tabs')).toBe('two tabs (copy)')
    expect(forkName('copy that')).toBe('copy that (copy)')
  })
})

/* ------------------------------------------------------------------------- *
 * Slide: the deferred release must not outlive its usefulness.
 *
 * A slide note holds until the NEXT note lands. The safety deadline for "no
 * next note ever comes" used to be PRE-SENT as a scheduled noteOff on the
 * assumption that "whichever fires first wins, the other is a no-op". That is
 * untrue the moment the same pitch is re-triggered before the deadline: the
 * stale release lands inside the NEW note and cuts it. At a tempo whose loop
 * divides the 4s cap it collides on exactly the same frame every time round.
 * ------------------------------------------------------------------------- */
describe('slide releases', () => {
  const rig = () => {
    const sent: EngineMessage[] = []
    const ints: { fn: () => void }[] = []
    const audio = { send: (m: EngineMessage) => void sent.push(m), onEvent: undefined, currentTimeFrames: 0, sampleRate: 48000 }
    const session = new Session({
      audio, startLead: 0,
      setIntervalImpl: (fn) => { const h = { fn }; ints.push(h); return h },
      clearIntervalImpl: () => {},
    })
    const run = (ticks: number): void => {
      for (let k = 0; k < ticks; k++) { for (const i of ints) i.fn(); audio.currentTimeFrames += 4800 }
    }
    const notes = () => sent.filter((m): m is Extract<EngineMessage, { kind: 'noteOn' | 'noteOff' }> =>
      m.kind === 'noteOn' || m.kind === 'noteOff')
    return { session, run, notes }
  }
  const SRC = [
    `const bass = synth(({ note, gate, saw, adsr }) => saw(note.freq).mul(adsr(gate)), undefined, { mono: true, glide: 0.08 })`,
    `p('b', n('0 3 5 7').scale('a minor').sound('bass').ctrl('slide', '0 1 0 1'))`,
  ].join('\n')

  it('holds a slide note PAST the next onset, which is what makes it glide', () => {
    const { session, run, notes } = rig()
    session.evalCode(SRC)
    session.transport('play')
    run(12)
    const on = notes().find((m) => m.kind === 'noteOn' && m.note === 62)!
    const off = notes().find((m) => m.kind === 'noteOff' && m.note === 62)!
    const nextOn = notes().find((m) => m.kind === 'noteOn' && m.note === 65)!
    expect(off.atFrame!).toBeGreaterThan(nextOn.atFrame!) // past the next note
    expect(off.atFrame! - on.atFrame!).toBeLessThan(48000) // …but not by the cap
  })

  it('sends NO release that lands inside a later note of the same pitch', () => {
    const { session, run, notes } = rig()
    session.evalCode(SRC)
    session.transport('play')
    run(60)
    const ons = notes().filter((m) => m.kind === 'noteOn')
    for (const off of notes().filter((m) => m.kind === 'noteOff')) {
      // the note this release actually belongs to is the NEAREST preceding
      // onset of that pitch; a release far past it is one that outlived its
      // note and is now sitting on top of a later one
      const owner = ons.filter((o) => o.note === off.note && o.atFrame! <= off.atFrame!)
        .sort((a, b) => b.atFrame! - a.atFrame!)[0]
      expect(owner, `off ${off.note}@${off.atFrame} has no onset`).toBeDefined()
      expect(off.atFrame! - owner!.atFrame!, `off ${off.note}@${off.atFrame} is stale`).toBeLessThan(96000)
    }
  })

  it('STILL releases when no next note ever comes', () => {
    // the case the deadline exists for — and the one a sweep inside
    // dispatchEvents could never see, because a tick with no events never
    // reaches it
    const { session, run, notes } = rig()
    session.evalCode([
      `const bass = synth(({ note, gate, saw, adsr }) => saw(note.freq).mul(adsr(gate)), undefined, { mono: true, glide: 0.08 })`,
      `p('b', n('0 ~ ~ ~').scale('a minor').sound('bass').ctrl('slide', 1).slow(40))`,
    ].join('\n'))
    session.transport('play')
    run(80)
    expect(notes().some((m) => m.kind === 'noteOff')).toBe(true)
  })
})
