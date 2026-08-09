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
  /** `sum k 1..16` — the body summed once per value of `k`.
   *
   *  An additive voice is N copies of one line with the numbers moving: a
   *  piano's partials, a drawbar organ, a tap chain. Writing them out is the
   *  only way rondo had, and sixteen near-identical lines is not a language
   *  being terse. The body is an ordinary spine with ordinary bindings, and
   *  `k` is in scope for both — which matters because bindings are how rondo
   *  writes what other languages need parentheses for. */
  | { t: 'sum'; index: string; lo: number; hi: number; bindings: Binding[]; body: Expr; pos: Pos }
  /** a live control declared on a binding: `knob DEF lo..hi curve`. */
  | { t: 'knob'; def: Expr; lo: Expr; hi: Expr; curve?: string; pos: Pos }
  /** A SWITCH: a knob with two fixed values instead of a range. `a` is the
   *  value it rests on, which is why tapping the widget REORDERS the pair
   *  rather than writing a third number somewhere. */
  | { t: 'switch'; a: number; b: number; pos: Pos }
  /** `LEVEL:CURVE` on an env breakpoint — that segment's own shape, where the
   *  envelope-wide `curve:` would bend every joint the same way. Only legal in
   *  an `env` argument list. */
  | { t: 'curved'; level: Expr; curve: Expr; pos: Pos }
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
  /** 'sound' = a `beat` block: notation words are synth names → s('…'). */
  entry?: 'sound'
  /** `play NAME synth:OTHER` routes to a DIFFERENT synth than the channel
   *  name — two patterns can drive one synth on separate channels. */
  synthName?: string
  /** raw notation text, handed verbatim to n()/note(). */
  notation: string
  /** absolute char offset of `notation` in the source (for note-play flash). */
  notationFrom: number
  /** Set when the notation was ASSEMBLED from patdefs rather than written
   *  here: the text exists nowhere in the buffer as one run, so each chunk
   *  maps back to wherever it came from. Note-flash needs this or it
   *  highlights the reference with the expansion (see compile.ts NoteSpan). */
  notationPieces?: { assembledStart: number; sourceStart: number; length: number }[]
  /** Reference spans: a stretch of the assembled notation, and the WORD in the
   *  buffer that stands for it. A note inside `tail` lights the word `tail`
   *  where it is written, not only the definition it expands to. */
  notationRefs?: { from: number; to: number; assembledStart: number; assembledEnd: number }[]
  /** additional stacked voice lines (multi-line play block → stack(...)).
   *  A voice may name its OWN synth with a trailing `synth:NAME`, which is
   *  what makes a layered drum pattern sayable: layers otherwise share the
   *  block's synth, which is right for a hand-built chord and wrong when
   *  each layer is a different instrument. */
  voices?: { notation: string; notationFrom: number; synthName?: string; notationPieces?: { assembledStart: number; sourceStart: number; length: number }[]; notationRefs?: { from: number; to: number; assembledStart: number; assembledEnd: number }[] }[]
  /** short scale name from `scale:a-min`, if present (e.g. "a-min"). */
  scale?: string
  /** modifier lines under the notation, applied in order. */
  mods: Mod[]
  pos: Pos
}

/** The tempo line, in either spelling: `cps .5333` or `bpm 128`. The UNIT is
 *  part of the program — it survives codegen (`setCps` / `setBpm`) and comes
 *  back through the decompiler, so converting a doc to JS and back never
 *  silently swaps the number a musician typed for the other one. */
export interface CpsItem {
  t: 'cps'
  /** the number as written, in `unit` (NOT normalized to cps). */
  value: number
  unit: 'cps' | 'bpm'
  pos: Pos
}

/** `level -4` — the project's overall output level in dB. The one line that
 *  scales every part equally, so it moves the level without touching the
 *  balance. Reach for it when a bounce says it was normalized: above the
 *  render's peak ceiling the whole mix gets scaled back down, which makes
 *  per-part gains inert, and only a uniform trim brings it back under. */
export interface LevelItem {
  t: 'level'
  /** decibels as written; 0 is unity, negative is quieter. */
  db: number
  pos: Pos
}

/** `timesig 3 4` — the project's meter. A cycle is one BAR, so this is what
 *  makes a bar three quarters long instead of four; `bpm` is counted in
 *  quarter notes and scales with it. */
export interface TimeSigItem {
  t: 'timesig'
  num: number
  den: number
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
  depth?: ScValue
  release?: ScValue
  duck: Record<string, ScValue>
  pos: Pos
}

/** A sidechain amount: a literal, or the NAME of a project-wide macro or
 *  switch. The pump is the one place a project control could not reach, which
 *  made "one knob, everything" untrue for the most obvious thing to want to
 *  switch off. */
export type ScValue = number | { macro: string }

/** `stereo width:1.3 monobelow:120` → stereo(opts). Mid/side on the master
 *  bus: the one place it is expressible, since every kernel is mono. */
export interface StereoItem {
  t: 'stereo'
  opts: Record<string, number>
  pos: Pos
}

/** `master threshold:-6 ratio:2 …` → masterCompress(opts). */
export interface MasterItem {
  t: 'master'
  opts: Record<string, number>
  pos: Pos
}

/** `scaledef NAME v1 v2 …` — register a custom tuning: step offsets in
 *  semitones from the root (floats welcome) → defineScale(NAME, [v…]).
 *
 *  A UNIT word may follow the name. Real tunings are published in cents
 *  (a pelog is `0 120 270 670 785`) or as frequency ratios (just intonation
 *  is `1 9/8 5/4 …`), and converting either to semitones by hand is how a
 *  tuning gets typed in wrong. `scaledef pelog cents 0 120 270 670 785`
 *  says what the numbers ARE, and `period:` gives the octave when the scale
 *  does not repeat at 2:1 — a Bohlen-Pierce is `period:1902`. */
export interface ScaleDefItem {
  t: 'scaledef'
  name: string
  values: number[]
  /** absent = semitones. */
  unit?: 'cents' | 'ratios'
  /** the repeat interval, in the same unit as `values`. */
  period?: number
  pos: Pos
}

/** `patdef NAME <notation>` — name a pattern so it is written once.
 *
 *  The gap this fills, measured on a real 472-line arrangement: 16% of the
 *  file was a repeat of a line already in it, one 333-character riff four
 *  times over. Editing that riff meant finding every copy, and missing one
 *  let two sections drift apart with nothing to say so.
 *
 *  Deliberately the same shape as `macro` / `curvedef` / `scaledef` /
 *  `wavedef`: the language already names numbers, curves, scales and
 *  wavetables, and a pattern was the one thing it could not name. */
export interface PatDefItem {
  t: 'patdef'
  name: string
  /** the notation, verbatim — substituted where the name is used. */
  notation: string
  /** buffer offset of the NOTATION (not the line). Substitution moves a
   *  play block's notation here, and note-flash highlights the text at the
   *  offset it is told — so without this it lit the reference, which is five
   *  characters long, with a figure that is ninety. */
  notationFrom: number
  pos: Pos
}

/** `wavedef NAME p1 p2 / p1 p2 p3 …` — register a custom wavetable:
 *  '/'-separated FRAMES of harmonic partial amplitudes (frames[f][i] =
 *  harmonic i+1) → defineWavetable(NAME, [[…], […]]). */
export interface WaveDefItem {
  t: 'wavedef'
  name: string
  frames: number[][]
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
  /** Sections this one plays ON TOP OF (`section main 8 with drums`).
   *
   *  Measured on a real arrangement: `intro2` repeated 4 of its 8 parts
   *  verbatim from `intro`, and `main` repeated 2 of 4 from `build`. A
   *  section that is "that one plus these" had to be written out in full,
   *  because `song` can only put sections in a ROW — nothing could put one
   *  on top of another.
   *
   *  This is both of the things that were missing at once: layering (a
   *  section that is only drums, stacked under several others) and variation
   *  (a section that is another plus two more parts). */
  with?: string[]
  pos: Pos
}

/** `song intro drop drop intro` — the section order. Optional: without it,
 *  sections play in definition order. */
export interface SongItem {
  t: 'song'
  order: string[]
  pos: Pos
}

/** `sing NAME [voice:WORD]` — a neural vocal. Body: alternating LYRIC and
 *  MELODY lines (sheet-music style, lyric above its notes), then modifier
 *  lines, then an optional `post` FX sub-block (same shape as a synth's). */
export interface SingBlock {
  t: 'sing'
  name: string
  voice?: string
  /** paired, in order: lyrics[i] sings notes[i]. */
  lyrics: { text: string; from: number }[]
  notes: { text: string; from: number }[]
  mods: Mod[]
  post?: Expr
  postBindings?: Binding[]
  pos: Pos
}

/** `macro bright 1480 500..7300 log` — a project-wide control. Declared once
 *  at the top level, then referenced BARE from any synth or post chain, so one
 *  knob moves every use site. Each site is free to scale it (`bright * 0.5`,
 *  `0.6 - bright / 7300 * 0.55`), which is how one knob drives several things
 *  at different ratios: a macro is a value, not a wire. The range is optional
 *  (the engine's param defaults apply without it). */
export interface MacroItem {
  t: 'macro'
  name: string
  def: number
  lo?: number
  hi?: number
  curve?: string
  /** Present when this was written `switch NAME A B`. A switch macro is still
   *  a macro — same registry, same one-control-many-destinations behaviour —
   *  so it shares this node rather than forking the whole top-level path. */
  values?: [number, number]
  pos: Pos
}

/** `curvedef swell .25 1 .75 .2` — a named curve SHAPE. Fractions are relative
 *  segment lengths, not durations: the shape is scaled where it is used, which
 *  is what lets one definition serve `env` (seconds) and a lane (cycles). A
 *  level may carry its own curve as `level:curve`, exactly as in `env`. */
export interface CurveDefItem {
  t: 'curvedef'
  name: string
  points: { frac: number; level: number; curve?: number }[]
  pos: Pos
}

export type TopItem =
  | SynthBlock | PlayBlock | CpsItem | TimeSigItem | RawItem
  | SidechainItem | MasterItem
  | StereoItem | LevelItem | PatDefItem | BusBlock | VisualItem
  | SectionBlock | SongItem | SingBlock | ScaleDefItem | WaveDefItem | MacroItem | CurveDefItem

export interface Program {
  items: TopItem[]
}

export interface RondoError {
  message: string
  line: number
  col: number
}
