import { describe, expect, it } from 'vitest'
import { synth } from '../src/builder'
import { DEFAULT_VOICES, MAX_TOTAL_VOICES, RealtimeEngine, allocVoices, planVoiceBudget } from '../src/realtime'
import type { DspContext } from '../src/dsp/types'

/* ------------------------------------------------------------------------- *
 * THE VOICE BUDGET, AND SAYING SO.
 *
 * 128 voices, first come first served. A project past it used to fail in the
 * worst possible way: the synth written LAST was refused, the engine said
 * `voice budget exhausted` once, and then every note that synth should have
 * played reported `unknown synth` until the message that mattered had scrolled
 * away. A synth before it could be quietly cut from 32 voices to 14 and say
 * nothing at all.
 *
 * `planVoiceBudget` lets the host say the whole thing up front. That is only
 * worth having if it agrees with the engine, so the load-bearing test here is
 * the PARITY one: the plan is checked against what defineSynth actually does.
 * ------------------------------------------------------------------------- */

const ctx: DspContext = { sampleRate: 48000 }
const graph = synth((c) => c.gate.mul(0.5)).graph

describe('allocVoices', () => {
  it('gives what was asked when there is room', () => {
    expect(allocVoices(8, 0)).toEqual({ voices: 8, rejected: false })
  })

  it('clamps to what is left', () => {
    expect(allocVoices(32, MAX_TOTAL_VOICES - 5)).toEqual({ voices: 5, rejected: false })
  })

  it('refuses when nothing is left', () => {
    expect(allocVoices(8, MAX_TOTAL_VOICES)).toEqual({ voices: 0, rejected: true })
  })

  it('never hands out less than one voice while any remain', () => {
    expect(allocVoices(0, 0).voices).toBe(1)
    expect(allocVoices(-4, 0).voices).toBe(1)
  })
})

describe('planVoiceBudget', () => {
  it('defaults a synth that names no count', () => {
    expect(planVoiceBudget([{ name: 'a' }])[0]).toEqual({ name: 'a', asked: DEFAULT_VOICES, got: DEFAULT_VOICES, rejected: false })
  })

  it('is FIRST COME FIRST SERVED: the last synth is the one that loses', () => {
    /* Not proportional and not fair — which is exactly why the host has to
     * report it, since which synth breaks depends on where it sits in the
     * file rather than on anything musical. */
    const plan = planVoiceBudget([
      { name: 'big', voices: 64 }, { name: 'big2', voices: 64 }, { name: 'last' },
    ])
    expect(plan.map((p) => p.got)).toEqual([64, 64, 0])
    expect(plan[2]!.rejected).toBe(true)
  })

  it('reports a CLAMP as well as a rejection', () => {
    const plan = planVoiceBudget([{ name: 'a', voices: 120 }, { name: 'b', voices: 32 }, { name: 'c' }])
    expect(plan[1]).toEqual({ name: 'b', asked: 32, got: 8, rejected: false })
    expect(plan[2]!.rejected).toBe(true)
  })

  it('says nothing is wrong when the project fits', () => {
    const plan = planVoiceBudget([{ name: 'a', voices: 4 }, { name: 'b', voices: 8 }])
    expect(plan.every((p) => !p.rejected && p.got === p.asked)).toBe(true)
  })
})

describe('the plan MATCHES the engine', () => {
  /* The whole point of a pre-flight is that it predicts. Two copies of this
   * arithmetic would drift, and the symptom of drift is a warning that
   * contradicts what actually happens — worse than no warning. */
  const cases: { label: string; synths: { name: string; voices?: number }[] }[] = [
    { label: 'a project that fits', synths: [{ name: 'a', voices: 4 }, { name: 'b' }, { name: 'c', voices: 16 }] },
    {
      label: 'the reported project (154 asked, 128 available)',
      synths: [
        { name: 'lead', voices: 4 }, { name: 'arp' }, { name: 'keys' }, { name: 'modal_piano' },
        { name: 'modal_piano2', voices: 32 }, { name: 'sub', voices: 4 }, { name: 'kick' },
        { name: 'snare' }, { name: 'crash' }, { name: 'revnoise' }, { name: 'slide' },
        { name: 'cloudbass' }, { name: 'cloud', voices: 2 }, { name: 'glitch', voices: 32 },
      ],
    },
    { label: 'exactly at the ceiling', synths: [{ name: 'a', voices: 64 }, { name: 'b', voices: 64 }, { name: 'c' }] },
    { label: 'one synth over the ceiling', synths: [{ name: 'a', voices: 64 }, { name: 'b', voices: 64 }, { name: 'c', voices: 1 }] },
  ]

  for (const { label, synths } of cases) {
    it(label, () => {
      const eng = new RealtimeEngine(ctx)
      const actual: { name: string; got: number }[] = []
      for (const s of synths) {
        const msg: Record<string, unknown> = { kind: 'defineSynth', name: s.name, graph }
        if (s.voices !== undefined) msg['maxVoices'] = s.voices
        eng.handleMessage(msg as never)
        const ch = (eng as unknown as { byName: Map<string, { voices: number }> }).byName.get(s.name)
        actual.push({ name: s.name, got: ch?.voices ?? 0 })
      }
      const planned = planVoiceBudget(synths).map((p) => ({ name: p.name, got: p.got }))
      expect(planned, 'the pre-flight disagrees with the engine').toEqual(actual)
    })
  }

  it('and the engine SAYS SO rather than clamping in silence', () => {
    const eng = new RealtimeEngine(ctx)
    const errs: string[] = []
    ;(eng as unknown as { onEvent?: (e: { kind: string; message?: string }) => void }).onEvent =
      (e) => { if (e.kind === 'error' && e.message !== undefined) errs.push(e.message) }
    eng.handleMessage({ kind: 'defineSynth', name: 'a', graph, maxVoices: 120 })
    eng.handleMessage({ kind: 'defineSynth', name: 'b', graph, maxVoices: 32 })
    eng.handleMessage({ kind: 'defineSynth', name: 'c', graph })
    const all = errs.join(' | ')
    expect(all, 'a synth cut from 32 to 8 said nothing').toMatch(/'b' asked for 32 voices and got 8/)
    expect(all, 'the refusal did not name the synth').toMatch(/'c' cannot be created/)
    expect(all, 'the message should say what to do').toMatch(/voices:/)
  })
})
