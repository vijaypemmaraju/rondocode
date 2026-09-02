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
import { MASK_CHAR_COMMAND, MASK_CHAR_NOTIFY, MASK_CHAR_UPLOAD, MASK_NAME_PREFIX, MASK_SERVICE } from './protocol'

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

/** Connect to a chosen (or previously chosen) device and wire its
 *  characteristics up as a link. */
export async function openMaskLink(dev: BluetoothDevice): Promise<MaskLink> {
  if (dev.gatt === undefined) throw new Error('device has no GATT server')
  const server = await dev.gatt.connect()
  const svc = await server.getPrimaryService(MASK_SERVICE)
  const cmd = await svc.getCharacteristic(MASK_CHAR_COMMAND)
  const up = await svc.getCharacteristic(MASK_CHAR_UPLOAD)
  const notify = await svc.getCharacteristic(MASK_CHAR_NOTIFY)
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
