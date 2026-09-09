/* Verify the transport in a REAL browser: pause that holds, and starting at
 * a measure.
 *
 *   pnpm tsx scripts/verify-transport.ts
 *
 * WHY A BROWSER AND NOT A VITEST TEST. Both features are made of things jsdom
 * does not have. Pause is an AudioContext refusing to advance its clock, and
 * the unit tests can only assert that against a double that was written to
 * behave that way. The question this answers is whether a REAL suspended
 * context does what the double claims, and whether the button, the field and
 * the keys reach it.
 *
 * Same shape as scripts/measure-frames.ts: our own dev server on a spare
 * port, our own Chrome on a spare CDP port, driven over the DevTools
 * protocol. Nothing here touches the user's Vite on :6060 or their tab.
 *
 * It exits non-zero on the first failed check, and prints what it saw.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 6199
const CDP_PORT = 9333
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/* A song whose three sections play DIFFERENT notes, so the events themselves
 * say which bar the transport is in. Four bars each: intro at measure 1, main
 * at 5, outro at 9. */
const SONG = `bpm 120

synth lead
  saw
  * env
  env = adsr .005 .05 .8 .1

section intro 4
  play lead
    c4 c4 c4 c4

section main 4
  play lead
    e4 e4 e4 e4

section outro 4
  play lead
    g4 g4 g4 g4

song intro main outro
`

/* ---------------------------------------------------------------- CDP client */

interface CdpMessage {
  id?: number
  result?: Record<string, unknown>
  error?: { message: string }
}

class Cdp {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void }>()

  private constructor(ws: WebSocket) {
    this.ws = ws
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

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> {
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

  /** Evaluate in the page. userGesture matters: the first Run resumes a
   *  suspended AudioContext, and without a gesture the browser refuses. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
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

/* REAL key events, through the browser's own input pipeline. A synthetic
 * KeyboardEvent dispatched at contentDOM is not the same thing: CodeMirror
 * resolves 'Mod-Shift-Enter' from the modifier flags, and a hand-built event
 * with both metaKey and ctrlKey set (as one is tempted to write, to cover
 * both platforms) matches NEITHER binding. The first run of this harness
 * "found" two broken shortcuts that way. Modifier bits: Alt 1, Ctrl 2,
 * Meta 4, Shift 8. */
const MOD = process.platform === 'darwin' ? 4 : 2
async function pressKey(cdp: Cdp, key: string, code: string, vk: number, modifiers: number): Promise<void> {
  for (const type of ['keyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    })
  }
}

const checks: { name: string; ok: boolean; saw: unknown }[] = []
const check = (name: string, ok: boolean, saw: unknown): void => {
  checks.push({ name, ok, saw })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      saw: ${JSON.stringify(saw)}`)
}

async function main(): Promise<void> {
  /* ---- dev server ---- */
  const repo = new URL('..', import.meta.url).pathname
  const vite = spawn('pnpm', ['--filter', '@rondocode/app', 'exec', 'vite', '--port', String(PORT), '--strictPort'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://localhost:${PORT}/`
  await waitFor('the dev server', async () => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const html = await r.text()
    if (!html.includes('id="app"')) throw new Error(`:${PORT} is serving something that is not the app`)
    return true
  })
  console.log(`dev server on ${url}`)

  /* ---- chrome ---- */
  const profile = mkdtempSync(join(tmpdir(), 'rc-transport-'))
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      url,
    ],
    { stdio: 'ignore' },
  )

  const wsUrl = await waitFor('a Chrome page target', async () => {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    const targets = (await r.json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined && t.url.startsWith(url))
    if (!page?.webSocketDebuggerUrl) throw new Error('no page target yet')
    return page.webSocketDebuggerUrl
  })
  const cdp = await Cdp.connect(wsUrl)

  const finish = (code: number): never => {
    cdp.close()
    chrome.kill()
    vite.kill()
    process.exit(code)
  }

  try {
    /* A cold Vite optimizes dependencies on first load and then FULL-RELOADS
     * the page, which wipes anything installed before it. So wait for the
     * editor to be there and still be the same one a moment later. */
    await waitFor('the editor to mount and settle', async () => {
      const a = await cdp.eval<boolean>('window.__rcMark = Math.random(); return !!window.__rcEditor?.view')
      await sleep(2000)
      const b = await cdp.eval<boolean>('return !!window.__rcEditor?.view && window.__rcMark !== undefined')
      if (!a || !b) throw new Error('not mounted, or the page reloaded under us')
      return true
    })

    /* Load the song, in rondo, and install a listener that records every note
     * event with the cycle it fired in. That list is the ground truth for
     * every question below: which bar are we in, and did anything sound. */
    await cdp.eval(`
      const ed = window.__rcEditor
      ed.setLang('rondo')
      ed.loadCode(${JSON.stringify(SONG)})
      window.__evs = []
      ed.onPatternEvents((evs) => { for (const e of evs) window.__evs.push({ cycle: e.cycle, note: e.controls.note, t: e.timeSec }) })
      window.__states = []
      ed.onState((s) => window.__states.push({ playing: s.playing, paused: s.paused }))
      return true
    `)
    await sleep(400)

    /* ---- 1. the header controls exist ---- */
    const header = await cdp.eval<Record<string, unknown>>(`
      const q = (s) => document.querySelector(s)
      return {
        from: q('.startfrom') !== null,
        fromValue: q('.startfrom-input')?.value ?? null,
        fromLabel: q('.startfrom-label')?.textContent ?? null,
        pause: q('.pause-btn') !== null,
        pauseHidden: q('.pause-btn')?.classList.contains('hidden') ?? null,
        order: [...document.querySelectorAll('.hdr-controls > *')].map((e) => e.className.split(' ').filter((c) => c !== 'btn' && c !== 'hidden').join('.')),
      }
    `)
    check('the header carries a `from` field and a pause button', header['from'] === true && header['pause'] === true, header)
    check('both are quiet until they mean something (from = 1, pause hidden while stopped)',
      header['fromValue'] === '1' && header['pauseHidden'] === true, header)

    /* ---- 2. plain Run starts at the top ---- */
    await cdp.eval(`document.querySelector('.run').click(); return true`)
    await sleep(1200)
    const top = await cdp.eval<Record<string, unknown>>(`
      const s = window.__rcEditor.session.getState()
      return { cycles: window.__evs.map((e) => e.cycle), notes: window.__evs.map((e) => e.note), playing: s.playing, paused: s.paused, err: s.lastError ?? null }
    `)
    const topCycles = top['cycles'] as number[]
    check('Run with the field at 1 starts at the top', topCycles.length > 0 && topCycles[0] === 0, top)
    check('and it is really playing, with no eval error', top['playing'] === true && top['paused'] === false && top['err'] === null, top)
    check('the pause button appears once there is something to hold',
      await cdp.eval<boolean>(`return !document.querySelector('.pause-btn').classList.contains('hidden')`), null)

    /* ---- 3. PAUSE holds: the audio clock stops, and so does everything ---- */
    const held = await cdp.eval<Record<string, unknown>>(`
      const pressed = { ctx: __rcCtx.currentTime, evs: window.__evs.length, cycle: __rcEditor.session.cycle }
      document.querySelector('.pause-btn').click()
      /* suspend() is asynchronous and takes effect at a render-quantum
       * boundary, so a few ms of audio still go by after the press. Let it
       * land, THEN ask whether the clock has actually stopped: two readings
       * far apart that agree to the microsecond. */
      await new Promise((r) => setTimeout(r, 400))
      const settled = { ctx: __rcCtx.currentTime, evs: window.__evs.length, cycle: __rcEditor.session.cycle }
      await new Promise((r) => setTimeout(r, 1500))
      const later = { ctx: __rcCtx.currentTime, evs: window.__evs.length, cycle: __rcEditor.session.cycle }
      const s = __rcEditor.session.getState()
      return {
        ctxState: __rcCtx.state,
        landedAfterMs: +((settled.ctx - pressed.ctx) * 1000).toFixed(1),
        ctxAdvancedMs: +((later.ctx - settled.ctx) * 1000).toFixed(6),
        newEvents: later.evs - settled.evs,
        cycleMoved: +(later.cycle - settled.cycle).toFixed(9),
        heldAt: +settled.cycle.toFixed(3),
        playing: s.playing, paused: s.paused,
        buttonHeld: document.querySelector('.pause-btn').classList.contains('held'),
        buttonPressed: document.querySelector('.pause-btn').getAttribute('aria-pressed'),
        stopStillThere: !document.querySelector('.stop-btn').classList.contains('hidden'),
      }
    `)
    check('pause suspends the audio context, and it lands within a few ms of the press',
      held['ctxState'] === 'suspended' && (held['landedAfterMs'] as number) < 50, held)
    check('once held, the clock is STOPPED: 1.5s of wall time, zero of audio',
      held['ctxAdvancedMs'] === 0, held)
    check('a frozen clock fires nothing new over 1.5s', held['newEvents'] === 0, held)
    check('and the transport holds its position rather than losing it', held['cycleMoved'] === 0, held)
    check('it reads as playing-but-paused, not stopped', held['playing'] === true && held['paused'] === true, held)
    check('the button says it is held, and stop is still offered',
      held['buttonHeld'] === true && held['buttonPressed'] === 'true' && held['stopStillThere'] === true, held)

    /* ---- 4. RESUME continues rather than restarting ---- */
    const resumed = await cdp.eval<Record<string, unknown>>(`
      const at = __rcEditor.session.cycle
      const n = window.__evs.length
      document.querySelector('.pause-btn').click()
      await new Promise((r) => setTimeout(r, 1500))
      const s = __rcEditor.session.getState()
      const after = window.__evs.slice(n)
      return {
        ctxState: __rcCtx.state,
        heldAt: +at.toFixed(3),
        firstCycleAfter: after.length ? after[0].cycle : null,
        newEvents: after.length,
        paused: s.paused, playing: s.playing,
        buttonHeld: document.querySelector('.pause-btn').classList.contains('held'),
      }
    `)
    const heldAt = resumed['heldAt'] as number
    const firstAfter = resumed['firstCycleAfter'] as number | null
    check('resume starts the clock again and fires notes', resumed['ctxState'] === 'running' && (resumed['newEvents'] as number) > 0, resumed)
    check('it CONTINUES from where it was held, rather than restarting at bar 1',
      firstAfter !== null && firstAfter >= Math.floor(heldAt), { heldAt, firstAfter, ...resumed })
    check('and the button goes back to offering a pause', resumed['paused'] === false && resumed['buttonHeld'] === false, resumed)

    /* ---- 5. the `from` field starts a take at that measure ---- */
    const fromNine = await cdp.eval<Record<string, unknown>>(`
      document.querySelector('.stop-btn').click()
      await new Promise((r) => setTimeout(r, 200))
      const f = document.querySelector('.startfrom-input')
      f.focus(); f.value = '9'
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.__evs = []
      await new Promise((r) => setTimeout(r, 1200))
      return {
        set: document.querySelector('.startfrom').classList.contains('set'),
        shown: f.value,
        cycles: window.__evs.map((e) => e.cycle),
        notes: window.__evs.map((e) => e.note),
      }
    `)
    const nineCycles = fromNine['cycles'] as number[]
    const nineNotes = fromNine['notes'] as number[]
    check('typing 9 and pressing Enter starts the take at measure 9 (cycle 8)',
      nineCycles.length > 0 && nineCycles[0] === 8, fromNine)
    check('and what sounds is the OUTRO, the section that lives there (g4 = 67)',
      nineNotes.length > 0 && nineNotes.every((n) => n === 67), fromNine)
    check('the pill shows it is set, so a remembered start point cannot hide',
      fromNine['set'] === true && fromNine['shown'] === '9', fromNine)

    /* ---- 6. cursor in a section + Cmd/Ctrl+Shift+Enter ---- */
    await cdp.eval(`
      document.querySelector('.stop-btn').click()
      await new Promise((r) => setTimeout(r, 200))
      const view = __rcEditor.view
      window.__docBefore = view.state.doc.toString()
      view.dispatch({ selection: { anchor: window.__docBefore.indexOf('e4 e4 e4 e4') } })  // inside \`main\`, bar 5
      view.focus()
      window.__evs = []
      return true
    `)
    await pressKey(cdp, 'Enter', 'Enter', 13, MOD + 8)
    await sleep(1200)
    const fromCursor = await cdp.eval<Record<string, unknown>>(`
      return {
        shown: document.querySelector('.startfrom-input').value,
        cycles: window.__evs.map((e) => e.cycle),
        notes: window.__evs.map((e) => e.note),
        docUnchanged: __rcEditor.view.state.doc.toString() === window.__docBefore,
      }
    `)
    const curCycles = fromCursor['cycles'] as number[]
    const curNotes = fromCursor['notes'] as number[]
    check('the cursor in `main` fills the field with its first measure (5)', fromCursor['shown'] === '5', fromCursor)
    check('and playback starts there: cycle 4, sounding e4 (64)',
      curCycles.length > 0 && curCycles[0] === 4 && curNotes.every((n) => n === 64), fromCursor)
    check('the shortcut did not type a newline into the document', fromCursor['docUnchanged'] === true, fromCursor)

    /* ---- 7. the keyboard pause, and stop leaving a runnable context ---- */
    await cdp.eval(`__rcEditor.view.focus(); return true`)
    await pressKey(cdp, '.', 'Period', 190, MOD + 8)
    await sleep(500)
    const heldKeys = await cdp.eval<Record<string, unknown>>(
      `return { paused: __rcEditor.session.getState().paused, ctx: __rcCtx.state, playing: __rcEditor.session.getState().playing }`,
    )
    await pressKey(cdp, '.', 'Period', 190, MOD + 8)
    await sleep(500)
    const backKeys = await cdp.eval<Record<string, unknown>>(
      `return { paused: __rcEditor.session.getState().paused, ctx: __rcCtx.state, playing: __rcEditor.session.getState().playing }`,
    )
    const afterStop = await cdp.eval<Record<string, unknown>>(`
      document.querySelector('.stop-btn').click()
      await new Promise((r) => setTimeout(r, 300))
      const s = __rcEditor.session.getState()
      return { ctx: __rcCtx.state, playing: s.playing, paused: s.paused }
    `)
    const keys = { held: heldKeys, back: backKeys, afterStop }
    check('Cmd/Ctrl+Shift+. holds the take', heldKeys['paused'] === true && heldKeys['ctx'] === 'suspended', keys)
    check('and pressing it again carries on',
      backKeys['paused'] === false && backKeys['ctx'] === 'running' && backKeys['playing'] === true, keys)
    check('stop leaves the context RUNNING, so the next run is not silently suspended',
      afterStop['ctx'] === 'running' && afterStop['playing'] === false && afterStop['paused'] === false, keys)

    /* ---- 8. a pause out of a stop is a no-op, not a broken state ---- */
    const whileStopped = await cdp.eval<Record<string, unknown>>(`
      document.querySelector('.pause-btn').click()   // hidden, but click it anyway
      await new Promise((r) => setTimeout(r, 300))
      const s = __rcEditor.session.getState()
      return { ctx: __rcCtx.state, playing: s.playing, paused: s.paused }
    `)
    check('pausing a stopped session does nothing at all',
      whileStopped['ctx'] === 'running' && whileStopped['paused'] === false, whileStopped)

    /* ---- 9. clearing the field goes back to the top ---- */
    const cleared = await cdp.eval<Record<string, unknown>>(`
      const f = document.querySelector('.startfrom-input')
      f.focus(); f.value = ''
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.__evs = []
      await new Promise((r) => setTimeout(r, 1200))
      return { shown: f.value, set: document.querySelector('.startfrom').classList.contains('set'), cycles: window.__evs.map((e) => e.cycle) }
    `)
    const clearedCycles = cleared['cycles'] as number[]
    check('clearing the field is how you undo it: back to measure 1',
      cleared['shown'] === '1' && cleared['set'] === false && clearedCycles[0] === 0, cleared)

    await cdp.eval(`document.querySelector('.stop-btn').click(); return true`)
  } catch (e) {
    console.error(`\nharness failed: ${String(e)}`)
    finish(1)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  finish(failed.length === 0 ? 0 : 1)
}

void main()
