import { describe, expect, it } from 'vitest'
import { F, MiniError, m, mini, miniLoc, n, timeHash } from '../src/index'
import { q, qw, span } from './helpers'

/** Parse src expecting a MiniError; return it for pos/message assertions. */
const errOf = (src: string): MiniError => {
  try {
    mini(src)
  } catch (e) {
    expect(e).toBeInstanceOf(MiniError)
    return e as MiniError
  }
  throw new Error(`expected MiniError parsing ${JSON.stringify(src)}`)
}

describe('mini: sequences', () => {
  it('"a b c" divides the cycle into thirds', () => {
    expect(q(mini('a b c'), 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [1 / 3, 2 / 3, 'b'],
      [2 / 3, 1, 'c'],
    ])
  })

  it('a single atom fills the cycle', () => {
    expect(q(mini('a'), 0, 1)).toEqual([[0, 1, 'a']])
  })

  it('"a [b c]" nests a subgroup into the second half', () => {
    expect(q(mini('a [b c]'), 0, 1)).toEqual([
      [0, 1 / 2, 'a'],
      [1 / 2, 3 / 4, 'b'],
      [3 / 4, 1, 'c'],
    ])
  })

  it('"a ~ b": rest takes a slot but emits nothing', () => {
    expect(q(mini('a ~ b'), 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [2 / 3, 1, 'b'],
    ])
  })

  it('"[a, b c]": comma inside brackets stacks patterns', () => {
    expect(q(mini('[a, b c]'), 0, 1)).toEqual([
      [0, 1 / 2, 'b'],
      [0, 1, 'a'],
      [1 / 2, 1, 'c'],
    ])
  })

  it('empty and whitespace-only sources are silence', () => {
    expect(q(mini(''), 0, 1)).toEqual([])
    expect(q(mini('  \t\n '), 0, 1)).toEqual([])
  })

  it('numbers parse as JS numbers (floats, leading dot, negatives)', () => {
    expect(q(mini('0.25 1.5'), 0, 1)).toEqual([
      [0, 1 / 2, 0.25],
      [1 / 2, 1, 1.5],
    ])
    expect(q(mini('.5'), 0, 1)).toEqual([[0, 1, 0.5]])
    expect(q(mini('-.5'), 0, 1)).toEqual([[0, 1, -0.5]])
    expect(q(mini('-12 5'), 0, 1)).toEqual([
      [0, 1 / 2, -12],
      [1 / 2, 1, 5],
    ])
  })

  it('scientific notation is unsupported: "1e3" lexes as number then word', () => {
    expect(q(mini('1e3'), 0, 1)).toEqual([
      [0, 1 / 2, 1],
      [1 / 2, 1, 'e3'],
    ])
  })

  it('word charset includes : . _ # digits after a leading letter', () => {
    expect(q(mini('bd:3 hh#2 c4.x_y'), 0, 1)).toEqual([
      [0, 1 / 3, 'bd:3'],
      [1 / 3, 2 / 3, 'hh#2'],
      [2 / 3, 1, 'c4.x_y'],
    ])
  })

  it('words and numbers mix in one pattern', () => {
    expect(q(mini('3 a'), 0, 1)).toEqual([
      [0, 1 / 2, 3],
      [1 / 2, 1, 'a'],
    ])
  })

  it('is whitespace-insensitive between tokens', () => {
    expect(q(mini('a[b c]'), 0, 1)).toEqual(q(mini('a [b c]'), 0, 1))
    expect(q(mini('  a   b  '), 0, 1)).toEqual(q(mini('a b'), 0, 1))
  })
})

describe('mini: alternation <>', () => {
  it('"<a b>" plays one per cycle', () => {
    const p = mini('<a b>')
    expect(q(p, 0, 1)).toEqual([[0, 1, 'a']])
    expect(q(p, 1, 2)).toEqual([[1, 2, 'b']])
    expect(q(p, 2, 3)).toEqual([[2, 3, 'a']])
  })

  it('"<a [b c]>" alternates with a nested subgroup', () => {
    const p = mini('<a [b c]>')
    expect(q(p, 0, 1)).toEqual([[0, 1, 'a']])
    expect(q(p, 1, 2)).toEqual([
      [1, 3 / 2, 'b'],
      [3 / 2, 2, 'c'],
    ])
  })

  it('"<a b>*2" squeezes the alternation into half-cycles', () => {
    const p = mini('<a b>*2')
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 2, 'a'],
      [1 / 2, 1, 'b'],
    ])
    expect(q(p, 1, 2)).toEqual([
      [1, 3 / 2, 'a'],
      [3 / 2, 2, 'b'],
    ])
  })
})

describe('mini: modifiers', () => {
  it('"a*2 b": fast within the slot', () => {
    expect(q(mini('a*2 b'), 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [1 / 4, 1 / 2, 'a'],
      [1 / 2, 1, 'b'],
    ])
  })

  it('"a/2 b": slow within the slot (onset on even cycles, tail on odd)', () => {
    expect(qw(mini('a/2 b'), 0, 2)).toEqual([
      { whole: [0, 1], part: [0, 1 / 2], value: 'a' },
      { whole: [1 / 2, 1], part: [1 / 2, 1], value: 'b' },
      { whole: [1 / 2, 3 / 2], part: [1, 3 / 2], value: 'a' },
      { whole: [3 / 2, 2], part: [3 / 2, 2], value: 'b' },
    ])
  })

  it('fractional fast factor: "a*0.5 b" equals "a/2 b"', () => {
    expect(qw(mini('a*0.5 b'), 0, 2)).toEqual(qw(mini('a/2 b'), 0, 2))
  })

  it('repeated "!" mods: last count wins ("a!2!3 b" is four slots)', () => {
    expect(q(mini('a!2!3 b'), 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [1 / 4, 1 / 2, 'a'],
      [1 / 2, 3 / 4, 'a'],
      [3 / 4, 1, 'b'],
    ])
  })

  it('"a!3 b" occupies four slots', () => {
    expect(q(mini('a!3 b'), 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [1 / 4, 1 / 2, 'a'],
      [1 / 2, 3 / 4, 'a'],
      [3 / 4, 1, 'b'],
    ])
  })

  it('bare "!" duplicates once more: "a! b" is three slots', () => {
    expect(q(mini('a! b'), 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [1 / 3, 2 / 3, 'a'],
      [2 / 3, 1, 'b'],
    ])
  })

  it('"a@3 b": weights 3:1', () => {
    expect(q(mini('a@3 b'), 0, 1)).toEqual([
      [0, 3 / 4, 'a'],
      [3 / 4, 1, 'b'],
    ])
  })

  it('"a _ b" elongates like "a@2 b"', () => {
    expect(q(mini('a _ b'), 0, 1)).toEqual([
      [0, 2 / 3, 'a'],
      [2 / 3, 1, 'b'],
    ])
    expect(q(mini('a _ b'), 0, 1)).toEqual(q(mini('a@2 b'), 0, 1))
  })

  it('"a _ _ b" stacks elongation', () => {
    expect(q(mini('a _ _ b'), 0, 1)).toEqual([
      [0, 3 / 4, 'a'],
      [3 / 4, 1, 'b'],
    ])
  })

  it('deep nesting: "[a [b c]]*2"', () => {
    expect(q(mini('[a [b c]]*2'), 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [1 / 4, 3 / 8, 'b'],
      [3 / 8, 1 / 2, 'c'],
      [1 / 2, 3 / 4, 'a'],
      [3 / 4, 7 / 8, 'b'],
      [7 / 8, 1, 'c'],
    ])
  })
})

describe('mini: euclid', () => {
  it('"a(3,8)" onsets at 0, 3/8, 6/8 (matches combinators euclid)', () => {
    expect(q(mini('a(3,8)'), 0, 1)).toEqual([
      [0, 1 / 8, 'a'],
      [3 / 8, 4 / 8, 'a'],
      [6 / 8, 7 / 8, 'a'],
    ])
  })

  it('"a(2,3)" follows the xx. convention: onsets 0 and 1/3', () => {
    expect(q(mini('a(2,3)'), 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [1 / 3, 2 / 3, 'a'],
    ])
  })

  it('"a(3,8,2)" rotates left by two steps', () => {
    expect(q(mini('a(3,8,2)'), 0, 1)).toEqual([
      [1 / 8, 2 / 8, 'a'],
      [4 / 8, 5 / 8, 'a'],
      [6 / 8, 7 / 8, 'a'],
    ])
  })

  it('euclid applies to a subgroup atom: "[a b](2,4)"', () => {
    expect(q(mini('[a b](2,4)'), 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [1 / 2, 3 / 4, 'b'],
    ])
  })
})

describe('mini: polymeter {}', () => {
  it('"{a b c, d e}%4": both voices on a 4-step grid, cycling independently', () => {
    const p = mini('{a b c, d e}%4')
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 4, 'a'],
      [0, 1 / 4, 'd'],
      [1 / 4, 1 / 2, 'b'],
      [1 / 4, 1 / 2, 'e'],
      [1 / 2, 3 / 4, 'c'],
      [1 / 2, 3 / 4, 'd'],
      [3 / 4, 1, 'a'],
      [3 / 4, 1, 'e'],
    ])
    expect(q(p, 1, 2)).toEqual([
      [1, 5 / 4, 'b'],
      [1, 5 / 4, 'd'],
      [5 / 4, 3 / 2, 'c'],
      [5 / 4, 3 / 2, 'e'],
      [3 / 2, 7 / 4, 'a'],
      [3 / 2, 7 / 4, 'd'],
      [7 / 4, 2, 'b'],
      [7 / 4, 2, 'e'],
    ])
  })

  it('"{a b, c d e}": base is the FIRST seq\'s step count (2)', () => {
    const p = mini('{a b, c d e}')
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 2, 'a'],
      [0, 1 / 2, 'c'],
      [1 / 2, 1, 'b'],
      [1 / 2, 1, 'd'],
    ])
    expect(q(p, 1, 2)).toEqual([
      [1, 3 / 2, 'a'],
      [1, 3 / 2, 'e'],
      [3 / 2, 2, 'b'],
      [3 / 2, 2, 'c'],
    ])
  })

  it('single-voice polymeter without % is a plain seq', () => {
    expect(q(mini('{a b c}'), 0, 1)).toEqual(q(mini('a b c'), 0, 1))
  })
})

describe('mini: random choice |', () => {
  const pick = (c: number, k: number): number =>
    Math.floor(timeHash(F(c), 0) * k)

  it('"a | b" picks per cycle via timeHash(cycle, seed 0)', () => {
    const p = mini('a | b')
    for (let c = 0; c < 8; c++) {
      const want = pick(c, 2) === 0 ? 'a' : 'b'
      expect(q(p, c, c + 1)).toEqual([[c, c + 1, want]])
    }
  })

  it('choice is stable across repeated queries', () => {
    const p = mini('a | b')
    expect(q(p, 0, 4)).toEqual(q(p, 0, 4))
  })

  it('choice is roughly balanced over 100 cycles (exact per timeHash)', () => {
    const p = mini('a | b')
    let as = 0
    for (let c = 0; c < 100; c++) {
      const got = q(p, c, c + 1)[0]![2]
      expect(got).toBe(pick(c, 2) === 0 ? 'a' : 'b')
      if (got === 'a') as++
    }
    expect(as).toBeGreaterThan(30)
    expect(as).toBeLessThan(70)
  })

  it('whole seqs alternate: "a b | c" has two haps on seq-0 cycles, one otherwise', () => {
    const p = mini('a b | c')
    for (let c = 0; c < 10; c++) {
      expect(q(p, c, c + 1).length).toBe(pick(c, 2) === 0 ? 2 : 1)
    }
  })

  it('choice nested in a subgroup: "[a | b] c" picks once per cycle (same stream as top level)', () => {
    const p = mini('[a | b] c')
    for (let c = 0; c < 6; c++) {
      const want = pick(c, 2) === 0 ? 'a' : 'b'
      expect(q(p, c, c + 1)).toEqual([
        [c, c + 1 / 2, want],
        [c + 1 / 2, c + 1, 'c'],
      ])
    }
  })

  it('"[a | b]*2" re-picks per half-cycle (inner cycles 2c and 2c+1)', () => {
    const p = mini('[a | b]*2')
    for (let c = 0; c < 4; c++) {
      const w0 = pick(2 * c, 2) === 0 ? 'a' : 'b'
      const w1 = pick(2 * c + 1, 2) === 0 ? 'a' : 'b'
      expect(q(p, c, c + 1)).toEqual([
        [c, c + 1 / 2, w0],
        [c + 1 / 2, c + 1, w1],
      ])
    }
  })
})

describe('mini: degrade ?', () => {
  it('"a? b": a survives iff timeHash(cycle, 0) >= 0.5 (pinned over 4 cycles)', () => {
    const p = mini('a? b')
    for (let c = 0; c < 4; c++) {
      const want: [number, number, string][] = []
      if (timeHash(F(c), 0) >= 0.5) want.push([c, c + 1 / 2, 'a'])
      want.push([c + 1 / 2, c + 1, 'b'])
      expect(q(p, c, c + 1)).toEqual(want)
    }
  })

  it('"a?0.3" drops with probability 0.3', () => {
    const p = mini('a?0.3')
    for (let c = 0; c < 6; c++) {
      const want: [number, number, string][] =
        timeHash(F(c), 0) >= 0.3 ? [[c, c + 1, 'a']] : []
      expect(q(p, c, c + 1)).toEqual(want)
    }
  })

  it('"a?0.9" is mostly gone over 20 cycles', () => {
    const p = mini('a?0.9')
    let survivors = 0
    for (let c = 0; c < 20; c++) {
      const got = q(p, c, c + 1)
      expect(got.length).toBe(timeHash(F(c), 0) >= 0.9 ? 1 : 0)
      survivors += got.length
    }
    expect(survivors).toBeLessThan(6)
  })

  it('"?" probability is clamped to [0,1]: a?2 drops all, a?-1 keeps all', () => {
    expect(q(mini('a?2'), 0, 4)).toEqual([])
    expect(q(mini('a?-1'), 0, 4)).toEqual(q(mini('a'), 0, 4))
  })
})

describe('miniLoc: source locations', () => {
  it('atoms carry their offsets in the source string', () => {
    expect(q(miniLoc('a bc'), 0, 1)).toEqual([
      [0, 1 / 2, { value: 'a', loc: { start: 0, end: 1 } }],
      [1 / 2, 1, { value: 'bc', loc: { start: 2, end: 4 } }],
    ])
  })

  it('number atoms carry locs too', () => {
    expect(q(miniLoc('42'), 0, 1)).toEqual([
      [0, 1, { value: 42, loc: { start: 0, end: 2 } }],
    ])
  })

  it('locs survive *2', () => {
    expect(q(miniLoc('ab*2'), 0, 1)).toEqual([
      [0, 1 / 2, { value: 'ab', loc: { start: 0, end: 2 } }],
      [1 / 2, 1, { value: 'ab', loc: { start: 0, end: 2 } }],
    ])
  })

  it('locs survive euclid', () => {
    const got = q(miniLoc('a(3,8)'), 0, 1)
    expect(got.length).toBe(3)
    for (const [, , v] of got) {
      expect(v).toEqual({ value: 'a', loc: { start: 0, end: 1 } })
    }
  })

  it('locs survive alternation', () => {
    const p = miniLoc('<a bc>')
    expect(q(p, 1, 2)).toEqual([
      [1, 2, { value: 'bc', loc: { start: 3, end: 5 } }],
    ])
  })

  it('mini() is miniLoc() with values stripped', () => {
    expect(q(mini('a bc'), 0, 1)).toEqual([
      [0, 1 / 2, 'a'],
      [1 / 2, 1, 'bc'],
    ])
  })

  it('stamps each atom loc with its exact source string (editor flash disambiguation)', () => {
    const haps = miniLoc('a bc').query(span(0, 1))
    expect(haps.map((h) => h.value.loc.src)).toEqual(['a bc', 'a bc'])
    // a DIFFERENT source string yields a different src, so the editor can tell
    // two same-looking literals apart
    expect(miniLoc('x y').query(span(0, 1))[0]!.value.loc.src).toBe('x y')
  })
})

describe('template tags', () => {
  it('m`...` parses like mini()', () => {
    expect(q(m`a b c`, 0, 1)).toEqual(q(mini('a b c'), 0, 1))
  })

  it('m tag stringifies interpolations into the source', () => {
    expect(q(m`a ${'x'} ${3}`, 0, 1)).toEqual([
      [0, 1 / 3, 'a'],
      [1 / 3, 2 / 3, 'x'],
      [2 / 3, 1, 3],
    ])
  })

  it('n`0 3 5` yields a numeric pattern', () => {
    expect(q(n`0 3 5`, 0, 1)).toEqual([
      [0, 1 / 3, 0],
      [1 / 3, 2 / 3, 3],
      [2 / 3, 1, 5],
    ])
  })

  it('n tag supports full mini-notation (alternation, rests, interpolation)', () => {
    const p = n`0 <1 2>`
    expect(q(p, 0, 1)).toEqual([
      [0, 1 / 2, 0],
      [1 / 2, 1, 1],
    ])
    expect(q(p, 1, 2)).toEqual([
      [1, 3 / 2, 0],
      [3 / 2, 2, 2],
    ])
    expect(q(n`0 ~ 5`, 0, 1)).toEqual([
      [0, 1 / 3, 0],
      [2 / 3, 1, 5],
    ])
    expect(q(n`0 ${3} 5`, 0, 1)).toEqual(q(n`0 3 5`, 0, 1))
  })

  it('m-tag interpolations splice as SOURCE TEXT: punctuation alters structure', () => {
    // "[a x, y]" — the interpolated comma turns the subgroup into a stack.
    expect(q(m`[a ${'x, y'}]`, 0, 1)).toEqual([
      [0, 1 / 2, 'a'],
      [0, 1, 'y'],
      [1 / 2, 1, 'x'],
    ])
  })

  it('m-tag interpolating a stray closer throws, positioned in the ASSEMBLED string', () => {
    expect(() => m`a ${'b ]'} c`).toThrow(MiniError)
    try {
      m`a ${'b ]'} c`
    } catch (e) {
      // assembled source is "a b ] c"; the ']' sits at offset 4
      expect((e as MiniError).src).toBe('a b ] c')
      expect((e as MiniError).pos).toBe(4)
      expect((e as MiniError).message).toMatch(/unexpected '\]'/)
    }
  })

  it('n tag rejects non-numeric atoms with the atom loc', () => {
    expect(() => n`0 a 5`).toThrow(MiniError)
    try {
      n`0 a 5`
    } catch (e) {
      expect((e as MiniError).pos).toBe(2)
      expect((e as MiniError).message).toMatch(/expected a number/)
    }
  })
})

describe('MiniError', () => {
  it('carries name, pos, src, and a caret-context message', () => {
    const e = errOf('a b ]')
    expect(e.name).toBe('MiniError')
    expect(e.pos).toBe(4)
    expect(e.src).toBe('a b ]')
    expect(e.message).toContain(`unexpected ']' at position 4 in "a b ]"`)
    expect(e.message).toContain('\na b ]\n    ^')
  })

  it('caret is line-relative on multiline sources', () => {
    const e = errOf('a b\nc ]')
    expect(e.pos).toBe(6) // pos stays a raw offset into the whole source
    expect(e.message).toContain('position 6')
    // caret sits under the ']' on ITS line, not at column 6 of line one
    expect(e.message).toContain('\nc ]\n  ^')
  })

  it('caret padding preserves tabs so it aligns under tabbed lines', () => {
    const e = errOf('a\t]')
    expect(e.pos).toBe(2)
    expect(e.message).toContain('\na\t]\n \t^')
  })

  it('long lines are windowed to ~60 chars around the error', () => {
    const src = 'a '.repeat(40) + ']'
    const e = errOf(src)
    expect(e.pos).toBe(80)
    expect(e.src).toBe(src) // .src keeps the full source
    const lines = e.message.split('\n')
    const caret = lines[lines.length - 1]!
    const snippet = lines[lines.length - 2]!
    expect(caret.endsWith('^')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(62)
    expect(snippet).toContain('…')
    expect(snippet[caret.indexOf('^')]).toBe(']') // caret under the offender
    expect(lines[0]!.length).toBeLessThan(120) // header quote truncated too
  })

  const cases: [src: string, pos: number, msg: RegExp][] = [
    ['a b ]', 4, /unexpected '\]'/],
    ['[a b', 0, /unclosed '\['/],
    ['<a b', 0, /unclosed '<'/],
    ['{a b', 0, /unclosed '\{'/],
    ['a *', 3, /after '\*'/],
    ['a*0', 2, /positive/],
    ['a*-2', 2, /positive/],
    ['a/0', 2, /positive/],
    ['a(3)', 3, /','/],
    ['a(3,x)', 4, /integer/],
    ['a(1.5,8)', 2, /integer/],
    ['a(3,0)', 4, /steps/],
    ['a(3,8,2,1)', 7, /'\)'/],
    ['a!0', 2, /positive integer/],
    ['a!1.5', 2, /positive integer/],
    ['a@', 2, /after '@'/],
    ['a@x', 2, /after '@'/],
    ['a@0', 2, /positive/],
    ['[]', 0, /empty/],
    ['<>', 0, /empty/],
    ['{}', 0, /empty/],
    ['{a b}%x', 6, /after '%'/],
    ['{a b}%1.5', 6, /after '%'/],
    ['{a b}%0', 6, /after '%'/],
    ['*2 a', 0, /unexpected '\*'/],
    ['_ a', 0, /'_'/],
    ['! a', 0, /unexpected '!'/],
    ['a $ b', 2, /character/],
    ['a %2', 2, /unexpected '%'/],
    ['a |', 3, /end of input/],
    // A run-together decimal must ERROR, not silently split into two atoms
    // and lengthen the sequence (regression: `0.5.5` used to parse as 0.5 0.5).
    ['0.5.5', 3, /malformed number/],
    ['1.2.3', 3, /malformed number/],
    ['12.34.56', 5, /malformed number/],
    ['0 1.2.3', 5, /malformed number/],
  ]

  for (const [src, pos, msg] of cases) {
    it(`${JSON.stringify(src)} -> MiniError at ${pos} matching ${msg}`, () => {
      expect(() => mini(src)).toThrow(MiniError)
      const e = errOf(src)
      expect(e.pos).toBe(pos)
      expect(e.message).toMatch(msg)
      expect(e.message).toContain(`position ${pos}`)
    })
  }
})
