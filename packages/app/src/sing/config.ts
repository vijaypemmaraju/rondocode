/* ------------------------------------------------------------------------- *
 * Where the on-device singing models load from. The phoneme CTC model, the RVC
 * ContentVec encoder and the per-voice RVC generators are large custom ONNX
 * files. In production they're served from a HuggingFace repo (see
 * docs/sing-models.md for the one-time upload); for local dev, point at the
 * static model server with:
 *     VITE_SING_MODELS_BASE=http://127.0.0.1:8790
 * The value is read once at build time (Vite inlines import.meta.env.*).
 * ------------------------------------------------------------------------- */

/** Where the phoneme + RVC models live — a public Cloudflare R2 bucket on the
 *  edge CDN (fast, cached, no egress fees), so it works everywhere (prod, dev,
 *  over Tailnet) with no local server. Override with VITE_SING_MODELS_BASE (e.g.
 *  http://127.0.0.1:8790 for a local model server). */
const DEFAULT_BASE = 'https://models.rondocode.com'

const readEnv = (key: string): string | undefined => {
  // Vite inlines import.meta.env at build time; node has no such object, and
  // the headless renderer imports this module directly. Try both, quietly.
  try {
    const v = (import.meta as { env?: Record<string, string | undefined> }).env?.[key]
    if (typeof v === 'string' && v !== '') return v
  } catch {
    /* no import.meta.env here */
  }
  try {
    const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key]
    if (typeof v === 'string' && v !== '') return v
  } catch {
    /* no process.env here */
  }
  return undefined
}

const envBase = readEnv('VITE_SING_MODELS_BASE')?.replace(/\/+$/, '')

/** Base URL (no trailing slash) for phoneme.onnx, vec-768.onnx, gen_<voice>.onnx. */
export const SING_MODELS_BASE = envBase ?? DEFAULT_BASE

/** Supertonic TTS models — already public on HuggingFace, overridable too. */
export const SUPERTONIC_BASE =
  readEnv('VITE_SUPERTONIC_BASE')?.replace(/\/+$/, '') ??
  'https://huggingface.co/Supertone/supertonic-3/resolve/main'

/** The two builds of the phoneme aligner served from SING_MODELS_BASE: the
 *  fp32 original and the ~3.5x smaller dynamic-int8 build (lm_head kept fp32;
 *  whole-graph quantization is what used to collapse the CTC output). */
export const PHONEME_MODEL_URL = `${SING_MODELS_BASE}/phoneme.onnx`
export const PHONEME_INT8_MODEL_URL = `${SING_MODELS_BASE}/phoneme-int8.onnx`

/** True when this client should prefer the small int8 aligner: iOS/iPadOS
 *  (tight per-tab memory budget) or the explicit opt-in flag for testing the
 *  small build on any device (`localStorage['rc.singSmallAligner'] = '1'`). */
export function preferSmallAligner(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rc.singSmallAligner') === '1') return true
  } catch {
    /* storage blocked: fall through to the UA check */
  }
  return isIOSWebKit()
}

/** Ordered aligner URLs to try. When the small build is preferred it comes
 *  first with the fp32 build as fallback, so a client keeps working while
 *  phoneme-int8.onnx isn't uploaded yet (404 falls through to fp32). Pure,
 *  exported for tests. */
export function phonemeModelUrls(small: boolean = preferSmallAligner()): string[] {
  return small ? [PHONEME_INT8_MODEL_URL, PHONEME_MODEL_URL] : [PHONEME_MODEL_URL]
}

/** The Supertonic TTS models with a validated int8 build served from
 *  SING_MODELS_BASE as `tts_<name>-int8.onnx`. Only these two carry one:
 *  - vector_estimator (256.5 MB -> 65.6 MB): dynamic int8 on Conv+MatMul with
 *    the `/vector_estimator/vector_field/proj_out/net/Conv` output head kept
 *    fp32. Log-mel delta vs fp32 on the fixed utterance set is 0.46 - a third
 *    of the fp32 seed-to-seed self-noise (~1.3).
 *  - vocoder (101.4 MB -> 38.6 MB): dynamic int8 on the fat 1x1 pwconvs only;
 *    the depthwise convs, the input embed conv and the two head convs stay
 *    fp32 (quantizing the depthwise convs is what pushed the delta past the
 *    self-noise band).
 *  duration_predictor (3.5 MB) is not worth shrinking, and text_encoder int8
 *  measurably drifted phrase prosody (aligned-timing deltas grew past one CTC
 *  frame on 2/6 fixed utterances), so both stay fp32 everywhere. */
export const TTS_INT8_MODELS: ReadonlySet<string> = new Set(['vector_estimator', 'vocoder'])

/** Ordered URLs to try for one Supertonic TTS model. On the sequential
 *  (constrained-device) path the int8 build from SING_MODELS_BASE comes first
 *  with the fp32 HuggingFace build as fallback, so a client keeps working
 *  while `tts_<name>-int8.onnx` isn't uploaded yet (404 falls through).
 *  Desktop stays fp32. Pure, exported for tests. */
export function supertonicModelUrls(name: string, small: boolean = sequentialSingSessions()): string[] {
  const fp32 = `${SUPERTONIC_BASE}/onnx/${name}.onnx`
  if (small && TTS_INT8_MODELS.has(name)) return [`${SING_MODELS_BASE}/tts_${name}-int8.onnx`, fp32]
  return [fp32]
}

/** True when the bake should run its model stages SEQUENTIALLY - create the
 *  sessions for one stage, use them, dispose them before the next stage - so
 *  peak session memory is the largest single stage instead of the sum of all
 *  of them. On by default on iOS/iPadOS (tight per-tab kill line); the
 *  localStorage flag (`rc.singSequential` = '1') opts any device in so the
 *  path can be exercised on desktop. */
export function sequentialSingSessions(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rc.singSequential') === '1') return true
  } catch {
    /* storage blocked: fall through to the UA check */
  }
  return isIOSWebKit()
}

/** True on iOS/iPadOS WebKit (every iOS browser is WebKit, including Chrome
 *  and Firefox shells). Two reasons the sing stack cares: (1) ORT's WebGPU
 *  execution provider is immature on WebKit and can take the whole tab down,
 *  where wasm merely runs slower; (2) the per-tab memory budget is tight
 *  enough that the ~250MB model set is already near the kill line, so we
 *  avoid stacking GPU buffer allocations on top. */
export function isIOSWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const classic = /iPhone|iPad|iPod/.test(ua)
  // iPadOS masquerades as macOS Safari; touch points give it away
  const ipadDesktopUA = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
  return classic || ipadDesktopUA
}
