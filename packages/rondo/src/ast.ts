/* rondo AST — the shapes the parser produces and codegen consumes.
 *
 * A rondo program is a sequence of top-level items (synth / play / cps). A
 * `synth` block is the heart of the language: an audio "spine" (folded into a
 * single expression while parsing, since the pipe is linear) plus `name = …`
 * bindings for modulation/CV. A `play` block is notation text (passed through
 * verbatim to n()/note()) plus modifiers. */

export interface Pos {
  line: number
  col: number
}

/* ---- expressions (the synth spine + bindings) ---------------------------- */
export type Expr =
  | { t: 'num'; v: number; pos: Pos }
  /** an identifier reference: a binding name, or the special `note` / `gate`. */
  | { t: 'ident'; name: string; pos: Pos }
  /** infix arithmetic: + - * / ^ (codegen → .add/.sub/.mul/.div/.pow). */
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Expr; r: Expr; pos: Pos }
  /** a builtin call: saw, square, adsr, ladder, … (see codegen BUILTINS). */
  | { t: 'call'; name: string; args: Expr[]; named: Record<string, Expr>; pos: Pos }
  /** `x -> lo..hi` — map a unipolar signal into a range (codegen → .range). */
  | { t: 'map'; x: Expr; lo: Expr; hi: Expr; pos: Pos }
  /** a live control declared on a binding: `knob DEF lo..hi curve`. */
  | { t: 'knob'; def: Expr; lo: Expr; hi: Expr; curve?: string; pos: Pos }

/* ---- top-level items ----------------------------------------------------- */
export interface Binding {
  name: string
  expr: Expr
  pos: Pos
}

export interface SynthBlock {
  t: 'synth'
  name: string
  bindings: Binding[]
  /** the audio spine, already folded into one expression. */
  spine: Expr
  pos: Pos
}

export interface PlayBlock {
  t: 'play'
  name: string
  /** raw notation text, handed verbatim to n()/note(). */
  notation: string
  /** short scale name from `scale:a-min`, if present (e.g. "a-min"). */
  scale?: string
  pos: Pos
}

export interface CpsItem {
  t: 'cps'
  value: number
  pos: Pos
}

export type TopItem = SynthBlock | PlayBlock | CpsItem

export interface Program {
  items: TopItem[]
}

export interface RondoError {
  message: string
  line: number
  col: number
}
