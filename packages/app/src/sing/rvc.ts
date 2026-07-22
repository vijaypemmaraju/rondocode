/* ------------------------------------------------------------------------- *
 * RVC neural voice conversion in the browser (onnxruntime-web, WebGPU).
 *
 * Takes the "guide track" (the phoneme-warped spoken line — correct words +
 * timing, any pitch) plus the EXACT melody f0, and regenerates it in a real
 * singer's timbre:
 *   guide 16k → ContentVec encoder → 768-d content @ 50 Hz → interp ×2 →
 *   RVC generator (content + coarse pitch + continuous f0 + noise) → 40 kHz wav.
 * Content is pitch-agnostic and we supply the melody f0 ourselves, so the output
 * is exactly on-pitch. Models are fetched once and cached (Cache API).
 *
 * The generator is a per-voice ~112 MB ONNX (exported dynamic-length from an RVC
 * v2 .pth); the ContentVec encoder is shared across voices.
 * ------------------------------------------------------------------------- */
import * as ort from 'onnxruntime-web'
import { SING_MODELS_BASE } from './config'
import { cachedBytes } from './modelcache'

/** Where the ONNX models are served (CORS). Local static server in dev; swap to
 *  HF/R2 for production (same idea as supertonic.ts). */
const RVC_BASE = SING_MODELS_BASE
const CONTENTVEC_URL = `${RVC_BASE}/vec-768.onnx`
const CACHE = 'rondocode-rvc-v1'

/** A shippable voice: name + generator URL. */
export interface Voice {
  id: string
  label: string
  url: string
}
export const VOICES: Voice[] = [
  { id: 'kizuna', label: 'Kizuna (bright F)', url: `${RVC_BASE}/gen_kizuna.onnx` },
  { id: 'barbara', label: 'Barbara (soft F)', url: `${RVC_BASE}/gen_barbara.onnx` },
  { id: 'rise', label: 'Rise (pop F)', url: `${RVC_BASE}/gen_rise.onnx` },
]

export interface RvcProgress {
  label: string
  done: number
  total: number
}

let contentVec: ort.InferenceSession | null = null
const generators = new Map<string, ort.InferenceSession>()
let ortReady = false


async function ortOptions(): Promise<ort.InferenceSession.SessionOptions> {
  if (!ortReady) {
    ort.env.wasm.numThreads = 1
    if (!ort.env.wasm.wasmPaths) ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/` /* browser CDN; node presets a local path */
    ortReady = true
  }
  let webgpu = false
  try {
    webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu!.requestAdapter())
  } catch {
    webgpu = false
  }
  return { executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'] }
}

/** Load (or reuse) the ContentVec encoder + a chosen voice generator, caching
 *  the ONNX bytes. ContentVec is ~378 MB, each generator ~112 MB (one-time). */
export async function loadRvc(voiceId: string, onProgress?: (p: RvcProgress) => void): Promise<void> {
  const opts = await ortOptions()
  if (!contentVec) {
    const buf = await cachedBytes(CONTENTVEC_URL, CACHE, (l, t) => onProgress?.({ label: 'voice encoder', done: l, total: t }))
    contentVec = await ort.InferenceSession.create(buf, opts)
  }
  if (!generators.has(voiceId)) {
    const v = VOICES.find((x) => x.id === voiceId)
    if (!v) throw new Error(`unknown voice ${voiceId}`)
    const buf = await cachedBytes(v.url, CACHE, (l, t) => onProgress?.({ label: `voice: ${v.label}`, done: l, total: t }))
    generators.set(voiceId, await ort.InferenceSession.create(buf, opts))
  }
}

/** Linear resample to 16 kHz (ContentVec's rate). */
function to16k(x: Float32Array, sr: number): Float32Array {
  if (sr === 16000) return x
  const ratio = sr / 16000
  const n = Math.floor(x.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i * ratio
    const i0 = Math.floor(t)
    const f = t - i0
    out[i] = (x[i0] ?? 0) * (1 - f) + (x[i0 + 1] ?? 0) * f
  }
  return out
}

/** Box–Muller normal noise. */
function randn(n: number): Float32Array {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-7, Math.random())
    a[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random())
  }
  return a
}

/** Convert a guide track to a singer's voice at the given per-output-frame f0.
 *  `f0Frames` is the target f0 (Hz) sampled on the generator's frame grid; if its
 *  length differs from the content length it is linearly resampled to match. */
export async function rvcConvert(guide: Float32Array, sr: number, f0Frames: Float32Array, voiceId: string): Promise<{ audio: Float32Array; sr: number }> {
  if (!contentVec) throw new Error('rvc not loaded')
  const gen = generators.get(voiceId)
  if (!gen) throw new Error(`voice ${voiceId} not loaded`)
  const x16 = to16k(guide, sr)

  // ContentVec: [1,1,T16] -> [1,F,768]
  const src = new ort.Tensor('float32', x16, [1, 1, x16.length])
  const enc = await contentVec.run({ source: src })
  const emb = enc['embed']!
  const F = emb.dims[1]!
  const D = emb.dims[2]! // 768
  const ed = emb.data as Float32Array
  // interp ×2 (nearest / repeat) -> [1,2F,768]
  const L = 2 * F
  const phone = new Float32Array(L * D)
  for (let f = 0; f < F; f++) {
    const s = f * D
    phone.set(ed.subarray(s, s + D), 2 * f * D)
    phone.set(ed.subarray(s, s + D), (2 * f + 1) * D)
  }

  // f0 -> L frames (resample if needed), then coarse pitch (mel bins 1..255)
  const f0 = new Float32Array(L)
  if (f0Frames.length === L) f0.set(f0Frames)
  else {
    for (let i = 0; i < L; i++) {
      const t = (i / L) * (f0Frames.length - 1)
      const i0 = Math.floor(t)
      const fr = t - i0
      f0[i] = (f0Frames[i0] ?? 0) * (1 - fr) + (f0Frames[i0 + 1] ?? 0) * fr
    }
  }
  const melMin = 1127 * Math.log(1 + 50 / 700)
  const melMax = 1127 * Math.log(1 + 1100 / 700)
  const pitch = new BigInt64Array(L)
  for (let i = 0; i < L; i++) {
    if (f0[i]! > 0) {
      const mel = 1127 * Math.log(1 + f0[i]! / 700)
      let b = Math.round(((mel - melMin) * 254) / (melMax - melMin) + 1)
      b = Math.max(0, Math.min(255, b))
      pitch[i] = BigInt(b)
    } else pitch[i] = 0n
  }

  const out = await gen.run({
    phone: new ort.Tensor('float32', phone, [1, L, D]),
    phone_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(L)]), [1]),
    pitch: new ort.Tensor('int64', pitch, [1, L]),
    pitchf: new ort.Tensor('float32', f0, [1, L]),
    ds: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
    rnd: new ort.Tensor('float32', randn(192 * L), [1, 192, L]),
  })
  const audio = out['audio']!.data as Float32Array
  // peak normalize
  let peak = 0
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]!))
  const g = peak > 1e-6 ? 0.95 / peak : 1
  const norm = new Float32Array(audio.length)
  for (let i = 0; i < audio.length; i++) norm[i] = audio[i]! * g
  return { audio: norm, sr: 40000 }
}
