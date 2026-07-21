import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Bridge } from '../src/bridge'
import { createMcpServer, NO_SESSION } from '../src/mcp'

/* End-to-end in process: a real MCP Client over the SDK's InMemoryTransport
 * pair talks to createMcpServer, which drives a real Bridge on an ephemeral
 * port with a `ws` client playing the browser (same rig as bridge.test.ts —
 * nothing touches 6070). The fake browser answers with the shapes main.ts's
 * handler map produces, evalCode's staged Maps JSON-flattened to {} exactly
 * as the wire does. */

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const FAKE_STATE = { playing: true, cps: 0.5, synths: ['acid'], patterns: ['bass'] }

interface BrowserFrame {
  id: string
  method: string
  params?: unknown
}

let bridges: Bridge[] = []
let clients: Client[] = []
let sockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of sockets) ws.terminate()
  sockets = []
  await Promise.all(clients.map((c) => c.close()))
  clients = []
  await Promise.all(bridges.map((b) => b.close()))
  bridges = []
})

const rig = async (): Promise<{ bridge: Bridge; client: Client }> => {
  const bridge = new Bridge({ port: 0 })
  await bridge.listen()
  bridges.push(bridge)
  const server = createMcpServer(bridge)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  clients.push(client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { bridge, client }
}

/** A fake browser session: records every request and answers like the
 *  handler map in packages/app/src/main.ts would. */
const attachBrowser = async (bridge: Bridge): Promise<{ ws: WebSocket; received: BrowserFrame[] }> => {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/session`)
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const received: BrowserFrame[] = []
  ws.on('message', (data) => {
    const m = JSON.parse(String(data)) as BrowserFrame
    received.push(m)
    const respond = (result?: unknown): void => {
      ws.send(JSON.stringify(result === undefined ? { id: m.id } : { id: m.id, result }))
    }
    switch (m.method) {
      case 'evalCode':
        respond({ ok: true, diagnostics: [], synths: {}, patterns: {} })
        break
      case 'getCode':
        respond({ code: "p('bass', silence)", lastAttempted: 'broken(' })
        break
      case 'getState':
        respond(FAKE_STATE)
        break
      default:
        respond() // setParam / setChannel / transport return undefined
    }
  })
  await until(() => bridge.connected)
  return { ws, received }
}

const asJson = (r: CallToolResult): unknown => {
  const first = r.content[0]
  if (first?.type !== 'text') throw new Error('expected text content')
  return JSON.parse(first.text)
}

const asText = (r: CallToolResult): string => {
  const first = r.content[0]
  return first?.type === 'text' ? first.text : ''
}

/** First resource content as text (resource contents are text | blob). */
const resourceText = (contents: { uri: string }[]): string => {
  const first = contents[0]
  return first !== undefined && 'text' in first ? String(first.text) : ''
}

describe('mcp server tools', () => {
  it('lists all tools with descriptions and input schemas', async () => {
    const { client } = await rig()
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const name of [
      'get_code',
      'eval_code',
      'set_param',
      'set_channel',
      'transport',
      'get_state',
      'get_diagnostics',
    ]) {
      const tool = byName.get(name)
      expect(tool, `missing tool ${name}`).toBeDefined()
      expect(tool!.description ?? '').not.toBe('')
      expect(tool!.inputSchema.type).toBe('object')
    }
    // Schemas carry the declared properties, not just an open object.
    expect(Object.keys(byName.get('eval_code')!.inputSchema.properties ?? {})).toContain('code')
    expect(Object.keys(byName.get('set_param')!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['synth', 'name', 'value', 'rampMs']),
    )
  })

  it('answers every LIVE tool with an actionable error when no browser is connected', async () => {
    const { client } = await rig()
    for (const name of ['get_state', 'eval_code'] as const) {
      const r = (await client.callTool({
        name,
        arguments: name === 'eval_code' ? { code: 'setCps(1)' } : {},
      })) as CallToolResult
      expect(r.isError, `${name} should be isError`).toBe(true)
      expect(asText(r)).toContain(NO_SESSION)
    }
  })

  it('get_diagnostics serves its cache even with no browser connected', async () => {
    const { client } = await rig()
    const r = (await client.callTool({
      name: 'get_diagnostics',
      arguments: {},
    })) as CallToolResult
    expect(r.isError).toBeFalsy()
    // No browser ever connected: cache empty, connected false, no error.
    expect(asJson(r)).toEqual({ connected: false, diagnostics: null, state: null })
  })

  it('eval_code round-trips through a live bridge session', async () => {
    const { bridge, client } = await rig()
    const { received } = await attachBrowser(bridge)
    const r = (await client.callTool({
      name: 'eval_code',
      arguments: { code: "p('bass', silence)" },
    })) as CallToolResult
    expect(r.isError).not.toBe(true)
    expect(asJson(r)).toEqual({ ok: true, diagnostics: [] })
    const evalReq = received.find((f) => f.method === 'evalCode')
    expect(evalReq?.params).toEqual({ source: "p('bass', silence)" })
  })

  it('get_code and get_state relay the session truth', async () => {
    const { bridge, client } = await rig()
    await attachBrowser(bridge)
    const code = (await client.callTool({ name: 'get_code', arguments: {} })) as CallToolResult
    expect(asJson(code)).toEqual({ code: "p('bass', silence)", lastAttempted: 'broken(' })
    const state = (await client.callTool({ name: 'get_state', arguments: {} })) as CallToolResult
    expect(asJson(state)).toEqual({ connected: true, state: FAKE_STATE })
  })

  it('set_param joins synth+name into the bridge addr; transport maps action→cmd', async () => {
    const { bridge, client } = await rig()
    const { received } = await attachBrowser(bridge)
    await client.callTool({
      name: 'set_param',
      arguments: { synth: 'acid', name: 'cutoff', value: 1200, rampMs: 50 },
    })
    await client.callTool({ name: 'transport', arguments: { action: 'play', cps: 0.6 } })
    await client.callTool({ name: 'set_channel', arguments: { synth: 'acid', gain: 0.8 } })
    expect(received.find((f) => f.method === 'setParam')?.params).toEqual({
      addr: 'acid.cutoff',
      value: 1200,
      rampMs: 50,
    })
    expect(received.find((f) => f.method === 'transport')?.params).toEqual({
      cmd: 'play',
      cps: 0.6,
    })
    expect(received.find((f) => f.method === 'setChannel')?.params).toEqual({
      synth: 'acid',
      gain: 0.8,
    })
  })

  it('get_diagnostics serves cached notifications with ageMs', async () => {
    const { bridge, client } = await rig()
    const { ws } = await attachBrowser(bridge)

    // Nothing pushed yet: both slots empty but the tool succeeds.
    const empty = (await client.callTool({ name: 'get_diagnostics', arguments: {} })) as CallToolResult
    expect(asJson(empty)).toEqual({ connected: true, diagnostics: null, state: null })

    const diag = [{ line: 1, col: 1, message: "pattern 'bass': boom", severity: 'error', source: 'scheduler' }]
    ws.send(JSON.stringify({ notify: 'diagnostics', payload: diag }))
    ws.send(JSON.stringify({ notify: 'state', payload: FAKE_STATE }))

    // Poll through the tool itself until both notifications have landed —
    // the cache is private to the server.
    type Cached = { payload: unknown; ageMs: number } | null
    let got: { diagnostics: Cached; state: Cached } = { diagnostics: null, state: null }
    const t0 = Date.now()
    while (got.diagnostics === null || got.state === null) {
      if (Date.now() - t0 > 2000) throw new Error('notifications never cached')
      const r = (await client.callTool({ name: 'get_diagnostics', arguments: {} })) as CallToolResult
      got = asJson(r) as typeof got
      await new Promise((r2) => setTimeout(r2, 5))
    }
    expect(got.diagnostics!.payload).toEqual(diag)
    expect(got.diagnostics!.ageMs).toBeGreaterThanOrEqual(0)
    expect(got.state!.payload).toEqual(FAKE_STATE)
    expect(got.state!.ageMs).toBeGreaterThanOrEqual(0)
  })
})

describe('mcp server resources', () => {
  it('lists the three docs resources', async () => {
    const { client } = await rig()
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)
    expect(uris).toEqual(
      expect.arrayContaining([
        'rondocode://docs/dsl-reference',
        'rondocode://docs/agent-guide',
        'rondocode://docs/examples',
      ]),
    )
    for (const r of resources) expect(r.mimeType).toBe('text/markdown')
  })

  it('serves the generated dsl reference', async () => {
    const { client } = await rig()
    const { contents } = await client.readResource({ uri: 'rondocode://docs/dsl-reference' })
    const text = resourceText(contents)
    expect(text).toContain('**euclid**')
    expect(text).toContain('## Mini-notation')
  })

  it('serves the agent guide verbatim from docs/reference', async () => {
    const { client } = await rig()
    const { contents } = await client.readResource({ uri: 'rondocode://docs/agent-guide' })
    const text = resourceText(contents)
    expect(text.length).toBeGreaterThan(500)
    expect(text).toContain('eval_code')
    expect(text).toMatch(/[Ll]ast-good-version/)
  })

  it('serves the shipped examples with code', async () => {
    const { client } = await rig()
    const { contents } = await client.readResource({ uri: 'rondocode://docs/examples' })
    const text = resourceText(contents)
    expect(text).toContain('## acid')
    expect(text).toContain('const acid = synth')
    expect(text).toContain('## generative')
  })
})
