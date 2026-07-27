import { describe, expect, it, vi, beforeEach } from 'vitest'

/* Bakes must run ONE AT A TIME. Each render is heavy synchronous inference on
 * the main thread, so concurrent bakes wedge the tab rather than finishing
 * sooner: a four-part vocal arrangement locked the page for minutes with no
 * progress and no way out. */

const renderCalls: string[] = []
let active = 0
let maxActive = 0
let settlers: { resolve: () => void; reject: () => void }[] = []

vi.mock('../src/sing/neural', () => ({
  renderNeural: (_l: string, _n: string, _c: number, voice: string) => {
    renderCalls.push(voice)
    active++
    maxActive = Math.max(maxActive, active)
    return new Promise((resolve, reject) => {
      settlers.push({
        resolve: () => { active--; resolve({ audio: new Float32Array(8), sr: 48000 }) },
        reject: () => { active--; reject(new Error('bake failed')) },
      })
    })
  },
}))

const req = (n: number) => ({
  sampleName: `clip${n}`,
  synthName: `v${n}`,
  voice: `voice${n}`,
  lyrics: 'la',
  notes: 'c4',
  cycles: 1,
})

describe('bake queue', () => {
  beforeEach(() => {
    renderCalls.length = 0
    settlers = []
    active = 0
    maxActive = 0
    vi.resetModules()
  })

  it('runs one render at a time, in order', async () => {
    const singMgr = await import('../src/sing/singMgr')
    singMgr.initSing({ loadSamplePcm: () => {} } as never)
    singMgr.bake([req(1), req(2), req(3), req(4)], 0.5)
    // renderOne dynamically imports the neural chunk first, so let the
    // microtask queue and one macrotask drain before asserting
    await new Promise((r) => setTimeout(r, 10))
    // only the FIRST has started
    expect(renderCalls).toEqual(['voice1'])
    expect(maxActive).toBe(1)
    // drain them one by one
    for (let i = 0; i < 4; i++) {
      settlers[i]?.resolve()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(renderCalls).toEqual(['voice1', 'voice2', 'voice3', 'voice4'])
    expect(maxActive).toBe(1) // never concurrent
  })

  it('a failed bake does not stall the queue behind it', async () => {
    const singMgr = await import('../src/sing/singMgr')
    singMgr.initSing({ loadSamplePcm: () => {} } as never)
    singMgr.bake([req(1), req(2)], 0.5)
    await new Promise((r) => setTimeout(r, 10))
    expect(renderCalls).toEqual(['voice1'])
    settlers[0]!.reject() // the manager catches it and moves on
    await new Promise((r) => setTimeout(r, 20))
    expect(renderCalls).toContain('voice2') // the queue moved on
  })
})
