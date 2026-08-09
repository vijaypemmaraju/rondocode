import { describe, expect, it } from 'vitest'
import { STEP_RE, accValue, exprValue, scanPlays, stepText } from '../src/editor/rondo/widgets'
import { scanPlaysJs } from '../src/editor/widgets/jsscan'

/* ------------------------------------------------------------------------- *
 * THE ROLL HAS TO SEE A NOTE THAT CARRIES A VALUE.
 *
 * Adding `'value` to the notation broke the grid, quietly and completely:
 * STEP_RE did not know the suffix, so `0'1 3'0` stopped matching, the line
 * stopped being a tappable roll, and the shipped "note bends" example rendered
 * no roll at all. The feature was invisible in the one place it most needed to
 * be visible.
 *
 * One exported regex, imported by the JS scanner too — so teaching it here
 * teaches both languages, and scan-parity holds them equal.
 * ------------------------------------------------------------------------- */

describe('STEP_RE reads a degree, its accidental and its expression', () => {
  const parse = (t: string): [number, number | undefined, number | undefined] | null => {
    const m = STEP_RE.exec(t)
    return m === null ? null : [Number(m[1]), accValue(m[2]), exprValue(m[3])]
  }

  it('still reads plain degrees and accidentals', () => {
    expect(parse('0')).toEqual([0, undefined, undefined])
    expect(parse('-2')).toEqual([-2, undefined, undefined])
    expect(parse('2#')).toEqual([2, 1, undefined])
    expect(parse('4b')).toEqual([4, -1, undefined])
  })

  it('reads an expression, including negatives and decimals', () => {
    expect(parse("0'1")).toEqual([0, undefined, 1])
    expect(parse("5'-1")).toEqual([5, undefined, -1])
    expect(parse("7'-.5")).toEqual([7, undefined, -0.5])
    expect(parse("3'0"), 'zero is a value, not an absence').toEqual([3, undefined, 0])
  })

  it('reads both at once', () => {
    expect(parse("2#'-0.5")).toEqual([2, 1, -0.5])
  })

  it('rejects what is not a step', () => {
    for (const t of ["0'", "'1", '0..2', 'kick']) expect(STEP_RE.test(t), t).toBe(false)
  })
})

describe('stepText writes back what it read', () => {
  it('round-trips a degree, an accidental and an expression', () => {
    for (const t of ['0', '-2', '2#', '4b', "0'1", "5'-1", "2#'-0.5", "3'0"]) {
      const m = STEP_RE.exec(t)!
      expect(stepText(Number(m[1]), accValue(m[2]), exprValue(m[3])), t).toBe(t)
    }
  })

  it('trims a dragged value so the notation stays readable', () => {
    // a drag lands on 0.7000000000000001; the source must not
    expect(stepText(0, undefined, 0.7000000000000001)).toBe("0'0.7")
    expect(stepText(0, undefined, 1)).toBe("0'1")
  })

  it('a rest stays a rest whatever it is handed', () => {
    expect(stepText(null, 1, 0.5)).toBe('~')
  })
})

describe('the roll scans a line whose notes carry values', () => {
  const doc = "synth lead\n  saw\n\nplay lead\n  0'1 3'0 5'-1 7\n  scale: a-min\n\ncps .5\n"

  it('finds the grid — this is what broke', () => {
    const rolls = scanPlays(doc)
    expect(rolls.length, 'the line stopped being a tappable grid').toBe(1)
    expect(rolls[0]!.steps).toEqual([0, 3, 5, 7])
    expect(rolls[0]!.exprs).toEqual([1, 0, -1, undefined])
  })

  it('still scans a line with no expressions at all', () => {
    const plain = scanPlays('synth lead\n  saw\n\nplay lead\n  0 3 5 7\n\ncps .5\n')
    expect(plain.length).toBe(1)
    expect(plain[0]!.exprs).toEqual([undefined, undefined, undefined, undefined])
  })

  it('the JS scanner agrees, because it is the same regex', () => {
    const js = scanPlaysJs("p('lead', n(\"0'1 3'0 5'-1 7\").scale('a minor').sound('lead'))")
    expect(js.length).toBe(1)
    expect(js[0]!.steps).toEqual([0, 3, 5, 7])
    expect(js[0]!.exprs).toEqual([1, 0, -1, undefined])
  })
})
