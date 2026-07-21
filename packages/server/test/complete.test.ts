import { describe, expect, it } from 'vitest'
import {
  CompletionService,
  RateLimiter,
  compactCheatsheet,
  completePrompt,
  makeCompleteHandler,
  parseDotEnv,
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

describe('compactCheatsheet', () => {
  const sheet = compactCheatsheet()
  it('is compact (<5KB) and grouped', () => {
    // Signature-only, grouped; grows as the DSL gains primitives. Kept well
    // under the model's context — a few KB is lean for a completion prompt.
    expect(sheet.length).toBeLessThan(5120)
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

  it('rate-limits after 30 requests in a minute', async () => {
    const svc = new CompletionService({
      apiKey: 'sk-test',
      createClient: () => fakeClient('.fast(2)'),
      now: () => 5000,
    })
    let last
    for (let i = 0; i < 31; i++) last = await svc.complete('p(', '')
    expect(last).toEqual({ completion: null, reason: 'rate-limited' })
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
})
