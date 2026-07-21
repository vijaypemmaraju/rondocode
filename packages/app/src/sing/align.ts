/* ------------------------------------------------------------------------- *
 * Word alignment via Whisper (transformers.js, in-browser). Given the TTS
 * audio, returns per-word [start,end] timings so sing() can place each word
 * precisely, then split it into its (hyphen-specified) syllables. Robust vs the
 * energy-nucleus heuristic. The Whisper model (~150MB) is cached by
 * transformers.js after first load. ~16 kHz mono is what Whisper wants.
 * ------------------------------------------------------------------------- */
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

export interface WordTiming {
  text: string
  start: number
  end: number
}

let asr: AutomaticSpeechRecognitionPipeline | null = null
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null

/** Boot (or reuse) the Whisper aligner. WebGPU when available, WASM otherwise. */
export async function loadAligner(): Promise<void> {
  if (asr) return
  if (!loading) {
    const webgpu =
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      !!(await (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu!.requestAdapter().catch(() => null))
    // the *_timestamped export includes the cross-attentions word-level
    // timestamps need (a plain export throws "must contain cross attentions").
    loading = pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en_timestamped', {
      device: webgpu ? 'webgpu' : 'wasm',
    }) as Promise<AutomaticSpeechRecognitionPipeline>
  }
  asr = await loading
}

/** Linear-resample mono audio to 16 kHz (what Whisper expects). */
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

/** Whisper word timings for `audio`. Empty array if nothing was transcribed. */
export async function alignWords(audio: Float32Array, sr: number): Promise<WordTiming[]> {
  if (!asr) throw new Error('aligner not loaded')
  const out = (await asr(to16k(audio, sr), { return_timestamps: 'word' })) as {
    chunks?: { text: string; timestamp: [number, number | null] }[]
  }
  return (out.chunks ?? [])
    .filter((c) => c.text.trim().length > 0)
    .map((c) => ({ text: c.text.trim(), start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 0.25 }))
}
