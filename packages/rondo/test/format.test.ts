import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { formatRondo, formatRondoLine } from '../src/format'
import { STATEMENT_KEYWORDS } from '../src/parser'
import { genProgram, mulberry32 } from './fuzzgen'

/* The formatter's contract, rule by rule, then the two fuzz gates:
 *   A. compile(format(src)).code === compile(src).code — formatting can never
 *      change what a program compiles to, byte for byte
 *   B. format(format(src)) === format(src) — idempotence
 * Both gates run over the existing generator's programs AND an "uglified"
 * variant of each (doubled indents, widened spaces, injected blanks/trailing
 * whitespace), so the formatter is exercised on non-canonical input too.
 *
 * RONDO_FMT_FUZZ_N=20000 npx vitest run packages/rondo/test/format.test.ts
 * for a longer sweep. */

const fmt = formatRondo

describe('indentation', () => {
  it('normalizes synth bodies to 2 spaces', () => {
    const src = 'synth a\n      saw\n   * env\n env = adsr .01 .1 .5 .1\n'
    expect(fmt(src)).toBe('synth a\n  saw\n  * env\n  env = adsr .01 .1 .5 .1\n')
  })

  it('nests post bodies at 4 under the post line at 2', () => {
    const src = 'synth a\n   saw\n   post\n       reverb room:.8\n\nplay a\n  0\n'
    expect(fmt(src)).toBe('synth a\n  saw\n  post\n    reverb room:.8\n\nplay a\n  0\n')
  })

  it('indents section-nested play headers at 2 and their bodies at 4', () => {
    const src = 'synth a\n  saw\n\nsection intro 4\n    play a\n            0 3 5\n            gain: .8\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\nsection intro 4\n  play a\n    0 3 5\n    gain: .8\n')
  })

  it('leaves membership intact for beat blocks nested in sections', () => {
    const src = 'synth k\n  sine\n\nsection drop 4\n   beat\n     k ~ k ~\n'
    expect(fmt(src)).toBe('synth k\n  sine\n\nsection drop 4\n  beat\n    k ~ k ~\n')
  })
})

describe('blank lines and trailing whitespace', () => {
  it('strips trailing whitespace and ends with a single newline', () => {
    const src = 'synth a  \n  saw\t \n\nplay a\n  0 3\n\n\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\nplay a\n  0 3\n')
  })

  it('collapses runs of blank lines between blocks to one and drops file-start blanks', () => {
    const src = '\n\nsynth a\n  saw\n\n\n\nplay a\n  0\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\nplay a\n  0\n')
  })

  it('inserts the missing blank line between adjacent top-level blocks', () => {
    const src = 'synth a\n  saw\nplay a\n  0\ncps .5\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\nplay a\n  0\n\ncps .5\n')
  })

  it('keeps a single interior blank inside a block body', () => {
    const src = 'synth a\n  saw\n\n\n  * env\n  env = adsr .01 .1 .5 .1\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\n  * env\n  env = adsr .01 .1 .5 .1\n')
  })

  it('adds the trailing newline when missing', () => {
    expect(fmt('cps .5')).toBe('cps .5\n')
  })
})

describe('interior spacing', () => {
  it('collapses runs of 3+ spaces on token-parsed lines, keeping 2-space runs', () => {
    // `cutoff` needs a binding: an undeclared name is a compile error now
    // (it used to fall through to a bare JS identifier and die at eval), and
    // the formatter only reformats a document that parses.
    expect(fmt('synth a\n  saw\n  ladder    cutoff  res:.5\n  cutoff = knob 900 80..8000\n'))
      .toBe('synth a\n  saw\n  ladder cutoff  res:.5\n  cutoff = knob 900 80..8000\n')
  })

  it('normalizes binding lines to name = expr', () => {
    const cases: [string, string][] = [
      ['  env= adsr .01 .1 .5 .1', '  env = adsr .01 .1 .5 .1'],
      ['  env =adsr .01 .1 .5 .1', '  env = adsr .01 .1 .5 .1'],
      ['  env=adsr .01 .1 .5 .1', '  env = adsr .01 .1 .5 .1'],
    ]
    for (const [line, want] of cases) {
      expect(fmt(`synth a\n  saw\n${line}\n`)).toBe(`synth a\n  saw\n${want}\n`)
    }
  })

  it('preserves binding-name alignment columns before =', () => {
    const src = 'synth a\n  saw\n  env    = adsr .01 .1 .5 .1\n  cutoff = knob 800 80..8000 log\n'
    expect(fmt(src)).toBe(src)
  })

  it('puts one space after modifier colons', () => {
    const src = 'synth a\n  saw\n\nplay a\n  0 3 5\n  gain:.8\n  dur :  .9\n  every 4:rev\n  jux:rev\n'
    expect(fmt(src)).toBe(
      'synth a\n  saw\n\nplay a\n  0 3 5\n  gain: .8\n  dur: .9\n  every 4: rev\n  jux: rev\n',
    )
  })

  it('leaves modifier VALUES byte-identical (they may be mini notation)', () => {
    const src = 'synth a\n  saw\n\nplay a\n  0 3\n  gain:<.2  .8>\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\nplay a\n  0 3\n  gain: <.2  .8>\n')
  })

  it('leaves bare combinator lines untouched (struct carries mini text)', () => {
    const src = 'synth a\n  saw\n\nplay a\n  0 3\n  struct ~  t ~ t\n'
    expect(fmt(src)).toBe(src)
  })

  it('keeps named args glued (res:.5 is canonical)', () => {
    const src = 'synth a\n  saw\n  ladder 1200 res:.5\n'
    expect(fmt(src)).toBe(src)
  })
})

describe('one-line statements, every one of them', () => {
  // The bug this pins: the formatter kept its OWN copy of the statement list,
  // so `timesig` was added to the parser and not here, and a top-level
  // `timesig    3     4` kept its sloppy spacing while `bpm    120` next to it
  // was normalized. The list now lives in the parser and is imported.
  it('normalizes spacing on every statement keyword the parser accepts', () => {
    const sloppy: Record<string, [string, string]> = {
      cps: ['cps    .5', 'cps .5'],
      bpm: ['bpm    120', 'bpm 120'],
      timesig: ['timesig    3     4', 'timesig 3 4'],
      song: ['song    a', 'song a'],
      sidechain: ['sidechain    kick   depth:.7', 'sidechain kick depth:.7'],
      master: ['master    ratio:3', 'master ratio:3'],
      level: ['level    -4', 'level -4'],
      // the notation is taken verbatim, so only the header spacing normalizes
      patdef: ['patdef    riff   <[0 ~ 3]>', 'patdef riff <[0 ~ 3]>'],
      macro: ['macro    drums   .5', 'macro drums .5'],
      scaledef: ['scaledef    myscale   cents   0   200', 'scaledef myscale cents 0 200'],
      wavedef: ['wavedef    mywave   1   .3   /   .5   1', 'wavedef mywave 1 .3 / .5 1'],
    }
    // every keyword in the set is covered here: a new statement must be given
    // a case rather than silently going unformatted
    expect(Object.keys(sloppy).sort()).toEqual([...STATEMENT_KEYWORDS].sort())
    for (const [kw, [line, want]] of Object.entries(sloppy)) {
      // a program that COMPILES: the formatter declines to touch one that
      // does not, so a sloppy program alone would pass this vacuously
      const src = `synth kick\n  saw\n\nsection a 4\n  play kick\n    0 2 4\n\n${line}\n`
      expect(compile(src).ok, `${kw}: fixture must compile`).toBe(true)
      const out = fmt(src)
      expect(out, kw).toContain(`\n${want}\n`)
    }
  })
})

describe('notation lines', () => {
  it('preserves notation interior spacing verbatim', () => {
    const src = 'synth a\n  saw\n\nplay a\n  0  0   3 5  scale:a-min\n'
    expect(fmt(src)).toBe(src)
  })

  it('normalizes the gap before an inline scale to two spaces', () => {
    const one = 'synth a\n  saw\n\nplay a\n  0 3 5 scale:a-min\n'
    const many = 'synth a\n  saw\n\nplay a\n  0 3 5      scale:a-min\n'
    const want = 'synth a\n  saw\n\nplay a\n  0 3 5  scale:a-min\n'
    expect(fmt(one)).toBe(want)
    expect(fmt(many)).toBe(want)
  })

  it('leaves beat rows (step grids) byte-identical', () => {
    const src = 'synth kick\n  sine\n\nbeat\n  kick ~    kick ~\n  kick:.6 ~ kick ~\n'
    expect(fmt(src)).toBe(src)
  })

  it('leaves sing lyric/melody pairs byte-identical', () => {
    const src = 'sing v1\n  la   la  lo-ver\n  c4   e4  g4\n  gain: .9\n'
    expect(fmt(src)).toBe(src)
  })
})

describe('comments', () => {
  it('re-indents own-line comments with their block, preserving the text', () => {
    const src = 'synth a\n# the source\n      saw\n'
    expect(fmt(src)).toBe('synth a\n  # the source\n  saw\n')
  })

  it('keeps trailing comments and their gap untouched', () => {
    const src = 'synth a\n  saw    # bright\n  ladder 900   # dark    \n'
    expect(fmt(src)).toBe('synth a\n  saw    # bright\n  ladder 900   # dark\n')
  })

  it('keeps a comment group attached to the block below it', () => {
    const src = 'synth a\n  saw\n# about the play\nplay a\n  0\n'
    expect(fmt(src)).toBe('synth a\n  saw\n\n# about the play\nplay a\n  0\n')
  })
})

describe('escape hatches are byte-preserved', () => {
  it('never touches a js block body (indent, spacing, blanks, trailing ws)', () => {
    const body = '   const x  =  1;   \n\n      if (x) {\n        setCps(0.5)\n      }'
    const src = `js\n${body}\n\ncps .5\n`
    const out = fmt(src)
    expect(out).toContain(body)
    expect(compile(out).ok).toBe(true)
  })

  it('never touches an inline js{ … } span', () => {
    const src = 'synth a\n  saw\n  e1    = js{ note.freq  .mul( 3 ) }\n'
    const out = fmt(src)
    expect(out).toBe('synth a\n  saw\n  e1    = js{ note.freq  .mul( 3 ) }\n')
  })

  it('never touches a visual block body', () => {
    const body = '  let  d =   length(uv);\n     col = vec3f(d,  d, d);'
    const src = `visual\n${body}\n\ncps .5\n`
    expect(fmt(src)).toContain(body)
  })

  it('collapses spaces outside an inline js{ … } span but not inside', () => {
    const src = 'synth a\n  saw\n  mo = js{ a  +    b }    *     2\n'
    expect(fmt(src)).toBe('synth a\n  saw\n  mo = js{ a  +    b } * 2\n')
  })
})

describe('broken code', () => {
  it('returns non-compiling documents unchanged', () => {
    const src = 'synth\n   zzz not a thing\n\n\n'
    expect(fmt(src)).toBe(src)
  })
})

describe('formatRondoLine (format-on-newline)', () => {
  const src = 'synth a\n      saw\n  gain= 2\n\nplay a\n  0 3 5\n  gain:.8\n'

  it('formats exactly one line, structure-local', () => {
    expect(formatRondoLine(src, 2)).toBe('  saw')
    expect(formatRondoLine(src, 3)).toBe('  gain = 2')
    expect(formatRondoLine(src, 7)).toBe('  gain: .8')
  })

  it('works without requiring the doc to compile', () => {
    const broken = 'synth a\n      saw\n\nplay nope\n  0 3\n  gain:.8'
    expect(formatRondoLine(broken, 2)).toBe('  saw')
    expect(formatRondoLine(broken, 6)).toBe('  gain: .8')
  })

  it('refuses to touch js block bodies', () => {
    const js = 'js\n  const   x = 1\n'
    expect(formatRondoLine(js, 2)).toBe(null)
  })

  it('returns null out of range', () => {
    expect(formatRondoLine(src, 0)).toBe(null)
    expect(formatRondoLine(src, 99)).toBe(null)
  })
})

/* ---- fuzz gates -------------------------------------------------------------- */

/** Semantics-agnostic uglifier: every mutation keeps the program COMPILING
 *  (asserted below) — the gate compares compile(format(ugly)) against
 *  compile(ugly), so the mutations only need validity, not meaning-
 *  preservation. Mutations: double every indent (strictly order-preserving,
 *  so block membership is intact), widen random single spaces, add trailing
 *  whitespace, inject extra blank lines. */
function uglify(src: string, seed: number): string {
  const rnd = mulberry32(seed ^ 0x5eed)
  const out: string[] = []
  for (const line of src.split('\n')) {
    const indent = /^[ ]*/.exec(line)![0]
    let rest = line.slice(indent.length)
    if (rnd() < 0.6) {
      // widen a few single spaces (never inside a token — only at spaces)
      rest = rest.replace(/ /g, (sp) => (rnd() < 0.25 ? '   ' : sp))
    }
    let ugly = indent + indent + rest
    if (rnd() < 0.2) ugly += '   '
    if (rnd() < 0.15) out.push('')
    out.push(ugly)
  }
  if (rnd() < 0.3) out.unshift('')
  return out.join('\n')
}

const N = Number(process.env['RONDO_FMT_FUZZ_N'] ?? 2000)

// ~2.5k seeds/s: scale the budget so RONDO_FMT_FUZZ_N sweeps don't trip the 5s default
const FUZZ_TIMEOUT = 30_000 + N * 10

describe(`fuzz gates (${N} seeds, canonical + uglified)`, () => {
  it('formatting never changes compiled output, and is idempotent', { timeout: FUZZ_TIMEOUT }, () => {
    for (let seed = 1; seed <= N; seed++) {
      const clean = genProgram(seed)
      for (const src of [clean, uglify(clean, seed)]) {
        const ref = compile(src)
        expect(ref.ok, `seed ${seed}: input must compile\n${src}`).toBe(true)
        if (!ref.ok) return
        const once = formatRondo(src)
        const c2 = compile(once)
        expect(c2.ok, `seed ${seed}: formatted output failed to compile\n--- input ---\n${src}\n--- formatted ---\n${once}`).toBe(true)
        if (!c2.ok) return
        if (c2.code !== ref.code) {
          const a = ref.code.split('\n')
          const b = c2.code.split('\n')
          let i = 0
          while (i < a.length && i < b.length && a[i] === b[i]) i++
          expect.fail(
            `seed ${seed}: compiled output changed at line ${i + 1}\n` +
              `  before: ${a[i] ?? '<end>'}\n  after:  ${b[i] ?? '<end>'}\n` +
              `--- input ---\n${src}\n--- formatted ---\n${once}`,
          )
        }
        const twice = formatRondo(once)
        if (twice !== once) {
          const a = once.split('\n')
          const b = twice.split('\n')
          let i = 0
          while (i < a.length && i < b.length && a[i] === b[i]) i++
          expect.fail(
            `seed ${seed}: not idempotent at line ${i + 1}\n` +
              `  once:  ${JSON.stringify(a[i] ?? '<end>')}\n  twice: ${JSON.stringify(b[i] ?? '<end>')}\n` +
              `--- input ---\n${src}`,
          )
        }
      }
    }
  })

  it('formatRondoLine agrees with the whole-doc formatter line by line on canonical docs', { timeout: FUZZ_TIMEOUT }, () => {
    // On an already-formatted doc (no blank-line moves), the per-line path
    // must reproduce every line — the two engines can never drift.
    for (let seed = 1; seed <= Math.min(N, 300); seed++) {
      const doc = formatRondo(genProgram(seed))
      const lines = doc.split('\n')
      for (let ln = 1; ln <= lines.length; ln++) {
        const got = formatRondoLine(doc, ln)
        if (got !== null) expect(got, `seed ${seed} line ${ln}`).toBe(lines[ln - 1])
      }
    }
  })
})
