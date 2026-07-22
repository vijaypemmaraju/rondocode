/* ------------------------------------------------------------------------- *
 * Supertonic 3 — on-device neural TTS in the browser (ONNX Runtime Web).
 * Ported from the upstream MIT `web/helper.js` (github.com/supertone-inc/
 * supertonic), adapted to fetch models straight from HuggingFace with CORS and
 * cache them in the Cache API (one-time ~250MB download, then offline). The
 * speech half of `sing()`; the phoneme aligner (phonemes.ts) + RVC (rvc.ts) do
 * the singing.
 *
 * Pipeline per utterance: text → unicode tokens → duration_predictor (total
 * length) → text_encoder → a flow-matching denoise loop (vector_estimator) →
 * vocoder → waveform. See synthesize().
 * ------------------------------------------------------------------------- */
import * as ort from 'onnxruntime-web'
import { SUPERTONIC_BASE } from './config'
import { cachedBytes } from './modelcache'

const HF = SUPERTONIC_BASE
const CACHE = 'rondocode-supertonic-v3'
const MODELS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'] as const

const LANGS = new Set([
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id',
  'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na',
])

/** Progress across the one-time model download + per-step synthesis. */
export interface SingProgress {
  phase: 'download' | 'synthesize'
  label: string
  done: number
  total: number
}

interface Cfgs {
  ae: { sample_rate: number; base_chunk_size: number }
  ttl: { chunk_compress_factor: number; latent_dim: number }
}

/* ------------------------------ text processor -------------------------- */

class UnicodeProcessor {
  constructor(private readonly indexer: number[]) {}

  preprocess(text: string, lang: string): string {
    text = text.normalize('NFKD')
    const emoji =
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]+/gu
    text = text.replace(emoji, '')
    const rep: Record<string, string> = {
      '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"',
      '‘': "'", '’': "'", '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ',
    }
    for (const [k, v] of Object.entries(rep)) text = text.replaceAll(k, v)
    text = text.replace(/[♥☆♡©\\]/g, '')
    text = text.replaceAll('@', ' at ')
    text = text.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?')
    text = text.replace(/\s+/g, ' ').trim()
    if (!/[.!?;:,'")\]}…]$/.test(text)) text += '.'
    if (!LANGS.has(lang)) throw new Error(`unsupported language: ${lang}`)
    return `<${lang}>${text}</${lang}>`
  }

  encode(text: string, lang: string): { ids: number[]; mask: number[] } {
    const t = this.preprocess(text, lang)
    const ids: number[] = []
    for (let j = 0; j < t.length; j++) {
      const cp = t.codePointAt(j)!
      ids.push(cp < this.indexer.length ? this.indexer[cp]! : -1)
    }
    return { ids, mask: ids.map(() => 1) }
  }
}

/* ------------------------------- loading -------------------------------- */

const cachedFetch = (url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> =>
  cachedBytes(url, CACHE, onProgress)

async function cachedJson<T>(url: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await cachedFetch(url))) as T
}

let engine: SupertonicEngine | null = null
let loading: Promise<SupertonicEngine> | null = null

/** Boot (or reuse) the TTS engine: fetch + cache the 4 models + config, create
 *  ORT sessions (WebGPU, WASM fallback). ~250MB the first time, then instant. */
export function loadEngine(onProgress?: (p: SingProgress) => void): Promise<SupertonicEngine> {
  if (engine) return Promise.resolve(engine)
  if (loading) return loading
  loading = (async () => {
    // Serve the ORT wasm binaries from the matching CDN build (no COOP/COEP →
    // single-threaded; WebGPU carries the heavy models anyway).
    ort.env.wasm.numThreads = 1
    if (!ort.env.wasm.wasmPaths) ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/` /* browser CDN; node presets a local path */

    const cfgs = await cachedJson<Cfgs>(`${HF}/onnx/tts.json`)
    const indexer = await cachedJson<number[]>(`${HF}/onnx/unicode_indexer.json`)

    let webgpu = false
    try {
      webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu!.requestAdapter())
    } catch {
      webgpu = false
    }
    const opts: ort.InferenceSession.SessionOptions = { executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'] }

    const sessions: ort.InferenceSession[] = []
    for (let i = 0; i < MODELS.length; i++) {
      const name = MODELS[i]!
      const buf = await cachedFetch(`${HF}/onnx/${name}.onnx`, (loaded, total) =>
        onProgress?.({ phase: 'download', label: `voice model ${i + 1}/${MODELS.length}`, done: loaded, total }),
      )
      sessions.push(await ort.InferenceSession.create(buf, opts))
    }
    engine = new SupertonicEngine(cfgs, new UnicodeProcessor(indexer), sessions)
    return engine
  })()
  return loading
}

/* --------------------------- the TTS engine ----------------------------- */

interface StyleJson {
  style_ttl: { dims: number[]; data: number[] }
  style_dp: { dims: number[]; data: number[] }
}

const flatDeep = (a: unknown): number[] => (Array.isArray(a) ? a.flat(Infinity as 1) as number[] : [a as number])

export class SupertonicEngine {
  readonly sampleRate: number
  private styleCache = new Map<string, { ttl: ort.Tensor; dp: ort.Tensor }>()

  constructor(
    private readonly cfgs: Cfgs,
    private readonly proc: UnicodeProcessor,
    private readonly sess: ort.InferenceSession[],
  ) {
    this.sampleRate = cfgs.ae.sample_rate
  }

  private async style(voice: string): Promise<{ ttl: ort.Tensor; dp: ort.Tensor }> {
    const cached = this.styleCache.get(voice)
    if (cached) return cached
    const j = await cachedJson<StyleJson>(`${HF}/voice_styles/${voice}.json`)
    const ttl = new ort.Tensor('float32', Float32Array.from(flatDeep(j.style_ttl.data)), j.style_ttl.dims)
    const dp = new ort.Tensor('float32', Float32Array.from(flatDeep(j.style_dp.data)), j.style_dp.dims)
    const s = { ttl, dp }
    this.styleCache.set(voice, s)
    return s
  }

  /** Synthesize one line → mono Float32Array at this.sampleRate. */
  async synthesize(
    text: string,
    opts: { voice?: string; lang?: string; steps?: number; speed?: number; onProgress?: (p: SingProgress) => void } = {},
  ): Promise<Float32Array> {
    const { voice = 'F1', lang = 'en', steps = 8, speed = 1.05, onProgress } = opts
    const [dpOrt, textEncOrt, vecOrt, vocOrt] = this.sess as [
      ort.InferenceSession, ort.InferenceSession, ort.InferenceSession, ort.InferenceSession,
    ]
    const style = await this.style(voice)
    const { ids, mask } = this.proc.encode(text, lang)
    const L = ids.length
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids.map((x) => BigInt(x))), [1, L])
    const textMask = new ort.Tensor('float32', Float32Array.from(mask), [1, 1, L])

    const dp = await dpOrt.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })
    const duration = (dp['duration']!.data as Float32Array)[0]! / speed

    const enc = await textEncOrt.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask })
    const textEmb = enc['text_emb']!

    // noisy latent + mask
    const chunk = this.cfgs.ae.base_chunk_size * this.cfgs.ttl.chunk_compress_factor
    const wavLen = Math.floor(duration * this.sampleRate)
    const latentLen = Math.floor((wavLen + chunk - 1) / chunk)
    const latentDim = this.cfgs.ttl.latent_dim * this.cfgs.ttl.chunk_compress_factor
    let xt: Float32Array = new Float32Array(latentDim * latentLen)
    for (let i = 0; i < xt.length; i++) {
      const u1 = Math.max(1e-4, Math.random())
      xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random())
    }
    const latentMask = new ort.Tensor('float32', Float32Array.from({ length: latentLen }, () => 1), [1, 1, latentLen])
    const totalStep = new ort.Tensor('float32', Float32Array.from({ length: 1 }, () => steps), [1])

    for (let step = 0; step < steps; step++) {
      onProgress?.({ phase: 'synthesize', label: 'singing', done: step + 1, total: steps })
      const cur = new ort.Tensor('float32', Float32Array.from([step]), [1])
      const xtT = new ort.Tensor('float32', xt, [1, latentDim, latentLen])
      const out = await vecOrt.run({
        noisy_latent: xtT, text_emb: textEmb, style_ttl: style.ttl,
        latent_mask: latentMask, text_mask: textMask, current_step: cur, total_step: totalStep,
      })
      xt = out['denoised_latent']!.data as Float32Array
    }

    const finalXt = new ort.Tensor('float32', xt, [1, latentDim, latentLen])
    const voc = await vocOrt.run({ latent: finalXt })
    return voc['wav_tts']!.data as Float32Array
  }
}
