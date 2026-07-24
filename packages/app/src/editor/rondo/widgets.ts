/* Inline rondo widgets — the prototype's controls, made real in the editor.
 *
 * v1: the KNOB. A `knob DEF lo..hi [log|lin]` binding renders a small draggable
 * dial right after its default value. Dragging it rewrites DEF in the source
 * (mapped through the range + curve) and re-evals live — the same "the text is
 * the source of truth" contract the rondocode slider()/scrub widgets use.
 *
 * Only active in rondo mode: this extension is bundled into rondoLanguage()'s
 * LanguageSupport, so it comes and goes with the language Compartment.
 *
 * Drag robustness: while dragging we edit only DEF (everything before it is
 * fixed), so the widget's anchor never moves; the plugin suppresses decoration
 * rebuilds mid-drag (mapping through our own edits instead) so the dial DOM —
 * and its pointer capture — survive. */

import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { formatNumber, niceStep } from '../widgets/rewrite'
import { parseScaleName, scaleDegree } from '@rondocode/pattern'
import { expandScale } from '@rondocode/rondo'

/** `knob DEF lo..hi [curve]` — groups: 1=prefix(`knob `), 2=DEF, 3=lo, 4=hi, 5=curve. */
const KNOB_RE = /\b(knob\s+)(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\.\.(-?\d*\.?\d+)(?:\s+(log|lin))?/g

/** A scheduler note event, reduced to what widget animation needs. */
export interface NoteEv {
  /** the mini-notation source string the note's Loc indexes into. */
  src?: string
  /** char offset of the note's atom within `src`. */
  start: number
  /** absolute time (audio clock, seconds) + musical duration. */
  timeSec: number
  durSec: number
  /** the synth/channel the event routes to. */
  sound?: string
  /** the event's control map (drives the live knob display). */
  controls?: Record<string, unknown>
}

export interface Hooks {
  requestEval: (immediate: boolean) => void
  /** audio-clock "now" in seconds — the clock NoteEv.timeSec lives on. */
  now?: () => number
  /** subscribe to note events; returns unsubscribe. When present, widgets go
   *  LIVE: the piano-roll lights with the playhead, the envelope fires its
   *  marker per note, and a pattern-driven knob's dial follows the drive. */
  onNoteEvents?: (fn: (evs: NoteEv[]) => void) => () => void
  /** TOUCH-TO-OVERRIDE: while a hand holds a knob, the held value plays and
   *  the pattern drive for that param is suppressed; releasing hands control
   *  back to the pattern on its next event. */
  holdParam?: (synth: string, name: string, value: number) => void
  releaseParam?: (synth: string, name: string) => void
  /** GRID PREVIEW: sound one note now (tapping a piano-roll cell while the
   *  transport is stopped previews what you just placed). */
  previewNote?: (synth: string, midi: number) => void
  isPlaying?: () => boolean
}

/** A tiny haptic tick on widget interactions (Android; a silent no-op where
 *  the Vibration API is missing, e.g. iOS Safari). */
export const buzz = (ms = 8): void => {
  try {
    ;(navigator as { vibrate?: (ms: number) => void }).vibrate?.(ms)
  } catch {
    // vibration is a garnish — never let it throw
  }
}

/** Resolve a grid degree to a MIDI note through a SHORT scale name
 *  ('a-min'). Returns undefined when there is no scale (a scale-less degree
 *  pattern is silent anyway) or the name doesn't parse. */
export function rollPreviewMidi(scaleShort: string | undefined, degree: number): number | undefined {
  if (scaleShort === undefined) return undefined
  try {
    const { root, intervals } = parseScaleName(expandScale(scaleShort))
    return root + scaleDegree(intervals, degree)
  } catch {
    return undefined
  }
}

/** SchedulerEvents → the reduced NoteEv shape widgets animate from (shared by
 *  the main editor and the docs page so the two feeds can't drift). */
export function toNoteEvs(
  evs: readonly { loc?: { src?: string; start: number }; timeSec: number; durSec: number; controls: Record<string, unknown> }[],
): NoteEv[] {
  const out: NoteEv[] = []
  for (const e of evs) {
    if (e.loc === undefined) continue
    const ev: NoteEv = { start: e.loc.start, timeSec: e.timeSec, durSec: e.durSec, controls: e.controls }
    if (e.loc.src !== undefined) ev.src = e.loc.src
    const sound = e.controls['sound']
    if (typeof sound === 'string') ev.sound = sound
    out.push(ev)
  }
  return out
}

/** Bound how long a note keeps a widget lit. */
const LIT_MIN_MS = 120
const LIT_MAX_MS = 1200
const MAX_PENDING = 64

/** Small per-widget timer pool: schedule audio-clock-aligned UI, drop cleanly
 *  on destroy (widgets die on every rebuild — leaks would pile up fast). */
class Timers {
  private readonly pending = new Set<ReturnType<typeof setTimeout>>()
  at(delayMs: number, fn: () => void): void {
    if (this.pending.size >= MAX_PENDING) return
    const h = setTimeout(() => { this.pending.delete(h); fn() }, Math.max(0, delayMs))
    this.pending.add(h)
  }
  clear(): void {
    for (const h of this.pending) clearTimeout(h)
    this.pending.clear()
  }
}
/** Shared drag state. `active` suppresses decoration rebuilds mid-gesture (so
 *  the dragged DOM + its pointer capture survive); `ended` forces ONE rebuild
 *  on the next update after a gesture — the surviving widget instances hold
 *  stale ranges/values (their doc text changed under them), and a second drag
 *  seeded from those would corrupt the source. */
interface Drag { active: boolean; ended: boolean }

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v)

/** value → normalized 0..1 position on the knob (log or linear). */
export function toNorm(v: number, lo: number, hi: number, log: boolean): number {
  if (log && lo > 0 && hi > 0) return clamp(Math.log(v / lo) / Math.log(hi / lo), 0, 1)
  return clamp((v - lo) / (hi - lo || 1), 0, 1)
}
/** normalized 0..1 → value. */
export function fromNorm(t: number, lo: number, hi: number, log: boolean): number {
  return log && lo > 0 && hi > 0 ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo)
}

export interface KnobMatch {
  /** char offset of the DEF value within the scanned text. */
  defFrom: number
  defTo: number
  value: number
  lo: number
  hi: number
  log: boolean
  /** the binding name (`cutoff = knob …`) — the param a `.ctrl` drives. */
  name?: string
  /** the enclosing `synth NAME` block, for routing live events. */
  synth?: string
}

/** Iterate a doc's CODE lines: the text before any rondo `#` comment, with the
 *  line's absolute offset. Widgets must not match inside comments (a knob in a
 *  comment would render live and drags would rewrite the comment), and per-line
 *  scanning keeps `\s+` in the regexes from crossing newlines. */
function codeLines(text: string): { line: string; off: number; synth?: string }[] {
  const out: { line: string; off: number; synth?: string }[] = []
  let off = 0
  let synth: string | undefined
  for (const raw of text.split('\n')) {
    const cm = /(^|\s)#/.exec(raw)
    const line = cm ? raw.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : raw
    // track block context: a top-level `synth NAME` opens a synth; any other
    // top-level header (play/cps/js) closes it — bindings inside a synth then
    // know which channel's events drive them
    const header = /^(synth|play|cps|js)\b(?:[ \t]+([a-zA-Z_]\w*))?/.exec(line)
    if (header) synth = header[1] === 'synth' ? header[2] : undefined
    out.push({ line, off, synth })
    off += raw.length + 1
  }
  return out
}

/** Find every `knob DEF lo..hi [curve]` in `text` (pure — unit tested). */
export function scanKnobs(text: string): KnobMatch[] {
  const out: KnobMatch[] = []
  for (const { line, off, synth } of codeLines(text)) {
    KNOB_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = KNOB_RE.exec(line)) !== null) {
      const value = Number(m[2]), lo = Number(m[3]), hi = Number(m[4])
      if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) continue
      const defFrom = off + m.index + m[1]!.length
      const name = /^[ \t]*([a-zA-Z_]\w*)[ \t]*=/.exec(line)?.[1]
      out.push({ defFrom, defTo: defFrom + m[2]!.length, value, lo, hi, log: m[5] === 'log', name, synth })
    }
  }
  return out
}

/** `adsr A D S R` — groups: 1=prefix(`adsr `), 2..5 = a,d,s,r. Spaces only
 *  ([ \t]) so a match can never span lines. */
const ENV_RE = /\b(adsr[ \t]+)(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)[ \t]+(-?\d*\.?\d+)/g

export interface EnvMatch {
  /** char offset of the first value (A) within the scanned text. */
  from: number
  /** char offset just past the last value (R). */
  to: number
  a: number
  d: number
  s: number
  r: number
  /** the enclosing `synth NAME` block — its notes fire the curve's marker. */
  synth?: string
}

/** Find every `adsr A D S R` in `text` (pure — unit tested). */
export function scanEnvs(text: string): EnvMatch[] {
  const out: EnvMatch[] = []
  for (const { line, off, synth } of codeLines(text)) {
    ENV_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ENV_RE.exec(line)) !== null) {
      const a = Number(m[2]), d = Number(m[3]), s = Number(m[4]), r = Number(m[5])
      if (![a, d, s, r].every((n) => Number.isFinite(n))) continue
      const from = off + m.index + m[1]!.length
      out.push({ from, to: off + m.index + m[0].length, a, d, s, r, synth })
    }
  }
  return out
}

export interface PlayRoll {
  /** char range of the notation string in the source (what a tap rewrites). */
  from: number
  to: number
  /** the play block's synth (preview routes a tapped note to it). */
  synth?: string
  /** short scale name from an inline `scale:a-min`, for degree→pitch preview. */
  scale?: string
  /** the notation text itself — a play event's `loc.src` equals this, which is
   *  how the grid recognizes its own notes for playhead lighting. */
  content: string
  /** one entry per step: a scale degree, or null for a rest (`~`). */
  steps: (number | null)[]
}

/** Char offset of each step token within a notation string — a note event's
 *  `loc.start` equals one of these, mapping the event to its grid column. */
export function stepStarts(notation: string): number[] {
  const out: number[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(notation)) !== null) out.push(m.index)
  return out
}

/** Find each `play` block's notation line when it's a SIMPLE flat sequence of
 *  degrees / rests (`0 0 3 5 ~ 7`) — the grid-editable case. Notation with
 *  richer mini-notation (`<> [] * @`, note names) is left as plain text. Pure. */
export function scanPlays(text: string): PlayRoll[] {
  const out: PlayRoll[] = []
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const ph = /^([ \t]*)play\s+([a-zA-Z_]\w*)/.exec(lines[i]!)
    if (!ph) continue // a play header (top-level OR nested in a section)
    const playIndent = ph[1]!.length
    const nx = lines[i + 1]
    if (nx === undefined) continue
    const indent = /^[ \t]*/.exec(nx)![0].length
    if (indent <= playIndent) continue // next line isn't a body line
    // strip a trailing `# comment`, then an inline `scale:…`
    const cm = /(^|\s)#/.exec(nx)
    const noComment = cm ? nx.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : nx
    const scale = /\bscale:[a-gA-G][a-z0-9#-]*/.exec(noComment)
    const notation = noComment.slice(indent, scale ? scale.index : noComment.length).replace(/\s+$/, '')
    const toks = notation.trim().split(/\s+/).filter(Boolean)
    if (toks.length === 0) continue
    if (!toks.every((tk) => tk === '~' || /^\d+$/.test(tk))) continue // simple degrees/rests only
    const from = offs[i + 1]! + indent
    const roll: PlayRoll = { from, to: from + notation.length, content: notation, steps: toks.map((tk) => (tk === '~' ? null : Number(tk))) }
    roll.synth = ph[2]!
    if (scale) roll.scale = scale[0]!.slice('scale:'.length)
    out.push(roll)
  }
  return out
}

export interface BeatRow {
  /** char range of the notation line in the source (what a tap rewrites). */
  from: number
  to: number
  /** the notation text itself — a beat event's `loc.src` equals this. */
  content: string
  /** the line's single instrument word — also the synth a tap previews. */
  word: string
  /** one entry per step: sounding or rest. */
  steps: boolean[]
}

/** Find `beat` block body lines that are SIMPLE flat word/rest sequences with
 *  ONE distinct word (`kick ~ kick ~`) — the step-sequencer-editable case.
 *  Mixed words, mini-notation (`kick*4`, `[..]`), and modifier lines are left
 *  as plain text. Pure. */
export function scanBeats(text: string): BeatRow[] {
  const out: BeatRow[] = []
  const lines = text.split('\n')
  const offs: number[] = []
  let o = 0
  for (const l of lines) { offs.push(o); o += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const bh = /^([ \t]*)beat(\s+[a-zA-Z_]\w*)?[ \t]*(#.*)?$/.exec(lines[i]!)
    if (!bh) continue // a beat header (top-level OR nested in a section)
    const beatIndent = bh[1]!.length
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j]!
      if (/^[ \t]*$/.test(ln) || /^[ \t]*#/.test(ln)) continue // blank/comment
      const indent = /^[ \t]*/.exec(ln)![0].length
      if (indent <= beatIndent) break // dedent — the block ended
      const cm = /(^|\s)#/.exec(ln)
      const noComment = cm ? ln.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : ln
      const notation = noComment.slice(indent).replace(/\s+$/, '')
      const toks = notation.split(/\s+/).filter(Boolean)
      if (toks.length < 2) continue // a 1-step row isn't a sequencer
      if (!toks.every((tk) => tk === '~' || /^[a-zA-Z_]\w*$/.test(tk))) continue
      const words = new Set(toks.filter((tk) => tk !== '~'))
      if (words.size !== 1) continue // no single instrument to label the row
      const from = offs[j]! + indent
      out.push({ from, to: from + notation.length, content: notation, word: [...words][0]!, steps: toks.map((tk) => tk !== '~') })
    }
  }
  return out
}

class KnobWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()
  /** true while a drag holds the param (touch-to-override) — released in
   *  end(), and defensively in destroy() so a mid-drag teardown (dispose,
   *  language switch) can never leave the pattern drive suppressed forever. */
  private holding = false

  constructor(
    readonly defFrom: number,
    /** end of the DEF literal IN THE SOURCE — must come from scanKnobs, never
     *  re-derived from the value (String(0.35) is "0.35" but the source may
     *  spell it ".35"; a length mismatch would eat the char after the value). */
    readonly defTo: number,
    readonly value: number,
    readonly lo: number,
    readonly hi: number,
    readonly log: boolean,
    readonly name: string | undefined,
    readonly synth: string | undefined,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: KnobWidget): boolean {
    return o.defFrom === this.defFrom && o.defTo === this.defTo && o.value === this.value &&
      o.lo === this.lo && o.hi === this.hi && o.log === this.log &&
      o.name === this.name && o.synth === this.synth
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'rondo-knob'
    wrap.setAttribute('role', 'slider')
    wrap.setAttribute('aria-label', 'knob')
    wrap.title = 'drag to set'
    wrap.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.35"/>' +
      '<line class="ptr" x1="12" y1="12" x2="12" y2="4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
      '</svg>'
    const ptr = wrap.querySelector('.ptr') as SVGLineElement
    const setDial = (t: number): void => { ptr.setAttribute('transform', `rotate(${-135 + 270 * t} 12 12)`) }
    const baseT = toNorm(this.value, this.lo, this.hi, this.log)
    setDial(baseT)

    // LIVE DRIVE: when a pattern's `.ctrl` sweeps this param, each note event
    // carries the driven value — the dial follows it (amber "live" state) and
    // settles back to the source DEF after the last note. The prototype's
    // "LFO turns the knob" made real. Dragging always wins over the drive.
    if (this.hooks.onNoteEvents && this.hooks.now && this.name !== undefined) {
      const name = this.name
      const now = this.hooks.now
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (this.synth !== undefined && ev.sound !== this.synth) continue
          const v = ev.controls?.[name]
          if (typeof v !== 'number' || !Number.isFinite(v)) continue
          const litMs = Math.min(Math.max(ev.durSec * 1000, LIT_MIN_MS), LIT_MAX_MS)
          this.timers.at((ev.timeSec - now()) * 1000, () => {
            if (this.drag.active) return // a hand on the knob outranks the drive
            wrap.classList.add('live')
            setDial(toNorm(v, this.lo, this.hi, this.log))
            this.timers.at(litMs, () => {
              if (this.drag.active) return
              wrap.classList.remove('live')
              setDial(baseT)
            })
          })
        }
      })
    }

    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      wrap.setPointerCapture(e.pointerId)
      this.drag.active = true
      wrap.classList.add('active')
      buzz()
      wrap.classList.remove('live') // grabbing overrides the pattern drive
      const startY = e.clientY
      const t0 = toNorm(this.value, this.lo, this.hi, this.log)
      const step = niceStep(Math.abs(this.hi - this.lo) / 200)
      const from = this.defFrom
      let toPos = this.defTo // current DEF end in the SOURCE (only DEF changes)
      // TOUCH-TO-OVERRIDE: while held, the exact hand value plays NOW (engine
      // param, no eval round-trip) and the pattern drive is suppressed; the
      // text rewrite below still records the value (text stays the truth).
      const canHold = this.hooks.holdParam !== undefined &&
        this.name !== undefined && this.synth !== undefined
      const move = (ev: PointerEvent): void => {
        const t = clamp(t0 + (startY - ev.clientY) / 170, 0, 1)
        const v = fromNorm(t, this.lo, this.hi, this.log)
        if (canHold) { this.holding = true; this.hooks.holdParam!(this.synth!, this.name!, v) }
        const text = formatNumber(v, { step, min: Math.min(this.lo, this.hi) })
        view.dispatch({ changes: { from, to: toPos, insert: text } })
        toPos = from + text.length
        setDial(t)
        this.hooks.requestEval(false)
      }
      const end = (): void => {
        this.drag.active = false
        this.drag.ended = true
        wrap.classList.remove('active')
        // hand off the knob: the pattern drive resumes on its next event
        if (this.holding) { this.holding = false; this.hooks.releaseParam?.(this.synth!, this.name!) }
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
        this.hooks.requestEval(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    return wrap
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    if (this.holding && this.synth !== undefined && this.name !== undefined) {
      this.holding = false
      this.hooks.releaseParam?.(this.synth, this.name)
    }
  }

  ignoreEvent(): boolean { return true }
}

// envelope handle mapping maxes (seconds); values beyond clamp visually
const AMAX = 1, DMAX = 1, RMAX = 2

class EnvWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()
  private raf = 0

  constructor(
    readonly regionFrom: number,
    readonly regionTo: number,
    readonly a: number,
    readonly d: number,
    readonly s: number,
    readonly r: number,
    readonly synth: string | undefined,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: EnvWidget): boolean {
    // regionTo matters: `.2` → `0.2` keeps the same VALUES but shifts the end;
    // reusing the old DOM would leave its closures rewriting a too-short range
    return o.regionFrom === this.regionFrom && o.regionTo === this.regionTo &&
      o.a === this.a && o.d === this.d && o.s === this.s && o.r === this.r &&
      o.synth === this.synth
  }

  toDOM(view: EditorView): HTMLElement {
    const W = 200, H = 58, pad = 5, base = H - pad, peak = pad, seg = 54, hold = 26
    const wrap = document.createElement('span')
    wrap.className = 'rondo-env'
    wrap.title = 'drag the handles: attack · decay/sustain · release'
    wrap.innerHTML =
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      '<path class="fill"/><path class="line" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle class="emark" r="4"/>' +
      '<circle class="h ha" r="5"/><circle class="h hd" r="5"/><circle class="h hr" r="5"/></svg>'
    const line = wrap.querySelector('.line') as SVGPathElement
    const fill = wrap.querySelector('.fill') as SVGPathElement
    const ha = wrap.querySelector('.ha') as SVGCircleElement
    const hd = wrap.querySelector('.hd') as SVGCircleElement
    const hr = wrap.querySelector('.hr') as SVGCircleElement
    const geom = (a: number, d: number, s: number, r: number) => {
      const ax = pad + clamp(a / AMAX, 0, 1) * seg
      const dx = ax + clamp(d / DMAX, 0, 1) * seg
      const sy = base - clamp(s, 0, 1) * (base - peak)
      const hx = dx + hold
      const rx = hx + clamp(r / RMAX, 0, 1) * seg
      return { ax, dx, sy, hx, rx }
    }
    const render = (a: number, d: number, s: number, r: number): void => {
      const g = geom(a, d, s, r)
      const p = `M ${pad} ${base} L ${g.ax.toFixed(1)} ${peak} L ${g.dx.toFixed(1)} ${g.sy.toFixed(1)} ` +
        `L ${g.hx.toFixed(1)} ${g.sy.toFixed(1)} L ${g.rx.toFixed(1)} ${base}`
      line.setAttribute('d', p)
      fill.setAttribute('d', `${p} L ${g.rx.toFixed(1)} ${base} L ${pad} ${base} Z`)
      ha.setAttribute('cx', String(g.ax)); ha.setAttribute('cy', String(peak))
      hd.setAttribute('cx', String(g.dx)); hd.setAttribute('cy', String(g.sy))
      hr.setAttribute('cx', String(g.rx)); hr.setAttribute('cy', String(base))
    }
    render(this.a, this.d, this.s, this.r)

    // FIRE on each of this synth's notes: a marker rides the curve — up the
    // attack, down the decay, holding at sustain for the note's duration, then
    // out the release — while the curve flashes "firing". Watching the shape
    // shape the sound, per note, like the prototype.
    const mark = wrap.querySelector('.emark') as SVGCircleElement
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const animate = (durSec: number): void => {
        cancelAnimationFrame(this.raf)
        const { a, d, s, r } = this
        const g = geom(a, d, s, r)
        const holdSec = Math.max(durSec - a - d, 0.05)
        const total = a + d + holdSec + r
        const t0 = performance.now()
        wrap.classList.add('firing')
        const frame = (nowMs: number): void => {
          const t = (nowMs - t0) / 1000
          if (t >= total || this.drag.active) {
            wrap.classList.remove('firing')
            mark.style.opacity = '0'
            return
          }
          let x: number, y: number
          if (t < a) { const u = t / a; x = pad + (g.ax - pad) * u; y = base + (peak - base) * u }
          else if (t < a + d) { const u = (t - a) / (d || 1e-6); x = g.ax + (g.dx - g.ax) * u; y = peak + (g.sy - peak) * u }
          else if (t < a + d + holdSec) { const u = (t - a - d) / holdSec; x = g.dx + (g.hx - g.dx) * u; y = g.sy }
          else { const u = (t - a - d - holdSec) / (r || 1e-6); x = g.hx + (g.rx - g.hx) * u; y = g.sy + (base - g.sy) * u }
          mark.setAttribute('cx', x.toFixed(1))
          mark.setAttribute('cy', y.toFixed(1))
          mark.style.opacity = '1'
          this.raf = requestAnimationFrame(frame)
        }
        this.raf = requestAnimationFrame(frame)
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (this.synth !== undefined && ev.sound !== this.synth) continue
          this.timers.at((ev.timeSec - now()) * 1000, () => { if (!this.drag.active) animate(ev.durSec) })
          break // one fire per batch — the marker is monophonic
        }
      })
    }

    const svg = wrap.querySelector('svg') as SVGSVGElement
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation()
      wrap.setPointerCapture(e.pointerId)
      buzz()
      this.drag.active = true; wrap.classList.add('active')
      const rect = svg.getBoundingClientRect()
      const sx = (e.clientX - rect.left) * (W / rect.width)
      const sy = (e.clientY - rect.top) * (H / rect.height)
      let a = this.a, d = this.d, s = this.s, r = this.r
      const g0 = geom(a, d, s, r)
      // pick the nearest handle
      const dist = (x: number, y: number): number => (sx - x) ** 2 + (sy - y) ** 2
      const which = [
        ['a', dist(g0.ax, peak)] as const,
        ['ds', dist(g0.dx, g0.sy)] as const,
        ['r', dist(g0.rx, base)] as const,
      ].sort((p, q) => p[1] - q[1])[0]![0]
      const tStep = 0.001, sStep = 0.01
      const from = this.regionFrom
      let toPos = this.regionTo
      // Preserve the SOURCE spelling of untouched fields: only the dragged
      // handle's value(s) are reformatted — otherwise touching release would
      // silently re-quantize a `.003` attack onto the step grid. parts is
      // [aRaw, ws, dRaw, ws, sRaw, ws, rRaw] (values at even indices).
      const region = view.state.doc.sliceString(from, toPos)
      const parts = region.split(/([ \t]+)/)
      const canSplice = parts.length === 7
      const fmt = (): string => {
        if (!canSplice) {
          return [
            formatNumber(a, { step: tStep }), formatNumber(d, { step: tStep }),
            formatNumber(s, { step: sStep }), formatNumber(r, { step: tStep }),
          ].join(' ')
        }
        const p = parts.slice()
        if (which === 'a') p[0] = formatNumber(a, { step: tStep })
        else if (which === 'ds') { p[2] = formatNumber(d, { step: tStep }); p[4] = formatNumber(s, { step: sStep }) }
        else p[6] = formatNumber(r, { step: tStep })
        return p.join('')
      }
      const move = (ev: PointerEvent): void => {
        const mx = (ev.clientX - rect.left) * (W / rect.width)
        const my = (ev.clientY - rect.top) * (H / rect.height)
        if (which === 'a') a = clamp((mx - pad) / seg, 0, 1) * AMAX
        else if (which === 'ds') {
          const ax = pad + clamp(a / AMAX, 0, 1) * seg
          d = clamp((mx - ax) / seg, 0, 1) * DMAX
          s = clamp((base - my) / (base - peak), 0, 1)
        } else {
          const hx = pad + clamp(a / AMAX, 0, 1) * seg + clamp(d / DMAX, 0, 1) * seg + hold
          r = clamp((mx - hx) / seg, 0, 1) * RMAX
        }
        const text = fmt()
        view.dispatch({ changes: { from, to: toPos, insert: text } })
        toPos = from + text.length
        render(a, d, s, r)
        this.hooks.requestEval(false)
      }
      const end = (): void => {
        this.drag.active = false; this.drag.ended = true
        wrap.classList.remove('active')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
        this.hooks.requestEval(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    return wrap
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
    cancelAnimationFrame(this.raf)
  }

  ignoreEvent(): boolean { return true }
}

class PianoRollWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()

  constructor(
    readonly from: number,
    readonly to: number,
    readonly content: string,
    readonly steps: (number | null)[],
    readonly synth: string | undefined,
    readonly scale: string | undefined,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: PianoRollWidget): boolean {
    // `to`/`content` matter: respacing `0 3 5` → `0  3  5` keeps the same
    // STEPS but shifts offsets; a reused DOM would rewrite a too-short range
    return o.from === this.from && o.to === this.to && o.content === this.content &&
      o.steps.length === this.steps.length && o.steps.every((v, i) => v === this.steps[i])
  }

  toDOM(view: EditorView): HTMLElement {
    const cols = this.steps.length
    let maxDeg = 7
    for (const s of this.steps) if (s !== null && s > maxDeg) maxDeg = s
    const rows = maxDeg + 1
    const grid = document.createElement('span')
    grid.className = 'rondo-roll'
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', 'notation grid: tap or drag to write the melody')
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    const steps = this.steps.slice()
    const cellEls: HTMLElement[][] = Array.from({ length: rows }, () => [])
    // rows top (high degree) → bottom (low), so pitch goes up the screen
    for (let dr = rows - 1; dr >= 0; dr--) {
      for (let c = 0; c < cols; c++) {
        const cell = document.createElement('span')
        // every 4th column reads brighter — the beat grid, like the prototype
        cell.className = 'rc' + (steps[c] === dr ? ' on' : '') + (c % 4 === 0 ? ' beat' : '')
        cell.dataset.r = String(dr)
        cell.dataset.c = String(c)
        cellEls[dr]![c] = cell
        grid.appendChild(cell)
      }
    }

    // PLAYHEAD: this grid's notes carry loc.src === the notation text, and
    // loc.start maps to a column via stepStarts — light the column + bloom the
    // sounding cell as the scheduler sweeps, exactly like the prototype.
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const starts = stepStarts(this.content)
      const lightCol = (c: number, litMs: number): void => {
        for (let r = 0; r < rows; r++) {
          const cell = cellEls[r]?.[c]
          if (!cell) continue
          cell.classList.add('play')
          if (cell.classList.contains('on')) cell.classList.add('trig')
        }
        this.timers.at(litMs, () => {
          for (let r = 0; r < rows; r++) cellEls[r]?.[c]?.classList.remove('play', 'trig')
        })
      }
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (ev.src !== this.content) continue
          const col = starts.indexOf(ev.start)
          if (col < 0) continue
          const litMs = Math.min(Math.max(ev.durSec * 1000, LIT_MIN_MS), LIT_MAX_MS)
          this.timers.at((ev.timeSec - now()) * 1000, () => lightCol(col, litMs))
        }
      })
    }
    const refresh = (c: number): void => {
      for (let r = 0; r < rows; r++) cellEls[r]?.[c]?.classList.toggle('on', steps[c] === r)
    }
    const from = this.from
    let toPos = this.to
    const write = (): void => {
      const s = steps.map((v) => (v === null ? '~' : String(v))).join(' ')
      view.dispatch({ changes: { from, to: toPos, insert: s } })
      toPos = from + s.length
      this.hooks.requestEval(false)
    }
    let painting = false
    let mode: 'draw' | 'erase' = 'draw'
    const set = (r: number, c: number): void => {
      const next = mode === 'draw' ? r : null
      if (steps[c] === next) return // no-op: don't spam identical rewrites/evals mid-drag
      steps[c] = next
      refresh(c)
      write()
      buzz()
      // preview the placed note while the transport is stopped — instant
      // feedback while composing (playing back, the playhead sounds it anyway)
      if (next !== null && this.synth !== undefined && this.hooks.previewNote !== undefined &&
          !(this.hooks.isPlaying?.() ?? false)) {
        const midi = rollPreviewMidi(this.scale, next)
        if (midi !== undefined) this.hooks.previewNote(this.synth, midi)
      }
    }
    grid.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest?.('.rc') as HTMLElement | null
      if (!el) return
      e.preventDefault(); e.stopPropagation()
      grid.setPointerCapture(e.pointerId)
      this.drag.active = true; painting = true
      const r = Number(el.dataset.r), c = Number(el.dataset.c)
      mode = steps[c] === r ? 'erase' : 'draw' // tap an active note to clear it
      set(r, c)
    })
    grid.addEventListener('pointermove', (e) => {
      if (!painting) return
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const cell = el?.closest?.('.rc') as HTMLElement | null
      if (cell && grid.contains(cell)) set(Number(cell.dataset.r), Number(cell.dataset.c))
    })
    const end = (): void => {
      painting = false
      this.drag.active = false
      this.drag.ended = true
      view.dispatch({}) // empty transaction → plugin rebuilds (fresh ranges)
      this.hooks.requestEval(false)
    }
    grid.addEventListener('pointerup', end)
    grid.addEventListener('pointercancel', end)
    return grid
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
  }

  ignoreEvent(): boolean { return true }
}

/** One step-sequencer row per simple beat line: tap/drag toggles steps, the
 *  playhead lights the sweeping column, a placed step previews its drum. */
class BeatRowWidget extends WidgetType {
  private unsub?: () => void
  private readonly timers = new Timers()

  constructor(
    readonly from: number,
    readonly to: number,
    readonly content: string,
    readonly word: string,
    readonly steps: boolean[],
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: BeatRowWidget): boolean {
    // `to`/`content` matter: respacing keeps the same STEPS but shifts
    // offsets; a reused DOM would rewrite a too-short range
    return o.from === this.from && o.to === this.to && o.content === this.content &&
      o.word === this.word && o.steps.length === this.steps.length &&
      o.steps.every((v, i) => v === this.steps[i])
  }

  toDOM(view: EditorView): HTMLElement {
    const cols = this.steps.length
    const grid = document.createElement('span')
    grid.className = 'rondo-roll rondo-beatrow'
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', `step sequencer: tap or drag to place ${this.word} hits`)
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    const steps = this.steps.slice()
    const cellEls: HTMLElement[] = []
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement('span')
      cell.className = 'rc' + (steps[c] === true ? ' on' : '') + (c % 4 === 0 ? ' beat' : '')
      cell.dataset.c = String(c)
      cellEls.push(cell)
      grid.appendChild(cell)
    }

    // PLAYHEAD: this row's events carry loc.src === the notation text, and
    // loc.start maps to a column via stepStarts.
    if (this.hooks.onNoteEvents && this.hooks.now) {
      const now = this.hooks.now
      const starts = stepStarts(this.content)
      this.unsub = this.hooks.onNoteEvents((evs) => {
        for (const ev of evs) {
          if (ev.src !== this.content) continue
          const col = starts.indexOf(ev.start)
          if (col < 0) continue
          const litMs = Math.min(Math.max(ev.durSec * 1000, LIT_MIN_MS), LIT_MAX_MS)
          this.timers.at((ev.timeSec - now()) * 1000, () => {
            const cell = cellEls[col]
            if (!cell) return
            cell.classList.add('play')
            if (cell.classList.contains('on')) cell.classList.add('trig')
            this.timers.at(litMs, () => cell.classList.remove('play', 'trig'))
          })
        }
      })
    }
    // The doc write is DEFERRED to gesture end: toggling `kick` ↔ `~` changes
    // the LINE LENGTH, so a mid-gesture write shifts this widget under the
    // stationary pointer and the next pointermove paints the neighbor cell.
    // (The piano-roll writes live safely — its tokens are all one char.)
    let painting = false
    let dirty = false
    let mode: 'draw' | 'erase' = 'draw'
    const set = (c: number): void => {
      const next = mode === 'draw'
      if (steps[c] === next) return
      steps[c] = next
      dirty = true
      cellEls[c]?.classList.toggle('on', next)
      buzz()
      // preview the placed hit while the transport is stopped — beat events
      // carry the sound() default note (60); drums ignore the pitch anyway
      if (next && this.hooks.previewNote !== undefined && !(this.hooks.isPlaying?.() ?? false)) {
        this.hooks.previewNote(this.word, 60)
      }
    }
    grid.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest?.('.rc') as HTMLElement | null
      if (!el) return
      e.preventDefault(); e.stopPropagation()
      grid.setPointerCapture(e.pointerId)
      this.drag.active = true; painting = true
      const c = Number(el.dataset.c)
      mode = steps[c] === true ? 'erase' : 'draw' // tap an active step to clear it
      set(c)
    })
    grid.addEventListener('pointermove', (e) => {
      if (!painting) return
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const cell = el?.closest?.('.rc') as HTMLElement | null
      if (cell && grid.contains(cell)) set(Number(cell.dataset.c))
    })
    const end = (): void => {
      if (!painting) return
      painting = false
      this.drag.active = false
      if (!dirty) return // nothing changed — ranges are still valid, no rebuild
      dirty = false
      this.drag.ended = true // the write's own transaction triggers ONE rebuild
      const s = steps.map((v) => (v ? this.word : '~')).join(' ')
      view.dispatch({ changes: { from: this.from, to: this.to, insert: s } })
      this.hooks.requestEval(false)
    }
    grid.addEventListener('pointerup', end)
    grid.addEventListener('pointercancel', end)
    return grid
  }

  destroy(): void {
    this.unsub?.()
    this.timers.clear()
  }

  ignoreEvent(): boolean { return true }
}

/** Scan the doc for knob + envelope + play-notation bindings → inline widgets. */
function build(view: EditorView, hooks: Hooks, drag: Drag): DecorationSet {
  const items: { pos: number; deco: Decoration }[] = []
  // Docs are tiny (<10 KB); scan the whole thing so widgets past the viewport
  // (and the line-oriented play scan) work without slicing bookkeeping.
  const text = view.state.doc.toString()
  for (const k of scanKnobs(text)) {
    items.push({ pos: k.defTo, deco: Decoration.widget({ widget: new KnobWidget(k.defFrom, k.defTo, k.value, k.lo, k.hi, k.log, k.name, k.synth, hooks, drag), side: 1 }) })
  }
  for (const e of scanEnvs(text)) {
    items.push({ pos: e.to, deco: Decoration.widget({ widget: new EnvWidget(e.from, e.to, e.a, e.d, e.s, e.r, e.synth, hooks, drag), side: 1 }) })
  }
  for (const p of scanPlays(text)) {
    items.push({ pos: p.to, deco: Decoration.widget({ widget: new PianoRollWidget(p.from, p.to, p.content, p.steps, p.synth, p.scale, hooks, drag), side: 1 }) })
  }
  for (const b of scanBeats(text)) {
    items.push({ pos: b.to, deco: Decoration.widget({ widget: new BeatRowWidget(b.from, b.to, b.content, b.word, b.steps, hooks, drag), side: 1 }) })
  }
  items.sort((x, y) => x.pos - y.pos)
  const b = new RangeSetBuilder<Decoration>()
  for (const it of items) b.add(it.pos, it.pos, it.deco)
  return b.finish()
}

/** The rondo inline-widget extension (knob · envelope · piano-roll). */
export function rondoWidgets(hooks: Hooks): Extension {
  const drag: Drag = { active: false, ended: false }
  return ViewPlugin.fromClass(
    class {
      decos: DecorationSet
      constructor(view: EditorView) { this.decos = build(view, hooks, drag) }
      update(u: ViewUpdate): void {
        // Keep the dragged widget's DOM stable: map our own edits through
        // instead of rebuilding (which would destroy the element mid-gesture)…
        if (drag.active) { this.decos = this.decos.map(u.changes); return }
        // …then rebuild ONCE when the gesture ends (each end() dispatches an
        // empty transaction): surviving instances hold stale ranges/values, and
        // a second drag seeded from them would rewrite the wrong chars.
        if (drag.ended) { drag.ended = false; this.decos = build(u.view, hooks, drag); return }
        if (u.docChanged || u.viewportChanged) this.decos = build(u.view, hooks, drag)
      }
    },
    { decorations: (v) => v.decos },
  )
}
