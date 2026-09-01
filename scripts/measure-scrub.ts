/* Measure what a NUMBER SCRUB costs, in a real browser.
 *
 *   pnpm tsx scripts/measure-scrub.ts                 # club example, `onepole 380`
 *   pnpm tsx scripts/measure-scrub.ts --secs=5 --needle="adsr .008" --offset=5
 *   pnpm tsx scripts/measure-scrub.ts --example=poly
 *
 * WHY THIS EXISTS. "Dragging a number lags the audio but a knob doesn't" got a
 * confident diagnosis from source (per-rewrite widget rebuilds starving the
 * scheduler), a branch that fixed it, and then this measurement: the rebuilds
 * cost nothing measurable, and the lag was a fixed 70 ms eval throttle. The
 * harness is kept so the next drag-latency report starts with a number.
 *
 * WHAT IT DOES. Starts a dev server, launches Chrome (CDP), loads a rondo
 * example, presses Run, then performs a synthetic Alt+drag on one literal,
 * sweeping back and forth for `secs`. Meanwhile it taps `view.dispatch` (each
 * doc-changing transaction is a rewrite) and `AudioSession.send` (each engine
 * message), and reports:
 *   - latency: rewrite -> first engine message (median / p90 / max) and which
 *     message kinds carried it. This is the number a finger feels.
 *   - frames: rAF pacing during the drag (the frames harness's metric).
 *   - work: long tasks and DOM churn inside the editor content.
 *   - a sanity line: the literal actually changed, and the widget DOM count
 *     is the same after release as before.
 *
 * The frames harness (measure-frames.ts) carries the CDP rationale; this
 * shares its shape rather than its code so each stays a single file to read. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ------------------------------------------------------------------ options */

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  const eq = hit.indexOf('=')
  return eq === -1 ? '' : hit.slice(eq + 1)
}
const num = (name: string, dflt: number): number => {
  const v = flag(name)
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got ${JSON.stringify(v)}`)
  return n
}

const OPTS = {
  port: num('port', 6071),
  cdpPort: num('cdp-port', 9223),
  /** Drag duration. */
  secs: num('secs', 3),
  /** The rondo example (packages/rondo/examples/<name>.rondo). */
  example: flag('example') ?? 'club',
  /** The text to find, and the offset into it of the literal to drag. */
  needle: flag('needle') ?? 'onepole 380',
  offset: num('offset', 9),
  /** Pixels per pointer move and the sweep half-width. */
  step: num('step', 6),
  sweep: num('sweep', 160),
  /** A label for the output lines, so A/B runs read side by side. */
  label: flag('label') ?? 'scrub',
}

const ROOT = new URL('..', import.meta.url).pathname
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/* ---------------------------------------------------------------------- cdp */

interface CdpMessage {
  id?: number
  result?: Record<string, unknown>
  error?: { message: string }
}

class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>()

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.fail(new Error(msg.error.message))
      else p.ok(msg.result ?? {})
    })
    ws.addEventListener('close', () => {
      for (const [, p] of this.pending) p.fail(new Error('the browser closed the DevTools connection'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error(`cannot open a CDP socket at ${wsUrl}`)), { once: true })
    })
    return new Cdp(ws)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    const ex = r['exceptionDetails'] as { exception?: { description?: string }; text?: string } | undefined
    if (ex) throw new Error(`page threw: ${ex.exception?.description ?? ex.text ?? 'unknown'}`)
    return (r['result'] as { value: T }).value
  }

  close(): void {
    this.ws.close()
  }
}

/* ------------------------------------------------------------------ plumbing */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(what: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}: ${String(e)}`)
      await sleep(250)
    }
  }
}

/* --------------------------------------------------------------- page script */

/** Installed once per page load. Kept as a string because it runs THERE. */
const PAGE_HARNESS = `
window.__rcScrub = {
  frames(ms) {
    return new Promise((resolve) => {
      const gaps = []
      let prev = performance.now()
      const t0 = prev
      const tick = () => {
        const now = performance.now()
        gaps.push(now - prev)
        prev = now
        if (now - t0 < ms) requestAnimationFrame(tick)
        else {
          const sorted = [...gaps].sort((a, b) => a - b)
          const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
          const median = at(0.5)
          resolve({
            fps: +(gaps.length / ((now - t0) / 1000)).toFixed(1),
            p95Ms: +at(0.95).toFixed(1),
            worstMs: +sorted[sorted.length - 1].toFixed(1),
            drops: gaps.filter((g) => g > median * 1.5).length,
          })
        }
      }
      requestAnimationFrame(tick)
    })
  },

  /* Tap the two ends of the pipeline: every doc-changing dispatch is a
   * rewrite, every non-note engine message is the sound catching up. */
  tap() {
    this.edits = []
    this.msgs = []
    const view = window.__rcEditor.view
    const dispatch = view.dispatch.bind(view)
    view.dispatch = (...a) => {
      if (a[0] && a[0].changes) this.edits.push(performance.now())
      return dispatch(...a)
    }
    const audio = window.__rcAudio
    const send = audio.send.bind(audio)
    audio.send = (m) => {
      if (m.kind !== 'noteOn' && m.kind !== 'noteOff') this.msgs.push({ t: performance.now(), kind: m.kind })
      return send(m)
    }
  },

  latency() {
    const gaps = []
    const kinds = {}
    for (const m of this.msgs) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1
    for (const e of this.edits) {
      const m = this.msgs.find((m) => m.t >= e)
      if (m) gaps.push(m.t - e)
    }
    gaps.sort((a, b) => a - b)
    const at = (q) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))].toFixed(1) : null)
    return { rewrites: this.edits.length, engineMsgs: this.msgs.length, kinds, medianMs: at(0.5), p90Ms: at(0.9), maxMs: at(1) }
  },

  arm() {
    this.longTasks = []
    this.added = 0
    this.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) this.longTasks.push(e.duration) })
    this.po.observe({ type: 'longtask' })
    this.mo = new MutationObserver((ms) => { for (const m of ms) this.added += m.addedNodes.length })
    this.mo.observe(document.querySelector('.cm-content'), { childList: true, subtree: true })
  },

  disarm() {
    this.po.disconnect()
    this.mo.disconnect()
    const lt = this.longTasks
    return { longTasks: lt.length, longTaskMs: +lt.reduce((a, b) => a + b, 0).toFixed(0), addedNodes: this.added }
  },

  widgets() {
    return document.querySelector('.cm-content').querySelectorAll('[class^="rondo-"], .cm-widgetBuffer').length
  },

  doc() {
    return window.__rcEditor.view.state.doc.toString()
  },

  /* Viewport coordinates of the literal: scroll it into view first. */
  target(needle, offset) {
    const view = window.__rcEditor.view
    const at = view.state.doc.toString().indexOf(needle)
    if (at === -1) throw new Error('needle not in doc: ' + needle)
    const pos = at + offset
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    return new Promise((r) => requestAnimationFrame(() => {
      const c = view.coordsAtPos(pos)
      r({ x: c.left + 4, y: (c.top + c.bottom) / 2 })
    }))
  },
}
`

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const code = readFileSync(join(ROOT, 'packages', 'rondo', 'examples', `${OPTS.example}.rondo`), 'utf8')
  const url = `http://localhost:${OPTS.port}/`
  // detached: killing the process GROUP takes vite down with its pnpm parent
  const vite = spawn('pnpm', ['--filter', '@rondocode/app', 'exec', 'vite', '--port', String(OPTS.port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  vite.stderr?.on('data', (b: Buffer) => process.stderr.write(`[vite] ${b.toString()}`))
  let chrome: ChildProcess | undefined
  let profile: string | undefined
  let cdp: Cdp | undefined
  try {
    await waitFor('the dev server', async () => {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      if (!(await r.text()).includes('id="app"')) throw new Error(`:${OPTS.port} is serving something that is not the app`)
      return true
    })
    profile = mkdtempSync(join(tmpdir(), 'rc-scrub-'))
    chrome = spawn(
      CHROME,
      [
        `--remote-debugging-port=${OPTS.cdpPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1440,900',
        '--force-device-scale-factor=2',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
    const wsUrl = await waitFor('a Chrome page target', async () => {
      const r = await fetch(`http://127.0.0.1:${OPTS.cdpPort}/json/list`)
      const targets = (await r.json()) as { type: string; webSocketDebuggerUrl?: string }[]
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined)
      if (!page?.webSocketDebuggerUrl) throw new Error('no page target yet')
      return page.webSocketDebuggerUrl
    })
    cdp = await Cdp.connect(wsUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // a fresh profile gets the onboarding survey, which sits over the editor
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('rc.tourDone', '1')" })
    await cdp.send('Page.navigate', { url })
    await cdp.send('Page.bringToFront')
    await waitFor('the app to boot (window.__rcEditor)', async () => {
      if (!(await cdp!.eval<boolean>('typeof window.__rcEditor === "object" && typeof window.__rcAudio === "object"'))) throw new Error('not yet')
      return true
    })
    await cdp.eval(PAGE_HARNESS)
    await cdp.eval(
      `window.__rcEditor.setLang('rondo'); window.__rcEditor.loadCode(${JSON.stringify(code)}); document.querySelector('button.btn.run').click(); true`,
    )
    await sleep(2500) // audio up, first cycle of widgets painted

    const docBefore = await cdp.eval<string>('window.__rcScrub.doc()')
    const widgetsBefore = await cdp.eval<number>('window.__rcScrub.widgets()')
    const { x, y } = await cdp.eval<{ x: number; y: number }>(
      `window.__rcScrub.target(${JSON.stringify(OPTS.needle)}, ${OPTS.offset})`,
    )
    await sleep(300)
    const under = await cdp.eval<string>(`(document.elementFromPoint(${x}, ${y})?.textContent ?? '').slice(0, 20)`)

    const dragMs = OPTS.secs * 1000
    await cdp.eval(`window.__rcScrub.tap(); window.__rcScrub.arm(); window.__framesP = window.__rcScrub.frames(${dragMs + 200}); true`)
    // Alt+drag (modifiers: 1 = Alt): press, sweep back and forth, release
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 1 })
    const t0 = Date.now()
    let dx = 0
    let dir = 1
    let moves = 0
    while (Date.now() - t0 < dragMs) {
      dx += OPTS.step * dir
      if (Math.abs(dx) > OPTS.sweep) dir = -dir
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y, button: 'left', modifiers: 1 })
      moves++
      await sleep(16)
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y, button: 'left', clickCount: 1, modifiers: 1 })
    const frames = await cdp.eval<Record<string, number>>('window.__framesP')
    const work = await cdp.eval<Record<string, number>>('window.__rcScrub.disarm()')
    await sleep(400) // the trailing eval and the release rebuild
    const latency = await cdp.eval<Record<string, unknown>>('window.__rcScrub.latency()')
    const docAfter = await cdp.eval<string>('window.__rcScrub.doc()')
    const widgetsAfter = await cdp.eval<number>('window.__rcScrub.widgets()')
    await cdp.eval(`window.__rcEditor.session.transport('stop'); true`)

    const lineWith = (s: string): string => (s.split('\n').find((l) => l.includes(OPTS.needle.split(' ')[0]!)) ?? '?').trim()
    const L = `[${OPTS.label}]`
    console.log(`${L} under pointer "${under}"  moves=${moves}  "${lineWith(docBefore)}" -> "${lineWith(docAfter)}"`)
    console.log(`${L} latency  ${JSON.stringify(latency)}`)
    console.log(`${L} frames   ${JSON.stringify(frames)}`)
    console.log(`${L} work     ${JSON.stringify(work)}  widgets ${widgetsBefore} -> ${widgetsAfter}`)
    if (docBefore === docAfter) {
      console.error(`${L} the drag did not rewrite the literal: nothing above was measured`)
      process.exitCode = 1
    }
  } finally {
    cdp?.close()
    chrome?.kill()
    if (vite.pid !== undefined) {
      try {
        process.kill(-vite.pid)
      } catch {
        vite.kill()
      }
    }
    await sleep(800) // Chrome flushes its profile on exit
    if (profile !== undefined) {
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        // still flushing; a temp dir is fine to leave
      }
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
