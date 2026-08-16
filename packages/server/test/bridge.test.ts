import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Bridge, SUPERSEDED } from '../src/bridge'
import { CompletionService, makeCompleteHandler } from '../src/complete'

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

/* WAITING ON A SOCKET, so the budgets here are generous on purpose.
 *
 * These tests open a real WebSocket and wait for a real round trip. Vitest's
 * default test timeout is 5s and the polls below allowed 2s inside it, which
 * is a claim about how loaded the machine is rather than about the code: under
 * the full suite, with a worker per core, an event loop can be starved for
 * longer than that. Three of these flaked that way (twice in mcp.test.ts, once
 * here) and every one passed alone and on rerun.
 *
 * A generous ceiling costs a passing run NOTHING -- the waits resolve on the
 * event, not on the clock -- and it is the failing path that gets the room. A
 * tight one only ever encodes the load of the machine that wrote it. */
const SOCKET_TIMEOUT_MS = 20_000

const until = async (cond: () => boolean, ms = SOCKET_TIMEOUT_MS): Promise<void> => {
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


/* ------------------------------------------------------------------------- *
 * GET /doc — the editor's document, for tooling that writes it back to disk.
 *
 * Read over HTTP rather than over a second WebSocket ON PURPOSE: the newest
 * /session connection wins and closes the previous one, so a tool that dialled
 * in to ask what the tab was showing would disconnect the tab it was asking
 * about. The last test here is the one that pins that.
 * ------------------------------------------------------------------------- */
describe('GET /doc', () => {
  /** A fake browser that answers `getDoc` with `doc`. */
  const speaks = (ws: WebSocket, doc: unknown): void => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { id: string; method: string }
      if (msg.method === 'getDoc') ws.send(JSON.stringify({ id: msg.id, result: doc }))
    })
  }

  it('answers with whatever the editor is showing, in its own language', async () => {
    const { bridge, port } = await rig()
    const ws = await connect(port)
    speaks(ws, { text: 'synth pad\n  saw note\n', lang: 'rondo' })
    await until(() => bridge.connected)
    const res = await fetch(`http://127.0.0.1:${port}/doc`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'synth pad\n  saw note\n', lang: 'rondo' })
  })

  it('says 503 with no browser, which is the one thing only a human can fix', async () => {
    const { port } = await rig()
    const res = await fetch(`http://127.0.0.1:${port}/doc`)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain('no browser session connected')
  })

  it('reading the doc does NOT take the session away from the tab', async () => {
    // a WebSocket read would have: newest /session connection wins
    const { bridge, port } = await rig()
    const ws = await connect(port)
    speaks(ws, { text: 'x', lang: 'rondocode' })
    await until(() => bridge.connected)
    let closed = false
    ws.on('close', () => { closed = true })
    await fetch(`http://127.0.0.1:${port}/doc`)
    await fetch(`http://127.0.0.1:${port}/doc`)
    expect(closed, 'the browser socket was closed by a read').toBe(false)
    expect(bridge.connected).toBe(true)
  })

  it('leaves the other routes alone', async () => {
    const { port } = await rig()
    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
  })
})


describe('Bridge', { timeout: SOCKET_TIMEOUT_MS }, () => {
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

  it('gives httpHandler first look at plain HTTP requests and 404s the rest', async () => {
    // End to end over a REAL http request: the same wiring main.ts uses — a
    // Bridge whose httpHandler is makeCompleteHandler — serves /complete
    // routes, while unhandled paths fall through to the bridge's default 404.
    const service = new CompletionService({
      apiKey: 'sk-test',
      createClient: () => ({
        messages: {
          create: () => Promise.resolve({ content: [{ type: 'text', text: '.rev()' }] }),
        },
      }),
    })
    const bridge = new Bridge({ port: 0, httpHandler: makeCompleteHandler(service) })
    bridges.push(bridge)
    await bridge.listen()
    const base = `http://127.0.0.1:${bridge.port}`

    const status = await fetch(`${base}/complete/status`)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ available: true })

    const completion = await fetch(`${base}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prefix: 'p(', suffix: '' }),
    })
    expect(completion.status).toBe(200)
    expect(await completion.json()).toEqual({ completion: '.rev()' })

    // Anything the handler declines falls through to the bridge's 404.
    const miss = await fetch(`${base}/nope`)
    expect(miss.status).toBe(404)
    expect(await miss.text()).toContain('WebSocket endpoint at /session')
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

describe('a port that is already in use', { timeout: SOCKET_TIMEOUT_MS }, () => {
  /* Found by running the command the docs tell you to run, twice.
   *
   * The WebSocketServer wraps the http server and RE-EMITS its errors, and an
   * 'error' event with no listener is a thrown exception in Node -- so the
   * process died on the spot, before the promise `listen()` returns could
   * reject. Its own contract, defeated by the single most likely failure: a
   * second editor with the MCP server configured, or a stray `pnpm bridge`.
   * What the operator saw was a page of net internals with EADDRINUSE in the
   * middle of it. */
  it('REJECTS rather than killing the process', async () => {
    const first = new Bridge({ port: 0 })
    await first.listen()
    const second = new Bridge({ port: first.port })
    await expect(second.listen()).rejects.toThrow()
    await first.close()
  })

  it('says what to do about it', async () => {
    const first = new Bridge({ port: 0 })
    await first.listen()
    const second = new Bridge({ port: first.port })
    const err = await second.listen().then(() => null, (e: Error) => e)
    expect(err?.message, 'the port belongs in the message').toContain(String(first.port))
    expect(err?.message).toContain('already in use')
    expect(err?.message, 'and a way out').toMatch(/PORT/)
    expect(err?.message, 'not a bare errno').not.toBe('listen EADDRINUSE')
    await first.close()
  })

  it('still reports other listen errors unchanged', async () => {
    // only EADDRINUSE is rewritten; anything else must arrive as itself
    const b = new Bridge({ port: -1 })
    await expect(b.listen()).rejects.toThrow()
  })
})
