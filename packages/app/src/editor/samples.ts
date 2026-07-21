import type { EditorView } from '@codemirror/view'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'

/* The samples popover, anchored under the header "+ sample" button. It answers
 * "what have I loaded and how do I use it": lists the built-in and user
 * samples, inserts sample(gate, 'name') at the cursor on click, loads new audio
 * files, and removes user ones. The worklet owns playback; AudioSession keeps
 * the main-thread list this renders from. */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const fmtDur = (frames: number, sampleRate: number): string => {
  const s = frames / sampleRate
  return s < 10 ? `${s.toFixed(2)}s` : `${s.toFixed(1)}s`
}

/** filename -> a valid sample name (letters/digits/underscore), matching the
 *  identifier rules the DSL accepts in sample(gate, '...'). */
const sanitizeName = (fname: string): string =>
  fname.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_')

export interface SamplesPopoverOpts {
  audio: AudioSession
  view: EditorView
  /** the "+ sample" button the popover anchors under and toggles from */
  anchor: HTMLButtonElement
  /** the shared hidden <input type=file> the "load" action triggers */
  fileInput: HTMLInputElement
}

/** Wire up the samples popover. Returns a disposer. */
export function mountSamplesPopover({ audio, view, anchor, fileInput }: SamplesPopoverOpts): () => void {
  const pop = el('div', 'samples-pop hidden')
  const list = el('div', 'samples-list')
  const loadBtn = el('button', 'samples-load')
  loadBtn.type = 'button'
  loadBtn.append(iconEl('plus'), el('span', undefined, 'load audio file…'))
  pop.append(el('div', 'samples-head', 'samples'), list, loadBtn)
  document.body.append(pop)

  let open = false

  const insert = (name: string): void => {
    view.dispatch(view.state.replaceSelection(`sample(gate, '${name}')`))
    view.focus()
    close()
  }

  const render = (): void => {
    const samples = audio.getSamples()
    list.replaceChildren()
    if (samples.length === 0) {
      list.append(el('div', 'samples-empty', 'no samples loaded yet'))
      return
    }
    for (const s of samples) {
      const wrap = el('div', 'samples-rowwrap')
      const play = el('button', 'samples-play')
      play.type = 'button'
      play.title = `preview ${s.name}`
      play.append(iconEl('play'))
      play.addEventListener('click', (e) => {
        e.stopPropagation()
        audio.previewSample(s.name)
      })
      wrap.append(play)
      const row = el('button', 'samples-row')
      row.type = 'button'
      row.title = `insert sample(gate, '${s.name}')`
      const name = el('span', 'samples-name', s.name)
      name.title = s.name // full name; the row ellipsizes
      if (s.builtIn) name.append(el('span', 'samples-tag', 'built-in'))
      row.append(name, el('span', 'samples-dur', fmtDur(s.frames, s.sampleRate)))
      row.addEventListener('click', () => insert(s.name))
      wrap.append(row)
      if (!s.builtIn) {
        const rm = el('button', 'samples-rm')
        rm.type = 'button'
        rm.title = `remove ${s.name}`
        rm.append(iconEl('x'))
        rm.addEventListener('click', (e) => {
          e.stopPropagation()
          audio.removeSample(s.name)
        })
        wrap.append(rm)
      }
      list.append(wrap)
    }
  }

  const position = (): void => {
    const r = anchor.getBoundingClientRect()
    pop.style.top = `${Math.round(r.bottom + 6)}px`
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`
  }

  const openPop = (): void => {
    render()
    position()
    pop.classList.remove('hidden')
    open = true
  }
  const close = (): void => {
    audio.stopPreview()
    pop.classList.add('hidden')
    open = false
  }

  anchor.addEventListener('click', () => (open ? close() : openPop()))
  loadBtn.addEventListener('click', () => fileInput.click())

  // load files from the shared hidden input; keep the popover open so the new
  // sample shows up in the list right away.
  fileInput.addEventListener('change', () => {
    const files = fileInput.files ? Array.from(fileInput.files) : []
    fileInput.value = '' // let the same file be re-picked later
    void (async () => {
      for (const f of files) {
        const name = sanitizeName(f.name)
        try {
          await audio.loadSample(name, await f.arrayBuffer())
        } catch (e) {
          console.warn('[sample] load failed', name, e)
        }
      }
      if (!open) openPop()
    })()
  })

  const unsub = audio.onSamplesChanged(() => {
    if (open) render()
  })

  // dismiss on outside click / Escape
  const onDocClick = (e: MouseEvent): void => {
    if (!open) return
    const t = e.target as Node
    if (pop.contains(t) || anchor.contains(t)) return
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === 'Escape') close()
  }
  // keep the popover pinned under its anchor if the window resizes while open
  const onResize = (): void => {
    if (open) position()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)

  return () => {
    unsub()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    pop.remove()
  }
}
