import { EditorState, Prec } from '@codemirror/state'
import type { Compartment, Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, selectNextOccurrence, selectSelectionMatches } from '@codemirror/search'
import { autocompletion } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { synthTheme } from './theme'
import { flashExtension } from './flash'
import { rondocodeCompletionSource } from './complete'
import { wgslHighlight, wgslCompletionSource } from './wgsl'
import { gotoDefExtension } from './gotodef'
import { noteHover } from './notehover'
import { dslHover } from './hover'
import { widgetExtension } from './widgets/widgets'
import { scrubExtension } from './widgets/scrub'
import { rondoLanguage, rondoAutocomplete } from './rondo'

/* ------------------------------------------------------------------------- *
 * The single source of truth for the rondocode code-editing experience,
 * shared by the main editor (editor.ts) AND the docs-page examples
 * (docs/doceditor.ts) so the two can never drift: whatever a snippet does in
 * the docs, it does identically in the editor.
 *
 * Everything here is PURE editing — grammar + phosphor theme, syntax
 * highlighting (incl. WGSL inside visual(`…`) templates), DSL
 * autocomplete/hover/note-hovercards/go-to-def, the slider/toggle/pick/xy
 * inline widgets + drag-to-scrub, multicursor, and the flash decoration
 * renderer. It is DOM- and session-free; the one thing it needs from a host is
 * `requestEval`, called after a widget/scrub rewrites the doc.
 *
 * Host-specific wiring stays with each caller and is NOT part of this set:
 *   - the transport keymap (Mod-Enter run / Mod-. stop) and the master meter
 *     gutter (editor.ts),
 *   - persistence / doc-change listeners,
 *   - the DEV-only LLM ghost-text (needs the bridge).
 * ------------------------------------------------------------------------- */

export interface CodeEditingOpts {
  /** A widget/scrub rewrote the doc — re-eval it. `immediate` for discrete
   *  changes (toggle/pick); false → debounced (drags). */
  requestEval: (immediate: boolean) => void
  /** Show the line-number gutter + active-line highlight (the full IDE look).
   *  Default true. The docs examples pass false so small snippets stay clean;
   *  every INTERACTIVE feature is unaffected either way. */
  gutter?: boolean
  /** When present, the language grammar + completion source are wrapped in
   *  these Compartments so the host can swap them at runtime (rondocode ↔
   *  rondo). Omit (docs pages) to get the static rondocode grammar. */
  langCompartment?: Compartment
  completionCompartment?: Compartment
  /** STATIC rondo mode (docs rondo snippets): the rondo grammar + hover +
   *  widgets + completion instead of the JS stack. Mutually exclusive with
   *  the Compartment pair above. */
  rondo?: boolean
}

/** The rondocode DSL autocomplete extension (also swappable via a Compartment). */
export const rondocodeAutocomplete = autocompletion({
  override: [wgslCompletionSource, rondocodeCompletionSource],
  activateOnTyping: true,
  maxRenderedOptions: 20,
})

/** The full shared editing stack, in precedence order. Spread it into an
 *  EditorState's `extensions`, then append host-specific extensions. */
export function codeEditingExtensions(opts: CodeEditingOpts): Extension[] {
  const gutter = opts.gutter ?? true
  return [
    // multi-cursor: CM6 collapses multi-range selections unless this is on —
    // it's what makes Cmd-D / Cmd-Shift-L actually stick.
    EditorState.allowMultipleSelections.of(true),
    Prec.highest(
      keymap.of([
        // VS Code / Cursor multi-cursor: Cmd-D adds the next occurrence of the
        // selection (or the word under the cursor); Cmd-Shift-L selects every
        // occurrence at once. preventDefault stops the browser bookmark (Cmd-D).
        { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
        { key: 'Mod-Shift-l', run: selectSelectionMatches },
      ]),
    ),
    ...(gutter ? [lineNumbers()] : []),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    ...(gutter ? [highlightActiveLine()] : []),
    highlightSelectionMatches(), // underline other occurrences of the selection
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    // the grammar the HighlightStyle colors. In the main editor this is wrapped
    // in a Compartment so it can be swapped for the rondo grammar at runtime;
    // docs rondo snippets pass `rondo: true` for a static rondo stack (grammar
    // + hover + inline knob/env/roll widgets bundled by rondoLanguage).
    opts.rondo
      ? rondoLanguage({ requestEval: opts.requestEval })
      : opts.langCompartment ? opts.langCompartment.of(javascript()) : javascript(),
    // DSL intellisense: context-aware completions (docs-driven, silent inside
    // mini-notation strings) plus WGSL completions inside visual() templates.
    opts.rondo
      ? rondoAutocomplete
      : opts.completionCompartment
        ? opts.completionCompartment.of(rondocodeAutocomplete)
        : rondocodeAutocomplete,
    wgslHighlight(), // WGSL syntax highlighting inside visual(`…`) templates
    dslHover, // hover a DSL symbol → its docs
    noteHover(), // hover a note/chord → a piano-keyboard hovercard
    gotoDefExtension(), // Cmd/Ctrl-click a symbol → jump to its definition
    EditorView.lineWrapping, // phones: wrap, never horizontal-scroll
    synthTheme,
    flashExtension, // renders .cm-flash decorations (host drives via EventFlasher)
    // Widgets-in-code: slider()/toggle()/pick()/xy() calls render as inline
    // controls; any plain number is Alt-drag (long-press on touch) scrubbable.
    // Both rewrite the doc, then re-eval via requestEval. See widgets/*.ts.
    widgetExtension({ requestEval: opts.requestEval }),
    scrubExtension({ requestEval: opts.requestEval }),
  ]
}
