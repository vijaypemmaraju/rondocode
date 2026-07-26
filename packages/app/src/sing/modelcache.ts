/* ------------------------------------------------------------------------- *
 * Shared model fetch + Cache API storage for the singing models. Sizes today:
 * 3.5-244 MB each, ~380 MB for the TTS set. The download STREAMS straight
 * into the Cache API through a counting TransformStream, so the JS heap never
 * holds the model during download (the old chunk-accumulate-then-assemble
 * path peaked at ~3x the model size right as the bar hit 100%, which is
 * exactly where iOS killed the tab). Progress reports per chunk, transient
 * failures retry with backoff, and a truncated body is never cached: the
 * byte count is checked against content-length and a short entry is deleted.
 * One-time download, then served from the cache offline.
 * ------------------------------------------------------------------------- */

const RETRIES = 3

/** The cache surface streamIntoCache needs - the real Cache object satisfies
 *  it; tests stub it. */
export interface CacheLike {
  put(url: string, res: Response): Promise<void>
  match(url: string): Promise<Response | undefined>
  delete(url: string): Promise<boolean>
}

/** Stream a fetch response body INTO the cache without accumulating it in
 *  the JS heap; count bytes through a TransformStream (backpressure flows
 *  through, so neither branch buffers). Throws on truncation (loaded !=
 *  content-length) after deleting any partial entry. */
export async function streamIntoCache(
  res: Response,
  cache: CacheLike,
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const total = Number(res.headers.get('content-length') ?? 0)
  const headers = { 'content-type': 'application/octet-stream' }
  if (res.body === null) {
    // no stream support: one buffered copy, the pre-streaming behavior
    await cache.put(url, new Response(await res.arrayBuffer(), { headers }))
    return
  }
  let loaded = 0
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl): void {
      loaded += chunk.byteLength
      if (total > 0) onProgress?.(loaded, total)
      ctrl.enqueue(chunk)
    },
  })
  try {
    await cache.put(url, new Response(res.body.pipeThrough(counting), { headers }))
  } catch (e) {
    await cache.delete(url).catch(() => undefined)
    throw e
  }
  if (total > 0 && loaded !== total) {
    // the server closed early without erroring - never keep a short model
    await cache.delete(url).catch(() => undefined)
    throw new Error(`truncated download: ${loaded}/${total} bytes for ${url}`)
  }
}

/** Try `urls` in order through `fetchBytes`, returning the first that loads
 *  (and which one it was). A failure on a non-final URL falls through to the
 *  next; only the last failure is thrown. Drives the small-aligner fallback:
 *  [phoneme-int8.onnx, phoneme.onnx] keeps working while the small build
 *  isn't uploaded yet. Pure fetch-order logic, exported for tests. */
export async function firstAvailableBytes(
  urls: string[],
  fetchBytes: (url: string) => Promise<ArrayBuffer>,
): Promise<{ url: string; buf: ArrayBuffer }> {
  let lastErr: unknown = new Error('no model URLs to try')
  for (const url of urls) {
    try {
      return { url, buf: await fetchBytes(url) }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Fetch `url` (or return it from `cacheName`), storing the full bytes on first
 *  success. `onProgress(loaded,total)` fires while streaming. Throws after
 *  RETRIES consecutive failures. */
export async function cachedBytes(
  url: string,
  cacheName: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(url)
  if (hit) return hit.arrayBuffer()

  let lastErr: unknown
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url)
      // 404 is deterministic (the file isn't there): fail fast so a fallback
      // URL can be tried instead of burning the retry backoff on it.
      if (res.status === 404) throw Object.assign(new Error(`404 ${res.statusText} for ${url}`), { permanent: true })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
      await streamIntoCache(res, cache, url, onProgress)
      const stored = await cache.match(url)
      if (!stored) throw new Error(`cache write failed for ${url}`)
      // the ONE full in-memory copy, read back from the (disk-backed) cache
      return stored.arrayBuffer()
    } catch (e) {
      lastErr = e
      if ((e as { permanent?: boolean }).permanent) break
      if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
