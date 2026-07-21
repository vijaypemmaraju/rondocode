import { javascriptLanguage } from '@codemirror/lang-javascript'
import { syntaxTree } from '@codemirror/language'
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { rmsToMeterPercent } from '../viz/mixer'

/* ------------------------------------------------------------------------- *
 * Per-synth inline meters: a tiny level bar at the END of every top-level
 * `const X = synth(...)` line, fed by engine meters events, so a performer
 * sees which instrument is doing what without leaving the code.
 *
 * NAME MAPPING: the defineSynth transform (evalCode.ts) registers each
 * top-level const/let `X = synth(...)` under its declared name, and engine
 * meters events key channels by that same name — so scanning the doc for
 * those declarations (same Lezer idiom as widgets/detect.ts, same acorn
 * semantics as transformSynthDecls: const/let only, direct synth() call)
 * yields exactly the channel names. Channels with no matching declaration
 * (agent-defined synths not in the doc) simply have no meter.
 *
 * PAINT PATH: decorations are rebuilt only on doc/tree changes (cheap Lezer
 * walk); LEVELS never touch decorations — meters events bump per-name
 * displays (attack instant), and a rAF loop mutates the widget DOM directly
 * (like the mixer strip), decaying displays exponentially (~300 ms release)
 * for readability. The loop runs ONLY while something is audible: silent
 * meters events don't start it, and it stops itself once every display has
 * decayed out, painting one final zero. Writes are skipped when the fill
 * delta is under 1% to avoid layout churn.
 * ------------------------------------------------------------------------- */

type Tree = ReturnType<typeof javascriptLanguage.parser.parse>

/** Display release time constant (ms): display = max(rms, d·e^(−dt/τ)). */
export const METER_RELEASE_MS = 300
/** A display below this is silence: the rAF loop may stop. */
const SILENCE = 0.001
/** Skip a DOM write when the fill percent moved less than this. */
const MIN_DELTA_PCT = 1
/** dt clamp — the first frame after an idle period must not mega-decay. */
const MAX_DT_MS = 100

/** One `const X = synth(...)` / `let X = synth(...)` at the top level.
 *  `at` is the offset of the `synth` callee (anchor line resolution). */
export interface SynthDecl {
  name: string
  at: number
}

/** Statement-level tokens to skip while pairing definition → initializer. */
const DECL_SKIP = new Set(['const', 'let', 'var', 'Equals', ',', ';', 'LineComment', 'BlockComment'])

/** Scan for top-level const/let declarations whose initializer is a DIRECT
 *  `synth(...)` call — mirrors transformSynthDecls in evalCode.ts, so the
 *  names found here are exactly the engine channel names. Pure; pass the
 *  editor's incremental syntaxTree to avoid a second parse. */
export function scanSynthDecls(doc: string, tree?: Tree): SynthDecl[] {
  const t = tree ?? javascriptLanguage.parser.parse(doc)
  const out: SynthDecl[] = []
  for (let stmt = t.topNode.firstChild; stmt !== null; stmt = stmt.nextSibling) {
    if (stmt.name !== 'VariableDeclaration') continue
    if (stmt.firstChild?.name === 'var') continue // var never registers
    let name: string | null = null
    for (let ch = stmt.firstChild; ch !== null; ch = ch.nextSibling) {
      if (DECL_SKIP.has(ch.name)) continue
      if (ch.name === 'VariableDefinition') {
        name = doc.slice(ch.from, ch.to)
        continue
      }
      // anything else is a declarator's initializer expression
      if (name !== null && ch.name === 'CallExpression') {
        const callee = ch.firstChild
        if (callee?.name === 'VariableName' && doc.slice(callee.from, callee.to) === 'synth') {
          out.push({ name, at: callee.from })
        }
      }
      name = null // initializer consumed
    }
  }
  return out
}

/** Where each meter widget sits: the end of the line holding the `synth(`
 *  call. Pure — headless placement tests live on this. */
export function meterAnchors(doc: string, decls: SynthDecl[]): { name: string; pos: number }[] {
  return decls.map(({ name, at }) => {
    const nl = doc.indexOf('\n', at)
    return { name, pos: nl === -1 ? doc.length : nl }
  })
}

/** Peak-hold display smoothing: attack instant, exponential release. */
export function nextDisplay(display: number, rms: number, dtMs: number): number {
  const level = Number.isFinite(rms) && rms > 0 ? rms : 0
  return Math.max(level, display * Math.exp(-dtMs / METER_RELEASE_MS))
}

/* ------------------------------- extension ------------------------------ */

export interface SynthMetersHandle {
  extension: Extension
  /** Feed one meters event's channels record (wired in mountEditor). */
  onMeters(channels: Record<string, number>): void
  /** Stop the paint loop (editor teardown). */
  dispose(): void
}

export function synthMeters(): SynthMetersHandle {
  /** Live fill elements per synth name (several decls may share a name). */
  const fills = new Map<string, Set<HTMLElement>>()
  const display = new Map<string, number>()
  const lastPct = new WeakMap<HTMLElement, number>()
  let raf: number | undefined
  let lastTick = 0
  let disposed = false

  const paint = (name: string, finalZero = false): void => {
    const els = fills.get(name)
    if (els === undefined) return
    let pct = rmsToMeterPercent(display.get(name) ?? 0)
    if (pct < MIN_DELTA_PCT || finalZero) pct = 0
    for (const el of els) {
      const prev = lastPct.get(el) ?? -1
      if (Math.abs(pct - prev) < MIN_DELTA_PCT && !(finalZero && prev !== 0)) continue
      lastPct.set(el, pct)
      el.style.width = `${pct}%`
    }
  }

  const tick = (now: number): void => {
    raf = undefined
    const dt = Math.min(MAX_DT_MS, Math.max(0, now - lastTick))
    lastTick = now
    let live = false
    for (const name of fills.keys()) {
      const d = nextDisplay(display.get(name) ?? 0, 0, dt)
      display.set(name, d)
      if (d > SILENCE) live = true
      paint(name)
    }
    if (live && !disposed) {
      raf = requestAnimationFrame(tick)
    } else {
      for (const name of fills.keys()) paint(name, true) // land on exact zero
    }
  }

  const ensureLoop = (): void => {
    if (raf !== undefined || disposed) return
    lastTick = performance.now()
    raf = requestAnimationFrame(tick)
  }

  class MeterWidget extends WidgetType {
    constructor(readonly name: string) {
      super()
    }

    override eq(other: WidgetType): boolean {
      return other instanceof MeterWidget && other.name === this.name
    }

    override toDOM(): HTMLElement {
      const track = document.createElement('span')
      track.className = 'cm-meter'
      track.setAttribute('aria-hidden', 'true')
      const fill = document.createElement('span')
      fill.className = 'cm-meter-fill'
      fill.style.width = `${rmsToMeterPercent(display.get(this.name) ?? 0)}%`
      track.append(fill)
      let set = fills.get(this.name)
      if (set === undefined) fills.set(this.name, (set = new Set()))
      set.add(fill)
      return track
    }

    override destroy(dom: HTMLElement): void {
      const fill = dom.firstElementChild
      const set = fills.get(this.name)
      if (set !== undefined && fill instanceof HTMLElement) {
        set.delete(fill)
        if (set.size === 0) fills.delete(this.name)
      }
    }

    override ignoreEvent(): boolean {
      return true
    }
  }

  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc.toString()
    const anchors = meterAnchors(doc, scanSynthDecls(doc, syntaxTree(view.state)))
    return Decoration.set(
      anchors.map(({ name, pos }) => Decoration.widget({ widget: new MeterWidget(name), side: 1 }).range(pos)),
      true,
    )
  }

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = build(view)
      }

      update(u: ViewUpdate): void {
        if (u.docChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = build(u.view)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  return {
    extension: plugin,
    onMeters(channels: Record<string, number>): void {
      if (disposed) return
      let audible = false
      for (const [name, rms] of Object.entries(channels)) {
        if (!fills.has(name)) continue // agent synths not in the doc: no meter
        const d = nextDisplay(display.get(name) ?? 0, rms, 0)
        display.set(name, d)
        if (d > SILENCE) audible = true
      }
      // silent heartbeats (meters flow whenever audio runs) must not spin rAF
      if (audible) ensureLoop()
    },
    dispose(): void {
      disposed = true
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = undefined
    },
  }
}
