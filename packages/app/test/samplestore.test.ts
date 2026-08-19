import { describe, expect, it, vi } from 'vitest'
import { MemoryDb, ProjectStore } from '../src/session/projects'
import { mountSamplePersistence } from '../src/editor/samplestore'

/* A resampled take used to live for exactly as long as the tab did, so
 * `sample(gate, 'take1')` in a SAVED project played today and rendered silence
 * tomorrow with the code unchanged. These pin the round trip and the two ways
 * it could go wrong quietly: writing a sample back into the project you just
 * switched away from, and re-writing on load what was just read. */

/** The slice of AudioSession this watches, with a settable bank. */
const fakeAudio = () => {
  const listeners = new Set<() => void>()
  const pcm: Record<string, { data: Float32Array; sampleRate: number }> = {}
  const list: { name: string; builtIn?: boolean }[] = []
  return {
    loadedSamples: pcm,
    getSamples: () => [...list],
    loadSamplePcm: vi.fn((name: string, data: Float32Array, sampleRate: number, builtIn = false) => {
      pcm[name] = { data, sampleRate }
      const i = list.findIndex((s) => s.name === name)
      const rec = { name, builtIn }
      if (i === -1) list.push(rec)
      else list[i] = rec
      for (const fn of listeners) fn()
    }),
    removeSample: (name: string) => {
      delete pcm[name]
      const i = list.findIndex((s) => s.name === name)
      if (i >= 0) list.splice(i, 1)
      for (const fn of listeners) fn()
    },
    onSamplesChanged: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

const rig = async () => {
  const store = new ProjectStore(new MemoryDb())
  const project = await store.createProject('tune', 'p(…)')
  const audio = fakeAudio()
  const errors: string[] = []
  const p = mountSamplePersistence({ audio, store, onError: (m) => errors.push(m) })
  await p.activate(project.id)
  return { store, project, audio, p, errors }
}
/** The watcher writes on a microtask queue; let it drain. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('per-project sample persistence', () => {
  it('survives a reload: a take loaded now is in the bank next time', async () => {
    const { store, project, audio, p } = await rig()
    audio.loadSamplePcm('take1', new Float32Array([0.1, -0.2, 0.3]), 48000)
    await settle()
    p.dispose()

    // a fresh tab: new bank, same store, same project
    const audio2 = fakeAudio()
    const p2 = mountSamplePersistence({ audio: audio2, store })
    await p2.activate(project.id)
    expect(audio2.getSamples().map((s) => s.name)).toEqual(['take1'])
    expect([...audio2.loadedSamples['take1']!.data]).toEqual([0.1, -0.2, 0.3].map((n) => Math.fround(n)))
    expect(audio2.loadedSamples['take1']!.sampleRate).toBe(48000)
  })

  it('does not re-write on restore what it just read', async () => {
    const { store, project, audio, p } = await rig()
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    p.dispose()
    const put = vi.spyOn(store, 'putSample')
    const p2 = mountSamplePersistence({ audio: fakeAudio(), store })
    await p2.activate(project.id)
    await settle()
    expect(put, 'restoring must not look like the user making a new take').not.toHaveBeenCalled()
  })

  it('forgets a sample the user removed', async () => {
    const { store, project, audio } = await rig()
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    expect(await store.listSamples(project.id)).toHaveLength(1)
    audio.removeSample('take1')
    await settle()
    expect(await store.listSamples(project.id)).toHaveLength(0)
  })

  it('keeps built-ins and baked sing() clips out of the store', async () => {
    const { store, project, audio } = await rig()
    audio.loadSamplePcm('break', new Float32Array([1]), 48000, true) // built-in
    audio.loadSamplePcm('singclipab12', new Float32Array([1]), 48000) // derived from code
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000) // the user's
    await settle()
    expect((await store.listSamples(project.id)).map((s) => s.name)).toEqual(['take1'])
  })

  it('writes a take to the project that was active when it was made', async () => {
    const { store, project, audio, p } = await rig()
    const other = await store.createProject('other', 'p(…)')
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    await p.activate(other.id)
    audio.loadSamplePcm('take2', new Float32Array([2]), 48000)
    await settle()
    expect((await store.listSamples(project.id)).map((s) => s.name)).toEqual(['take1'])
    expect((await store.listSamples(other.id)).map((s) => s.name)).toEqual(['take2'])
  })

  it('replaces a take by NAME when it is re-rendered', async () => {
    const { store, project, audio } = await rig()
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    audio.removeSample('take1')
    audio.loadSamplePcm('take1', new Float32Array([9, 9]), 48000)
    await settle()
    const rows = await store.listSamples(project.id)
    expect(rows, 'two rows would fight over one name').toHaveLength(1)
    expect([...rows[0]!.data]).toEqual([9, 9])
  })

  it('says so instead of losing the take when storage refuses', async () => {
    const { store, audio, errors } = await rig()
    vi.spyOn(store, 'putSample').mockRejectedValue(new Error('QuotaExceededError'))
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    expect(errors.join(' ')).toContain('QuotaExceededError')
  })

  it('deletes a project\'s samples with the project', async () => {
    const { store, project, audio } = await rig()
    audio.loadSamplePcm('take1', new Float32Array([1]), 48000)
    await settle()
    await store.deleteProject(project.id)
    expect(await store.listSamples(project.id), 'megabytes nobody can reach').toHaveLength(0)
  })
})
