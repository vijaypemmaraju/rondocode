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
  /** The measure a quantized call landed on; absent when it was not held. */
  measure?: number
}

/** A quantized call is HELD in the browser until its boundary, so the bridge
 *  must wait longer than its usual 5 s. Two minutes covers a 32-bar phrase at
 *  the slowest tempo anyone plays; a transport that stops mid-wait does not
 *  strand the call, because the browser's timer fires regardless. */
const QUANTIZE_TIMEOUT_MS = 125_000

const QUANTIZE_DOC =
  'Hold this call until the next boundary that is a multiple of this many bars, then apply it there: 1 lands on the next bar line, 4 or 8 on the next phrase. The reply comes back when it has landed and carries `measure`, the bar it landed on. Ignored (applied at once) while the transport is stopped.'

const relay = (r: EvalRelay): EvalRelay =>
  r.measure === undefined ? { ok: r.ok, diagnostics: r.diagnostics } : { ok: r.ok, diagnostics: r.diagnostics, measure: r.measure }

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
        'Read the program currently in the live rondocode session: `code` is the last source that evaluated successfully (the running program, always JavaScript), `lastAttempted` is the last source handed to eval even if it failed, and `editor` is the text in the human\'s editor with the language it is in (`rondo` or `rondocode`) — the buffer edit_code edits, including any slider or knob they have dragged. Call this before eval_code — evals replace the whole program, so start from what is already playing.',
      inputSchema: {},
    },
    () =>
      viaBridge(async () => {
        const code = (await bridge.call('getCode')) as Record<string, unknown>
        // The buffer the human is looking at, in the language it is in. It is
        // what edit_code edits, and it carries every slider they have moved.
        const doc = (await bridge.call('getDoc')) as { text: string; lang: string }
        return { ...code, editor: doc }
      }),
  )

  server.registerTool(
    'eval_code',
    {
      description:
        'Evaluate a COMPLETE rondocode program in the live browser session and return { ok, diagnostics }. The source defines instruments (top-level `const x = synth(ctx => ...)`), registers patterns (`p(\'name\', n(\'0 3 5\').scale(\'a minor\').sound(\'x\'))`), and sets tempo (`setCps(0.5)`) — see the rondocode://docs resources first. Each eval replaces the entire program: anything omitted stops playing. On failure (ok: false) NOTHING changes — the previous program keeps playing and diagnostics carry line/col/message. Pass `lang` to eval THROUGH THE EDITOR: the source becomes the human\'s editor text in that language (`rondo` for the terse language, `rondocode` for the JavaScript DSL) and evals on the same path as their Run button, so they see your program, its sliders and knobs are theirs to drag, and edit_code can then change it a line at a time. On that path a failed eval still leaves the SOUND untouched, but your text is in their buffer. Without `lang` the source must be JavaScript and evals into the session only: their editor keeps its own document, and if they press run, their text replaces your program.',
      inputSchema: {
        code: z.string().describe('Full source to evaluate (a whole program, not a diff)'),
        lang: z
          .enum(['rondo', 'rondocode'])
          .optional()
          .describe("Language of `code`. Setting it writes the program into the human's editor; omit for a session-only JavaScript eval"),
        quantize: z.number().positive().optional().describe(QUANTIZE_DOC),
      },
    },
    ({ code, lang, quantize }) =>
      viaBridge(async () => {
        const params = { source: code, ...(lang === undefined ? {} : { lang }), ...(quantize === undefined ? {} : { quantize }) }
        const timeout = quantize === undefined ? undefined : QUANTIZE_TIMEOUT_MS
        return relay((await bridge.call(lang === undefined ? 'evalCode' : 'evalDoc', params, timeout)) as EvalRelay)
      }),
  )

  server.registerTool(
    'edit_code',
    {
      description:
        "Change the program a piece at a time: apply exact find-and-replace edits to the text in the human's editor, then eval the result on their Run path. This is the fast way to iterate while something plays — send the one line that changes instead of the whole program. Each `old` must occur EXACTLY ONCE in the text as it stands after the edits before it (get_code's `editor.text` is that text); an empty `new` deletes. All or nothing: if any edit does not match, nothing is written and the reply says which one. The language is whatever the editor is in. Returns { ok, diagnostics } like eval_code; on a failed eval the sound keeps the last good program while the editor holds your edited text.",
      inputSchema: {
        edits: z
          .array(
            z.object({
              old: z.string().min(1).describe('Exact text to find; must occur exactly once'),
              new: z.string().describe('Its replacement (empty deletes)'),
            }),
          )
          .min(1)
          .describe('Edits, applied in order'),
        quantize: z.number().positive().optional().describe(QUANTIZE_DOC),
      },
    },
    ({ edits, quantize }) =>
      viaBridge(async () => {
        const doc = (await bridge.call('getDoc')) as { text: string; lang: string }
        let text = doc.text
        for (const [i, e] of edits.entries()) {
          const first = text.indexOf(e.old)
          if (first === -1) throw new Error(`edit ${i + 1}: \`old\` not found in the editor text; nothing was changed`)
          if (text.indexOf(e.old, first + 1) !== -1) {
            throw new Error(`edit ${i + 1}: \`old\` occurs more than once; add surrounding text to make it unique. Nothing was changed`)
          }
          text = text.slice(0, first) + e.new + text.slice(first + e.old.length)
        }
        const params = { source: text, lang: doc.lang, ...(quantize === undefined ? {} : { quantize }) }
        return relay((await bridge.call('evalDoc', params, quantize === undefined ? undefined : QUANTIZE_TIMEOUT_MS)) as EvalRelay)
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
    'set_macro',
    {
      description:
        "Move a project-wide macro (declared with macro() / rondo `macro NAME`) on EVERY synth that reads it, at once. rampMs glides there instead of jumping, which is how to ease a whole track open or closed from one number: a build is one call with a long ramp. Returns { ok, sites }: sites is how many synths the macro reached, and ok is false when that is zero (no such macro, or nothing uses it). The written value in the editor is NOT changed, so the next eval returns the macro to the number in the text: once a ramp has landed, write the same value with edit_code to keep it.",
      inputSchema: {
        name: z.string().describe("Macro name, e.g. 'energy'"),
        value: z.number().describe("New value, in the macro's own range"),
        rampMs: z.number().optional().describe('Glide time in milliseconds (default: immediate)'),
        quantize: z.number().positive().optional().describe(QUANTIZE_DOC),
      },
    },
    ({ name, value, rampMs, quantize }) =>
      viaBridge(() =>
        bridge.call(
          'setMacro',
          { name, value, ...(rampMs === undefined ? {} : { rampMs }), ...(quantize === undefined ? {} : { quantize }) },
          quantize === undefined ? undefined : QUANTIZE_TIMEOUT_MS,
        ),
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
        "Control playback. 'play' (re)starts the pattern scheduler at fromMeasure (measure 1, the top, by default) — nothing sounds until you play; 'stop' halts it and silences all notes; 'pause' freezes the transport where it is, holding sounding notes and tails, and 'resume' continues from that exact point. Optional cps sets tempo in cycles per second, clamped to 0.05..4 (0.5 cps at 4 beats per cycle = 120 bpm). The reply carries the resulting state, with ok:false when the command was a no-op (pause while stopped, resume while running).",
      inputSchema: {
        action: z
          .enum(['play', 'stop', 'pause', 'resume'])
          .describe("'play' to start, 'stop' to halt and silence, 'pause' to freeze in place, 'resume' to continue"),
        cps: z.number().optional().describe('Tempo in cycles per second (clamped 0.05..4)'),
        fromMeasure: z
          .number()
          .int()
          .optional()
          .describe(
            'Measure to start playing at, counted from 1 like a score (one measure = one cycle = one bar). play only. A measure past the end of the song wraps, the way the song loops on its own.',
          ),
      },
    },
    ({ action, cps, fromMeasure }) =>
      viaBridge(() =>
        bridge.call('transport', {
          cmd: action,
          ...(cps === undefined ? {} : { cps }),
          ...(fromMeasure === undefined ? {} : { fromMeasure }),
        }),
      ),
  )

  server.registerTool(
    'get_state',
    {
      description:
        'Get the live session state: playing (bool), cps (tempo), registered synth and pattern names, lastError if any, plus connected (browser link up). While playing it also carries `position`: the measure the transport is in (counted from 1) and `phase`, how far through that bar it is (0..1), which is how to know where in a phrase a change will land. Use it to discover what exists before eval_code and to confirm what a tool call did.',
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
