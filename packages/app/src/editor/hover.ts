import { hoverTooltip } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'
import type { DocEntry } from '../docs/dsl-docs'
import { docsByName } from '../docs/dsl-docs'
import { syntacticContext } from './complete'

/* ------------------------------------------------------------------------- *
 * Hover documentation: identifier under the cursor → its dsl-docs entries;
 * inside a string literal, a mini-notation operator character → its
 * mini-syntax entry (that is where mini docs surface, since completions
 * stay silent in strings). The lookup and classification are pure
 * (hoverDocsAt) and unit-tested; only tooltip rendering touches the DOM.
 * ------------------------------------------------------------------------- */

/** Mini operator character → docsByName key. Multi-char constructs map all
 *  their delimiters to the one entry ('[' and ']' both explain subgroups). */
const MINI_CHAR_TO_NAME = new Map<string, string>([
  ['~', 'mini:~'],
  ['_', 'mini:_'],
  ['[', 'mini:[]'],
  [']', 'mini:[]'],
  ['<', 'mini:<>'],
  ['>', 'mini:<>'],
  ['{', 'mini:{}'],
  ['}', 'mini:{}'],
  ['%', 'mini:{}'],
  ['*', 'mini:*'],
  ['/', 'mini:/'],
  ['!', 'mini:!'],
  ['@', 'mini:@'],
  ['(', 'mini:(p,s,r)'],
  [')', 'mini:(p,s,r)'],
  [',', 'mini:(p,s,r)'],
  ['?', 'mini:?'],
  ['|', 'mini:|'],
])

/** The mini-syntax entry for a single character, if it is a mini operator. */
export const miniEntryForChar = (ch: string): DocEntry | undefined => {
  const name = MINI_CHAR_TO_NAME.get(ch)
  return name === undefined ? undefined : docsByName.get(name)?.[0]
}

/**
 * A name can carry entries of several kinds ('mul' is a Pattern method AND
 * a Sig method; 'sine' a scope global AND a ctx member). Prefer the kinds
 * that make sense where the cursor is; fall back to everything so hover
 * never goes silent on a documented name.
 */
export const selectEntries = (
  entries: DocEntry[],
  context: 'synth' | 'top' | 'string',
): DocEntry[] => {
  const preferred =
    context === 'synth'
      ? entries.filter((e) => e.kind === 'synth-ctx' || e.kind === 'sig-method')
      : entries.filter((e) => e.kind !== 'synth-ctx' && e.kind !== 'sig-method')
  return preferred.length > 0 ? preferred : entries
}

export interface HoverDocs {
  from: number
  to: number
  entries: DocEntry[]
}

const isWordChar = (ch: string): boolean => /[\w$]/.test(ch)

/**
 * Pure hover resolution: what to document at `pos`, if anything.
 * Inside strings: the single character at pos (mini operators only).
 * Elsewhere: the identifier containing pos, looked up in docsByName and
 * filtered by context (see selectEntries).
 */
export const hoverDocsAt = (state: EditorState, pos: number): HoverDocs | null => {
  const context = syntacticContext(state, pos)
  if (context === 'string') {
    const ch = state.sliceDoc(pos, pos + 1)
    const entry = miniEntryForChar(ch)
    return entry === undefined ? null : { from: pos, to: pos + 1, entries: [entry] }
  }
  // expand to the identifier around pos
  const line = state.doc.lineAt(pos)
  const text = line.text
  let from = pos - line.from
  let to = from
  while (from > 0 && isWordChar(text[from - 1]!)) from--
  while (to < text.length && isWordChar(text[to]!)) to++
  if (from === to) return null
  const word = text.slice(from, to)
  if (/^\d/.test(word)) return null // numeric literal, not an identifier
  const entries = docsByName.get(word)
  if (entries === undefined) return null
  const selected = selectEntries(
    entries.filter((e) => e.kind !== 'mini-syntax'),
    context,
  )
  return selected.length === 0
    ? null
    : { from: line.from + from, to: line.from + to, entries: selected }
}

// ------------------------------------------------------------- DOM render

const renderTooltip = (entries: DocEntry[]): HTMLElement => {
  const root = document.createElement('div')
  root.className = 'cm-dsl-hover'
  for (const e of entries) {
    const block = document.createElement('div')
    block.className = 'cm-dsl-doc'
    const sig = document.createElement('div')
    sig.className = 'cm-dsl-doc-signature'
    sig.textContent = e.signature
    const summary = document.createElement('div')
    summary.className = 'cm-dsl-doc-summary'
    summary.textContent = e.summary
    block.append(sig, summary)
    if (e.example !== undefined) {
      const ex = document.createElement('code')
      ex.className = 'cm-dsl-doc-example'
      ex.textContent = e.example
      block.append(ex)
    }
    root.append(block)
  }
  return root
}

/** The hover extension mountEditor installs. */
export const dslHover: Extension = hoverTooltip((view, pos) => {
  const docs = hoverDocsAt(view.state, pos)
  if (docs === null) return null
  return {
    pos: docs.from,
    end: docs.to,
    above: true, // prefer above: never covers the transport bar below
    create: () => ({ dom: renderTooltip(docs.entries) }),
  }
})
