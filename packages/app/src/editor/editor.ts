import { Compartment, EditorState, Prec } from '@codemirror/state'
import type { Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { setDiagnostics } from '@codemirror/lint'
import type { Diagnostic as CmDiagnostic } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { compile } from '@rondocode/rondo'
import type { NoteSpan } from '@rondocode/rondo'
import type { EngineEvent } from '@rondocode/engine'
import type { SchedulerEvent } from '@rondocode/pattern'
import { Session } from '../session/Session'
import type { SessionState, ProbeTarget } from '../session/Session'
import type { Diagnostic } from '../session/evalCode'
import type { AudioSession } from '../audio/AudioSession'
import { makeVox, makeRiser, makePad } from '../audio/demo-samples'
import { mountSamplesPopover } from './samples'
import { mountExport } from './export'
import { tooltip } from '../ui/tooltip'
import { getSetting } from '../ui/settings'
import { EXAMPLES } from '../examples'
import { EventFlasher, FLASH_MS, rondoNoteLiterals } from './flash'
import { karaokeExtension, mountKaraoke } from './karaoke'
import { iconEl } from '../ui/icons'
import { ghostCompletion } from './ghost'
import { codeEditingExtensions, rondocodeAutocomplete } from './setup'
import { rondoLanguage, rondoAutocomplete } from './rondo'
import { mountRondoPalette } from './rondo/palette'
import { toNoteEvs } from './rondo/widgets'
import type { RondoWidgetHooks } from './rondo'
import { synthMeters } from './meters'
import * as singMgr from '../sing/singMgr'
import { mountSingDialog, confirmSingDownload } from '../ui/singDialog'

/* ------------------------------------------------------------------------- *
 * The live-coding editor shell: header (logo, example picker, master
 * meter), CodeMirror filling the viewport, a slim runtime-error strip, and
 * a bottom transport bar. Mobile-first: 44px+ touch targets, 16px editor
 * font (iOS focus-zoom threshold), safe-area insets in CSS, single column.
 *
 * Diagnostics split (Session semantics: every callback carries the FULL
 * merged set): source 'eval' → CodeMirror lint markers, positions clamped
 * to the current doc; source 'scheduler'/'engine' (always position-less
 * 1:1) → the status strip, latest two, auto-clearing because a successful
 * eval empties the runtime subset. Any render failure is caught — a
 * diagnostics bug must never take the editor down.
 * ------------------------------------------------------------------------- */

const DOC_KEY = 'rondocode-doc'
const LANG_KEY = 'rondocode-lang'

/** The editor's active language surface. */
export type EditorLang = 'rondocode' | 'rondo'

/** The initial language: a saved choice wins; otherwise default to rondo on
 *  touch/small screens (the mobile-native language) and rondocode on desktop. */
const initialLang = (): EditorLang => {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved === 'rondo' || saved === 'rondocode') return saved
    // A saved buffer with no saved lang predates the toggle — it's rondocode
    // JS. Booting it into rondo mode would squiggle the user's own work, so
    // the mobile default only applies to FRESH visits.
    if (localStorage.getItem(DOC_KEY) !== null) return 'rondocode'
  } catch {
    // ignore storage failures — fall through to the heuristic
  }
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const small = typeof window !== 'undefined' && window.innerWidth < 640
  return coarse || small ? 'rondo' : 'rondocode'
}
/** Eval saves land fast; per-keystroke saves wait a little longer. Both
 *  share one timer, so the LATEST doc always wins. */
const SAVE_ON_EVAL_MS = 250
const SAVE_ON_CHANGE_MS = 500
/** Throttle interval for widget-drag / scrub re-evals. The value must apply
 *  WHILE dragging (not only on release), so this is a throttle (leading edge +
 *  trailing), not a pure trailing debounce: during a drag we re-eval at most
 *  every WIDGET_EVAL_MS, so the sound follows the slider continuously. Session
 *  diffs staged synths/patterns, so these evals never redefine an unchanged
 *  synth — audio keeps running seamlessly. */
const WIDGET_EVAL_MS = 70
/** LIVE TYPING settle: apply a typed edit this long after the last keystroke
 *  (opt-in setting; only while the transport is playing). */
const LIVE_TYPE_SETTLE_MS = 700

const firstExample = (lang: EditorLang): string => {
  const ex = EXAMPLES[0]!
  return lang === 'rondo' && ex.rondo !== undefined ? ex.rondo : ex.code
}

const loadDoc = (lang: EditorLang): string => {
  try {
    const cur = localStorage.getItem(DOC_KEY)
    if (cur !== null) return cur
    // one-time migration from the pre-rename key so the in-progress buffer
    // survives (rondocode was 'synthcode' until this rename).
    const legacy = localStorage.getItem('synthcode-doc')
    if (legacy !== null) {
      localStorage.setItem(DOC_KEY, legacy)
      return legacy
    }
    return firstExample(lang)
  } catch {
    return firstExample(lang)
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Session Diagnostic (1-based line/col vs the eval-time source) → CM lint
 *  diagnostic, defensively clamped to the CURRENT doc. */
const toCmDiagnostics = (doc: Text, diags: Diagnostic[]): CmDiagnostic[] => {
  const out: CmDiagnostic[] = []
  for (const d of diags) {
    try {
      const line = doc.line(Math.min(Math.max(d.line, 1), doc.lines))
      const from = Math.min(line.from + Math.max(d.col - 1, 0), line.to)
      let to = Math.min(from + 1, line.to)
      if (d.endLine !== undefined && d.endCol !== undefined) {
        const endLine = doc.line(Math.min(Math.max(d.endLine, 1), doc.lines))
        to = Math.min(endLine.from + Math.max(d.endCol - 1, 0), endLine.to)
      }
      out.push({
        from,
        to: Math.max(to, from),
        severity: d.severity,
        message: d.message,
        source: d.source,
      })
    } catch {
      // a malformed position must not lose the whole render
    }
  }
  return out
}

/** What mountEditor hands back — the extension seam for visualizers and
 *  widgets (Task 3.4+). */
export interface EditorHandle {
  view: EditorView
  session: Session
  /** The top bar element — extra chrome (viz toggle, project switcher) mounts
   *  here rather than each feature re-querying the DOM. */
  topbar: HTMLElement
  /** Subscribe to raw engine events (meters etc.). The internal master
   *  meter uses the same dispatcher. Returns an unsubscribe function. */
  onEngineEvent(fn: (ev: EngineEvent) => void): () => void
  /** Subscribe to session state changes (playing, synths, cps…). Fired
   *  AFTER the editor's own state render; call session.getState() for the
   *  initial snapshot. Returns an unsubscribe function. */
  onState(fn: (s: SessionState) => void): () => void
  /** Subscribe to scheduler note/beat events (which synth fired, note, gain,
   *  timing) — for note-driven visuals. Fanned out here because the Session's
   *  onPatternEvents is single-consumer (the flasher). Returns unsubscribe. */
  onPatternEvents(fn: (evs: SchedulerEvent[]) => void): () => void
  /** Subscribe to the shader visualizer source: the WGSL from the last good
   *  eval's visual() (or null) plus the current synth names (for per-synth
   *  hit_<name> channels). Replays immediately on subscribe. Returns
   *  an unsubscribe function. */
  onVisual(fn: (wgsl: string | null, synths: string[]) => void): () => void
  /** Subscribe to value-probe targets: every modulation expression the last
   *  good eval tagged (synth + node id + source char-range). The live-readout
   *  feature picks which to show and calls session.setProbes. Replays the last
   *  set on subscribe. Returns an unsubscribe function. */
  onProbeTargets(fn: (targets: ProbeTarget[]) => void): () => void
  /** Current editor text. */
  getDoc(): string
  /** Replace the whole buffer (loading a project or restoring a version):
   *  stops the transport first — like loading an example — so Run starts the
   *  new program cleanly from cycle 0 rather than hot-swapping mid-cycle. */
  loadCode(code: string): void
  /** The editor language: 'rondocode' (the JS DSL) or 'rondo' (the terse
   *  language that transpiles to it). Drives highlighting, intellisense, and
   *  whether Run transpiles first. */
  getLang(): EditorLang
  setLang(lang: EditorLang): void
  /** Apply a literal rewrite to the doc and re-eval — the same path the inline
   *  widget/scrub controls use, exposed so the mixer's bus faders can edit the
   *  bus() literals in the source. A drag passes immediate=false (throttled,
   *  leading+trailing eval); a discrete set passes true. */
  rewrite(change: { from: number; to: number; insert: string }, immediate: boolean): void
  /** Fired on every doc change with the new text (the library autosaves the
   *  active project from this). Returns an unsubscribe function. */
  onDoc(fn: (code: string) => void): () => void
  /** Fired after each eval (Run or widget re-eval) with the evaluated code and
   *  whether it succeeded — the library snapshots history from this. */
  onEval(fn: (ev: { code: string; ok: boolean }) => void): () => void
  /** Tear everything down: flush the pending save, dispose the session and
   *  flasher, detach lifecycle listeners, destroy the view. */
  dispose(): void
}

export function mountEditor(root: HTMLElement, audio: AudioSession): EditorHandle {
  // Single source of truth for the flash pulse duration: CSS reads it here.
  document.documentElement.style.setProperty('--flash-ms', `${FLASH_MS}ms`)

  // ---- DOM shell -----------------------------------------------------
  const topbar = el('header', 'topbar')
  const logo = el('span', 'logo', 'rondocode')
  // sample loader: bring audio files into the engine as sample(gate, 'name').
  // Icon-only in the header (the label is hidden via CSS like the other
  // secondary controls); the title names it, and it opens the samples popover.
  const sampleBtn = el('button', 'btn sample-btn')
  sampleBtn.type = 'button'
  tooltip(sampleBtn, 'load audio file(s) as samples, then play with sample(gate, "name")')
  const sampleLabel = el('span', 'btn-label', 'sample')
  const renderSample = (): void => {
    sampleBtn.replaceChildren(iconEl('plus'), sampleLabel)
  }
  renderSample()
  const fileInput = el('input', 'sample-file') as HTMLInputElement
  fileInput.type = 'file'
  fileInput.accept = 'audio/*'
  fileInput.multiple = true
  fileInput.hidden = true
  // The samples popover (mounted below, once the editor view exists) wires the
  // button toggle, file loading, and the list of what's loaded.

  // Master output meter, styled as the header's living baseline hairline.
  const meter = el('div', 'meter')
  const meterFill = el('div', 'meter-fill')
  meter.append(meterFill)

  // Right-side control cluster in the header (viz.ts prepends its toggle here).
  const controls = el('div', 'hdr-controls')
  // Language picker: JavaScript (rondocode) ↔ rondo. Its label shows the ACTIVE
  // language; clicking toggles. Wired below, once setLang exists.
  const langBtn = el('button', 'btn lang-btn')
  langBtn.type = 'button'
  const langLabel = el('span', 'btn-label')
  langBtn.append(langLabel)
  tooltip(langBtn, 'language: JavaScript ↔ rondo')
  const runBtn = el('button', 'btn run')
  runBtn.type = 'button'
  const runLabel = el('span', 'btn-label', 'run')
  runBtn.replaceChildren(iconEl('play'), runLabel)
  tooltip(runBtn, 'run (Cmd/Ctrl+Enter)') // also sets aria-label (icon-only on mobile)
  const stopBtn = el('button', 'btn stop-btn hidden') // only shown while playing
  stopBtn.type = 'button'
  stopBtn.replaceChildren(iconEl('stop'))
  tooltip(stopBtn, 'stop (Cmd/Ctrl+.)')
  const dirtyDot = el('span', 'dirty-dot')
  tooltip(dirtyDot, 'edited since last run')
  runBtn.append(dirtyDot) // the "edited since last run" hint lives on Run itself
  const exportBtn = el('button', 'btn export-btn')
  exportBtn.type = 'button'
  exportBtn.replaceChildren(iconEl('download'), el('span', 'btn-label', 'export'))
  controls.append(langBtn, sampleBtn, exportBtn, stopBtn, runBtn)

  topbar.append(logo, fileInput, controls, meter)

  // Default demo samples so `sample()` works out of the box (users add their
  // own via the button above). Generated PCM fed through the real sample path.
  try {
    audio.loadSamplePcm('vox', makeVox(audio.sampleRate), audio.sampleRate, true)
    audio.loadSamplePcm('riser', makeRiser(audio.sampleRate), audio.sampleRate, true)
    audio.loadSamplePcm('pad', makePad(audio.sampleRate), audio.sampleRate, true)
    // sing(): wire the neural render manager + its progress dialog
    singMgr.initSing(audio)
    mountSingDialog()
  } catch (e) {
    console.warn('[sample] default sample load failed', e)
  }

  const host = el('div', 'editor-host')
  // the rondo tap palette: a chip bar docked above the software keyboard,
  // offering the grammar's legal next moves at the cursor (rondo mode only)
  const paletteBar = el('div', 'rondo-palette hidden')
  const strip = el('div', 'status-strip')
  strip.hidden = true

  root.append(topbar, host, paletteBar, strip)

  // ---- doc persistence -----------------------------------------------
  // Debounced writes + an eager flush on pagehide/visibility-hidden: iOS
  // kills backgrounded tabs without ever firing pending timers, which is
  // exactly when losing typed-but-never-run text would hurt most.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSave: string | undefined
  const writeDoc = (source: string): void => {
    try {
      localStorage.setItem(DOC_KEY, source)
    } catch {
      // storage full / private mode: losing persistence is acceptable
    }
  }
  const saveDoc = (source: string, delayMs: number): void => {
    clearTimeout(saveTimer)
    pendingSave = source
    saveTimer = setTimeout(() => {
      pendingSave = undefined
      writeDoc(source)
    }, delayMs)
  }
  const flushSave = (): void => {
    if (pendingSave === undefined) return
    clearTimeout(saveTimer)
    writeDoc(pendingSave)
    pendingSave = undefined
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flushSave()
  }
  window.addEventListener('pagehide', flushSave)
  document.addEventListener('visibilitychange', onVisibility)

  // Seams for the projects/history library (session/projects.ts): it autosaves
  // the active project from onDoc and snapshots history from onEval.
  const docListeners = new Set<(code: string) => void>()
  const evalListeners = new Set<(ev: { code: string; ok: boolean }) => void>()
  const emitDoc = (code: string): void => {
    for (const fn of docListeners) {
      try {
        fn(code)
      } catch (e) {
        console.warn('[editor] doc listener failed', e)
      }
    }
  }
  const emitEval = (code: string, ok: boolean): void => {
    for (const fn of evalListeners) {
      try {
        fn({ code, ok })
      } catch (e) {
        console.warn('[editor] eval listener failed', e)
      }
    }
  }

  // ---- editor state --------------------------------------------------
  // Language surface (rondocode ↔ rondo). Compartments let us swap the grammar
  // + completion at runtime; `lang` gates transpile-before-run in applyDoc.
  let lang: EditorLang = initialLang()
  // Persist the heuristic's choice immediately: once a doc autosaves, a fresh
  // mobile visit's rondo buffer must not be reclassified as rondocode on
  // reload by the saved-doc guard in initialLang().
  try {
    if (localStorage.getItem(LANG_KEY) === null) localStorage.setItem(LANG_KEY, lang)
  } catch {
    // storage failures leave the heuristic re-running each visit — harmless
  }
  const langCompartment = new Compartment()
  const completionCompartment = new Compartment()
  let liveTypeTimer: ReturnType<typeof setTimeout> | undefined
  const initialDoc = loadDoc(lang)
  /** Source of the last eval attempt / last GOOD eval (dirty tracking). */
  let lastAttempted: string | undefined
  let lastGood: string | undefined
  let dirtyVsGood = true
  // Synth/channel names of the current sing() vocals (for karaoke detection).
  let singSoundNames = new Set<string>()
  let dirtyVsAttempted = true

  const updateDirty = (doc: string): void => {
    dirtyVsGood = doc !== lastGood
    dirtyVsAttempted = doc !== lastAttempted
    dirtyDot.classList.toggle('visible', dirtyVsAttempted)
  }

  /** Eval the current doc (the Run path and the widget re-eval path share
   *  this). Only the ▶ path auto-starts the transport — dragging a slider
   *  while stopped stages the change silently. */
  const applyDoc = (autoplay: boolean): boolean => {
    const source = view.state.doc.toString()
    saveDoc(source, SAVE_ON_EVAL_MS) // good or bad: the text is worth keeping
    lastAttempted = source
    // In rondo mode, transpile first and eval the OUTPUT. A compile failure
    // shows the rondo diagnostics (their line/col already point at THIS buffer)
    // and skips the eval entirely.
    let evalSource = source
    let rondoNotes: NoteSpan[] = []
    if (lang === 'rondo') {
      const compiled = compile(source)
      if (!compiled.ok) {
        const diags: Diagnostic[] = compiled.errors.map((e) => ({
          line: e.line, col: e.col, message: e.message, severity: 'error', source: 'eval',
        }))
        view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, diags)))
        updateDirty(source)
        if (autoplay) emitEval(source, false)
        return true
      }
      evalSource = compiled.code
      rondoNotes = compiled.notes
    }
    // live = a widget/scrub re-eval (not an explicit Run): lets the Session
    // hot-patch constants continuously and coalesce rebuilds, so sweeping a
    // synth number glides instead of stuttering.
    const result = session.evalCode(evalSource, { live: !autoplay }) // diagnostics arrive via callback
    if (result.ok) {
      lastGood = source
      // Note-play flash: rondocode maps onset events by scanning the source's
      // string literals; rondo can't (the eval'd source is transpiled JS), so
      // the compiler hands us each notation string + its buffer offset and we
      // build the flash literals from that — same highlighting, either language.
      if (lang === 'rondo') flasher.onGoodEvalLiterals(rondoNoteLiterals(rondoNotes))
      else flasher.onGoodEval(source)
      // Track the current vocals' synth/channel names so karaoke can spot their
      // trigger events even when sing(..., { name }) renames off the singv-hash.
      singSoundNames = new Set(result.sings.map((s) => s.synthName))
      const firstPlay = autoplay && !session.getState().playing
      const singCps = result.cps ?? session.getState().cps
      // sing(): bake the vocal clip(s). First play PRELOADS (wait, then play);
      // live edits bake in the BACKGROUND and swap the clip in when ready.
      const needPreload = firstPlay && result.sings.length > 0 && singMgr.hasUnloaded(result.sings, singCps)
      const startPlayback = (): void => {
        // First Run unlocks audio: resume() runs inside this click/keypress
        // gesture, which is exactly what browsers require. Idempotent after.
        void audio.resume()
        session.transport('play')
      }
      if (needPreload) {
        // A first play that must bake a vocal. If the models aren't downloaded
        // yet, ASK first (it's a large one-time download); on consent, bake +
        // wait + play; if declined, play the track without the vocal.
        void (async () => {
          if (!(await singMgr.modelsCached()) && !(await confirmSingDownload())) {
            startPlayback()
            return
          }
          singMgr.bake(result.sings, singCps)
          await singMgr.whenReady(result.sings, singCps)
          startPlayback()
        })()
      } else {
        if (result.sings.length > 0) singMgr.bake(result.sings, singCps) // background bake on live edits
        if (firstPlay) startPlayback()
      }
    }
    updateDirty(source)
    // Only explicit Runs (autoplay) record history — widget-drag re-evals fire
    // this path every ~70ms and would flood the timeline. Their edits are still
    // kept as the working code via the onDoc autosave.
    if (autoplay) emitEval(source, result.ok)
    return true
  }

  // Flash the Run button on every run (click OR Mod-Enter) for tactile
  // feedback. Remove-reflow-add restarts the animation even on rapid presses.
  const flashRun = (): void => {
    runBtn.classList.remove('run-flash')
    void runBtn.offsetWidth
    runBtn.classList.add('run-flash')
  }
  runBtn.addEventListener('animationend', () => runBtn.classList.remove('run-flash'))

  const run = (): boolean => {
    flashRun()
    return applyDoc(true)
  }

  // Widgets/scrub hand every literal rewrite to the editor as a normal
  // transaction, then ask for a re-eval here: immediate for discrete changes
  // (toggle/pick), throttled for drags so the value applies AS YOU DRAG (a
  // leading-edge eval, then at most one per WIDGET_EVAL_MS, plus a trailing
  // eval that lands the exact release value).
  let widgetEvalTimer: ReturnType<typeof setTimeout> | undefined
  let lastWidgetEval = 0
  const requestEval = (immediate: boolean): void => {
    clearTimeout(widgetEvalTimer)
    widgetEvalTimer = undefined
    if (immediate) {
      applyDoc(false)
      lastWidgetEval = Date.now()
      return
    }
    const since = Date.now() - lastWidgetEval
    if (since >= WIDGET_EVAL_MS) {
      applyDoc(false) // leading edge: apply now, mid-drag
      lastWidgetEval = Date.now()
    } else {
      // too soon — schedule the trailing eval to land the latest value
      widgetEvalTimer = setTimeout(() => {
        applyDoc(false)
        lastWidgetEval = Date.now()
      }, WIDGET_EVAL_MS - since)
    }
  }

  // Per-synth inline meters: a tiny level bar at the end of every
  // `const X = synth(...)` line, fed below from the engine-event fanout.
  const meters = synthMeters()

  const stop = (): boolean => {
    session.transport('stop')
    flasher.clearPending() // events that will never sound must not light up
    return true
  }

  const view: EditorView = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: initialDoc,
      extensions: [
        // Transport keys live with the editor (docs blocks have their own ▶).
        // Highest precedence so nothing steals Mod-Enter / Mod-.
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run },
            { key: 'Mod-.', run: stop },
          ]),
        ),
        // The shared rondocode editing stack — grammar, highlighting (incl.
        // WGSL), DSL intellisense/hover/note-cards/go-to-def, inline widgets +
        // drag-to-scrub, multicursor, theme. Kept byte-identical to the docs
        // examples via editor/setup.ts so the two can never drift.
        ...codeEditingExtensions({ requestEval, langCompartment, completionCompartment }),
        // ---- host-only: things the docs page has no analogue for ----
        // LLM ghost text: DEV-ONLY (a local authoring convenience, not part of
        // the shipped product). On idle, asks the bridge's /complete endpoint
        // to continue the code; Tab accepts, Esc dismisses. `[]` in production
        // builds means the extension is simply never installed.
        import.meta.env.DEV ? ghostCompletion() : [],
        meters.extension, // per-synth meter gutter (audio-driven)
        karaokeExtension, // karaoke syllable/note highlight while a vocal sings
        EditorView.updateListener.of((u) => {
          // the tap palette re-derives its chips from the cursor context
          // (palette is declared below; updates only fire post-mount)
          if ((u.docChanged || u.selectionSet) && lang === 'rondo') palette.refresh()
          if (!u.docChanged) return
          const doc = u.state.doc.toString()
          updateDirty(doc)
          // Persist typed-but-never-run text too: an accidental reload on
          // a phone must not lose work.
          saveDoc(doc, SAVE_ON_CHANGE_MS)
          emitDoc(doc) // library autosaves the active project
          // LIVE TYPING (opt-in): while playing, a clean edit applies itself
          // once typing settles — the loop never stops. A failed compile/eval
          // just shows its squiggles and changes nothing (last-good contract).
          clearTimeout(liveTypeTimer)
          if (getSetting('liveType') && session.getState().playing) {
            liveTypeTimer = setTimeout(() => applyDoc(false), LIVE_TYPE_SETTLE_MS)
          }
        }),
      ],
    }),
  })

  // Pattern-event fanout: the Session's onPatternEvents is single-consumer, and
  // the flasher already owns it — so we route it through here to also feed the
  // shader visualizer and the live rondo widgets without stealing it from the
  // flasher. Declared BEFORE the language wiring: widget toDOM runs
  // synchronously inside the mount-time Compartment reconfigure and subscribes
  // immediately — a later declaration is a TDZ crash.
  const patternListeners = new Set<(evs: SchedulerEvent[]) => void>()
  const subscribePatternEvents = (fn: (evs: SchedulerEvent[]) => void): (() => void) => {
    patternListeners.add(fn)
    return () => patternListeners.delete(fn)
  }

  // ---- language switching (rondocode ↔ rondo) ----
  // Live-widget hooks: the audio clock + a note-event feed make the rondo
  // widgets ANIMATE — playhead lighting on the piano-roll, the envelope's
  // marker firing per note, pattern-driven knobs turning themselves.
  const rondoWidgetHooks: RondoWidgetHooks = {
    requestEval,
    now: () => audio.currentTimeFrames / audio.sampleRate,
    // touch-to-override: a held knob plays the hand's value NOW (engine param,
    // no eval round-trip) and suppresses the pattern drive until release
    holdParam: (synth, name, value) => session.holdParam(synth, name, value),
    releaseParam: (synth, name) => session.releaseParam(synth, name),
    // grid preview: tapping a piano-roll cell while stopped sounds that note
    // (a one-shot noteOn/noteOff straight to the engine; the tap is the
    // audio-unlock gesture)
    isPlaying: () => session.getState().playing,
    previewNote: (synth, midi) => {
      try {
        void audio.resume()
        const at = Math.round(audio.currentTimeFrames)
        audio.send({ kind: 'noteOn', synth, note: midi, velocity: 0.8, atFrame: at })
        audio.send({ kind: 'noteOff', synth, note: midi, atFrame: at + Math.round(0.3 * audio.sampleRate) })
      } catch {
        // preview is a garnish — never let it break a tap
      }
    },
    onNoteEvents: (fn) =>
      subscribePatternEvents((evs) => {
        const notes = toNoteEvs(evs)
        if (notes.length > 0) fn(notes)
      }),
  }
  // the tap palette: grammar-legal chips above the keyboard (rondo mode).
  // Mounted BEFORE the language wiring: the mount-time Compartment reconfigure
  // fires the view's update listener, which refreshes the palette.
  const palette = mountRondoPalette(paletteBar, view)
  const reflectLang = (): void => {
    langLabel.textContent = lang === 'rondo' ? 'rondo' : 'js'
    langBtn.classList.toggle('lang-rondo', lang === 'rondo')
  }
  const reconfigureLang = (): void => {
    view.dispatch({
      effects: [
        langCompartment.reconfigure(lang === 'rondo' ? rondoLanguage(rondoWidgetHooks) : javascript()),
        completionCompartment.reconfigure(lang === 'rondo' ? rondoAutocomplete : rondocodeAutocomplete),
      ],
    })
  }
  const setLang = (next: EditorLang): void => {
    if (next === lang) return
    lang = next
    try { localStorage.setItem(LANG_KEY, lang) } catch { /* ignore storage failures */ }
    reflectLang()
    reconfigureLang()
    palette.setVisible(lang === 'rondo')
    applyDoc(false) // re-lint the buffer under the new language
  }
  reflectLang()
  if (lang === 'rondo') reconfigureLang() // compartments boot as rondocode
  langBtn.addEventListener('click', () => setLang(lang === 'rondo' ? 'rondocode' : 'rondo'))

  palette.setVisible(lang === 'rondo')

  const flasher = new EventFlasher(
    view,
    () => audio.currentTimeFrames / audio.sampleRate,
    () => dirtyVsGood,
  )

  // ---- session wiring ------------------------------------------------
  const renderDiagnostics = (diags: Diagnostic[]): void => {
    try {
      const evalDiags = diags.filter((d) => d.source === 'eval')
      // rondo mode: eval diagnostics reference the TRANSPILED JS, not this
      // buffer — clamped squiggles would land on unrelated rondo text, so they
      // join the status strip instead. (Rondo COMPILE errors, whose positions
      // do point at this buffer, are dispatched directly from applyDoc.)
      // A successful eval still clears stale compile squiggles: empty set.
      view.dispatch(
        setDiagnostics(view.state, lang === 'rondo' ? [] : toCmDiagnostics(view.state.doc, evalDiags)),
      )
      const stripDiags = [
        ...(lang === 'rondo' ? evalDiags : []),
        ...diags.filter((d) => d.source !== 'eval'),
      ].slice(-2)
      strip.replaceChildren(
        ...stripDiags.map((d) => el('div', 'status-line', `[${d.source}] ${d.message}`)),
      )
      strip.hidden = stripDiags.length === 0
    } catch (e) {
      console.warn('[editor] diagnostics render failed', e)
    }
  }

  // Engine-event fanout: the Session exposes ONE onEngineEvent; visualizers
  // (Task 3.4+) and the master meter all subscribe here instead. Session
  // state gets the same treatment for the viz panel / mixer strip.
  const engineListeners = new Set<(ev: EngineEvent) => void>()
  const subscribeEngine = (fn: (ev: EngineEvent) => void): (() => void) => {
    engineListeners.add(fn)
    return () => engineListeners.delete(fn)
  }
  const stateListeners = new Set<(s: SessionState) => void>()
  const subscribeState = (fn: (s: SessionState) => void): (() => void) => {
    stateListeners.add(fn)
    return () => stateListeners.delete(fn)
  }
  // Visual (WGSL) fanout: the Session fires onVisual on each good eval, with
  // the current synth names (for per-synth hit_<name> channels).
  const visualListeners = new Set<(wgsl: string | null, synths: string[]) => void>()
  let lastVisual: string | null = null
  let lastSynths: string[] = []
  const subscribeVisual = (fn: (wgsl: string | null, synths: string[]) => void): (() => void) => {
    visualListeners.add(fn)
    fn(lastVisual, lastSynths) // replay the current shader so late subscribers catch up
    return () => visualListeners.delete(fn)
  }

  // Value-probe targets fanout: the Session fires onProbes on each good eval
  // with every tagged modulation expression; the live-readout feature subscribes.
  const probeListeners = new Set<(targets: ProbeTarget[]) => void>()
  let lastProbes: ProbeTarget[] = []
  const subscribeProbes = (fn: (targets: ProbeTarget[]) => void): (() => void) => {
    probeListeners.add(fn)
    fn(lastProbes)
    return () => probeListeners.delete(fn)
  }

  // Meter: latest master RMS, painted at most once per animation frame.
  let meterLevel = 0
  let meterQueued = false
  const paintMeter = (): void => {
    meterQueued = false
    // RMS → percent; a full sine at master 0.8 lands around 0.57 RMS.
    meterFill.style.width = `${Math.min(100, meterLevel * 160)}%`
  }
  subscribeEngine((ev) => {
    if (ev.kind !== 'meters') return
    meterLevel = ev.master
    if (!meterQueued) {
      meterQueued = true
      requestAnimationFrame(paintMeter)
    }
    meters.onMeters(ev.channels) // per-synth inline bars share the fanout
  })

  const session = new Session({
    audio,
    onDiagnostics: renderDiagnostics,
    onState: (s) => {
      stopBtn.classList.toggle('hidden', !s.playing) // no value when idle
      runBtn.classList.toggle('playing', s.playing)
      // While playing, Run hot-swaps the current code into the running program
      // rather than starting it — label it "update" (refresh icon) to say so.
      runLabel.textContent = s.playing ? 'update' : 'run'
      tooltip(runBtn, s.playing ? 'update (Cmd/Ctrl+Enter)' : 'run (Cmd/Ctrl+Enter)')
      const wantIcon = s.playing ? 'refresh' : 'play'
      if (runBtn.dataset.icon !== wantIcon) {
        runBtn.querySelector('svg.ico')?.replaceWith(iconEl(wantIcon))
        runBtn.dataset.icon = wantIcon
      }
      for (const fn of stateListeners) {
        try {
          fn(s)
        } catch (e) {
          console.warn('[editor] state listener failed', e)
        }
      }
    },
    onEngineEvent: (ev) => {
      for (const fn of engineListeners) {
        try {
          fn(ev)
        } catch (e) {
          console.warn('[editor] engine-event listener failed', e)
        }
      }
    },
    onPatternEvents: (evs) => {
      flasher.onEvents(evs)
      for (const fn of patternListeners) {
        try {
          fn(evs)
        } catch (e) {
          console.warn('[editor] pattern-event listener failed', e)
        }
      }
    },
    onVisual: (wgsl, synths) => {
      lastVisual = wgsl
      lastSynths = synths
      for (const fn of visualListeners) {
        try {
          fn(wgsl, synths)
        } catch (e) {
          console.warn('[editor] visual listener failed', e)
        }
      }
    },
    onProbes: (targets) => {
      lastProbes = targets
      for (const fn of probeListeners) {
        try {
          fn(targets)
        } catch (e) {
          console.warn('[editor] probe listener failed', e)
        }
      }
    },
  })

  // ---- controls ------------------------------------------------------
  runBtn.addEventListener('click', () => run())
  stopBtn.addEventListener('click', () => stop())

  // Replace the whole buffer (library: switch project, load example, restore a
  // version). Stop first — otherwise the old patterns keep running and Run
  // would HOT-SWAP the new program in mid-cycle, so an arrange()/<>-based track
  // would start mid-section with the wrong chords/tempo. Stopping means Run
  // starts the new program cleanly from cycle 0.
  const loadCode = (code: string): void => {
    stop()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
    // buffer replaced; press Run to play it from the top
  }

  // samples popover: lists loaded samples (built-in + user), inserts
  // sample(gate, 'name') at the cursor, and loads audio files.
  const disposeSamples = mountSamplesPopover({ audio, view, anchor: sampleBtn, fileInput })
  const disposeExport = mountExport({ view, audio, anchor: exportBtn })

  // karaoke: light up the current sing() syllable + note as the vocal plays,
  // driven by the sing-trigger event's timing against the AudioContext clock.
  const disposeKaraoke = mountKaraoke(view, {
    audio,
    isPlaying: () => session.getState().playing,
    subscribeEvents: subscribePatternEvents,
    getDoc: () => view.state.doc.toString(),
    onDoc: (fn) => {
      docListeners.add(fn)
      return () => docListeners.delete(fn)
    },
    isSingSound: (snd) => singSoundNames.has(snd),
  })

  const dispose = (): void => {
    window.removeEventListener('pagehide', flushSave)
    document.removeEventListener('visibilitychange', onVisibility)
    clearTimeout(widgetEvalTimer)
    clearTimeout(liveTypeTimer)
    flushSave() // the last text is still worth keeping
    session.dispose()
    flasher.dispose()
    meters.dispose()
    disposeSamples()
    disposeExport()
    disposeKaraoke()
    engineListeners.clear()
    stateListeners.clear()
    docListeners.clear()
    evalListeners.clear()
    view.destroy()
  }

  return {
    view,
    session,
    topbar,
    onEngineEvent: subscribeEngine,
    onState: subscribeState,
    onPatternEvents: subscribePatternEvents,
    onVisual: subscribeVisual,
    onProbeTargets: subscribeProbes,
    getDoc: () => view.state.doc.toString(),
    loadCode,
    getLang: () => lang,
    setLang,
    rewrite: (change, immediate) => {
      view.dispatch({ changes: change })
      requestEval(immediate)
    },
    onDoc: (fn) => {
      docListeners.add(fn)
      return () => docListeners.delete(fn)
    },
    onEval: (fn) => {
      evalListeners.add(fn)
      return () => evalListeners.delete(fn)
    },
    dispose,
  }
}
