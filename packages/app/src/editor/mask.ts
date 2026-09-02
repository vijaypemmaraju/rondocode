import type { EditorHandle } from './editor'
import { MaskDevice } from '../mask/device'
import { MaskOutput } from '../mask/output'
import type { MaskStatus } from '../mask/output'
import { hasWebBluetooth, openMaskLink, requestMaskDevice } from '../mask/webbluetooth'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'

/* The LED mask button: connect over Web Bluetooth, see what the mask is
 * showing and how the picture uploads are going.
 *
 * Thin by design, like midi.ts: mask/output.ts owns every rule (scheduling,
 * dedupe, coalescing behind uploads, the slot diff), mask/device.ts owns the
 * radio discipline, and this file is DOM plus the one thing only a click can
 * do, which is open the browser's device chooser. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const describeShown = (s: MaskStatus['shown']): string => {
  const parts: string[] = []
  if (s.picture !== undefined) parts.push(`${s.picture.kind === 'slot' ? 'picture' : s.picture.kind} ${s.picture.n}`)
  if (s.light !== undefined) parts.push(`brightness ${Math.round((s.light / 255) * 100)}%`)
  return parts.length === 0 ? 'nothing sent yet' : parts.join(', ')
}

/** Wire the mask button + popover into the header. Returns a disposer. */
export function mountMask(editor: EditorHandle): () => void {
  const audio = editor.audio
  const anchor = el('button', 'btn mask-btn')
  anchor.type = 'button'
  anchor.append(iconEl('mask'), el('span', 'btn-label', 'mask'))
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(anchor, controls.firstChild)

  const pop = el('div', 'midi-pop mask-pop hidden')
  const status = el('div', 'midi-status', 'not connected')
  const shown = el('div', 'midi-status')
  const progress = el('div', 'midi-status')
  const errLine = el('div', 'mask-error')
  errLine.hidden = true
  const connectBtn = el('button', 'export-btn', 'connect mask')
  connectBtn.type = 'button'
  const hint = el(
    'div',
    'export-hint',
    'route a pattern to the sound `mask`: the notation picks a picture slot, `face:` a built-in face, `anim:` an animation and `gain:` the brightness. Pictures come from maskFrame() and upload when you run; each takes about five seconds.',
  )
  pop.append(status, shown, progress, errLine, connectBtn, hint)
  document.body.append(pop)

  const supported = hasWebBluetooth()
  if (!supported) {
    status.textContent = 'this browser has no Web Bluetooth'
    connectBtn.disabled = true
    hint.textContent = 'the mask connects over Web Bluetooth, which Chrome and Edge have on desktop and Android. The desktop app and Safari do not.'
  }

  let device: MaskDevice | null = null
  let chosen: BluetoothDevice | null = null // kept so a reconnect skips the chooser
  let busy = false

  const showError = (msg: string | null): void => {
    errLine.hidden = msg === null
    errLine.textContent = msg ?? ''
  }

  const render = (s: MaskStatus): void => {
    if (!supported) return
    anchor.classList.toggle('connected', s.device !== null)
    tooltip(anchor, s.device === null ? 'LED mask (not connected)' : `LED mask: ${s.device}`)
    status.textContent = s.device === null ? (chosen === null ? 'not connected' : `disconnected from ${chosen.name ?? 'mask'}`) : `connected to ${s.device}`
    shown.textContent = s.device === null ? '' : `showing: ${describeShown(s.shown)}`
    if (s.upload !== null) {
      const more = s.upload.remaining > 0 ? `, ${s.upload.remaining} more to go` : ''
      progress.textContent = `uploading picture ${s.upload.slot}: ${s.upload.done}/${s.upload.total}${more}`
    } else if (s.torn.length > 0) {
      progress.textContent = `picture ${s.torn.map((t) => t.slot).join(', ')} uploaded with dropped chunks; run again to retry`
    } else {
      progress.textContent = ''
    }
    connectBtn.textContent = busy ? 'connecting...' : s.device === null ? (chosen === null ? 'connect mask' : 'reconnect') : 'disconnect'
    connectBtn.disabled = busy
  }

  const output = new MaskOutput({
    now: () => audio.currentTimeFrames / audio.sampleRate,
    onStatus: render,
    onError: (m) => showError(m),
  })

  const connect = async (): Promise<void> => {
    busy = true
    showError(null)
    render(output.status())
    try {
      // the chooser needs the gesture we are inside of: nothing awaits before it
      const remembered = chosen
      if (chosen === null) chosen = await requestMaskDevice()
      let link
      try {
        link = await openMaskLink(chosen)
      } catch (e) {
        // a mask that was switched off and on again comes back under a new
        // address, so the remembered handle is "no longer in range" for good:
        // forget it, and the next click is the chooser again
        if (remembered === null) throw e
        chosen = null
        throw new Error(`${(e as Error).message ?? String(e)} (the mask may have restarted: press connect mask to pick it again)`)
      }
      device = new MaskDevice(link)
      device.onClose(() => {
        if (device !== null && !device.connected) device = null
        render(output.status())
      })
      output.attach(device)
    } catch (e) {
      const err = e as { name?: string; message?: string }
      // cancelling the chooser is not an error worth a red line
      if (err.name !== 'NotFoundError') showError(err.message ?? String(e))
    } finally {
      busy = false
      render(output.status())
    }
  }

  connectBtn.addEventListener('click', () => {
    if (device !== null) {
      device.disconnect()
      device = null
      output.attach(null)
      return
    }
    void connect()
  })

  const offEvents = editor.onPatternEvents((evs) => output.send(evs))
  const offFrames = editor.onMaskFrames((frames) => output.setFrames(frames))
  const offState = editor.onState((s) => {
    if (!s.playing) output.stop()
  })

  // popover open/close under the button
  let open = false
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
  }
  const openPop = (): void => {
    render(output.status())
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
  tooltip(anchor, supported ? 'LED mask (not connected)' : 'LED mask (needs Web Bluetooth)')

  return () => {
    offEvents()
    offFrames()
    offState()
    output.stop()
    device?.disconnect()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
    anchor.remove()
  }
}
