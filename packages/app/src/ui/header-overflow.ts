import { iconEl } from './icons'
import { tooltip } from './tooltip'
import { anchorPopover } from './viewport'

/* The header gained enough tools to overflow a phone row. On narrow screens
 * this moves the SECONDARY controls (everything except run + stop) into a "⋯"
 * popover, and moves them back on wider screens. Run and stop always stay in
 * the bar; the recording pill (a status indicator) stays too. Call once, after
 * every module has added its header button. */
export function mountHeaderOverflow(topbar: HTMLElement): () => void {
  const controls = topbar.querySelector('.hdr-controls') as HTMLElement | null
  if (!controls) return () => {}

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'btn more-btn'
  more.append(iconEl('dots'))
  tooltip(more, 'more')

  const pop = document.createElement('div')
  pop.className = 'more-pop hidden'
  document.body.append(pop)

  const isPrimary = (elm: Element): boolean =>
    elm.classList.contains('run') ||
    elm.classList.contains('stop-btn') ||
    elm.classList.contains('rec-pill') ||
    elm === more

  // snapshot the secondary controls in their current (desktop) left-to-right order
  const secondary = Array.from(controls.children).filter((c) => !isPrimary(c)) as HTMLElement[]
  controls.insertBefore(more, controls.firstChild) // ⋯ first, so run/stop stay rightmost

  let open = false
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
  }
  const openPop = (): void => {
    pop.classList.remove('hidden') // visible first so anchorPopover can measure it
    anchorPopover(pop, more)
    open = true
  }
  more.addEventListener('click', () => (open ? close() : openPop()))
  // picking anything inside closes the menu (so a sheet/panel behind it shows)
  pop.addEventListener('click', (e) => {
    if ((e.target as Element).closest('button')) close()
  })

  const mq = window.matchMedia('(max-width: 560px)')
  const sync = (): void => {
    if (mq.matches) {
      for (const c of secondary) pop.append(c) // relocate (order preserved)
    } else {
      let ref: Element = more
      for (const c of secondary) {
        controls.insertBefore(c, ref.nextSibling)
        ref = c
      }
      close()
    }
  }
  sync()
  const onChange = (): void => sync()
  mq.addEventListener('change', onChange)

  const onDocClick = (e: MouseEvent): void => {
    if (!open) return
    const t = e.target as Node
    if (pop.contains(t) || more.contains(t)) return
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === 'Escape') close()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)

  return () => {
    mq.removeEventListener('change', onChange)
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    pop.remove()
    more.remove()
  }
}
