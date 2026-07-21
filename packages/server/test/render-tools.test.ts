import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Bridge } from '../src/bridge'
import { createMcpServer } from '../src/mcp'
// Read-only import of the app's shipped examples (see mcp.ts header): the
// acid example is the canonical known-good program to render.
import { EXAMPLES } from '../../app/src/examples/index'
import type { Analysis } from '../../engine/src/index'

/* MCP-level tests for the render tools. DELIBERATELY no browser is ever
 * attached to the Bridge: unlike the live tools (which answer NO_SESSION),
 * render_code / render_synth / compare_renders must work with the bridge
 * disconnected — they are fully server-side. WAV output is routed to temp
 * dirs via createMcpServer's renderDirs so tests never touch the real
 * renders/ or the human's synced folder. */

const ACID = EXAMPLES.find((e) => e.name === 'acid')!.code

let bridge: Bridge
let client: Client
let rendersDir: string
let mirrorDir: string

beforeEach(async () => {
  rendersDir = mkdtempSync(join(tmpdir(), 'rondocode-renders-'))
  mirrorDir = mkdtempSync(join(tmpdir(), 'rondocode-mirror-'))
  bridge = new Bridge({ port: 0 })
  await bridge.listen()
  const server = createMcpServer(bridge, { renderDirs: { rendersDir, mirrorDir } })
  client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
})

afterEach(async () => {
  await client.close()
  await bridge.close()
  rmSync(rendersDir, { recursive: true, force: true })
  rmSync(mirrorDir, { recursive: true, force: true })
})

const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
  (await client.callTool({ name, arguments: args })) as CallToolResult

const asJson = (r: CallToolResult): Record<string, unknown> => {
  const first = r.content[0]
  if (first?.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

const asText = (r: CallToolResult): string => {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : ''
}

describe('render_code', () => {
  it('renders the acid example with the bridge disconnected: real analysis, wav on disk + mirror', async () => {
    expect(bridge.connected).toBe(false)
    const r = await call('render_code', { code: ACID, cycles: 2 })
    expect(r.isError, asText(r)).not.toBe(true)
    const j = asJson(r)

    const analysis = j['analysis'] as Analysis
    expect(analysis.isSilent).toBe(false)
    expect(analysis.rms).toBeGreaterThan(0.01)
    expect(analysis.hasNaN).toBe(false)
    expect(analysis.clipped).toBe(false)
    expect(analysis.spectralCentroidHz).toBeGreaterThan(100)

    // acid at setCps(0.6): 2 cycles / 0.6 + 2s tail
    expect(j['cps']).toBe(0.6)
    expect(j['cycles']).toBe(2)
    expect(j['durationSec']).toBeCloseTo(2 / 0.6 + 2, 2)

    const perSynth = j['perSynth'] as Record<string, { events: number; rms: number }>
    expect(perSynth['acid']!.events).toBe(16) // 8 notes/cycle × 2 cycles
    expect(perSynth['acid']!.rms).toBeGreaterThan(0.01)

    // WAV written under the injected renders dir, mirrored to the other.
    const wavPath = j['wavPath'] as string
    expect(wavPath.startsWith(rendersDir)).toBe(true)
    expect(wavPath).toMatch(/agent-\d+-[0-9a-f]{8}\.wav$/)
    expect(existsSync(wavPath)).toBe(true)
    expect(readdirSync(mirrorDir)).toHaveLength(1)
  }, 60_000)

  it('skips the wav when includeWav is false', async () => {
    const r = await call('render_code', { code: ACID, cycles: 1, includeWav: false })
    expect(r.isError, asText(r)).not.toBe(true)
    expect(asJson(r)['wavPath']).toBeUndefined()
    expect(readdirSync(rendersDir)).toHaveLength(0)
    expect(readdirSync(mirrorDir)).toHaveLength(0)
  }, 60_000)

  it('is deterministic: same code, same analysis', async () => {
    const code = "const blip = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, {}))); p('a', note('c3 e3').sound('blip')); setCps(1)"
    const a = asJson(await call('render_code', { code, cycles: 1, includeWav: false }))
    const b = asJson(await call('render_code', { code, cycles: 1, includeWav: false }))
    expect(a['analysis']).toEqual(b['analysis'])
  }, 60_000)

  it('reports unknown .sound() targets', async () => {
    const code = "const blip = synth(({ note, gate, adsr, sine }) => sine(note.freq).mul(adsr(gate, {}))); p('a', note('c3').sound('zynth')); setCps(1)"
    const j = asJson(await call('render_code', { code, cycles: 1, includeWav: false }))
    expect(j['unknownSounds']).toEqual(['zynth'])
    expect((j['analysis'] as Analysis).isSilent).toBe(true)
  }, 60_000)

  it('returns positioned diagnostics on eval failure', async () => {
    const r = await call('render_code', { code: 'const nope = synth(\n???', includeWav: false })
    expect(r.isError).toBe(true)
    const text = asText(r)
    expect(text).toContain('failed to eval')
    expect(text).toMatch(/"line":\s*2/)
    expect(text).toMatch(/"col":\s*\d+/)
    expect(readdirSync(rendersDir)).toHaveLength(0)
  })

  it('clamps cycles to 1..64 and rejects renders over the 120s ceiling', async () => {
    // 500 cycles clamps to 64; at the acid example's 0.6 cps that is ~107s
    // + 2s tail — under the ceiling would be slow to render, so use a cps
    // where the CLAMPED value still trips the guard: 64 / 0.5 = 128s.
    const slow = await call('render_code', { code: ACID, cycles: 500, cps: 0.5, includeWav: false })
    expect(slow.isError).toBe(true)
    expect(asText(slow)).toContain('64 cycles') // proves the 1..64 clamp ran first
    expect(asText(slow)).toContain('120')

    // Low clamp: cycles 0 → 1 (fast render at cps 4).
    const tiny = asJson(await call('render_code', { code: ACID, cycles: 0, cps: 4, includeWav: false }))
    expect(tiny['cycles']).toBe(1)
    expect(tiny['durationSec']).toBeCloseTo(1 / 4 + 2, 3)
  }, 60_000)

  it('rejects oversized code without evaluating it', async () => {
    const r = await call('render_code', { code: `// ${'x'.repeat(101_000)}`, includeWav: false })
    expect(r.isError).toBe(true)
    expect(asText(r)).toContain('100 KB')
  })
})

describe('render_synth', () => {
  it('auditions the first synth by default and writes a synth- wav', async () => {
    const r = await call('render_synth', { code: ACID, durationSec: 1 })
    expect(r.isError, asText(r)).not.toBe(true)
    const j = asJson(r)
    expect(j['synth']).toBe('acid')
    expect(j['note']).toBe(48)
    expect(j['durationSec']).toBe(2) // 1s + 1s tail
    const analysis = j['analysis'] as Analysis
    expect(analysis.isSilent).toBe(false)
    expect(analysis.rms).toBeGreaterThan(0.001)
    const wavPath = j['wavPath'] as string
    expect(wavPath).toMatch(/synth-\d+-[0-9a-f]{8}\.wav$/)
    expect(existsSync(wavPath)).toBe(true)
  }, 60_000)

  it('errors when the code defines no synths', async () => {
    const r = await call('render_synth', { code: "p('a', note('c3').sound('x'))" })
    expect(r.isError).toBe(true)
    expect(asText(r)).toContain('code defines no synths')
  })

  it('errors on an unknown synthName, listing what exists', async () => {
    const r = await call('render_synth', { code: ACID, synthName: 'wobble' })
    expect(r.isError).toBe(true)
    expect(asText(r)).toContain("unknown synth 'wobble'")
    expect(asText(r)).toContain('acid')
  })
})

describe('compare_renders', () => {
  const patch = (cutoff: number): string => `
const lead = synth(({ note, gate, adsr, saw, svf }) => {
  const env = adsr(gate, { a: 0.002, d: 0.3, s: 0.3, r: 0.1 })
  return svf(saw(note.freq), ${cutoff}).mul(env)
})
p('line', note('c3 e3 g3 c4').sound('lead'))
setCps(1)
`

  it('returns both analyses and b-minus-a deltas with the right signs', async () => {
    const r = await call('compare_renders', { codeA: patch(400), codeB: patch(4000), cycles: 1 })
    expect(r.isError, asText(r)).not.toBe(true)
    const j = asJson(r)
    const a = j['a'] as Analysis
    const b = j['b'] as Analysis
    const delta = j['delta'] as Record<string, number> & { lowMidHigh: [number, number, number] }
    // opening the filter 400 → 4000 Hz must read brighter
    expect(delta['spectralCentroidHz']).toBeGreaterThan(0)
    expect(delta['spectralCentroidHz']).toBeCloseTo(b.spectralCentroidHz - a.spectralCentroidHz, 0)
    expect(delta['rms']).toBeCloseTo(b.rms - a.rms, 3)
    expect(delta.lowMidHigh[2]).toBeGreaterThanOrEqual(0) // energy moved upward
    // no wavs for comparisons
    expect(readdirSync(rendersDir)).toHaveLength(0)
    expect(readdirSync(mirrorDir)).toHaveLength(0)
  }, 60_000)

  it('identical programs yield an all-zero delta', async () => {
    const r = await call('compare_renders', { codeA: patch(800), codeB: patch(800), cycles: 1 })
    const delta = asJson(r)['delta'] as Record<string, unknown>
    expect(delta).toEqual({
      rms: 0,
      spectralCentroidHz: 0,
      spectralRolloffHz: 0,
      spectralFlatness: 0,
      lowMidHigh: [0, 0, 0],
      peak: 0,
      stereoWidth: 0,
    })
  }, 60_000)

  it('names the failing side on eval errors', async () => {
    const r = await call('compare_renders', { codeA: patch(800), codeB: 'boom(' })
    expect(r.isError).toBe(true)
    expect(asText(r)).toContain('codeB')
  }, 60_000)
})

describe('tool listing', () => {
  it('exposes the three render tools with schemas alongside the live tools', async () => {
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const name of ['render_code', 'render_synth', 'compare_renders']) {
      const tool = byName.get(name)
      expect(tool, `missing tool ${name}`).toBeDefined()
      expect(tool!.description ?? '').not.toBe('')
      expect(tool!.inputSchema.type).toBe('object')
    }
    expect(Object.keys(byName.get('render_code')!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['code', 'cycles', 'cps', 'includeWav']),
    )
    expect(Object.keys(byName.get('compare_renders')!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['codeA', 'codeB', 'cycles']),
    )
  })
})
