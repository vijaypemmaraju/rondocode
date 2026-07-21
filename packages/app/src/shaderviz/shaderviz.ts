import type { EditorHandle } from '../editor/editor'
import type { AudioSession } from '../audio/AudioSession'
import { icon } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { createShaderRenderer, DEFAULT_FRAG } from './renderer'

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
    sampleRate: () => audio.sampleRate,
    onError: (msg) => {
      if (msg === null) toast.classList.add('hidden')
      else {
        toast.textContent = msg
        toast.classList.remove('hidden')
      }
    },
  })
  renderer.setCps(editor.session.getState().cps)

  const unsubState = editor.onState((s) => renderer.setCps(s.cps))
  const unsubPat = editor.onPatternEvents((evs) => renderer.pushEvents(evs))
  const unsubVisual = editor.onVisual((wgsl, synths) => renderer.setVisual(wgsl, synths))

  let on = false
  const setOn = (v: boolean): void => {
    on = v
    btn.classList.toggle('active', v)
    btn.setAttribute('aria-pressed', String(v))
    canvas.classList.toggle('visible', v)
    document.body.classList.toggle('shaderviz-on', v)
    if (!v) toast.classList.add('hidden')
    renderer.setActive(v)
  }
  btn.addEventListener('click', () => setOn(!on))

  return {
    dispose(): void {
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
