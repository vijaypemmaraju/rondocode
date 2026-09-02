import './style.css'
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
  const client = new BridgeClient({
    handlers: {
      evalCode: (p) => session.evalCode(str(obj(p).source, 'source')),
      getCode: () => ({ code: session.code, lastAttempted: session.lastAttempted }),
      /* The EDITOR's text, which is NOT `getCode`: that answers with the
       * session's evaluated JavaScript, and the human may be writing rondo.
       * Tooling that writes a file back to disk needs the source they are
       * editing, in the language they are editing it in. */
      getDoc: () => ({
        text: editor.view.state.doc.toString(),
        lang: editor.view.state.facet(rondoMode) ? 'rondo' : 'rondocode',
      }),
      setParam: (p) => {
        const q = obj(p)
        session.setParam(
          str(q.addr, 'addr'),
          num(q.value, 'value'),
          q.rampMs === undefined ? undefined : num(q.rampMs, 'rampMs'),
        )
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
        if (cmd !== 'play' && cmd !== 'stop') throw new TypeError(`cmd must be play|stop`)
        session.transport(cmd, q.cps === undefined ? undefined : { cps: num(q.cps, 'cps') })
      },
      getState: () => session.getState(),
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
