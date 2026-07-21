/* Path A prototype: turn SPOKEN words into SUNG words on a melody.
 * For each syllable: time-stretch it to its note's duration (so the vowel
 * SUSTAINS instead of talking past), then vocode it with a clean carrier held
 * at the note's pitch (+ vibrato). Because the vocoder only reads the
 * modulator's spectral ENVELOPE, cheap OLA stretching is fine — the clean
 * carrier re-synthesizes the tone. Demo: "twinkle twinkle little star".
 *   pnpm tsx scripts/render-vocaloid.ts <words-dir> <out.wav>  */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SawKernel } from '../packages/engine/src/dsp/osc'
import { VocoderKernel } from '../packages/engine/src/dsp/vocoder'
import { encodeWav16 } from '../packages/engine/src/index'

const wordsDir = process.argv[2]!
const outPath = process.argv[3]!

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

/** RMS envelope in ~10ms windows. */
function envelope(x: Float32Array, sr: number): Float32Array {
  const w = Math.floor(0.01 * sr)
  const e = new Float32Array(x.length)
  let acc = 0
  for (let i = 0; i < x.length; i++) {
    acc += x[i]! * x[i]!
    if (i >= w) acc -= x[i - w]! * x[i - w]!
    e[i] = Math.sqrt(acc / w)
  }
  return e
}

/** Trim leading/trailing near-silence (below 6% of peak envelope). */
function trim(x: Float32Array, sr: number): Float32Array {
  const e = envelope(x, sr)
  let peak = 0
  for (let i = 0; i < e.length; i++) peak = Math.max(peak, e[i]!)
  const th = peak * 0.06
  let a = 0
  let b = x.length - 1
  while (a < b && e[a]! < th) a++
  while (b > a && e[b]! < th) b--
  return x.slice(a, b + 1)
}

/** Split a 2-syllable word at the lowest-energy point in its middle 50%. */
function splitTwo(x: Float32Array, sr: number): [Float32Array, Float32Array] {
  const e = envelope(x, sr)
  const lo = Math.floor(x.length * 0.28)
  const hi = Math.floor(x.length * 0.72)
  let m = lo
  for (let i = lo; i < hi; i++) if (e[i]! < e[m]!) m = i
  return [x.slice(0, m), x.slice(m)]
}

/** OLA time-stretch x to exactly `target` samples (envelope-faithful). */
function olaStretch(x: Float32Array, target: number, sr: number): Float32Array {
  const out = new Float32Array(target)
  if (x.length < 2 || target < 2) return out
  const grain = Math.min(x.length, Math.max(256, Math.floor(0.055 * sr)))
  const hopOut = Math.max(1, Math.floor(grain / 4))
  const ratio = x.length / target
  const win = new Float32Array(grain)
  for (let k = 0; k < grain; k++) win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (grain - 1))
  const norm = new Float32Array(target)
  let inPos = 0
  for (let outPos = 0; outPos < target; outPos += hopOut) {
    const i0 = Math.floor(inPos)
    for (let k = 0; k < grain; k++) {
      const oi = outPos + k
      const ii = i0 + k
      if (oi < target && ii >= 0 && ii < x.length) {
        out[oi]! += x[ii]! * win[k]!
        norm[oi]! += win[k]!
      }
    }
    inPos += hopOut * ratio
  }
  for (let i = 0; i < target; i++) out[i] = norm[i]! > 1e-6 ? out[i]! / norm[i]! : 0
  return out
}

const mtof = (m: number): number => 440 * 2 ** ((m - 69) / 12)

// --- load + segment "twinkle twinkle little star" into 7 syllables --------
const twinkle = trim(readWavMono(join(wordsDir, 'twinkle_1.wav')).data, 44100)
const little = trim(readWavMono(join(wordsDir, 'little_1.wav')).data, 44100)
const star = trim(readWavMono(join(wordsDir, 'star_1.wav')).data, 44100)
const sr = readWavMono(join(wordsDir, 'star_1.wav')).sr
const ctx = { sampleRate: sr }
const [twin, kle] = splitTwo(twinkle, sr)
const [lit, tle] = splitTwo(little, sr)
const SYL = [twin, kle, twin, kle, lit, tle, star]

// melody: Twinkle — C C G G A A G
const NOTE = [60, 60, 67, 67, 69, 69, 67]
const DUR = [0.55, 0.55, 0.55, 0.55, 0.55, 0.55, 1.1]

// --- per syllable: stretch to note, vocode with a vibrato carrier ----------
const parts: Float32Array[] = []
for (let n = 0; n < NOTE.length; n++) {
  const len = Math.floor(DUR[n]! * sr)
  const mod = olaStretch(SYL[n]!, len, sr)

  // carrier: saw + octave + noise, vibrato, per-note amp envelope
  const f0 = mtof(NOTE[n]!)
  const freq = new Float32Array(len)
  const amp = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    freq[i] = f0 * (1 + 0.02 * Math.sin((2 * Math.PI * 5.5 * i) / sr))
    const atk = Math.min(1, i / (0.025 * sr))
    const rel = Math.min(1, (len - i) / (0.06 * sr))
    amp[i] = Math.min(atk, rel)
  }
  const car = new Float32Array(len)
  const tmp = new Float32Array(len)
  new SawKernel().process(len, { freq }, tmp, ctx)
  for (let i = 0; i < len; i++) car[i]! += tmp[i]! * 0.8
  const f2 = new Float32Array(len)
  for (let i = 0; i < len; i++) f2[i] = freq[i]! * 2
  new SawKernel().process(len, { freq: f2 }, tmp, ctx)
  for (let i = 0; i < len; i++) car[i]! = (car[i]! + tmp[i]! * 0.25 + (Math.random() * 2 - 1) * 0.05) * amp[i]!

  const wet = new Float32Array(len)
  new VocoderKernel({ bands: 30, low: 120, high: 9500, response: 0.01 }, ctx).process(len, { carrier: car, modulator: mod }, wet, ctx)
  // sibilance passthrough for consonant clarity
  const hpG = 1 - Math.exp((-2 * Math.PI * 3500) / sr)
  let lp = 0
  for (let i = 0; i < len; i++) {
    lp += hpG * (mod[i]! - lp)
    wet[i]! += (mod[i]! - lp) * 0.5 * amp[i]!
  }
  parts.push(wet)
}

// --- concatenate with short equal-power crossfades -------------------------
const xf = Math.floor(0.02 * sr)
let totalLen = 0
for (const p of parts) totalLen += p.length
totalLen -= xf * (parts.length - 1)
const mix = new Float32Array(totalLen)
let pos = 0
for (let n = 0; n < parts.length; n++) {
  const p = parts[n]!
  for (let i = 0; i < p.length; i++) {
    let g = 1
    if (n > 0 && i < xf) g = i / xf
    if (n < parts.length - 1 && i > p.length - xf) g = (p.length - i) / xf
    const oi = pos + i
    if (oi < totalLen) mix[oi]! += p[i]! * g
  }
  pos += p.length - xf
}

let peak = 0
for (let i = 0; i < totalLen; i++) peak = Math.max(peak, Math.abs(mix[i]!))
const g = peak > 1e-6 ? 0.85 / peak : 1
for (let i = 0; i < totalLen; i++) mix[i]! *= g
writeFileSync(outPath, encodeWav16(mix, mix, sr))
console.log(`✓ ${outPath}  (${(totalLen / sr).toFixed(1)}s, ${NOTE.length} syllables)`)
