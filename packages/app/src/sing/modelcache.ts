/* ------------------------------------------------------------------------- *
 * Shared model fetch + Cache API storage for the singing models. They're large
 * (100 MB – 1.2 GB), so: report byte progress, retry a transient failure with
 * backoff (a blip mid-download shouldn't fail the whole load), and only ever
 * cache a FULLY-read response (never a truncated one). One-time download, then
 * served from the cache offline.
 * ------------------------------------------------------------------------- */

const RETRIES = 3

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
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      let buf: ArrayBuffer
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
        const out = new Uint8Array(loaded)
        let off = 0
        for (const c of chunks) {
          out.set(c, off)
          off += c.length
        }
        buf = out.buffer
      } else {
        buf = await res.arrayBuffer()
      }
      await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }))
      return buf
    } catch (e) {
      lastErr = e
      if (attempt < RETRIES - 1) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
