/* ------------------------------------------------------------------------- *
 * BridgeClient: the browser side of the MCP bridge. Connects to the local
 * Node bridge (packages/server/src/bridge.ts) at
 *   ws(s)://<page hostname>:6070/session
 * and answers its JSON requests {id, method, params} with {id, result|error}
 * by dispatching into a handler map built over the live Session (wired in
 * main.ts). Browser→server notifications {notify, payload} carry 'hello' on
 * connect plus 'state' pushes.
 *
 * REACH — where this works, and a known limitation:
 * - localhost dev and plain-http LAN access: ws://host:6070 connects
 *   directly to the bridge. Works out of the box (run `pnpm bridge`).
 * - tailscale HTTPS: `tailscale serve` currently proxies only 443→6060 (the
 *   app), so the wss://host:6070 dial has no listener and the bridge is
 *   simply unreachable from there. To enable it later, add a second
 *   mapping (e.g. `tailscale serve --https=8443 6070`) and point the client
 *   at that port. Until then the client's resilience policy covers it: the
 *   app must work standalone, so connection failures are SILENT and retried
 *   with exponential backoff (1s doubling to a 30s cap, reset on success).
 *
 * NOTIFICATION SEAM (v1 choice, documented per plan): the Session's
 * onDiagnostics/onState callbacks are owned by the editor (editor.ts
 * constructs the Session), and editor.ts is deliberately not modified here.
 * Instead the adapter exposes what main.ts can reach without touching it:
 * - 'state' notifications come from (a) an optional subscribeState seam —
 *   mountEditor's EditorHandle.onState, a real subscription — plus (b) a
 *   getState() push after every handled request and (c) a heartbeat (2s
 *   default) while connected, so the server converges even if a state
 *   change slips past the subscription.
 * - 'diagnostics' notifications are NOT pushed in v1: there is no
 *   subscription seam short of editor.ts, and evalCode responses already
 *   carry the full diagnostics of the eval, which is what an MCP caller
 *   acts on. Runtime-diagnostic push can ride a future editor seam.
 * ------------------------------------------------------------------------- */

/** Structural WebSocket surface — injectable so tests never hit the network.
 *  The 'close' event carries the numeric code so we can honor a deliberate
 *  supersession (SUPERSEDED_CODE) rather than fighting the newer tab. */
export interface WsLike {
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'message' | 'close',
    fn: (ev: { data?: unknown; code?: number }) => void,
  ): void
}
export type WsCtor = new (url: string) => WsLike

/** The bridge closes a superseded session with this code (bridge.ts uses 4000
 *  "superseded by new session"). A tab that receives it must NOT reconnect —
 *  otherwise two open tabs steal the single bridge session from each other in
 *  a ~1s loop, defeating the bridge's latest-wins intent. */
export const SUPERSEDED_CODE = 4000

export interface BridgeAdapter {
  /** method name → implementation over the Session command API. Sync or
   *  async; a throw/rejection becomes an {error:{message}} response. */
  handlers: Record<string, (params: unknown) => unknown | Promise<unknown>>
  /** Current session state, used for 'state' notifications. */
  getState?: () => unknown
  /** Real state subscription (EditorHandle.onState); returns unsubscribe. */
  subscribeState?: (fn: () => void) => () => void
}

export interface BridgeClientOpts {
  /** Full ws URL; default derives from the page location (see header). */
  url?: string
  /** WebSocket constructor injection for tests. Default: globalThis.WebSocket. */
  WebSocketImpl?: WsCtor
  /** 'state' heartbeat period while connected; 0 disables. Default 2000. */
  heartbeatMs?: number
  /** Initial reconnect delay (doubles per failure, capped ×30). Default 1000. */
  retryMs?: number
}

const RETRY_CAP_FACTOR = 30 // 1s..30s with defaults

export const defaultBridgeUrl = (loc: { protocol: string; hostname: string }): string =>
  `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.hostname}:6070/session`

export class BridgeClient {
  private readonly adapter: BridgeAdapter
  private readonly url: string
  private readonly WsImpl: WsCtor
  private readonly heartbeatMs: number
  private readonly baseRetryMs: number
  private retryMs: number
  private ws: WsLike | undefined
  private open = false
  private stopped = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private unsubscribeState: (() => void) | undefined

  constructor(adapter: BridgeAdapter, opts?: BridgeClientOpts) {
    this.adapter = adapter
    this.url = opts?.url ?? defaultBridgeUrl(location)
    this.WsImpl = opts?.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsCtor)
    this.heartbeatMs = opts?.heartbeatMs ?? 2000
    this.baseRetryMs = opts?.retryMs ?? 1000
    this.retryMs = this.baseRetryMs
  }

  get connected(): boolean {
    return this.open
  }

  /** Connect (and keep reconnecting until stop()). Idempotent. */
  start(): void {
    if (this.stopped || this.ws !== undefined) return
    this.unsubscribeState ??= this.adapter.subscribeState?.(() => this.notifyState())
    this.connect()
  }

  /** TERMINAL: close the socket and cease all retries/heartbeats. */
  stop(): void {
    this.stopped = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.stopHeartbeat()
    this.unsubscribeState?.()
    this.unsubscribeState = undefined
    this.ws?.close()
    this.ws = undefined
    this.open = false
  }

  // ---- internals ------------------------------------------------------

  private connect(): void {
    let ws: WsLike
    try {
      ws = new this.WsImpl(this.url)
    } catch {
      this.scheduleRetry() // constructor can throw on bad URL/mixed content
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.open = true
      this.retryMs = this.baseRetryMs
      this.sendFrame({ notify: 'hello', payload: { url: this.url } })
      this.notifyState()
      if (this.heartbeatMs > 0) {
        this.heartbeatTimer = setInterval(() => this.notifyState(), this.heartbeatMs)
      }
    })
    ws.addEventListener('message', (ev) => {
      if (this.ws === ws) void this.onFrame(String(ev.data))
    })
    // 'error' always precedes 'close' on failure — close alone suffices,
    // and listening to both would double-schedule retries.
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.open = false
      this.stopHeartbeat()
      if (ev.code === SUPERSEDED_CODE) {
        // Another tab took over the single bridge session. Go dormant: a
        // reconnect here would just steal it back and thrash. The user can
        // reload this tab to reclaim the bridge.
        this.stopped = true
        console.info('[bridge-client] another tab took over the bridge session; going dormant')
        return
      }
      this.scheduleRetry()
    })
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs)
    this.retryMs = Math.min(this.retryMs * 2, this.baseRetryMs * RETRY_CAP_FACTOR)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private async onFrame(text: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      console.warn('[bridge-client] ignoring non-JSON frame')
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: unknown }
    if (typeof id !== 'string' || typeof method !== 'string') {
      console.warn('[bridge-client] ignoring frame without id/method')
      return
    }
    const handler = this.adapter.handlers[method]
    if (handler === undefined) {
      this.sendFrame({ id, error: { message: `unknown method: ${method}` } })
      return
    }
    try {
      const result = await handler(params)
      this.sendFrame(result === undefined ? { id } : { id, result })
      // Post-request push: any handled call may have mutated the session.
      this.notifyState()
    } catch (e) {
      this.sendFrame({ id, error: { message: e instanceof Error ? e.message : String(e) } })
    }
  }

  private notifyState(): void {
    if (!this.open || this.adapter.getState === undefined) return
    this.sendFrame({ notify: 'state', payload: this.adapter.getState() })
  }

  private sendFrame(frame: unknown): void {
    if (!this.open) return
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch {
      // Socket died between open and send — the close handler will retry.
    }
  }
}
