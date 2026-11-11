import './style.css'
import { cycleToMeasure, measureToCycle } from '@rondocode/pattern'
import { AudioSession } from './audio/AudioSession'
import { mountEditor } from './editor/editor'
import type { EditorHandle } from './editor/editor'
import { rondoMode } from './editor/langflag'
import { mountLibrary } from './editor/library'
import type { ProjectStore } from './session/projects'
import { mountDocs } from './editor/docspanel'
import { mountSynthLib } from './editor/synthlib'
import { mountShaderViz } from './shaderviz/shaderviz'
import { mountProbes } from './editor/probes'
import { mountOptions } from './ui/options'
import { getSetting } from './ui/settings'
import { looksMobile } from './audio/devices'
import { mountTour } from './ui/tour'
import { mountMidi } from './editor/midi'
import { mountMask } from './editor/mask'
import { mountHeaderOverflow } from './ui/header-overflow'
import { BridgeClient } from './session/bridge-client'
import { nextBoundary } from './session/quantize'
import { applyPalette } from './ui/palette'
import { installViewportFit } from './ui/viewport'

/* MCP bridge wiring: expose the Session command API to the local bridge
 * server (see session/bridge-client.ts for protocol, reach, and the
 * notification-seam rationale). Purely additive — the editor keeps sole
 * ownership of the Session's own callbacks; state notifications ride the
 * EditorHandle.onState subscription seam. The client is silent and retries
 * with backoff when no bridge is running, so the app works standalone. */
const startBridge = (editor: EditorHandle): void => {
  const session = editor.session
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new TypeError(`${name} must be a string`)
    return v
  }
  const num = (v: unknown, name: string): number => {
    if (typeof v !== 'number') throw new TypeError(`${name} must be a number`)
    return v
  }
  const obj = (p: unknown): Record<string, unknown> =>
    typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}
  /* QUANTIZED APPLY: `quantize: N` holds a call until the next cycle that is
   * a multiple of N, so an agent's change lands on a bar line instead of
   * wherever its tool call happened to arrive (see session/quantize.ts for
   * the rule, and for why a program swap goes in early).
   *
   * Resolves to the measure the change lands on, or undefined when nothing
   * was held: no quantize, or the transport is not running. With no clock
   * there is no boundary, and the call applies at once. */
  const SWAP_LEAD_MS = 150
  const quantizeOf = (q: Record<string, unknown>): number | undefined => {
    if (q.quantize === undefined) return undefined
    const n = num(q.quantize, 'quantize')
    if (!(n > 0)) throw new TypeError('quantize must be a positive number of bars')
    return n
  }
  const untilBoundary = (bars: number | undefined, leadMs: number): Promise<number | undefined> => {
    const s = session.getState()
    if (bars === undefined || !s.playing || s.paused) return Promise.resolve(undefined)
    const at = nextBoundary(session.cycle, s.cps, bars, leadMs)
    return new Promise((resolve) => setTimeout(() => resolve(cycleToMeasure(at.cycle)), at.waitMs))
  }
  /* A set_macro moves the SOUND; this moves the number on screen with it. The
   * text is rewritten without an eval, a few times a second, along the same
   * straight line the engine ramps, so the dial the human is looking at shows
   * where the macro is. It also closes the gap that made a ramp fragile: the
   * next eval reads the macro's value from the text, and the text is now where
   * the sound is rather than where it started. Landing re-asserts the target,
   * in case an eval during the ramp cut the engine's glide short. */
  const MACRO_TEXT_MS = 80
  const macroFollowers = new Map<string, ReturnType<typeof setInterval>>()
  const followMacro = (name: string, value: number, rampMs: number | undefined): void => {
    const running = macroFollowers.get(name)
    if (running !== undefined) clearInterval(running)
    macroFollowers.delete(name)
    const from = editor.readMacro(name)
    if (from === undefined) return // not declared in this buffer: nothing to show
    if (rampMs === undefined || rampMs <= MACRO_TEXT_MS) {
      editor.writeMacro(name, value)
      return
    }
    const t0 = performance.now()
    const timer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / rampMs)
      editor.writeMacro(name, from + (value - from) * k)
      if (k < 1) return
      clearInterval(timer)
      macroFollowers.delete(name)
      session.setMacro(name, value)
    }, MACRO_TEXT_MS)
    macroFollowers.set(name, timer)
  }
  const client = new BridgeClient({
    handlers: {
      evalCode: async (p) => {
        const q = obj(p)
        const source = str(q.source, 'source')
        const measure = await untilBoundary(quantizeOf(q), SWAP_LEAD_MS)
        const r = session.evalCode(source)
        return measure === undefined ? r : { ...r, measure }
      },
      getCode: () => ({ code: session.code, lastAttempted: session.lastAttempted }),
      /* The EDITOR's text, which is NOT `getCode`: that answers with the
       * session's evaluated JavaScript, and the human may be writing rondo.
       * Tooling that writes a file back to disk needs the source they are
       * editing, in the language they are editing it in. */
      getDoc: () => ({
        text: editor.view.state.doc.toString(),
        lang: editor.view.state.facet(rondoMode) ? 'rondo' : 'rondocode',
      }),
      /* evalCode's twin, through the editor: the source becomes the buffer
       * (in the language named) and evals on the Run path, so the human sees
       * the agent's program and its sliders and knobs are theirs to move. */
      evalDoc: async (p) => {
        const q = obj(p)
        const lang = q.lang
        if (lang !== undefined && lang !== 'rondo' && lang !== 'rondocode') {
          throw new TypeError(`lang must be rondo|rondocode`)
        }
        const source = str(q.source, 'source')
        const measure = await untilBoundary(quantizeOf(q), SWAP_LEAD_MS)
        const r = editor.evalDoc(source, lang)
        return measure === undefined ? r : { ...r, measure }
      },
      setParam: (p) => {
        const q = obj(p)
        session.setParam(
          str(q.addr, 'addr'),
          num(q.value, 'value'),
          q.rampMs === undefined ? undefined : num(q.rampMs, 'rampMs'),
        )
      },
      /* One macro, every site, optionally eased. Returns how many sites it
       * reached so the caller can tell "no such macro" from "moved it". */
      setMacro: async (p) => {
        const q = obj(p)
        const name = str(q.name, 'name')
        const value = num(q.value, 'value')
        const rampMs = q.rampMs === undefined ? undefined : num(q.rampMs, 'rampMs')
        const measure = await untilBoundary(quantizeOf(q), 0)
        const sites = session.setMacro(name, value, rampMs)
        if (sites > 0) followMacro(name, value, rampMs)
        return measure === undefined ? { ok: sites > 0, sites } : { ok: sites > 0, sites, measure }
      },
      setChannel: (p) => {
        const q = obj(p)
        session.setChannel(str(q.synth, 'synth'), {
          gain: q.gain === undefined ? undefined : num(q.gain, 'gain'),
          pan: q.pan === undefined ? undefined : num(q.pan, 'pan'),
        })
      },
      transport: (p) => {
        const q = obj(p)
        const cmd = str(q.cmd, 'cmd')
        if (cmd !== 'play' && cmd !== 'stop' && cmd !== 'pause' && cmd !== 'resume') {
          throw new TypeError(`cmd must be play|stop|pause|resume`)
        }
        // The wire speaks MEASURES, the way the tool's caller and the header
        // field do; cycles start below this line (see measureToCycle).
        const opts: { cps?: number; from?: number } = {}
        if (q.cps !== undefined) opts.cps = num(q.cps, 'cps')
        if (q.fromMeasure !== undefined) opts.from = measureToCycle(num(q.fromMeasure, 'fromMeasure'))
        const done = session.transport(cmd, opts)
        // pause on a stopped (or unfreezable) session is a no-op, not a
        // failure: say so rather than reporting a hold that never happened.
        return { ok: done, ...session.getState() }
      },
      /* The state, plus WHERE the transport is: the bar it is in (1-based,
       * like the header) and how far through that bar. Without it an agent
       * can only guess at the phrase it is editing into. */
      getState: () => {
        const s = session.getState()
        if (!s.playing) return s
        const cycle = session.cycle
        return { ...s, position: { measure: cycleToMeasure(cycle), phase: Math.round((cycle - Math.floor(cycle)) * 1000) / 1000 } }
      },
    },
    getState: () => session.getState(),
    subscribeState: (fn) => editor.onState(fn),
  })
  client.start()
}

// Palette first: style.css consumes var(--c-*) with no fallbacks, so the
// custom properties must exist before anything renders (see ui/palette.ts).
applyPalette()

// Lock the shell to the visible viewport so the mobile keyboard can't scroll
// the header off-screen (see ui/viewport.ts). Runs before mount so #app is
// sized correctly on first paint.
installViewportFit()

const app = document.getElementById('app')
if (!app) throw new Error('missing #app root')

/* No tap-to-start gate: the audio graph is built at load in a SUSPENDED
 * context (silent, no gesture needed), so the editor mounts immediately. The
 * first Run resumes the context from its own click/keypress gesture — that's
 * where the browser's audio-unlock requirement is satisfied (see editor.ts). */
AudioSession.start().then(
  (audio) => {
    const editor = mountEditor(app, audio)
    // mixer + scopes panel removed for now (mountViz) — see viz/viz.ts to restore
    // The library opens the store (IndexedDB, or an in-memory fallback) and
    // it does so asynchronously. The shelf needs the SAME store to hold
    // snippets — a second opener would be a second answer to which backend
    // is in use — so it reads through a getter that is null until this lands.
    let projectStore: ProjectStore | null = null
    const library = mountLibrary(editor)
    void library.then((h) => { projectStore = h.store }).catch((e) => console.warn('[library] failed to mount', e))
    mountDocs(editor)
    mountSynthLib(editor, () => projectStore)
    const shaderviz = mountShaderViz(app, editor, audio)
    mountProbes(editor) // inline live-value readouts on modulation expressions
    // First-run onboarding: a one-question survey sets the default language,
    // a dedicated welcome project owns the coach marks (created through the
    // library, hence the promise). Mounted after docs/synthlib so the coach
    // anchors (docs button, chip bar) exist; auto-shows for first-time
    // visitors only (never over a share link).
    const tour = mountTour(editor, { library })
    /* The saved rig, applied before anything listens. Output routing takes
     * effect immediately; the input choice is held until mic() actually opens
     * a capture, so this never triggers a permission prompt on its own. */
    void audio.setPreferredDevices(getSetting('inputDevice'), getSetting('outputDevice'))
      .catch((e) => console.warn('[audio] preferred devices', e))
    // on a phone the speaker is next to the mic: 'auto' turns on echo
    // cancellation there, so a live mic chain does not simply howl
    void audio.setMicProcessing(getSetting('micProcessing'), looksMobile())
      .catch((e) => console.warn('[audio] mic processing', e))
    mountOptions(editor, {
      showTour: () => tour.start(),
      audio: {
        listDevices: () => audio.listDevices(),
        setPreferredDevices: (i, o) => audio.setPreferredDevices(i, o),
        latency: () => audio.latency(),
        deviceWarnings: () => audio.deviceWarnings(),
        setMicProcessing: (m, mob) => audio.setMicProcessing(m, mob),
        micProcessingActive: () => audio.micProcessingActive(),
      },
    }) // user settings popover (gear)
    mountMidi(editor, audio)
    mountMask(editor) // the Bluetooth LED mask as a pattern output
    mountHeaderOverflow(editor.topbar) // after every module has added its button
    startBridge(editor)
    // DEV-only: singing-engine console hook for bring-up (window.__rcSing).
    if (import.meta.env.DEV) {
      void import('./sing/devhook').then((m) => m.installSingDevHook())
      ;(window as unknown as { __rcEditor: typeof editor }).__rcEditor = editor
      ;(window as unknown as { __rcAudio: typeof audio }).__rcAudio = audio
      // The frame-pacing harness drives the visuals from here rather than by
      // clicking the header button: `pnpm tsx scripts/measure-frames.ts`.
      ;(window as unknown as { __rcViz: typeof shaderviz }).__rcViz = shaderviz
    }
  },
  (e: unknown) => {
    const banner = document.createElement('div')
    banner.className = 'boot-error'
    banner.textContent = `audio failed to start: ${e instanceof Error ? e.message : String(e)}`
    app.append(banner)
  },
)
