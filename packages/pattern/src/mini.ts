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
 * pattern  := seq ('|' seq)*                   -- random choice per cycle
 * seq      := (term | '_')+                    -- timecat with weights
 * term     := atom mod*
 * atom     := word | number | '~'
 *           | '[' pattern (',' pattern)* ']'   -- subgroup; ',' stacks
 *           | '<' term+ '>'                    -- alternation (one per cycle)
 *           | '{' seq (',' seq)* '}' ('%' int)?  -- polymeter
 * mod      := '*' number | '/' number | '!' int? | '@' number
 *           | '(' int ',' int (',' int)? ')' | '?' number?
 * ```
 *
 * Decisions pinned by tests (see mini.test.ts):
 * - Words are `[a-zA-Z][a-zA-Z0-9._#:]*` — ':' included for sample
 *   indexing (`bd:3`), '#' and '.' for note/name spellings.
 * - Numbers are plain integers/floats with an optional leading '-'
 *   (`-12`, `0.25`, `.5`, `-.5`). Scientific notation is unsupported:
 *   `1e3` lexes as the number 1 followed by the word `e3`.
 * - Repeated mods of the same kind apply left to right; for `!` the last
 *   count wins (`a!2!3` = `a!3`).
 * - Bare `!` duplicates once more (`"a! b"` = `"a a b"`, Tidal/Strudel).
 * - `_` elongates the previous step by one slot (`"a _ b"` = `"a@2 b"`).
 * - `*` / `/` factors are positive numbers only in v1; pattern-valued
 *   factors (`"a*[2 3]"`) are deliberately deferred to v2.
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
 *
 * v2 note: `..` ranges (Strudel's `0 .. 7`) would collide with '.' being
 * both a word character and a number start (`.5`); introducing them needs
 * a dedicated '..' lexer rule that wins over word/number continuation.
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
}

const PUNCT = new Set('[]<>{}(),|*/!@?%~_')
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
      toks.push({ kind: 'word', text: src.slice(i, j), value: NaN, start: i, end: j })
      i = j
      continue
    }
    const c1 = src[i + 1] ?? ''
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
      if (src[j] === '.') {
        throw new MiniError('malformed number (extra decimal point)', j, src)
      }
      const text = src.slice(i, j)
      toks.push({ kind: 'number', text, value: parseFloat(text), start: i, end: j })
      i = j
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
const randcat = <T>(pats: Pattern<T>[]): Pattern<T> =>
  new Pattern<T>((span) => {
    const cycle = span.begin.sam()
    const i = Math.min(Math.floor(timeHash(cycle, 0) * pats.length), pats.length - 1)
    return pats[i]!.query(span)
  }).splitQueries()

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
  private parsePattern(): Pattern<MiniValue> {
    const seqs = [this.parseSeq()]
    while (this.isPunct(this.peek(), '|')) {
      this.next()
      seqs.push(this.parseSeq())
    }
    return seqs.length === 1 ? seqs[0]! : randcat(seqs)
  }

  /** seq := (term | '_')+, as a weighted timecat. */
  private parseSeq(): Pattern<MiniValue> {
    return Pattern.timecat(this.parseSeqEntries().map((e) => [e.weight, e.pat]))
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
        const f = this.parseFactor(t.text)
        pat = t.text === '*' ? pat.fast(f) : pat.slow(f)
      } else if (t.text === '!') {
        this.next()
        const num = this.peek()
        if (num !== undefined && num.kind === 'number' && num.start === t.end) {
          if (!Number.isInteger(num.value) || num.value < 1) {
            this.err(`count for '!' must be a positive integer`, num.start)
          }
          this.next()
          reps = num.value
        } else {
          reps = 2 // bare '!': one extra copy (Tidal: "a! b" = "a a b")
        }
      } else if (t.text === '@') {
        this.next()
        const num = this.peek()
        if (num === undefined || num.kind !== 'number') {
          this.err(`expected a number after '@'`)
        }
        if (!(num.value > 0)) this.err(`weight for '@' must be positive`, num.start)
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

  /** Positive number after '*' or '/'. Pattern-valued factors are v2. */
  private parseFactor(op: string): number {
    const t = this.peek()
    if (t === undefined || t.kind !== 'number') this.err(`expected a number after '${op}'`)
    if (!(t.value > 0)) this.err(`factor for '${op}' must be positive`, t.start)
    this.next()
    return t.value
  }

  /** '(' already consumed: int ',' int (',' int)? ')' -> euclid. */
  private parseEuclid(pat: Pattern<MiniValue>): Pattern<MiniValue> {
    const pulses = this.parseEuclidInt()
    this.expectPunct(',', 'between euclid arguments')
    const steps = this.parseEuclidInt()
    if (steps.value < 1) this.err(`euclid steps must be >= 1`, steps.pos)
    let rotation = 0
    if (this.isPunct(this.peek(), ',')) {
      this.next()
      rotation = this.parseEuclidInt().value
    }
    this.expectPunct(')', 'to close euclid arguments')
    return pat.euclid(pulses.value, steps.value, rotation)
  }

  private parseEuclidInt(): { value: number; pos: number } {
    const t = this.peek()
    if (t === undefined || t.kind !== 'number' || !Number.isInteger(t.value)) {
      this.err(`expected an integer in euclid arguments`)
    }
    this.next()
    return { value: t.value, pos: t.start }
  }

  /** Record an atom (the `n` tag validates against the list) and build its pattern. */
  private mkAtom(value: string | number, loc: Loc): Pattern<MiniValue> {
    // Stamp the source so the editor can flash exactly this literal (see Loc).
    const located: Loc = { start: loc.start, end: loc.end, src: this.src }
    this.atoms.push({ value, loc: located })
    return Pattern.pure({ value, loc: located })
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
      })
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

  /** '[' pattern (',' pattern)* ']' — ',' stacks. */
  private parseSubgroup(): Pattern<MiniValue> {
    const open = this.next()! // '['
    if (this.isPunct(this.peek(), ']')) this.err(`empty '[]'`, open.start)
    const pats = [this.parsePattern()]
    while (this.isPunct(this.peek(), ',')) {
      this.next()
      pats.push(this.parsePattern())
    }
    if (this.peek() === undefined) this.err(`unclosed '['`, open.start)
    this.expectPunct(']', 'to close the subgroup')
    return pats.length === 1 ? pats[0]! : Pattern.stack(...pats)
  }

  /**
   * '<' term+ '>' — slowcat, one term per cycle. `!n` repetition adds
   * copies to the rotation; `@` weights are meaningless here and ignored.
   */
  private parseAlternation(): Pattern<MiniValue> {
    const open = this.next()! // '<'
    if (this.isPunct(this.peek(), '>')) this.err(`empty '<>'`, open.start)
    const pats: Pattern<MiniValue>[] = []
    for (;;) {
      const t = this.peek()
      if (t === undefined || !this.isTermStart(t)) break
      const { pat, reps } = this.parseTerm()
      for (let k = 0; k < reps; k++) pats.push(pat)
    }
    if (pats.length === 0) this.errUnexpected()
    if (this.peek() === undefined) this.err(`unclosed '<'`, open.start)
    this.expectPunct('>', 'to close the alternation')
    return Pattern.cat(...pats)
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
