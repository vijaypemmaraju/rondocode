import { describe, expect, it } from 'vitest'
import { BLOCK, RealtimeEngine, micDevicesIn, sampleNamesIn, synth, usesMicIn } from '../src/index'
import type { EngineEvent } from '../src/index'

/* What a graph needs from OUTSIDE itself: a sample bank, or an input device.
 *
 * An offline render has neither, so those voices are digital zero — and the
 * headless scripts used to report "wrote out.wav" over exactly that, with the
 * only explanation in a comment three files away. These two walks are what let
 * a renderer say WHY a file is silent, and what stops the audio sweep from
 * flagging a working example as broken.
 *
 * The app asks the same question for a different reason (whether to request
 * microphone permission) and reads the same walk — see synthsUseMic. */

describe('sampleNamesIn', () => {
  it('finds the sample a sample() voice plays', () => {
    const s = synth(({ gate, sample }) => sample(gate, 'break'))
    expect(sampleNamesIn(s.graph)).toEqual(['break'])
  })

  it('finds the sample a granular() cloud plays', () => {
    const s = synth(({ gate, granular }) => granular(gate, 'pad', { size: 0.2 }))
    expect(sampleNamesIn(s.graph)).toEqual(['pad'])
  })

  it('reports each name ONCE, however many voices play it', () => {
    const s = synth(({ gate, sample }) => sample(gate, 'break').add(sample(gate, 'break')))
    expect(sampleNamesIn(s.graph)).toEqual(['break'])
  })

  it('collects every distinct name', () => {
    const s = synth(({ gate, sample, granular }) => sample(gate, 'vox').add(granular(gate, 'riser')))
    expect(sampleNamesIn(s.graph).sort()).toEqual(['riser', 'vox'])
  })

  it('is empty for a synth that plays no samples — the common case', () => {
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)))
    expect(sampleNamesIn(s.graph)).toEqual([])
  })
})

describe('usesMicIn', () => {
  it('is true for a graph that reads the microphone', () => {
    const s = synth(({ mic, svf }) => svf(mic(), 800))
    expect(usesMicIn(s.graph)).toBe(true)
  })

  it('is false for one that does not', () => {
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)))
    expect(usesMicIn(s.graph)).toBe(false)
  })

  it('sees a mic in a POST chain too, not only the voice', () => {
    // the post chain is a separate graph; a caller checking only .graph would
    // miss a vocoder fed from the mic downstream of the voices
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)), ({ input, mic }) => input.add(mic()))
    expect(usesMicIn(s.graph)).toBe(false)
    expect(s.post).toBeDefined()
    expect(usesMicIn(s.post!)).toBe(true)
  })
})

describe('micDevicesIn', () => {
  it('collects every distinct device, in first-appearance order', () => {
    const s = synth(({ mic }) => mic({ device: 'a' }).add(mic({ device: 'b' })).add(mic({ device: 'a' })))
    expect(micDevicesIn(s.graph)).toEqual(['a', 'b'])
  })

  it('skips bare and empty-named mics', () => {
    const s = synth(({ mic }) => mic().add(mic({ device: '' })))
    expect(micDevicesIn(s.graph)).toEqual([])
  })
})

/* MULTIPLE LIVE INPUTS: a device-named mic reads whichever slot the host has
 * mapped its name to (setMicMap), per block — captures open, close and remap
 * without recompiling any graph. A bare mic still aliases slot 0. */
describe('device-named mic inputs (multiple live inputs)', () => {
  const dc = (level: number): Float32Array => new Float32Array(BLOCK).fill(level)

  const mk = (graph: ReturnType<typeof synth>['graph'], name = 'v') => {
    const eng = new RealtimeEngine({ sampleRate: 48000 })
    const events: EngineEvent[] = []
    eng.onEvent = (ev) => events.push(ev)
    eng.handleMessage({ kind: 'defineSynth', name, graph })
    eng.handleMessage({ kind: 'noteOn', synth: name, note: 60 })
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    return { eng, events, l, r }
  }

  it('follows its mapped slot, and REMAPS live without a redefine', () => {
    const { eng, events, l, r } = mk(synth(({ mic }) => mic({ device: 'sm58' })).graph)
    // no map yet: silence, NOT the default capture
    eng.writeMic(dc(0.5), 0)
    eng.writeMic(dc(0.25), 1)
    eng.process(l, r, 0)
    expect(Math.max(...l.map(Math.abs))).toBe(0)
    // mapped to slot 1: follows that slot
    eng.handleMessage({ kind: 'setMicMap', map: { sm58: 1 } })
    eng.process(l, r, BLOCK)
    const at1 = Math.max(...l.map(Math.abs))
    expect(at1).toBeGreaterThan(0.01)
    // remapped to slot 2, which carries twice the level: output doubles
    eng.handleMessage({ kind: 'setMicMap', map: { sm58: 2 } })
    eng.writeMic(dc(0.5), 2)
    eng.process(l, r, BLOCK * 2)
    expect(Math.max(...l.map(Math.abs))).toBeCloseTo(at1 * 2, 1)
    expect(events.filter((e) => e.kind === 'error')).toEqual([])
  })

  it('a bare mic still reads the default capture, untouched by the map', () => {
    const { eng, l, r } = mk(synth(({ mic }) => mic()).graph)
    eng.handleMessage({ kind: 'setMicMap', map: { anything: 3 } })
    eng.writeMic(dc(0.4), 0)
    eng.process(l, r, 0)
    expect(Math.max(...l.map(Math.abs))).toBeGreaterThan(0.01)
  })

  it('two synths on two devices hear their own inputs at once', () => {
    const { eng, l, r } = mk(synth(({ mic }) => mic({ device: 'da' })).graph, 'a')
    eng.handleMessage({ kind: 'defineSynth', name: 'b', graph: synth(({ mic }) => mic({ device: 'db' })).graph })
    eng.handleMessage({ kind: 'noteOn', synth: 'b', note: 60 })
    eng.handleMessage({ kind: 'setMicMap', map: { da: 1, db: 2 } })
    eng.writeMic(dc(0.5), 1) // only device A's slot carries signal
    eng.process(l, r, 0)
    const meters = eng.collectMeters() as Extract<EngineEvent, { kind: 'meters' }>
    expect(meters.channels['a']).toBeGreaterThan(0.01)
    expect(meters.channels['b']).toBe(0)
  })

  it('an out-of-range slot rejects the whole map with an error event', () => {
    const { eng, events } = mk(synth(({ mic }) => mic({ device: 'x' })).graph)
    eng.handleMessage({ kind: 'setMicMap', map: { x: 9 } })
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(1)
  })
})
