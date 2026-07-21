import { iconEl } from './icons'
import { tooltip } from './tooltip'
import { SETTING_META, getSetting, setSetting, onSettingsChange } from './settings'
import type { Settings } from './settings'
import type { EditorHandle } from '../editor/editor'

/* ------------------------------------------------------------------------- *
 * The Options panel: a header gear button that opens an anchored popover of
 * user preferences (ui/settings.ts). Each boolean setting renders as a labelled
 * toggle; the list is driven by SETTING_META, so adding a setting there adds a
 * row here automatically. Same anchored-popover mechanics as the samples/export
 * popovers (fixed box under the button, outside-click / Escape to dismiss).
 * ------------------------------------------------------------------------- */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const BOOL_KEYS = (Object.keys(SETTING_META) as (keyof Settings)[]).filter((k) => typeof getSetting(k) === 'boolean')

/** Mount the Options panel on the editor's header. Returns a disposer. */
export function mountOptions(editor: EditorHandle): () => void {
  const btn = el('button', 'btn options-btn')
  btn.type = 'button'
  btn.append(iconEl('gear'), el('span', 'btn-label', 'options'))
  btn.setAttribute('aria-expanded', 'false')
  tooltip(btn, 'options')
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(btn, controls.firstChild)

  const pop = el('div', 'options-pop hidden')
  pop.append(el('div', 'options-head', 'options'))
  document.body.append(pop)

  // One toggle row per boolean setting, kept in sync with the store.
  const rows = new Map<keyof Settings, HTMLButtonElement>()
  for (const key of BOOL_KEYS) {
    const meta = SETTING_META[key]
    const row = el('button', 'opt-row')
    row.type = 'button'
    const text = el('div', 'opt-text')
    text.append(el('div', 'opt-label', meta.label), el('div', 'opt-help', meta.help))
    const sw = el('span', 'opt-switch')
    row.append(text, sw)
    const reflect = (): void => {
      const on = getSetting(key) === true
      row.classList.toggle('on', on)
      row.setAttribute('aria-checked', String(on))
    }
    row.setAttribute('role', 'switch')
    reflect()
    row.addEventListener('click', () => setSetting(key, !(getSetting(key) as boolean) as Settings[typeof key]))
    rows.set(key, row)
    pop.append(row)
  }

  // Reflect external changes (another surface, or a future keybinding).
  const offSettings = onSettingsChange(() => {
    for (const [key, row] of rows) {
      const on = getSetting(key) === true
      row.classList.toggle('on', on)
      row.setAttribute('aria-checked', String(on))
    }
  })

  let open = false
  const position = (): void => {
    const r = btn.getBoundingClientRect()
    pop.style.top = `${Math.round(r.bottom + 6)}px`
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`
  }
  const openPop = (): void => {
    position()
    pop.classList.remove('hidden')
    open = true
    btn.setAttribute('aria-expanded', 'true')
    btn.classList.add('active')
  }
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
    btn.setAttribute('aria-expanded', 'false')
    btn.classList.remove('active')
  }
  btn.addEventListener('click', () => (open ? close() : openPop()))

  const onDocClick = (e: MouseEvent): void => {
    if (!open) return
    const t = e.target as Node
    if (pop.contains(t) || btn.contains(t)) return
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === 'Escape') close()
  }
  const onResize = (): void => {
    if (open) position()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)

  return () => {
    offSettings()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    pop.remove()
    btn.remove()
  }
}
