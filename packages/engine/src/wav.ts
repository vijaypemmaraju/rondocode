/* ------------------------------------------------------------------------- *
 * WAV encoding and decoding: stereo 16/24-bit integer PCM or 32-bit IEEE
 * float, at any sample rate. Environment-agnostic (Uint8Array in and out, no
 * Node Buffer) so the render scripts, the MCP tools and the browser download
 * path all share one writer.
 *
 * Layout is the classic 44-byte canonical RIFF header at every depth:
 * RIFF/WAVE, a 16-byte `fmt ` chunk, then `data`. Integer depths declare
 * format tag 1 (WAVE_FORMAT_PCM); 32-bit declares tag 3
 * (WAVE_FORMAT_IEEE_FLOAT). Plain tag 3 with a 16-byte fmt chunk is what
 * DAWs and libsndfile-based tools read; WAVE_FORMAT_EXTENSIBLE would only be
 * required past two channels or past 32 bits, and neither applies here.
 * ------------------------------------------------------------------------- */

/** Bits per sample. 16 and 24 are integer PCM; 32 is IEEE float. */
export type WavBits = 16 | 24 | 32

export interface WavOptions {
  /** Bits per sample. Default 16. */
  bits?: WavBits
}

/** Human label for a depth, for UI and messages. */
export const wavBitsLabel = (bits: WavBits): string => (bits === 32 ? '32-bit float' : `${bits}-bit`)

const FMT_PCM = 1
const FMT_FLOAT = 3

const validate = (fn: string, left: Float32Array, right: Float32Array, sampleRate: number, bits: WavBits): void => {
  if (left.length !== right.length) {
    throw new RangeError(`${fn}: channel length mismatch (${left.length} vs ${right.length})`)
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`${fn}: sampleRate must be a positive integer, got ${sampleRate}`)
  }
  if (bits !== 16 && bits !== 24 && bits !== 32) {
    throw new RangeError(`${fn}: bits must be 16, 24 or 32, got ${String(bits)}`)
  }
}

/**
 * Encode stereo float audio as a WAV file.
 *
 * - `bits: 16` quantizes to signed 16-bit, `bits: 24` to packed 3-byte
 *   little-endian signed 24-bit. Both CLAMP to [-1, 1] and quantize
 *   symmetrically (±1 → ±(2^(bits-1) - 1)), so full scale survives the round
 *   trip and nothing wraps.
 * - `bits: 32` writes the float samples verbatim (IEEE float, tag 3). Values
 *   past ±1 are PRESERVED, not clamped: keeping the overshoot is the reason
 *   to deliver float, and the receiving tool can still turn it down. Only
 *   non-finite samples are scrubbed to 0.
 *
 * Both channels must be the same length; sampleRate must be a positive
 * integer (44100, 48000, 96000 all encode the same way).
 */
export function encodeWav(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts?: WavOptions,
): Uint8Array {
  const bits = opts?.bits ?? 16
  validate('encodeWav', left, right, sampleRate, bits)
  const frames = left.length
  const bytesPerSample = bits / 8
  const blockAlign = bytesPerSample * 2
  const dataSize = frames * blockAlign
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
  dv.setUint16(20, bits === 32 ? FMT_FLOAT : FMT_PCM, true)
  dv.setUint16(22, 2, true) // stereo
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * blockAlign, true) // byte rate
  dv.setUint16(32, blockAlign, true)
  dv.setUint16(34, bits, true)
  tag(36, 'data')
  dv.setUint32(40, dataSize, true)

  if (bits === 32) {
    for (let i = 0; i < frames; i++) {
      const l = left[i]!
      const r = right[i]!
      dv.setFloat32(44 + i * 8, Number.isFinite(l) ? l : 0, true)
      dv.setFloat32(48 + i * 8, Number.isFinite(r) ? r : 0, true)
    }
    return out
  }
  const peak = bits === 16 ? 32767 : 8388607
  const quant = (x: number): number => Math.round(Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0)) * peak)
  if (bits === 16) {
    for (let i = 0; i < frames; i++) {
      dv.setInt16(44 + i * 4, quant(left[i]!), true)
      dv.setInt16(46 + i * 4, quant(right[i]!), true)
    }
    return out
  }
  // 24-bit: three little-endian bytes per sample, two's complement.
  let o = 44
  for (let i = 0; i < frames; i++) {
    const l = quant(left[i]!)
    const r = quant(right[i]!)
    const ul = l < 0 ? l + 0x1000000 : l
    const ur = r < 0 ? r + 0x1000000 : r
    out[o++] = ul & 0xff
    out[o++] = (ul >> 8) & 0xff
    out[o++] = (ul >> 16) & 0xff
    out[o++] = ur & 0xff
    out[o++] = (ur >> 8) & 0xff
    out[o++] = (ur >> 16) & 0xff
  }
  return out
}

/**
 * Encode stereo float audio as a 16-bit PCM WAV file: the long-standing
 * default (render scripts, MCP tools, session recording), kept as a thin
 * wrapper over encodeWav.
 */
export function encodeWav16(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  validate('encodeWav16', left, right, sampleRate, 16)
  return encodeWav(left, right, sampleRate, { bits: 16 })
}

export interface DecodedWav {
  left: Float32Array
  /** The same array as `left` for a mono file, so callers can always read both. */
  right: Float32Array
  sampleRate: number
  bits: WavBits
  channels: number
}

/**
 * Decode a WAV file this encoder (or any tool writing canonical RIFF) wrote:
 * mono or stereo, 16/24-bit integer PCM or 32-bit float, chunks walked in
 * order so a file carrying LIST/fact/anything else still reads. Integer
 * samples are scaled by 1/(2^(bits-1) - 1), the inverse of the quantization
 * above, so a round trip is exact at every depth. Channels past the second
 * are ignored. Throws on anything it cannot honestly read.
 */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.byteLength < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
    throw new RangeError('decodeWav: not a RIFF/WAVE file')
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined
  let data: { at: number; size: number } | undefined
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(at)
    const size = dv.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, bytes.byteLength - body) }
    }
    at = body + size + (size % 2) // chunks are word-aligned
  }
  if (fmt === undefined || data === undefined) throw new RangeError('decodeWav: missing fmt or data chunk')
  const { format, channels, sampleRate, bits } = fmt
  if (channels < 1) throw new RangeError(`decodeWav: bad channel count ${channels}`)
  const isFloat = format === FMT_FLOAT
  if (!isFloat && format !== FMT_PCM) throw new RangeError(`decodeWav: unsupported format tag ${format}`)
  if (bits !== 16 && bits !== 24 && bits !== 32) throw new RangeError(`decodeWav: unsupported bit depth ${bits}`)
  if (isFloat !== (bits === 32)) throw new RangeError(`decodeWav: ${bits}-bit with format tag ${format}`)
  const bytesPerSample = bits / 8
  const frames = Math.floor(data.size / (bytesPerSample * channels))
  const left = new Float32Array(frames)
  const right = channels > 1 ? new Float32Array(frames) : left
  const scale = bits === 16 ? 1 / 32767 : 1 / 8388607
  const read = (o: number): number => {
    if (bits === 32) return dv.getFloat32(o, true)
    if (bits === 16) return dv.getInt16(o, true) * scale
    const u = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16)
    return (u & 0x800000 ? u - 0x1000000 : u) * scale
  }
  for (let i = 0; i < frames; i++) {
    const frame = data.at + i * bytesPerSample * channels
    left[i] = read(frame)
    if (channels > 1) right[i] = read(frame + bytesPerSample)
  }
  return { left, right, sampleRate, bits: bits as WavBits, channels }
}
