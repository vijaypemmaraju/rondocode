import { describe, expect, it } from 'vitest'
import { encodeWav16 } from '../src/wav'

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
})
