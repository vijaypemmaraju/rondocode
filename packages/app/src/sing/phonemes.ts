/* ------------------------------------------------------------------------- *
 * Phoneme extraction via wav2vec2 CTC, run DIRECTLY on onnxruntime-web (WebGPU).
 * Given the spoken TTS line, returns per-phoneme [start,end] timings + a vowel
 * flag — the precise alignment the singing warp needs (replaces Whisper's
 * word-level timing + energy-guess syllable splitting).
 *
 * We drive onnxruntime-web ourselves (not transformers.js) so the input_values
 * actually reach the model, and decode the logits against the raw vocab (argmax
 * → collapse repeats/blanks) — no espeak `phonemizer` needed. fp32, no
 * quantization (q4f16/int8 collapse the CTC output to all-blank).
 * ------------------------------------------------------------------------- */
import * as ort from 'onnxruntime-web'

const BASE = 'http://127.0.0.1:8790'
const MODEL_URL = `${BASE}/phoneme.onnx`
const VOCAB_URL = 'https://huggingface.co/facebook/wav2vec2-lv-60-espeak-cv-ft/resolve/main/vocab.json'
const CACHE = 'rondocode-phonemes-v1'

// include the r-coloured vowels ɚ/ɝ (the "-er" in wonder, bird) — missing them
// undercounts syllables and derails the phoneme→syllable grouping.
const VOWEL_CHARS = 'aeiouɐɛɪʊəɔæʌɑɜɒyɨʉøœɵɘɚɝ'
const isVowel = (p: string): boolean => [...p].some((c) => VOWEL_CHARS.includes(c))

export interface Phone {
  start: number
  end: number
  sym: string
  vowel: boolean
}

let session: ort.InferenceSession | null = null
let idToSym: string[] = []
let vowelIds: number[] = []
let loading: Promise<void> | null = null
let ortReady = false

async function cachedBytes(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(url)
  if (hit) return hit.arrayBuffer()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (onProgress && total > 0 && res.body) {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      onProgress(loaded, total)
    }
    const buf = new Uint8Array(loaded)
    let off = 0
    for (const c of chunks) {
      buf.set(c, off)
      off += c.length
    }
    await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }))
    return buf.buffer
  }
  const buf = await res.arrayBuffer()
  await cache.put(url, new Response(buf))
  return buf
}

/** Load (or reuse) the phoneme CTC model + vocab. fp32 (~1.2 GB), cached. */
export async function loadPhonemes(onProgress?: (p: { label: string; done: number; total: number }) => void): Promise<void> {
  if (session) return
  if (!loading) {
    loading = (async () => {
      if (!ortReady) {
        ort.env.wasm.numThreads = 1
        ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`
        ortReady = true
      }
      let webgpu = false
      try {
        webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu!.requestAdapter())
      } catch {
        webgpu = false
      }
      const buf = await cachedBytes(MODEL_URL, (l, t) => onProgress?.({ label: 'phoneme model', done: l, total: t }))
      session = await ort.InferenceSession.create(buf, { executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'] })
      const res = await fetch(VOCAB_URL)
      if (!res.ok) throw new Error(`vocab fetch: ${res.status}`)
      const vocab = (await res.json()) as Record<string, number>
      idToSym = []
      for (const [sym, id] of Object.entries(vocab)) idToSym[id] = sym
      vowelIds = []
      for (let id = 0; id < idToSym.length; id++) {
        const s = idToSym[id]
        if (id > 3 && s && isVowel(s)) vowelIds.push(id)
      }
    })()
  }
  await loading
}

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

/** Zero-mean / unit-variance normalize (wav2vec2-lv60 feature extractor). */
function normalize(x: Float32Array): Float32Array {
  let mean = 0
  for (let i = 0; i < x.length; i++) mean += x[i]!
  mean /= Math.max(1, x.length)
  let v = 0
  for (let i = 0; i < x.length; i++) v += (x[i]! - mean) ** 2
  const std = Math.sqrt(v / Math.max(1, x.length)) + 1e-7
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = (x[i]! - mean) / std
  return out
}

/** Per-frame VOWEL PROBABILITY (softmax mass on all vowel tokens) for `audio`.
 *  Unlike the greedy phoneme decode — which drops/duplicates phonemes on long or
 *  repetitive takes — this is a smooth activity curve. Paired with the KNOWN
 *  syllable count from the lyrics, the caller snaps exactly N vowel centres to
 *  its peaks (warp.ts), so syllable→note alignment can never miscount. */
export async function vowelActivity(audio: Float32Array, sr: number): Promise<{ prob: Float32Array; fps: number }> {
  if (!session) throw new Error('phoneme model not loaded')
  const x16 = normalize(to16k(audio, sr))
  const out = await session.run({ input_values: new ort.Tensor('float32', x16, [1, x16.length]) })
  const logits = out['logits']!
  const T = logits.dims[1]!
  const V = logits.dims[2]!
  const data = logits.data as Float32Array
  const fps = T / (x16.length / 16000)
  const prob = new Float32Array(T)
  for (let t = 0; t < T; t++) {
    const base = t * V
    let mx = -Infinity
    for (let k = 0; k < V; k++) {
      const v = data[base + k]!
      if (v > mx) mx = v
    }
    let sum = 0
    for (let k = 0; k < V; k++) sum += Math.exp(data[base + k]! - mx)
    let vs = 0
    for (const id of vowelIds) vs += Math.exp(data[base + id]! - mx)
    prob[t] = vs / sum
  }
  return { prob, fps }
}

/** Phoneme timeline for `audio`. Blank (id 0) + repeats collapsed. */
export async function extractPhonemes(audio: Float32Array, sr: number): Promise<Phone[]> {
  if (!session) throw new Error('phoneme model not loaded')
  const x16 = normalize(to16k(audio, sr))
  const out = await session.run({ input_values: new ort.Tensor('float32', x16, [1, x16.length]) })
  const logits = out['logits']!
  const T = logits.dims[1]!
  const V = logits.dims[2]!
  const data = logits.data as Float32Array
  const fps = T / (x16.length / 16000)
  const phones: Phone[] = []
  let prev = -1
  let start = 0
  for (let t = 0; t <= T; t++) {
    let id = -1
    if (t < T) {
      let best = -Infinity
      const base = t * V
      for (let k = 0; k < V; k++) {
        const val = data[base + k]!
        if (val > best) {
          best = val
          id = k
        }
      }
    }
    if (id !== prev) {
      if (prev > 3) {
        // >3 skips the specials <pad>(0) <s>(1) </s>(2) <unk>(3)
        const sym = idToSym[prev] ?? '?'
        phones.push({ start: start / fps, end: t / fps, sym, vowel: isVowel(sym) })
      }
      start = t
      prev = id
    }
  }
  return phones
}
