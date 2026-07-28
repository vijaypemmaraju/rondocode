/* ------------------------------------------------------------------------- *
 * A minimal ZIP writer: store-only (no compression), no dependencies.
 *
 * Why a ZIP at all: a browser cannot write a FOLDER, and a stem export is
 * inherently many files. Firing N sequential downloads works but asks the
 * user to approve a "download multiple files" prompt, drops files if that
 * prompt is dismissed, and scatters nine WAVs into Downloads with no
 * grouping. One archive is a single click, arrives whole or not at all, and
 * unzips into a folder named after the project.
 *
 * Store-only is deliberate: WAV audio is already dense, deflate would buy a
 * few percent for a lot of CPU on the main thread, and every unzipper reads
 * stored entries.
 * ------------------------------------------------------------------------- */

export interface ZipEntry {
  /** File name inside the archive; may contain '/' for a folder. */
  name: string
  bytes: Uint8Array
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time pair (the only timestamp a plain ZIP entry carries). */
const dosStamp = (d: Date): { time: number; date: number } => ({
  time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
  date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
})

/** UTF-8 bytes of a file name, plus the flag bit that declares the encoding. */
const encodeName = (name: string): Uint8Array => new TextEncoder().encode(name)

/**
 * Build a ZIP archive from `entries`, stored uncompressed.
 *
 * `date` stamps every entry (default: now). Names are written as UTF-8 with
 * the language-encoding flag set, so non-ASCII project names survive.
 * Throws past 4 GB, where the format would need ZIP64.
 */
export function buildZip(entries: ZipEntry[], date: Date = new Date()): Uint8Array {
  const stamp = dosStamp(date)
  const names = entries.map((e) => encodeName(e.name))
  const total =
    entries.reduce((a, e, i) => a + 30 + names[i]!.length + e.bytes.length + 46 + names[i]!.length, 0) + 22
  if (total > 0xffffffff) throw new RangeError('buildZip: archive would exceed 4 GB (ZIP64 not supported)')
  if (entries.length > 0xffff) throw new RangeError('buildZip: too many entries (ZIP64 not supported)')
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let at = 0
  const u16 = (v: number): void => {
    dv.setUint16(at, v, true)
    at += 2
  }
  const u32 = (v: number): void => {
    dv.setUint32(at, v >>> 0, true)
    at += 4
  }
  const raw = (b: Uint8Array): void => {
    out.set(b, at)
    at += b.length
  }

  const offsets: number[] = []
  const crcs: number[] = []
  entries.forEach((e, i) => {
    offsets.push(at)
    crcs.push(crc32(e.bytes))
    u32(0x04034b50) // local file header
    u16(20) // version needed
    u16(0x0800) // flags: UTF-8 names
    u16(0) // method: stored
    u16(stamp.time)
    u16(stamp.date)
    u32(crcs[i]!)
    u32(e.bytes.length)
    u32(e.bytes.length)
    u16(names[i]!.length)
    u16(0) // extra length
    raw(names[i]!)
    raw(e.bytes)
  })

  const cdStart = at
  entries.forEach((e, i) => {
    u32(0x02014b50) // central directory header
    u16(20) // version made by
    u16(20) // version needed
    u16(0x0800)
    u16(0)
    u16(stamp.time)
    u16(stamp.date)
    u32(crcs[i]!)
    u32(e.bytes.length)
    u32(e.bytes.length)
    u16(names[i]!.length)
    u16(0) // extra
    u16(0) // comment
    u16(0) // disk number
    u16(0) // internal attrs
    u32(0) // external attrs
    u32(offsets[i]!)
    raw(names[i]!)
  })

  const cdSize = at - cdStart // captured BEFORE the trailer moves the cursor
  u32(0x06054b50) // end of central directory
  u16(0) // this disk
  u16(0) // disk with the central directory
  u16(entries.length)
  u16(entries.length)
  u32(cdSize)
  u32(cdStart)
  u16(0) // comment length
  return out
}
