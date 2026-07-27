import { describe, expect, it, vi, beforeEach } from 'vitest'

/* MULTI-PART SINGING. A harmony arrangement sings the same words in every
 * part, so the speech render and alignment are shared: only the warp and the
 * voice conversion are per part. And a queued run reports its position, so
 * four bakes read as "vocal 2 of 4" instead of one anonymous dialog. */

const calls: { voice: string }[] = []
let settlers: { resolve: () => void }[] = []

vi.mock('../src/sing/neural', () => ({
  renderNeural: (_l: string, _n: string, _c: number, voice: string, onProgress?: (p: unknown) => void) => {
    calls.push({ voice })
    onProgress?.({ phase: 'synthesize', label: 'phrase 1/1', done: 0, total: 1 })
    return new Promise((resolve) => {
      settlers.push({ resolve: () => resolve({ audio: new Float32Array(8), sr: 48000 }) })
    })
  },
}))

const req = (n: number, lyrics = 'oh sweet and low') => ({
  sampleName: `clip${n}`, synthName: `v${n}`, voice: `voice${n}`,
  lyrics, notes: 'c4 e4 g4 c5', cycles: 8,
})

describe('queued harmony bakes', () => {
  beforeEach(() => { calls.length = 0; settlers = []; vi.resetModules() })

  it('reports the position in a multi-part run', async () => {
    const singMgr = await import('../src/sing/singMgr')
    singMgr.initSing({ loadSamplePcm: () => {} } as never)
    const labels: string[] = []
    singMgr.onSingProgress((p) => { if (p) labels.push(p.label) })
    singMgr.bake([req(1), req(2), req(3), req(4)], 0.4)
    await new Promise((r) => setTimeout(r, 10))
    expect(labels.some((l) => l.startsWith('vocal 1 of 4'))).toBe(true)
    settlers[0]!.resolve()
    await new Promise((r) => setTimeout(r, 10))
    expect(labels.some((l) => l.startsWith('vocal 2 of 4'))).toBe(true)
  })

  it('a single vocal gets no part prefix', async () => {
    const singMgr = await import('../src/sing/singMgr')
    singMgr.initSing({ loadSamplePcm: () => {} } as never)
    const labels: string[] = []
    singMgr.onSingProgress((p) => { if (p) labels.push(p.label) })
    singMgr.bake([req(1)], 0.4)
    await new Promise((r) => setTimeout(r, 10))
    expect(labels.every((l) => !l.includes('vocal 1 of'))).toBe(true)
  })
})
