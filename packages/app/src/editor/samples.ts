import type { EditorView } from '@codemirror/view'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'
import { nextMicName, startMicRecording } from './micrec'
import type { MicRecording } from './micrec'

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
  /** current editor language — inserts use rondo or JS syntax accordingly. */
  getLang?: () => 'rondocode' | 'rondo'
}

/** Wire up the samples popover. Returns a disposer. */
export function mountSamplesPopover({ audio, view, anchor, fileInput, getLang }: SamplesPopoverOpts): () => void {
  const pop = el('div', 'samples-pop hidden')
  const list = el('div', 'samples-list')
  const loadBtn = el('button', 'samples-load')
  loadBtn.type = 'button'
  loadBtn.append(iconEl('plus'), el('span', undefined, 'load audio file…'))
  // MIC SAMPLING: record a sound on the device mic → a named, playable sample
  const recBtn = el('button', 'samples-load samples-rec')
  recBtn.type = 'button'
  const recLabel = el('span', undefined, 'record from mic')
  recBtn.append(el('span', 'samples-recdot', '●'), recLabel)
  const recMsg = el('div', 'samples-recmsg')
  recMsg.hidden = true
  pop.append(el('div', 'samples-head', 'samples'), list, loadBtn, recBtn, recMsg)
  document.body.append(pop)

  let open = false
  let rec: MicRecording | null = null
  let recTimer: ReturnType<typeof setInterval> | undefined
  let recStarted = 0

  const setRecUi = (on: boolean): void => {
    recBtn.classList.toggle('recording', on)
    recLabel.textContent = on ? 'stop recording (0.0s)' : 'record from mic'
    if (!on) clearInterval(recTimer)
  }

  const stopRecording = async (): Promise<void> => {
    const r = rec
    rec = null
    setRecUi(false)
    if (r === null) return
    try {
      const { data, sampleRate } = await r.stop()
      if (data.length < 128) {
        recMsg.hidden = false
        recMsg.textContent = 'nothing recorded (all silence?)'
        return
      }
      const name = nextMicName(audio.getSamples().map((x) => x.name))
      audio.loadSamplePcm(name, data, sampleRate)
      recMsg.hidden = true
      render()
    } catch (e) {
      recMsg.hidden = false
      recMsg.textContent = 'recording failed'
      console.warn('[mic] stop failed', e)
    }
  }

  const startRecording = async (): Promise<void> => {
    recMsg.hidden = true
    try {
      rec = await startMicRecording((bytes) => audio.decodeAudio(bytes))
      recStarted = Date.now()
      setRecUi(true)
      recTimer = setInterval(() => {
        recLabel.textContent = `stop recording (${((Date.now() - recStarted) / 1000).toFixed(1)}s)`
      }, 100)
    } catch (e) {
      recMsg.hidden = false
      recMsg.textContent = 'microphone unavailable (permission denied?)'
      console.warn('[mic] start failed', e)
    }
  }

  recBtn.addEventListener('click', () => {
    if (rec !== null) void stopRecording()
    else void startRecording()
  })

  const insert = (name: string): void => {
    // rondo mode inserts rondo syntax; JS mode the API call
    const text = getLang?.() === 'rondo' ? `sample ${name}` : `sample(gate, '${name}')`
    view.dispatch(view.state.replaceSelection(text))
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
      tooltip(play, `preview ${s.name}`)
      play.append(iconEl('play'))
      play.addEventListener('click', (e) => {
        e.stopPropagation()
        audio.previewSample(s.name)
      })
      wrap.append(play)
      const row = el('button', 'samples-row')
      row.type = 'button'
      tooltip(row, `insert ${s.name} at the cursor`)
      const name = el('span', 'samples-name', s.name)
      if (s.builtIn) name.append(el('span', 'samples-tag', 'built-in'))
      row.append(name, el('span', 'samples-dur', fmtDur(s.frames, s.sampleRate)))
      row.addEventListener('click', () => insert(s.name))
      wrap.append(row)
      if (!s.builtIn) {
        const rm = el('button', 'samples-rm')
        rm.type = 'button'
        tooltip(rm, `remove ${s.name}`)
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

  const position = (): void => anchorPopover(pop, anchor)

  const openPop = (): void => {
    render()
    pop.classList.remove('hidden') // must be visible for anchorPopover to measure it
    position()
    open = true
  }
  const close = (): void => {
    audio.stopPreview()
    if (rec !== null) { rec.cancel(); rec = null; setRecUi(false) }
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
