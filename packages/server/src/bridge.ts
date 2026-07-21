import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'

/* ------------------------------------------------------------------------- *
 * Bridge: the local Node side of the MCP↔browser link. An MCP server (Task
 * 4.2) holds a Bridge and calls `bridge.call('evalCode', …)`; the browser's
 * BridgeClient (packages/app/src/session/bridge-client.ts) connects to
 * ws://localhost:6070/session, executes each request against the live
 * Session, and answers. Plain node:http + ws — no express: the server's only
 * HTTP job is upgrading /session to a WebSocket (and 404ing everything
 * else), which http.createServer covers outright (YAGNI).
 *
 * Protocol — JSON text frames:
 * - server→browser requests:  { id: string, method: string, params?: unknown }
 * - browser→server responses: { id, result?: unknown, error?: { message } }
 * - browser→server notifications (no id, never answered):
 *     { notify: 'diagnostics' | 'state' | 'hello', payload }
 *
 * One active browser session, LATEST WINS: a new /session connection closes
 * the previous one with code 4000 / reason 'superseded' — refreshing the
 * page (or opening a second tab) must hand control to the newest page, not
 * strand it behind a zombie socket. Calls pending on the superseded socket
 * reject with 'session disconnected' (their answers can no longer arrive).
 *
 * Correlation: each call gets a crypto.randomUUID id into a pending map with
 * a per-call timeout; the matching response settles it. Malformed frames
 * (bad JSON, no id/notify, unknown id) are console.warn'd and dropped — a
 * misbehaving browser must never crash the bridge.
 * ------------------------------------------------------------------------- */

/** Close code sent to a browser session displaced by a newer connection. */
export const SUPERSEDED = 4000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  /** The socket the request went out on — its close rejects this call. */
  socket: WebSocket
}

export type NotifyKind = 'diagnostics' | 'state' | 'hello'

export interface BridgeOpts {
  /** Listen port; 0 for ephemeral (tests). Default 6070 (6060 is the Vite
   *  dev server). */
  port?: number
  /** Optional first-look handler for non-upgrade HTTP requests (the LLM
   *  /complete routes). Returns true when it handled the request; otherwise
   *  the bridge falls through to its default 404. */
  httpHandler?: (req: IncomingMessage, res: ServerResponse) => boolean
}

export class Bridge {
  private readonly requestedPort: number
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly pending = new Map<string, Pending>()
  private session: WebSocket | undefined

  /** Browser-initiated notifications land here (assign before/after listen). */
  onNotify: ((kind: NotifyKind, payload: unknown) => void) | undefined

  constructor(opts?: BridgeOpts) {
    this.requestedPort = opts?.port ?? 6070
    const httpHandler = opts?.httpHandler
    // Non-upgrade HTTP requests: give the optional handler (the /complete
    // routes) first look, else a plain 404.
    this.server = createServer((req, res) => {
      if (httpHandler?.(req, res)) return
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('rondocode bridge: WebSocket endpoint at /session\n')
    })
    this.wss = new WebSocketServer({ server: this.server, path: '/session' })
    this.wss.on('connection', (ws) => this.adopt(ws))
  }

  /** True while a browser session socket is open. */
  get connected(): boolean {
    return this.session !== undefined
  }

  /** The actual bound port (differs from opts.port when it was 0). Throws
   *  before listen(). */
  get port(): number {
    const addr = this.server.address()
    if (addr === null || typeof addr === 'string') {
      throw new Error('Bridge: not listening')
    }
    return addr.port
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.requestedPort, () => {
        this.server.removeListener('error', reject)
        resolve()
      })
    })
  }

  /**
   * Send a request to the connected browser session and await its response.
   * Rejects immediately with 'no session connected' when no browser is
   * attached; rejects after timeoutMs (default 5000) if the browser never
   * answers (pending entry is cleaned up either way).
   */
  call(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    const ws = this.session
    if (ws === undefined) {
      return Promise.reject(new Error('no session connected'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`call '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, socket: ws })
      ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
    })
  }

  /** Stop listening and drop the session; pending calls reject. */
  close(): Promise<void> {
    for (const ws of this.wss.clients) ws.close(1001, 'bridge shutting down')
    this.session = undefined
    this.rejectPending(() => true, 'bridge closed')
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve())
      })
    })
  }

  // ---- internals ------------------------------------------------------

  private adopt(ws: WebSocket): void {
    const prev = this.session
    if (prev !== undefined) {
      prev.close(SUPERSEDED, 'superseded by new session')
      // Don't wait for the close handshake: answers from the displaced
      // socket can no longer be trusted to arrive.
      this.rejectPending((p) => p.socket === prev, 'session disconnected')
    }
    this.session = ws
    ws.on('message', (data) => this.onFrame(ws, String(data)))
    ws.on('close', () => {
      if (this.session === ws) this.session = undefined
      this.rejectPending((p) => p.socket === ws, 'session disconnected')
    })
    ws.on('error', (err) => {
      console.warn(`[bridge] session socket error: ${err.message}`)
    })
  }

  private onFrame(ws: WebSocket, text: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      console.warn('[bridge] ignoring non-JSON frame')
      return
    }
    if (typeof msg !== 'object' || msg === null) {
      console.warn('[bridge] ignoring non-object frame')
      return
    }
    const m = msg as { id?: unknown; result?: unknown; error?: unknown; notify?: unknown; payload?: unknown }

    if (typeof m.notify === 'string') {
      if (m.notify === 'diagnostics' || m.notify === 'state' || m.notify === 'hello') {
        this.onNotify?.(m.notify, m.payload)
      } else {
        console.warn(`[bridge] ignoring unknown notification '${m.notify}'`)
      }
      return
    }

    if (typeof m.id !== 'string') {
      console.warn('[bridge] ignoring frame without id or notify')
      return
    }
    const p = this.pending.get(m.id)
    if (p === undefined) {
      console.warn(`[bridge] ignoring response for unknown id ${m.id}`)
      return
    }
    // A response is only honored from the socket the request went to — a
    // superseded session already had its calls rejected.
    if (p.socket !== ws) {
      console.warn(`[bridge] ignoring response for id ${m.id} from a stale socket`)
      return
    }
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error !== undefined) {
      const message =
        typeof m.error === 'object' && m.error !== null && 'message' in m.error
          ? String((m.error as { message: unknown }).message)
          : String(m.error)
      p.reject(new Error(message))
    } else {
      p.resolve(m.result)
    }
  }

  private rejectPending(match: (p: Pending) => boolean, reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (!match(p)) continue
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
  }
}
