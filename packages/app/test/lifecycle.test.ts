import { afterEach, describe, expect, it } from 'vitest'
import { ModelSlot, runStages, SING_STAGE_ORDER, type SingStage } from '../src/sing/lifecycle'
import { sequentialSingSessions } from '../src/sing/config'

/* Sequential session lifecycle on constrained devices (see lifecycle.ts):
 * every sing module holds its ORT sessions in a ModelSlot instead of a bare
 * module singleton, and the bake drives the stages through runStages so that
 * on phones each stage's sessions are disposed before the next stage loads -
 * peak session memory becomes the largest single stage, not the sum. */

describe('ModelSlot', () => {
  it('loads once and shares the value across callers', async () => {
    let creates = 0
    const slot = new ModelSlot<string>(() => undefined)
    const load = (): Promise<string> => slot.load(async () => `v${++creates}`)
    expect(await Promise.all([load(), load()])).toEqual(['v1', 'v1'])
    expect(await load()).toBe('v1')
    expect(creates).toBe(1)
    expect(slot.get()).toBe('v1')
  })

  it('get() is null before load and after dispose', async () => {
    const slot = new ModelSlot<string>(() => undefined)
    expect(slot.get()).toBeNull()
    await slot.load(async () => 'v')
    await slot.dispose()
    expect(slot.get()).toBeNull()
  })

  it('dispose releases the value and resets so the next load starts clean', async () => {
    const released: string[] = []
    let creates = 0
    const slot = new ModelSlot<string>((v) => void released.push(v))
    await slot.load(async () => `v${++creates}`)
    await slot.dispose()
    expect(released).toEqual(['v1'])
    expect(await slot.load(async () => `v${++creates}`)).toBe('v2')
    expect(creates).toBe(2)
  })

  it('dispose is callable twice safely (second call releases nothing)', async () => {
    const released: string[] = []
    const slot = new ModelSlot<string>((v) => void released.push(v))
    await slot.load(async () => 'v')
    await slot.dispose()
    await slot.dispose()
    expect(released).toEqual(['v'])
  })

  it('dispose with nothing loaded is a no-op', async () => {
    const slot = new ModelSlot<string>(() => {
      throw new Error('must not release')
    })
    await expect(slot.dispose()).resolves.toBeUndefined()
  })

  it('dispose mid-load awaits the pending load and releases it (nothing left pinned)', async () => {
    const released: string[] = []
    let resolve!: (v: string) => void
    const slot = new ModelSlot<string>((v) => void released.push(v))
    const loading = slot.load(() => new Promise<string>((r) => (resolve = r)))
    const disposing = slot.dispose()
    resolve('v1')
    await loading
    await disposing
    expect(released).toEqual(['v1'])
    expect(slot.get()).toBeNull()
    // and a later load starts a FRESH create
    expect(await slot.load(async () => 'v2')).toBe('v2')
  })

  it('a failed load resets the loading state so the next call retries', async () => {
    let creates = 0
    const slot = new ModelSlot<string>(() => undefined)
    await expect(
      slot.load(async () => {
        creates++
        throw new Error('download died')
      }),
    ).rejects.toThrow('download died')
    expect(await slot.load(async () => `v${++creates}`)).toBe('v2')
  })

  it('dispose while a load is FAILING neither throws nor releases', async () => {
    const slot = new ModelSlot<string>(() => {
      throw new Error('must not release')
    })
    let reject!: (e: Error) => void
    const loading = slot.load(() => new Promise<string>((_, rj) => (reject = rj)))
    loading.catch(() => undefined) // observed; the interesting path is dispose
    const disposing = slot.dispose()
    reject(new Error('boom'))
    await expect(disposing).resolves.toBeUndefined()
  })

  it('a throwing release does not break dispose', async () => {
    const slot = new ModelSlot<string>(() => {
      throw new Error('release exploded')
    })
    await slot.load(async () => 'v')
    await expect(slot.dispose()).resolves.toBeUndefined()
  })
})

describe('runStages', () => {
  const mkStages = (log: string[], failIn?: string): SingStage[] =>
    SING_STAGE_ORDER.map((name) => ({
      name,
      run: async () => {
        log.push(`run:${name}`)
        if (name === failIn) throw new Error(`${name} died`)
      },
      dispose: () => {
        log.push(`dispose:${name}`)
      },
    }))

  it('pins the constrained-device order: each stage disposed before the next runs', async () => {
    const log: string[] = []
    await runStages(mkStages(log), true)
    expect(log).toEqual(['run:tts', 'dispose:tts', 'run:align', 'dispose:align', 'run:rvc', 'dispose:rvc'])
  })

  it('never disposes on desktop (singletons persist across bakes)', async () => {
    const log: string[] = []
    await runStages(mkStages(log), false)
    expect(log).toEqual(['run:tts', 'run:align', 'run:rvc'])
  })

  it('an error mid-bake still disposes the failing stage, and earlier stages are already gone', async () => {
    const log: string[] = []
    await expect(runStages(mkStages(log, 'align'), true)).rejects.toThrow('align died')
    // tts fully torn down, align disposed via finally, rvc never touched
    expect(log).toEqual(['run:tts', 'dispose:tts', 'run:align', 'dispose:align'])
  })

  it('the stage order constant is the pipeline order', () => {
    expect([...SING_STAGE_ORDER]).toEqual(['tts', 'align', 'rvc'])
  })
})

describe('sequentialSingSessions', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('is false in a plain node environment (no iOS UA, no flag)', () => {
    expect(sequentialSingSessions()).toBe(false)
  })

  it('the rc.singSequential opt-in flag turns it on anywhere (desktop testing)', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (k === 'rc.singSequential' ? '1' : null),
    }
    expect(sequentialSingSessions()).toBe(true)
  })

  it('a throwing localStorage falls back to the UA check', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(sequentialSingSessions()).toBe(false)
  })
})
