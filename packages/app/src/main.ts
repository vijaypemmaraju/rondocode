import './style.css'
import { AudioSession } from './audio/AudioSession'
import { mountEditor } from './editor/editor'
import type { EditorHandle } from './editor/editor'
import { mountLibrary } from './editor/library'
import { mountDocs } from './editor/docspanel'
import { mountSynthLib } from './editor/synthlib'
import { mountShaderViz } from './shaderviz/shaderviz'
import { mountProbes } from './editor/probes'
import { mountOptions } from './ui/options'
import { mountMidi } from './editor/midi'
import { mountHeaderOverflow } from './ui/header-overflow'
import { BridgeClient } from './session/bridge-client'
import { applyPalette } from './ui/palette'

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
    void mountLibrary(editor).catch((e) => console.warn('[library] failed to mount', e))
    mountDocs(editor)
    mountSynthLib(editor)
    mountShaderViz(app, editor, audio)
    mountProbes(editor) // inline live-value readouts on modulation expressions
    mountOptions(editor) // user settings popover (gear)
    mountMidi(editor, audio)
    mountHeaderOverflow(editor.topbar) // after every module has added its button
    startBridge(editor)
  },
  (e: unknown) => {
    const banner = document.createElement('div')
    banner.className = 'boot-error'
    banner.textContent = `audio failed to start: ${e instanceof Error ? e.message : String(e)}`
    app.append(banner)
  },
)
