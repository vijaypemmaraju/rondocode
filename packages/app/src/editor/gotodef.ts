import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { EditorState, Extension } from '@codemirror/state'
import { stringCallName, syntacticContext } from './complete'

/* ------------------------------------------------------------------------- *
 * Smart go-to-definition (Cmd/Ctrl-click). Two cases, resolved from the doc
 * text (the DSL is small and top-level, so no full scope analysis needed):
 *
 *  - a synth name inside .sound('…') / s('…')  → jump to `const <name> = synth(`
 *  - any JS identifier (e.g. s0 in stack(s0,…)) → jump to its `const|let|var`
 *    (or `function`) declaration.
 *
 * Cmd-click on the definition itself, or on a built-in with no in-doc
 * declaration, is a no-op (falls through to normal click handling).
 * ------------------------------------------------------------------------- */

export interface Range {
  from: number
  to: number
}

/** The identifier token spanning `pos`, or null (numbers/punctuation → null). */
export function identifierAt(doc: string, pos: number): { from: number; to: number; text: string } | null {
  const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c)
  let from = pos
  let to = pos
  while (from > 0 && isWord(doc[from - 1])) from--
  while (to < doc.length && isWord(doc[to])) to++
  if (from === to) return null
  const text = doc.slice(from, to)
  if (!/^[A-Za-z_$]/.test(text)) return null // must start like an identifier (not a number)
  return { from, to, text }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Document offset range of `name`'s definition, or null. `preferSynth` puts a
 * `const <name> = synth(` match first (for .sound() targets); otherwise a
 * plain const/let/var/function declaration wins.
 */
export function definitionTarget(doc: string, name: string, preferSynth: boolean): Range | null {
  const n = escapeRe(name)
  const synthDecl = new RegExp(`\\bconst\\s+(${n})\\s*=\\s*synth\\b`)
  const anyDecl = new RegExp(`\\b(?:const|let|var)\\s+(${n})\\b`)
  const fnDecl = new RegExp(`\\bfunction\\s+(${n})\\b`)
  const order = preferSynth ? [synthDecl, anyDecl, fnDecl] : [anyDecl, fnDecl, synthDecl]
  for (const re of order) {
    const m = re.exec(doc)
    if (m) {
      const from = m.index + m[0].lastIndexOf(name)
      return { from, to: from + name.length }
    }
  }
  return null
}

/** The symbol under `pos` and where it jumps to, or null if not a resolvable
 *  reference (built-in, mini-notation atom, the definition itself…). */
function resolveAt(state: EditorState, pos: number): { source: Range; target: Range } | null {
  const doc = state.doc.toString()
  const id = identifierAt(doc, pos)
  if (!id) return null
  const kind = syntacticContext(state, pos)
  const call = kind === 'string' ? stringCallName(state, pos) : null
  const isSoundName = call === 'sound' || call === 's'
  // inside a non-sound string it's mini-notation, not a reference
  if (kind === 'string' && !isSoundName) return null
  const target = definitionTarget(doc, id.text, isSoundName)
  if (!target || target.from === id.from) return null
  return { source: { from: id.from, to: id.to }, target }
}

// Link-highlight (the underlined "it's clickable" hint while the mod key is held).
const setLink = StateEffect.define<Range | null>()
const linkMark = Decoration.mark({ class: 'cm-gotodef-link' })
const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setLink)) {
        deco = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** CodeMirror extension: Cmd/Ctrl-click a symbol to jump to its definition,
 *  and — while the mod key is held — underline the symbol under the pointer so
 *  it reads as a link. */
export function gotoDefExtension(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private x = -1
      private y = -1
      private mod = false
      private cur: Range | null = null
      private readonly onMove: (e: MouseEvent) => void
      private readonly onLeave: () => void
      private readonly onKey: (e: KeyboardEvent) => void
      private readonly onDown: (e: MouseEvent) => void

      constructor(private readonly view: EditorView) {
        this.onMove = (e) => {
          this.x = e.clientX
          this.y = e.clientY
          this.mod = e.metaKey || e.ctrlKey
          this.refresh()
        }
        this.onLeave = () => {
          this.x = this.y = -1
          this.apply(null)
        }
        this.onKey = (e) => {
          const m = e.metaKey || e.ctrlKey
          if (m !== this.mod) {
            this.mod = m
            this.refresh()
          }
        }
        this.onDown = (e) => {
          if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos === null) return
          const r = resolveAt(view.state, pos)
          if (!r) return
          e.preventDefault()
          view.dispatch({ selection: { anchor: r.target.from, head: r.target.to }, scrollIntoView: true })
          view.focus()
          this.apply(null)
        }
        view.dom.addEventListener('mousemove', this.onMove)
        view.dom.addEventListener('mouseleave', this.onLeave)
        view.dom.addEventListener('mousedown', this.onDown)
        window.addEventListener('keydown', this.onKey)
        window.addEventListener('keyup', this.onKey)
      }

      private refresh(): void {
        if (!this.mod || this.x < 0) return this.apply(null)
        const pos = this.view.posAtCoords({ x: this.x, y: this.y })
        this.apply(pos === null ? null : (resolveAt(this.view.state, pos)?.source ?? null))
      }

      /** Dispatch the link decoration only when it actually changed. */
      private apply(range: Range | null): void {
        const same =
          (range === null && this.cur === null) ||
          (range !== null && this.cur !== null && range.from === this.cur.from && range.to === this.cur.to)
        if (same) return
        this.cur = range
        this.view.dispatch({ effects: setLink.of(range) })
      }

      destroy(): void {
        this.view.dom.removeEventListener('mousemove', this.onMove)
        this.view.dom.removeEventListener('mouseleave', this.onLeave)
        this.view.dom.removeEventListener('mousedown', this.onDown)
        window.removeEventListener('keydown', this.onKey)
        window.removeEventListener('keyup', this.onKey)
      }
    },
  )
  return [linkField, plugin]
}
