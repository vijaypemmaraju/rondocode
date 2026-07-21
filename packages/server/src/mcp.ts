/* ------------------------------------------------------------------------- *
 * MCP server: the agent-facing surface of rondocode. Composes a Bridge (the
 * ws link to the browser Session, see bridge.ts) into an McpServer exposing
 *
 * - tools: get_code / eval_code / set_param / set_channel / transport /
 *   get_state / get_diagnostics — thin wrappers over bridge.call with the
 *   Session's remote-method vocabulary (main.ts handler map). Every tool
 *   answers a missing browser with an isError result carrying an actionable
 *   message (see NO_SESSION) instead of a protocol error: agents should read
 *   it and tell the human to open the app, not crash their loop.
 * - render tools: render_code / render_synth / compare_renders — the
 *   agent's EARS. Registered from render-tools.ts; fully server-side
 *   (eval + offline render + analysis), they need NO browser and keep
 *   working while every live tool above reports NO_SESSION.
 * - resources: rondocode://docs/{dsl-reference,agent-guide,examples} —
 *   dsl-reference and examples are GENERATED from the app package's data
 *   modules (docs-gen.ts), agent-guide is docs/reference/agent-guide.md
 *   served verbatim (read per request, so doc edits show up live).
 *
 * Notification cache: the browser pushes {notify:'state'|'diagnostics'}
 * frames (state on connect, after every handled request, and on a 2s
 * heartbeat; diagnostics only via future seams — eval results already carry
 * eval diagnostics). This module caches the latest of each with an arrival
 * timestamp; get_diagnostics reports them with ageMs so an agent can judge
 * staleness. Creating the server ASSIGNS bridge.onNotify (sole listener).
 *
 * Transport-agnostic: no stdio here — mcp-stdio.ts owns process wiring and
 * the stderr-only logging rule; tests connect via InMemoryTransport.
 * ------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Bridge } from './bridge'
import { dslReferenceMarkdown, examplesMarkdown } from './docs-gen'
import { registerRenderTools } from './render-tools'
import type { RenderDirs } from './render-tools'
// Deep read-only imports from the app package source (pure data modules —
// no DOM, no deps; @rondocode/app has no exports map for deep specifiers,
// hence the relative paths). Diagnostic is the shape eval_code returns.
import { DSL_DOCS } from '../../app/src/docs/dsl-docs'
import { EXAMPLES } from '../../app/src/examples/index'
import type { Diagnostic } from '../../app/src/session/evalCode'

/** What every tool reports when no browser session is attached to the
 *  bridge. Actionable on purpose: the fix is on the human's side. */
export const NO_SESSION = 'no browser session connected — open the rondocode app'

const AGENT_GUIDE_URL = new URL('../../../docs/reference/agent-guide.md', import.meta.url)

/** The subset of the browser's evalCode response worth relaying: the staged
 *  synth/pattern Maps JSON-serialize to {} over the wire — drop them. */
interface EvalRelay {
  ok: boolean
  diagnostics: Diagnostic[]
}

interface CachedNotify {
  payload: unknown
  /** Date.now() at arrival — reported to agents as ageMs. */
  at: number
}

// Fire-and-forget bridge methods (setParam/setChannel/transport) resolve
// undefined — report `{ ok: true }` so every tool returns parseable JSON.
const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value === undefined ? { ok: true } : value, null, 2) }],
})

const fail = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})

export interface McpServerOpts {
  /** WAV output dirs for the render tools — injectable so tests write to
   *  temp dirs instead of renders/ and the human's synced folder. */
  renderDirs?: Partial<RenderDirs>
}

export function createMcpServer(bridge: Bridge, opts?: McpServerOpts): McpServer {
  const server = new McpServer({ name: 'rondocode', version: '0.1.0' })

  const cache: { state?: CachedNotify; diagnostics?: CachedNotify } = {}
  bridge.onNotify = (kind, payload) => {
    if (kind === 'state' || kind === 'diagnostics') {
      cache[kind] = { payload, at: Date.now() }
    }
    // 'hello' carries only the client's own url — nothing an agent needs.
  }

  /** Gate on a connected browser, run the bridge call, map failures to
   *  isError results (bridge rejections are strings agents can act on). */
  const viaBridge = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    if (!bridge.connected) return fail(NO_SESSION)
    try {
      return ok(await fn())
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return fail(message === 'no session connected' ? NO_SESSION : message)
    }
  }

  // ---- tools -----------------------------------------------------------

  server.registerTool(
    'get_code',
    {
      description:
        'Read the program currently in the live rondocode session: `code` is the last source that evaluated successfully (the running program), `lastAttempted` is the last source handed to eval even if it failed. Call this before eval_code — evals replace the whole program, so start from what is already playing.',
      inputSchema: {},
    },
    () => viaBridge(() => bridge.call('getCode')),
  )

  server.registerTool(
    'eval_code',
    {
      description:
        'Evaluate a COMPLETE rondocode program in the live browser session and return { ok, diagnostics }. The source defines instruments (top-level `const x = synth(ctx => ...)`), registers patterns (`p(\'name\', n(\'0 3 5\').scale(\'a minor\').sound(\'x\'))`), and sets tempo (`setCps(0.5)`) — see the rondocode://docs resources first. Each eval replaces the entire program: anything omitted stops playing. On failure (ok: false) NOTHING changes — the previous program keeps playing and diagnostics carry line/col/message. Known v1 limitation: this evals into the session but does NOT rewrite the human\'s editor text; their editor keeps its own document, and if they press run, their text replaces your program.',
      inputSchema: {
        code: z.string().describe('Full rondocode source to evaluate (a whole program, not a diff)'),
      },
    },
    ({ code }) =>
      viaBridge(async () => {
        const r = (await bridge.call('evalCode', { source: code })) as EvalRelay
        return { ok: r.ok, diagnostics: r.diagnostics } satisfies EvalRelay
      }),
  )

  server.registerTool(
    'set_param',
    {
      description:
        "Set one live synth parameter to a numeric value — instant, no re-eval. Targets a knob the synth declared via param(), e.g. synth 'acid' name 'cutoff'. Optional rampMs glides to the value. Note: a pattern that drives the same param via .ctrl() will overwrite this on its next event.",
      inputSchema: {
        synth: z.string().describe('Registered synth name (see get_state)'),
        name: z.string().describe("Parameter name declared by param() in the synth, e.g. 'cutoff'"),
        value: z.number().describe('New value, in the units the param declared'),
        rampMs: z.number().optional().describe('Glide time in milliseconds (default: immediate)'),
      },
    },
    ({ synth, name, value, rampMs }) =>
      viaBridge(() =>
        bridge.call('setParam', rampMs === undefined ? { addr: `${synth}.${name}`, value } : { addr: `${synth}.${name}`, value, rampMs }),
      ),
  )

  server.registerTool(
    'set_channel',
    {
      description:
        "Set a synth's mixer channel: gain (0..1) and/or pan (0 left, 0.5 center, 1 right). Affects everything that synth plays. An unknown synth name is silently ignored by the browser (live-coding renames race mixer moves by design).",
      inputSchema: {
        synth: z.string().describe('Registered synth name (see get_state)'),
        gain: z.number().optional().describe('Channel gain 0..1'),
        pan: z.number().optional().describe('Stereo position 0..1 (0 left, 0.5 center, 1 right)'),
      },
    },
    ({ synth, gain, pan }) =>
      viaBridge(() => bridge.call('setChannel', { synth, gain, pan })),
  )

  server.registerTool(
    'transport',
    {
      description:
        "Start or stop playback. 'play' (re)starts the pattern scheduler from cycle 0 — nothing sounds until you play; 'stop' halts it and silences all notes. Optional cps sets tempo in cycles per second, clamped to 0.05..4 (0.5 cps at 4 beats per cycle = 120 bpm).",
      inputSchema: {
        action: z.enum(['play', 'stop']).describe("'play' to start from cycle 0, 'stop' to halt and silence"),
        cps: z.number().optional().describe('Tempo in cycles per second (clamped 0.05..4)'),
      },
    },
    ({ action, cps }) =>
      viaBridge(() => bridge.call('transport', cps === undefined ? { cmd: action } : { cmd: action, cps })),
  )

  server.registerTool(
    'get_state',
    {
      description:
        'Get the live session state: playing (bool), cps (tempo), registered synth and pattern names, lastError if any, plus connected (browser link up). Use it to discover what exists before eval_code and to confirm what a tool call did.',
      inputSchema: {},
    },
    () =>
      viaBridge(async () => {
        const state = await bridge.call('getState')
        return { connected: bridge.connected, state }
      }),
  )

  server.registerTool(
    'get_diagnostics',
    {
      description:
        "Get the most recent 'diagnostics' and 'state' notifications the browser pushed, each with ageMs since arrival (null when never received). Use it to catch RUNTIME errors (source 'scheduler'/'engine') that happen after an eval while patterns play; eval-time diagnostics already come back in eval_code's own result.",
      inputSchema: {},
    },
    () => {
      // Unlike the live tools this reads a server-side CACHE, which survives a
      // disconnect — so serve it even with no browser attached (with
      // connected:false and the ageMs telling the agent how stale it is)
      // rather than erroring away access to data we still hold.
      const now = Date.now()
      const view = (c: CachedNotify | undefined): { payload: unknown; ageMs: number } | null =>
        c === undefined ? null : { payload: c.payload, ageMs: now - c.at }
      return ok({
        connected: bridge.connected,
        diagnostics: view(cache.diagnostics),
        state: view(cache.state),
      })
    },
  )

  // ---- render tools (browser-free — see render-tools.ts) ---------------

  registerRenderTools(server, opts?.renderDirs)

  // ---- resources -------------------------------------------------------

  const markdown = (uri: URL, text: string) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
  })

  server.registerResource(
    'dsl-reference',
    'rondocode://docs/dsl-reference',
    {
      title: 'rondocode DSL reference',
      description:
        'Every name in the language — globals, pattern methods, synth-building context, signal math, mini-notation — with signature, musical summary and example. Read this before writing code for eval_code.',
      mimeType: 'text/markdown',
    },
    (uri) => markdown(uri, dslReferenceMarkdown(DSL_DOCS)),
  )

  server.registerResource(
    'agent-guide',
    'rondocode://docs/agent-guide',
    {
      title: 'rondocode agent guide',
      description:
        'How the system fits together and how to work it: eval semantics (whole-program replacement, last-good-version), the editor-sync limitation, typical workflows, reading diagnostics. Start here.',
      mimeType: 'text/markdown',
    },
    async (uri) => markdown(uri, await readFile(AGENT_GUIDE_URL, 'utf8')),
  )

  server.registerResource(
    'examples',
    'rondocode://docs/examples',
    {
      title: 'rondocode examples',
      description:
        'The five shipped example programs (acid, ambient bells, drum groove, fm keys, generative) — complete, known-working sources to seed eval_code.',
      mimeType: 'text/markdown',
    },
    (uri) => markdown(uri, examplesMarkdown(EXAMPLES)),
  )

  return server
}
