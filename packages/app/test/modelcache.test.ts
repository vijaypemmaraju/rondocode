import { describe, expect, it } from 'vitest'
import { streamIntoCache } from '../src/sing/modelcache'
import type { CacheLike } from '../src/sing/modelcache'

/* The model download's memory contract: bytes stream INTO the cache through a
 * counting transform, never accumulating in the JS heap, and a truncated body
 * is never kept. Exercised with a stub cache that consumes the streamed
 * Response the way the real Cache API does. */

function stubCache(): CacheLike & { stored: Map<string, Uint8Array>; deletes: string[] } {
  const stored = new Map<string, Uint8Array>()
  const deletes: string[] = []
  return {
    stored,
    deletes,
    async put(url, res): Promise<void> {
      stored.set(url, new Uint8Array(await res.arrayBuffer()))
    },
    async match(url): Promise<Response | undefined> {
      const hit = stored.get(url)
      return hit === undefined ? undefined : new Response(hit.slice())
    },
    async delete(url): Promise<boolean> {
      deletes.push(url)
      return stored.delete(url)
    },
  }
}

const chunkedResponse = (chunks: Uint8Array[], contentLength: number): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      for (const c of chunks) ctrl.enqueue(c)
      ctrl.close()
    },
  })
  return new Response(body, { headers: { 'content-length': String(contentLength) } })
}

describe('streamIntoCache', () => {
  it('streams the body into the cache and reports per-chunk progress', async () => {
    const cache = stubCache()
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])]
    const seen: number[] = []
    await streamIntoCache(chunkedResponse(chunks, 6), cache, 'u', (loaded) => seen.push(loaded))
    expect([...cache.stored.get('u')!]).toEqual([1, 2, 3, 4, 5, 6])
    expect(seen).toEqual([3, 5, 6])
  })

  it('a truncated body (loaded < content-length) throws and deletes the entry', async () => {
    const cache = stubCache()
    const short = chunkedResponse([new Uint8Array([1, 2])], 100)
    await expect(streamIntoCache(short, cache, 'u')).rejects.toThrow(/truncated/)
    expect(cache.deletes).toContain('u')
    expect(cache.stored.has('u')).toBe(false)
  })

  it('an erroring stream rejects and deletes any partial entry', async () => {
    const cache = stubCache()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl): void {
        ctrl.enqueue(new Uint8Array([1]))
        ctrl.error(new Error('network blip'))
      },
    })
    const res = new Response(body, { headers: { 'content-length': '10' } })
    await expect(streamIntoCache(res, cache, 'u')).rejects.toThrow()
    expect(cache.deletes).toContain('u')
  })

  it('missing content-length still stores everything (no truncation check possible)', async () => {
    const cache = stubCache()
    const body = new ReadableStream<Uint8Array>({
      start(ctrl): void {
        ctrl.enqueue(new Uint8Array([7, 8]))
        ctrl.close()
      },
    })
    await streamIntoCache(new Response(body), cache, 'u')
    expect([...cache.stored.get('u')!]).toEqual([7, 8])
  })
})
