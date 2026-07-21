import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  C_ACCENT,
  C_ACCENT_ALT,
  C_BG,
  C_BORDER,
  C_DIM,
  C_ERROR,
  C_FAINT,
  C_GREEN,
  C_RAISED,
  C_TEXT,
  C_WARN,
} from '../ui/palette'

/* Minimal hand-rolled dark theme — deliberately not a theme dependency. Shared
 * colors come from ui/palette.ts (the single source of truth). Syntax uses a
 * PHOSPHOR family (Oscilloscope Lab): mint keywords/functions, cyan strings,
 * amber numbers, dim-green comments — a scope-display duotone-plus-amber that
 * stays readable without the rainbow. 16px mono type is load-bearing on iOS:
 * anything smaller makes Safari zoom the page when the editor gets focus. */

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: C_BG,
      color: C_TEXT,
      fontSize: '16px',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5',
      overscrollBehavior: 'contain',
    },
    '.cm-content': {
      caretColor: C_ACCENT,
      padding: '10px 0 40vh', // bottom slack: keep the caret above the keyboard
    },
    '.cm-line': { padding: '0 12px 0 6px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: C_ACCENT, borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
      { backgroundColor: `${C_GREEN}66` },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-gutters': {
      backgroundColor: C_BG,
      color: C_FAINT,
      borderRight: `1px solid ${C_RAISED}`,
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: C_DIM },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 6px 0 8px' },
    '.cm-lintRange-error': {
      backgroundImage: 'none',
      textDecoration: `underline wavy ${C_ERROR} 1px`,
      textUnderlineOffset: '3px',
    },
    '.cm-lintRange-warning': {
      backgroundImage: 'none',
      textDecoration: `underline wavy ${C_WARN} 1px`,
      textUnderlineOffset: '3px',
    },
    '.cm-tooltip': {
      backgroundColor: C_RAISED,
      color: C_TEXT,
      border: `1px solid ${C_BORDER}`,
      borderRadius: '8px',
    },
    '.cm-diagnostic': { padding: '4px 8px' },
    '.cm-diagnostic-error': { borderLeft: `3px solid ${C_ERROR}` },
    '.cm-diagnostic-warning': { borderLeft: `3px solid ${C_WARN}` },
    // completion list: keep it phone-sized; the info panel carries the docs
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: '13px',
      maxHeight: '12em',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
    '.cm-completionDetail': { color: C_FAINT, fontStyle: 'normal', marginLeft: '0.6em' },
    '.cm-tooltip.cm-completionInfo': { padding: '0', maxWidth: 'min(320px, 70vw)' },
    // shared doc block (completion info + hover tooltip)
    '.cm-dsl-doc': { padding: '6px 9px', maxWidth: '340px' },
    '.cm-dsl-doc + .cm-dsl-doc': { borderTop: `1px solid ${C_BORDER}` },
    '.cm-dsl-doc-signature': {
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: '12px',
      color: C_ACCENT,
    },
    '.cm-dsl-doc-summary': { fontSize: '12px', margin: '4px 0 0', lineHeight: '1.4' },
    '.cm-dsl-doc-example': {
      display: 'block',
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: '11px',
      color: C_GREEN,
      marginTop: '4px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
    // Inline WGSL highlighting inside visual(`…`) (editor/wgsl.ts). Lives in the
    // theme — NOT a stylesheet — so it travels with the shared editor extension
    // to both the main editor and the docs examples (no CSS to keep in sync).
    // The per-token marks are Prec.highest, so they nest innermost and win over
    // the JS grammar's whole-string coloring.
    '.wgsl-com': { color: C_FAINT, fontStyle: 'italic' },
    '.wgsl-kw': { color: '#a7f3d0' },
    '.wgsl-type': { color: C_ACCENT_ALT },
    '.wgsl-fn': { color: C_ACCENT },
    '.wgsl-num': { color: C_WARN },
    '.wgsl-attr': { color: '#f7a8ff' },
    // the rondocode audio API (level, spectrum, beat…) — magenta so it pops
    '.wgsl-api': { color: '#f7a8ff', fontWeight: '600' },
    '.wgsl-punct': { color: C_DIM },
    '.wgsl-id': { color: C_TEXT },
  },
  { dark: true },
)

const highlight = HighlightStyle.define([
  { tag: t.comment, color: C_FAINT, fontStyle: 'italic' },
  { tag: t.string, color: C_ACCENT_ALT }, // cyan channel
  { tag: t.number, color: C_WARN }, // amber channel
  { tag: [t.keyword, t.definitionKeyword, t.modifier], color: '#a7f3d0' }, // bright mint
  { tag: [t.bool, t.null, t.atom], color: C_WARN },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: C_ACCENT }, // phosphor
  { tag: t.propertyName, color: '#5ec8b0' },
  { tag: [t.definition(t.variableName), t.variableName], color: C_TEXT },
  { tag: [t.operator, t.punctuation], color: C_DIM },
  { tag: t.bracket, color: C_DIM },
])

export const synthTheme: Extension = [editorTheme, syntaxHighlighting(highlight)]
