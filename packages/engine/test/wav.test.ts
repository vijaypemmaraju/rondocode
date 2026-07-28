import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav, encodeWav16, wavBitsLabel } from '../src/wav'
import type { WavBits } from '../src/wav'

const ascii = (b: Uint8Array, from: number, len: number): string =>
  String.fromCharCode(...b.subarray(from, from + len))

describe('encodeWav16', () => {
  it('writes a valid 44-byte RIFF/WAVE header for 16-bit stereo PCM', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1])
    const right = new Float32Array([1, -1, 0.25, 0])
    const wav = encodeWav16(left, right, 48000)
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const dataSize = 4 * 2 * 2 // frames * channels * bytes
    expect(wav.byteLength).toBe(44 + dataSize)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(dv.getUint32(4, true)).toBe(36 + dataSize)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(dv.getUint32(16, true)).toBe(16) // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1) // PCM
    expect(dv.getUint16(22, true)).toBe(2) // stereo
    expect(dv.getUint32(24, true)).toBe(48000)
    expect(dv.getUint32(28, true)).toBe(48000 * 4) // byte rate
    expect(dv.getUint16(32, true)).toBe(4) // block align
    expect(dv.getUint16(34, true)).toBe(16) // bits per sample
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(dataSize)
  })

  it('interleaves L/R and quantizes to 16-bit with clamping at ±1', () => {
    const left = new Float32Array([0, 0.5, -0.5, 2])
    const right = new Float32Array([1, -1, 0.25, -2])
    const wav = encodeWav16(left, right, 44100)
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    const sample = (frame: number, ch: 0 | 1): number =>
      dv.getInt16(44 + frame * 4 + ch * 2, true)
    expect(sample(0, 0)).toBe(0)
    expect(sample(0, 1)).toBe(32767)
    expect(sample(1, 0)).toBe(Math.round(0.5 * 32767))
    expect(sample(1, 1)).toBe(-32767)
    expect(sample(2, 0)).toBe(Math.round(-0.5 * 32767))
    expect(sample(2, 1)).toBe(Math.round(0.25 * 32767))
    expect(sample(3, 0)).toBe(32767) // clamped from 2
    expect(sample(3, 1)).toBe(-32767) // clamped from -2
  })

  it('rejects mismatched channel lengths and bad sample rates', () => {
    expect(() =>
      encodeWav16(new Float32Array(2), new Float32Array(3), 48000),
    ).toThrowError(/length/)
    expect(() => encodeWav16(new Float32Array(2), new Float32Array(2), 0)).toThrow()
    expect(() => encodeWav16(new Float32Array(2), new Float32Array(2), 44100.5)).toThrow()
  })

  it('is byte-identical to encodeWav at its default depth (one writer, one layout)', () => {
    const left = new Float32Array([0, 0.5, -0.5, 1])
    const right = new Float32Array([1, -1, 0.25, 0])
    expect([...encodeWav16(left, right, 48000)]).toEqual([...encodeWav(left, right, 48000, { bits: 16 })])
    expect([...encodeWav(left, right, 48000)]).toEqual([...encodeWav16(left, right, 48000)])
  })
})

/* The professional depths. A wrong fmt chunk does not error anywhere: the
 * file just opens as noise (or not at all) in the DAW it was delivered to,
 * so every header field is pinned byte-exactly, and the sample bytes of a
 * KNOWN value are pinned too (24-bit packing is hand-rolled). */
describe('encodeWav depths', () => {
  const header = (wav: Uint8Array) => new DataView(wav.buffer, wav.byteOffset, wav.byteLength)

  it.each([
    { bits: 16 as WavBits, format: 1, blockAlign: 4 },
    { bits: 24 as WavBits, format: 1, blockAlign: 6 },
    { bits: 32 as WavBits, format: 3, blockAlign: 8 },
  ])('writes a canonical 44-byte header for $bits-bit', ({ bits, format, blockAlign }) => {
    const frames = 5
    const wav = encodeWav(new Float32Array(frames), new Float32Array(frames), 44100, { bits })
    const dv = header(wav)
    const dataSize = frames * blockAlign
    expect(wav.byteLength).toBe(44 + dataSize)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(dv.getUint32(4, true)).toBe(36 + dataSize)
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(dv.getUint32(16, true)).toBe(16) // plain 16-byte fmt, no cbSize/extensible
    expect(dv.getUint16(20, true)).toBe(format) // 1 = PCM, 3 = IEEE float
    expect(dv.getUint16(22, true)).toBe(2) // stereo
    expect(dv.getUint32(24, true)).toBe(44100)
    expect(dv.getUint32(28, true)).toBe(44100 * blockAlign) // byte rate
    expect(dv.getUint16(32, true)).toBe(blockAlign)
    expect(dv.getUint16(34, true)).toBe(bits)
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(dv.getUint32(40, true)).toBe(dataSize)
  })

  it('packs 24-bit as three little-endian bytes per sample, negatives in two-complement', () => {
    //  0.5 * 8388607 =  4194303.5 -> Math.round is half-UP -> 4194304 = 0x400000 -> 00 00 40
    // -0.5 * 8388607 = -4194303.5 -> half-up again        -> -4194303 = 0xC00001 -> 01 00 C0
    //  1 -> 8388607 = 0x7FFFFF -> FF FF 7F ; -1 -> -8388607 = 0x800001 -> 01 00 80
    const wav = encodeWav(new Float32Array([0.5, 1]), new Float32Array([-0.5, -1]), 48000, { bits: 24 })
    expect([...wav.subarray(44, 50)]).toEqual([0x00, 0x00, 0x40, 0x01, 0x00, 0xc0])
    expect([...wav.subarray(50, 56)]).toEqual([0xff, 0xff, 0x7f, 0x01, 0x00, 0x80])
  })

  it('writes 32-bit samples as raw IEEE floats and keeps values past full scale', () => {
    const wav = encodeWav(new Float32Array([0.25, 1.5]), new Float32Array([-0.75, NaN]), 96000, { bits: 32 })
    const dv = header(wav)
    expect(dv.getFloat32(44, true)).toBe(0.25)
    expect(dv.getFloat32(48, true)).toBe(-0.75)
    expect(dv.getFloat32(52, true)).toBe(1.5) // NOT clamped: float delivery keeps the overshoot
    expect(dv.getFloat32(56, true)).toBe(0) // non-finite scrubbed
  })

  it('rejects a bad depth', () => {
    expect(() => encodeWav(new Float32Array(1), new Float32Array(1), 48000, { bits: 8 as unknown as WavBits })).toThrowError(/bits/)
  })

  it('labels depths for the UI', () => {
    expect([wavBitsLabel(16), wavBitsLabel(24), wavBitsLabel(32)]).toEqual(['16-bit', '24-bit', '32-bit float'])
  })
})

/* Round trip through our own reader: the encoder's claims about the layout
 * are only worth what a DECODER reading those bytes gets back. */
describe('decodeWav', () => {
  /** A ramp from -1 to 1 plus the exact endpoints, as a stereo pair. */
  const ramp = (n: number): { left: Float32Array; right: Float32Array } => {
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      left[i] = -1 + (2 * i) / (n - 1)
      right[i] = Math.sin((2 * Math.PI * i) / n) * 0.8
    }
    return { left, right }
  }

  it.each([
    { bits: 16 as WavBits, tol: 1 / 32767 },
    { bits: 24 as WavBits, tol: 1 / 8388607 },
    { bits: 32 as WavBits, tol: 0 }, // float is exact
  ])('round-trips a ramp within $bits-bit quantization', ({ bits, tol }) => {
    const { left, right } = ramp(257)
    const got = decodeWav(encodeWav(left, right, 44100, { bits }))
    expect(got.bits).toBe(bits)
    expect(got.channels).toBe(2)
    expect(got.sampleRate).toBe(44100)
    expect(got.left.length).toBe(257)
    let worst = 0
    for (let i = 0; i < 257; i++) {
      worst = Math.max(worst, Math.abs(got.left[i]! - left[i]!), Math.abs(got.right[i]! - right[i]!))
    }
    // half a quantization step is the honest bound for round-to-nearest
    expect(worst).toBeLessThanOrEqual(tol / 2 + 1e-9)
  })

  it('reads a file carrying an extra chunk between fmt and data', () => {
    const plain = encodeWav(new Float32Array([0.5, -0.5]), new Float32Array([0.25, -0.25]), 48000, { bits: 24 })
    // splice a 4-byte LIST chunk in after fmt (offset 36)
    const withList = new Uint8Array(plain.byteLength + 12)
    withList.set(plain.subarray(0, 36), 0)
    withList.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 36) // 'LIST', size 4
    withList.set(plain.subarray(36), 48)
    const dv = new DataView(withList.buffer)
    dv.setUint32(4, withList.byteLength - 8, true)
    const got = decodeWav(withList)
    expect(got.left[0]).toBeCloseTo(0.5, 6)
    expect(got.right[1]).toBeCloseTo(-0.25, 6)
  })

  it('rejects what it cannot honestly read', () => {
    expect(() => decodeWav(new Uint8Array(8))).toThrowError(/RIFF/)
    const wav = encodeWav(new Float32Array(2), new Float32Array(2), 48000, { bits: 16 })
    const badFormat = wav.slice()
    new DataView(badFormat.buffer).setUint16(20, 7, true) // mu-law
    expect(() => decodeWav(badFormat)).toThrowError(/format tag 7/)
    const badBits = wav.slice()
    new DataView(badBits.buffer).setUint16(34, 8, true)
    expect(() => decodeWav(badBits)).toThrowError(/bit depth 8/)
  })
})
