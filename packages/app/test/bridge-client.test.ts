import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient, defaultBridgeUrl } from '../src/session/bridge-client'
import type { BridgeAdapter, WsCtor } from '../src/session/bridge-client'

/* BridgeClient tests run in plain Node with an injected mock WebSocket —
 * no network. The mock records sent frames and lets tests emit open/
 * message/close events synchronously. */

type Listener = (ev: { data?: unknown; code?: number }) => void

class MockWs {
  static instances: MockWs[] = []
  readonly url: string
  readonly sent: string[] = []
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    MockWs.instances.push(this)
  }
  send(data: string): void {
    if (this.closed) throw new Error('send after close')
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  emit(type: string, ev: { data?: unknown; code?: number } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }
  /** Parsed frames, oldest first. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
}

const flush = (): Promise<void> => Promise.resolve().then(() => Promise.resolve())

let clients: BridgeClient[] = []

const rig = (adapter: Partial<BridgeAdapter>, opts?: { heartbeatMs?: number; retryMs?: number }) => {
  MockWs.instances = []
  const client = new BridgeClient(
    { handlers: {}, ...adapter },
    {
      url: 'ws://test:6070/session',
      WebSocketImpl: MockWs as unknown as WsCtor,
      heartbeatMs: opts?.heartbeatMs ?? 0, // off by default: tests opt in
      ...(opts?.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    },
  )
  clients.push(client)
  client.start()
  const ws = MockWs.instances[0]
  if (ws === undefined) throw new Error('no socket created')
  return { client, ws }
}

afterEach(() => {
  for (const c of clients) c.stop()
  clients = []
  vi.useRealTimers()
})

describe('BridgeClient', () => {
  it('derives the default URL from the page location', () => {
    expect(defaultBridgeUrl({ protocol: 'http:', hostname: 'localhost' })).toBe(
      'ws://localhost:6070/session',
    )
    expect(defaultBridgeUrl({ protocol: 'https:', hostname: 'ts.example' })).toBe(
      'wss://ts.example:6070/session',
    )
  })

  it('sends hello on open and dispatches a request to its handler', async () => {
    const evalCode = vi.fn().mockReturnValue({ ok: true })
    const { ws } = rig({ handlers: { evalCode } })
    ws.emit('open')
    expect(ws.frames()[0]).toEqual({ notify: 'hello', payload: { url: 'ws://test:6070/session' } })

    ws.emit('message', { data: JSON.stringify({ id: 'r1', method: 'evalCode', params: { source: 'x' } }) })
    await flush()
    expect(evalCode).toHaveBeenCalledWith({ source: 'x' })
    expect(ws.frames()).toContainEqual({ id: 'r1', result: { ok: true } })
  })

  it('supports async handlers and omits result for undefined returns', async () => {
    const { ws } = rig({
      handlers: {
        slow: async () => 'done',
        voidish: () => undefined,
      },
    })
    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({ id: 'a', method: 'slow' }) })
    ws.emit('message', { data: JSON.stringify({ id: 'b', method: 'voidish' }) })
    await flush()
    expect(ws.frames()).toContainEqual({ id: 'a', result: 'done' })
    expect(ws.frames()).toContainEqual({ id: 'b' })
  })

  it('answers unknown methods with an error', async () => {
    const { ws } = rig({ handlers: {} })
    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({ id: 'r2', method: 'nope' }) })
    await flush()
    expect(ws.frames()).toContainEqual({ id: 'r2', error: { message: 'unknown method: nope' } })
  })

  it('turns handler throws into error responses', async () => {
    const { ws } = rig({
      handlers: {
        boom: () => {
          throw new TypeError('addr must be a string')
        },
      },
    })
    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({ id: 'r3', method: 'boom' }) })
    await flush()
    expect(ws.frames()).toContainEqual({ id: 'r3', error: { message: 'addr must be a string' } })
  })

  it('ignores malformed frames without crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ws } = rig({ handlers: { ok: () => 1 } })
      ws.emit('open')
      ws.emit('message', { data: 'not json' })
      ws.emit('message', { data: JSON.stringify({ method: 'ok' }) }) // no id
      ws.emit('message', { data: JSON.stringify({ id: 'r4', method: 'ok' }) })
      await flush()
      expect(ws.frames()).toContainEqual({ id: 'r4', result: 1 })
    } finally {
      warn.mockRestore()
    }
  })

  it('pushes state on open, after each handled request, and via subscription', async () => {
    let state = { playing: false }
    let push: (() => void) | undefined
    const { ws } = rig({
      handlers: { transport: () => undefined },
      getState: () => state,
      subscribeState: (fn) => {
        push = fn
        return () => (push = undefined)
      },
    })
    ws.emit('open')
    expect(ws.frames()).toContainEqual({ notify: 'state', payload: { playing: false } })

    state = { playing: true }
    ws.emit('message', { data: JSON.stringify({ id: 't', method: 'transport' }) })
    await flush()
    // Post-request push carries the NEW state.
    expect(ws.frames().filter((f) => f.notify === 'state')).toContainEqual({
      notify: 'state',
      payload: { playing: true },
    })

    state = { playing: false }
    push?.()
    expect(ws.frames().at(-1)).toEqual({ notify: 'state', payload: { playing: false } })
  })

  it('heartbeats state while connected', () => {
    vi.useFakeTimers()
    const { ws } = rig({ getState: () => ({ hb: true }) }, { heartbeatMs: 2000 })
    ws.emit('open')
    const before = ws.frames().filter((f) => f.notify === 'state').length
    vi.advanceTimersByTime(6000)
    expect(ws.frames().filter((f) => f.notify === 'state').length).toBe(before + 3)
    ws.emit('close')
    vi.advanceTimersByTime(60000)
    // No sends after close (mock would throw), and no heartbeat frames added.
    expect(ws.frames().filter((f) => f.notify === 'state').length).toBe(before + 3)
  })

  it('reconnects with doubling backoff capped at 30x, resetting on success', () => {
    vi.useFakeTimers()
    const { ws } = rig({}, { retryMs: 1000 })
    ws.emit('open')
    ws.emit('close')
    expect(MockWs.instances.length).toBe(1)
    vi.advanceTimersByTime(1000) // first retry after base delay
    expect(MockWs.instances.length).toBe(2)
    MockWs.instances[1]?.emit('close')
    vi.advanceTimersByTime(1999)
    expect(MockWs.instances.length).toBe(2) // doubled: not yet
    vi.advanceTimersByTime(1)
    expect(MockWs.instances.length).toBe(3)
    // Ten more failures pin the delay at the 30s cap.
    for (let i = 3; i <= 12; i++) {
      MockWs.instances[i - 1]?.emit('close')
      vi.advanceTimersByTime(30_000)
      expect(MockWs.instances.length).toBe(i + 1)
    }
    // A successful open resets the backoff to the base delay.
    MockWs.instances[12]?.emit('open')
    MockWs.instances[12]?.emit('close')
    vi.advanceTimersByTime(1000)
    expect(MockWs.instances.length).toBe(14)
  })

  it('stop() closes the socket and halts retries', () => {
    vi.useFakeTimers()
    const { client, ws } = rig({})
    ws.emit('open')
    client.stop()
    expect(ws.closed).toBe(true)
    vi.advanceTimersByTime(120_000)
    expect(MockWs.instances.length).toBe(1)
    expect(client.connected).toBe(false)
  })

  it('goes dormant on a SUPERSEDED close (4000) instead of stealing the session back', () => {
    vi.useFakeTimers()
    const { client, ws } = rig({}, { retryMs: 1000 })
    ws.emit('open')
    expect(client.connected).toBe(true)
    // Another tab took over: the bridge closes us with code 4000.
    ws.emit('close', { code: 4000 })
    expect(client.connected).toBe(false)
    // No reconnect — ever — so the newer tab keeps the session.
    vi.advanceTimersByTime(120_000)
    expect(MockWs.instances.length).toBe(1)
    // A plain close (no code) still retries, proving 4000 is the special case.
    const { ws: ws2 } = rig({}, { retryMs: 1000 })
    ws2.emit('open')
    ws2.emit('close')
    vi.advanceTimersByTime(1000)
    expect(MockWs.instances.length).toBe(2)
  })
})
