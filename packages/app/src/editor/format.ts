/* Auto-formatting glue for the editor: both languages, one seam.
 *
 *   - diffChanges(a, b): a MINIMAL per-line ChangeSpec between two versions of
 *     a doc. The manual formatter dispatches these instead of one whole-doc
 *     replace, so undo history, decorations, and (via ChangeSet mapping) the
 *     cursor all survive — a full-buffer replace would nuke every mark and
 *     snap the selection to the end.
 *   - formatJsSource(src): prettier standalone, LAZY-loaded on first use via
 *     dynamic import so the ~400 kB formatter chunk never joins the eager
 *     page-load graph (pinned by test/eager-graph.test.ts). Returns null when
 *     the source does not parse — a formatter must never mangle broken code.
 *   - formatOnNewline(...): an update listener that notices a typed Enter and
 *     tidies ONLY the line the cursor just left, using the rondo formatter's
 *     line-local rules. Rondo only in v1: prettier has no reliable
 *     single-line mode, and reformatting the whole doc on every Enter is not
 *     acceptable, so in JS mode the setting is a no-op.
 *
 * The rondo formatter itself lives in @rondocode/rondo (pure, fuzz-gated). */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { formatRondoLine } from '@rondocode/rondo'

/* ---- prettier (lazy) -------------------------------------------------------- */

/** House style, matched to the shipped rondocode examples: semicolonless,
 *  single quotes, 2-space indent, trailing commas, bare arrow params. The
 *  ~44-char example line length is an AUTHORING guideline, not a formatter
 *  concern — printWidth stays 100 and never hard-wraps mobile-formatted code
 *  that already fits. */
export const PRETTIER_OPTIONS = {
  parser: 'babel',
  semi: false,
  singleQuote: true,
  printWidth: 100,
  tabWidth: 2,
  arrowParens: 'avoid',
  trailingComma: 'all',
} as const

/** Format rondocode (JS) source with prettier. Returns null if the source
 *  does not parse (leave the doc untouched) or the formatter fails to load. */
export async function formatJsSource(src: string): Promise<string | null> {
  try {
    const [standalone, babel, estree] = await Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
    ])
    return await standalone.format(src, {
      ...PRETTIER_OPTIONS,
      plugins: [babel.default ?? babel, estree.default ?? estree],
    })
  } catch {
    return null
  }
}

/* ---- minimal per-line diff ---------------------------------------------------- */

export interface Change {
  from: number
  to: number
  insert: string
}

/** Shrink one replacement to the differing middle (common prefix/suffix off),
 *  so e.g. an indent fix touches only the indent characters. */
function shrink(a: string, from: number, to: number, insert: string): Change {
  const old = a.slice(from, to)
  let p = 0
  while (p < old.length && p < insert.length && old[p] === insert[p]) p++
  let s = 0
  while (s < old.length - p && s < insert.length - p && old[old.length - 1 - s] === insert[insert.length - 1 - s]) s++
  return { from: from + p, to: to - s, insert: insert.slice(p, insert.length - s) }
}

/** Minimal per-line changes turning `a` into `b`: line-level LCS, hunks
 *  coalesced, then each hunk shrunk to its differing characters. Applying the
 *  result to `a` yields exactly `b` (pinned by test/format.test.ts). */
export function diffChanges(a: string, b: string): Change[] {
  if (a === b) return []
  const al = a.split('\n')
  const bl = b.split('\n')
  // trim common line prefix/suffix first — the DP then runs on the small middle
  let pre = 0
  while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++
  let suf = 0
  while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++
  const am = al.slice(pre, al.length - suf)
  const bm = bl.slice(pre, bl.length - suf)
  // char offset of the start of line i in `a`
  const offA: number[] = new Array<number>(al.length + 1)
  offA[0] = 0
  for (let i = 0; i < al.length; i++) offA[i + 1] = offA[i]! + al[i]!.length + 1
  /** the char range covering lines [i0, i1) of `a`, newline-inclusive where
   *  possible so whole-line hunks splice cleanly. */
  const range = (i0: number, i1: number): { from: number; to: number; nl: boolean } => {
    if (i1 < al.length) return { from: offA[i0]!, to: offA[i1]!, nl: true }
    // hunk reaches the last line: no trailing newline to own — take the
    // preceding one instead when deleting from a non-empty prefix
    return { from: i0 > 0 ? offA[i0]! - 1 : 0, to: a.length, nl: false }
  }
  const emit = (i0: number, i1: number, repl: string[], out: Change[]): void => {
    const r = range(i0, i1)
    const joined = repl.join('\n')
    // NB: repl.length, not joined === '' — [''] is one BLANK LINE, not nothing
    const insert = r.nl
      ? repl.length === 0 ? '' : joined + '\n'
      : repl.length === 0 ? '' : (i0 > 0 ? '\n' : '') + joined
    const c = shrink(a, r.from, r.to, insert)
    if (c.from !== c.to || c.insert !== '') out.push(c)
  }
  const out: Change[] = []
  if (am.length * bm.length > 1_000_000) {
    // absurdly large middle: one hunk (still shrunk to differing chars)
    emit(pre, al.length - suf, bm, out)
    return out
  }
  // LCS over the middle
  const n = am.length
  const m = bm.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        am[i] === bm[j]
          ? dp[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  let hi = -1 // current hunk start (a-side), -1 = none
  let hRepl: string[] = []
  const flush = (aEnd: number): void => {
    if (hi >= 0) emit(pre + hi, pre + aEnd, hRepl, out)
    hi = -1
    hRepl = []
  }
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      flush(i)
      i++
      j++
      continue
    }
    if (hi < 0) hi = i
    if (j < m && (i >= n || dp[i * (m + 1) + j + 1]! >= dp[(i + 1) * (m + 1) + j]!)) {
      hRepl.push(bm[j]!)
      j++
    } else {
      i++
    }
  }
  flush(i)
  return out
}

/* ---- format-on-newline --------------------------------------------------------- */

/** After a typed Enter, format the line the cursor just left (rondo's
 *  line-local rules — indentation, binding/modifier spacing, trailing
 *  whitespace). `enabled` gates on the setting AND the active language. */
export function formatOnNewline(enabled: () => boolean): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.docChanged || !enabled()) return
    // a typed Enter: a user 'input' transaction (not paste/drop) whose only
    // inserted text is a newline plus auto-indent
    let isEnter = false
    for (const tr of u.transactions) {
      if (!tr.isUserEvent('input') || tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop')) continue
      tr.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
        if (/^\n[ \t]*$/.test(ins.toString())) isEnter = true
      })
    }
    if (!isEnter) return
    const view = u.view
    const lineNo = view.state.doc.lineAt(view.state.selection.main.head).number
    if (lineNo <= 1) return
    const left = view.state.doc.line(lineNo - 1)
    const formatted = formatRondoLine(view.state.doc.toString(), lineNo - 1)
    if (formatted === null || formatted === left.text) return
    const before = left.text
    // dispatching inside an update listener is not allowed — defer a tick,
    // then re-check the line is still exactly what we formatted
    setTimeout(() => {
      if (lineNo - 1 > view.state.doc.lines) return
      const cur = view.state.doc.line(lineNo - 1)
      if (cur.text !== before) return
      const c = shrink(view.state.doc.toString(), cur.from, cur.to, formatted)
      if (c.from === c.to && c.insert === '') return
      view.dispatch({ changes: c, userEvent: 'format.line' })
    }, 0)
  })
}
