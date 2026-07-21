import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import type { SchedulerEvent } from '@rondocode/pattern'
import { synthTheme } from '../editor/theme'
import { flashExtension, EventFlasher } from '../editor/flash'

/* ------------------------------------------------------------------------- *
 * A small, self-contained CodeMirror editor for a docs example: the same
 * syntax highlighting and phosphor theme as the main editor, editable, and
 * wired for the flash decoration that lights mini-notation atoms as they
 * fire. It carries its own EventFlasher; the docs page points the shared
 * PreviewPlayer's events at whichever editor is currently playing.
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
): DocEditor {
  let lastGood = doc
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        javascript(), // the grammar the HighlightStyle colors
        synthTheme, // theme chrome + syntaxHighlighting
        flashExtension, // renders .cm-flash decorations
        EditorView.lineWrapping,
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
