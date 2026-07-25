/* Performance lock: freeze the TEXT, keep every widget live.
 *
 * Mid-jam on a phone, an accidental tap in the code places a caret and opens
 * the on-screen keyboard right over the knob you were reaching for. The lock
 * turns off `EditorView.editable` (contenteditable), so taps can't focus the
 * buffer or summon the keyboard, while everything programmatic keeps working:
 * widget rewrites, number scrubs, undo/redo chips, example loads, live evals.
 *
 * Deliberately NOT `EditorState.readOnly`: that facet makes history commands
 * refuse, which would kill the undo/redo chips. The threat model is stray
 * fingers on glass, not programmatic edits - editable(false) blocks exactly
 * the former and none of the latter. */

import type { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** The contents of the lock compartment for a given lock state. */
export function lockExtension(locked: boolean): Extension {
  return locked ? EditorView.editable.of(false) : []
}

/** True when the buffer is performance-locked (not user-editable). */
export function isLocked(state: EditorState): boolean {
  return !state.facet(EditorView.editable)
}
