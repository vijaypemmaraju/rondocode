import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pickRememberedMask, recallMaskId, rememberMaskId, rememberedMaskDevices, waitForMaskInRange,
} from '../src/mask/webbluetooth'
import { MASK_NAME_PREFIX } from '../src/mask/protocol'

/* ------------------------------------------------------------------------- *
 * RECONNECTING WITHOUT THE CHOOSER. A reload used to cost a pick in the
 * browser's device dialog every time. The reconnect asks the browser for the
 * devices this origin already has, picks by policy (last used, else the only
 * one, else nobody), waits to see the mask advertise, then connects. Each of
 * those is a case here, against fakes of the slice of Web Bluetooth involved;
 * the default Chrome, which has none of it, must come out as "no remembered
 * mask", not as an exception on load.
 * ------------------------------------------------------------------------- */

const fakeDevice = (id: string, name: string | undefined, watch?: (o: { signal?: AbortSignal }) => Promise<void>): BluetoothDevice => {
  const d = new EventTarget() as BluetoothDevice & { id: string; name?: string; watchAdvertisements?: typeof watch }
  d.id = id
  d.name = name
  if (watch !== undefined) d.watchAdvertisements = watch
  return d
}

const mask = (id: string, watch?: (o: { signal?: AbortSignal }) => Promise<void>): BluetoothDevice =>
  fakeDevice(id, `${MASK_NAME_PREFIX}${id}`, watch)

describe('rememberedMaskDevices: what the browser will name without a chooser', () => {
  it('is empty where there is no Web Bluetooth, and where getDevices is missing (Chrome by default)', async () => {
    expect(await rememberedMaskDevices(undefined)).toEqual([])
    const bare = { requestDevice: () => Promise.reject(new Error('no chooser here')) } as Bluetooth
    expect(await rememberedMaskDevices(bare)).toEqual([])
  })

  it('keeps only the masks among the permitted devices, by name prefix', async () => {
    const m1 = mask('1')
    const m2 = mask('2')
    const bt = {
      requestDevice: () => Promise.reject(new Error('no chooser here')),
      getDevices: () => Promise.resolve([fakeDevice('h', 'HeartRate-9'), m1, fakeDevice('x', undefined), m2]),
    } as Bluetooth
    expect(await rememberedMaskDevices(bt)).toEqual([m1, m2])
  })

  it('a getDevices that throws is the same as none', async () => {
    const bt = {
      requestDevice: () => Promise.reject(new Error('no chooser here')),
      getDevices: () => Promise.reject(new DOMException('nope', 'SecurityError')),
    } as Bluetooth
    expect(await rememberedMaskDevices(bt)).toEqual([])
  })
})

describe('pickRememberedMask: a policy, not a guess', () => {
  const a = mask('a')
  const b = mask('b')

  it('the mask used last time wins when it is still permitted', () => {
    expect(pickRememberedMask([a, b], 'b')).toBe(b)
  })

  it('the only permitted mask is taken even with no memory, or a stale one', () => {
    expect(pickRememberedMask([a], null)).toBe(a)
    expect(pickRememberedMask([a], 'gone')).toBe(a)
  })

  it('two masks and no usable memory means nobody: that is the chooser again', () => {
    expect(pickRememberedMask([a, b], null)).toBeNull()
    expect(pickRememberedMask([a, b], 'gone')).toBeNull()
    expect(pickRememberedMask([], 'a')).toBeNull()
  })
})

describe('waitForMaskInRange: a permitted device is connectable once seen advertising', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has nothing to wait for on a browser without watchAdvertisements', async () => {
    await expect(waitForMaskInRange(mask('a'), 10)).resolves.toBeUndefined()
  })

  it('resolves on the first advertisement and stops the watch', async () => {
    let signal: AbortSignal | undefined
    const dev = mask('a', (o) => {
      signal = o.signal
      return Promise.resolve()
    })
    const p = waitForMaskInRange(dev, 1000)
    expect(signal?.aborted).toBe(false)
    dev.dispatchEvent(new Event('advertisementreceived'))
    await expect(p).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
  })

  it('gives up after the timeout with the watch cancelled: how "the mask is off" ends', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const dev = mask('a', (o) => {
      signal = o.signal
      return Promise.resolve()
    })
    const p = waitForMaskInRange(dev, 4000)
    const settled = p.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(3999)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe(`no advertisement from ${dev.name} in 4000 ms`)
    expect(signal?.aborted).toBe(true)
  })

  it('a watch the browser refuses is a rejection, not a hang until the timeout', async () => {
    vi.useFakeTimers()
    const dev = mask('a', () => Promise.reject(new DOMException('not allowed', 'NotAllowedError')))
    await expect(waitForMaskInRange(dev, 4000)).rejects.toThrow(/not allowed/)
    expect(vi.getTimerCount()).toBe(0) // the timer was cleared, nothing left ticking
  })
})

describe('the remembered id', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips through localStorage and clears on null', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    })
    expect(recallMaskId()).toBeNull()
    rememberMaskId('abc')
    expect(recallMaskId()).toBe('abc')
    rememberMaskId(null)
    expect(recallMaskId()).toBeNull()
  })

  it('no storage at all (private mode, a throwing accessor) is "nothing remembered", never a throw', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError') },
      setItem: () => { throw new DOMException('denied', 'SecurityError') },
      removeItem: () => { throw new DOMException('denied', 'SecurityError') },
    })
    expect(recallMaskId()).toBeNull()
    expect(() => rememberMaskId('abc')).not.toThrow()
  })
})
