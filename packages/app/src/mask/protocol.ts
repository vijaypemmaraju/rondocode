/* ------------------------------------------------------------------------- *
 * The Shining Mask wire protocol (the Bluetooth LED face masks sold under a
 * dozen brand names, advertising as `MASK-xxxxxx`), as verified on one.
 *
 * Everything the app knows about the device's bytes lives here, as pure
 * functions over Uint8Arrays. The transport (device.ts) only moves them.
 *
 * COMMANDS are one 16-byte block on the command characteristic:
 *   [len][ASCII name][args...] zero-padded, AES-128-ECB under MASK_KEY.
 * REPLIES arrive on the notify characteristic, encrypted the same way:
 *   `DATSOK`, `REOK`, `DATCPOK`, `PLAYOK`, ... followed by a counter byte.
 *
 * A DIY PICTURE is 46 x 58 pixels, RGB, 3 bytes each, no header: 8004 bytes.
 * It is stored COLUMN-MAJOR (58 pixels down one column, then the next) and
 * the first column is at the VIEWER'S RIGHT, so a row-major frame is packed
 * with x mirrored. Both facts were established by uploading test frames and
 * looking at the mask: a quadrant pattern for the layout, a letter F for the
 * mirror. It is uploaded in chunks of 98 bytes on the upload characteristic,
 * each `[chunkLen + 1][seq][bytes]`, after `DATS` (length, slot) and before
 * `DATCP`. The mask acknowledges EVERY chunk with `REOK`, and it means it:
 * fire the chunks without waiting and about half are dropped, leaving a slot
 * with a torn picture. Paced, a picture takes around five seconds, which is
 * why pictures are baked into slots ahead of time and switched between with
 * `PLAY`, never streamed.
 *
 * Single commands answer in 30 to 50 ms, so face and slot switches keep up
 * with a pattern.
 *
 * THE RHYTHM STREAM is the live path, on a characteristic of its own. It came
 * out of the official app's decompiled source (ConnectActivity.sendRhythmData
 * and VisualizerView): a 16-byte frame `[0x0F][mode][12 bytes][0][0]`,
 * encrypted like a command but with no command word and no reply. The mask
 * draws it at once with one of five built-in visualizers, chosen by `mode`
 * (0 bars mirrored from the centre with peak dots, 1 butterfly, 2 rainbow
 * columns, 3 rows from the centre, 4 hourglass), from 24 band levels of 0..9
 * packed two to a byte, high nibble first. It is written WITHOUT response:
 * measured, the mask took a hundred frames in a quarter of a second and
 * tracked a 20 fps sweep frame for frame, where the app itself sends ten a
 * second. There is no command to enter or leave the mode: the first frame
 * takes the panel over and any picture command (`PLAY`, `IMAG`, `ANIM`)
 * takes it back.
 * ------------------------------------------------------------------------- */

import { decryptBlock, encryptBlock } from './aes'
import { MASK_H, MASK_W } from './frame'
import type { MaskFrame } from './frame'

export { MASK_H, MASK_W }

/** The sound name that routes a pattern to the mask instead of the engine. */
export const MASK_SOUND = 'mask'

export const MASK_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb'
export const MASK_CHAR_COMMAND = 'd44bc439-abfd-45a2-b575-925416129600'
export const MASK_CHAR_NOTIFY = 'd44bc439-abfd-45a2-b575-925416129601'
export const MASK_CHAR_UPLOAD = 'd44bc439-abfd-45a2-b575-92541612960a'
/** The live spectrum: written without response, never answered. */
export const MASK_CHAR_RHYTHM = 'd44bc439-abfd-45a2-b575-92541612960b'
/** What the mask advertises as. */
export const MASK_NAME_PREFIX = 'MASK'

/** The one key every mask ships with. */
export const MASK_KEY = Uint8Array.from([
  0x32, 0x67, 0x2f, 0x79, 0x74, 0xad, 0x43, 0x45, 0x1d, 0x9c, 0x6c, 0x89, 0x4a, 0x0e, 0x87, 0x64,
])

/** Bytes in one uploaded picture. */
export const FRAME_BYTES = MASK_W * MASK_H * 3
/** Payload bytes per upload packet. */
export const UPLOAD_CHUNK = 98
/** Bands in one rhythm frame, and how high each goes. */
export const RHYTHM_BANDS = 24
export const RHYTHM_LEVEL_MAX = 9
/** The visualizers built into the mask are numbered 0..MASK_VIZ_MAX. */
export const MASK_VIZ_MAX = 4

const isByte = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 255

/** One encrypted command block. */
export function encodeCommand(name: string, args: readonly number[] = []): Uint8Array {
  if (!/^[A-Z]{1,8}$/.test(name)) throw new RangeError(`mask command name must be 1-8 capital letters, got ${JSON.stringify(name)}`)
  for (const a of args) if (!isByte(a)) throw new RangeError(`mask command ${name}: args must be bytes, got ${a}`)
  if (1 + name.length + args.length > 16) throw new RangeError(`mask command ${name}: too many args (${args.length})`)
  const block = new Uint8Array(16)
  block[0] = name.length + args.length
  for (let i = 0; i < name.length; i++) block[1 + i] = name.charCodeAt(i)
  block.set(args, 1 + name.length)
  return encryptBlock(MASK_KEY, block)
}

/** A reply, decrypted: the ASCII word the mask answered (`REOK`, `DATSOK`,
 *  ...) and the whole plaintext for anything else. */
export interface MaskReply {
  word: string
  plain: Uint8Array
}

/**
 * A reply is framed like a command, `[len][WORD]...`, and the LENGTH is the
 * only reliable edge of the word: the mask reuses its reply buffer, so the
 * bytes after a short word are whatever a longer reply left there. The chunk
 * ack after `DATSOK` decrypts to `[4]REOKOK\0\1\1...`; read greedily that is
 * "REOKOK", which is no ack at all, and every chunk counts as dropped.
 */
export function decodeReply(bytes: Uint8Array): MaskReply {
  if (bytes.length < 16) return { word: '', plain: Uint8Array.from(bytes) }
  const plain = decryptBlock(MASK_KEY, bytes.subarray(0, 16))
  const len = plain[0]!
  if (len < 1 || len > 15) return { word: '', plain }
  let word = ''
  for (let i = 1; i <= len; i++) {
    const b = plain[i]!
    if (b < 0x41 || b > 0x5a) return { word: '', plain }
    word += String.fromCharCode(b)
  }
  return { word, plain }
}

/** Brightness 0..255. */
export const cmdLight = (level: number): Uint8Array => encodeCommand('LIGHT', [clampByte(level)])
/** Show built-in picture n (the mask ships with at least 20). */
export const cmdImage = (n: number): Uint8Array => encodeCommand('IMAG', [clampByte(n)])
/** Show built-in animation n. */
export const cmdAnim = (n: number): Uint8Array => encodeCommand('ANIM', [clampByte(n)])
/** Show the DIY picture in slot n. */
export const cmdPlaySlot = (slot: number): Uint8Array => encodeCommand('PLAY', [1, clampByte(slot)])
/** Begin uploading `length` bytes into DIY slot `slot`. */
export const cmdUploadStart = (length: number, slot: number): Uint8Array => {
  if (!Number.isInteger(length) || length < 1 || length > 0xffff) throw new RangeError(`mask upload length out of range: ${length}`)
  return encodeCommand('DATS', [(length >> 8) & 0xff, length & 0xff, 0x00, clampByte(slot), 0x01])
}
/** Finish an upload. */
export const cmdUploadEnd = (): Uint8Array => encodeCommand('DATCP')

/** One rhythm frame: visualizer `mode` drawing `bands` (24 levels, 0..9). */
export function encodeRhythm(mode: number, bands: ArrayLike<number>): Uint8Array {
  if (!Number.isInteger(mode) || mode < 0 || mode > MASK_VIZ_MAX) throw new RangeError(`mask viz mode must be 0..${MASK_VIZ_MAX}, got ${mode}`)
  if (bands.length !== RHYTHM_BANDS) throw new RangeError(`mask rhythm frame takes ${RHYTHM_BANDS} bands, got ${bands.length}`)
  const block = new Uint8Array(16)
  block[0] = 0x0f
  block[1] = mode
  for (let i = 0; i < RHYTHM_BANDS; i++) {
    const v = bands[i]!
    if (!Number.isInteger(v) || v < 0 || v > RHYTHM_LEVEL_MAX) throw new RangeError(`mask rhythm band ${i} must be 0..${RHYTHM_LEVEL_MAX}, got ${v}`)
    const at = 2 + (i >> 1)
    block[at] = block[at]! | (i % 2 === 0 ? v << 4 : v)
  }
  return encryptBlock(MASK_KEY, block)
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(255, Math.round(v)))
}

/** Brightness as the program says it (0..1, like gain) → the mask's byte. */
export const lightByte = (gain: number): number => clampByte(gain * 255)

/** A row-major frame → the panel's bytes: column-major, x mirrored. */
export function packFrame(frame: MaskFrame): Uint8Array {
  if (frame.rgb.length !== FRAME_BYTES) throw new RangeError(`mask frame must be ${FRAME_BYTES} bytes, got ${frame.rgb.length}`)
  const out = new Uint8Array(FRAME_BYTES)
  for (let x = 0; x < MASK_W; x++) {
    const col = MASK_W - 1 - x // memory column 0 is the viewer's right edge
    for (let y = 0; y < MASK_H; y++) {
      const src = (y * MASK_W + x) * 3
      const dst = (col * MASK_H + y) * 3
      out[dst] = frame.rgb[src]!
      out[dst + 1] = frame.rgb[src + 1]!
      out[dst + 2] = frame.rgb[src + 2]!
    }
  }
  return out
}

/** Split packed bytes into upload packets, in order. */
export function uploadPackets(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let seq = 0
  for (let off = 0; off < bytes.length; off += UPLOAD_CHUNK, seq++) {
    const chunk = bytes.subarray(off, Math.min(off + UPLOAD_CHUNK, bytes.length))
    const pkt = new Uint8Array(chunk.length + 2)
    pkt[0] = chunk.length + 1
    pkt[1] = seq & 0xff
    pkt.set(chunk, 2)
    out.push(pkt)
  }
  return out
}
