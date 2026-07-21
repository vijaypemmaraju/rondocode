import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Bridge, SUPERSEDED } from '../src/bridge'

/* Bridge tests run fully in-process: a real Bridge on an ephemeral port
 * (port 0) with `ws` clients playing the browser. Nothing here touches 6070
 * — the MCP task owns the real port. */

const openClient = (port: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })

/** Collect parsed frames the server sends to this client. */
const frameLog = (ws: WebSocket): { id: string; method: string; params?: unknown }[] => {
  const frames: { id: string; method: string; params?: unknown }[] = []
  ws.on('message', (data) => frames.push(JSON.parse(String(data))))
  return frames
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

let bridges: Bridge[] = []
let clients: WebSocket[] = []

const rig = async (): Promise<{ bridge: Bridge; port: number }> => {
  const bridge = new Bridge({ port: 0 })
  await bridge.listen()
  bridges.push(bridge)
  return { bridge, port: bridge.port }
}

const connect = async (port: number): Promise<WebSocket> => {
  const ws = await openClient(port)
  clients.push(ws)
  return ws
}

afterEach(async () => {
  for (const ws of clients) ws.terminate()
  clients = []
  await Promise.all(bridges.map((b) => b.close()))
  bridges = []
})

describe('Bridge', () => {
  it('rejects calls when no session is connected', async () => {
    const { bridge } = await rig()
    await expect(bridge.call('getState')).rejects.toThrow('no session connected')
    expect(bridge.connected).toBe(false)
  })

  it('correlates two concurrent calls to the right responses', async () => {
    const { bridge, port } = await rig()
    const ws = await connect(port)
    const frames = frameLog(ws)
    await until(() => bridge.connected)

    const a = bridge.call('evalCode', { source: 'x' })
    const b = bridge.call('getState')
    await until(() => frames.length === 2)

    // Answer in REVERSE order to prove correlation is by id, not FIFO.
    const [fa, fb] = frames as [{ id: string; method: string }, { id: string; method: string }]
    expect(fa.method).toBe('evalCode')
    expect(fb.method).toBe('getState')
    ws.send(JSON.stringify({ id: fb.id, result: { playing: true } }))
    ws.send(JSON.stringify({ id: fa.id, result: { ok: true } }))

    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ playing: true })
  })

  it('propagates error responses as rejections', async () => {
    const { bridge, port } = await rig()
    const ws = await connect(port)
    const frames = frameLog(ws)
    await until(() => bridge.connected)

    const call = bridge.call('setParam', { addr: 'nope' })
    await until(() => frames.length === 1)
    ws.send(JSON.stringify({ id: frames[0]?.id, error: { message: 'bad addr' } }))
    await expect(call).rejects.toThrow('bad addr')
  })

  it('times out cleanly when the browser never answers', async () => {
    const { bridge, port } = await rig()
    await connect(port)
    await until(() => bridge.connected)
    await expect(bridge.call('evalCode', {}, 50)).rejects.toThrow('timed out after 50ms')
  })

  it('latest connection wins: first is closed, calls route to second', async () => {
    const { bridge, port } = await rig()
    const first = await connect(port)
    const firstClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      first.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
    })
    await until(() => bridge.connected)

    // A call pending on the first socket rejects when it is superseded.
    // (Attach the rejection expectation BEFORE triggering it, or the interim
    // unhandled rejection trips vitest's global handler.)
    const stranded = expect(bridge.call('getState')).rejects.toThrow('session disconnected')

    const second = await connect(port)
    const frames = frameLog(second)
    const closed = await firstClosed
    expect(closed.code).toBe(SUPERSEDED)
    expect(closed.reason).toContain('superseded')
    await stranded

    const call = bridge.call('getState')
    await until(() => frames.length === 1)
    second.send(JSON.stringify({ id: frames[0]?.id, result: 'from-second' }))
    expect(await call).toBe('from-second')
    expect(bridge.connected).toBe(true)
  })

  it('rejects pending calls when the session disconnects', async () => {
    const { bridge, port } = await rig()
    const ws = await connect(port)
    await until(() => bridge.connected)
    const call = bridge.call('getState')
    ws.close()
    await expect(call).rejects.toThrow('session disconnected')
    await until(() => !bridge.connected)
  })

  it('ignores malformed frames without crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { bridge, port } = await rig()
      const ws = await connect(port)
      const frames = frameLog(ws)
      await until(() => bridge.connected)

      ws.send('not json {{{')
      ws.send('42')
      ws.send(JSON.stringify({ id: 'unknown-id', result: 1 }))
      ws.send(JSON.stringify({ notify: 'bogus', payload: null }))

      // Bridge still works after the garbage.
      const call = bridge.call('getState')
      await until(() => frames.length === 1)
      ws.send(JSON.stringify({ id: frames[0]?.id, result: 'still alive' }))
      expect(await call).toBe('still alive')
      await until(() => warn.mock.calls.length >= 4)
    } finally {
      warn.mockRestore()
    }
  })

  it('delivers notifications to onNotify', async () => {
    const { bridge, port } = await rig()
    const seen: [string, unknown][] = []
    bridge.onNotify = (kind, payload) => seen.push([kind, payload])
    const ws = await connect(port)
    await until(() => bridge.connected)

    ws.send(JSON.stringify({ notify: 'hello', payload: { ua: 'test' } }))
    ws.send(JSON.stringify({ notify: 'state', payload: { playing: false } }))
    ws.send(JSON.stringify({ notify: 'diagnostics', payload: [] }))
    await until(() => seen.length === 3)
    expect(seen).toEqual([
      ['hello', { ua: 'test' }],
      ['state', { playing: false }],
      ['diagnostics', []],
    ])
  })

  it('close() rejects pending calls and stops accepting connections', async () => {
    const { bridge, port } = await rig()
    await connect(port)
    await until(() => bridge.connected)
    const rejected = expect(bridge.call('getState')).rejects.toThrow(
      /bridge closed|session disconnected/,
    )
    await bridge.close()
    await rejected
    expect(bridge.connected).toBe(false)
    await expect(openClient(port)).rejects.toThrow()
  })
})
