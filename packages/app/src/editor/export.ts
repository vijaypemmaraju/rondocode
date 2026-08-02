import { encodeWav, formatDbTp, formatLufs, measureLoudness, wavBitsLabel } from '@rondocode/engine'
import type { WavBits } from '@rondocode/engine'
import { notesToSmf } from '@rondocode/pattern'
import type { EditorView } from '@codemirror/view'
import type { AudioSession } from '../audio/AudioSession'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'
import { capturePatternNotes, stageCode } from '../../../server/src/render-runner'
import { renderStagedMix } from './resample'
import { buildZip } from './zip'

/* Export the current tune five ways:
 *   - bounce wav: render N cycles offline (deterministic, uses the render path)
 *   - stems: the same render, one WAV per synth (and per send bus), zipped
 *   - midi: capture the SAME N scheduled cycles as a Standard MIDI File —
 *     the road to sheet music (MuseScore/Dorico/any DAW opens it)
 *   - measure: read the bounce's loudness (LUFS + true peak), changing nothing
 *   - record: capture the LIVE output while it plays (edits, tweaks and all)
 * Audio writes at the chosen depth (16-bit, 24-bit, or 32-bit float) and
 * downloads; the record mode shows a recording pill (dot + timer) in the
 * header while it runs. */

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
  bits: WavBits = 16,
): Uint8Array | { error: string } {
  const mix = renderStagedMix(code, cycles, samples)
  if ('error' in mix) return mix
  return encodeWav(mix.left, mix.right, mix.sampleRate, { bits })
}

/** One stem file: the WAV bytes and the name it should be delivered under. */
export interface StemFile {
  /** synth or bus name, as written in the code */
  part: string
  name: string
  bytes: Uint8Array
}

/** Render `cycles` of `code` and return one WAV per part, or an error message.
 *  Each stem is that part's CONTRIBUTION TO THE MIX (its post-chain, its
 *  sidechain ducking, and the master stage all applied), so the stems sum
 *  back to what `bounceLoop` writes. Shared send buses come back as their own
 *  stems, named `<project>-bus-<name>.wav`: a bus mixes several synths through
 *  one FX chain and cannot be split per synth honestly. */
export function bounceStems(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
  bits: WavBits = 16,
  project = 'rondocode',
): StemFile[] | { error: string } {
  const mix = renderStagedMix(code, cycles, samples, { stems: true })
  if ('error' in mix) return mix
  const stems = mix.stems ?? []
  if (stems.length === 0) return { error: 'nothing to export: no synth made sound' }
  return stems.map((s) => ({
    part: s.name,
    name: `${project}-${s.kind === 'bus' ? `bus-${s.name}` : s.name}.wav`,
    bytes: encodeWav(s.left, s.right, mix.sampleRate, { bits }),
  }))
}

/** Zip `files` into one archive named `<project>-stems.zip`. Browsers cannot
 *  write a folder and a multi-file download needs the user to approve a
 *  browser prompt, so stems ship as a single archive (see zip.ts). */
export function zipStems(files: StemFile[], project: string): { name: string; bytes: Uint8Array } {
  return {
    name: `${project}-stems.zip`,
    bytes: buildZip(files.map((f) => ({ name: `${project}-stems/${f.name}`, bytes: f.bytes }))),
  }
}

/** Measure `cycles` of `code` the way a mastering engineer would: BS.1770-4
 *  integrated loudness and true peak of the bounce. Measurement only, nothing
 *  is normalized or limited. */
export function measureBounce(
  code: string,
  cycles: number,
  samples?: Record<string, { data: Float32Array; sampleRate: number }>,
): { text: string } | { error: string } {
  const mix = renderStagedMix(code, cycles, samples)
  if ('error' in mix) return mix
  const m = measureLoudness(mix.left, mix.right, mix.sampleRate)
  return { text: `${formatLufs(m.integratedLufs)} · ${formatDbTp(m.truePeakDb)} peak` }
}

/** Capture `cycles` of `code` as a Standard MIDI File, or an error message.
 *  Same source of truth as the WAV bounce: the staged patterns run through
 *  the scheduler (stageCode → capturePatternNotes), so what you hear is what
 *  exports. One track per synth (staged definition order), .gain as velocity,
 *  one cycle = one bar at the staged tempo AND the staged meter (so a 3/4
 *  project's bar lines land where the code says, not every four quarters);
 *  sing()/sample channels export their trigger notes. */
export function bounceMidi(code: string, cycles: number): Uint8Array | { error: string } {
  const staged = stageCode(code)
  if (!staged.ok) return { error: staged.diagnostics.find((d) => d.severity === 'error')?.message ?? 'eval failed' }
  const cps = staged.cps ?? 0.5
  const notes = capturePatternNotes(staged.patterns, { cycles, cps })
  if (notes.length === 0) return { error: 'no notes to export' }
  return notesToSmf(notes, {
    cps,
    trackOrder: [...staged.synths.keys()],
    ...(staged.timeSig !== undefined ? { timeSig: staged.timeSig } : {}),
  })
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

  // --- bounce a loop: N cycles as WAV audio, as stems, or as a MIDI file ---
  const bounceRow = el('div', 'export-row')
  const cyc = el('input', 'export-cycles') as HTMLInputElement
  cyc.type = 'number'
  cyc.min = '1'
  cyc.max = '256'
  cyc.value = '8'
  cyc.setAttribute('aria-label', 'cycles to bounce')
  // Bit depth: 16 for a normal file, 24 for delivery, 32-bit float to keep
  // every bit of headroom for another tool to finish.
  const depth = el('select', 'export-select') as HTMLSelectElement
  depth.setAttribute('aria-label', 'bit depth')
  for (const bits of [16, 24, 32] as const) {
    const o = document.createElement('option')
    o.value = String(bits)
    o.textContent = wavBitsLabel(bits)
    depth.append(o)
  }
  depth.value = '16'
  const bounceBtn = el('button', 'export-btn')
  bounceBtn.type = 'button'
  bounceBtn.append(iconEl('download'), el('span', undefined, 'WAV'))
  const stemsBtn = el('button', 'export-btn')
  stemsBtn.type = 'button'
  stemsBtn.append(iconEl('download'), el('span', undefined, 'stems (.zip)'))
  const midiBtn = el('button', 'export-btn')
  midiBtn.type = 'button'
  midiBtn.append(iconEl('download'), el('span', undefined, 'MIDI (.mid)'))
  const measureBtn = el('button', 'export-btn')
  measureBtn.type = 'button'
  measureBtn.textContent = 'measure loudness'
  const bounceMsg = el('div', 'export-msg')
  bounceRow.append(el('label', 'export-label', 'cycles'), cyc, depth)
  // One button per row so every touch target keeps its full 44px inside the
  // popover's min width.
  const wavRow = el('div', 'export-row')
  wavRow.append(bounceBtn)
  const stemsRow = el('div', 'export-row')
  stemsRow.append(stemsBtn)
  const midiRow = el('div', 'export-row')
  midiRow.append(midiBtn)
  const measureRow = el('div', 'export-row')
  measureRow.append(measureBtn)
  pop.append(
    bounceRow,
    wavRow,
    stemsRow,
    el('div', 'export-hint', 'stems: one WAV per synth, plus each send bus. They sum back to the mix.'),
    midiRow,
    measureRow,
    el('div', 'export-hint', 'loudness targets: -14 LUFS streaming, -9 LUFS club, -1 dBTP ceiling. Measuring changes nothing.'),
    bounceMsg,
  )

  const readCycles = (): number => Math.max(1, Math.min(256, Math.round(Number(cyc.value) || 8)))
  const readBits = (): WavBits => (Number(depth.value) === 24 ? 24 : Number(depth.value) === 32 ? 32 : 16)
  const evalCode = (): string | { error: string } => getEvalCode?.() ?? view.state.doc.toString()
  const flash = (text: string, ms = 1800): void => {
    bounceMsg.textContent = text
    setTimeout(() => (bounceMsg.textContent = ''), ms)
  }
  /** Show `busy`, let it paint, then run the (synchronous, blocking) render. */
  const withRender = (busy: string, run: (code: string, cycles: number) => void): void => {
    const cycles = readCycles()
    const code = evalCode()
    if (typeof code !== 'string') {
      bounceMsg.textContent = code.error
      return
    }
    bounceMsg.textContent = busy
    setTimeout(() => run(code, cycles), 20)
  }
  bounceBtn.addEventListener('click', () => {
    withRender('rendering…', (code, cycles) => {
      const res = bounceLoop(code, cycles, audio.loadedSamples, readBits())
      if (res instanceof Uint8Array) {
        download(res, `${projectFileName()}-loop-${cycles}.wav`)
        flash('downloaded')
      } else {
        bounceMsg.textContent = res.error
      }
    })
  })
  stemsBtn.addEventListener('click', () => {
    withRender('rendering stems…', (code, cycles) => {
      const project = projectFileName()
      const res = bounceStems(code, cycles, audio.loadedSamples, readBits(), project)
      if ('error' in res) {
        bounceMsg.textContent = res.error
        return
      }
      const zip = zipStems(res, project)
      download(zip.bytes, zip.name, 'application/zip')
      flash(`${res.length} stem${res.length === 1 ? '' : 's'} downloaded`)
    })
  })
  measureBtn.addEventListener('click', () => {
    withRender('measuring…', (code, cycles) => {
      const res = measureBounce(code, cycles, audio.loadedSamples)
      if ('error' in res) {
        bounceMsg.textContent = res.error
        return
      }
      flash(res.text, 8000)
    })
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
    // the session take gets the same depth the bounces are set to
    if (pcm && pcm.left.length > 0) {
      download(encodeWav(pcm.left, pcm.right, pcm.sampleRate, { bits: readBits() }), `${projectFileName()}-session.wav`)
    }
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
