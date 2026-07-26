import { encodeWav16 } from '@rondocode/engine'
import { notesToSmf } from '@rondocode/pattern'
import type { EditorView } from '@codemirror/view'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'
import { capturePatternNotes, stageCode } from '../../../server/src/render-runner'
import { renderStagedMix } from './resample'

/* Export the current tune three ways:
 *   - bounce wav: render N cycles offline (deterministic, uses the render path)
 *   - midi: capture the SAME N scheduled cycles as a Standard MIDI File —
 *     the road to sheet music (MuseScore/Dorico/any DAW opens it)
 *   - record: capture the LIVE output while it plays (edits, tweaks and all)
 * WAV paths encode 16-bit stereo and download; the record mode shows a
 * recording pill (dot + timer) in the header while it runs. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function download(bytes: Uint8Array, name: string, type = 'audio/wav'): void {
  const blob = new Blob([bytes as BlobPart], { type })
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
 *  a program using samples (or sing()) bounces silent for those voices.
 *  The staged→renderMix option mapping lives in renderStagedMix (shared with
 *  the resample-to-loop path) so a staged feature (sidechain/buses/masterComp/
 *  samples) can never silently drop from one path but not the other. */
export function bounceLoop(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
): Uint8Array | { error: string } {
  const mix = renderStagedMix(code, cycles, samples)
  if ('error' in mix) return mix
  return encodeWav16(mix.left, mix.right, mix.sampleRate)
}

/** Capture `cycles` of `code` as a Standard MIDI File, or an error message.
 *  Same source of truth as the WAV bounce: the staged patterns run through
 *  the scheduler (stageCode → capturePatternNotes), so what you hear is what
 *  exports. One track per synth (staged definition order), .gain as velocity,
 *  one cycle = one bar of 4/4 at the staged tempo; sing()/sample channels
 *  export their trigger notes. */
export function bounceMidi(code: string, cycles: number): Uint8Array | { error: string } {
  const staged = stageCode(code)
  if (!staged.ok) return { error: staged.diagnostics.find((d) => d.severity === 'error')?.message ?? 'eval failed' }
  const cps = staged.cps ?? 0.5
  const notes = capturePatternNotes(staged.patterns, { cycles, cps })
  if (notes.length === 0) return { error: 'no notes to export' }
  return notesToSmf(notes, { cps, trackOrder: [...staged.synths.keys()] })
}

/** The active project's name from the header label (the library owns it),
 *  sanitized for a filename; 'rondocode' when the library has not mounted. */
function projectFileName(): string {
  const raw = document.querySelector('.project-name')?.textContent ?? ''
  return raw.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'rondocode'
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
  /** The eval-ready program for offline bounces: the doc itself in JS mode,
   *  the TRANSPILED JS in rondo mode (raw rondo source cannot stage). Falls
   *  back to the raw doc when omitted. */
  getEvalCode?: () => string | { error: string }
}

/** Wire the export button: a popover with a loop-bounce control and a live
 *  session recorder. Returns a disposer. */
export function mountExport({ view, audio, anchor, getEvalCode }: ExportOpts): () => void {
  // recording pill lives next to the button in the header
  const pill = el('span', 'rec-pill hidden')
  pill.append(iconEl('record'), el('span', 'rec-time', '0:00'))
  anchor.after(pill)

  const pop = el('div', 'export-pop hidden')
  pop.append(el('div', 'export-head', 'export'))

  // --- bounce a loop: N cycles as WAV audio or as a MIDI file ---
  const bounceRow = el('div', 'export-row')
  const cyc = el('input', 'export-cycles') as HTMLInputElement
  cyc.type = 'number'
  cyc.min = '1'
  cyc.max = '256'
  cyc.value = '8'
  cyc.setAttribute('aria-label', 'cycles to bounce')
  const bounceBtn = el('button', 'export-btn')
  bounceBtn.type = 'button'
  bounceBtn.append(iconEl('download'), el('span', undefined, 'WAV'))
  const midiBtn = el('button', 'export-btn')
  midiBtn.type = 'button'
  midiBtn.append(iconEl('download'), el('span', undefined, 'MIDI (.mid)'))
  const bounceMsg = el('div', 'export-msg')
  bounceRow.append(el('label', 'export-label', 'cycles'), cyc, bounceBtn)
  // MIDI gets its own full-width row so both buttons keep 44px+ touch targets
  // inside the popover's min width.
  const midiRow = el('div', 'export-row')
  midiRow.append(midiBtn)
  pop.append(bounceRow, midiRow, bounceMsg)

  const readCycles = (): number => Math.max(1, Math.min(256, Math.round(Number(cyc.value) || 8)))
  const evalCode = (): string | { error: string } => getEvalCode?.() ?? view.state.doc.toString()
  const flash = (text: string): void => {
    bounceMsg.textContent = text
    setTimeout(() => (bounceMsg.textContent = ''), 1800)
  }
  bounceBtn.addEventListener('click', () => {
    const cycles = readCycles()
    const code = evalCode()
    if (typeof code !== 'string') {
      bounceMsg.textContent = code.error
      return
    }
    bounceMsg.textContent = 'rendering…'
    // let the label paint before the (synchronous) render blocks the thread
    setTimeout(() => {
      const res = bounceLoop(code, cycles, audio.loadedSamples)
      if (res instanceof Uint8Array) {
        download(res, `rondocode-loop-${cycles}.wav`)
        flash('downloaded')
      } else {
        bounceMsg.textContent = res.error
      }
    }, 20)
  })
  midiBtn.addEventListener('click', () => {
    const cycles = readCycles()
    const code = evalCode()
    if (typeof code !== 'string') {
      bounceMsg.textContent = code.error
      return
    }
    bounceMsg.textContent = 'exporting…'
    setTimeout(() => {
      const res = bounceMidi(code, cycles)
      if (res instanceof Uint8Array) {
        download(res, `${projectFileName()}.mid`, 'audio/midi')
        flash('downloaded')
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
  tooltip(anchor, 'export WAV or MIDI')

  return () => {
    window.clearInterval(ticker)
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
    pill.remove()
  }
}
