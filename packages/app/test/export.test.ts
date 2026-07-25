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
import { bounceLoop } from '../src/editor/export'

const SYNTH = "synth(({ sine, note, gate }) => sine(note.freq).mul(gate))"
const FULL_CODE = [
  `const kick = ${SYNTH}`,
  `const pad = ${SYNTH}`,
  "bus('space', ({ input, reverb }) => reverb(input, { roomSize: 0.9 }), { pad: 0.3 })",
  "p('k', note('c1*4').sound('kick'))",
  "p('p', note('c4').sound('pad'))",
  "sidechain('kick', { depth: 0.5, release: 0.2, duck: { pad: 0.8 } })",
  'masterCompress({ threshold: -12, ratio: 3 })',
  'setCps(2)',
].join('\n')

describe('bounceLoop → renderMix option mapping', () => {
  it('threads samples, sidechain, masterComp and buses+sends through (nothing silently dropped)', () => {
    vi.mocked(renderMix).mockClear()
    const samples = { clip: { data: new Float32Array(16), sampleRate: 48000 } }
    const out = bounceLoop(FULL_CODE, 1, samples)
    expect(out, JSON.stringify(out)).toBeInstanceOf(Uint8Array) // a real (short) WAV rendered
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
    expect(out).toBeInstanceOf(Uint8Array)
    const opts = vi.mocked(renderMix).mock.calls[0]![3]!
    expect(opts.sampleRate).toBe(48000)
    for (const key of ['samples', 'sidechain', 'masterComp', 'buses', 'sends'] as const) {
      expect(key in opts, `unexpected '${key}'`).toBe(false)
    }
  })

  it('returns the staging error message instead of rendering when eval fails', () => {
    vi.mocked(renderMix).mockClear()
    const res = bounceLoop("throw new Error('nope')", 1)
    expect(res).toMatchObject({ error: expect.stringContaining('nope') })
    expect(vi.mocked(renderMix)).not.toHaveBeenCalled()
  })
})
