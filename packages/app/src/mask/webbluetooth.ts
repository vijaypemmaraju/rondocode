/* ------------------------------------------------------------------------- *
 * Web Bluetooth as a MaskLink. Chromium only, and browser only: the desktop
 * shell's WKWebView has no navigator.bluetooth, so there the button says so
 * and does nothing else.
 *
 * requestDevice() has to run inside a user gesture (the chooser is the
 * browser's own dialog), which is why the header button's click handler calls
 * it directly rather than anything queued or awaited first.
 * ------------------------------------------------------------------------- */

import type { MaskLink } from './device'
import { MASK_CHAR_COMMAND, MASK_CHAR_NOTIFY, MASK_CHAR_RHYTHM, MASK_CHAR_UPLOAD, MASK_NAME_PREFIX, MASK_SERVICE } from './protocol'

export const hasWebBluetooth = (): boolean =>
  typeof navigator !== 'undefined' && navigator.bluetooth !== undefined

/** The browser's device chooser, filtered to masks. Rejects when the user
 *  cancels (a DOMException named NotFoundError). */
export function requestMaskDevice(): Promise<BluetoothDevice> {
  const bt = navigator.bluetooth
  if (bt === undefined) return Promise.reject(new Error('this browser has no Web Bluetooth'))
  return bt.requestDevice({
    filters: [{ namePrefix: MASK_NAME_PREFIX }, { services: [MASK_SERVICE] }],
    optionalServices: [MASK_SERVICE],
  })
}

/* ------------------------------------------------------------------------- *
 * RECONNECTING WITHOUT THE CHOOSER. A page reload drops the connection (the
 * BluetoothDevice object goes with the page), and the chooser needs a click,
 * so every reload used to cost one more pick. Chrome can hand back the
 * devices this origin was already allowed to use (getDevices, behind a flag
 * today), and a permitted device becomes connectable once it has been seen
 * advertising again (watchAdvertisements). Where either is missing the
 * answer is simply "no remembered mask" and the button works as before.
 *
 * Which one to reconnect to is a policy, not a guess: the mask connected
 * last time by id, or the only permitted mask. Two permitted masks and no
 * memory of which was used means asking, never picking one.
 * ------------------------------------------------------------------------- */

const MASK_DEVICE_KEY = 'rc.maskDevice'

/** The masks this origin was already allowed to use; [] where the browser
 *  cannot say (no getDevices, or it threw). Never opens a chooser. */
export async function rememberedMaskDevices(bt: Bluetooth | undefined = navigator.bluetooth): Promise<BluetoothDevice[]> {
  if (bt === undefined || typeof bt.getDevices !== 'function') return []
  try {
    const all = await bt.getDevices()
    return all.filter((d) => (d.name ?? '').startsWith(MASK_NAME_PREFIX))
  } catch {
    return []
  }
}

/** Which permitted mask to reconnect to: the one used last (by id) if it is
 *  still permitted, else the only one, else none. */
export function pickRememberedMask(devices: readonly BluetoothDevice[], lastId: string | null): BluetoothDevice | null {
  if (lastId !== null) {
    const same = devices.find((d) => d.id === lastId)
    if (same !== undefined) return same
  }
  return devices.length === 1 ? devices[0]! : null
}

export const recallMaskId = (): string | null => {
  try { return localStorage.getItem(MASK_DEVICE_KEY) } catch { return null }
}

export const rememberMaskId = (id: string | null): void => {
  try {
    if (id === null) localStorage.removeItem(MASK_DEVICE_KEY)
    else localStorage.setItem(MASK_DEVICE_KEY, id)
  } catch { /* private mode: the next load asks again */ }
}

/** Wait until a permitted device has been seen advertising, so gatt.connect()
 *  has something to connect to. Resolves at once on a browser without
 *  watchAdvertisements (the connect is then simply attempted). Rejects after
 *  `timeoutMs` with the watch cancelled, which is how "the mask is off" ends. */
export function waitForMaskInRange(dev: BluetoothDevice, timeoutMs: number): Promise<void> {
  if (typeof dev.watchAdvertisements !== 'function') return Promise.resolve()
  const ctl = new AbortController()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctl.abort()
      reject(new Error(`no advertisement from ${dev.name ?? 'the mask'} in ${timeoutMs} ms`))
    }, timeoutMs)
    dev.addEventListener('advertisementreceived', () => {
      clearTimeout(timer)
      ctl.abort() // one sighting is all the connect needs
      resolve()
    }, { once: true })
    dev.watchAdvertisements!({ signal: ctl.signal }).catch((e: unknown) => {
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

/** Connect to a chosen (or previously chosen) device and wire its
 *  characteristics up as a link. */
export async function openMaskLink(dev: BluetoothDevice): Promise<MaskLink> {
  if (dev.gatt === undefined) throw new Error('device has no GATT server')
  const server = await dev.gatt.connect()
  const svc = await server.getPrimaryService(MASK_SERVICE)
  const cmd = await svc.getCharacteristic(MASK_CHAR_COMMAND)
  const up = await svc.getCharacteristic(MASK_CHAR_UPLOAD)
  const notify = await svc.getCharacteristic(MASK_CHAR_NOTIFY)
  // the live spectrum; a firmware without it still gets pictures
  const rhythm = await svc.getCharacteristic(MASK_CHAR_RHYTHM).catch(() => null)
  const replyListeners = new Set<(bytes: Uint8Array) => void>()
  const closeListeners = new Set<() => void>()
  await notify.startNotifications()
  notify.addEventListener('characteristicvaluechanged', (e) => {
    const v = (e.target as BluetoothRemoteGATTCharacteristic).value
    if (v === undefined) return
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    for (const fn of replyListeners) fn(bytes)
  })
  dev.addEventListener('gattserverdisconnected', () => {
    for (const fn of closeListeners) fn()
  })
  return {
    name: dev.name ?? 'mask',
    writeCommand: (bytes) => cmd.writeValueWithResponse(bytes),
    writeUpload: (bytes) => up.writeValueWithResponse(bytes),
    writeRhythm: (bytes) =>
      rhythm === null ? Promise.reject(new Error('this mask has no live spectrum characteristic')) : rhythm.writeValueWithoutResponse(bytes),
    onReply: (fn) => {
      replyListeners.add(fn)
    },
    onDisconnect: (fn) => {
      closeListeners.add(fn)
    },
    disconnect: () => {
      if (server.connected) server.disconnect()
    },
  }
}
