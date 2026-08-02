/* Measure FRAME PACING in a real browser, for every shipped example.
 *
 *   pnpm tsx scripts/measure-frames.ts                    # sweep them all
 *   pnpm tsx scripts/measure-frames.ts --examples=edm,acid
 *   pnpm tsx scripts/measure-frames.ts --secs=6 --min-fps=55
 *   pnpm tsx scripts/measure-frames.ts --scroll=0,0.6     # also sample lower
 *
 * WHY THIS EXISTS. Eight commits went into one stutter, and the first five were
 * aimed at costs later measured under 0.1 ms per frame. The measurement that
 * ended it took ten minutes; it just needed a real browser and a number. This
 * is that measurement, kept.
 *
 * WHY NOT A VITEST TEST. Frame pacing is a property of a compositor with a GPU
 * behind it. jsdom has no frames, and headless Chrome's software WebGPU path
 * reports numbers that have nothing to do with a user's machine. So this is an
 * on-demand tool that exits non-zero under --min-fps, not a CI test, and its
 * baseline lives in docs/perf-frames.md next to the machine it was taken on.
 *
 * WHY CDP AND NOT AN AUTOMATION TAB. A tab in a collapsed tab group reports
 * `document.visibilityState === 'hidden'`, and Chrome throttles a hidden tab's
 * requestAnimationFrame to ZERO. You can measure WORK in such a tab (layout,
 * style, paint) but never PACING — which is the only number that matters here.
 * So: launch our own Chrome, foreground, and drive it over the DevTools
 * protocol.
 *
 * WHAT IT REPORTS, per example and per shader state: fps over the window, p95
 * and worst frame gap, dropped frames (a gap over 1.5x the display interval),
 * and — when the shader is on — the render loop's OWN cpu time. That last one
 * is the diagnosis: cpu near zero with fps on the floor means the time is going
 * to paint or to the GPU, not to script, and no amount of staring at the render
 * loop will find it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  /** An already-running dev server to use. Without it we start our own. */
  url: flag('url'),
  port: num('port', 6070),
  cdpPort: num('cdp-port', 9222),
  /** Sample window per (example, shader state, scroll position). */
  secs: num('secs', 4),
  /** Settle time after Run before sampling: audio starts, the first cycle of
   *  widgets paints, the shader compiles and boots the GPU. */
  warmupSecs: num('warmup', 2),
  minFps: num('min-fps', 0),
  /** Device pixel ratio to rasterize at. NOT cosmetic: the compositor's WebGPU
   *  work scales with the surface's PIXELS, so the same page measures ~4x
   *  easier on a 1x display than on the Retina panel most of this app's users
   *  are on. Pinning it makes runs comparable between machines and stops a
   *  green sweep from meaning "the window happened to be on the cheap
   *  monitor". */
  dpr: num('dpr', 2),
  /** Comma-separated example names (substring match), default all. */
  examples: flag('examples'),
  /** 'on' | 'off' | 'both' — measure with the visuals running, not, or each. */
  shader: flag('shader') ?? 'both',
  /** Scroll positions as fractions of the document, e.g. `0,0.6`. The cost
   *  that started all this scaled with the glyph count ON SCREEN, so where the
   *  viewport sits is part of the measurement. */
  scroll: (flag('scroll') ?? '0').split(',').map((s) => Number(s)),
  /** A CSS file appended to the page before measuring. This is how you A/B a
   *  style change without editing the source — and how the harness's own
   *  sensitivity is checked: re-inject a treatment already known to cost
   *  frames and confirm the numbers fall. See docs/perf-frames.md. */
  injectCss: flag('inject-css'),
  /** Leave Chrome open at the end (to poke at it yourself). */
  keep: flag('keep') !== undefined,
  json: flag('json'),
} as const

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Examples that must not be swept unattended: they wait on a permission
 *  prompt or a large model download, and would measure the dialog, not the
 *  frame loop. */
const SKIP = new Set(['singing', 'live mic'])

/* ---------------------------------------------------------------- CDP client */

interface CdpMessage {
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: { message: string }
  params?: Record<string, unknown>
}

class Cdp {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage
      if (msg.id === undefined) return // an event; we subscribe to none
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.fail(new Error(msg.error.message))
      else p.ok(msg.result ?? {})
    })
    /* A browser that goes away must FAIL the calls in flight. Without this the
     * script waits forever on a socket that will never answer — which is
     * exactly what happened the first time someone closed the window. */
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

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error(`${method} did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        ok: (v) => { clearTimeout(timer); ok(v) },
        fail: (e) => { clearTimeout(timer); fail(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluate an expression in the page and return its (awaited) value.
   *  `userGesture` matters: the first Run resumes a suspended AudioContext,
   *  and without a gesture the browser refuses. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
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

async function waitFor<T>(what: string, fn: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const t0 = Date.now()
  let last: unknown
  for (;;) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}: ${String(last)}`)
      await sleep(250)
    }
  }
}

async function startDevServer(port: number): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn('pnpm', ['--filter', '@rondocode/app', 'exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[vite] ${b.toString()}`))
  const url = `http://localhost:${port}/`
  await waitFor('the dev server', async () => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status} — is something else already on :${port}? pass --port`)
    // Not just "a server answered": another project's dev server on this port
    // would answer 200 and then every page call would fail confusingly.
    const html = await r.text()
    if (!html.includes('id="app"')) throw new Error(`:${port} is serving something that is not the app`)
    return true
  })
  return { url, child }
}

async function launchChrome(url: string, cdpPort: number, dpr: number): Promise<{ child: ChildProcess; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'rc-cdp-'))
  const child = spawn(
    CHROME,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The harness clicks Run through Runtime.evaluate with a synthetic
      // gesture; this keeps the audio unlock from depending on that detail.
      '--autoplay-policy=no-user-gesture-required',
      // A fixed window makes the glyph count on screen (and so the paint cost)
      // comparable between runs and between machines.
      '--window-size=1440,900',
      // …and a fixed scale factor makes the PIXEL count comparable. A fresh
      // profile opens wherever the OS puts it, which on a 1x external monitor
      // is a quarter of the surface a Retina user pays for.
      `--force-device-scale-factor=${dpr}`,
      `${url}?fps=1`,
    ],
    { stdio: 'ignore' },
  )
  return { child, profile }
}

/** Refuse to start if something is already debugging on this port. Otherwise
 *  we attach to SOMEONE ELSE'S Chrome — a previous run that never exited, or
 *  the user's own — and measure a page we did not set up. */
async function assertCdpPortFree(cdpPort: number): Promise<void> {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) {
      throw new Error(
        `a Chrome is already listening on :${cdpPort} — close it, or pass --cdp-port=<other>`,
      )
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('already listening')) throw e
    // Anything else (refused, timed out) means the port is free. Good.
  }
}

async function pageSocket(cdpPort: number, appUrl: string): Promise<string> {
  return waitFor('a Chrome page target', async () => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    const targets = (await r.json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    // Match OUR url: a stray tab (or a restored session) is not the app.
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined && t.url.startsWith(appUrl))
    if (!page?.webSocketDebuggerUrl) throw new Error('no page target yet')
    return page.webSocketDebuggerUrl
  })
}

/* --------------------------------------------------------------- page script */

/** Installed once per page load. Kept as a string because it runs THERE. */
const PAGE_HARNESS = `
window.__rcMeasure = {
  /* Sample rAF pacing for \`ms\`. This is the page's own view of frame
   * delivery, so it works with the shader on OR off (the renderer's stats()
   * only exist while it runs). */
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
          const elapsed = now - t0
          const sorted = [...gaps].sort((a, b) => a - b)
          const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0
          const median = at(0.5)
          resolve({
            fps: +(gaps.length / (elapsed / 1000)).toFixed(1),
            p95Ms: +at(0.95).toFixed(1),
            worstMs: +(sorted.length ? sorted[sorted.length - 1] : 0).toFixed(1),
            medianMs: +median.toFixed(1),
            /* A drop is a gap over 1.5 display intervals. The interval is taken
             * from the run's own median rather than assumed to be 16.7 ms: this
             * repo gets measured on a 120 Hz laptop panel and on 60 Hz externals,
             * and hard-coding either turns the other into a wall of false drops. */
            drops: gaps.filter((g) => g > median * 1.5).length,
            frames: gaps.length,
          })
        }
      }
      requestAnimationFrame(tick)
    })
  },

  /* Load an example by name, Run it, and wait for the transport to be live.
   * Looks in EXAMPLES (shipped + the developer's local, gitignored ones), so
   * work in progress can be measured by name — while the default sweep list
   * below stays the SHIPPED set, which is the thing users actually load. */
  async run(name) {
    const mod = window.__rcExamples ?? (window.__rcExamples = await import('/src/examples/index.ts'))
    const ex = mod.EXAMPLES.find((e) => e.name === name)
    if (!ex) throw new Error('no such example: ' + name)
    const ed = window.__rcEditor
    ed.setLang('rondocode')
    ed.loadCode(ex.code)
    const run = document.querySelector('button.btn.run')
    if (!run) throw new Error('no Run button')
    run.click()
    return true
  },

  names(all) {
    const mod = window.__rcExamples
    return ((all ? mod?.EXAMPLES : mod?.SHIPPED_EXAMPLES) ?? []).map((e) => e.name)
  },

  stop() {
    window.__rcEditor.session.transport('stop')
  },

  /* Scroll the editor to a fraction of its document. Returns the number of
   * characters actually on screen — the quantity the per-glyph paint cost
   * scaled with, so a slow number is interpretable next to it. */
  scrollTo(frac) {
    const view = window.__rcEditor.view
    const dom = view.scrollDOM
    dom.scrollTop = Math.round((dom.scrollHeight - dom.clientHeight) * frac)
    const { from, to } = view.viewport
    return to - from
  },
}
`

/* -------------------------------------------------------------------- sweep */

interface Sample {
  example: string
  shader: 'on' | 'off'
  scroll: number
  visibleChars: number
  fps: number
  p95Ms: number
  worstMs: number
  medianMs: number
  drops: number
  frames: number
  /** The render loop's own time per frame; only meaningful with the shader on. */
  cpuMs: number | null
}

async function main(): Promise<void> {
  let devServer: ChildProcess | undefined
  let chrome: ChildProcess | undefined
  let profile: string | undefined
  let cdp: Cdp | undefined

  /* Teardown must never throw over the top of a finished sweep: Chrome is
   * still flushing its profile when we kill it, so the temp dir needs retries
   * (ENOTEMPTY), and a failure to clean up is not a failure to measure. */
  const shutdown = (): void => {
    try {
      cdp?.close()
      if (!OPTS.keep) {
        chrome?.kill()
        if (profile !== undefined) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
      devServer?.kill()
    } catch (e) {
      process.stderr.write(`(cleanup) ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  process.on('SIGINT', () => {
    shutdown()
    process.exit(130)
  })

  try {
    let url = OPTS.url
    if (url === undefined) {
      process.stderr.write(`starting a dev server on :${OPTS.port}…\n`)
      const started = await startDevServer(OPTS.port)
      url = started.url
      devServer = started.child
    }

    process.stderr.write(`launching Chrome at ${url}\n`)
    await assertCdpPortFree(OPTS.cdpPort)
    const launched = await launchChrome(url, OPTS.cdpPort, OPTS.dpr)
    chrome = launched.child
    profile = launched.profile

    cdp = await Cdp.connect(await pageSocket(OPTS.cdpPort, url))
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // The dev hooks appear only after AudioSession.start() resolves and the
    // editor mounts, so wait for the hook itself rather than for a load event.
    await waitFor('the app to boot (window.__rcEditor)', async () => {
      const ok = await cdp!.eval<boolean>('typeof window.__rcEditor === "object" && typeof window.__rcViz === "object"')
      if (!ok) throw new Error('not yet')
      return true
    })
    await cdp.eval(PAGE_HARNESS)

    if (OPTS.injectCss !== undefined && OPTS.injectCss !== '') {
      const css = readFileSync(OPTS.injectCss, 'utf8')
      await cdp.eval(
        `(() => { const s = document.createElement('style'); s.id = 'rc-measure-inject';` +
        ` s.textContent = ${JSON.stringify(css)}; document.head.append(s); return true })()`,
      )
      process.stderr.write(`injected ${OPTS.injectCss}\n`)
    }

    // A first load also forces the examples module to import, so the name
    // lists below are populated.
    const named = OPTS.examples !== undefined && OPTS.examples !== ''
    const all = await cdp.eval<string[]>(
      `window.__rcMeasure.run("acid").then(() => window.__rcMeasure.names(${named}))`,
    )
    const wanted = !named
      ? all.filter((n) => !SKIP.has(n))
      : all.filter((n) => OPTS.examples!.split(',').some((f) => n.includes(f.trim())))
    if (wanted.length === 0) throw new Error(`no example matched --examples=${OPTS.examples ?? ''}`)

    const states: ('on' | 'off')[] = OPTS.shader === 'both' ? ['on', 'off'] : [OPTS.shader as 'on' | 'off']
    const samples: Sample[] = []

    for (const name of wanted) {
      await cdp.eval(`window.__rcMeasure.run(${JSON.stringify(name)})`)
      await sleep(OPTS.warmupSecs * 1000)
      for (const shader of states) {
        await cdp.eval(`window.__rcViz.setOn(${shader === 'on'})`)
        await sleep(600) // the GPU boots lazily on first activation
        for (const frac of OPTS.scroll) {
          const visibleChars = await cdp.eval<number>(`window.__rcMeasure.scrollTo(${frac})`)
          await sleep(300)
          const s = await cdp.eval<Omit<Sample, 'example' | 'shader' | 'scroll' | 'visibleChars' | 'cpuMs'>>(
            `window.__rcMeasure.frames(${OPTS.secs * 1000})`,
          )
          const cpuMs = shader === 'on'
            ? await cdp.eval<number>('window.__rcViz.stats().cpuMs')
            : null
          const row: Sample = { example: name, shader, scroll: frac, visibleChars, cpuMs, ...s }
          samples.push(row)
          process.stderr.write(
            `  ${name.padEnd(16)} shader:${shader.padEnd(3)} scroll:${frac.toFixed(2)} ` +
            `${String(row.fps).padStart(5)} fps  p95 ${String(row.p95Ms).padStart(5)}ms  ` +
            `worst ${String(row.worstMs).padStart(6)}ms  drops ${row.drops}` +
            (cpuMs === null ? '' : `  cpu ${cpuMs}ms`) + `\n`,
          )
        }
      }
      await cdp.eval('window.__rcMeasure.stop()')
    }

    report(samples)
    if (OPTS.json !== undefined && OPTS.json !== '') {
      writeFileSync(OPTS.json, JSON.stringify(samples, null, 2))
      process.stderr.write(`wrote ${OPTS.json}\n`)
    }

    if (OPTS.minFps > 0) {
      const bad = samples.filter((s) => s.fps < OPTS.minFps)
      if (bad.length > 0) {
        process.stderr.write(`\nFAIL: ${bad.length} sample(s) under ${OPTS.minFps} fps\n`)
        process.exitCode = 1
      }
    }
  } finally {
    shutdown()
  }
}

function report(samples: Sample[]): void {
  const byExample = new Map<string, Sample[]>()
  for (const s of samples) {
    const list = byExample.get(s.example) ?? []
    list.push(s)
    byExample.set(s.example, list)
  }
  const worst = (rows: Sample[]): number => Math.min(...rows.map((r) => r.fps))
  const order = [...byExample.entries()].sort((a, b) => worst(a[1]) - worst(b[1]))

  process.stdout.write(`\n${'example'.padEnd(16)} ${'on'.padStart(7)} ${'off'.padStart(7)}  ${'p95'.padStart(7)}  ${'worst'.padStart(8)}  chars\n`)
  for (const [name, rows] of order) {
    const on = rows.filter((r) => r.shader === 'on')
    const off = rows.filter((r) => r.shader === 'off')
    const fps = (rs: Sample[]): string => (rs.length === 0 ? '—' : String(Math.min(...rs.map((r) => r.fps))))
    const p95 = Math.max(...rows.map((r) => r.p95Ms))
    const wst = Math.max(...rows.map((r) => r.worstMs))
    const chars = Math.max(...rows.map((r) => r.visibleChars))
    process.stdout.write(
      `${name.padEnd(16)} ${fps(on).padStart(7)} ${fps(off).padStart(7)}  ${`${p95}ms`.padStart(7)}  ${`${wst}ms`.padStart(8)}  ${chars}\n`,
    )
  }
}

main().then(
  /* Exit EXPLICITLY. A killed `pnpm` leaves its vite grandchild holding the
   * stdio pipes we opened, so the event loop stays alive and the script hangs
   * after printing its results — which then blocks the next run out of the
   * debugging port. */
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(1)
  },
)
