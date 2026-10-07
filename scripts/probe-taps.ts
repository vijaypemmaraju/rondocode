/* Probe WIDGET TAPS in a real browser: does a second tap still land?
 *
 *   pnpm tsx scripts/probe-taps.ts                  # piano roll, transport running
 *   pnpm tsx scripts/probe-taps.ts --stopped        # same, transport stopped
 *   pnpm tsx scripts/probe-taps.ts --sel=.rondo-beatgrid --example=drums
 *
 * WHY THIS EXISTS. Reported from the field: "the note buttons work the first
 * time I clicked, but then the UI elements stop responding to clicks and at
 * some point stop showing their feedback completely. The music was still
 * playing, and ctrl-enter still worked." Widget pointer handling has no DOM
 * test (widgets.test.ts says so outright: "exercised manually in the
 * browser"), so this is that manual pass, automated.
 *
 * WHAT IT DOES. Starts a dev server, launches Chrome (CDP), loads a rondo
 * example, optionally presses Run, then taps three roll cells in a row with
 * real trusted mouse input and reports, per tap:
 *   - whether the document actually changed (the tap wrote a note)
 *   - whether the grid element is still in the DOM while the finger is down
 *   - whether a `play` class ever lands on a cell again (the playhead
 *     feedback the report says dies)
 * A healthy editor writes on every tap. Exit code 1 if any tap after the
 * first is a no-op.
 *
 * Shares the CDP shape of measure-scrub.ts rather than its code, so each
 * stays a single file to read. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  port: num('port', 6073),
  cdpPort: num('cdp-port', 9225),
  example: flag('example') ?? 'acid',
  /** The widget surface to tap. */
  sel: flag('sel') ?? '.rondo-roll',
  /** How many taps to try. */
  taps: num('taps', 3),
  stopped: flag('stopped') !== undefined,
}

const ROOT = new URL('..', import.meta.url).pathname
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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

/** Installed once per page load. Kept as a string because it runs THERE. */
const PAGE_HARNESS = `
window.__rcTaps = {
  doc() { return window.__rcEditor.view.state.doc.toString() },

  /* Remember the grid we are about to tap, so the next call can say whether
   * it survived. A widget whose DOM was swapped out mid-gesture cannot
   * receive the pointerup that ends the gesture. */
  aim(sel, nth) { return new Promise((r) => requestAnimationFrame(() => r(this.aimNow(sel, nth)))) },

  aimNow(sel, nth) {
    const grids = [...document.querySelectorAll(sel)]
    const grid = grids[0]
    if (!grid) throw new Error('no ' + sel + ' in the document')
    const cells = [...grid.querySelectorAll('.rc')]
    const cell = cells[nth % cells.length]
    if (!cell) throw new Error(sel + ' has no .rc cells')
    /* Scroll it under the pointer: a grid further down the file sits outside
     * the viewport, where elementFromPoint returns null and every synthetic
     * tap silently misses. */
    cell.scrollIntoView({ block: 'center' })
    const r = cell.getBoundingClientRect()
    this.lastGrid = grid
    this.lastCell = cell
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      grids: grids.length,
      cells: cells.length,
      cellSize: Math.round(r.width) + 'x' + Math.round(r.height),
    }
  },

  /* Is the surface we aimed at still in the document? Asked while the
   * pointer is DOWN: a grid torn out by its own first write cannot receive
   * the pointerup that ends the gesture, and the editor wedges. (After the
   * gesture ends it is rebuilt on purpose, so asking later proves nothing.) */
  survived() { return this.lastGrid ? this.lastGrid.isConnected : null },

  /* Watch for the playhead class the report says stops appearing. Observed
   * on .cm-content, NOT on the grids: a rebuild swaps the grid out and an
   * observer bound to it would go blind and report a dead playhead that is
   * actually fine. */
  watchPlay() {
    this.plays = 0
    this.mo = new MutationObserver((ms) => {
      for (const m of ms) if (m.target.classList && m.target.classList.contains('play')) this.plays++
    })
    this.mo.observe(document.querySelector('.cm-content'), {
      attributes: true, attributeFilter: ['class'], subtree: true,
    })
  },
  playCount() { const n = this.plays; this.plays = 0; return n },
  unwatchPlay() { this.mo?.disconnect() },

  /* Which element the pointer will actually hit, as a sanity line. */
  under(x, y) {
    const el = document.elementFromPoint(x, y)
    return el ? el.className + (el.dataset ? ' r=' + el.dataset.r + ' c=' + el.dataset.c : '') : 'nothing'
  },
}
`

/** Press, ask whether the tapped surface is still there, release. */
async function tap(cdp: Cdp, x: number, y: number): Promise<boolean | null> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  const survived = await cdp.eval<boolean | null>('window.__rcTaps.survived()')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return survived
}

async function main(): Promise<void> {
  const code = readFileSync(join(ROOT, 'packages', 'rondo', 'examples', `${OPTS.example}.rondo`), 'utf8')
  const url = `http://localhost:${OPTS.port}/`
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
    profile = mkdtempSync(join(tmpdir(), 'rc-taps-'))
    chrome = spawn(
      CHROME,
      [
        `--remote-debugging-port=${OPTS.cdpPort}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1440,900',
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('rc.tourDone', '1')" })
    await cdp.send('Page.navigate', { url })
    await cdp.send('Page.bringToFront')
    await waitFor('the app to boot (window.__rcEditor)', async () => {
      if (!(await cdp!.eval<boolean>('typeof window.__rcEditor === "object"'))) throw new Error('not yet')
      return true
    })
    await cdp.eval(PAGE_HARNESS)
    await cdp.eval(`window.__rcEditor.setLang('rondo'); window.__rcEditor.loadCode(${JSON.stringify(code)}); true`)
    await sleep(600)
    if (!OPTS.stopped) {
      await cdp.eval(`document.querySelector('button.btn.run').click(); true`)
      await sleep(2500)
    }
    await cdp.eval('window.__rcTaps.watchPlay(); true')

    let doc = await cdp.eval<string>('window.__rcTaps.doc()')
    const results: { n: number; wrote: boolean; survived: boolean | null; plays: number; under: string; line: string }[] = []
    for (let n = 0; n < OPTS.taps; n++) {
      // tap a different cell each time, so "no change" can never be a no-op write
      const aim = await cdp.eval<{ x: number; y: number; grids: number; cells: number; cellSize: string }>(
        `window.__rcTaps.aim(${JSON.stringify(OPTS.sel)}, ${n * 5 + 1})`,
      )
      if (n === 0) console.log(`[taps] ${OPTS.sel}: ${aim.grids} grid(s), ${aim.cells} cells, ${aim.cellSize}px`)
      const under = await cdp.eval<string>(`window.__rcTaps.under(${aim.x}, ${aim.y})`)
      await cdp.eval('window.__rcTaps.playCount()') // reset the window
      const survived = await tap(cdp, aim.x, aim.y)
      await sleep(500)
      const after = await cdp.eval<string>('window.__rcTaps.doc()')
      const plays = await cdp.eval<number>('window.__rcTaps.playCount()')
      const notation = (s: string): string =>
        (s.split('\n').find((l) => /^\s+[-0-9~]/.test(l)) ?? '?').trim()
      results.push({ n: n + 1, wrote: after !== doc, survived, plays, under, line: notation(after) })
      doc = after
    }
    await cdp.eval('window.__rcTaps.unwatchPlay(); true')
    if (!OPTS.stopped) await cdp.eval(`window.__rcEditor.session.transport('stop'); true`)

    for (const r of results) {
      console.log(
        `[taps] tap ${r.n}  wrote=${r.wrote ? 'YES' : 'no '}  alive-under-the-finger=${r.survived}  ` +
          `playhead-flashes=${r.plays}  under="${r.under}"  "${r.line}"`,
      )
    }
    const dead = results.slice(1).filter((r) => !r.wrote)
    if (!results[0]?.wrote) {
      console.error('[taps] the FIRST tap did nothing: the probe is not hitting a cell, nothing below is meaningful')
      process.exitCode = 1
    } else if (dead.length > 0) {
      console.error(`[taps] WEDGED: tap 1 wrote, then ${dead.length}/${results.length - 1} later taps did nothing`)
      process.exitCode = 1
    } else if (results.some((r) => r.survived !== true)) {
      console.error('[taps] a tapped surface was torn out from under the finger: its pointerup has nowhere to land')
      process.exitCode = 1
    } else {
      console.log('[taps] every tap wrote')
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
    await sleep(800)
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
