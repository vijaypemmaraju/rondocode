/* ------------------------------------------------------------------------- *
 * The shipped DDSP instrument models: which exist, where they load from, and
 * a byte cache shared by the live engine (loadDdspModel messages) and the
 * offline bounce path (renderStagedMix ddspModels opt) so a bounce plays the
 * same instruments the session did.
 *
 * Models are ~1 MB RDSP .bin files (training/ddsp/SPEC.md) on the same R2
 * bucket as the singing models. They fetch lazily on FIRST USE of a ddsp
 * node naming them (Session.defineSynthNow calls ensureDdspModels with the
 * names it sees in the graph), so a session that never plays a violin never
 * downloads one. Silence until the file lands, then the kernel picks it up
 * per block — the sample live-load contract.
 * ------------------------------------------------------------------------- */

/** The instruments we ship (and the enum the editor cycles through —
 *  editor/rondo/enums.ts mirrors this list; ddsp-models.test.ts pins them
 *  together). The bank accepts user-loaded models under any name; this list
 *  is only what the CDN serves. */
export const DDSP_MODELS = ['violin', 'viola', 'cello', 'bass', 'flute', 'trumpet', 'tenorsax'] as const

const DEFAULT_BASE = 'https://models.rondocode.com/ddsp/v1'

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

/** Base URL (no trailing slash) for ddsp-<name>.bin. Override with
 *  VITE_DDSP_MODELS_BASE (e.g. http://127.0.0.1:8790 for local files). */
export const DDSP_MODELS_BASE = readEnv('VITE_DDSP_MODELS_BASE')?.replace(/\/+$/, '') ?? DEFAULT_BASE

export const ddspModelUrl = (name: string): string => `${DDSP_MODELS_BASE}/ddsp-${name}.bin`
export const ddspBodyUrl = (name: string): string => `${DDSP_MODELS_BASE}/ddsp-${name}-body.wav`

/** Minimal 16-bit mono WAV parse (the body IRs are our own files — this is
 *  not a general decoder). Returns null on anything unexpected. */
export function parseWav16Mono(bytes: Uint8Array): { data: Float32Array; sampleRate: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 44 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null
  let pos = 12
  let sampleRate = 0
  let dataStart = -1
  let dataLen = 0
  while (pos + 8 <= bytes.byteLength) {
    const id = dv.getUint32(pos, false)
    const size = dv.getUint32(pos + 4, true)
    if (id === 0x666d7420) {
      // fmt: PCM, mono, 16-bit only
      if (dv.getUint16(pos + 8, true) !== 1 || dv.getUint16(pos + 10, true) !== 1 || dv.getUint16(pos + 22, true) !== 16) return null
      sampleRate = dv.getUint32(pos + 12, true)
    } else if (id === 0x64617461) {
      dataStart = pos + 8
      dataLen = Math.min(size, bytes.byteLength - dataStart)
    }
    pos += 8 + size + (size & 1)
  }
  if (sampleRate === 0 || dataStart < 0) return null
  const n = Math.floor(dataLen / 2)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = dv.getInt16(dataStart + i * 2, true) / 32768
  return { data, sampleRate }
}

const loaded = new Map<string, Uint8Array>()
const inflight = new Map<string, Promise<Uint8Array | undefined>>()
const failed = new Set<string>()

/** Everything fetched so far, keyed by model name — the bounce path passes
 *  this to renderMix so offline ddsp nodes play the same weights. */
export function loadedDdspModels(): Record<string, Uint8Array> {
  return Object.fromEntries(loaded)
}

async function fetchModel(name: string): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(ddspModelUrl(name))
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    loaded.set(name, bytes)
    return bytes
  } catch (e) {
    // warn once per name per session; a later eval retries (failure cleared)
    if (!failed.has(name)) {
      failed.add(name)
      console.warn(`[ddsp] model '${name}' failed to load from ${ddspModelUrl(name)}:`, e)
    }
    return undefined
  } finally {
    inflight.delete(name)
  }
}

const bodies = new Map<string, { data: Float32Array; sampleRate: number }>()
const bodyInflight = new Set<string>()

/** Body-resonance samples fetched so far (name '<instrument>body'), for the
 *  bounce path — same reason as loadedDdspModels. */
export function loadedDdspBodies(): Record<string, { data: Float32Array; sampleRate: number }> {
  return Object.fromEntries(bodies)
}

/** Test/dev hook mirroring primeDdspModel. */
export function primeDdspBody(name: string, data: Float32Array, sampleRate: number): void {
  bodies.set(`${name}body`, { data, sampleRate })
}

/** Fetch any of `names` that are shipped models not yet cached, calling
 *  `deliver` with each one's bytes as it lands (the caller posts it to the
 *  engine). Names outside DDSP_MODELS are ignored — user-loaded models come
 *  through their own load path, and fetching arbitrary names off the CDN
 *  would just 404. Already-cached names are re-delivered (cheap; the engine
 *  replaces the entry), which makes eval-after-reload just work.
 *
 *  `deliverBody` (optional) receives each instrument's BODY impulse response
 *  as a sample named '<instrument>body' (e.g. 'violinbody') for the post
 *  chain's convolve — extracted from the trained room model, it carries the
 *  fixed body resonances the dry synth cannot make. Missing body files are
 *  fine (older CDN layouts): the instrument still plays, just dry. */
export function ensureDdspModels(
  names: Iterable<string>,
  deliver: (name: string, bytes: Uint8Array) => void,
  deliverBody?: (sampleName: string, data: Float32Array, sampleRate: number) => void,
): void {
  for (const name of new Set(names)) {
    if (!(DDSP_MODELS as readonly string[]).includes(name)) continue
    const have = loaded.get(name)
    if (have !== undefined) {
      deliver(name, have)
    } else if (inflight.has(name)) {
      void inflight.get(name)!.then((bytes) => {
        if (bytes !== undefined) deliver(name, bytes)
      })
    } else {
      failed.delete(name) // a fresh eval is a fresh chance
      const p = fetchModel(name)
      inflight.set(name, p)
      void p.then((bytes) => {
        if (bytes !== undefined) deliver(name, bytes)
      })
    }
    if (deliverBody === undefined) continue
    const bodyName = `${name}body`
    const haveBody = bodies.get(bodyName)
    if (haveBody !== undefined) {
      deliverBody(bodyName, haveBody.data, haveBody.sampleRate)
    } else if (!bodyInflight.has(bodyName)) {
      bodyInflight.add(bodyName)
      void (async () => {
        try {
          const res = await fetch(ddspBodyUrl(name))
          if (!res.ok) return
          const parsed = parseWav16Mono(new Uint8Array(await res.arrayBuffer()))
          if (!parsed) return
          bodies.set(bodyName, parsed)
          deliverBody(bodyName, parsed.data, parsed.sampleRate)
        } catch {
          /* body IR is an enhancement; the instrument plays dry without it */
        } finally {
          bodyInflight.delete(bodyName)
        }
      })()
    }
  }
}

/** Test/dev hook: preload bytes under a name without any network. */
export function primeDdspModel(name: string, bytes: Uint8Array): void {
  loaded.set(name, bytes)
}

/** The ddsp model names a set of graph specs reference. The graph is the
 *  truth (not the source text): every path that defines a synth carries one,
 *  so rondo, JS and hand-built graphs all trigger the same fetch. */
export function ddspModelNamesInGraph(graph: { nodes?: { type?: string; config?: Record<string, unknown> }[] }): string[] {
  const out: string[] = []
  for (const n of graph.nodes ?? []) {
    if (n.type === 'ddsp' && typeof n.config?.['model'] === 'string') out.push(n.config['model'] as string)
  }
  return out
}
