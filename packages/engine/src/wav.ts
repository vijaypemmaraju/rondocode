/* ------------------------------------------------------------------------- *
 * Minimal WAV encoding: 16-bit stereo PCM with the classic 44-byte RIFF
 * header. Environment-agnostic (returns a Uint8Array, no Node Buffer) so
 * both the render scripts and a future browser download path can use it.
 * ------------------------------------------------------------------------- */

/**
 * Encode stereo float audio as a 16-bit PCM WAV file. Samples are clamped
 * to [-1, 1] and quantized symmetrically (±1 → ±32767). Both channels must
 * be the same length; sampleRate must be a positive integer.
 */
export function encodeWav16(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): Uint8Array {
  if (left.length !== right.length) {
    throw new RangeError(
      `encodeWav16: channel length mismatch (${left.length} vs ${right.length})`,
    )
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWav16: sampleRate must be a positive integer, got ${sampleRate}`)
  }
  const frames = left.length
  const dataSize = frames * 2 * 2 // 2 channels * 2 bytes
  const out = new Uint8Array(44 + dataSize)
  const dv = new DataView(out.buffer)
  const tag = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  tag(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  dv.setUint32(16, 16, true) // fmt chunk size
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 2, true) // stereo
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 4, true) // byte rate
  dv.setUint16(32, 4, true) // block align
  dv.setUint16(34, 16, true) // bits per sample
  tag(36, 'data')
  dv.setUint32(40, dataSize, true)
  const clamp16 = (x: number): number =>
    Math.round(Math.max(-1, Math.min(1, x)) * 32767)
  for (let i = 0; i < frames; i++) {
    dv.setInt16(44 + i * 4, clamp16(left[i]!), true)
    dv.setInt16(46 + i * 4, clamp16(right[i]!), true)
  }
  return out
}
