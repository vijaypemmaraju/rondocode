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
  /** a builtin call: saw, square, adsr, ladder, … (see src/builtins.ts). */
  | { t: 'call'; name: string; args: Expr[]; named: Record<string, Expr>; pos: Pos }
  /** a bare enum word in an arg position (`noise pink`, `mode:hp`) — emitted
   *  as a quoted string. */
  | { t: 'enum'; name: string; pos: Pos }
  /** `x -> lo..hi` — map a unipolar signal into a range (codegen → .range). */
  | { t: 'map'; x: Expr; lo: Expr; hi: Expr; pos: Pos }
  /** a live control declared on a binding: `knob DEF lo..hi curve`. */
  | { t: 'knob'; def: Expr; lo: Expr; hi: Expr; curve?: string; pos: Pos }
  /** raw rondocode/JS passed through verbatim via the `js{ … }` escape hatch. */
  | { t: 'js'; code: string; pos: Pos }

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
  /** optional post chain (a `post` sub-block): a spine folded from `input`. */
  post?: Expr
  postBindings?: Binding[]
  /** header voice options: `synth acid mono glide:.08` → synth() opts. */
  voiceOpts?: Record<string, number | boolean>
  pos: Pos
}

/** A value on a play modifier line: a plain number, a continuous signal
 *  (`sine 200..2400 slow:4`), or a mini-notation string (`<1 2.5>`). */
export type CtrlValue =
  | { kind: 'num'; v: number }
  | { kind: 'sig'; sig: string; lo?: number; hi?: number; slow?: number; fast?: number }
  | { kind: 'mini'; text: string }

/** A combinator applied to a pattern (a bare line, or the body of `every N:`). */
export interface Comb {
  name: string
  /** raw arguments — numbers, or (for struct) a mini string. */
  args: string[]
}

/** A play-block modifier line, applied in order after `.sound()`. */
export type Mod =
  | { kind: 'ctrl'; name: string; value: CtrlValue; pos: Pos }
  | { kind: 'method'; name: 'gain' | 'dur' | 'pan'; value: CtrlValue; pos: Pos }
  /** a function-taking combinator: `every 4: rev`, `jux: rev`,
   *  `off .25: gain .3` → .name(...pre, x => x.comb()). */
  | { kind: 'fncomb'; name: string; pre: number[]; comb: Comb; pos: Pos }
  | { kind: 'comb'; comb: Comb; pos: Pos }

export interface PlayBlock {
  t: 'play'
  name: string
  /** raw notation text, handed verbatim to n()/note(). */
  notation: string
  /** absolute char offset of `notation` in the source (for note-play flash). */
  notationFrom: number
  /** additional stacked voice lines (multi-line play block → stack(...)). */
  voices?: { notation: string; notationFrom: number }[]
  /** short scale name from `scale:a-min`, if present (e.g. "a-min"). */
  scale?: string
  /** modifier lines under the notation, applied in order. */
  mods: Mod[]
  pos: Pos
}

export interface CpsItem {
  t: 'cps'
  value: number
  pos: Pos
}

/** Raw rondocode/JS passed through verbatim — a top-level `js{ … }` line or a
 *  `js` block (header + indented body). The parity escape hatch. */
export interface RawItem {
  t: 'raw'
  code: string
  pos: Pos
}

/** `sidechain kick depth:.7 release:.09 lead:.5 …` — named args other than
 *  depth/release are per-channel duck amounts. */
export interface SidechainItem {
  t: 'sidechain'
  source: string
  depth?: number
  release?: number
  duck: Record<string, number>
  pos: Pos
}

/** `master threshold:-6 ratio:2 …` → masterCompress(opts). */
export interface MasterItem {
  t: 'master'
  opts: Record<string, number>
  pos: Pos
}

/** A `bus NAME` block: an FX spine folded from `input` + `send SYNTH AMT`
 *  routing lines. */
export interface BusBlock {
  t: 'bus'
  name: string
  fx: Expr
  bindings: Binding[]
  sends: Record<string, number>
  pos: Pos
}

/** A `visual` block: raw WGSL body passed verbatim to visual(`…`). */
export interface VisualItem {
  t: 'visual'
  wgsl: string
  pos: Pos
}

/** `section NAME LEN` — a named block of nested plays, LEN cycles long.
 *  Sections stack their plays and sequence via arrange() (see SongItem). */
export interface SectionBlock {
  t: 'section'
  name: string
  len: number
  plays: PlayBlock[]
  pos: Pos
}

/** `song intro drop drop intro` — the section order. Optional: without it,
 *  sections play in definition order. */
export interface SongItem {
  t: 'song'
  order: string[]
  pos: Pos
}

export type TopItem =
  | SynthBlock | PlayBlock | CpsItem | RawItem
  | SidechainItem | MasterItem | BusBlock | VisualItem
  | SectionBlock | SongItem

export interface Program {
  items: TopItem[]
}

export interface RondoError {
  message: string
  line: number
  col: number
}
