import type { EditorHandle } from './editor'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'

/* Live MIDI input (Web MIDI): play one of the running synths from a connected
 * keyboard/controller in real time. Note-on/off map straight to the engine's
 * immediate noteOn/noteOff messages. The target synth is picked from the
 * program's current synths (defaults to the last one defined). */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** Wire the MIDI button + popover into the header. Returns a disposer. */
export function mountMidi(editor: EditorHandle, audio: AudioSession): () => void {
  const anchor = el('button', 'btn midi-btn')
  anchor.type = 'button'
  anchor.append(iconEl('midi'))
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(anchor, controls.firstChild)

  let synths: string[] = []
  let target = '' // '' means "last synth"
  let access: MIDIAccess | null = null
  let enabled = false

  const pop = el('div', 'midi-pop hidden')
  const status = el('div', 'midi-status', 'not connected')
  const pick = el('select', 'midi-pick') as HTMLSelectElement
  pick.setAttribute('aria-label', 'synth to play')
  const toggle = el('button', 'export-btn', 'enable MIDI')
  toggle.type = 'button'
  pop.append(
    el('div', 'export-head', 'midi input'),
    status,
    el('label', 'export-label', 'play synth'),
    pick,
    toggle,
    el('div', 'export-hint', 'plays a running synth from a connected keyboard'),
  )
  document.body.append(pop)

  const activeSynth = (): string => target || synths[synths.length - 1] || ''

  const refreshPick = (): void => {
    const cur = pick.value
    pick.replaceChildren(el('option', undefined, 'last defined'))
    ;(pick.firstChild as HTMLOptionElement).value = ''
    for (const s of synths) {
      const o = el('option', undefined, s)
      o.value = s
      pick.append(o)
    }
    pick.value = synths.includes(cur) || cur === '' ? cur : ''
  }
  pick.addEventListener('change', () => (target = pick.value))
  const offState = editor.onState((s) => {
    synths = s.synths
    refreshPick()
  })

  const onMidi = (e: MIDIMessageEvent): void => {
    const data = e.data
    if (!data) return
    const cmd = data[0]! & 0xf0
    const synth = activeSynth()
    if (!synth) return
    if (cmd === 0x90 && data[2]! > 0) {
      audio.send({ kind: 'noteOn', synth, note: data[1]!, velocity: data[2]! / 127 })
    } else if (cmd === 0x80 || (cmd === 0x90 && data[2] === 0)) {
      audio.send({ kind: 'noteOff', synth, note: data[1]! })
    }
  }

  const inputs = (): MIDIInput[] =>
    access ? Array.from((access.inputs as Map<string, MIDIInput>).values()) : []

  const bindInputs = (): void => {
    const ins = inputs()
    for (const input of ins) input.onmidimessage = onMidi
    status.textContent = ins.length === 0 ? 'no devices found' : `${ins.length} device${ins.length === 1 ? '' : 's'} connected`
  }

  const enable = async (): Promise<void> => {
    if (typeof navigator.requestMIDIAccess !== 'function') {
      status.textContent = 'Web MIDI not supported in this browser'
      return
    }
    try {
      access = await navigator.requestMIDIAccess()
      access.onstatechange = bindInputs
      bindInputs()
      enabled = true
      toggle.textContent = 'disable MIDI'
      toggle.classList.add('armed')
    } catch {
      status.textContent = 'permission denied'
    }
  }
  const disable = (): void => {
    for (const input of inputs()) input.onmidimessage = null
    audio.send({ kind: 'allNotesOff' })
    enabled = false
    toggle.textContent = 'enable MIDI'
    toggle.classList.remove('armed')
    status.textContent = 'not connected'
  }
  toggle.addEventListener('click', () => {
    if (enabled) disable()
    else void enable()
  })

  // popover open/close under the button
  let open = false
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
  }
  const openPop = (): void => {
    refreshPick()
    pop.classList.remove('hidden') // visible first so anchorPopover can measure it
    anchorPopover(pop, anchor)
    open = true
  }
  anchor.addEventListener('click', () => (open ? close() : openPop()))
  const onDocClick = (e: MouseEvent): void => {
    if (!open) return
    const t = e.target as Node
    if (pop.contains(t) || anchor.contains(t)) return
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === 'Escape') close()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  tooltip(anchor, 'live MIDI input')

  return () => {
    offState()
    if (enabled) disable()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
  }
}
