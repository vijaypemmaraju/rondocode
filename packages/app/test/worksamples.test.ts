import { describe, expect, it, vi } from 'vitest'

/* The workspace half of per-project samples. In a workspace the FILE is the
 * project, so its takes live in `<stem>.samples/` beside it as WAVs — the
 * folder travels with the tune when it is copied, committed or handed over,
 * which an IndexedDB row beside the file would not.
 *
 * What must hold: a take round-trips through the folder UNCHANGED (resampling
 * something twice would otherwise degrade it), and the store presents the same
 * interface as the IndexedDB one so mountSamplePersistence never branches. */

const files = new Map<string, Uint8Array>()
vi.mock('../src/desktop/bridge', () => ({
  listProjectSamples: vi.fn(async (project: string) =>
    [...files.entries()]
      .filter(([k]) => k.startsWith(`${project}#`))
      .map(([k, wav]) => ({ name: k.slice(project.length + 1), wav })),
  ),
  writeProjectSample: vi.fn(async (project: string, name: string, wav: Uint8Array) => {
    files.set(`${project}#${name}`, wav)
    return `${project}.samples/${name}.wav`
  }),
  deleteProjectSample: vi.fn(async (project: string, name: string) => {
    files.delete(`${project}#${name}`)
  }),
}))

import { encodeWav } from '@rondocode/engine'
import { workspaceSampleStore } from '../src/editor/worksamples'

const PATH = '/tunes/one.rondo'

describe('workspace sample store', () => {
  it('round-trips a take through the folder bit for bit', async () => {
    files.clear()
    const store = workspaceSampleStore()
    // values that a 16-bit encode would round: the take must not degrade
    const pcm = new Float32Array([0.1234567, -0.7654321, 0.0000151, -1, 1])
    await store.putSample(PATH, 'take1', pcm, 48000)
    const [got] = await store.listSamples(PATH)
    expect(got, 'the take must come back').toBeDefined()
    expect([...got!.data]).toEqual([...pcm])
    expect(got!.sampleRate).toBe(48000)
    expect(got!.name).toBe('take1')
  })

  it('keys samples by the project PATH, because the file is the project', async () => {
    files.clear()
    const store = workspaceSampleStore()
    await store.putSample('/tunes/one.rondo', 'take1', new Float32Array([1]), 48000)
    await store.putSample('/tunes/two.js', 'take1', new Float32Array([-1]), 48000)
    // same NAME, different projects, different audio
    expect([...(await store.listSamples('/tunes/one.rondo'))[0]!.data]).toEqual([1])
    expect([...(await store.listSamples('/tunes/two.js'))[0]!.data]).toEqual([-1])
  })

  it('folds a stereo WAV someone dropped in the folder', async () => {
    files.clear()
    // the folder is user-visible, so this will happen
    const l = new Float32Array([1, 0])
    const r = new Float32Array([0, 1])
    files.set(`${PATH}#dropped`, encodeWav(l, r, 44100, { bits: 32 }))
    const [got] = await workspaceSampleStore().listSamples(PATH)
    expect([...got!.data], 'the bank is mono').toEqual([0.5, 0.5])
    expect(got!.sampleRate).toBe(44100)
  })

  it('forgets a take, and says nothing when it is already gone', async () => {
    files.clear()
    const store = workspaceSampleStore()
    await store.putSample(PATH, 'take1', new Float32Array([1]), 48000)
    await store.deleteSample(PATH, 'take1')
    expect(await store.listSamples(PATH)).toEqual([])
    await expect(store.deleteSample(PATH, 'take1')).resolves.toBeUndefined()
  })
})
