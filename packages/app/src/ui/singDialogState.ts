/* ------------------------------------------------------------------------- *
 * The bake dialog's visible mode, as a pure transition table.
 *
 * The rules used to live spread across three DOM listeners, where the awkward
 * ones are easy to get wrong and impossible to test in a suite with no DOM:
 *   - an error must OUTLIVE the "idle" progress event that follows the failed
 *     bake, or the card vanishes the instant it appears;
 *   - Escape belongs to the editor unless an error is actually showing;
 *   - dismissing early must cancel the auto-dismiss backstop, or a stale timer
 *     hides the NEXT error a moment after it appears.
 * singDialog.ts owns the pixels; this owns the decisions.
 * ------------------------------------------------------------------------- */

export type SingDialogMode = 'hidden' | 'baking' | 'error'

export type SingDialogEvent =
  /** A bake failed. */
  | { kind: 'error' }
  /** Bake progress arrived. */
  | { kind: 'progress' }
  /** Progress went null: nothing is baking. */
  | { kind: 'idle' }
  /** The close button. */
  | { kind: 'dismiss' }
  /** Escape pressed anywhere in the document. */
  | { kind: 'escape' }
  /** The auto-dismiss backstop fired. */
  | { kind: 'timeout' }

export interface SingDialogNext {
  mode: SingDialogMode
  /** Cancel any pending auto-dismiss. */
  clearTimer: boolean
  /** Arm the auto-dismiss backstop for this many ms (0 = none). */
  armTimer: number
  /** True when the event was consumed — Escape uses this to decide whether the
   *  editor still gets to see it. */
  handled: boolean
}

/** How long a failed bake stays up on its own. Long enough to read a 140-char
 *  message and copy it; short enough that a missed error does not sit over the
 *  editor forever (the card is dismissable, so this is only a backstop). */
export const ERROR_DISMISS_MS = 30_000

export function singDialogNext(mode: SingDialogMode, ev: SingDialogEvent): SingDialogNext {
  const to = (m: SingDialogMode, clearTimer = true, armTimer = 0): SingDialogNext => ({
    mode: m,
    clearTimer,
    armTimer,
    handled: true,
  })
  switch (ev.kind) {
    case 'error':
      return to('error', true, ERROR_DISMISS_MS)
    case 'progress':
      return to('baking')
    case 'idle':
      // a failed bake reports idle right after failing: keep the error up
      return mode === 'error'
        ? { mode: 'error', clearTimer: false, armTimer: 0, handled: false }
        : to('hidden')
    case 'dismiss':
    case 'timeout':
      return to('hidden')
    case 'escape':
      return mode === 'error'
        ? to('hidden')
        : { mode, clearTimer: false, armTimer: 0, handled: false }
  }
}
