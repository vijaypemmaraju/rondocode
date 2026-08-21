/* Verify a TRAINED ddsp model against the PyTorch reference and the engine:
 *
 *  1. Decoder parity: run the vectors training/ddsp/verify.py exported through
 *     the TS decoder; harmonic amps + noise mags must match the Python run of
 *     the same fp16 .bin.
 *  2. In-engine audibility: renderOffline a ddsp voice playing A3, assert it
 *     sounds, is pitched at the note (Goertzel at 220 Hz beats its
 *     inharmonic neighbours), and decays after release.
 *
 *   pnpm tsx scripts/verify-ddsp-model.ts training/ddsp/runs/violin/ddsp-violin.bin [midiNote]
 *
 * midiNote defaults to 57 (A3, 220 Hz) — pass one inside the instrument's
 * trained range (flute 69, bass 45).
 */
import { readFileSync } from 'node:fs'
import { parseDdspModel, DdspDecoder, renderOffline } from '../packages/engine/src/index'
import type { GraphSpec } from '../packages/engine/src/index'
import { goertzel } from '../packages/engine/test/util/goertzel'

const binPath = process.argv[2]
if (!binPath) {
  console.error('usage: pnpm tsx scripts/verify-ddsp-model.ts <path/to/ddsp-name.bin>')
  process.exit(2)
}
const bytes = new Uint8Array(readFileSync(binPath))
const model = parseDdspModel(bytes)
console.log(`model '${model.header.name}': ${model.header.nHarmonics} harmonics, hop ${model.header.hop} @ ${model.header.sampleRate} Hz, license ${model.header.license}`)

let failures = 0
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/* 1. decoder parity with the Python run of the same file */
interface Vectors {
  f0_hz: number[]
  loudness_db: number[]
  harm_amps: number[][]
  noise_mags: number[][]
}
const vecPath = binPath.replace(/\.bin$/, '.vectors.json')
const vec = JSON.parse(readFileSync(vecPath, 'utf8')) as Vectors
const dec = new DdspDecoder(model)
let worstHarm = 0
let worstNoise = 0
for (let f = 0; f < vec.f0_hz.length; f++) {
  dec.step(vec.f0_hz[f]!, vec.loudness_db[f]!)
  for (let k = 0; k < model.header.nHarmonics; k++) {
    worstHarm = Math.max(worstHarm, Math.abs(dec.harmAmps[k]! - vec.harm_amps[f]![k]!))
  }
  for (let j = 0; j < model.header.nNoise; j++) {
    worstNoise = Math.max(worstNoise, Math.abs(dec.noiseMags[j]! - vec.noise_mags[f]![j]!))
  }
}
check('decoder parity: harmonic amps', worstHarm < 5e-4, `worst |Δ| ${worstHarm}`)
check('decoder parity: noise mags', worstNoise < 5e-4, `worst |Δ| ${worstNoise}`)

/* 2. in-engine render: sounds, in tune, decays */
const spec: GraphSpec = {
  nodes: [
    { id: 0, type: 'gate', inputs: {} },
    { id: 1, type: 'notefreq', inputs: {} },
    { id: 2, type: 'ddsp', inputs: { gate: { node: 0 }, freq: { node: 1 } }, config: { model: model.header.name } },
    { id: 3, type: 'out', inputs: { in: { node: 2 } } },
  ],
  out: 3,
  params: [],
}
const sr = 48000
const midi = Number(process.argv[3] ?? 57)
const res = renderOffline(
  { graph: spec },
  [
    { type: 'noteOn', time: 0.05, note: midi, velocity: 0.9 },
    { type: 'noteOff', time: 1.55, note: midi },
  ],
  3,
  { sampleRate: sr, ddspModels: { [model.header.name]: bytes } },
)
const mono = new Float32Array(sr * 3)
for (let i = 0; i < mono.length; i++) mono[i] = (res.left[i]! + res.right[i]!) / 2
const rms = (from: number, to: number): number => {
  let s = 0
  for (let i = from; i < to; i++) s += mono[i]! * mono[i]!
  return Math.sqrt(s / (to - from))
}
const sustained = mono.subarray(Math.round(0.6 * sr), Math.round(1.4 * sr))
const sustainRms = rms(Math.round(0.6 * sr), Math.round(1.4 * sr))
check('sounds while held', sustainRms > 1e-3, `sustain rms ${sustainRms}`)
const f0 = 440 * Math.pow(2, (midi - 69) / 12)
const atF0 = goertzel(sustained, f0, sr) + goertzel(sustained, 2 * f0, sr) + goertzel(sustained, 3 * f0, sr)
const off = goertzel(sustained, f0 * 1.26, sr) + goertzel(sustained, f0 * 2.24, sr) + goertzel(sustained, f0 * 3.36, sr)
check('pitched at the note', atF0 > off * 4, `harmonic power ${atF0} vs inharmonic ${off}`)
const tailRms = rms(Math.round(2.6 * sr), 3 * sr)
check('decays after release', tailRms < sustainRms * 0.1, `tail rms ${tailRms} vs sustain ${sustainRms}`)

// peak sanity: a synth voice should sit in a mixable range
let peak = 0
for (const v of mono) peak = Math.max(peak, Math.abs(v))
check('peak in mixable range', peak > 0.005 && peak < 1.5, `peak ${peak}`)

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
