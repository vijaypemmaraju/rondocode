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

  let on = false
  const setOn = (v: boolean): void => {
    on = v
    btn.classList.toggle('active', v)
    btn.setAttribute('aria-pressed', String(v))
    canvas.classList.toggle('visible', v)
    document.body.classList.toggle('shaderviz-on', v)
    if (!v) toast.classList.add('hidden')
    pointerOn(v)
    renderer.setActive(v)
  }
  btn.addEventListener('click', () => setOn(!on))

  return {
    dispose(): void {
      pointerOn(false)
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
