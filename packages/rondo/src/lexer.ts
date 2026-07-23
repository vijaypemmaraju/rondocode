/* rondo lexer — line-oriented, indentation-aware.
 *
 * rondo blocks are delimited by 2-space indentation: a `synth NAME` / `play
 * NAME` header at one level, its body indented under it. So rather than a flat
 * INDENT/DEDENT token stream, the lexer yields LOGICAL LINES, each carrying its
 * indent depth, its raw text (used verbatim for play-block notation), and its
 * inline tokens (used to parse synth-block expressions).
 *
 * Comments run from a `#` (at line start, or preceded by whitespace) to EOL —
 * so a note like `c#4` keeps its sharp, but ` # note` is a comment. */

import type { Pos, RondoError } from './ast'

export type Tok =
  | { k: 'num'; v: number; text: string; pos: Pos; sp: boolean }
  | { k: 'ident'; v: string; pos: Pos; sp: boolean }
  | { k: 'op'; v: '+' | '-' | '*' | '/' | '^'; pos: Pos; sp: boolean }
  | { k: 'range'; pos: Pos; sp: boolean } // ..
  | { k: 'arrow'; pos: Pos; sp: boolean } // ->
  | { k: 'colon'; pos: Pos; sp: boolean } // :
  | { k: 'eq'; pos: Pos; sp: boolean } // =

export interface Line {
  indent: number
  line: number
  /** text after the indent, with any trailing comment removed. */
  raw: string
  /** column (1-based) where `raw` begins, for accurate positions. */
  rawCol: number
  toks: Tok[]
}

const stripComment = (s: string): string => {
  // a '#' at start, or preceded by whitespace, begins a comment
  const m = /(^|\s)#/.exec(s)
  return m ? s.slice(0, m.index + (m[1] ? m[1].length : 0)) : s
}

const OPS = new Set(['+', '-', '*', '/', '^'])

/** Tokenize one line's text into inline tokens. `base` is the 1-based column of
 *  the first character, so token positions map back to the source. */
function tokenizeLine(text: string, lineNo: number, base: number, errors: RondoError[]): Tok[] {
  const toks: Tok[] = []
  let i = 0
  let sawSpace = true // leading position counts as space-preceded
  while (i < text.length) {
    const ch = text[i]!
    if (ch === ' ' || ch === '\t') { sawSpace = true; i++; continue }
    const pos: Pos = { line: lineNo, col: base + i }
    const sp = sawSpace
    sawSpace = false
    // two-char tokens
    if (ch === '.' && text[i + 1] === '.') { toks.push({ k: 'range', pos, sp }); i += 2; continue }
    if (ch === '-' && text[i + 1] === '>') { toks.push({ k: 'arrow', pos, sp }); i += 2; continue }
    // number: 12, 12.5, .5 — a single decimal point only, never eating `..`
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i
      while (j < text.length && /[0-9]/.test(text[j]!)) j++
      if (text[j] === '.' && text[j + 1] !== '.') { j++; while (j < text.length && /[0-9]/.test(text[j]!)) j++ }
      const t = text.slice(i, j)
      const v = Number(t)
      if (!Number.isFinite(v)) errors.push({ message: `bad number "${t}"`, line: lineNo, col: base + i })
      toks.push({ k: 'num', v, text: t, pos, sp })
      i = j
      continue
    }
    // identifier: letters, then word chars
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i
      while (j < text.length && /[a-zA-Z0-9_]/.test(text[j]!)) j++
      toks.push({ k: 'ident', v: text.slice(i, j), pos, sp })
      i = j
      continue
    }
    if (ch === ':') { toks.push({ k: 'colon', pos, sp }); i++; continue }
    if (ch === '=') { toks.push({ k: 'eq', pos, sp }); i++; continue }
    if (OPS.has(ch)) { toks.push({ k: 'op', v: ch as '+', pos, sp }); i++; continue }
    errors.push({ message: `unexpected character "${ch}"`, line: lineNo, col: base + i })
    i++
  }
  return toks
}

export function lex(src: string): { lines: Line[]; errors: RondoError[] } {
  const errors: RondoError[] = []
  const lines: Line[] = []
  const rawLines = src.split('\n')
  for (let li = 0; li < rawLines.length; li++) {
    const rawFull = rawLines[li]!
    const lineNo = li + 1
    const noComment = stripComment(rawFull)
    if (noComment.trim() === '') continue // blank / comment-only line: skip
    const indentMatch = /^[ \t]*/.exec(noComment)![0]
    if (indentMatch.includes('\t')) {
      errors.push({ message: 'use spaces, not tabs, for indentation', line: lineNo, col: 1 })
    }
    const indent = indentMatch.length
    const rawCol = indent + 1
    const text = noComment.slice(indent).replace(/\s+$/, '')
    lines.push({ indent, line: lineNo, raw: text, rawCol, toks: tokenizeLine(text, lineNo, rawCol, errors) })
  }
  return { lines, errors }
}
