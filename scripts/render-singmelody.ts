/* A wordless VOCAL-SYNTH singing a melody: a carrier melody (with vibrato +
 * per-note articulation) vocoded by a sustained, slowly-morphing vowel source.
 * This is what actually reads as "singing" — held pitched vowels on a tune —
 * vs a speech modulator, which only ever sounds like pitched talking.
 *   pnpm tsx scripts/render-singmelody.ts <out.wav>  */
import { writeFileSync } from 'node:fs'
import { SawKernel } from '../packages/engine/src/dsp/osc'
import { FormantKernel } from '../packages/engine/src/dsp/fx2'
import { VocoderKernel } from '../packages/engine/src/dsp/vocoder'
import { encodeWav16 } from '../packages/engine/src/index'

const sr = 48000
const ctx = { sampleRate: sr }
const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

// "Ode to Joy" opening — a recognizable tune so it's obviously SINGING.
const NOTE = [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62]
const DUR = NOTE.map((_, i) => (i === NOTE.length - 1 ? 0.9 : 0.42))
const total = DUR.reduce((s, d) => s + d, 0)
const N = Math.ceil(total * sr)

// per-sample pitch (with vibrato) + a per-note amplitude envelope (legato)
const freq = new Float32Array(N)
const amp = new Float32Array(N)
let t = 0
for (let n = 0; n < NOTE.length; n++) {
  const f = mtof(NOTE[n]!)
  const start = Math.floor(t * sr)
  const end = Math.min(N, Math.floor((t + DUR[n]!) * sr))
  for (let i = start; i < end; i++) {
    freq[i] = f
    const atk = Math.min(1, (i - start) / (0.02 * sr))
    const rel = Math.min(1, (end - i) / (0.05 * sr))
    amp[i] = Math.min(atk, rel) * 0.9
  }
  t += DUR[n]!
}
// vibrato: ~5.5 Hz, ~2% — the wobble that reads as a voice
for (let i = 0; i < N; i++) freq[i]! *= 1 + 0.02 * Math.sin((2 * Math.PI * 5.5 * i) / sr)

// carrier: saw + octave + a little noise, gated by the note envelope
const car = new Float32Array(N)
const tmp = new Float32Array(N)
const f2 = new Float32Array(N)
new SawKernel().process(N, { freq }, tmp, ctx)
for (let i = 0; i < N; i++) car[i]! += tmp[i]! * 0.8
for (let i = 0; i < N; i++) f2[i] = freq[i]! * 2
new SawKernel().process(N, { freq: f2 }, tmp, ctx)
for (let i = 0; i < N; i++) car[i]! += tmp[i]! * 0.25
for (let i = 0; i < N; i++) car[i]! = (car[i]! + (Math.random() * 2 - 1) * 0.05) * amp[i]!

// modulator: a sustained buzzy+breathy source through a SLOWLY morphing formant
// filter → held vowels (aah→ooh→eee→…) that the vocoder imposes on the melody.
const src = new Float32Array(N)
new SawKernel().process(N, { freq: new Float32Array(N).fill(110) }, src, ctx)
for (let i = 0; i < N; i++) src[i]! = src[i]! * 0.7 + (Math.random() * 2 - 1) * 0.2
const morph = new Float32Array(N)
for (let i = 0; i < N; i++) morph[i] = 0.5 + 0.5 * Math.sin((2 * Math.PI * 0.22 * i) / sr)
const mod = new Float32Array(N)
new FormantKernel().process(N, { in: src, morph }, mod, ctx)

const wet = new Float32Array(N)
new VocoderKernel({ bands: 28, low: 130, high: 9000, response: 0.012 }, ctx).process(N, { carrier: car, modulator: mod }, wet, ctx)

let peak = 0
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(wet[i]!))
const g = peak > 1e-6 ? 0.85 / peak : 1
for (let i = 0; i < N; i++) wet[i]! *= g
const out = process.argv[2]!
writeFileSync(out, encodeWav16(wet, wet, sr))
console.log(`✓ ${out}  (${(N / sr).toFixed(1)}s)`)
