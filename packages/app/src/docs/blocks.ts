import type { Block, ListBlock, NoteBlock, ParagraphBlock, TableBlock } from './content'
import { escapeHtml } from './highlight'

/* ------------------------------------------------------------------------- *
 * The non-code guide blocks, rendered to HTML as pure strings. The docs page
 * (docs.ts) parses these into nodes; keeping them string-shaped means the
 * markup is testable in node, with no DOM.
 *
 * Every text field on every block runs through inlineHtml, so a `code span`
 * looks the same in a table cell, a list item, a note and a paragraph. There
 * is exactly one such path on purpose: forking it is how a cell ends up
 * showing literal backticks.
 * ------------------------------------------------------------------------- */

/** Escape, then turn `backticked` runs into <code>. The ONE inline formatter. */
export const inlineHtml = (text: string): string =>
  escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')

/** A cell/heading is numeric when its whole content is a number, backticks and
 *  a leading sign allowed (`.1875`, `-7`, `1`). Numeric COLUMNS get tabular
 *  figures so the digits line up down the column. */
const isNumeric = (cell: string): boolean => /^-?(\d+\.?\d*|\.\d+)$/.test(cell.replace(/`/g, '').trim())

/** Column indices whose every body cell is numeric (an empty column is not). */
const numericColumns = (t: TableBlock): Set<number> => {
  const cols = new Set<number>()
  for (let i = 0; i < t.headers.length; i++) {
    const cells = t.rows.map((r) => r[i] ?? '')
    if (cells.length > 0 && cells.every(isNumeric)) cols.add(i)
  }
  return cols
}

const paragraphHtml = (b: ParagraphBlock): string => `<p>${inlineHtml(b.text)}</p>`

const listHtml = (b: ListBlock): string => {
  const tag = b.ordered === true ? 'ol' : 'ul'
  const items = b.items.map((it) => `<li>${inlineHtml(it)}</li>`).join('')
  return `<${tag} class="doc-list">${items}</${tag}>`
}

const noteHtml = (b: NoteBlock): string =>
  `<aside class="doc-note${b.tone === 'warn' ? ' doc-note-warn' : ''}">${inlineHtml(b.text)}</aside>`

/** A table in its OWN horizontal scroller: a wide reference table must never
 *  make the page itself scroll sideways on a phone. */
const tableHtml = (b: TableBlock): string => {
  const num = numericColumns(b)
  const cls = (i: number): string => (num.has(i) ? ' class="num"' : '')
  const caption = b.caption !== undefined && b.caption !== '' ? `<caption>${inlineHtml(b.caption)}</caption>` : ''
  const head = b.headers.map((h, i) => `<th scope="col"${cls(i)}>${inlineHtml(h)}</th>`).join('')
  const body = b.rows
    .map((r) => `<tr>${b.headers.map((_, i) => `<td${cls(i)}>${inlineHtml(r[i] ?? '')}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="doc-table-wrap"><table class="doc-table">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

/** HTML for any block that is not a playable code card (those need the live
 *  editor and are built by docs.ts). */
export function blockHtml(b: Exclude<Block, { kind: 'code' }>): string {
  switch (b.kind) {
    case 'p':
      return paragraphHtml(b)
    case 'list':
      return listHtml(b)
    case 'note':
      return noteHtml(b)
    case 'table':
      return tableHtml(b)
  }
}
