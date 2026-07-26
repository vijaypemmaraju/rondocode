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
