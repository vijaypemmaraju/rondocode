/* ------------------------------------------------------------------------- *
 * sing() render manager. The editor hands it the staged SingRequests after each
 * eval; it renders each vocal clip (neural, async) and loadSamplePcm's it under
 * the request's sampleName so the already-staged sampler synth + trigger pattern
 * play it. Dedups by (voice, lyrics, notes, cps) so an unrelated re-eval never
 * re-bakes an unchanged clip.
 *
 * UX (per the design):
 *   - FIRST play: the editor awaits whenReady() before transport('play') — a
 *     progress dialog shows the model download + bake, then playback starts.
 *   - LIVE edits while playing: bake() fires in the background; loadSamplePcm
 *     swaps the clip when ready and the looping pattern picks it up next cycle —
 *     playback never stops.
 * ------------------------------------------------------------------------- */
import type { AudioSession } from '../audio/AudioSession'
import type { SingRequest } from '../session/evalCode'
import type { SingProgress } from './neural'
import { PHONEME_INT8_MODEL_URL, PHONEME_MODEL_URL } from './config'
import { clearPhase } from './bakephase'

/** True once the big models have been downloaded (the phoneme model — the
 *  largest — is in the Cache API; either the fp32 or the int8 build counts).
 *  Lets the UI ask for consent only on a first play that would actually
 *  trigger the multi-GB download. */
export async function modelsCached(): Promise<boolean> {
  try {
    const c = await caches.open('rondocode-phonemes-v1')
    return !!((await c.match(PHONEME_MODEL_URL)) ?? (await c.match(PHONEME_INT8_MODEL_URL)))
  } catch {
    return false
  }
}

let audio: AudioSession | null = null
let onProgress: ((p: (SingProgress & { active: number }) | null) => void) | null = null
let onError: ((msg: string) => void) | null = null

/** Turn a raw load/render error into a short, user-facing message. */
function humanError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  if (/Failed to fetch|NetworkError|ERR_|load failed/i.test(m)) return 'Could not download the voice models — check your connection and run again.'
  if (/\b(40\d|50\d)\b/.test(m)) return 'Voice models are unavailable right now. Try again shortly.'
  if (/no available backend|webgpu|wasm/i.test(m)) return "This browser couldn't run the voice models."
  return `Singing failed: ${m.slice(0, 140)}`
}

/** sampleName → the render key currently LOADED for it. */
const loadedKey = new Map<string, string>()
/** sampleName → { key, promise } for the render in flight. */
const inflight = new Map<string, { key: string; promise: Promise<void> }>()

export function initSing(a: AudioSession): void {
  audio = a
}
/** Subscribe to bake progress (for the dialog). Null = idle/done. */
export function onSingProgress(cb: (p: (SingProgress & { active: number }) | null) => void): void {
  onProgress = cb
}
/** Subscribe to render failures (for the dialog to surface, not swallow). */
export function onSingError(cb: (msg: string) => void): void {
  onError = cb
}

const keyOf = (r: SingRequest, cps: number): string => `${r.voice}\n${r.lyrics}\n${r.notes}\n${cps}\n${r.cycles ?? 1}`

/** True if any request isn't yet LOADED with its current key (a clip in flight
 *  counts as unloaded — it can't play until its render lands). */
export function hasUnloaded(sings: SingRequest[], cps: number): boolean {
  return sings.some((r) => loadedKey.get(r.sampleName) !== keyOf(r, cps))
}

async function renderOne(r: SingRequest, cps: number, report: (p: SingProgress) => void): Promise<void> {
  const { renderNeural } = await import('./neural')
  const { audio: pcm, sr } = await renderNeural(r.lyrics, r.notes, cps, r.voice, report, r.cycles ?? 1)
  audio?.loadSamplePcm(r.sampleName, pcm, sr, false)
}

/** Bake every request whose (voice,lyrics,notes,cps) changed. Idempotent: an
 *  unchanged clip is skipped; a re-triggered render supersedes an older one for
 *  the same sampleName. Fire-and-forget; use whenReady() to await. */
/** Serializes bakes: every queued render waits for the previous one. */
let bakeChain: Promise<unknown> = Promise.resolve()

export function bake(sings: SingRequest[], cps: number): void {
  for (const r of sings) {
    const k = keyOf(r, cps)
    if (loadedKey.get(r.sampleName) === k) continue // already loaded
    if (inflight.get(r.sampleName)?.key === k) continue // already rendering this exact clip
    // QUEUE, do not race: each render is heavy synchronous inference on the
    // main thread, so N concurrent bakes wedge the tab instead of finishing
    // sooner (a four-part vocal arrangement locked the page for minutes with
    // no UI and no progress). Serializing keeps the page alive and the same
    // total time. A request superseded while queued is skipped at its turn.
    const promise = bakeChain
      .then(() => (inflight.get(r.sampleName)?.key === k ? renderOne(r, cps, (p) => emit(p)) : undefined))
      .then(() => {
        loadedKey.set(r.sampleName, k)
        clearPhase() // clean finish: no crash marker left for the next boot
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[sing] render failed', r.sampleName, e)
        // A HANDLED failure reached this catch, so the tab is alive and the
        // error is surfaced right here; clear the phase marker so the next
        // boot doesn't misreport it as an out-of-memory tab kill (a real kill
        // never reaches this catch - that's what makes the marker a report).
        clearPhase()
        onError?.(humanError(e))
      })
      .finally(() => {
        if (inflight.get(r.sampleName)?.key === k) inflight.delete(r.sampleName)
        if (inflight.size === 0) onProgress?.(null)
      })
    inflight.set(r.sampleName, { key: k, promise })
    bakeChain = promise.catch(() => undefined) // a failure must not stall the queue
    // Show the dialog IMMEDIATELY. renderOne dynamically imports the (large)
    // neural chunk before it emits any progress, so without this the dialog
    // would only appear after a visible delay from clicking play.
    emit({ phase: 'prepare', label: 'preparing voice…', done: 0, total: 0 })
  }
}

function emit(p: SingProgress): void {
  // Preserve p.total — it's the download byte count the dialog shows as MB.
  // (`active` = how many clips are baking, for a future multi-bake indicator.)
  onProgress?.({ ...p, active: inflight.size })
}

/** Resolve once every current request is loaded (or its render settled). */
export async function whenReady(sings: SingRequest[], cps: number): Promise<void> {
  await Promise.all(
    sings.map((r) => {
      if (loadedKey.get(r.sampleName) === keyOf(r, cps)) return Promise.resolve()
      return inflight.get(r.sampleName)?.promise ?? Promise.resolve()
    }),
  )
}
