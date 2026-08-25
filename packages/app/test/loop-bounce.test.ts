import { describe, expect, it } from 'vitest'
import type { EngineEvent, EngineMessage } from '@rondocode/engine'
import { Session } from '../src/session/Session'
import { compile } from '@rondocode/rondo'

/* The loop-bounce round trip, host side. The ENGINE half (bounceLoop message
 * -> loopBounced event, registry, empty/unknown errors) is pinned in
 * engine/test/looper.test.ts against a real RealtimeEngine; this pins the
 * Session half: a loopBounced event is fed back through loadSamplePcm (the
 * ONE sample-loading path), and namedLoopers() finds the pedals the samples
 * popover should offer. */

const rig = () => {
  const sent: EngineMessage[] = []
  const loaded: { name: string; frames: number; sampleRate: number }[] = []
  const audio = {
    send: (m: EngineMessage) => { sent.push(m) },
    loadSamplePcm: (name: string, data: Float32Array, sampleRate: number) => {
      loaded.push({ name, frames: data.length, sampleRate })
    },
    onEvent: undefined as ((ev: EngineEvent) => void) | undefined,
    currentTimeFrames: 0,
    sampleRate: 48000,
  }
  const session = new Session({
    audio,
    startLead: 0,
    setIntervalImpl: (fn) => ({ fn, cleared: false }),
    clearIntervalImpl: () => {},
  })
  return { audio, sent, loaded, session }
}

describe('loopBounced handling', () => {
  it('feeds the PCM back through loadSamplePcm under the event sample name', () => {
    const { audio, loaded } = rig()
    audio.onEvent?.({
      kind: 'loopBounced', looper: 'jam', sample: 'jam',
      data: new Float32Array(2048), sampleRate: 48000, frames: 2048,
    })
    expect(loaded).toEqual([{ name: 'jam', frames: 2048, sampleRate: 48000 }])
  })
})

describe('namedLoopers', () => {
  it('finds a named post-chain looper in the applied program; unnamed ones stay invisible', () => {
    const { session } = rig()
    const src = `synth pedal
  saw
  post
    looper rec feedback:decay name:jam
    rec = knob 0 0..1
    decay = knob 1 0..1

synth plain
  saw
  post
    looper rec2
    rec2 = knob 0 0..1

play pedal
  0

play plain
  0

cps .5
`
    const c = compile(src)
    expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const r = session.evalCode(c.code)
    expect(r.ok, JSON.stringify(r.ok ? [] : r.diagnostics)).toBe(true)
    expect(session.namedLoopers()).toEqual(['jam'])
  })
})
