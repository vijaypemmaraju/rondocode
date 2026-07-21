import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SchedulerEvent } from '@rondocode/pattern'
import { EventFlasher } from '../editor/flash'
import { codeEditingExtensions } from '../editor/setup'

/* ------------------------------------------------------------------------- *
 * A small, self-contained CodeMirror editor for a docs example: the same
 * syntax highlighting and phosphor theme as the main editor, editable, and
 * wired for the flash decoration that lights mini-notation atoms as they
 * fire. It carries its own EventFlasher; the docs page points the shared
 * PreviewPlayer's events at whichever editor is currently playing.
 *
 * It also carries the full editor affordances so an example behaves like the
 * real thing: WGSL syntax highlighting inside visual(`…`) templates, the
 * slider/toggle/pick/xy inline widgets, and drag-to-scrub on any number.
 * A widget/scrub edit rewrites the doc and calls `requestEval` — the docs
 * page hot-patches the snippet live when it is the one currently playing.
 * ------------------------------------------------------------------------- */

export interface DocEditor {
  view: EditorView
  getDoc(): string
  /** Feed scheduler events to the flasher (call while this block plays). */
  flash(evs: SchedulerEvent[]): void
  /** Register the source that was just evaluated so locs map correctly. */
  markPlaying(source: string): void
  /** Cancel pending flashes (on stop / when another block takes over). */
  stopFlashes(): void
  destroy(): void
}

export function createDocEditor(
  parent: HTMLElement,
  doc: string,
  now: () => number,
  onDocChange?: () => void,
  /** A widget/scrub rewrote the doc — re-eval the snippet. `immediate` for
   *  discrete changes (toggle/pick), false for debounced drags. */
  requestEval?: (immediate: boolean) => void,
): DocEditor {
  let lastGood = doc
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        // The exact editing stack the main editor uses (widgets, WGSL, DSL
        // intellisense, multicursor…) — one shared source so the two never
        // drift. `gutter: false` drops line numbers so small snippets stay
        // clean; every interactive feature is identical to the editor.
        ...codeEditingExtensions({ requestEval: (imm) => requestEval?.(imm), gutter: false }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onDocChange?.()
        }),
      ],
    }),
  })

  // Flash only maps cleanly while the doc matches the last evaluated source;
  // once edited it's "dirty" and the flasher skips until the next play.
  const flasher = new EventFlasher(view, now, () => view.state.doc.toString() !== lastGood)

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    flash: (evs) => flasher.onEvents(evs),
    markPlaying: (source) => {
      lastGood = source
      flasher.onGoodEval(source)
    },
    stopFlashes: () => flasher.clearPending(),
    destroy: () => {
      flasher.dispose()
      view.destroy()
    },
  }
}
