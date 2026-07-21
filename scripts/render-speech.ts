/* Vocode a speech clip with a sustained chord carrier — a "talking robot choir".
 *   pnpm tsx scripts/render-speech.ts <voice.wav> <out.wav>
 * The voice (mono 16-bit WAV) is the modulator; the carrier is a rich saw chord
 * plus a little noise (so the high bands have energy for consonants). A light
 * high-passed voice is mixed back in for sibilance ("s"/"t"/"sh") intelligibility. */
import { readFileSync, writeFileSync } from 'node:fs'
import { SawKernel } from '../packages/engine/src/dsp/osc'
import { VocoderKernel } from '../packages/engine/src/dsp/vocoder'
import { encodeWav16 } from '../packages/engine/src/index'

function readWavMono(path: string): { data: Float32Array; sr: number } {
  const b = readFileSync(path)
  const sr = b.readUInt32LE(24)
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const sz = b.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = sz >> 1
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768
      return { data: out, sr }
    }
    off += 8 + sz
  }
  throw new Error('no data chunk')
}

const voicePath = process.argv[2]!
const outPath = process.argv[3]!
const { data: voice, sr } = readWavMono(voicePath)
const ctx = { sampleRate: sr }
const N = voice.length

// Carrier: a lush Cmaj9 chord (C3 E3 G3 B3 D4) as saws + a little noise so the
// high bands — where consonants live — have energy for the vocoder to shape.
const freqs = [130.81, 164.81, 196.0, 246.94, 293.66]
const carrier = new Float32Array(N)
const tmp = new Float32Array(N)
for (const f of freqs) {
  new SawKernel().process(N, { freq: new Float32Array(N).fill(f) }, tmp, ctx)
  for (let i = 0; i < N; i++) carrier[i]! += (tmp[i]! * 0.85) / freqs.length
}
for (let i = 0; i < N; i++) carrier[i]! += (Math.random() * 2 - 1) * 0.05

// Vocode: many bands + fast response for intelligible speech.
const wet = new Float32Array(N)
new VocoderKernel({ bands: 30, low: 120, high: 9500, response: 0.008 }, ctx).process(N, { carrier, modulator: voice }, wet, ctx)

// Sibilance passthrough: a one-pole high-pass of the voice, mixed back so the
// unvoiced consonants (which the pitched carrier can't reproduce) come through.
const hpG = 1 - Math.exp((-2 * Math.PI * 3500) / sr)
let lp = 0
for (let i = 0; i < N; i++) {
  lp += hpG * (voice[i]! - lp)
  wet[i]! += (voice[i]! - lp) * 0.7
}

// peak-normalize
let peak = 0
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(wet[i]!))
const g = peak > 1e-6 ? 0.85 / peak : 1
for (let i = 0; i < N; i++) wet[i]! *= g

writeFileSync(outPath, encodeWav16(wet, wet, sr))
console.log(`✓ ${outPath}  (${(N / sr).toFixed(1)}s, peak×${g.toFixed(2)})`)
