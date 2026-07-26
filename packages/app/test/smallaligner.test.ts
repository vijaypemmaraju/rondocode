import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PHONEME_INT8_MODEL_URL,
  PHONEME_MODEL_URL,
  phonemeModelUrls,
  preferSmallAligner,
} from '../src/sing/config'
import { cachedBytes, firstAvailableBytes } from '../src/sing/modelcache'

/* The small-aligner selection + fallback contract (PR: phones get the ~3.5x
 * smaller int8 phoneme model): iOS or the opt-in flag prefers the int8 URL,
 * the fp32 URL is ALWAYS the fallback (so a not-yet-uploaded int8 build can
 * never brick singing), and a 404 fails fast instead of burning retries. */

describe('phonemeModelUrls', () => {
  it('prefers the int8 build with the fp32 build as fallback when small', () => {
    expect(phonemeModelUrls(true)).toEqual([PHONEME_INT8_MODEL_URL, PHONEME_MODEL_URL])
  })

  it('uses only the fp32 build otherwise', () => {
    expect(phonemeModelUrls(false)).toEqual([PHONEME_MODEL_URL])
  })

  it('the two builds live at SING_MODELS_BASE under the documented names', () => {
    expect(PHONEME_MODEL_URL.endsWith('/phoneme.onnx')).toBe(true)
    expect(PHONEME_INT8_MODEL_URL.endsWith('/phoneme-int8.onnx')).toBe(true)
  })
})

describe('preferSmallAligner', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('is false in a plain node environment (no iOS UA, no flag)', () => {
    expect(preferSmallAligner()).toBe(false)
  })

  it('the rc.singSmallAligner opt-in flag turns it on anywhere', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (k === 'rc.singSmallAligner' ? '1' : null),
    }
    expect(preferSmallAligner()).toBe(true)
  })

  it('a throwing localStorage (storage blocked) falls back to the UA check', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(preferSmallAligner()).toBe(false)
  })
})

describe('firstAvailableBytes', () => {
  it('returns the first URL that loads', async () => {
    const buf = new ArrayBuffer(4)
    const calls: string[] = []
    const got = await firstAvailableBytes(['a', 'b'], async (u) => {
      calls.push(u)
      return buf
    })
    expect(got).toEqual({ url: 'a', buf })
    expect(calls).toEqual(['a'])
  })

  it('falls through to the next URL when an earlier one fails (int8 404 → fp32)', async () => {
    const buf = new ArrayBuffer(4)
    const got = await firstAvailableBytes(['int8', 'fp32'], async (u) => {
      if (u === 'int8') throw new Error('404 Not Found for int8')
      return buf
    })
    expect(got.url).toBe('fp32')
  })

  it('throws the LAST failure when every URL fails', async () => {
    await expect(
      firstAvailableBytes(['a', 'b'], async (u) => {
        throw new Error(`down: ${u}`)
      }),
    ).rejects.toThrow('down: b')
  })

  it('throws rather than resolving on an empty URL list', async () => {
    await expect(firstAvailableBytes([], async () => new ArrayBuffer(0))).rejects.toThrow()
  })
})

describe('cachedBytes 404 fail-fast', () => {
  it('does not retry a 404 (deterministic miss: the fallback URL should run instead)', async () => {
    const stored = new Map<string, Uint8Array>()
    ;(globalThis as { caches?: unknown }).caches = {
      open: async () => ({
        match: async (url: string) => {
          const hit = stored.get(url)
          return hit === undefined ? undefined : new Response(hit.slice())
        },
        put: async (url: string, res: Response) => {
          stored.set(url, new Uint8Array(await res.arrayBuffer()))
        },
        delete: async (url: string) => stored.delete(url),
      }),
    }
    const realFetch = globalThis.fetch
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }))
    ;(globalThis as { fetch: unknown }).fetch = fetchSpy
    try {
      await expect(cachedBytes('https://x/phoneme-int8.onnx', 'test-cache')).rejects.toThrow(/404/)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { caches?: unknown }).caches
      globalThis.fetch = realFetch
    }
  })
})
