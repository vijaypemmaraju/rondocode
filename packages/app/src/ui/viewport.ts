/* Keep the app shell locked to the *visible* viewport — the region the mobile
 * software keyboard leaves uncovered.
 *
 * The bug this fixes: `#app { height: 100dvh }` is sized to the layout viewport,
 * which on iOS Safari (and Android Chrome) does NOT shrink when the keyboard
 * opens — only `window.visualViewport` does. So the shell stays a full screen
 * tall *behind* the keyboard, and when CodeMirror scrolls the caret into view
 * the browser scrolls the whole page up to reveal it, pushing the fixed header
 * (.topbar) off the top of the screen.
 *
 * The fix: drive the shell's height AND top offset from visualViewport, so the
 * shell is exactly the visible band. The editor then scrolls internally and the
 * caret is always already on-screen, so the browser never needs to scroll the
 * page — the header stays put. `--app-h` / `--app-top` are consumed by
 * `#app` in style.css; both have static fallbacks so non-supporting browsers
 * (and the pre-boot paint) keep the old 100dvh behaviour.
 *
 * We deliberately offset with `top`, not `transform`: a transformed ancestor
 * would become the containing block for the app's `position: fixed` overlays
 * (sheets, popovers, the shader canvas), breaking their viewport anchoring. */
export function installViewportFit(): () => void {
  const vv = window.visualViewport
  const root = document.documentElement
  if (!vv) return () => {}

  let raf = 0
  const apply = (): void => {
    raf = 0
    root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`)
    // Belt-and-braces: if the page did scroll (e.g. iOS revealed the caret
    // before our resize landed) and the keyboard is now closed, snap it back
    // so the layout viewport can't drift out from under the fixed shell.
    if (vv.offsetTop === 0 && window.scrollY !== 0) window.scrollTo(0, 0)
  }
  const onChange = (): void => {
    if (raf === 0) raf = requestAnimationFrame(apply)
  }

  vv.addEventListener('resize', onChange)
  vv.addEventListener('scroll', onChange)
  apply()

  return () => {
    vv.removeEventListener('resize', onChange)
    vv.removeEventListener('scroll', onChange)
    if (raf !== 0) cancelAnimationFrame(raf)
    root.style.removeProperty('--app-h')
    root.style.removeProperty('--app-top')
  }
}

/* Anchor a `position: fixed` popover under a header control's bottom-right edge,
 * clamped to the viewport so it never spills off-screen on short/narrow phones:
 * it flips above the anchor when there's no room below, and stays within the
 * left/right margins. Coordinates use getBoundingClientRect + innerWidth/Height,
 * the same frame `position: fixed` resolves against.
 *
 * The popover MUST be visible (not `display: none`) when this is called so its
 * size can be measured — callers remove their `.hidden` class first. */
export function anchorPopover(pop: HTMLElement, anchor: HTMLElement): void {
  const M = 6 // gap between anchor and popover
  const PAD = 8 // min gap from the viewport edges
  const vw = window.innerWidth
  const vh = window.innerHeight
  const a = anchor.getBoundingClientRect()
  const pw = pop.offsetWidth
  const ph = pop.offsetHeight

  // Prefer below the anchor; flip above when it would overflow the bottom and
  // there's room up top. Then clamp so it can't sit past either edge.
  let top = a.bottom + M
  if (top + ph > vh - PAD && a.top - M - ph >= PAD) top = a.top - M - ph
  top = Math.max(PAD, Math.min(top, vh - ph - PAD))

  // Right-anchored to the control, clamped so the left edge stays on-screen.
  let right = vw - a.right
  right = Math.max(PAD, Math.min(right, vw - pw - PAD))

  pop.style.top = `${Math.round(top)}px`
  pop.style.right = `${Math.round(right)}px`
  pop.style.left = 'auto'
}
