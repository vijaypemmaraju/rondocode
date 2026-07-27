/* ------------------------------------------------------------------------- *
 * Headless singing: bake sing() vocals in NODE, with no browser.
 *
 * Two things stand between the neural vocal pipeline and a CLI, and neither
 * is fundamental:
 *   1. the model store is the browser Cache API, which node does not have, and
 *   2. onnxruntime-web looks for its wasm on a CDN by default.
 * Both are swapped here: models land in a real directory (so they are
 * downloaded once and reused, exactly like the browser cache), and ORT reads
 * the wasm shipped in node_modules.
 *
 * Everything else is the SAME code the app runs, on purpose: the point is a
 * render you can diff against the browser's, and a vocal arrangement you can
 * test in CI instead of by pressing play and waiting.
 * ------------------------------------------------------------------------- */

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { setCacheOpener } from '../../app/src/sing/modelcache'
import type { CacheLike } from '../../app/src/sing/modelcache'

/** Where downloaded models live. Override with RONDOCODE_MODEL_CACHE. */
export const modelCacheDir = (): string =>
  process.env['RONDOCODE_MODEL_CACHE'] ?? join(homedir(), '.cache', 'rondocode-models')

const keyFor = (name: string, url: string): string =>
  join(modelCacheDir(), name, createHash('sha256').update(url).digest('hex').slice(0, 32))

/** A CacheLike over the filesystem. Writes go to a `.part` file and are
 *  renamed on completion, so an interrupted download is never mistaken for a
 *  cached model (the browser path gets the same guarantee from the Cache API's
 *  atomic put). */
function fileCache(name: string): CacheLike {
  return {
    async put(url: string, res: Response): Promise<void> {
      const path = keyFor(name, url)
      mkdirSync(dirname(path), { recursive: true })
      const part = `${path}.part`
      if (res.body === null) {
        await writeFile(part, Buffer.from(await res.arrayBuffer()))
      } else {
        const { createWriteStream } = await import('node:fs')
        const out = createWriteStream(part)
        // stream to disk: a 1.26 GB model must never sit in the heap
        await new Promise<void>((ok, fail) => {
          Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
            .pipe(out)
            .on('finish', () => ok())
            .on('error', fail)
        })
      }
      await rename(part, path)
    },
    async match(url: string): Promise<Response | undefined> {
      const path = keyFor(name, url)
      if (!existsSync(path)) return undefined
      const size = statSync(path).size
      const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>
      return new Response(stream, { headers: { 'content-length': String(size) } })
    },
    async delete(url: string): Promise<boolean> {
      const path = keyFor(name, url)
      if (!existsSync(path)) return false
      await rm(path, { force: true })
      return true
    },
  }
}

let installed = false

/** Point the sing pipeline at node: filesystem model store + local ORT wasm.
 *  Idempotent. */
export async function installNodeSingRuntime(): Promise<void> {
  if (installed) return
  installed = true
  setCacheOpener(async (name) => fileCache(name))
  // ORT's wasm ships in node_modules; without this it reaches for a CDN path
  // that only makes sense in a browser.
  const ort = await import('onnxruntime-web')
  // the package's exports map hides package.json, so locate its dist through
  // the main entry instead (that file already LIVES in dist/)
  const req = createRequire(import.meta.url)
  const dist = dirname(req.resolve('onnxruntime-web')) + '/'
  ort.env.wasm.wasmPaths = dist
  ort.env.wasm.numThreads = 1
}

export interface BakedClip {
  sampleName: string
  data: Float32Array
  sampleRate: number
}

/** Bake every sing() request of a staged program. Returns the clips keyed the
 *  way renderMix's `samples` option wants them, so the caller can render a
 *  mix that includes the vocals. Serial by construction (the same reason the
 *  app queues them: one heavy inference at a time). */
export async function bakeSings(
  sings: readonly {
    sampleName: string
    voice: string
    lyrics: string
    notes: string
    cycles?: number
  }[],
  cps: number,
  onProgress?: (msg: string) => void,
): Promise<Record<string, { data: Float32Array; sampleRate: number }>> {
  await installNodeSingRuntime()
  const { renderNeural } = await import('../../app/src/sing/neural')
  const out: Record<string, { data: Float32Array; sampleRate: number }> = {}
  for (let i = 0; i < sings.length; i++) {
    const r = sings[i]!
    const part = sings.length > 1 ? `vocal ${i + 1}/${sings.length} ` : ''
    const { audio, sr } = await renderNeural(
      r.lyrics,
      r.notes,
      cps,
      r.voice,
      (p) => onProgress?.(`${part}${p.label}`),
      r.cycles ?? 1,
    )
    if (audio.length === 0) throw new Error(`sing(): baked an EMPTY clip for '${r.sampleName}'`)
    out[r.sampleName] = { data: audio, sampleRate: sr }
    onProgress?.(`${part}done: ${(audio.length / sr).toFixed(2)}s at ${sr} Hz`)
  }
  return out
}

/** Read a model straight from the store (tests/tools). */
export const readCachedModel = async (name: string, url: string): Promise<Buffer | null> => {
  const path = keyFor(name, url)
  return existsSync(path) ? readFile(path) : null
}
