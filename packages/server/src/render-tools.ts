/* ------------------------------------------------------------------------- *
 * render-tools: the agent's EARS. Three MCP tools that evaluate rondocode
 * source server-side (render-runner.ts), render it offline, and return
 * analyze() numbers — the feedback loop that lets an agent hear what it
 * wrote and iterate on sound design WITHOUT any browser. Unlike the live
 * tools in mcp.ts, these never touch the Bridge: they work with no browser
 * connected at all.
 *
 *   render_code     — full program: scheduler → per-synth stems → mix →
 *                     Analysis JSON (+ WAV on disk for the human).
 *   render_synth    — one synth, one note: the quick audition.
 *   compare_renders — render two programs, return both analyses plus b−a
 *                     deltas: "did my change do what I intended".
 *
 * WAV output goes to `dirs.rendersDir` (repo-root renders/, gitignored) and
 * is mirrored fail-open into `dirs.mirrorDir` (a Dropbox folder the human
 * watches). Both are injectable so tests write to temp dirs instead.
 * ------------------------------------------------------------------------- */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { renderMix, runPatterns, stageCode } from './render-runner'
import type { MixResult, StageResult } from './render-runner'
// Deep read-only imports from sibling package source (see mcp.ts header).
import { analyze, encodeWav16, renderOffline } from '../../engine/src/index'
import type { Analysis } from '../../engine/src/index'
import { clampCps } from '../../app/src/session/evalCode'

export interface RenderDirs {
  /** Where WAVs land; created on demand. Default: <repo root>/renders. */
  rendersDir: string
  /** Fail-open mirror copy (the human's synced folder); null disables. */
  mirrorDir: string | null
}

const DEFAULT_DIRS: RenderDirs = {
  rendersDir: fileURLToPath(new URL('../../../renders', import.meta.url)),
  mirrorDir: '/Users/vijaypemmaraju/Dropbox/rondocode-renders',
}

/** Release tail appended after the last cycle so envelopes ring out. */
const TAIL_SEC = 2
/** Hard ceiling on one render's total length (offline CPU guard). */
const MAX_RENDER_SEC = 120
/** Source size guard — nobody hand-writes 100 KB of rondocode. */
const MAX_CODE_BYTES = 100_000
/** Fallback tempo when neither the tool arg nor the code sets one
 *  (the Scheduler's own default). */
const DEFAULT_CPS = 0.5

const clampCycles = (c: number): number => Math.min(64, Math.max(1, Math.round(c)))

const round = (x: number, dp: number): number => {
  const f = 10 ** dp
  return Math.round(x * f) / f
}

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const fail = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})

const evalFail = (which: string, diagnostics: unknown): CallToolResult =>
  fail(`${which} failed to eval — fix these and retry:\n${JSON.stringify(diagnostics, null, 2)}`)

/** Write the WAV under rendersDir (created on demand) and mirror it
 *  fail-open into mirrorDir. Returns the rendersDir path. */
const writeWav = (wav: Uint8Array, prefix: string, code: string, dirs: RenderDirs): string => {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 8)
  const name = `${prefix}-${Date.now()}-${hash}.wav`
  mkdirSync(dirs.rendersDir, { recursive: true })
  const wavPath = join(dirs.rendersDir, name)
  writeFileSync(wavPath, wav)
  if (dirs.mirrorDir !== null) {
    try {
      mkdirSync(dirs.mirrorDir, { recursive: true })
      writeFileSync(join(dirs.mirrorDir, name), wav)
    } catch (e) {
      // Fail-open: the mirror is a convenience for the human, never a
      // reason to fail the render (stderr only — stdout is MCP's).
      console.warn(`[render] mirror copy to ${dirs.mirrorDir} skipped: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return wavPath
}

interface ProgramRender {
  staged: Extract<StageResult, { ok: true }>
  mix: MixResult
  analysis: Analysis
  cycles: number
  cps: number
  durationSec: number
  /** Pattern `sound` targets with no staged synth (typos — they rendered
   *  as silence). */
  unknownSounds: string[]
}

/** Shared render_code / compare_renders pipeline: stage → schedule → mix →
 *  analyze. Returns a CallToolResult on any failure. */
const renderProgram = (
  code: string,
  opts: { cycles: number; cps?: number },
  label = 'code',
): ProgramRender | CallToolResult => {
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return fail(`${label} is over 100 KB — render_code expects a program, not a data blob`)
  }
  const staged = stageCode(code)
  if (!staged.ok) return evalFail(label, staged.diagnostics)
  const cycles = clampCycles(opts.cycles)
  const cps = clampCps(opts.cps ?? staged.cps ?? DEFAULT_CPS)
  const musicSec = cycles / cps
  if (musicSec + TAIL_SEC > MAX_RENDER_SEC) {
    return fail(
      `render too long: ${cycles} cycles at ${cps} cps = ${round(musicSec, 1)}s + ${TAIL_SEC}s tail, over the ${MAX_RENDER_SEC}s ceiling — fewer cycles or a faster cps`,
    )
  }
  const durationSec = musicSec + TAIL_SEC
  const events = runPatterns(staged.patterns, { cycles, cps })
  const mix = renderMix(staged.synths, events, durationSec, {
    maxVoices: 12,
    // Forward buses/sends/masterComp too, so the offline render an agent "hears"
    // matches the live signal path (renderMix supports all three; omitting them
    // silently dropped bus FX and the glue compressor from the render).
    ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
    ...(staged.sidechain !== undefined ? { sidechain: staged.sidechain } : {}),
    ...(staged.masterComp !== undefined ? { masterComp: staged.masterComp } : {}),
  })
  const analysis = analyze({ left: mix.left, right: mix.right, sampleRate: mix.sampleRate })
  const unknownSounds = [...events.keys()].filter((s) => !staged.synths.has(s))
  return { staged, mix, analysis, cycles, cps, durationSec, unknownSounds }
}

const isToolResult = (x: ProgramRender | CallToolResult): x is CallToolResult => 'content' in x

/** How to READ an Analysis, shared by all three tool descriptions. */
const READING =
  'Reading the analysis: rms = loudness (~0.1 healthy, <0.01 very quiet, isSilent = check gate/envelope wiring); spectralCentroidHz = brightness (up = brighter/opener filter, down = darker); spectralRolloffHz = where the spectrum ends; spectralFlatness = noisy (→1) vs pitched (→0); lowMidHighRatio = tonal balance [<250 Hz, 250-4k, >4k]; clipped/peak = headroom; attackTimeMs = click vs swell; envelope = 50-point amplitude outline.'

export function registerRenderTools(server: McpServer, dirs?: Partial<RenderDirs>): void {
  const d: RenderDirs = {
    rendersDir: dirs?.rendersDir ?? DEFAULT_DIRS.rendersDir,
    mirrorDir: dirs?.mirrorDir === undefined ? DEFAULT_DIRS.mirrorDir : dirs.mirrorDir,
  }

  server.registerTool(
    'render_code',
    {
      description:
        `Render a COMPLETE rondocode program offline and LISTEN via analysis — no browser needed (works even when the live tools report no session; fully server-side and deterministic: same code + cycles + cps → identical analysis). Evals the source (see rondocode://docs/dsl-reference), drives the real pattern scheduler for N cycles, renders each synth's events, mixes the stems (peak-normalized to 0.89 when hot) with a ${TAIL_SEC}s release tail. Returns { analysis, perSynth: {name: {events, rms}}, durationSec, wavPath? } — perSynth with events 0 or rms ~0 pinpoints a synth that never sounds; unknownSounds lists .sound() targets no synth defines. ${READING} The WAV also lands in the human's Dropbox rondocode-renders folder so they can actually hear it — mention the filename when you want them to listen. This renders a COPY of the code you pass; it does not touch the live browser session.`,
      inputSchema: {
        code: z.string().describe('Full rondocode program source (synths + p() patterns + optional setCps)'),
        cycles: z.number().optional().describe('Whole cycles to render (default 4, clamped 1..64)'),
        cps: z.number().optional().describe("Tempo override in cycles/sec (default: the code's setCps, else 0.5; clamped 0.05..4)"),
        includeWav: z.boolean().optional().describe('Write a 16-bit WAV to disk (default true; false = analysis only, faster and no files)'),
      },
    },
    ({ code, cycles, cps, includeWav }) => {
      const r = renderProgram(code, { cycles: cycles ?? 4, ...(cps !== undefined ? { cps } : {}) })
      if (isToolResult(r)) return r
      const perSynth: Record<string, { events: number; rms: number }> = {}
      for (const [name, s] of Object.entries(r.mix.perSynth)) {
        perSynth[name] = { events: s.events, rms: round(s.rms, 4) }
      }
      const result: Record<string, unknown> = {
        analysis: r.analysis,
        perSynth,
        durationSec: round(r.durationSec, 3),
        cycles: r.cycles,
        cps: r.cps,
      }
      if (r.unknownSounds.length > 0) result['unknownSounds'] = r.unknownSounds
      if (r.staged.warnings.length > 0) result['warnings'] = r.staged.warnings
      if (includeWav !== false) {
        const wav = encodeWav16(r.mix.left, r.mix.right, r.mix.sampleRate)
        result['wavPath'] = writeWav(wav, 'agent', code, d)
      }
      return ok(result)
    },
  )

  server.registerTool(
    'render_synth',
    {
      description:
        `Quick single-synth audition, offline and deterministic (no browser needed): eval the code, play ONE note on one synth (noteOn at 0.05s, noteOff at 60% of durationSec, +1s release tail) and return its analysis + a WAV on disk (also mirrored to the human's Dropbox rondocode-renders folder). The fastest way to iterate on a patch's timbre before patterning it. ${READING}`,
      inputSchema: {
        code: z.string().describe('Rondocode source defining at least one synth (patterns are ignored here)'),
        synthName: z.string().optional().describe('Which synth to audition (default: the first one the code defines)'),
        note: z.number().optional().describe('MIDI note to play (default 48 = C3)'),
        durationSec: z.number().optional().describe('Held-note render length in seconds before the 1s tail (default 2, clamped 0.2..30)'),
      },
    },
    ({ code, synthName, note, durationSec }) => {
      if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return fail('code is over 100 KB — render_synth expects a program, not a data blob')
      }
      const staged = stageCode(code)
      if (!staged.ok) return evalFail('code', staged.diagnostics)
      const names = [...staged.synths.keys()]
      if (names.length === 0) {
        return fail("code defines no synths — declare one as a top-level `const name = synth(ctx => ...)`")
      }
      const name = synthName ?? names[0]!
      const def = staged.synths.get(name)
      if (def === undefined) {
        return fail(`unknown synth '${name}' — available: ${names.join(', ')}`)
      }
      const dur = Math.min(30, Math.max(0.2, durationSec ?? 2))
      const midi = note ?? 48
      const total = dur + 1
      const rendered = renderOffline(
        def,
        [
          { time: 0.05, type: 'noteOn', note: midi, velocity: 1 },
          { time: dur * 0.6, type: 'noteOff', note: midi },
        ],
        total,
      )
      const analysis = analyze(rendered)
      const wav = encodeWav16(rendered.left, rendered.right, rendered.sampleRate)
      const wavPath = writeWav(wav, 'synth', code, d)
      return ok({ synth: name, note: midi, durationSec: total, analysis, wavPath })
    },
  )

  server.registerTool(
    'compare_renders',
    {
      description:
        `Render two rondocode programs offline (no WAVs) and return { a, b, delta } where delta is b MINUS a per metric — the "did my change do what I intended" tool. Positive delta.spectralCentroidHz = B is brighter; positive rms = louder; positive spectralFlatness = noisier/more distorted; lowMidHigh deltas show where the energy moved. Deterministic and browser-free, so identical code yields delta 0 exactly. Same cycles/tempo rules as render_code (each side uses its own setCps unless you pass cycles). ${READING}`,
      inputSchema: {
        codeA: z.string().describe('Baseline program (usually the current version)'),
        codeB: z.string().describe('Changed program to compare against the baseline'),
        cycles: z.number().optional().describe('Whole cycles to render on both sides (default 4, clamped 1..64)'),
      },
    },
    ({ codeA, codeB, cycles }) => {
      const a = renderProgram(codeA, { cycles: cycles ?? 4 }, 'codeA')
      if (isToolResult(a)) return a
      const b = renderProgram(codeB, { cycles: cycles ?? 4 }, 'codeB')
      if (isToolResult(b)) return b
      const A = a.analysis
      const B = b.analysis
      const delta = {
        rms: round(B.rms - A.rms, 4),
        spectralCentroidHz: round(B.spectralCentroidHz - A.spectralCentroidHz, 1),
        spectralRolloffHz: round(B.spectralRolloffHz - A.spectralRolloffHz, 1),
        spectralFlatness: round(B.spectralFlatness - A.spectralFlatness, 4),
        lowMidHigh: [
          round(B.lowMidHighRatio[0] - A.lowMidHighRatio[0], 4),
          round(B.lowMidHighRatio[1] - A.lowMidHighRatio[1], 4),
          round(B.lowMidHighRatio[2] - A.lowMidHighRatio[2], 4),
        ] as [number, number, number],
        peak: round(B.peak - A.peak, 4),
        stereoWidth: round(B.stereoWidth - A.stereoWidth, 4),
      }
      return ok({ a: A, b: B, delta })
    },
  )
}
