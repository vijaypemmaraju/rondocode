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

const envBase = (import.meta.env.VITE_SING_MODELS_BASE as string | undefined)?.replace(/\/+$/, '')

/** Base URL (no trailing slash) for phoneme.onnx, vec-768.onnx, gen_<voice>.onnx. */
export const SING_MODELS_BASE = envBase ?? DEFAULT_BASE

/** Supertonic TTS models — already public on HuggingFace, overridable too. */
export const SUPERTONIC_BASE =
  (import.meta.env.VITE_SUPERTONIC_BASE as string | undefined)?.replace(/\/+$/, '') ??
  'https://huggingface.co/Supertone/supertonic-3/resolve/main'
