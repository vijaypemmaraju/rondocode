/* A single shared, styled tooltip that replaces native `title` attributes
 * (which are slow to appear, unstyled, and inconsistent across browsers).
 * tooltip(el, text) also sets aria-label, so the element keeps an accessible
 * name for screen readers — the visual tip is decorative (aria-hidden). */

let tip: HTMLDivElement | null = null
let showTimer: number | undefined
const labels = new WeakMap<HTMLElement, string>()

function ensure(): HTMLDivElement {
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'tooltip'
    tip.setAttribute('aria-hidden', 'true')
    document.body.appendChild(tip)
  }
  return tip
}

function show(el: HTMLElement): void {
  const label = labels.get(el)
  if (!label || !el.isConnected) return
  const t = ensure()
  t.textContent = label
  t.classList.add('visible')
  // Place below, centered on the target, clamped to the viewport. Measure
  // AFTER the text is set: these tips wrap, so height depends on the content.
  const r = el.getBoundingClientRect()
  const w = t.offsetWidth
  const h = t.offsetHeight
  const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6))
  // below by default; flip above when there is no room down there
  const below = r.bottom + 6
  const top = below + h > window.innerHeight - 6 ? Math.max(6, r.top - h - 6) : below
  t.style.left = `${Math.round(left)}px`
  t.style.top = `${Math.round(top)}px`
}

function hide(): void {
  clearTimeout(showTimer)
  if (tip) tip.classList.remove('visible')
}

/** Attach (or update) a tooltip on an element. Safe to call repeatedly to
 *  change the text (e.g. a button whose label toggles). */
export function tooltip(el: HTMLElement, label: string): void {
  const isNew = !labels.has(el)
  labels.set(el, label)
  el.setAttribute('aria-label', label)
  if (!isNew) return
  el.addEventListener('mouseenter', () => {
    clearTimeout(showTimer)
    showTimer = window.setTimeout(() => show(el), 350)
  })
  el.addEventListener('mouseleave', hide)
  el.addEventListener('focus', () => {
    // only on keyboard focus, so a mouse click doesn't leave a tip lingering
    if (el.matches(':focus-visible')) show(el)
  })
  el.addEventListener('blur', hide)
  el.addEventListener('mousedown', hide) // don't linger after activation
}

// dismiss on scroll / Escape so a stale tip never floats (guarded so importing
// this module in a non-DOM/test environment doesn't touch window at load)
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', hide, true)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide()
  })
}
