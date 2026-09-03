import { createCipheriv, createDecipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptBlock, encryptBlock } from '../src/mask/aes'
import { MASK_H, MASK_SLOT_MAX, MASK_SLOT_MIN, MASK_W, colorBytes, paintFrame, sameFrame } from '../src/mask/frame'
import {
  FRAME_BYTES,
  MASK_CHAR_RHYTHM,
  MASK_KEY,
  MASK_VIZ_MAX,
  RHYTHM_BANDS,
  RHYTHM_LEVEL_MAX,
  UPLOAD_CHUNK,
  cmdAnim,
  cmdImage,
  cmdLight,
  cmdPlaySlot,
  cmdUploadEnd,
  cmdUploadStart,
  decodeReply,
  encodeCommand,
  encodeRhythm,
  lightByte,
  packFrame,
  uploadPackets,
} from '../src/mask/protocol'

/* The LED mask's bytes. Every constant here was established against the
 * device: the three command ciphertexts were what unlocked it, the frame
 * layout came from uploading test patterns and reading the panel. A test
 * that pins them is what stops a refactor from quietly re-breaking a
 * protocol that took an evening of squinting at LEDs to read. */

const hex = (u8: Uint8Array): string => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))

/** node's AES, as the oracle our hand-rolled block cipher has to agree with */
const oracleEncrypt = (block: Uint8Array): Uint8Array =>
  Uint8Array.from(createCipheriv('aes-128-ecb', MASK_KEY, null).setAutoPadding(false).update(block))
const oracleDecrypt = (block: Uint8Array): Uint8Array =>
  Uint8Array.from(createDecipheriv('aes-128-ecb', MASK_KEY, null).setAutoPadding(false).update(block))

describe('AES-128 block', () => {
  it('matches the ciphertexts the mask accepted', () => {
    // MODE 1, MODE 2, DATCP: recorded from the working probe session
    expect(hex(encryptBlock(MASK_KEY, unhex('054d4f44450103bdc6d53bc7150f06a8')))).toBe('063bd99a997d030604917ce5285f7aba')
    expect(hex(encryptBlock(MASK_KEY, unhex('054d4f444502dd80fd1cb279fd43ede6')))).toBe('9a71b04fbd0aa02d594d6369ea996578')
    expect(hex(encryptBlock(MASK_KEY, unhex('05444154435000000000000000000000')))).toBe('e799ad01aa48ae0aee0b7203e8ede520')
  })

  it('agrees with node crypto in both directions on random blocks', () => {
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed & 0xff
    }
    for (let i = 0; i < 64; i++) {
      const block = Uint8Array.from({ length: 16 }, rnd)
      const ct = encryptBlock(MASK_KEY, block)
      expect(hex(ct)).toBe(hex(oracleEncrypt(block)))
      expect(hex(decryptBlock(MASK_KEY, ct))).toBe(hex(block))
      expect(hex(decryptBlock(MASK_KEY, block))).toBe(hex(oracleDecrypt(block)))
    }
  })

  it('refuses the wrong sizes rather than reading past them', () => {
    expect(() => encryptBlock(MASK_KEY, new Uint8Array(15))).toThrow(/16 bytes/)
    expect(() => encryptBlock(new Uint8Array(8), new Uint8Array(16))).toThrow(/key/)
  })
})

describe('commands', () => {
  const plain = (bytes: Uint8Array): Uint8Array => decryptBlock(MASK_KEY, bytes)

  it('frames [len][ASCII][args] zero-padded before encrypting', () => {
    expect(hex(plain(encodeCommand('MODE', [1])))).toBe('054d4f44450100000000000000000000')
    expect(hex(encodeCommand('DATCP'))).toBe('e799ad01aa48ae0aee0b7203e8ede520')
  })

  it('builds each command the app sends', () => {
    expect(hex(plain(cmdLight(255)))).toBe(hex(plain(encodeCommand('LIGHT', [255]))))
    expect([...plain(cmdImage(7)).subarray(0, 6)]).toEqual([5, 0x49, 0x4d, 0x41, 0x47, 7])
    expect([...plain(cmdAnim(3)).subarray(0, 6)]).toEqual([5, 0x41, 0x4e, 0x49, 0x4d, 3])
    // PLAY 01 n: the 01 is the DIY kind, n the slot
    expect([...plain(cmdPlaySlot(2)).subarray(0, 7)]).toEqual([6, 0x50, 0x4c, 0x41, 0x59, 1, 2])
    // DATS lenHi lenLo 00 slot 01 for a full picture into slot 2
    expect([...plain(cmdUploadStart(8004, 2)).subarray(0, 10)]).toEqual([9, 0x44, 0x41, 0x54, 0x53, 0x1f, 0x44, 0, 2, 1])
    expect(hex(cmdUploadEnd())).toBe('e799ad01aa48ae0aee0b7203e8ede520')
  })

  it('clamps out-of-range values to a byte instead of wrapping', () => {
    expect(plain(cmdLight(999))[6]).toBe(255)
    expect(plain(cmdLight(-4))[6]).toBe(0)
    expect(plain(cmdLight(NaN))[6]).toBe(0)
    expect(lightByte(1)).toBe(255)
    expect(lightByte(0.5)).toBe(128)
    expect(lightByte(3)).toBe(255)
  })

  it('rejects a command that cannot fit a block', () => {
    expect(() => encodeCommand('dats')).toThrow(/capital/)
    expect(() => encodeCommand('DATS', [256])).toThrow(/bytes/)
    expect(() => encodeCommand('ABCDEFGH', new Array(8).fill(0))).toThrow(/too many/)
    expect(() => cmdUploadStart(70000, 1)).toThrow(/length/)
  })

  it('reads the word out of an encrypted reply', () => {
    // a reply is [wordLen][WORD]... encrypted like a command, with a counter
    // in the last byte
    const reply = (word: string, tail: number[] = []): Uint8Array => {
      const b = new Uint8Array(16)
      b[0] = word.length
      for (let i = 0; i < word.length; i++) b[1 + i] = word.charCodeAt(i)
      b.set(tail, 1 + word.length)
      b[15] = 1
      return oracleEncrypt(b)
    }
    expect(decodeReply(reply('REOK')).word).toBe('REOK')
    expect(decodeReply(reply('DATSOK', [0, 1, 1])).word).toBe('DATSOK')
    expect(decodeReply(reply('DATCPOK')).word).toBe('DATCPOK')
    // too short to be a block: not a reply we understand, but not a crash
    expect(decodeReply(new Uint8Array(3)).word).toBe('')
  })

  it('takes exactly the length byte of word: the mask leaves an earlier, longer reply behind it', () => {
    // seen on the device: the chunk ack after DATSOK is [4,R,E,O,K,O,K,0,1,1,...]
    // where the "OK,0,1,1" is DATSOK's tail. Read greedily that is "REOKOK",
    // which is no ack at all, and every chunk counts as dropped
    const b = new Uint8Array(16)
    b.set([4, 0x52, 0x45, 0x4f, 0x4b, 0x4f, 0x4b, 0, 1, 1, 0, 0, 0, 0, 0, 2])
    expect(decodeReply(oracleEncrypt(b)).word).toBe('REOK')
    // a length that does not point at capitals is not a word
    const junk = new Uint8Array(16)
    junk.set([3, 0x52, 0x00, 0x4b])
    expect(decodeReply(oracleEncrypt(junk)).word).toBe('')
    const tooLong = new Uint8Array(16)
    tooLong[0] = 40
    expect(decodeReply(oracleEncrypt(tooLong)).word).toBe('')
  })
})

describe('rhythm stream', () => {
  const plain = (bytes: Uint8Array): Uint8Array => decryptBlock(MASK_KEY, bytes)

  it('is its own characteristic, next to the upload one', () => {
    expect(MASK_CHAR_RHYTHM).toBe('d44bc439-abfd-45a2-b575-92541612960b')
  })

  it('packs [0x0F][mode][24 bands as nibbles, high first][0 0]', () => {
    // the packet the official app builds (ConnectActivity.sendRhythmData):
    // no command word, 15 is the frame tag, then the visualizer mode, then
    // two bands per byte
    const bands = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 9, 9, 0]
    expect(hex(plain(encodeRhythm(3, bands)))).toBe('0f03' + '123456789098765432100990' + '0000')
    // encrypted like everything else on the radio
    const b = new Uint8Array(16)
    b.set([15, 0, 0x90], 0)
    expect(hex(encodeRhythm(0, [9, 0, ...new Array(22).fill(0)]))).toBe(hex(oracleEncrypt(b)))
  })

  it('refuses what the mask would misread rather than wrapping it', () => {
    const zeros = new Array<number>(RHYTHM_BANDS).fill(0)
    expect(() => encodeRhythm(5, zeros)).toThrow(/mode/)
    expect(() => encodeRhythm(-1, zeros)).toThrow(/mode/)
    expect(() => encodeRhythm(1.5, zeros)).toThrow(/mode/)
    expect(() => encodeRhythm(0, zeros.slice(1))).toThrow(/24/)
    expect(() => encodeRhythm(0, [10, ...zeros.slice(1)])).toThrow(/0\.\.9/)
    expect(() => encodeRhythm(0, [2.5, ...zeros.slice(1)])).toThrow(/0\.\.9/)
    expect(RHYTHM_BANDS).toBe(24)
    expect(RHYTHM_LEVEL_MAX).toBe(9)
    expect(MASK_VIZ_MAX).toBe(4)
  })
})

describe('frames', () => {
  it('paints row-major RGB from any colour spelling', () => {
    const f = paintFrame((x, y) => (x === 0 && y === 0 ? '#f00' : x === 1 && y === 0 ? [0, 1, 0] : x === 2 && y === 0 ? 0.5 : null))
    expect(f.rgb.length).toBe(FRAME_BYTES)
    expect([...f.rgb.subarray(0, 9)]).toEqual([255, 0, 0, 0, 255, 0, 128, 128, 128])
    expect([...f.rgb.subarray(9, 12)]).toEqual([0, 0, 0])
    expect(colorBytes('#0080ff')).toEqual([0, 128, 255])
    expect(colorBytes(2)).toEqual([255, 255, 255])
    expect(colorBytes(false)).toEqual([0, 0, 0])
  })

  it('names the pixel when a painter answers nonsense', () => {
    expect(() => paintFrame((x, y) => (x === 3 && y === 4 ? 'red' : 0))).toThrow(/at \(3, 4\).*#rgb/)
    expect(() => paintFrame(() => ({}) as unknown as number)).toThrow(/grey 0\.\.1/)
  })

  it('packs column-major with x mirrored, which is how the panel is wired', () => {
    // one red pixel at the viewer's top-left
    const f = paintFrame((x, y) => (x === 0 && y === 0 ? '#f00' : null))
    const packed = packFrame(f)
    // the panel's first stored column is the viewer's RIGHT edge, so x = 0
    // lands in the LAST column: (45 * 58 + 0) * 3
    const at = (MASK_W - 1) * MASK_H * 3
    expect([...packed.subarray(at, at + 3)]).toEqual([255, 0, 0])
    expect(packed.reduce((n, b) => n + b, 0)).toBe(255) // and nowhere else
    // second row of the same column is the next 3 bytes: columns run top to bottom
    const g = packFrame(paintFrame((x, y) => (x === 0 && y === 1 ? '#0f0' : null)))
    expect([...g.subarray(at + 3, at + 6)]).toEqual([0, 255, 0])
    // the viewer's right edge is stored first
    const h = packFrame(paintFrame((x, y) => (x === MASK_W - 1 && y === 0 ? '#00f' : null)))
    expect([...h.subarray(0, 3)]).toEqual([0, 0, 255])
  })

  it('splits a picture into 82 acknowledged packets of [len+1][seq][bytes]', () => {
    const packed = new Uint8Array(FRAME_BYTES).map((_, i) => i & 0xff)
    const pkts = uploadPackets(packed)
    expect(pkts.length).toBe(82) // 81 x 98 + 66
    expect(pkts[0]![0]).toBe(UPLOAD_CHUNK + 1)
    expect(pkts[0]![1]).toBe(0)
    expect([...pkts[0]!.subarray(2, 5)]).toEqual([0, 1, 2])
    expect(pkts[81]![0]).toBe(66 + 1)
    expect(pkts[81]![1]).toBe(81)
    expect(pkts[81]!.length).toBe(68)
    // everything is carried exactly once, in order
    const joined = new Uint8Array(FRAME_BYTES)
    let off = 0
    for (const p of pkts) {
      joined.set(p.subarray(2), off)
      off += p.length - 2
    }
    expect(hex(joined)).toBe(hex(packed))
  })

  it('compares frames by content and refuses a wrong-sized one', () => {
    const a = paintFrame(() => 0.2)
    const b = paintFrame(() => 0.2)
    const c = paintFrame((x) => (x === 5 ? 0.3 : 0.2))
    expect(sameFrame(a, b)).toBe(true)
    expect(sameFrame(a, c)).toBe(false)
    expect(() => packFrame({ width: MASK_W, height: MASK_H, rgb: new Uint8Array(10) })).toThrow(/8004/)
    expect(MASK_SLOT_MIN).toBe(1)
    expect(MASK_SLOT_MAX).toBeGreaterThanOrEqual(2) // slots 1 and 2 were seen coexisting
  })
})
