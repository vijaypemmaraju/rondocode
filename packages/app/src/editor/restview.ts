/* The CodeMirror half of rest highlighting — kept apart from rests.ts so the
 * span arithmetic stays testable without an editor. */

import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { litRestRanges } from './rests'
import type { RestSource, RestSpan } from './rests'

const restMark = Decoration.mark({ class: 'cm-rest-lit' })

/**
 * Light the rest the playhead is inside, in whichever language.
 *
 * The loop runs every frame but only DISPATCHES when the lit set changes — a
 * rest lasts many frames, and repainting an unchanged decoration set every one
 * of them is the cost that has bitten this editor before.
 */
export function restHighlight(src: RestSource): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none
      private raf = 0
      private readonly cache = new Map<string, RestSpan[]>()
      private last = ''

      constructor(private readonly view: EditorView) {
        const frame = (): void => {
          this.raf = requestAnimationFrame(frame)
          let ranges: { from: number; to: number }[]
          try {
            ranges = litRestRanges(src, this.cache)
          } catch {
            return // a highlight must never take the editor down
          }
          const key = ranges.map((r) => `${r.from}:${r.to}`).join(',')
          if (key === this.last) return
          this.last = key
          const b = new RangeSetBuilder<Decoration>()
          const len = this.view.state.doc.length
          for (const r of ranges) if (r.to <= len) b.add(r.from, r.to, restMark)
          this.decorations = b.finish()
          this.view.dispatch({}) // empty transaction → redraw with the new set
        }
        this.raf = requestAnimationFrame(frame)
      }

      destroy(): void {
        cancelAnimationFrame(this.raf)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
