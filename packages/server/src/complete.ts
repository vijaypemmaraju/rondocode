/* ------------------------------------------------------------------------- *
 * complete.ts — the LLM ghost-text completion endpoint. The browser editor
 * POSTs {prefix, suffix} on idle; we ask a small Claude model to continue the
 * code and return {completion}. Tuned for rondocode's DSL via a compact
 * cheatsheet generated from the same docs data as the editor's intellisense
 * (packages/app/src/docs/dsl-docs.ts) plus a few-shot pair.
 *
 * The ANTHROPIC_API_KEY is read server-side only (from process.env or a
 * repo-root .env) and NEVER reaches the browser. With no key the service
 * reports unavailable and the editor silently disables ghost text.
 *
 * The pure pieces (compactCheatsheet, completePrompt, stripCompletion,
 * RateLimiter) are unit-tested; the Anthropic client is injected so tests
 * never touch the network.
 * ------------------------------------------------------------------------- */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Deep read-only import of the docs DATA (pure, no DOM) — same source the
// editor's completions/hover use, so the model's vocabulary can't drift.
import { DSL_DOCS } from '../../app/src/docs/dsl-docs'
import type { DocEntry } from '../../app/src/docs/dsl-docs'

export const COMPLETION_MODEL = 'claude-haiku-4-5-20251001'

// ---- .env loading (no dependency; ~current process.env wins) --------------

/** Walk up from `startDir` looking for a .env, parse KEY=value lines, and
 *  return the parsed map. Missing file → {}. process.env is NOT mutated. */
export function loadDotEnv(startDir: string = process.cwd()): Record<string, string> {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    try {
      const text = readFileSync(join(dir, '.env'), 'utf8')
      return parseDotEnv(text)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return {}
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** ANTHROPIC_API_KEY from the environment, falling back to a repo-root .env. */
export function resolveApiKey(): string | undefined {
  return process.env['ANTHROPIC_API_KEY'] ?? loadDotEnv()['ANTHROPIC_API_KEY']
}

// ---- prompt construction (pure) -------------------------------------------

/** A ~2KB signature-only cheatsheet grouped by kind — enough for the model to
 *  use the right names/arities without the full markdown reference. */
export function compactCheatsheet(docs: readonly DocEntry[] = DSL_DOCS): string {
  const groups: [DocEntry['kind'], string][] = [
    ['global', 'Top-level'],
    ['pattern-method', 'Pattern methods (chain after a pattern)'],
    ['synth-ctx', 'Inside synth(({ ... }) => ...): context members'],
    ['sig-method', 'Signal (Sig) methods'],
    ['mini-syntax', 'Mini-notation (inside pattern strings)'],
  ]
  const lines: string[] = []
  for (const [kind, title] of groups) {
    const items = docs.filter((d) => d.kind === kind)
    if (items.length === 0) continue
    lines.push(`# ${title}`)
    for (const d of items) lines.push(d.signature)
  }
  return lines.join('\n')
}

/** Few-shot exemplars: (prefix ending mid-idiom) → (continuation). Hand-crafted
 *  from the shipped example idioms so the model learns house style. */
const FEW_SHOT: { prefix: string; completion: string }[] = [
  {
    prefix: "p('bass', n('0 3 5 7').scale('a minor').sound('acid').ctrl('cutoff', ",
    completion: 'sine.range(300, 2400).slow(4)))',
  },
  {
    prefix:
      'const kick = synth(({ gate, adsr, sine }) => {\n  const env = adsr(gate, { a: 0.001, d: 0.2, s: 0, r: 0.05 })\n  ',
    completion: 'return sine(env.pow(3).range(45, 160)).mul(env).tanh()\n})',
  },
  {
    prefix: "p('hats', note('c5*8').sound('hat').euclid(5, 8)",
    completion: '.swing(4).gain(rand.range(0.5, 1)))',
  },
]

export interface PromptParts {
  system: string
  user: string
}

export function completePrompt(
  prefix: string,
  suffix: string,
  cheatsheet: string = compactCheatsheet(),
): PromptParts {
  const shots = FEW_SHOT.map(
    (s) => `PREFIX:\n${s.prefix}\nCOMPLETION:\n${s.completion}`,
  ).join('\n\n')
  const system =
    'You complete code in rondocode, a live-coding music DSL (synths are ' +
    'code-defined DSP graphs; patterns use mini-notation + chainable ' +
    'combinators). Given the code before the cursor (PREFIX) and after ' +
    '(SUFFIX), return ONLY the code that continues from exactly where PREFIX ' +
    'ends — no prose, no markdown fences, no repetition of the prefix. Prefer ' +
    'completing the current expression or line; at most 3 lines.\n\n' +
    'DSL cheatsheet:\n' +
    cheatsheet +
    '\n\nExamples:\n' +
    shots
  const user =
    `<prefix>\n${prefix.slice(-2000)}\n</prefix>\n` +
    `<suffix>\n${suffix.slice(0, 500)}\n</suffix>\n` +
    'Continue at the end of <prefix>.'
  return { system, user }
}

// ---- response post-processing (pure) --------------------------------------

/** Clean a raw model completion: strip markdown fences, drop any echo of the
 *  prefix's tail, and cap at 3 lines. Empty → null. */
export function stripCompletion(raw: string, prefix: string): string | null {
  let s = raw
  // Strip a leading ```lang fence and a trailing ``` fence if present.
  s = s.replace(/^\s*```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '')
  // Models sometimes echo the last token(s) of the prefix. If our text starts
  // with a suffix of the prefix (>= 3 chars), drop that overlap.
  const tail = prefix.slice(-40)
  for (let n = Math.min(tail.length, s.length); n >= 3; n--) {
    if (tail.endsWith(s.slice(0, n))) {
      s = s.slice(n)
      break
    }
  }
  // Cap at 3 lines.
  const lines = s.split('\n')
  if (lines.length > 3) s = lines.slice(0, 3).join('\n')
  // Trim trailing whitespace but preserve leading (indentation continuation).
  s = s.replace(/\s+$/, '')
  return s === '' ? null : s
}

// ---- rate limiting (injectable clock) -------------------------------------

export class RateLimiter {
  private readonly hits: number[] = []
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record an attempt; true if allowed, false if over budget. */
  take(): boolean {
    const t = this.now()
    const cutoff = t - this.windowMs
    while (this.hits.length > 0 && this.hits[0]! < cutoff) this.hits.shift()
    if (this.hits.length >= this.max) return false
    this.hits.push(t)
    return true
  }
}

// ---- the service ----------------------------------------------------------

export type CompletionReason = 'no-key' | 'error' | 'rate-limited'
export interface CompletionResult {
  completion: string | null
  reason?: CompletionReason
}

/** Minimal shape of the Anthropic messages client we use — injectable. */
export interface MessagesClient {
  messages: {
    create(params: {
      model: string
      max_tokens: number
      temperature: number
      system: string
      messages: { role: 'user'; content: string }[]
      stop_sequences?: string[]
    }): Promise<{ content: { type: string; text?: string }[] }>
  }
}

export interface CompletionServiceOpts {
  apiKey?: string
  /** Build the Anthropic client from a key (injected in tests). */
  createClient?: (apiKey: string) => MessagesClient
  now?: () => number
  timeoutMs?: number
}

export class CompletionService {
  private client: MessagesClient | undefined
  private readonly limiter: RateLimiter
  private readonly timeoutMs: number

  constructor(opts?: CompletionServiceOpts) {
    const key = opts?.apiKey ?? resolveApiKey()
    this.timeoutMs = opts?.timeoutMs ?? 5000
    this.limiter = new RateLimiter(30, 60_000, opts?.now)
    if (key !== undefined && key !== '' && opts?.createClient !== undefined) {
      this.client = opts.createClient(key)
    } else if (key !== undefined && key !== '') {
      // Lazy default client so tests without a factory still report available
      // by key presence but never construct a real network client here.
      this.client = undefined
      this.pendingKey = key
    }
  }

  private pendingKey: string | undefined

  get available(): boolean {
    return this.client !== undefined || this.pendingKey !== undefined
  }

  /** Ensure a real client exists (lazy import of the SDK on first use). */
  private async ensureClient(): Promise<MessagesClient | undefined> {
    if (this.client !== undefined) return this.client
    if (this.pendingKey === undefined) return undefined
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    this.client = new Anthropic({ apiKey: this.pendingKey }) as unknown as MessagesClient
    this.pendingKey = undefined
    return this.client
  }

  async complete(prefix: string, suffix: string): Promise<CompletionResult> {
    if (!this.available) return { completion: null, reason: 'no-key' }
    if (!this.limiter.take()) return { completion: null, reason: 'rate-limited' }
    const client = await this.ensureClient()
    if (client === undefined) return { completion: null, reason: 'no-key' }
    const { system, user } = completePrompt(prefix, suffix)
    try {
      const resp = await withTimeout(
        // No stop_sequences: the API rejects whitespace-only stops, and
        // max_tokens + the 3-line cap in stripCompletion already bound length.
        client.messages.create({
          model: COMPLETION_MODEL,
          max_tokens: 128,
          temperature: 0.2,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        this.timeoutMs,
      )
      const raw = resp.content
        .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
        .join('')
      return { completion: stripCompletion(raw, prefix) }
    } catch (e) {
      console.error('[complete] request failed:', e instanceof Error ? e.message : e)
      return { completion: null, reason: 'error' }
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`completion timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

// ---- http handler ---------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

/**
 * Returns an http handler that answers the two completion routes and reports
 * whether it handled the request (so the bridge can 404 everything else).
 * Routes: `POST /complete` {prefix, suffix} → {completion, reason?};
 * `GET /complete/status` → {available}.
 */
export function makeCompleteHandler(
  service: CompletionService,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const url = req.url ?? ''
    const path = url.split('?')[0]
    if (path !== '/complete' && path !== '/complete/status') return false

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return true
    }
    if (path === '/complete/status' && req.method === 'GET') {
      sendJson(res, 200, { available: service.available })
      return true
    }
    if (path === '/complete' && req.method === 'POST') {
      readBody(req)
        .then(async (body) => {
          let prefix = ''
          let suffix = ''
          try {
            const parsed = JSON.parse(body) as { prefix?: unknown; suffix?: unknown }
            if (typeof parsed.prefix === 'string') prefix = parsed.prefix
            if (typeof parsed.suffix === 'string') suffix = parsed.suffix
          } catch {
            sendJson(res, 400, { completion: null, reason: 'error' })
            return
          }
          const result = await service.complete(prefix, suffix)
          sendJson(res, 200, result)
        })
        .catch(() => sendJson(res, 500, { completion: null, reason: 'error' }))
      return true
    }
    res.writeHead(405, CORS)
    res.end()
    return true
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 200_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}
