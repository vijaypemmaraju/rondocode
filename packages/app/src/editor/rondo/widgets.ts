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

/** `knob DEF lo..hi [curve]` — groups: 1=prefix(`knob `), 2=DEF, 3=lo, 4=hi, 5=curve. */
const KNOB_RE = /\b(knob\s+)(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\.\.(-?\d*\.?\d+)(?:\s+(log|lin))?/g

interface Hooks { requestEval: (immediate: boolean) => void }
interface Drag { active: boolean }

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
}

/** Find every `knob DEF lo..hi [curve]` in `text` (pure — unit tested). */
export function scanKnobs(text: string): KnobMatch[] {
  const out: KnobMatch[] = []
  KNOB_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KNOB_RE.exec(text)) !== null) {
    const value = Number(m[2]), lo = Number(m[3]), hi = Number(m[4])
    if (!Number.isFinite(value) || !Number.isFinite(lo) || !Number.isFinite(hi)) continue
    const defFrom = m.index + m[1]!.length
    out.push({ defFrom, defTo: defFrom + m[2]!.length, value, lo, hi, log: m[5] === 'log' })
  }
  return out
}

/** `adsr A D S R` — groups: 1=prefix(`adsr `), 2..5 = a,d,s,r. */
const ENV_RE = /\b(adsr\s+)(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g

export interface EnvMatch {
  /** char offset of the first value (A) within the scanned text. */
  from: number
  /** char offset just past the last value (R). */
  to: number
  a: number
  d: number
  s: number
  r: number
}

/** Find every `adsr A D S R` in `text` (pure — unit tested). */
export function scanEnvs(text: string): EnvMatch[] {
  const out: EnvMatch[] = []
  ENV_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ENV_RE.exec(text)) !== null) {
    const a = Number(m[2]), d = Number(m[3]), s = Number(m[4]), r = Number(m[5])
    if (![a, d, s, r].every((n) => Number.isFinite(n))) continue
    const from = m.index + m[1]!.length
    out.push({ from, to: m.index + m[0].length, a, d, s, r })
  }
  return out
}

export interface PlayRoll {
  /** char range of the notation string in the source (what a tap rewrites). */
  from: number
  to: number
  /** one entry per step: a scale degree, or null for a rest (`~`). */
  steps: (number | null)[]
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
    if (!/^play\s+\S/.test(lines[i]!)) continue // header at indent 0
    const nx = lines[i + 1]
    if (nx === undefined) continue
    const indent = /^[ \t]*/.exec(nx)![0].length
    if (indent === 0) continue // next line isn't a body line
    // strip a trailing `# comment`, then an inline `scale:…`
    const cm = /(^|\s)#/.exec(nx)
    const noComment = cm ? nx.slice(0, cm.index + (cm[1] ? cm[1].length : 0)) : nx
    const scale = /\bscale:[a-gA-G][a-z0-9#-]*/.exec(noComment)
    const notation = noComment.slice(indent, scale ? scale.index : noComment.length).replace(/\s+$/, '')
    const toks = notation.trim().split(/\s+/).filter(Boolean)
    if (toks.length === 0) continue
    if (!toks.every((tk) => tk === '~' || /^\d+$/.test(tk))) continue // simple degrees/rests only
    const from = offs[i + 1]! + indent
    out.push({ from, to: from + notation.length, steps: toks.map((tk) => (tk === '~' ? null : Number(tk))) })
  }
  return out
}

class KnobWidget extends WidgetType {
  constructor(
    readonly defFrom: number,
    readonly value: number,
    readonly lo: number,
    readonly hi: number,
    readonly log: boolean,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: KnobWidget): boolean {
    return o.defFrom === this.defFrom && o.value === this.value &&
      o.lo === this.lo && o.hi === this.hi && o.log === this.log
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'rondo-knob'
    wrap.setAttribute('role', 'slider')
    wrap.setAttribute('aria-label', 'knob')
    wrap.title = 'drag to set'
    wrap.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 15 15">' +
      '<circle cx="7.5" cy="7.5" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>' +
      '<line class="ptr" x1="7.5" y1="7.5" x2="7.5" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
      '</svg>'
    const ptr = wrap.querySelector('.ptr') as SVGLineElement
    const setDial = (t: number): void => { ptr.setAttribute('transform', `rotate(${-135 + 270 * t} 7.5 7.5)`) }
    setDial(toNorm(this.value, this.lo, this.hi, this.log))

    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      wrap.setPointerCapture(e.pointerId)
      this.drag.active = true
      wrap.classList.add('active')
      const startY = e.clientY
      const t0 = toNorm(this.value, this.lo, this.hi, this.log)
      const step = niceStep(Math.abs(this.hi - this.lo) / 200)
      const from = this.defFrom
      let toPos = from + String(this.value).length // current DEF end (only DEF changes)
      const move = (ev: PointerEvent): void => {
        const t = clamp(t0 + (startY - ev.clientY) / 170, 0, 1)
        const v = fromNorm(t, this.lo, this.hi, this.log)
        const text = formatNumber(v, { step, min: Math.min(this.lo, this.hi) })
        view.dispatch({ changes: { from, to: toPos, insert: text } })
        toPos = from + text.length
        setDial(t)
        this.hooks.requestEval(false)
      }
      const end = (): void => {
        this.drag.active = false
        wrap.classList.remove('active')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        this.hooks.requestEval(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

// envelope handle mapping maxes (seconds); values beyond clamp visually
const AMAX = 1, DMAX = 1, RMAX = 2

class EnvWidget extends WidgetType {
  constructor(
    readonly regionFrom: number,
    readonly regionTo: number,
    readonly a: number,
    readonly d: number,
    readonly s: number,
    readonly r: number,
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: EnvWidget): boolean {
    return o.regionFrom === this.regionFrom &&
      o.a === this.a && o.d === this.d && o.s === this.s && o.r === this.r
  }

  toDOM(view: EditorView): HTMLElement {
    const W = 200, H = 58, pad = 5, base = H - pad, peak = pad, seg = 54, hold = 26
    const wrap = document.createElement('span')
    wrap.className = 'rondo-env'
    wrap.title = 'drag the handles: attack · decay/sustain · release'
    wrap.innerHTML =
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      '<path class="fill"/><path class="line" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
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

    const svg = wrap.querySelector('svg') as SVGSVGElement
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation()
      wrap.setPointerCapture(e.pointerId)
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
      const tStep = niceStep(1 / 200), sStep = 0.01
      const from = this.regionFrom
      let toPos = this.regionTo
      const fmt = (): string => [
        formatNumber(a, { step: tStep }), formatNumber(d, { step: tStep }),
        formatNumber(s, { step: sStep }), formatNumber(r, { step: tStep }),
      ].join(' ')
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
        this.drag.active = false; wrap.classList.remove('active')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        this.hooks.requestEval(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    })
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

class PianoRollWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly steps: (number | null)[],
    readonly hooks: Hooks,
    readonly drag: Drag,
  ) { super() }

  eq(o: PianoRollWidget): boolean {
    return o.from === this.from && o.steps.length === this.steps.length &&
      o.steps.every((v, i) => v === this.steps[i])
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
        cell.className = 'rc' + (steps[c] === dr ? ' on' : '')
        cell.dataset.r = String(dr)
        cell.dataset.c = String(c)
        cellEls[dr]![c] = cell
        grid.appendChild(cell)
      }
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
    const set = (r: number, c: number): void => { steps[c] = mode === 'draw' ? r : null; refresh(c); write() }
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
    const end = (): void => { painting = false; this.drag.active = false; this.hooks.requestEval(false) }
    grid.addEventListener('pointerup', end)
    grid.addEventListener('pointercancel', end)
    return grid
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
    items.push({ pos: k.defTo, deco: Decoration.widget({ widget: new KnobWidget(k.defFrom, k.value, k.lo, k.hi, k.log, hooks, drag), side: 1 }) })
  }
  for (const e of scanEnvs(text)) {
    items.push({ pos: e.to, deco: Decoration.widget({ widget: new EnvWidget(e.from, e.to, e.a, e.d, e.s, e.r, hooks, drag), side: 1 }) })
  }
  for (const p of scanPlays(text)) {
    items.push({ pos: p.to, deco: Decoration.widget({ widget: new PianoRollWidget(p.from, p.to, p.steps, hooks, drag), side: 1 }) })
  }
  items.sort((x, y) => x.pos - y.pos)
  const b = new RangeSetBuilder<Decoration>()
  for (const it of items) b.add(it.pos, it.pos, it.deco)
  return b.finish()
}

/** The rondo inline-widget extension (currently: the knob). */
export function rondoWidgets(hooks: Hooks): Extension {
  const drag: Drag = { active: false }
  return ViewPlugin.fromClass(
    class {
      decos: DecorationSet
      constructor(view: EditorView) { this.decos = build(view, hooks, drag) }
      update(u: ViewUpdate): void {
        // Keep the dragged knob's DOM stable: map our own edits through instead
        // of rebuilding (which would destroy the element mid-gesture).
        if (drag.active) { this.decos = this.decos.map(u.changes); return }
        if (u.docChanged || u.viewportChanged) this.decos = build(u.view, hooks, drag)
      }
    },
    { decorations: (v) => v.decos },
  )
}
