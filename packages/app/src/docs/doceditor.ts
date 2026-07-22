import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SchedulerEvent } from '@rondocode/pattern'
import { EventFlasher } from '../editor/flash'
import { karaokeExtension, mountKaraoke } from '../editor/karaoke'
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
  /** True if a `sound` control names a sing() vocal — lets karaoke light the
   *  syllable/note even when sing(..., { name }) renames off the singv-hash.
   *  Omitted → the built-in singv-prefix default. */
  isSingSound?: (sound: string) => boolean,
): DocEditor {
  let lastGood = doc
  // Karaoke needs to know when THIS block is the one playing, get its events,
  // and re-parse on edits — all pushed in from the docs page via flash()/
  // markPlaying()/the update listener, mirrored to these tiny fanouts.
  let playing = false
  const kEvSubs = new Set<(evs: SchedulerEvent[]) => void>()
  const kDocSubs = new Set<(code: string) => void>()
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
        karaokeExtension, // sing() syllable/note highlight while a vocal plays
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          onDocChange?.()
          const code = u.state.doc.toString()
          for (const fn of kDocSubs) fn(code)
        }),
      ],
    }),
  })

  // Flash only maps cleanly while the doc matches the last evaluated source;
  // once edited it's "dirty" and the flasher skips until the next play.
  const flasher = new EventFlasher(view, now, () => view.state.doc.toString() !== lastGood)

  // Karaoke: same events as the flasher, the shared audio clock, and a
  // per-block "is this the one playing" flag so only the active snippet lights.
  const disposeKaraoke = mountKaraoke(view, {
    audio: {
      get currentTime(): number {
        return now()
      },
    },
    isPlaying: () => playing,
    subscribeEvents: (fn) => {
      kEvSubs.add(fn)
      return () => kEvSubs.delete(fn)
    },
    getDoc: () => view.state.doc.toString(),
    onDoc: (fn) => {
      kDocSubs.add(fn)
      return () => kDocSubs.delete(fn)
    },
    ...(isSingSound ? { isSingSound } : {}),
  })

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    flash: (evs) => {
      flasher.onEvents(evs)
      for (const fn of kEvSubs) fn(evs)
    },
    markPlaying: (source) => {
      lastGood = source
      playing = true
      flasher.onGoodEval(source)
    },
    stopFlashes: () => {
      playing = false
      flasher.clearPending()
    },
    destroy: () => {
      disposeKaraoke()
      flasher.dispose()
      view.destroy()
    },
  }
}
