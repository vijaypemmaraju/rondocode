import { describe, expect, it, vi } from 'vitest'

/* Resample-to-loop: bounce N cycles of the staged track into the sample bank
 * as takeN with a SAMPLE-ACCURATE loop length. The render flows through
 * renderStagedMix, the ONE staged→renderMix option mapping shared with the
 * WAV export (bounceLoop) — the last test here pins that the two paths hand
 * renderMix identical options, so a staged feature can never silently drop
 * from one path but not the other (the audited bug class). */

vi.mock('../../server/src/render-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/render-runner')>()
  return { ...actual, renderMix: vi.fn(actual.renderMix) }
})

import { renderMix } from '../../server/src/render-runner'
import { bounceLoop } from '../src/editor/export'
import { exactLoopFrames, nextTakeName, renderTakePcm, resampleTake } from '../src/editor/resample'

const SYNTH = "synth(({ sine, note, gate }) => sine(note.freq).mul(gate))"
const CODE = [`const a = ${SYNTH}`, "p('x', note('c4*4').sound('a'))", 'setCps(2)'].join('\n')

describe('nextTakeName', () => {
  it('starts at take1 and fills the first gap', () => {
    expect(nextTakeName([])).toBe('take1')
    expect(nextTakeName(['take1'])).toBe('take2')
    expect(nextTakeName(['take1', 'take2'])).toBe('take3')
    expect(nextTakeName(['take1', 'take3'])).toBe('take2') // first free wins
  })

  it('ignores non-take names (mic takes, built-ins, user files)', () => {
    expect(nextTakeName(['mic1', 'vox', 'pad', 'take10'])).toBe('take1')
  })
})

describe('exactLoopFrames', () => {
  it('is round(cycles / cps * sampleRate)', () => {
    expect(exactLoopFrames(0.5, 2, 48000)).toBe(192000) // 4s at 48k
    expect(exactLoopFrames(2, 1, 48000)).toBe(24000) // half a second
    expect(exactLoopFrames(2, 8, 44100)).toBe(176400)
  })

  it('rounds a fractional frame count to the nearest frame', () => {
    expect(exactLoopFrames(0.7, 2, 48000)).toBe(137143) // 137142.857…
    expect(exactLoopFrames(3, 1, 44100)).toBe(14700)
  })
})

describe('renderTakePcm (end to end)', () => {
  it('renders exactly cycles/cps seconds of mono PCM, normalized to 0.9', () => {
    const res = renderTakePcm(CODE, 2)
    expect(res, JSON.stringify(res)).not.toHaveProperty('error')
    const { data, sampleRate } = res as { data: Float32Array; sampleRate: number }
    expect(sampleRate).toBe(48000)
    expect(data).toBeInstanceOf(Float32Array) // one channel: mono by construction
    // 2 cycles at the staged cps 2 = exactly 1 second
    expect(data.length).toBe(exactLoopFrames(2, 2, 48000))
    expect(data.length).toBe(48000)
    let peak = 0
    let sumSq = 0
    for (const v of data) {
      const a = Math.abs(v)
      if (a > peak) peak = a
      sumSq += v * v
    }
    expect(peak).toBeCloseTo(0.9, 3) // micrec's normalize target
    expect(Math.sqrt(sumSq / data.length)).toBeGreaterThan(0.01) // non-silent
  })

  it('returns the staging error instead of PCM when eval fails', () => {
    const res = renderTakePcm("throw new Error('nope')", 1)
    expect(res).toMatchObject({ error: expect.stringContaining('nope') })
  })
})

describe('resampleTake', () => {
  const fakeAudio = (existing: string[]): {
    loadedSamples: Record<string, { data: Float32Array; sampleRate: number }>
    getSamples: () => { name: string; frames: number; sampleRate: number; builtIn: boolean }[]
    loadSamplePcm: ReturnType<typeof vi.fn>
  } => ({
    loadedSamples: {},
    getSamples: () => existing.map((name) => ({ name, frames: 16, sampleRate: 48000, builtIn: false })),
    loadSamplePcm: vi.fn(),
  })

  it('loads the rendered take under the next free takeN', () => {
    const audio = fakeAudio(['mic1', 'take1'])
    const res = resampleTake({ code: CODE, cycles: 1, audio })
    expect(res).toEqual({ name: 'take2', normalizeDb: 0 })
    expect(audio.loadSamplePcm).toHaveBeenCalledTimes(1)
    const [name, data, sampleRate] = audio.loadSamplePcm.mock.calls[0]!
    expect(name).toBe('take2')
    expect(data).toBeInstanceOf(Float32Array)
    expect((data as Float32Array).length).toBe(exactLoopFrames(2, 1, 48000))
    expect(sampleRate).toBe(48000)
  })

  /* A take is a bounce, so it meets the same 0.89 ceiling as the WAV export —
   * and resample-to-loop then normalizes AGAIN to 0.9 on the way into the
   * bank. Two normalizations means the take's level tells you nothing about
   * the level of what you resampled, so the amount the first one removed is
   * the only way to know a part was mixed past the top. */
  it('reports how far the mix stage pulled a hot take down', () => {
    const hot = ["const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate).mul(8))",
                 "p('x', note('c3*4').sound('a'))", 'setCps(2)'].join('\n')
    const res = resampleTake({ code: hot, cycles: 1, audio: fakeAudio([]) })
    if ('error' in res) throw new Error(res.error)
    expect(res.normalizeDb, 'a mix 8x over the ceiling must report the cut').toBeLessThan(-10)
  })

  it('reports render failures as { error } and loads nothing (never throws)', () => {
    const audio = fakeAudio([])
    const res = resampleTake({ code: 'not valid js (((', cycles: 1, audio })
    expect(res).toHaveProperty('error')
    expect(audio.loadSamplePcm).not.toHaveBeenCalled()
  })
})

/* The drift the shared-helper refactor exists to prevent: the WAV export and
 * the resample path must hand renderMix IDENTICAL options for the same
 * program. If either path grew its own staged→renderMix mapping again, a new
 * staged feature threaded into one but not the other would quietly render
 * different audio — this pins them together. */
describe('shared staged→renderMix mapping (WAV export vs resample)', () => {
  const FULL_CODE = [
    `const kick = ${SYNTH}`,
    `const pad = ${SYNTH}`,
    "bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9 }), { pad: 0.3 })",
    "p('k', note('c1*4').sound('kick'))",
    "p('p', note('c4').sound('pad'))",
    "sidechain('kick', { depth: 0.5, release: 200, duck: { pad: 0.8 } })",
    'masterCompress({ threshold: -12, ratio: 3 })',
    'setCps(2)',
  ].join('\n')

  it('both paths call renderMix with identical synths, events, duration and options', () => {
    vi.mocked(renderMix).mockClear()
    const samples = { clip: { data: new Float32Array(16), sampleRate: 48000 } }
    expect(bounceLoop(FULL_CODE, 1, samples)).toHaveProperty('bytes')
    expect(renderTakePcm(FULL_CODE, 1, samples)).not.toHaveProperty('error')
    expect(vi.mocked(renderMix)).toHaveBeenCalledTimes(2)
    const [wavCall, takeCall] = vi.mocked(renderMix).mock.calls
    const [wavSynths, wavEvents, wavDuration, wavOpts] = wavCall!
    const [takeSynths, takeEvents, takeDuration, takeOpts] = takeCall!
    expect([...takeSynths.keys()].sort()).toEqual([...wavSynths.keys()].sort())
    expect([...takeEvents.keys()].sort()).toEqual([...wavEvents.keys()].sort())
    expect(takeDuration).toBe(wavDuration)
    expect(takeOpts).toEqual(wavOpts) // sampleRate, samples, sidechain, masterComp, buses, sends
    // and the full feature set actually made it through (not vacuously equal)
    expect(wavOpts).toMatchObject({ sampleRate: 48000, samples })
    for (const key of ['sidechain', 'masterComp', 'buses', 'sends'] as const) {
      expect(wavOpts, `missing '${key}'`).toHaveProperty(key)
    }
  })
})
