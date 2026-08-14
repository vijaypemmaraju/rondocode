import { Fraction } from './fraction'
import { Pattern } from './pattern'
import { timeHash } from './rand'
// Side-effect import: installs euclid/degradeBy/fast/slow prototype methods
// used by the compiled patterns. Must stay even though nothing is bound.
import './combinators'

/**
 * Mini-notation: the terse Tidal/Strudel pattern syntax live-coders type
 * (`"bd(3,8) [sn sn] ~"`), compiled by a hand-written recursive-descent
 * parser into Pattern objects via the existing factories and combinators.
 *
 * Grammar (v1):
 *
 * ```text
 * pattern  := seq ((',' seq)+ | ('|' seq)+)?   -- stack OR choice, not both
 * seq      := group ('.' group)*               -- '.' makes equal-width groups
 * group    := (term | range | '_')+            -- timecat with weights
 * range    := number '..' number               -- inclusive run of steps
 * term     := atom mod*
 * atom     := word | number | '~'
 *           | '[' pattern (',' pattern)* ']'   -- subgroup; ',' stacks
 *           | '<' voice (',' voice)* '>'       -- alternation; ',' stacks
 *           | '{' seq (',' seq)* '}' ('%' int)?  -- polymeter
 * mod      := '*' arg | '/' arg | '!' int? | '@' number
 *           | '(' arg ',' arg (',' arg)? ')' | '?' number?
 * arg      := number | '[' … | '<' … | '{' …   -- patterned, not just literal
 * ```
 *
 * Decisions pinned by tests (see mini.test.ts):
 * - Words are `[a-zA-Z][a-zA-Z0-9._#:]*` — ':' included for sample
 *   indexing (`bd:3`), '#' and '.' for note/name spellings.
 * - Numbers are plain integers/floats with an optional leading '-'
 *   (`-12`, `0.25`, `.5`, `-.5`). Scientific notation is unsupported:
 *   `1e3` lexes as the number 1 followed by the word `e3`.
 * - Repeated mods of the same kind apply left to right; `!` ACCUMULATES, so
 *   each one adds its own copies (`a!2!3` is four a's, `a ! !` is three).
 * - Bare `!` duplicates once more (`"a! b"` = `"a a b"`, Tidal/Strudel).
 * - `_` elongates the previous step by one slot (`"a _ b"` = `"a@2 b"`).
 * - `*` / `/` factors and euclid arguments may be PATTERNS (`"a*[2 3]"`,
 *   `"a(<3 5>,8)"`), joined with innerBind so structure comes from the
 *   result. Literals are validated at parse time, so a bad one points at the
 *   character rather than throwing from inside a query.
 * - `!n` and `?p` consume their number only when it is ADJACENT to the
 *   mod character (`a!3`, `a?0.3`); with whitespace between, the number is
 *   an ordinary atom (`"a! 3"` = three steps a a 3). By contrast the
 *   mandatory-argument mods `*` `/` `@` `(` bind across whitespace
 *   (`"a * 2"` = `"a*2"`, Strudel-consistent) — only the OPTIONAL numbers
 *   of `!` and `?` require adjacency, because there the number could
 *   otherwise be a step of its own.
 * - Polymeter `{a b c, d e}%n`: every voice plays at n steps per cycle
 *   (default n = the FIRST voice's step count, i.e. its total weight); a
 *   k-step voice therefore loops every k/n cycles — Strudel semantics.
 * - `|` picks one seq per cycle via `floor(timeHash(cycle, seed 0) * n)`;
 *   deterministic and stable across queries, runs, and machines. The
 *   chosen seq is queried in place (outer timeline, no shifting).
 * - `?` degrades via `degradeBy(p, seed 0)` (default p = 0.5) — the same
 *   time-locked randomness stream as the combinator (see combinators.ts).
 *   The probability is clamped to [0,1]: `a?-1` keeps everything, `a?2`
 *   drops everything — never an error.
 * - Empty / whitespace-only source parses to silence.
 * - `..` expands an inclusive run of steps (`0 .. 3` IS `0 1 2 3`), counting
 *   down when the end is lower. It is lexed by a dedicated '..' rule that
 *   runs before the number and word rules, which is what the collision with
 *   '.' as a word character and as a number start (`.5`) demanded. Unlike
 *   Strudel we accept it unspaced too, since `0..3` reads fine and its only
 *   other meaning was a malformed-number error.
 * - `.` splits a seq into EQUAL-WIDTH groups (`0 . 1 2 . 3` is `[0] [1 2]
 *   [3]`). It binds tighter than `,` and `|`, so it needs none of their
 *   disambiguation: those split whole sequences, this one groups within.
 */

/** Half-open offset range [start, end) into the original source string. */
export interface Loc {
  readonly start: number
  readonly end: number
  /** The exact mini-notation source this loc indexes into. Lets the editor
   *  flash ONLY the originating literal, not every same-looking one (e.g. the
   *  stacked voices `q0`/`q1`/`q2`, which share offsets). Optional — locs built
   *  outside the parser omit it. */
  readonly src?: string
}

/**
 * A mini-notation value with its source location. Locations live in the
 * VALUES, so they survive every combinator transform — the editor uses
 * them to flash the originating text when the scheduler fires an event.
 * Only atoms (words / numbers) carry locs; groups have none of their own.
 */
export interface MiniValue {
  readonly value: string | number
  readonly loc: Loc
  /** Semitones from a trailing accidental on a NUMBER: `2#` is +1, `2b` is -1,
   *  `2##` is +2. Degrees are positions in a scale, so this is the only way to
   *  name a pitch the scale does not contain; see the note on `nAcc` in
   *  controls.ts for why it stays separate from the degree. */
  readonly acc?: number
  /** PER-NOTE LANES, from trailing `'…` suffixes on the atom.
   *
   *      0'2              the anonymous lane, `expr`
   *      0'gain:.8         a named lane
   *      0'2'gain:.8'chance:.5   chained, in any order
   *
   *  Named lanes let one note carry velocity, length, probability and an
   *  expression at once — the Live-11 cluster — without a parallel control
   *  pattern per property, which is the thing that loses track of which note
   *  it is talking about the moment the notation grows a subgroup.
   *
   *  Attached LEXICALLY to the note rather than carried on a parallel control
   *  pattern, which is the whole point. A modifier line (`amt: 2 0 1 3`) is a
   *  pattern in its own right and aligns by TIME, so the moment the notation
   *  grows a rest, a subgroup or an alternation the values stop corresponding
   *  to the notes — `0 ~ [3 5] 7` against `2 0 1 3` gives BOTH subgroup notes
   *  the same value and feeds one to the rest. A value written on the note
   *  survives all of that, because it never leaves the note. */
  readonly lanes?: Readonly<Record<string, number>>
}

/** Quote a source string for the error header, truncated for huge inputs. */
const quoteSrc = (src: string): string =>
  JSON.stringify(src.length > 60 ? `${src.slice(0, 57)}…` : src)

/**
 * The line containing `pos` with a caret under the offending column.
 * Line-relative: multiline sources show only the erring line. Long lines
 * are windowed to ~60 chars around pos ('…' marks a cut edge). The caret
 * padding mirrors the line's tabs so it stays aligned under tab stops.
 */
const caretSnippet = (src: string, pos: number): string => {
  const p = Math.max(0, Math.min(pos, src.length))
  const lineStart = src.lastIndexOf('\n', p - 1) + 1
  const nl = src.indexOf('\n', p)
  let line = src.slice(lineStart, nl === -1 ? src.length : nl)
  let col = p - lineStart
  const WINDOW = 60
  if (line.length > WINDOW) {
    const from = Math.max(0, Math.min(col - WINDOW / 2, line.length - WINDOW))
    const to = Math.min(line.length, from + WINDOW)
    const pre = from > 0 ? '…' : ''
    const post = to < line.length ? '…' : ''
    line = pre + line.slice(from, to) + post
    col = col - from + pre.length
  }
  const pad = line.slice(0, col).replace(/[^\t]/g, ' ')
  return `${line}\n${pad}^`
}

/**
 * A mini-notation parse error: carries the offset of the offending token
 * (`pos`, always a raw offset into the FULL source), the source string
 * (`src`), and a human/agent-readable message with a caret-context
 * snippet showing the erring line only:
 *
 * ```text
 * unexpected ']' at position 4 in "a b ]"
 * a b ]
 *     ^
 * ```
 */
export class MiniError extends Error {
  override readonly name = 'MiniError'
  readonly pos: number
  readonly src: string

  constructor(what: string, pos: number, src: string) {
    super(
      `${what} at position ${pos} in ${quoteSrc(src)}\n${caretSnippet(src, pos)}`,
    )
    this.pos = pos
    this.src = src
  }
}

// ---------------------------------------------------------------- tokenizer

interface Tok {
  readonly kind: 'word' | 'number' | 'punct'
  readonly text: string
  /** Numeric value; only meaningful when kind === 'number'. */
  readonly value: number
  readonly start: number
  readonly end: number
  /** Semitones from a trailing accidental run (`2#` → 1, `2b` → -1). */
  readonly acc?: number
  /** Values of the trailing `'…` lane suffixes (`0'2'gain:.8`). */
  readonly lanes?: Record<string, number>
}

const PUNCT = new Set('[]<>{}(),|*/!@?%~_.')

/** The lane a bare `'2` writes to. Named so the mapping is stated once. */
export const DEFAULT_LANE = 'expr'

/** Read a signed decimal at `j`; returns the end index, or j when there is none. */
function readNum(src: string, j: number): number {
  let i = j
  if (src[i] === '-') i++
  const digits = i
  while (isDigit(src[i] ?? '')) i++
  if (src[i] === '.') { i++; while (isDigit(src[i] ?? '')) i++ }
  return i === digits ? j : i
}

/**
 * Read the run of `'…` lane suffixes at `k`.
 *
 * `'2` is the anonymous lane; `'name:2` is a named one; they chain in any
 * order (`0'2'gain:.8'chance:.5`). `'` is deliberately neither punctuation nor
 * a word character, so it can only ever mean this. Values are plain signed
 * decimals — no expressions — so a widget can find one, rewrite it, and never
 * have to parse.
 */
function readLanes(src: string, k: number): { lanes: Record<string, number>; next: number } | undefined {
  const lanes: Record<string, number> = {}
  let i = k
  let found = false
  while (src[i] === "'") {
    const afterQuote = i + 1
    // `'name:value`
    let j = afterQuote
    while (/[a-zA-Z]/.test(src[j] ?? '')) j++
    if (j > afterQuote && src[j] === ':') {
      const name = src.slice(afterQuote, j)
      const end = readNum(src, j + 1)
      if (end === j + 1) break // `'gain:` with no number is not a lane
      lanes[name] = parseFloat(src.slice(j + 1, end))
      i = end
      found = true
      continue
    }
    // `'value`
    const end = readNum(src, afterQuote)
    if (end === afterQuote) break // a lone quote is not a lane
    lanes[DEFAULT_LANE] = parseFloat(src.slice(afterQuote, end))
    i = end
    found = true
  }
  return found ? { lanes, next: i } : undefined
}
const isSpace = (c: string): boolean => /\s/.test(c)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isWordStart = (c: string): boolean => /[a-zA-Z]/.test(c)
const isWordChar = (c: string): boolean => /[a-zA-Z0-9._#:]/.test(c)

/** Position-preserving tokenizer: every token knows its [start, end). */
function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (isSpace(c)) {
      i++
      continue
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < src.length && isWordChar(src[j]!)) j++
      // a word takes the same `'value` suffix a number does, so an absolute
      // note (`c4'2`) and a drum hit (`kick'2`) carry expression too
      const wex = readLanes(src, j)
      if (wex !== undefined) {
        toks.push({ kind: 'word', text: src.slice(i, j), value: NaN, start: i, end: wex.next, lanes: wex.lanes })
        i = wex.next
        continue
      }
      toks.push({ kind: 'word', text: src.slice(i, j), value: NaN, start: i, end: j })
      i = j
      continue
    }
    const c1 = src[i + 1] ?? ''
    /* '..' before everything else that can start with a dot. It cannot be a
     * number ('..' has no digit after the dot) and a word never STARTS with
     * one, so the only rule it could lose to is the single-'.' punct. */
    if (c === '.' && c1 === '.') {
      toks.push({ kind: 'punct', text: '..', value: NaN, start: i, end: i + 2 })
      i += 2
      continue
    }
    if (
      isDigit(c) ||
      ((c === '-' || c === '.') && isDigit(c1)) ||
      (c === '-' && c1 === '.' && isDigit(src[i + 2] ?? ''))
    ) {
      let j = i
      if (src[j] === '-') j++
      while (j < src.length && isDigit(src[j]!)) j++
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        j++
        while (j < src.length && isDigit(src[j]!)) j++
      }
      // A second decimal point directly attached (e.g. `1.2.3`, `0.5.5`) is a
      // malformed number, NOT the start of a new atom — otherwise a typo'd
      // decimal would silently ADD a step to the sequence (`0.5.5` → 0.5 0.5).
      // '..' after a number is the RANGE operator, not a second decimal
      // point: `0..3` and `0.5..2` end the number here and lex '..' next.
      if (src[j] === '.' && src[j + 1] !== '.') {
        throw new MiniError('malformed number (extra decimal point)', j, src)
      }
      const text = src.slice(i, j)
      // A trailing `#`/`b` run is an ACCIDENTAL on this degree: `2#`, `2bb`.
      // Only when nothing word-ish follows, so `2bd` stays the number 2 and
      // the sample name `bd` rather than becoming a flat and a stray `d`.
      let acc = 0
      let k = j
      while (src[k] === '#' || src[k] === 'b') { acc += src[k] === '#' ? 1 : -1; k++ }
      if (k > j && isWordChar(src[k] ?? '')) { acc = 0; k = j }
      const ex = readLanes(src, k)
      if (ex !== undefined) {
        toks.push({ kind: 'number', text: src.slice(i, ex.next), value: parseFloat(text), start: i, end: ex.next, acc, lanes: ex.lanes })
        i = ex.next
        continue
      }
      toks.push({ kind: 'number', text: src.slice(i, k), value: parseFloat(text), start: i, end: k, acc })
      i = k
      continue
    }
    if (PUNCT.has(c)) {
      toks.push({ kind: 'punct', text: c, value: NaN, start: i, end: i + 1 })
      i++
      continue
    }
    throw new MiniError(`unexpected character '${c}'`, i, src)
  }
  return toks
}

// ------------------------------------------------------------------- parser

/** One step of a seq: a pattern plus its timecat weight. */
interface Entry {
  weight: number
  pat: Pattern<MiniValue>
}

/**
 * Random choice per cycle: index = floor(timeHash(cycle, seed 0) * n).
 * The chosen pattern is queried in place (no timeline shifting) — for the
 * single-cycle seqs `|` joins, in-place and shifted are indistinguishable.
 */
const randcat = <T>(pats: Pattern<T>[], weights?: number[]): Pattern<T> =>
  new Pattern<T>((span) => {
    const cycle = span.begin.sam()
    const i = weights === undefined
      ? Math.min(Math.floor(timeHash(cycle, 0) * pats.length), pats.length - 1)
      : weightedIndex(timeHash(cycle, 0), weights)
    return pats[i]!.query(span)
  }).splitQueries()

/**
 * Pick an index from `weights` given one uniform draw in [0, 1).
 *
 * Walks the cumulative total, which reduces EXACTLY to the unweighted
 * `floor(r * n)` when every weight is 1 -- deliberately, so adding weights
 * cannot change what an existing `a | b | c` chooses on any cycle.
 */
const weightedIndex = (r: number, weights: number[]): number => {
  // every weight is > 0 (see the `@` parser), so `acc < 0` and `acc <= 0`
  // pick the same index: acc can only reach exactly 0 before a subtraction
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = r * total
  for (let i = 0; i < weights.length - 1; i++) {
    acc -= weights[i]!
    if (acc < 0) return i
  }
  return weights.length - 1
}

class Parser {
  private i = 0
  /** Every atom in parse order — the `n` tag validates against this. */
  readonly atoms: { value: string | number; loc: Loc }[] = []

  constructor(
    private readonly toks: Tok[],
    private readonly src: string,
  ) {}

  private peek(): Tok | undefined {
    return this.toks[this.i]
  }

  private next(): Tok | undefined {
    return this.toks[this.i++]
  }

  /** Error at an explicit position, or at the current token / EOF. */
  private err(what: string, pos?: number): never {
    throw new MiniError(what, pos ?? this.peek()?.start ?? this.src.length, this.src)
  }

  /** Error naming whatever sits at the cursor (or end of input). */
  private errUnexpected(): never {
    const t = this.peek()
    if (t === undefined) this.err('unexpected end of input')
    this.err(`unexpected '${t.text}'`, t.start)
  }

  private isPunct(t: Tok | undefined, ch: string): boolean {
    return t !== undefined && t.kind === 'punct' && t.text === ch
  }

  private expectPunct(ch: string, context: string): void {
    if (!this.isPunct(this.peek(), ch)) this.err(`expected '${ch}' ${context}`)
    this.next()
  }

  /**
   * A number used as a MODIFIER ARGUMENT must not carry a note's decorations.
   *
   * `'name:value` lane suffixes are attached by the tokenizer to the number it
   * just read, so in `0@2'rel:.5` the nearest number is the WEIGHT — the lane
   * lands on `2`, the parser reads the weight's value, and the lane is thrown
   * away. It was silent, which is the worst way for it to fail: the notation
   * is there, the note plays, and the param never moves, so the search starts
   * in the synth. Same for a trailing accidental (`0@2#`).
   *
   * Lanes belong to the note, and the note is to the LEFT of every modifier:
   * `0'rel:.5@2` is the same term and works.
   */
  private refuseDecoratedArg(t: Tok, op: string): void {
    const lane = t.lanes === undefined ? undefined : Object.keys(t.lanes)[0]
    if (lane !== undefined) {
      const shown = lane === DEFAULT_LANE ? `'${t.lanes![lane]!}` : `'${lane}:${t.lanes![lane]!}`
      this.err(
        `${shown} is a lane on the NOTE, but here it is attached to the argument of '${op}'. `
        + `Write the lane directly after the note instead: '0${shown}${op}…'`,
        t.start,
      )
    }
    if ((t.acc ?? 0) !== 0) {
      this.err(`an accidental belongs to the NOTE, not to the argument of '${op}'`, t.start)
    }
  }

  private isTermStart(t: Tok): boolean {
    if (t.kind === 'word' || t.kind === 'number') return true
    return t.kind === 'punct' && (t.text === '~' || t.text === '[' || t.text === '<' || t.text === '{')
  }

  // ------------------------------------------------------------ productions

  /** Whole source: empty is silence; anything unconsumed is an error. */
  parseTop(): Pattern<MiniValue> {
    if (this.toks.length === 0) return Pattern.silence
    const pat = this.parsePattern()
    if (this.peek() !== undefined) this.errUnexpected()
    return pat
  }

  /** pattern := seq ('|' seq)* */
  /** pattern := seq ((',' seq)+ | ('|' seq)+)? — a stack OR a choice, never
   *  both at one level.
   *
   *  That restriction is Strudel's, not ours: its `stack_or_choose` takes a
   *  head sequence followed by ONE of a comma tail, a pipe tail or a dot tail,
   *  so `0|1, 2` is a parse error there. We briefly accepted it and invented a
   *  precedence (`|` tighter than `,`) — which is a fine reading and a
   *  divergence, so a program that worked here would not work in Strudel. The
   *  fix is to say which grouping you meant: `[0|1], 2`. */
  private parsePattern(): Pattern<MiniValue> {
    const head = this.parseSeqWeighted()
    if (this.isPunct(this.peek(), ',')) {
      const parts = [head.pat]
      while (this.isPunct(this.peek(), ',')) {
        this.next()
        parts.push(this.parseSeq())
      }
      this.refuseMixed('|', ',')
      return Pattern.stack(...parts)
    }
    if (this.isPunct(this.peek(), '|')) {
      /* WEIGHTED CHOICE. `a@3 | b` picks a three times as often. The weight is
       * the one an alternative carries as a whole (see parseSeqWeighted),
       * which until now parsed and did nothing at all -- in Strudel too,
       * measured at an even split for `a@3 | b`. Giving it the obvious meaning
       * costs no syntax and reuses the character that already means weight.
       *
       * Without any `@` this is bit-for-bit the old uniform choice: see
       * weightedIndex. */
      const seqs = [head]
      while (this.isPunct(this.peek(), '|')) {
        this.next()
        seqs.push(this.parseSeqWeighted())
      }
      this.refuseMixed(',', '|')
      // no zero or negative guard needed: `@` already refuses anything <= 0,
      // so every weight arriving here is positive
      const weights = seqs.map((s) => s.weight)
      const uniform = weights.every((w) => w === 1)
      return randcat(seqs.map((s) => s.pat), uniform ? undefined : weights)
    }
    return head.pat
  }

  /** `,` and `|` do not mix at one level — say which grouping was meant. */
  private refuseMixed(found: ',' | '|', already: ',' | '|'): void {
    const t = this.peek()
    if (!this.isPunct(t, found)) return
    const what = (c: string): string => (c === ',' ? "',' (stack)" : "'|' (choice)")
    this.err(
      `${what(found)} and ${what(already)} cannot be mixed at the same level. `
      + `Bracket the one you meant to group first, e.g. '[0|1], 2'`,
      t!.start,
    )
  }

  /**
   * `a .. b` — the inclusive integer run between two number atoms, expanded
   * into ordinary steps: `0 .. 3` IS `0 1 2 3`, and counts down when b < a.
   * The step is 1 from `a`, so a fractional start keeps its fraction
   * (`0.5 .. 2` is `0.5 1.5`), which is the only reading that leaves `a`
   * itself in the run.
   *
   * The run is ONE term, not a row of siblings: `0 .. 3 5` is `[0 1 2 3] 5`,
   * two halves. Sibling steps would make the length of a range re-time
   * everything around it, so appending `.. 15` to one note would squash the
   * rest of the bar to a seventeenth each. A term keeps the edit local, and it
   * is the only reading that stays the same in a seq, a subgroup and an
   * alternation.
   *
   * Returns undefined when the cursor is not at `number '..'`, so callers can
   * fall through to parsing an ordinary term.
   */
  private tryRange(): Entry | undefined {
    const a = this.peek()
    if (a === undefined || a.kind !== 'number') return undefined
    const dots = this.toks[this.i + 1]
    if (dots === undefined || dots.kind !== 'punct' || dots.text !== '..') return undefined
    this.next()
    this.next()
    const b = this.peek()
    if (b === undefined || b.kind !== 'number') {
      this.err(`'..' needs a number on both sides`, dots.start)
    }
    this.next()
    /* An accidental or a lane on an endpoint would have to apply to every
     * generated step or to none, and both are guesses — so say so instead of
     * picking one silently. */
    for (const t of [a, b]) {
      if ((t.acc ?? 0) !== 0 || t.lanes !== undefined) {
        this.err(`a '..' endpoint cannot carry an accidental or a lane`, t.start)
      }
    }
    const step = b.value < a.value ? -1 : 1
    const span = Math.floor(Math.abs(b.value - a.value)) + 1
    const LIMIT = 1024
    if (span > LIMIT) {
      this.err(`'..' range of ${span} steps is too long (limit ${LIMIT})`, dots.start)
    }
    /* Every generated step points at the WHOLE `a .. b` source, so the editor
     * flashes the range that produced the note rather than one of its ends. */
    const loc = { start: a.start, end: b.end }
    const steps: [number, Pattern<MiniValue>][] = []
    for (let k = 0; k < span; k++) {
      steps.push([1, this.mkAtom(a.value + step * k, loc)])
    }
    return { weight: 1, pat: Pattern.timecat(steps) }
  }

  /**
   * seq := group ('.' group)*, as a weighted timecat.
   *
   * `.` splits the sequence into EQUAL-WIDTH groups, so it is bracketing
   * without the brackets: `0 . 1 2 . 3` is `[0] [1 2] [3]`, three thirds of a
   * cycle rather than four quarters. It binds tighter than `,` and `|`, which
   * split whole sequences — `0 . 1, 2` stacks the dotted sequence against 2 —
   * so unlike that pair it needs no disambiguation.
   */
  private parseSeq(): Pattern<MiniValue> {
    return this.parseSeqWeighted().pat
  }

  /**
   * A seq, plus the weight it carries as a whole.
   *
   * A weight on a seq's ONLY top-level term is meaningless in the seq itself:
   * `timecat([[3, p]])` and `timecat([[1, p]])` both give p the whole cycle. So
   * `a@3` alone has always parsed and always done nothing, which is exactly
   * the slot a choice weight can occupy without ambiguity -- see the `|`
   * branch of parsePattern. Anything else (several terms, or `.` groups)
   * weighs 1: there the `@` is already doing its normal job INSIDE the seq.
   */
  private parseSeqWeighted(): { pat: Pattern<MiniValue>; weight: number } {
    const flat = (es: Entry[]): Pattern<MiniValue> =>
      Pattern.timecat(es.map((e) => [e.weight, e.pat]))
    let group = this.parseSeqEntries()
    if (!this.isPunct(this.peek(), '.')) {
      return { pat: flat(group), weight: group.length === 1 ? group[0]!.weight : 1 }
    }
    return { pat: this.parseDotGroups(group), weight: 1 }
  }

  private parseDotGroups(group: Entry[]): Pattern<MiniValue> {
    const flat = (es: Entry[]): Pattern<MiniValue> =>
      Pattern.timecat(es.map((e) => [e.weight, e.pat]))
    const groups: Pattern<MiniValue>[] = []
    for (;;) {
      groups.push(flat(group))
      if (!this.isPunct(this.peek(), '.')) break
      this.next()
      group = this.parseSeqEntries()
    }
    return Pattern.timecat(groups.map((g) => [1, g]))
  }

  /**
   * Collect a seq's entries. `_` elongates the previous entry by one slot;
   * `!n` repetition expands to n entries. Errors if the seq is empty
   * (callers that allow emptiness — the top level — never reach here).
   */
  private parseSeqEntries(): Entry[] {
    const entries: Entry[] = []
    for (;;) {
      const t = this.peek()
      if (t === undefined) break
      if (this.isPunct(t, '_')) {
        const last = entries[entries.length - 1]
        if (last === undefined) this.err(`'_' must follow a term`, t.start)
        this.next()
        last.weight += 1
        continue
      }
      if (!this.isTermStart(t)) break
      const range = this.tryRange()
      if (range !== undefined) {
        entries.push(range)
        continue
      }
      const { pat, weight, reps } = this.parseTerm()
      for (let k = 0; k < reps; k++) entries.push({ weight, pat })
    }
    if (entries.length === 0) this.errUnexpected()
    return entries
  }

  /** term := atom mod* — returns the pattern plus seq-level weight/reps. */
  private parseTerm(): { pat: Pattern<MiniValue>; weight: number; reps: number } {
    let pat = this.parseAtom()
    let weight = 1
    let reps = 1
    for (;;) {
      const t = this.peek()
      if (t === undefined || t.kind !== 'punct') break
      if (t.text === '*' || t.text === '/') {
        this.next()
        const arg = this.parseArg(t.text, false)
        const base = pat
        const op = t.text
        pat = this.applyArgs([arg], ([k]) => (op === '*' ? base.fast(k!) : base.slow(k!)))
      } else if (t.text === '!') {
        this.next()
        const num = this.peek()
        if (num !== undefined && num.kind === 'number' && num.start === t.end) {
          if (!Number.isInteger(num.value) || num.value < 1) {
            this.err(`count for '!' must be a positive integer`, num.start)
          }
          this.refuseDecoratedArg(num, '!')
          this.next()
          /* ACCUMULATE, do not assign. `!` can appear more than once on a
           * term — `0 ! !` is three copies — and assigning meant the second
           * one overwrote the first, so every `!` after the first was read
           * and then silently thrown away. `!n` contributes n-1 EXTRA copies
           * on top of the term itself, which makes `0!2!2` three and `0!3`
           * three, both matching Tidal. */
          reps += num.value - 1
        } else {
          reps += 1 // bare '!': one extra copy (Tidal: "a! b" = "a a b")
        }
      } else if (t.text === '@') {
        this.next()
        const num = this.peek()
        if (num === undefined || num.kind !== 'number') {
          this.err(`expected a number after '@'`)
        }
        if (!(num.value > 0)) this.err(`weight for '@' must be positive`, num.start)
        this.refuseDecoratedArg(num, '@')
        this.next()
        weight = num.value
      } else if (t.text === '(') {
        this.next()
        pat = this.parseEuclid(pat)
      } else if (t.text === '?') {
        this.next()
        let p = 0.5
        const num = this.peek()
        if (num !== undefined && num.kind === 'number' && num.start === t.end) {
          this.refuseDecoratedArg(num, '?')
          this.next()
          p = Math.min(1, Math.max(0, num.value)) // clamp: contract is [0,1]
        }
        pat = pat.degradeBy(p, 0)
      } else {
        break
      }
    }
    return { pat, weight, reps }
  }

  /**
   * The argument of `*`, `/` or a euclid slot: a positive number, or a
   * PATTERN of them (`[2 3]`, `<2 3>`, `{2 3}%4`).
   *
   * A patterned argument is what makes the operators live: `0*<2 3>` doubles
   * on one cycle and triples on the next, and `0(<3 5>,8)` walks between two
   * Euclidean figures. It was deferred while `parseFactor` demanded a literal,
   * which meant the one thing you would reach for after learning `*` was a
   * syntax error.
   */
  private parseArg(op: string, wantInt: boolean): number | Pattern<MiniValue> {
    // euclid names its slots; '*' and '/' name themselves
    const where = wantInt ? 'in euclid arguments' : `after '${op}'`
    const kind = wantInt ? 'an integer' : 'a number'
    const t = this.peek()
    if (t !== undefined && t.kind === 'number') {
      this.refuseDecoratedArg(t, op)
      this.next()
      this.checkArg(op, wantInt, t.value, t.start)
      return t.value
    }
    if (t !== undefined && t.kind === 'punct' && (t.text === '[' || t.text === '<' || t.text === '{')) {
      /* Validate the LITERALS the group contributes, at parse time, so a bad
       * factor points at the offending character instead of throwing from
       * inside a query with no source to show. `atoms` grows in parse order,
       * so the ones this group added are exactly the new tail. */
      const from = this.atoms.length
      const pat = this.parseAtom()
      for (const a of this.atoms.slice(from)) {
        if (typeof a.value !== 'number') {
          this.err(`expected ${kind} ${where}, but this group has '${String(a.value)}'`, a.loc.start)
        }
        this.checkArg(op, wantInt, a.value, a.loc.start)
      }
      return pat
    }
    this.err(`expected ${kind} (or a pattern of them) ${where}`)
  }

  /** The contract every `*` / `/` / euclid argument shares. */
  private checkArg(op: string, wantInt: boolean, v: number, pos: number): void {
    if (wantInt) {
      if (!Number.isInteger(v)) this.err(`expected an integer in euclid arguments, not ${v}`, pos)
      return
    }
    if (!(v > 0)) this.err(`factor for '${op}' must be positive`, pos)
  }

  /**
   * Apply `f` once the patterned arguments have been resolved to numbers.
   *
   * Each patterned argument is joined with `innerBind`, which takes structure
   * from the RESULT rather than the argument: in `0*[2 3]` the second half of
   * the cycle is genuinely running at triple speed, clipped to that half,
   * rather than the whole being re-divided. Scalars short-circuit, so an
   * ordinary `0*2` builds precisely the pattern it always did.
   */
  private applyArgs(
    args: readonly (number | Pattern<MiniValue>)[],
    f: (vals: number[]) => Pattern<MiniValue>,
  ): Pattern<MiniValue> {
    const i = args.findIndex((a) => typeof a !== 'number')
    if (i === -1) return f(args as number[])
    return (args[i] as Pattern<MiniValue>).innerBind((v) => {
      const next = args.slice()
      next[i] = typeof v === 'object' && v !== null ? (v as MiniValue).value as number : (v as number)
      return this.applyArgs(next, f)
    })
  }

  /** '(' already consumed: arg ',' arg (',' arg)? ')' -> euclid. Each
   *  argument may itself be a pattern (`bd(<3 5>,8)`). */
  private parseEuclid(pat: Pattern<MiniValue>): Pattern<MiniValue> {
    const at = this.peek()?.start
    const pulses = this.parseArg('euclid', true)
    this.expectPunct(',', 'between euclid arguments')
    const stepsAt = this.peek()?.start
    const steps = this.parseArg('euclid', true)
    if (typeof steps === 'number' && steps < 1) this.err(`euclid steps must be >= 1`, stepsAt)
    let rotation: number | Pattern<MiniValue> = 0
    if (this.isPunct(this.peek(), ',')) {
      this.next()
      rotation = this.parseArg('euclid', true)
    }
    this.expectPunct(')', 'to close euclid arguments')
    return this.applyArgs([pulses, steps, rotation], ([p, st, r]) => {
      /* A patterned `steps` can only be checked once it has a value, and a
       * query is the wrong place to throw — clamp to the smallest legal
       * figure, which is what an empty one would sound like anyway. */
      if (!(st! >= 1)) return Pattern.silence
      /* A NEGATIVE pulse count is the COMPLEMENT: `a(-3,8)` plays the five
       * slots `a(3,8)` leaves empty, which is how you write the counter-rhythm
       * to a figure without restating it. Strudel reads it the same way.
       *
       * It used to fall through to `euclid`, where bjorklund answers "pulses
       * <= 0 means all rests" -- so the whole line went silent with no error,
       * and the only clue was that nothing played. */
      return p! < 0 ? pat.euclidInv(-p!, st!, r!) : pat.euclid(p!, st!, r!)
    })
  }

  /** Record an atom (the `n` tag validates against the list) and build its pattern. */
  private mkAtom(value: string | number, loc: Loc, acc = 0, lanes?: Record<string, number>): Pattern<MiniValue> {
    // Stamp the source so the editor can flash exactly this literal (see Loc).
    const located: Loc = { start: loc.start, end: loc.end, src: this.src }
    const base = acc === 0 ? { value, loc: located } : { value, loc: located, acc }
    const v: MiniValue = lanes === undefined ? base : { ...base, lanes }
    this.atoms.push(v)
    return Pattern.pure(v)
  }

  /** atom := word | number | '~' | '[' ... | '<' ... | '{' ... */
  private parseAtom(): Pattern<MiniValue> {
    const t = this.peek()
    if (t === undefined) this.errUnexpected()
    if (t.kind === 'word' || t.kind === 'number') {
      this.next()
      return this.mkAtom(t.kind === 'word' ? t.text : t.value, {
        start: t.start,
        end: t.end,
      }, t.acc ?? 0, t.lanes)
    }
    if (t.text === '~') {
      this.next()
      return Pattern.silence
    }
    if (t.text === '[') return this.parseSubgroup()
    if (t.text === '<') return this.parseAlternation()
    if (t.text === '{') return this.parsePolymeter()
    this.errUnexpected()
  }

  /** '[' pattern ']' — the ',' stacking lives in parsePattern now, so a
   *  subgroup is just a bracketed pattern. */
  private parseSubgroup(): Pattern<MiniValue> {
    const open = this.next()! // '['
    if (this.isPunct(this.peek(), ']')) this.err(`empty '[]'`, open.start)
    const pat = this.parsePattern()
    if (this.peek() === undefined) this.err(`unclosed '['`, open.start)
    this.expectPunct(']', 'to close the subgroup')
    return pat
  }

  /**
   * '<' voice (',' voice)* '>' — each voice takes one term per cycle, and the
   * voices run TOGETHER: `<a b, c d>` is a with c, then b with d.
   */
  private parseAlternation(): Pattern<MiniValue> {
    const open = this.next()! // '<'
    if (this.isPunct(this.peek(), '>')) this.err(`empty '<>'`, open.start)
    /* THE COMMA STACKS, it does not need bracketing. Strudel's grammar defers
     * `<…>` to the same stack-capable rule `{…}` uses (slow_sequence ->
     * polymeter_stack), so this is parity, not an extension. We used to reject
     * it with a message telling the reader to write `<[0,2] [4,6]>` instead —
     * which is a DIFFERENT pattern (alternating between two chords, rather
     * than two rotations running at once), so the advice was wrong as well as
     * unnecessary. */
    const voices: Pattern<MiniValue>[] = []
    for (;;) {
      voices.push(this.altVoice())
      if (!this.isPunct(this.peek(), ',')) break
      this.next()
    }
    if (this.peek() === undefined) this.err(`unclosed '<'`, open.start)
    this.expectPunct('>', 'to close the alternation')
    return voices.length === 1 ? voices[0]! : Pattern.stack(...voices)
  }

  /**
   * One voice of an alternation: `term+`, one term per cycle. `!n` repetition
   * adds copies to the rotation, and `@n` gives a term n cycles' WIDTH:
   * `<0@3 4>` sustains 0 across three cycles, then plays 4 for one.
   *
   * Weighted alternation is a `timecat` slowed to the total weight, which is
   * what Strudel does and the only reading consistent with `@` elsewhere: in
   * `[0@3 4]` the weight divides ONE cycle, so in `<0@3 4>` it divides the
   * rotation, with a cycle as the unit. An earlier fix here pushed n COPIES
   * into the rotation instead, which re-articulates the term every cycle —
   * three separate notes where the notation asks for one long one, and no way
   * at all to write a sustain. Unweighted alternations are unaffected: every
   * weight is 1, and timecat over n equal parts slowed by n is exactly
   * one-per-cycle.
   */
  private altVoice(): Pattern<MiniValue> {
    const parts: [number, Pattern<MiniValue>][] = []
    for (;;) {
      const t = this.peek()
      if (t === undefined) break
      /* `_` extends the previous term by a cycle, exactly as it extends by a
       * slot inside a seq — `<0 _ 1>` is `<0@2 1>`. It was rejected here only
       * because this loop asked for a term and `_` is not one, which made `_`
       * the single piece of notation that worked everywhere but here. */
      if (this.isPunct(t, '_')) {
        const last = parts[parts.length - 1]
        if (last === undefined) this.err(`'_' must follow a term`, t.start)
        this.next()
        last[0] += 1
        continue
      }
      if (!this.isTermStart(t)) break
      const range = this.tryRange()
      if (range !== undefined) {
        parts.push([range.weight, range.pat])
        continue
      }
      const at = t.start
      const { pat, weight, reps } = this.parseTerm()
      if (!(weight > 0)) this.err(`'@${weight}' must be greater than 0`, at)
      // `!n` is repetition — n separate turns in the rotation — while `@n` is
      // width. They compose: `0!2@3` takes two turns of three cycles each.
      for (let k = 0; k < reps; k++) parts.push([weight, pat])
    }
    if (parts.length === 0) this.errUnexpected()
    const total = parts.reduce((n, [w]) => n + w, 0)
    // all-equal weights: timecat over n parts slowed by n IS cat, but go
    // through cat anyway so the common path keeps its exact identity
    if (parts.every(([w]) => w === 1)) return Pattern.cat(...parts.map(([, p]) => p))
    return Pattern.timecat(parts).slow(total)
  }

  /**
   * '{' seq (',' seq)* '}' ('%' int)? — every voice plays at `base` steps
   * per cycle (base = first voice's step count, i.e. its total weight,
   * unless '%n' overrides), each voice cycling through its own steps
   * independently: a k-step voice loops every k/base cycles.
   */
  private parsePolymeter(): Pattern<MiniValue> {
    const open = this.next()! // '{'
    if (this.isPunct(this.peek(), '}')) this.err(`empty '{}'`, open.start)
    const voices = [this.parseSeqEntries()]
    while (this.isPunct(this.peek(), ',')) {
      this.next()
      voices.push(this.parseSeqEntries())
    }
    if (this.peek() === undefined) this.err(`unclosed '{'`, open.start)
    this.expectPunct('}', 'to close the polymeter')
    // Weights are always positive here ('@' validates > 0, '_' only adds),
    // so a voice's step count is the plain weight sum.
    const stepsOf = (entries: Entry[]): number =>
      entries.reduce((acc, e) => acc + e.weight, 0)
    let base = stepsOf(voices[0]!)
    if (this.isPunct(this.peek(), '%')) {
      this.next()
      const num = this.peek()
      if (
        num === undefined ||
        num.kind !== 'number' ||
        !Number.isInteger(num.value) ||
        num.value < 1
      ) {
        this.err(`expected a positive integer after '%'`)
      }
      this.refuseDecoratedArg(num, '%')
      this.next()
      base = num.value
    }
    return Pattern.stack(
      ...voices.map((entries) =>
        Pattern.timecat(entries.map((e): [number, Pattern<MiniValue>] => [e.weight, e.pat])).fast(
          Fraction.fromNumber(base).div(Fraction.fromNumber(stepsOf(entries))),
        ),
      ),
    )
  }
}

// --------------------------------------------------------------- public API

/**
 * Parse mini-notation returning both the loc-carrying pattern and the flat
 * list of atoms in source order. The atom list is how EAGER validation
 * works (querying a pattern cannot enumerate atoms hidden in alternations):
 * the `n` tag and the control entry points (controls.ts) walk it to reject
 * non-numeric / non-note atoms at parse time with a positioned MiniError.
 */
export function miniParse(src: string): {
  pattern: Pattern<MiniValue>
  atoms: { value: string | number; loc: Loc }[]
} {
  const parser = new Parser(tokenize(src), src)
  return { pattern: parser.parseTop(), atoms: parser.atoms }
}

const parse = miniParse

/**
 * Parse mini-notation keeping source locations: every hap's value is a
 * {@link MiniValue} pairing the raw word/number with its [start, end)
 * offsets in `src`. This is the editor-facing form — locs travel inside
 * values, so they survive arbitrary combinator transforms downstream.
 */
export function miniLoc(src: string): Pattern<MiniValue> {
  return parse(src).pattern
}

/**
 * Parse mini-notation into a plain value pattern: `miniLoc` with the
 * locations stripped. `mini('a b c')` is the everyday form.
 */
export function mini(src: string): Pattern<string | number> {
  return miniLoc(src).withValue((v) => v.value)
}

const assemble = (
  strings: TemplateStringsArray,
  values: (string | number)[],
): string =>
  strings.reduce((acc, s, i) => (i === 0 ? s : acc + String(values[i - 1]) + s), '')

/**
 * Template-tag form of {@link mini}: `` m`a b c` ``. Interpolations are
 * stringified into the source before parsing.
 *
 * STRUCTURAL SPLICE HAZARD: interpolations are spliced as SOURCE TEXT,
 * not as opaque atoms. A string containing mini punctuation — `]`, `|`,
 * `,`, whitespace, brackets — alters the pattern's structure:
 * `` m`[a ${'x, y'}]` `` parses as the stack `[a x, y]`, and an
 * interpolated stray closer throws a {@link MiniError}. This is by
 * design (interpolating sub-patterns is legitimate); when a value must
 * stay a single atom, sanitize it first. All locs and error positions
 * refer to the ASSEMBLED string, not the literal parts.
 */
export function m(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): Pattern<string | number> {
  return mini(assemble(strings, values))
}

/**
 * Numeric template tag: `` n`0 3 5` `` parses like {@link m} but asserts
 * every atom is a number, throwing a {@link MiniError} at the offending
 * atom's location otherwise. Returns a loc-stripped Pattern<number> —
 * the natural form for note/degree patterns.
 *
 * Interpolations splice as SOURCE TEXT exactly as in {@link m} (they can
 * alter pattern structure; locs and error positions refer to the
 * assembled string).
 */
export function n(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): Pattern<number> {
  const src = assemble(strings, values)
  const { pattern, atoms } = parse(src)
  for (const a of atoms) {
    if (typeof a.value !== 'number') {
      throw new MiniError(`expected a number, got '${a.value}'`, a.loc.start, src)
    }
  }
  return pattern.withValue((v) => v.value as number)
}
