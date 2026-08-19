/* ------------------------------------------------------------------------- *
 * SCROLL-SPY: which nav link is lit.
 *
 * The spy watches a BAND across the top of the viewport and lights the nav
 * link for the section inside it. Two things about that band decide whether it
 * agrees with what the reader sees, and the first version got both wrong.
 *
 * WHERE THE BAND STARTS. Clicking a nav link jumps to a section, and `html`'s
 * `scroll-padding-top` decides where it lands: below both sticky bars, at
 * 116px as measured. The spy had its own hard-coded `-72px` — SMALLER — so
 * after a jump the strip between 72px and the landing point held the TAIL OF
 * THE PREVIOUS SECTION, still inside the band, still a candidate. Click
 * `recipe-one-knob` and the link above it lights up. The fix is to stop
 * keeping a second copy of the number: read it from the scroller, so the band
 * starts exactly where a click lands.
 *
 * WHICH ONE WINS WHEN SEVERAL ARE IN IT. The band is tall enough to hold two
 * sections at once, and the first version lit whichever entry came LAST in the
 * callback — an order IntersectionObserver does not promise and which, on a
 * jump, is usually the section that just moved. Worse, a callback only reports
 * what CHANGED, so a section already in the band is absent from the entries
 * and cannot win at all.
 *
 * Both are fixed by keeping the intersecting set and choosing from it by
 * DOCUMENT ORDER: the topmost section in the band is the one being read.
 * ------------------------------------------------------------------------- */

/** The nav link to light: topmost section in the band, in document order.
 *  `undefined` when the band is empty, which means "keep what is lit" — that
 *  happens above the first section and below the last, where changing the
 *  highlight would be a guess. */
export function topmostVisible(order: readonly string[], visible: ReadonlySet<string>): string | undefined {
  return order.find((id) => visible.has(id))
}

/** Where the band starts, in px: exactly where a clicked section comes to
 *  rest. Read from the SCROLLER's `scroll-padding-top`, which is the one place
 *  that offset is declared (docs.css sets it on `html`), so it cannot drift
 *  from the CSS the way a hard-coded number did.
 *
 *  Deliberately not `scroll-margin-top` on the section: scroll-padding and
 *  scroll-margin ADD, so declaring it in both places lands anchors at twice
 *  the offset — which is its own version of this same bug. */
export function bandTop(scroller: Element | null, fallback = 96): number {
  if (scroller === null) return fallback
  const px = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop)
  return Number.isFinite(px) && px > 0 ? Math.round(px) : fallback
}

/** Update the intersecting set from a batch of observer entries. Entries only
 *  ever describe CHANGES, so this accumulates rather than replaces. */
export function applyEntries(visible: Set<string>, entries: readonly IntersectionObserverEntry[]): void {
  for (const e of entries) {
    const id = (e.target as HTMLElement).id
    if (e.isIntersecting) visible.add(id)
    else visible.delete(id)
  }
}
