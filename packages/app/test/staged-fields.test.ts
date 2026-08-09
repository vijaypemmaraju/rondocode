import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/** repo root, from this file's location (packages/app/test). */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

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
import { STAGING_NAMES, evalCode } from '../src/session/evalCode'
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
sidechain('a', { depth: 0.5, release: 200, duck: { b: 0.7 } })
masterCompress({ threshold: -10, ratio: 3 })
masterGain(-3)
stereo({ width: 1.2, monoBelow: 100 })
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
  masterGain: { staged: true, mixOpt: 'masterGain', live: 'setMaster' },
  stereo: { staged: true, mixOpt: 'stereo', live: 'setStereo' },
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

/** Staging names MAXIMAL deliberately does not call, and why. Everything else
 *  in STAGING_NAMES must appear in the fixture or the field it stages would be
 *  invisible to every assertion in this file. */
const NOT_IN_FIXTURE: Record<string, string> = {
  defineSynth: 'not written by hand — `const a = synth(...)` compiles to it, which MAXIMAL does twice',
  setBpm: 'an alternative spelling of setCps that stages the same `cps` field, already covered',
  __rcTap: 'internal source-position tap, stages nothing',
}

describe('staged fields reach both consumers', () => {
  it('calls every staging function, so nothing can stage a field unseen', () => {
    // Without this the fixture is a hand-maintained list, which is the exact
    // thing this file exists to replace: a new staging call would add a field
    // that MAXIMAL never triggers, so every check below would pass over it.
    for (const name of STAGING_NAMES) {
      if (name in NOT_IN_FIXTURE) continue
      expect(
        MAXIMAL.includes(`${name}(`),
        `MAXIMAL never calls ${name}() — add it, or say in NOT_IN_FIXTURE why it cannot be called`,
      ).toBe(true)
    }
  })

  it('exercises every staging call, so the list below is the whole list', () => {
    // Guards the fixture itself: a field only appears if MAXIMAL stages it.
    expect(stagedFields()).toEqual([
      'buses', 'cps', 'masterComp', 'masterGain', 'patterns', 'sends', 'sidechain', 'sings', 'stereo', 'synths', 'timeSig', 'visual',
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

  /* The mapping above is only worth pinning if there is ONE of it. Two scripts
   * had grown their own copy of the renderMix option object, and both went
   * stale the day masterGain landed: the audio sweep rendered seven examples
   * without their own output level and then reported them as still mixed into
   * the ceiling — a harness disagreeing with the app it measures. */
  it('is the only place that builds renderMix options', () => {
    const roots = ['packages/app/src', 'packages/server/src', 'packages/engine/src', 'scripts']
    const ALLOWED = new Set([
      'packages/server/src/render-runner.ts', // where renderMix is defined
      'packages/app/src/editor/resample.ts', // renderStagedMix: the one mapping
    ])
    const offenders: string[] = []
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(dir, e)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!full.endsWith('.ts') || full.includes('/test/') || e.startsWith('_')) continue
        const rel = full.slice(repoRoot.length + 1)
        if (ALLOWED.has(rel)) continue
        const text = readFileSync(full, 'utf8')
        if (/renderMix\s*\(/.test(text)) offenders.push(rel)
      }
    }
    for (const r of roots) walk(join(repoRoot, r))
    expect(
      offenders,
      'call renderStagedMix instead — it is the one place that knows which staged fields become which options',
    ).toEqual([])
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
