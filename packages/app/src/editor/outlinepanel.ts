import { EditorView } from '@codemirror/view'
import { filterOutline, outlineOf } from './outline'
import type { OutlineItem } from './outline'
import { iconEl } from '../ui/icons'
import { tooltip } from '../ui/tooltip'

/* ------------------------------------------------------------------------- *
 * The outline panel: jump to anything in this document.
 *
 * Opened from the header or with Cmd/Ctrl-O, filtered by typing, and every
 * row scrolls its target to the middle of the view rather than the top — a
 * jump that leaves the thing you asked for on the first line puts its body
 * off-screen, which is the opposite of what you wanted it for.
 *
 * Rebuilt on OPEN, not on every keystroke: it is a snapshot of a document you
 * are about to move around in, and re-scanning 472 lines per character typed
 * into the editor would be work nobody asked for.
 * ------------------------------------------------------------------------- */

export interface OutlineHost {
  view: EditorView
  topbar: HTMLElement
  getLang: () => 'rondo' | 'rondocode'
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** Mount the outline. Returns a disposer. */
export function mountOutline(host: OutlineHost): () => void {
  const backdrop = el('div', 'outline-backdrop hidden')
  const sheet = el('div', 'outline-sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-label', 'outline')
  const search = el('input', 'outline-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'jump to…'
  search.setAttribute('aria-label', 'filter the outline')
  const list = el('div', 'outline-list')
  const empty = el('div', 'outline-empty', 'nothing to jump to yet')
  sheet.append(search, list, empty)
  backdrop.append(sheet)
  document.body.append(backdrop)

  let items: OutlineItem[] = []

  const jump = (it: OutlineItem): void => {
    const { view } = host
    // clamp: the document may have changed since the panel opened
    const pos = Math.min(it.from, view.state.doc.length)
    view.dispatch({
      selection: { anchor: pos },
      // 'center', not 'start': landing the header on the top line puts its
      // body off-screen, which is the opposite of why anyone jumped to it
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    close()
    view.focus()
  }

  const render = (): void => {
    const rows = filterOutline(items, search.value)
    list.replaceChildren()
    empty.hidden = rows.length > 0
    if (rows.length === 0) {
      empty.textContent = items.length === 0 ? 'nothing to jump to yet' : 'nothing matches'
      return
    }
    for (const it of rows) {
      const row = el('button', `outline-row d${it.depth}`)
      row.type = 'button'
      row.append(el('span', `outline-kind k-${it.kind}`, it.kind), el('span', 'outline-name', it.name))
      row.append(el('span', 'outline-line', String(it.line)))
      row.addEventListener('click', () => jump(it))
      list.append(row)
    }
  }

  function open(): void {
    items = outlineOf(host.view.state.doc.toString(), host.getLang())
    search.value = ''
    render()
    backdrop.classList.remove('hidden')
    btn.setAttribute('aria-expanded', 'true')
    search.focus()
  }
  function close(): void {
    backdrop.classList.add('hidden')
    btn.setAttribute('aria-expanded', 'false')
  }
  const toggle = (): void => {
    if (backdrop.classList.contains('hidden')) open()
    else close()
  }

  const btn = el('button', 'btn outline-btn')
  btn.type = 'button'
  btn.setAttribute('aria-expanded', 'false')
  btn.append(iconEl('dots'), el('span', 'btn-label', 'outline'))
  tooltip(btn, 'outline (Cmd/Ctrl+O)')
  btn.addEventListener('click', toggle)
  const controls = host.topbar.querySelector('.hdr-controls') ?? host.topbar
  controls.insertBefore(btn, controls.firstChild)

  search.addEventListener('input', render)
  // Enter takes the first row: type three letters and go, without reaching
  // for the pointer
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const first = filterOutline(items, search.value)[0]
    if (first !== undefined) jump(first)
  })
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) {
      close()
      host.view.focus()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault() // the browser's "open file", which is never wanted here
      toggle()
    }
  }
  document.addEventListener('keydown', onKey)

  return () => {
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    btn.remove()
  }
}
