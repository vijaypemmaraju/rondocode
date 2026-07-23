import { encodeWav16 } from '@rondocode/engine'
import { stageCode, runPatterns, renderMix } from '../../../server/src/render-runner'
import type { EditorView } from '@codemirror/view'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'

/* Export the current tune to a WAV two ways:
 *   - bounce: render N cycles offline (deterministic, uses the render path)
 *   - record: capture the LIVE output while it plays (edits, tweaks and all)
 * Both encode 16-bit stereo WAV and download it. The record mode shows a
 * recording pill (dot + timer) in the header while it runs. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function download(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Render `cycles` of `code` offline to WAV bytes, or an error message.
 *  `samples` is the live engine's loaded sample bank (built-ins + baked sing()
 *  vocals) so the offline sample('name') nodes play the same audio — without it
 *  a program using samples (or sing()) bounces silent for those voices. */
function bounceLoop(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
): Uint8Array | { error: string } {
  const staged = stageCode(code)
  if (!staged.ok) return { error: staged.diagnostics.find((d) => d.severity === 'error')?.message ?? 'eval failed' }
  const cps = staged.cps ?? 0.5
  const durationSec = cycles / cps
  const events = runPatterns(staged.patterns, { cycles, cps })
  const mix = renderMix(staged.synths, events, durationSec, {
    sampleRate: 48000,
    ...(samples ? { samples } : {}),
    ...(staged.sidechain ? { sidechain: staged.sidechain } : {}),
    ...(staged.masterComp ? { masterComp: staged.masterComp } : {}),
    ...(staged.buses.size > 0 ? { buses: staged.buses, sends: staged.sends } : {}),
  })
  return encodeWav16(mix.left, mix.right, mix.sampleRate)
}

const clock = (s: number): string => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export interface ExportOpts {
  view: EditorView
  audio: AudioSession
  /** the header button the popover anchors under */ anchor: HTMLButtonElement
}

/** Wire the export button: a popover with a loop-bounce control and a live
 *  session recorder. Returns a disposer. */
export function mountExport({ view, audio, anchor }: ExportOpts): () => void {
  // recording pill lives next to the button in the header
  const pill = el('span', 'rec-pill hidden')
  pill.append(iconEl('record'), el('span', 'rec-time', '0:00'))
  anchor.after(pill)

  const pop = el('div', 'export-pop hidden')
  pop.append(el('div', 'export-head', 'export wav'))

  // --- bounce a loop ---
  const bounceRow = el('div', 'export-row')
  const cyc = el('input', 'export-cycles') as HTMLInputElement
  cyc.type = 'number'
  cyc.min = '1'
  cyc.max = '256'
  cyc.value = '8'
  cyc.setAttribute('aria-label', 'cycles to bounce')
  const bounceBtn = el('button', 'export-btn')
  bounceBtn.type = 'button'
  bounceBtn.append(iconEl('download'), el('span', undefined, 'bounce loop'))
  const bounceMsg = el('div', 'export-msg')
  bounceRow.append(el('label', 'export-label', 'cycles'), cyc, bounceBtn)
  pop.append(bounceRow, bounceMsg)

  bounceBtn.addEventListener('click', () => {
    const cycles = Math.max(1, Math.min(256, Math.round(Number(cyc.value) || 8)))
    bounceMsg.textContent = 'rendering…'
    // let the label paint before the (synchronous) render blocks the thread
    setTimeout(() => {
      const res = bounceLoop(view.state.doc.toString(), cycles, audio.loadedSamples)
      if (res instanceof Uint8Array) {
        download(res, `rondocode-loop-${cycles}.wav`)
        bounceMsg.textContent = 'downloaded'
        setTimeout(() => (bounceMsg.textContent = ''), 1800)
      } else {
        bounceMsg.textContent = res.error
      }
    }, 20)
  })

  // --- record the live session ---
  const recBtn = el('button', 'export-btn')
  recBtn.type = 'button'
  const setRecLabel = (): void => recBtn.replaceChildren(iconEl('record'), el('span', undefined, 'record session'))
  setRecLabel()
  pop.append(el('div', 'export-hint', 'records the live output as it plays; press play first'), recBtn)
  document.body.append(pop)

  let ticker: number | undefined
  const stopRec = (): void => {
    window.clearInterval(ticker)
    pill.classList.add('hidden')
    const pcm = audio.stopRecording()
    setRecLabel()
    recBtn.classList.remove('armed')
    if (pcm && pcm.left.length > 0) download(encodeWav16(pcm.left, pcm.right, pcm.sampleRate), 'rondocode-session.wav')
  }
  recBtn.addEventListener('click', () => {
    if (audio.isRecording) {
      stopRec()
      return
    }
    audio.startRecording()
    recBtn.replaceChildren(iconEl('record'), el('span', undefined, 'stop & save'))
    recBtn.classList.add('armed')
    pill.classList.remove('hidden')
    ticker = window.setInterval(() => {
      pill.querySelector('.rec-time')!.textContent = clock(audio.recordingSeconds)
    }, 250)
  })

  // popover open/close, anchored under the button
  let open = false
  const place = (): void => anchorPopover(pop, anchor)
  const openPop = (): void => {
    pop.classList.remove('hidden') // visible first so anchorPopover can measure it
    place()
    open = true
  }
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
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
  tooltip(anchor, 'export to WAV')

  return () => {
    window.clearInterval(ticker)
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
    pill.remove()
  }
}
