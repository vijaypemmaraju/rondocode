import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompletionService,
  RateLimiter,
  compactCheatsheet,
  completePrompt,
  loadDotEnv,
  makeCompleteHandler,
  parseDotEnv,
  resolveApiKey,
  stripCompletion,
} from '../src/complete'
import type { MessagesClient } from '../src/complete'

describe('parseDotEnv', () => {
  it('parses KEY=value lines, ignoring comments/blanks and quotes', () => {
    const env = parseDotEnv('# c\nANTHROPIC_API_KEY="sk-abc"\n\nX = 1\nBAD\n')
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-abc')
    expect(env['X']).toBe('1')
    expect(env['BAD']).toBeUndefined()
  })
})

describe('loadDotEnv / resolveApiKey', () => {
  let base: string
  afterEach(() => {
    vi.restoreAllMocks()
    if (base !== undefined) rmSync(base, { recursive: true, force: true })
  })

  /** base/.env plus a chain of empty subdirs base/d1/d2/.../dN. */
  const rig = (depth: number): string => {
    base = mkdtempSync(join(tmpdir(), 'rondocode-dotenv-'))
    writeFileSync(join(base, '.env'), 'ANTHROPIC_API_KEY=sk-from-file\n')
    let dir = base
    for (let i = 1; i <= depth; i++) {
      dir = join(dir, `d${i}`)
      mkdirSync(dir)
    }
    return dir
  }

  it('walks up parent directories to find the .env', () => {
    const start = rig(3)
    expect(loadDotEnv(start)).toEqual({ ANTHROPIC_API_KEY: 'sk-from-file' })
  })

  it('gives up after six levels (missing .env → {})', () => {
    // The .env sits SEVEN levels above the start dir — one past the walk cap —
    // so the lookup comes back empty instead of scanning to the filesystem root.
    const start = rig(7)
    expect(loadDotEnv(start)).toEqual({})
  })

  it('resolveApiKey prefers process.env over the .env file, falling back when unset', () => {
    const start = rig(1)
    vi.spyOn(process, 'cwd').mockReturnValue(start)
    const saved = process.env['ANTHROPIC_API_KEY']
    try {
      process.env['ANTHROPIC_API_KEY'] = 'sk-from-env'
      expect(resolveApiKey()).toBe('sk-from-env')
      delete process.env['ANTHROPIC_API_KEY']
      expect(resolveApiKey()).toBe('sk-from-file')
    } finally {
      if (saved === undefined) delete process.env['ANTHROPIC_API_KEY']
      else process.env['ANTHROPIC_API_KEY'] = saved
    }
  })
})

describe('compactCheatsheet', () => {
  const sheet = compactCheatsheet()
  it('is compact (<8KB) and grouped', () => {
    // Signature-only, grouped; grows as the DSL gains primitives (FM, physical
    // modeling, chip/filter FX...). Kept well under the model's context — a few
    // KB is lean for a completion prompt.
    expect(sheet.length).toBeLessThan(8192)
    expect(sheet).toContain('# Top-level')
    expect(sheet).toContain('# Pattern methods')
    expect(sheet).toContain('# Mini-notation')
  })
  it('contains key DSL signatures', () => {
    expect(sheet).toMatch(/euclid\(/)
    expect(sheet).toMatch(/sound\(/)
    expect(sheet).toMatch(/adsr\(/)
  })
})

describe('completePrompt', () => {
  const { system, user } = completePrompt('const x = sine(', ')')
  it('embeds the cheatsheet, few-shots, and rules', () => {
    expect(system).toContain('DSL cheatsheet:')
    expect(system).toContain('euclid(')
    expect(system).toContain('Examples:')
    expect(system).toMatch(/no markdown fences|no prose/i)
  })
  it('wraps prefix/suffix', () => {
    expect(user).toContain('<prefix>')
    expect(user).toContain('const x = sine(')
    expect(user).toContain('<suffix>')
  })
})

describe('stripCompletion', () => {
  it('strips markdown fences', () => {
    expect(stripCompletion('```js\n.fast(2)\n```', 'p(')).toBe('.fast(2)')
  })
  it('drops an echoed prefix tail', () => {
    // prefix ends with "sine(" and model echoes it
    expect(stripCompletion('sine(note.freq)', 'const x = sine(')).toBe('note.freq)')
  })
  it('caps at 3 lines', () => {
    expect(stripCompletion('a\nb\nc\nd\ne', 'x')).toBe('a\nb\nc')
  })
  it('empty → null', () => {
    expect(stripCompletion('   \n  ', 'x')).toBeNull()
    expect(stripCompletion('```\n```', 'x')).toBeNull()
  })
})

describe('RateLimiter', () => {
  it('allows up to max within the window, then blocks, then recovers', () => {
    let now = 1000
    const rl = new RateLimiter(3, 1000, () => now)
    expect(rl.take()).toBe(true)
    expect(rl.take()).toBe(true)
    expect(rl.take()).toBe(true)
    expect(rl.take()).toBe(false) // over budget
    now += 1001 // window elapsed
    expect(rl.take()).toBe(true)
  })
})

// ---- service with an injected client --------------------------------------

const fakeClient = (text: string): MessagesClient => ({
  messages: {
    create: () => Promise.resolve({ content: [{ type: 'text', text }] }),
  },
})

describe('CompletionService', () => {
  it('reports unavailable and returns no-key without a key', async () => {
    const svc = new CompletionService({ apiKey: '' })
    expect(svc.available).toBe(false)
    expect(await svc.complete('p(', '')).toEqual({ completion: null, reason: 'no-key' })
  })

  it('returns a cleaned completion via the injected client', async () => {
    const svc = new CompletionService({
      apiKey: 'sk-test',
      createClient: () => fakeClient('```\n.euclid(3, 8)\n```'),
    })
    expect(svc.available).toBe(true)
    expect(await svc.complete("p('h', note('c5*8')", '')).toEqual({ completion: '.euclid(3, 8)' })
  })

  it('maps client errors to reason:error', async () => {
    const svc = new CompletionService({
      apiKey: 'sk-test',
      createClient: () => ({
        messages: { create: () => Promise.reject(new Error('boom')) },
      }),
    })
    expect(await svc.complete('p(', '')).toEqual({ completion: null, reason: 'error' })
  })

  it('rate-limits after 30 requests in a minute — and the first 30 all succeed', async () => {
    const svc = new CompletionService({
      apiKey: 'sk-test',
      createClient: () => fakeClient('.fast(2)'),
      now: () => 5000,
    })
    // The first 30 must NOT be rate-limited (an inverted or zero-budget
    // limiter would fail here, not just at the 31st call).
    for (let i = 0; i < 30; i++) {
      expect(await svc.complete('p(', ''), `call ${i + 1} of 30`).toEqual({ completion: '.fast(2)' })
    }
    expect(await svc.complete('p(', '')).toEqual({ completion: null, reason: 'rate-limited' })
  })

  it('a hung provider call resolves to reason:error within the injected timeout', async () => {
    const svc = new CompletionService({
      apiKey: 'sk-test',
      // Never settles — only withTimeout can end this call.
      createClient: () => ({ messages: { create: () => new Promise(() => {}) } }),
      timeoutMs: 25,
    })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const t0 = Date.now()
      const result = await svc.complete('p(', '')
      expect(result).toEqual({ completion: null, reason: 'error' })
      expect(Date.now() - t0).toBeLessThan(2000) // resolved by the 25ms timer, not a hang
      expect(String(err.mock.calls[0])).toContain('timed out after 25ms')
    } finally {
      err.mockRestore()
    }
  })
})

// ---- http handler ---------------------------------------------------------

import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

const mockReqRes = (method: string, url: string, body?: string) => {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  const res = new ServerResponse(req)
  const chunks: string[] = []
  let statusCode = 0
  const headers: Record<string, unknown> = {}
  res.writeHead = ((code: number, h?: Record<string, unknown>) => {
    statusCode = code
    Object.assign(headers, h)
    return res
  }) as typeof res.writeHead
  res.end = ((chunk?: string) => {
    if (chunk !== undefined) chunks.push(chunk)
    return res
  }) as typeof res.end
  // Feed the body asynchronously.
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', body)
      req.emit('end')
    }, 0)
  }
  return { req, res, get: () => ({ statusCode, headers, body: chunks.join('') }) }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('makeCompleteHandler', () => {
  it('reports availability and sends CORS on status', () => {
    const handler = makeCompleteHandler(new CompletionService({ apiKey: 'sk-x', createClient: () => fakeClient('') }))
    const { req, res, get } = mockReqRes('GET', '/complete/status')
    expect(handler(req, res)).toBe(true)
    const out = get()
    expect(out.statusCode).toBe(200)
    expect(out.headers['access-control-allow-origin']).toBe('*')
    expect(JSON.parse(out.body)).toEqual({ available: true })
  })

  it('ignores unrelated paths', () => {
    const handler = makeCompleteHandler(new CompletionService({ apiKey: '' }))
    const { req, res } = mockReqRes('GET', '/session')
    expect(handler(req, res)).toBe(false)
  })

  it('answers POST /complete with a completion', async () => {
    const handler = makeCompleteHandler(
      new CompletionService({ apiKey: 'sk-x', createClient: () => fakeClient('.rev()') }),
    )
    const { req, res, get } = mockReqRes('POST', '/complete', JSON.stringify({ prefix: 'p(', suffix: '' }))
    expect(handler(req, res)).toBe(true)
    await settle()
    expect(JSON.parse(get().body)).toEqual({ completion: '.rev()' })
  })

  it('rejects a body over 200KB with a 500 error result', async () => {
    const handler = makeCompleteHandler(
      new CompletionService({ apiKey: 'sk-x', createClient: () => fakeClient('.rev()') }),
    )
    const { req, res, get } = mockReqRes('POST', '/complete', 'x'.repeat(200_001))
    expect(handler(req, res)).toBe(true)
    await settle()
    const out = get()
    expect(out.statusCode).toBe(500)
    expect(JSON.parse(out.body)).toEqual({ completion: null, reason: 'error' })
  })

  it('answers OPTIONS preflight with 204 and CORS headers', () => {
    const handler = makeCompleteHandler(new CompletionService({ apiKey: '' }))
    const { req, res, get } = mockReqRes('OPTIONS', '/complete')
    expect(handler(req, res)).toBe(true)
    const out = get()
    expect(out.statusCode).toBe(204)
    expect(out.headers['access-control-allow-origin']).toBe('*')
    expect(out.headers['access-control-allow-methods']).toContain('POST')
    expect(out.body).toBe('')
  })

  it('falls through to 405 on a wrong method for a known path', () => {
    const handler = makeCompleteHandler(new CompletionService({ apiKey: '' }))
    for (const [method, url] of [
      ['PUT', '/complete'],
      ['GET', '/complete'],
      ['POST', '/complete/status'],
    ] as const) {
      const { req, res, get } = mockReqRes(method, url)
      expect(handler(req, res), `${method} ${url} should be handled`).toBe(true)
      const out = get()
      expect(out.statusCode, `${method} ${url}`).toBe(405)
      expect(out.headers['access-control-allow-origin']).toBe('*')
    }
  })
})
