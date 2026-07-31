/* ------------------------------------------------------------------------- *
 * Canvas widgets and the colour they are supposed to be.
 *
 * A canvas cannot use `currentColor`, so these widgets read their ink out of
 * the cascade with getComputedStyle and hand it to the 2D context. That works
 * only on an element the document knows about: getComputedStyle on a DETACHED
 * node returns INITIAL values, and `color`'s initial value is black.
 *
 * CodeMirror's toDOM() builds a widget before inserting it, so a widget that
 * paints in toDOM paints black — and then keeps it, because nothing redraws a
 * curve nobody touches. That is the whole of the "svf curve is black on grey"
 * report: the CSS said `color: var(--c-accent)` and was never consulted.
 *
 * Two pieces, because there are two halves to the problem: choose the ink
 * defensibly, and repaint once the node is actually in the tree. Both halves
 * are pure functions with the DOM read at the edge, so the rules are testable
 * without a browser — the same split every scanner in this directory uses.
 * ------------------------------------------------------------------------- */

/** Fallback ink, matching the `var(--c-accent, …)` fallbacks in rondo-ui.css. */
export const FALLBACK_INK = '#6ea8fe'

/**
 * Which colour to believe.
 *
 * Connected: whatever the cascade says, which is what lets `.active` (and any
 * future themed state) recolour a curve for free — including a theme that
 * genuinely wants black. Detached: the computed value is not an answer at all,
 * it is the initial value, so fall back to the palette.
 */
export function pickInk(connected: boolean, computed: string, paletteAccent: string): string {
  if (connected && computed !== '') return computed
  const accent = paletteAccent.trim()
  return accent === '' ? FALLBACK_INK : accent
}

/** The colour to paint `el` in. The DOM read; the rule is pickInk. */
export function inkOf(el: Element): string {
  const palette = getComputedStyle(document.documentElement).getPropertyValue('--c-accent')
  return pickInk(el.isConnected, el.isConnected ? getComputedStyle(el).color : '', palette)
}

/**
 * Paint now, and again as soon as the node is in the document.
 *
 * The immediate call means no empty frame; the second picks up the real
 * cascade. Both are needed — dropping the first flashes blank on every scroll
 * that rebuilds decorations, and dropping the second is the bug.
 *
 * `raf` is injectable so the sequencing is testable, and optional so a caller
 * without one still gets its first paint rather than an exception.
 */
export function paintOnAttach(
  draw: () => void,
  raf: ((cb: () => void) => unknown) | undefined = globalThis.requestAnimationFrame,
): void {
  draw()
  if (typeof raf === 'function') raf(() => draw())
}
