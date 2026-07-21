import type { EditorHandle } from './editor'
import { icon, iconEl } from '../ui/icons'
import { overlayClosed, overlayOpened } from '../ui/overlays'
import { DSL_DOCS } from '../docs/dsl-docs'
import type { DocEntry } from '../docs/dsl-docs'

/* ------------------------------------------------------------------------- *
 * In-app DSL reference: a "?" button opens a searchable panel generated from
 * the same dsl-docs data that drives hover + intellisense — one source of
 * truth, so the reference can never drift from the actual vocabulary.
 * ------------------------------------------------------------------------- */

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const GROUPS: { title: string; kinds: DocEntry['kind'][] }[] = [
  { title: 'globals', kinds: ['global'] },
  { title: 'pattern methods', kinds: ['pattern-method'] },
  { title: 'synth builder', kinds: ['synth-ctx', 'sig-method'] },
  { title: 'mini-notation', kinds: ['mini-syntax'] },
]

export interface DocsHandle {
  dispose(): void
}

export function mountDocs(editor: EditorHandle): DocsHandle {
  const btn = el('button', 'btn docs-btn')
  btn.type = 'button'
  btn.innerHTML = icon('help')
  btn.title = 'DSL reference'
  btn.setAttribute('aria-expanded', 'false')
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(btn, controls.firstChild)

  const backdrop = el('div', 'sheet-backdrop hidden')
  const sheet = el('aside', 'sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', 'DSL reference')
  backdrop.append(sheet)
  document.body.append(backdrop)

  const close = (): void => {
    backdrop.classList.add('hidden')
    btn.setAttribute('aria-expanded', 'false')
    overlayClosed(close)
    btn.focus() // restore focus to the trigger
  }
  const open = (): void => {
    overlayOpened(close) // close any other open sheet
    backdrop.classList.remove('hidden')
    btn.setAttribute('aria-expanded', 'true')
    search.focus()
  }

  const head = el('div', 'sheet-head')
  head.append(el('h2', 'sheet-title', 'reference'))
  const full = el('a', 'docs-full-link') as HTMLAnchorElement
  full.append('full docs ', iconEl('external'))
  full.href = '/docs'
  full.target = '_blank'
  full.rel = 'noopener'
  head.append(full)
  const closeBtn = el('button', 'sheet-close')
  closeBtn.type = 'button'
  closeBtn.innerHTML = icon('x')
  closeBtn.setAttribute('aria-label', 'close')
  closeBtn.addEventListener('click', close)
  head.append(closeBtn)

  const search = el('input', 'lib-snap-name docs-search') as HTMLInputElement
  search.placeholder = 'search the reference…'
  search.setAttribute('aria-label', 'search reference')

  const body = el('div', 'docs-body')
  sheet.append(head, search, body)

  const render = (query = ''): void => {
    body.replaceChildren()
    const q = query.trim().toLowerCase()
    for (const grp of GROUPS) {
      const entries = DSL_DOCS.filter((e) => grp.kinds.includes(e.kind)).filter(
        (e) => q === '' || `${e.name} ${e.signature} ${e.summary}`.toLowerCase().includes(q),
      )
      if (entries.length === 0) continue
      body.append(el('h3', 'lib-subtitle docs-group', grp.title))
      for (const e of entries) {
        const row = el('div', 'docs-entry')
        row.append(el('div', 'docs-signature', e.signature))
        row.append(el('div', 'docs-summary', e.summary))
        if (e.example !== undefined) row.append(el('code', 'docs-example', e.example))
        body.append(row)
      }
    }
    if (body.children.length === 0) body.append(el('div', 'lib-empty', 'no matches'))
  }
  render()
  search.addEventListener('input', () => render(search.value))

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  btn.addEventListener('click', () => {
    if (backdrop.classList.contains('hidden')) open()
    else close()
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close()
  }
  document.addEventListener('keydown', onKey)

  return {
    dispose(): void {
      document.removeEventListener('keydown', onKey)
      backdrop.remove()
      btn.remove()
    },
  }
}
