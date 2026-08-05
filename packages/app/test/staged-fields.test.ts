import { describe, expect, it, vi } from 'vitest'

/* ------------------------------------------------------------------------- *
 * ONE staged result, TWO consumers that must not disagree.
 *
 * evalCode stages what a program declared. The LIVE session applies it to the
 * engine; the OFFLINE renderer applies it again, separately, in render-runner.
 * Anything the live path forwards and the offline path does not produces a
 * bounce that quietly sounds different from what you just heard, with no error
 * anywhere. That has now happened three times:
 *
 *   #239  cps was optional on renderMix and eight callers omitted it, so
 *         every sync'd delay and LFO rendered at the wrong rate
 *   #243  a ctrl naming an undeclared param was an engine warning live and
 *         silently IGNORED offline, so the broken file rendered clean
 *   #244  peak normalization exists offline only, so a gain edit that got
 *         louder in the app did nothing (or the reverse) in the render
 *
 * Each was found by ear, weeks apart. So this does not test any one of them:
 * it derives the list of staged fields from a program that stages ALL of them
 * and demands that every field be ACCOUNTED FOR at both hops. A new staged
 * field fails here until someone writes down what happens to it, which is the
 * decision that got skipped all three times.
 * ------------------------------------------------------------------------- */

vi.mock('../../server/src/render-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/render-runner')>()
  return { ...actual, renderMix: vi.fn(actual.renderMix) }
})

import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { renderMix, stageCode } from '../../server/src/render-runner'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'
import { renderStagedMix } from '../src/editor/resample'
import { Session } from '../src/session/Session'

/** A program that stages EVERY field evalCode can produce. If a new staging
 *  call is added and not exercised here, the completeness test below cannot
 *  see it — so this source is the one thing that has to be kept current, and
 *  the assertion right after it says so out loud. */
const MAXIMAL = `
const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate))
const b = synth(({ saw, note, gate }) => saw(note.freq).mul(gate))
p('x', note('c3*4').sound('a'))
p('y', note('e4').sound('b'))
bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.8 }), { b: 0.3 })
sidechain('a', { depth: 0.5, release: 0.2, duck: { b: 0.7 } })
masterCompress({ threshold: -10, ratio: 3 })
visual(\`fn main() {}\`)
setTimeSig(3, 4)
setCps(0.7)
p('vox', sing('la la', 'c4 e4'))
`

/** Not staged data — the result envelope. */
const ENVELOPE = new Set(['ok', 'diagnostics'])

interface Fate {
  /** Does it survive evalCode -> StageResult (the headless staging hop)? */
  staged: boolean
  /** Which renderMix option it must become, or null if it becomes none. */
  mixOpt: string | null
  /** How to see that the LIVE session acted on it: an engine message kind it
   *  must send, or a check against the applied result. `null` means it has no
   *  observable effect through the engine at all, which also needs a reason. */
  live: EngineMessage['kind'] | 'callback' | null
  /** Required whenever something is false/null: why that is correct. */
  why?: string
}

const FATE: Record<string, Fate> = {
  synths: { staged: true, mixOpt: null, live: 'defineSynth', why: 'passed as renderMix\'s first ARGUMENT, not an option' },
  patterns: { staged: true, mixOpt: null, live: 'callback', why: 'run through runPatterns first; reaches renderMix as the events argument, and live it drives the scheduler rather than the engine' },
  buses: { staged: true, mixOpt: 'buses', live: 'defineBus' },
  sends: { staged: true, mixOpt: 'sends', live: 'setSend' },
  cps: { staged: true, mixOpt: 'cps', live: 'callback', why: 'live it retimes the scheduler, which is not an engine message' },
  sidechain: { staged: true, mixOpt: 'sidechain', live: 'setSidechain' },
  masterComp: { staged: true, mixOpt: 'masterComp', live: 'setMasterComp' },
  sings: {
    staged: true,
    mixOpt: null,
    live: 'callback',
    why:
      'a sing() clip is neural and baked ASYNCHRONOUSLY; staging gives the sampler synth and the trigger pattern, and the CALLER supplies the baked PCM via `samples`. A headless render with no bake is silent for that voice BY CONSTRUCTION, which the audio sweep reports as `needs samples` rather than a failure',
  },
  timeSig: {
    staged: true,
    mixOpt: null,
    live: 'callback',
    why: 'a cycle is one BAR whatever the meter, so meter changes no audio; it reaches the MIDI export instead (bounceMidi), where bar lines matter',
  },
  visual: {
    staged: false,
    mixOpt: null,
    live: 'callback',
    why: 'a WGSL fragment shader has no audio to render, and the GPU layer compiles it straight from the live result',
  },
}

const stagedFields = (): string[] => {
  const r = evalCode(MAXIMAL, baseScope)
  expect(r.ok, r.diagnostics.map((d) => d.message).join('; ')).toBe(true)
  return Object.keys(r)
    .filter((k) => !ENVELOPE.has(k) && (r as unknown as Record<string, unknown>)[k] !== undefined)
    .sort()
}

describe('staged fields reach both consumers', () => {
  it('exercises every staging call, so the list below is the whole list', () => {
    // Guards the fixture itself: a field only appears if MAXIMAL stages it.
    expect(stagedFields()).toEqual([
      'buses', 'cps', 'masterComp', 'patterns', 'sends', 'sidechain', 'sings', 'synths', 'timeSig', 'visual',
    ])
  })

  it('has a written-down fate for every staged field', () => {
    // THE POINT OF THIS FILE. A new staged field lands here first, and the
    // author has to say whether the offline render needs it. All three bugs
    // above are what happens when nobody is asked.
    expect(Object.keys(FATE).sort()).toEqual(stagedFields())
    for (const [name, f] of Object.entries(FATE)) {
      if (!f.staged || f.mixOpt === null) {
        expect(f.why, `'${name}' skips a hop, so it needs a reason`).toBeTruthy()
      }
    }
  })

  it('carries every field marked staged through stageCode', () => {
    const st = stageCode(MAXIMAL)
    if (!st.ok) throw new Error(st.diagnostics.map((d) => d.message).join('; '))
    for (const [name, f] of Object.entries(FATE)) {
      expect(name in st, `'${name}' is marked staged: true but stageCode dropped it`).toBe(f.staged)
    }
  })

  it('hands every field marked mixOpt to renderMix', () => {
    vi.mocked(renderMix).mockClear()
    const out = renderStagedMix(MAXIMAL, 1)
    if ('error' in out) throw new Error(out.error)
    expect(vi.mocked(renderMix)).toHaveBeenCalledTimes(1)
    const [synths, events, , opts] = vi.mocked(renderMix).mock.calls[0]!
    // the two that arrive as arguments rather than options
    expect([...synths.keys()]).toContain('a')
    expect(events.size, 'patterns must arrive as scheduled events').toBeGreaterThan(0)
    for (const [name, f] of Object.entries(FATE)) {
      if (f.mixOpt === null) continue
      expect(
        (opts as unknown as Record<string, unknown>)[f.mixOpt],
        `'${name}' is staged but never reached renderMix as '${f.mixOpt}' — the offline render would ignore it`,
      ).toBeDefined()
    }
  })

  it('sends an engine message for every field whose live effect is one', () => {
    // The other consumer. Same program, applied to a real Session against a
    // mock audio device, asserting the message each field is supposed to
    // produce actually arrives — so a field can't be dropped on the LIVE side
    // either, which is the direction that would make the render the correct
    // one and the app the liar.
    const sent: EngineMessage[] = []
    const session = new Session({
      audio: {
        send: (m: EngineMessage) => sent.push(m),
        onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
        currentTimeFrames: 0,
        sampleRate: 48000,
      },
      startLead: 0,
      onDiagnostics: () => {},
      onState: () => {},
      onEngineEvent: () => {},
      onPatternEvents: () => {},
      setIntervalImpl: (fn, ms) => ({ fn, ms }),
      clearIntervalImpl: () => {},
    })
    const r = session.evalCode(MAXIMAL)
    expect(r.ok, r.diagnostics.map((d) => d.message).join('; ')).toBe(true)
    const kinds = new Set(sent.map((m) => m.kind))
    for (const [name, f] of Object.entries(FATE)) {
      if (f.live === null || f.live === 'callback') continue
      expect(kinds.has(f.live), `'${name}' is staged but the live session never sent '${f.live}'`).toBe(true)
    }
  })

  it('does not quietly start forwarding something declared unforwarded', () => {
    // The other direction: a `why` that has gone stale is a lie in the file,
    // and the next reader trusts it.
    const st = stageCode(MAXIMAL)
    if (!st.ok) throw new Error('stage failed')
    for (const [name, f] of Object.entries(FATE)) {
      if (f.staged) continue
      expect(name in st, `'${name}' is documented as never staged, but stageCode now carries it`).toBe(false)
    }
  })
})
