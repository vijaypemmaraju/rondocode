import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/* ------------------------------------------------------------------------- *
 * Per-synth inline SCOPE: a live trace of each synth's own output, drawn at
 * the end of its `synth NAME` header line.
 *
 * The inline meter already says HOW LOUD a synth is, which is the one question
 * a single bar can answer. It cannot say whether the attack is too slow, where
 * the gate actually ends, whether the sidechain is pumping this channel, or
 * whether a patch is clipping into the strip — all of which are shape, and all
 * of which you would otherwise go and render a file to see.
 *
 * WHAT IT DRAWS. Not raw audio: the engine sends one SIGNED PEAK per processed
 * block (see SCOPE_POINTS in realtime.ts), so this is an envelope that kept its
 * polarity. At ~2.7ms a point, 64 points is ~170ms — an attack, a gate, a
 * couple of kick ducks. Individual cycles of a high note are not resolvable at
 * this size, and sending raw samples to pretend otherwise would cost about
 * sixty times the bandwidth to draw the same picture.
 *
 * SCALE. The same linear ×1.6 the mixer meters use, so a synth that reads
 * half-way up its meter draws half-way up its scope. Auto-gaining each trace
 * to fill the box would make silence look like a performance, which is the one
 * thing a level display must never do.
 * ------------------------------------------------------------------------- */

/** Drawn size, in px. Narrow enough to sit after a header without pushing the
 *  line around, tall enough for polarity to read. */
export const SCOPE_W = 88
export const SCOPE_H = 14
/** Matches `rmsToMeterPercent` (rms * 160, clamped): scope and meter agree. */
export const SCOPE_GAIN = 1.6

/**
 * An SVG polygon `points` attribute for one trace: a filled band, mirrored
 * about the centre line, in a SCOPE_W by SCOPE_H box.
 *
 * MIRRORED, not signed. The first version drew the signed peak as a line, and
 * in a browser it read as noise: at ~2.7ms a point the polarity of a peak
 * alternates essentially at random, so a saw and a sine both came out as a
 * thin zigzag. Magnitude mirrored above and below is what a waveform overview
 * looks like in every DAW, for the same reason — at this zoom the envelope is
 * the signal and the sign is not information you can read.
 *
 * Pure, so the mapping is testable without a DOM: the interesting parts are
 * that silence is a flat centre line rather than an empty string, and that a
 * signal past full scale CLAMPS to the box instead of drawing outside it.
 */
export function scopePoints(trace: ArrayLike<number>, w = SCOPE_W, h = SCOPE_H): string {
  const n = trace.length
  const mid = h / 2
  if (n === 0) return `0,${mid} ${w},${mid}`
  const xs: number[] = []
  const mags: number[] = []
  for (let i = 0; i < n; i++) {
    const raw = trace[i]!
    const v = Number.isFinite(raw) ? raw * SCOPE_GAIN : 0
    const a = v < 0 ? -v : v
    mags.push(a > 1 ? 1 : a)
    xs.push(n === 1 ? w / 2 : (i / (n - 1)) * w)
  }
  const up: string[] = []
  const down: string[] = []
  for (let i = 0; i < n; i++) {
    const x = xs[i]!.toFixed(1)
    const d = mags[i]! * mid
    // y grows downward in SVG, so the louder edge is FURTHER from the centre
    up.push(`${x},${(mid - d).toFixed(2)}`)
    down.push(`${x},${(mid + d).toFixed(2)}`)
  }
  return `${up.join(' ')} ${down.reverse().join(' ')}`
}

/** True when a trace has nothing worth drawing — used to skip DOM writes. */
export function scopeSilent(trace: ArrayLike<number>, eps = 1e-4): boolean {
  for (let i = 0; i < trace.length; i++) {
    const v = trace[i]!
    if (v > eps || v < -eps) return false
  }
  return true
}

/** Every `synth NAME` header in a rondo doc, with the offset of its line END
 *  (where the scope hangs). Comment lines are skipped: a synth named inside a
 *  `#` comment is not a synth. Pure — unit tested. */
export function scopeAnchors(text: string): { name: string; pos: number }[] {
  const out: { name: string; pos: number }[] = []
  let off = 0
  for (const raw of text.split('\n')) {
    const cm = /(^|\s)#/.exec(raw)
    const code = cm === null ? raw : raw.slice(0, cm.index + (cm[1] ?? '').length)
    const m = /^synth[ \t]+([a-zA-Z_]\w*)/.exec(code)
    if (m !== null) out.push({ name: m[1]!, pos: off + code.replace(/\s+$/, '').length })
    off += raw.length + 1
  }
  return out
}

export interface SynthScopesHandle {
  extension: Extension
  /** Feed a meters event's `scopes` payload. */
  update(scopes: Record<string, ArrayLike<number>> | undefined): void
  dispose(): void
}

/**
 * Inline per-synth scopes.
 *
 * PAINT PATH mirrors the meters': decorations are rebuilt only on doc changes,
 * and traces never touch decorations — a meters event writes the `points`
 * attribute of the live polylines directly. There is no rAF loop and no decay,
 * because unlike a level meter the trace is already a history: it scrolls
 * itself, and the last frame before silence is the correct thing to leave on
 * screen.
 */
export function synthScopes(): SynthScopesHandle {
  /** Live polyline elements per synth name (a name can appear once, but a
   *  redefine mid-edit can briefly produce two). */
  const lines = new Map<string, Set<SVGPolygonElement>>()
  const last = new Map<string, string>()
  let disposed = false

  const paint = (name: string, pts: string): void => {
    const els = lines.get(name)
    if (els === undefined || els.size === 0) return
    if (last.get(name) === pts) return // nothing moved; skip the DOM write
    last.set(name, pts)
    for (const el of els) el.setAttribute('points', pts)
  }

  class ScopeWidget extends WidgetType {
    constructor(readonly name: string) {
      super()
    }

    override eq(other: WidgetType): boolean {
      return other instanceof ScopeWidget && other.name === this.name
    }

    override toDOM(): HTMLElement {
      const box = document.createElement('span')
      box.className = 'cm-scope'
      box.setAttribute('aria-hidden', 'true')
      box.title = `${this.name}: live output`
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', `0 0 ${SCOPE_W} ${SCOPE_H}`)
      svg.setAttribute('width', String(SCOPE_W))
      svg.setAttribute('height', String(SCOPE_H))
      const zero = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      zero.setAttribute('class', 'cm-scope-zero')
      zero.setAttribute('x1', '0')
      zero.setAttribute('x2', String(SCOPE_W))
      zero.setAttribute('y1', String(SCOPE_H / 2))
      zero.setAttribute('y2', String(SCOPE_H / 2))
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      line.setAttribute('class', 'cm-scope-trace')
      line.setAttribute('points', last.get(this.name) ?? scopePoints([]))
      svg.append(zero, line)
      box.append(svg)
      let set = lines.get(this.name)
      if (set === undefined) lines.set(this.name, (set = new Set()))
      set.add(line)
      return box
    }

    override destroy(dom: HTMLElement): void {
      const el = dom.querySelector('polygon')
      const set = lines.get(this.name)
      if (set !== undefined && el instanceof SVGPolygonElement) {
        set.delete(el)
        if (set.size === 0) lines.delete(this.name)
      }
    }

    override ignoreEvent(): boolean {
      return true
    }
  }

  const build = (view: EditorView): DecorationSet =>
    Decoration.set(
      scopeAnchors(view.state.doc.toString()).map(({ name, pos }) =>
        Decoration.widget({ widget: new ScopeWidget(name), side: 1 }).range(pos)),
      true,
    )

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = build(view)
      }

      update(u: ViewUpdate): void {
        if (u.docChanged) this.decorations = build(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )

  return {
    extension: plugin,
    update(scopes) {
      if (disposed || scopes === undefined) return
      for (const name of lines.keys()) {
        const t = scopes[name]
        if (t === undefined) continue
        paint(name, scopePoints(t))
      }
    },
    dispose() {
      disposed = true
      lines.clear()
      last.clear()
    },
  }
}
