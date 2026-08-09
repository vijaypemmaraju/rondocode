import { describe, expect, it, vi } from 'vitest'

/* bounceLoop is the "bounce loop" WAV export: stageCode → runPatterns →
 * renderMix. The bug class pinned here is exposed-but-silently-dropped: a
 * staged feature (samples / sidechain / masterCompress / buses+sends) that
 * bounceLoop forgets to thread into renderMix would export a WAV that
 * quietly sounds DIFFERENT from the live session — no error anywhere. So we
 * spy on renderMix (calling through to the real render) and assert the
 * option mapping carries everything staged. */

vi.mock('../../server/src/render-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/src/render-runner')>()
  return { ...actual, renderMix: vi.fn(actual.renderMix) }
})

import { renderMix } from '../../server/src/render-runner'
import { decodeWav } from '@rondocode/engine'
import { bounceLoop, bounceStems, measureBounce, zipStems } from '../src/editor/export'

const SYNTH = "synth(({ sine, note, gate }) => sine(note.freq).mul(gate))"
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

describe('bounceLoop → renderMix option mapping', () => {
  it('threads samples, sidechain, masterComp and buses+sends through (nothing silently dropped)', () => {
    vi.mocked(renderMix).mockClear()
    const samples = { clip: { data: new Float32Array(16), sampleRate: 48000 } }
    const out = bounceLoop(FULL_CODE, 1, samples)
    expect(out, JSON.stringify(out)).toHaveProperty('bytes') // a real (short) WAV rendered
    expect(vi.mocked(renderMix)).toHaveBeenCalledTimes(1)
    const [synths, events, durationSec, opts] = vi.mocked(renderMix).mock.calls[0]!
    expect([...synths.keys()].sort()).toEqual(['kick', 'pad'])
    expect([...events.keys()].sort()).toEqual(['kick', 'pad'])
    expect(durationSec).toBe(0.5) // 1 cycle at the staged cps 2
    expect(opts).toMatchObject({
      sampleRate: 48000,
      samples,
      sidechain: { source: 'kick', depth: 0.5, releaseMs: 200, amounts: { pad: 0.8 } },
      masterComp: { threshold: -12, ratio: 3 },
      sends: [{ synth: 'pad', bus: 'space', amount: 0.3 }],
    })
    expect([...(opts!.buses?.keys() ?? [])]).toEqual(['space'])
  })

  it('omits the optional features when the code stages none (bare render)', () => {
    vi.mocked(renderMix).mockClear()
    const out = bounceLoop(`const a = ${SYNTH}\np('x', note('c4').sound('a'))\nsetCps(2)`, 1)
    expect(out).toHaveProperty('bytes')
    const opts = vi.mocked(renderMix).mock.calls[0]![3]!
    expect(opts.sampleRate).toBe(48000)
    for (const key of ['samples', 'sidechain', 'masterComp', 'buses', 'sends', 'stems'] as const) {
      expect(key in opts, `unexpected '${key}'`).toBe(false)
    }
  })

  it('returns the staging error message instead of rendering when eval fails', () => {
    vi.mocked(renderMix).mockClear()
    const res = bounceLoop("throw new Error('nope')", 1)
    expect(res).toMatchObject({ error: expect.stringContaining('nope') })
    expect(vi.mocked(renderMix)).not.toHaveBeenCalled()
  })

  it('writes the depth it is asked for, defaulting to 16-bit', () => {
    const header = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const bounce = (bits?: 16 | 24 | 32): Uint8Array => {
      const out = bits === undefined ? bounceLoop(FULL_CODE, 1) : bounceLoop(FULL_CODE, 1, undefined, bits)
      if ('error' in out) throw new Error(out.error)
      return out.bytes
    }
    expect(header(bounce()).getUint16(34, true)).toBe(16)
    expect(header(bounce(24)).getUint16(34, true)).toBe(24)
    const f32 = header(bounce(32))
    expect(f32.getUint16(34, true)).toBe(32)
    expect(f32.getUint16(20, true)).toBe(3) // IEEE float tag
  })
})

/* ------------------------------------------------------------------------- *
 * STEM DELIVERY. The promise made to the user is "these files are the parts
 * of that mix", so the test decodes the delivered WAVs back out of the
 * delivered ZIP and adds them up against the delivered mix. Nothing about
 * that chain (render, stem split, encode, archive) can quietly break without
 * failing here.
 * ------------------------------------------------------------------------- */
describe('bounceStems', () => {
  it('names one file per synth plus one per send bus', () => {
    const res = bounceStems(FULL_CODE, 1, undefined, 16, 'my-track')
    if ('error' in res) throw new Error(res.error)
    expect(res.files.map((f) => f.name)).toEqual(['my-track-kick.wav', 'my-track-pad.wav', 'my-track-bus-space.wav'])
    expect(res.files.map((f) => f.part)).toEqual(['kick', 'pad', 'space'])
  })

  it('delivers stems that sum back to the WAV the same code bounces', () => {
    const mix = bounceLoop(FULL_CODE, 1, undefined, 32)
    if ('error' in mix) throw new Error(mix.error)
    const stems = bounceStems(FULL_CODE, 1, undefined, 32, 'sum')
    if ('error' in stems) throw new Error(stems.error)
    const mixed = decodeWav(mix.bytes)
    const parts = stems.files.map((f) => decodeWav(f.bytes))
    expect(parts.every((p) => p.left.length === mixed.left.length)).toBe(true)
    let worst = 0
    let peak = 0
    for (let i = 0; i < mixed.left.length; i++) {
      const l = parts.reduce((a, p) => a + p.left[i]!, 0)
      const r = parts.reduce((a, p) => a + p.right[i]!, 0)
      worst = Math.max(worst, Math.abs(l - mixed.left[i]!), Math.abs(r - mixed.right[i]!))
      peak = Math.max(peak, Math.abs(mixed.left[i]!))
    }
    // 32-bit float delivery keeps the render's own samples, so the only error
    // is the float32 rounding of one multiply per stem in the master stage.
    // Measured max |sum of stems - mix| = 6e-8 against a peak of ~0.5.
    expect(peak).toBeGreaterThan(0.1) // there really is audio in here
    expect(worst).toBeLessThan(1e-6)
  })

  it('says so instead of writing an empty archive when nothing made sound', () => {
    expect(bounceStems('setCps(1)', 1)).toMatchObject({ error: expect.stringContaining('no synth') })
    expect(bounceStems("throw new Error('nope')", 1)).toMatchObject({ error: expect.stringContaining('nope') })
  })

  it('zips the stems into one archive under a project folder', () => {
    const res = bounceStems(FULL_CODE, 1, undefined, 16, 'my-track')
    if ('error' in res) throw new Error(res.error)
    const files = res.files
    const zip = zipStems(files, 'my-track')
    expect(zip.name).toBe('my-track-stems.zip')
    // every stem's bytes appear intact inside the archive, under the folder
    const text = new TextDecoder('latin1').decode(zip.bytes)
    for (const f of files) expect(text).toContain(`my-track-stems/${f.name}`)
    expect(zip.bytes.length).toBeGreaterThan(files.reduce((a, f) => a + f.bytes.length, 0))
  })
})

describe('measureBounce', () => {
  it('reports integrated loudness and true peak of the bounce', () => {
    const res = measureBounce(FULL_CODE, 1)
    if ('error' in res) throw new Error(res.error)
    // e.g. "-17.2 LUFS · -6.0 dBTP peak" — the numbers themselves are pinned
    // against known signals in the engine's loudness tests.
    expect(res.text).toMatch(/^-?\d+\.\d LUFS · -?\d+\.\d dBTP peak( · normalized -\d+\.\d dB)?$/)
  })

  /* The readout used to document itself as "nothing is normalized or limited",
   * which was false: the mix stage pulls anything over 0.89 down to it before
   * the samples reach measureLoudness. So a hot project read back a tidy -1.0
   * dBTP and a loudness that had already been dragged down, with nothing
   * saying so. FULL_CODE is one of those — the assertion below would have
   * been impossible to write before, because the number did not exist. */
  it('says how far the mix stage pulled a hot bounce down, and stays quiet when it did not', () => {
    const at = (amp: number): string =>
      [`const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate).mul(${amp}))`,
       "p('x', note('c3*4').sound('a'))", 'setCps(2)'].join('\n')

    const hot = measureBounce(at(6), 1)
    if ('error' in hot) throw new Error(hot.error)
    expect(hot.text, hot.text).toMatch(/normalized -\d+\.\d dB/)

    const quiet = measureBounce(at(0.2), 1)
    if ('error' in quiet) throw new Error(quiet.error)
    expect(quiet.text, quiet.text).not.toContain('normalized')
  })

  /* The behaviour that makes this worth reporting at all: past the ceiling,
   * turning a part UP does not make the bounce louder. */
  it('a gain edit above the ceiling changes the balance, not the level', () => {
    const two = (loud: number): string =>
      [`const a = synth(({ sine, note, gate }) => sine(note.freq).mul(gate).mul(${loud}))`,
       'const b = synth(({ sine, note, gate }) => sine(note.freq).mul(gate).mul(3))',
       "p('x', note('c3').sound('a'))", "p('y', note('g4').sound('b'))", 'setCps(2)'].join('\n')
    const soft = measureBounce(two(3), 1)
    const loud = measureBounce(two(12), 1)
    if ('error' in soft || 'error' in loud) throw new Error('render failed')
    const lufs = (t: string): number => Number(/^(-?\d+\.\d) LUFS/.exec(t)![1])
    // 3 -> 12 is +12 dB asked for. Almost all of it is swallowed: what is left
    // is the balance shifting, not the file getting louder.
    const moved = Math.abs(lufs(loud.text) - lufs(soft.text))
    expect(moved, `+12 dB of gain moved the bounce ${moved} dB`).toBeLessThan(3)
    // …and the readout now says why, instead of leaving it a mystery
    expect(loud.text).toMatch(/normalized -\d+\.\d dB/)
  })

  it('passes the staging error through instead of measuring', () => {
    expect(measureBounce("throw new Error('nope')", 1)).toMatchObject({ error: expect.stringContaining('nope') })
  })
})
