import type { EditorHandle } from '../editor/editor'
import type { AudioSession } from '../audio/AudioSession'
import { icon } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { createShaderRenderer, DEFAULT_FRAG } from './renderer'
import { getMacroValues } from '@rondocode/pattern'

/* ------------------------------------------------------------------------- *
 * Editor visuals: a full-bleed WebGPU canvas behind the editor, driven by the
 * live audio, toggled from the header. The rendering engine lives in
 * renderer.ts (shared with the docs page); this file is just the editor
 * chrome + wiring (button, canvas, error toast, and the editor→renderer
 * subscriptions). User code registers a fragment via visual(`…`).
 * ------------------------------------------------------------------------- */

export interface ShaderVizHandle {
  /** Turn the visuals on/off exactly as the header button does. Exposed so a
   *  measurement harness can hold the shader in a known state instead of
   *  synthesizing a click and hoping. */
  setOn(v: boolean): void
  /** Whether the visuals are currently on. */
  isOn(): boolean
  /** Frame pacing over the last ~2 s — the same numbers the `?fps=1` readout
   *  prints. See scripts/measure-frames.ts. */
  stats(): { fps: number; p95Ms: number; worstMs: number; cpuMs: number; drops: number }
  dispose(): void
}

// Re-exported so existing importers of the default fragment keep working.
export { DEFAULT_FRAG }

export function mountShaderViz(root: HTMLElement, editor: EditorHandle, audio: AudioSession): ShaderVizHandle {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn shaderviz-btn'
  btn.innerHTML = `${icon('sparkles')}<span class="btn-label">visuals</span>`
  tooltip(btn, 'programmable visuals')
  const controls = root.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(btn, controls.firstChild)

  const canvas = document.createElement('canvas')
  canvas.className = 'shaderviz-canvas'
  document.body.insertBefore(canvas, document.body.firstChild)

  const toast = document.createElement('div')
  toast.className = 'shaderviz-toast hidden'
  document.body.append(toast)

  const renderer = createShaderRenderer(canvas, {
    now: () => audio.currentTimeFrames / audio.sampleRate,
    analyser: () => audio.analyser,
    analyserL: () => audio.analyserL,
    analyserR: () => audio.analyserR,
    sampleRate: () => audio.sampleRate,
    onError: (msg) => {
      if (msg === null) toast.classList.add('hidden')
      else {
        toast.textContent = msg
        toast.classList.remove('hidden')
      }
    },
  })
  const state0 = editor.session.getState()
  renderer.setCps(state0.cps)
  renderer.setPlaying(state0.playing)

  const unsubState = editor.onState((s) => {
    renderer.setCps(s.cps)
    renderer.setPlaying(s.playing)
  })
  const unsubPat = editor.onPatternEvents((evs) => renderer.pushEvents(evs))
  const unsubVisual = editor.onVisual((wgsl, synths) => renderer.setVisual(wgsl, synths))
  // Per-synth levels ride the engine's existing meter cadence — the same
  // events the header meter and the inline channel bars already consume.
  const unsubEngine = editor.onEngineEvent((ev) => {
    if (ev.kind !== 'meters') return
    renderer.setMeters({
      channels: ev.channels,
      ...(typeof ev.duck === 'number' ? { duck: ev.duck } : {}),
      ...(typeof ev.mic === 'number' ? { mic: ev.mic } : {}),
    })
    // macros/knobs are read on the same tick: they change from a finger on a
    // widget, from MIDI, or from a re-eval, and no one of those has a single
    // notification the shader could hang off
    renderer.setParams(Object.fromEntries(getMacroValues()))
  })

  /* POINTER, in uv space with y flipped to match the shader's coordinates.
   *
   * NO LAYOUT READ IN THE HANDLER. getBoundingClientRect() here forces a style
   * and layout flush, pointermove fires at display rate or faster, and the
   * cost scales with how complicated the DOM is — so with the editor's widgets
   * on screen it was a full layout recalculation several hundred times a
   * second, which is precisely when the visuals went choppy.
   *
   * The canvas is a fixed full-bleed element, so the viewport IS its box.
   * Listeners are attached only while the visuals are on, since a pointer
   * handler for an invisible canvas is pure overhead. */
  const onMove = (e: PointerEvent): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    if (w > 0 && h > 0) renderer.setPointer(e.clientX / w, 1 - e.clientY / h)
  }
  const onDown = (e: PointerEvent): void => { onMove(e); renderer.pressPointer() }
  const pointerOn = (v: boolean): void => {
    if (v) {
      window.addEventListener('pointermove', onMove, { passive: true })
      window.addEventListener('pointerdown', onDown, { passive: true })
    } else {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
    }
  }

  /* `?fps=1` — a corner readout of frame pacing.
   *
   * Three separate performance "fixes" went into this renderer against a
   * description rather than a number, and two of them were aimed at costs
   * later measured at under 0.1 ms per frame. This is the missing instrument:
   * `cpu` is what the render loop itself spends, so a large gap between `cpu`
   * and the frame interval means the time is going to something ELSE on the
   * main thread or to the GPU, and that distinction is the whole diagnosis. */
  let fpsEl: HTMLElement | null = null
  let fpsTimer = 0
  const showFps = new URLSearchParams(location.search).get('fps') === '1'
  const startFps = (v: boolean): void => {
    if (!showFps) return
    if (v && fpsEl === null) {
      fpsEl = document.createElement('div')
      fpsEl.className = 'shaderviz-fps'
      document.body.append(fpsEl)
      fpsTimer = window.setInterval(() => {
        const s = renderer.stats()
        if (fpsEl !== null) {
          fpsEl.textContent =
            `${s.fps} fps · p95 ${s.p95Ms}ms · worst ${s.worstMs}ms · cpu ${s.cpuMs}ms · ${s.drops} drops`
        }
      }, 400)
    } else if (!v && fpsEl !== null) {
      clearInterval(fpsTimer)
      fpsEl.remove()
      fpsEl = null
    }
  }

  let on = false
  const setOn = (v: boolean): void => {
    on = v
    btn.classList.toggle('active', v)
    btn.setAttribute('aria-pressed', String(v))
    canvas.classList.toggle('visible', v)
    document.body.classList.toggle('shaderviz-on', v)
    if (!v) toast.classList.add('hidden')
    pointerOn(v)
    startFps(v)
    renderer.setActive(v)
  }
  btn.addEventListener('click', () => setOn(!on))

  return {
    setOn,
    isOn: (): boolean => on,
    stats: (): ReturnType<typeof renderer.stats> => renderer.stats(),
    dispose(): void {
      pointerOn(false)
      startFps(false)
      unsubEngine()
      unsubState()
      unsubPat()
      unsubVisual()
      renderer.dispose()
      canvas.remove()
      toast.remove()
      btn.remove()
    },
  }
}
