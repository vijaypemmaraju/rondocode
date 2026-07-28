import { describe, expect, it } from 'vitest'
import { buildZip, crc32 } from '../src/editor/zip'

/* ------------------------------------------------------------------------- *
 * The stem export ships as one archive, so a malformed byte here means the
 * user's whole delivery fails to open with no error anywhere in the app. The
 * layout is pinned field by field, and every entry is read back out with an
 * independent reader (below) that walks the central directory the way a real
 * unzipper does.
 * ------------------------------------------------------------------------- */

const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, true)
const u16 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(at, true)

/** Read an archive through its central directory: name, bytes and stored CRC. */
const readZip = (zip: Uint8Array): { name: string; bytes: Uint8Array; crc: number }[] => {
  // end of central directory is the last 22 bytes (no archive comment)
  const eocd = zip.length - 22
  expect(u32(zip, eocd)).toBe(0x06054b50)
  const count = u16(zip, eocd + 10)
  let at = u32(zip, eocd + 16)
  const out: { name: string; bytes: Uint8Array; crc: number }[] = []
  for (let i = 0; i < count; i++) {
    expect(u32(zip, at)).toBe(0x02014b50)
    const crc = u32(zip, at + 16)
    const size = u32(zip, at + 24)
    const nameLen = u16(zip, at + 28)
    const localAt = u32(zip, at + 42)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen))
    expect(u32(zip, localAt)).toBe(0x04034b50)
    const dataAt = localAt + 30 + u16(zip, localAt + 26) + u16(zip, localAt + 28)
    out.push({ name, bytes: zip.subarray(dataAt, dataAt + size), crc })
    at += 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32)
  }
  return out
}

describe('crc32', () => {
  it('matches the known IEEE checksums', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926) // the standard check value
    expect(crc32(new Uint8Array(0))).toBe(0)
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43)
  })
})

describe('buildZip', () => {
  const files = [
    { name: 'take-stems/take-kick.wav', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    { name: 'take-stems/take-pad.wav', bytes: new Uint8Array(500).fill(7) },
    { name: 'take-stems/take-bus-space.wav', bytes: new Uint8Array(0) },
  ]

  it('round-trips every entry, name, byte and checksum', () => {
    const read = readZip(buildZip(files))
    expect(read.map((e) => e.name)).toEqual(files.map((f) => f.name))
    for (const [i, e] of read.entries()) {
      expect([...e.bytes]).toEqual([...files[i]!.bytes])
      expect(e.crc).toBe(crc32(files[i]!.bytes))
    }
  })

  it('stores entries uncompressed, flags UTF-8 names, and sizes the archive exactly', () => {
    const zip = buildZip(files)
    expect(u16(zip, 8)).toBe(0) // method 0 = stored, in the first local header
    expect(u16(zip, 6)).toBe(0x0800) // language-encoding (UTF-8) flag
    expect(u32(zip, 18)).toBe(u32(zip, 22)) // compressed size == uncompressed size
    const perEntry = files.reduce((a, f) => a + 30 + f.name.length + f.bytes.length + 46 + f.name.length, 0)
    expect(zip.length).toBe(perEntry + 22)
  })

  it('keeps non-ASCII names readable', () => {
    const read = readZip(buildZip([{ name: 'söngur/pað.wav', bytes: new Uint8Array([9]) }]))
    expect(read[0]!.name).toBe('söngur/pað.wav')
  })

  it('stamps the DOS date/time it is given', () => {
    const zip = buildZip(files, new Date(2026, 6, 27, 13, 45, 20)) // 2026-07-27 13:45:20
    expect(u16(zip, 10)).toBe((13 << 11) | (45 << 5) | 10) // seconds are stored in 2 s units
    expect(u16(zip, 12)).toBe(((2026 - 1980) << 9) | (7 << 5) | 27)
  })

  it('builds an empty archive rather than throwing', () => {
    const zip = buildZip([])
    expect(zip.length).toBe(22)
    expect(readZip(zip)).toEqual([])
  })
})
