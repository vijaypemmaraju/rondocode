import type { EditorHandle } from './editor'
import type { AudioSession } from '../audio/AudioSession'
import type { ParamTarget } from '../session/Session'
import { ACTIVE_PROJECT_EVENT, getActiveProjectId } from './library'
import { CcRouter, loadMappings, parseCc, saveMappings } from '../midi/cc'
import type { ParamRange } from '../midi/cc'
import { CLOCK_BYTE, MidiClockFollower, MidiClockSender, parseClock } from '../midi/clock'
import type { ClockMessage } from '../midi/clock'
import { cpsToBpm } from '@rondocode/pattern'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'
import { anchorPopover } from '../ui/viewport'

/* Live MIDI input (Web MIDI): play one of the running synths from a connected
 * keyboard/controller in real time, and drive its params from that
 * controller's knobs.
 *
 * Notes map straight to the engine's immediate noteOn/noteOff messages; the
 * target synth is picked from the program's current synths (defaults to the
 * last one defined).
 *
 * Control changes go through the pure CcRouter (midi/cc.ts), which owns every
 * rule worth testing: learn, the one-control-one-param binding, the 7-bit and
 * 14-bit value scaling, and stale mappings. This file stays the thin layer it
 * should be: DOM, Web MIDI, and localStorage.
 *
 * A mapped knob drives the param through the SAME Session.holdParam path a
 * finger on an inline widget uses, tagged with the 'midi' owner. So a knob and
 * a finger behave identically as far as the sequencer is concerned (both
 * suppress a `.ctrl` sweep on that param), and the value is simply whoever
 * moved last. The difference is the ending: a finger releases when it lifts, a
 * knob keeps its param until it is unmapped or MIDI is switched off.
 *
 * Clock sync is the same shape: midi/clock.ts owns the tempo estimation, the
 * phase trim and the send schedule, and this file only carries the bytes. The
 * follower is fed whenever MIDI is on, so the popover can show an external
 * tempo before you commit to following it; only the SELECTED mode acts on it. */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const targetKey = (t: { synth: string; param: string }): string => `${t.synth}.${t.param}`

/** Where the tempo comes from. */
type SyncMode = 'internal' | 'follow' | 'send'

/** How often the clock loop runs: the send lookahead and the tempo readout
 *  both ride on it, so it must be shorter than that lookahead. */
const CLOCK_POLL_MS = 100
/** Ticks between tempo pushes while following: twice a beat is a fast enough
 *  control loop for a clock that drifts by a fraction of a percent, and keeps
 *  the scheduler from re-anchoring 48 times a second. */
const APPLY_EVERY_TICKS = 12
/** Tempo moves smaller than this are not worth re-anchoring the scheduler for
 *  (0.05% is 0.06 BPM at 120). */
const CPS_DEADBAND = 0.0005

const showBpm = (bpm: number): string => bpm.toFixed(1)

/** Wire the MIDI button + popover into the header. Returns a disposer. */
export function mountMidi(editor: EditorHandle, audio: AudioSession): () => void {
  const session = editor.session
  const anchor = el('button', 'btn midi-btn')
  anchor.type = 'button'
  anchor.append(iconEl('midi'), el('span', 'btn-label', 'midi'))
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

  // ---- knob mappings ---------------------------------------------------
  const mapHead = el('div', 'export-head', 'knob mappings')
  const learnRow = el('div', 'midi-learn-row')
  const paramPick = el('select', 'midi-pick midi-parampick') as HTMLSelectElement
  paramPick.setAttribute('aria-label', 'param to map')
  const learnBtn = el('button', 'export-btn midi-learn', 'learn')
  learnBtn.type = 'button'
  learnRow.append(paramPick, learnBtn)
  const rowList = el('div', 'midi-maps')
  const mapHint = el(
    'div',
    'export-hint',
    'pick a param, tap learn, then move a knob. A mapped knob owns that param until you unmap it, so a patterned sweep on it steps aside.',
  )

  // ---- clock sync ------------------------------------------------------
  const syncHead = el('div', 'export-head', 'clock')
  const syncPick = el('select', 'midi-pick midi-sync') as HTMLSelectElement
  syncPick.setAttribute('aria-label', 'tempo clock')
  for (const [value, label] of [
    ['internal', 'internal clock'],
    ['follow', 'follow MIDI clock'],
    ['send', 'send MIDI clock'],
  ] as const) {
    const o = el('option', undefined, label)
    o.value = value
    syncPick.append(o)
  }
  const tempoLine = el('div', 'midi-tempo', 'internal')
  const syncHint = el(
    'div',
    'export-hint',
    'follow takes the tempo from a drum machine, a DAW or a mixer, and starts and stops with it. While you follow, a setCps line in the tune is remembered but does not take over. Send makes other gear follow you instead.',
  )

  /** Live param surface, rebuilt on every eval — the learn menu's options and
   *  the router's liveness test both read it. */
  let paramTargets: ParamTarget[] = []
  let paramIndex = new Map<string, ParamRange>()
  const lookup = (synth: string, param: string): ParamRange | undefined => paramIndex.get(`${synth}.${param}`)

  /** The project whose rig is loaded. undefined until the library mounts (or
   *  forever in private mode), in which case mappings live for the session
   *  only rather than being written under a wrong id. */
  let projectId = getActiveProjectId()

  const router = new CcRouter({
    hold: (synth, param, value) => session.holdParam(synth, param, value, 'midi'),
    release: (synth, param) => session.releaseParam(synth, param, 'midi'),
    lookup,
    onChange: () => {
      if (projectId !== undefined) saveMappings(localStorage, projectId, router.mappings())
      renderMappings()
    },
  })

  pop.append(
    el('div', 'export-head', 'midi input'),
    status,
    el('label', 'export-label', 'play synth'),
    pick,
    toggle,
    el('div', 'export-hint', 'plays a running synth from a connected keyboard'),
    mapHead,
    learnRow,
    rowList,
    mapHint,
    syncHead,
    syncPick,
    tempoLine,
    syncHint,
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

  const refreshParamPick = (): void => {
    const cur = paramPick.value
    paramPick.replaceChildren()
    if (paramTargets.length === 0) {
      const o = el('option', undefined, 'no params in this tune')
      o.value = ''
      o.disabled = true
      paramPick.append(o)
      paramPick.value = ''
      learnBtn.disabled = true
      return
    }
    learnBtn.disabled = false
    for (const t of paramTargets) {
      const key = targetKey(t)
      const o = el('option', undefined, key)
      o.value = key
      paramPick.append(o)
    }
    paramPick.value = paramTargets.some((t) => targetKey(t) === cur) ? cur : targetKey(paramTargets[0]!)
  }

  function renderMappings(): void {
    const learning = router.learning()
    learnBtn.textContent = learning === undefined ? 'learn' : 'move a control'
    learnBtn.classList.toggle('armed', learning !== undefined)
    const rows = router.rows()
    rowList.replaceChildren()
    if (rows.length === 0) {
      rowList.append(el('div', 'export-hint midi-empty', 'nothing mapped yet'))
      return
    }
    for (const r of rows) {
      const row = el('div', 'midi-map-row' + (r.stale ? ' stale' : ''))
      const name = el('span', 'midi-map-name', `${r.synth}.${r.param}`)
      const addr = el('span', 'midi-map-cc', `ch ${r.channel + 1} cc ${r.cc}`)
      row.append(name, addr)
      if (r.stale) row.append(el('span', 'midi-map-stale', 'stale'))
      const drop = el('button', 'midi-map-unmap', '×')
      drop.type = 'button'
      drop.setAttribute('aria-label', `unmap ${r.synth}.${r.param}`)
      drop.addEventListener('click', () => router.unmap(r.channel, r.cc))
      row.append(drop)
      rowList.append(row)
    }
  }

  learnBtn.addEventListener('click', () => {
    if (router.learning() !== undefined) {
      router.cancelLearn()
      return
    }
    const value = paramPick.value
    const dot = value.indexOf('.')
    if (dot <= 0) return
    const arm = (): void => router.arm(value.slice(0, dot), value.slice(dot + 1))
    // Learning with MIDI off would wait forever: turn it on first.
    if (enabled) arm()
    else void enable().then(() => { if (enabled) arm() })
  })

  const offState = editor.onState(() => {
    const s = session.getState()
    synths = s.synths
    paramTargets = session.paramTargets()
    paramIndex = new Map(paramTargets.map((t) => [targetKey(t), { min: t.min, max: t.max, curve: t.curve }]))
    refreshPick()
    refreshParamPick()
    renderMappings() // liveness of every row may have just changed
  })

  const loadRig = (id: string | undefined): void => {
    projectId = id
    router.setMappings(id === undefined ? [] : loadMappings(localStorage, id))
  }
  const onActiveProject = (e: Event): void => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id === 'string' && id !== projectId) loadRig(id)
  }
  window.addEventListener(ACTIVE_PROJECT_EVENT, onActiveProject)
  loadRig(projectId)

  // ---- clock ------------------------------------------------------------
  let sync: SyncMode = 'internal'
  const follower = new MidiClockFollower()
  const sender = new MidiClockSender()
  let clockTimer: ReturnType<typeof setInterval> | undefined
  /** Ticks since the last tempo push, and the value pushed, for the deadband. */
  let sinceApply = 0
  let pushedCps = 0
  /** What the sender last told the world about our transport. */
  let sentPlaying = false

  const outputs = (): MIDIOutput[] =>
    access ? Array.from((access.outputs as Map<string, MIDIOutput>).values()) : []

  const emit = (byte: number, at?: number): void => {
    for (const out of outputs()) {
      try {
        out.send([byte], at)
      } catch {
        // a port that vanished mid-set is not worth breaking the loop for
      }
    }
  }

  const refreshTempo = (): void => {
    const bpm = follower.bpm
    if (sync === 'follow') {
      tempoLine.textContent =
        bpm === undefined
          ? 'waiting for a clock'
          : `following ${showBpm(bpm)} BPM${follower.running ? '' : ' (master stopped)'}`
    } else if (sync === 'send') {
      const outs = outputs().length
      tempoLine.textContent =
        outs === 0 ? 'no outputs to send to' : `sending ${showBpm(cpsToBpm(session.getState().cps))} BPM`
    } else {
      const own = `internal ${showBpm(cpsToBpm(session.getState().cps))} BPM`
      tempoLine.textContent = bpm === undefined ? own : `${own}, clock in at ${showBpm(bpm)}`
    }
  }

  /** Push the followed tempo, rate-limited and dead-banded. */
  const applyFollow = (): void => {
    if (++sinceApply < APPLY_EVERY_TICKS) return
    sinceApply = 0
    const target = follower.targetCps(session.cycle)
    if (target === undefined) return
    if (pushedCps !== 0 && Math.abs(target - pushedCps) / pushedCps < CPS_DEADBAND) return
    pushedCps = target
    session.setExternalCps(target)
  }

  const onClock = (msg: ClockMessage, timeMs: number): void => {
    if (msg === 'tick') {
      follower.tick(timeMs)
      if (sync === 'follow') applyFollow()
      return
    }
    if (msg === 'start') follower.start()
    else if (msg === 'continue') follower.resume()
    else follower.stop()
    if (sync !== 'follow') return
    if (msg === 'stop') {
      session.transport('stop')
      return
    }
    // The master says go. Selecting follow was the audio-unlock gesture; this
    // resume is the one that matters, since the start arrives later.
    void audio.resume()
    // 0xFA restarts from the top; 0xFB resumes, so a loop already running is
    // left alone rather than snapped back to cycle 0.
    if (msg === 'start' || !session.getState().playing) session.transport('play')
  }

  /** The one repeating job: schedule outgoing ticks and keep the readout
   *  honest. Runs only while MIDI is on. */
  const clockPoll = (): void => {
    if (sync === 'send') {
      const now = performance.now()
      const playing = session.getState().playing
      if (playing !== sentPlaying) {
        sentPlaying = playing
        if (playing) {
          sender.start(now)
          emit(CLOCK_BYTE.start, now)
        } else {
          sender.stop()
          emit(CLOCK_BYTE.stop, now)
        }
      }
      for (const at of sender.due(now, session.getState().cps)) emit(CLOCK_BYTE.tick, at)
    }
    refreshTempo()
  }

  const startClockPoll = (): void => {
    if (clockTimer === undefined) clockTimer = setInterval(clockPoll, CLOCK_POLL_MS)
  }
  const stopClockPoll = (): void => {
    if (clockTimer !== undefined) clearInterval(clockTimer)
    clockTimer = undefined
  }

  /** Leave whatever the current mode was holding: hand the tempo back, stop
   *  sending, tell the world we stopped. */
  const leaveMode = (): void => {
    if (sync === 'follow') {
      session.setExternalCps(undefined)
      follower.reset()
      pushedCps = 0
      sinceApply = 0
    } else if (sync === 'send') {
      if (sentPlaying) emit(CLOCK_BYTE.stop, performance.now())
      sentPlaying = false
      sender.stop()
    }
  }

  const setSync = (mode: SyncMode): void => {
    if (mode === sync) return
    leaveMode()
    sync = mode
    syncPick.value = mode
    if (mode === 'follow') {
      void audio.resume()
      // Take the tempo now, at whatever we are playing, so an eval cannot grab
      // it back in the gap before the clock locks.
      pushedCps = follower.cps ?? session.getState().cps
      session.setExternalCps(pushedCps)
    }
    if (mode !== 'internal' && !enabled) void enable()
    refreshTempo()
  }
  syncPick.addEventListener('change', () => setSync(syncPick.value as SyncMode))

  const onMidi = (e: MIDIMessageEvent): void => {
    const data = e.data
    if (!data) return
    // Clock first: it is by far the most frequent thing on the wire.
    const clock = parseClock(data)
    if (clock !== undefined) {
      onClock(clock, e.timeStamp)
      return
    }
    const cc = parseCc(data)
    if (cc !== undefined) {
      router.handle(cc)
      return
    }
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
      startClockPoll()
      refreshTempo()
    } catch {
      status.textContent = 'permission denied'
    }
  }
  const disable = (): void => {
    for (const input of inputs()) input.onmidimessage = null
    audio.send({ kind: 'allNotesOff' })
    router.cancelLearn()
    router.releaseHeld() // the knobs let go of their params; the mappings stay
    // MIDI off means no clock either: the tempo comes home.
    leaveMode()
    sync = 'internal'
    syncPick.value = 'internal'
    stopClockPoll()
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
    refreshParamPick()
    renderMappings()
    refreshTempo()
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
    stopClockPoll()
    router.releaseHeld()
    window.removeEventListener(ACTIVE_PROJECT_EVENT, onActiveProject)
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
  }
}
