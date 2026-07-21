/* Make a voice clip SING: vocode it with a carrier that plays a chord
 * PROGRESSION (moving pitch = a tune), so the words come out sung as harmony.
 *   pnpm tsx scripts/render-sing.ts <voice.wav> <out.wav>
 * Same source–filter trick as render-speech, but the carrier's pitch moves
 * through I–V–vi–IV — the vocoder imposes THAT pitch on the voice's words. */
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

// C major — G — A minor — F  (I–V–vi–IV), four chord voices moving per bar.
// Each row is one carrier voice's note (Hz) through the four chords.
const CHORDS = [
  [130.81, 98.0, 110.0, 87.31], // low
  [164.81, 146.83, 164.81, 130.81],
  [196.0, 196.0, 220.0, 174.61],
  [261.63, 246.94, 261.63, 220.0], // top
]
const nBars = CHORDS[0]!.length
const barLen = N / nBars

// Per-voice per-sample frequency schedule → SawKernel keeps phase continuous
// across the chord changes (no clicks), then sum the voices into the carrier.
const carrier = new Float32Array(N)
const freq = new Float32Array(N)
const tmp = new Float32Array(N)
for (const voiceNotes of CHORDS) {
  for (let i = 0; i < N; i++) {
    const bar = Math.min(nBars - 1, Math.floor(i / barLen))
    freq[i] = voiceNotes[bar]!
  }
  new SawKernel().process(N, { freq }, tmp, ctx)
  for (let i = 0; i < N; i++) carrier[i]! += (tmp[i]! * 0.8) / CHORDS.length
}
// a little noise so the high bands (consonants) have energy to shape
for (let i = 0; i < N; i++) carrier[i]! += (Math.random() * 2 - 1) * 0.05

// Vocode: the carrier's chord pitch + the voice's words/formants.
const wet = new Float32Array(N)
new VocoderKernel({ bands: 30, low: 120, high: 9500, response: 0.008 }, ctx).process(N, { carrier, modulator: voice }, wet, ctx)

// sibilance passthrough for consonant clarity
const hpG = 1 - Math.exp((-2 * Math.PI * 3500) / sr)
let lp = 0
for (let i = 0; i < N; i++) {
  lp += hpG * (voice[i]! - lp)
  wet[i]! += (voice[i]! - lp) * 0.6
}

let peak = 0
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(wet[i]!))
const g = peak > 1e-6 ? 0.85 / peak : 1
for (let i = 0; i < N; i++) wet[i]! *= g

writeFileSync(outPath, encodeWav16(wet, wet, sr))
console.log(`✓ ${outPath}  (${(N / sr).toFixed(1)}s, ${nBars} chords, peak×${g.toFixed(2)})`)
