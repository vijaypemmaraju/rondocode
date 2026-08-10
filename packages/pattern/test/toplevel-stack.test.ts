import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset, n } from '../src/index'
import type { ControlMap } from '../src/index'

/* ------------------------------------------------------------------------- *
 * `,` STACKS, BRACKETED OR NOT.
 *
 * It used to live only in the `[…]` production, so `[0,2,4]` was a chord and a
 * bare `0,2,4` was a syntax error pointing at the comma — with nothing in the
 * message to say that brackets were what it wanted. There was no reason for
 * the asymmetry: a stack is a stack whether or not it is bracketed.
 *
 * `<0,2,4>` stacks too, and `0|1, 2` is now an ERROR. Both of those are
 * STRUDEL'S answers, checked against its actual parser rather than its docs:
 * `slow_sequence` defers to the same stack-capable rule `{…}` uses, and
 * `stack_or_choose` takes a head sequence followed by exactly ONE of a comma
 * tail, a pipe tail or a dot tail.
 *
 * We had it backwards on both. `<0,2,4>` was rejected with a helpful message
 * explaining a restriction that only existed here, and `0|1, 2` was accepted
 * under a precedence (`|` tighter than `,`) that we invented. A reasonable
 * reading is still a divergence: it makes a program that runs here fail there.
 * ------------------------------------------------------------------------- */

const degrees = (src: string, cycle = 0): number[] =>
  n(src).query(new TimeSpan(F(cycle), F(cycle + 1)))
    .filter(hasOnset)
    .map((h) => (h.value as ControlMap).n as number)

describe('a bare comma stacks', () => {
  it('0,2,4 is the same chord as [0,2,4]', () => {
    expect(degrees('0,2,4')).toEqual(degrees('[0,2,4]'))
    expect(degrees('0,2,4')).toEqual([0, 2, 4])
  })

  it('all of them start together and last the whole cycle', () => {
    // a stack is parallel: three onsets at 0, not a sequence
    const haps = n('0,2,4').query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(haps).toHaveLength(3)
    for (const h of haps) {
      expect(h.whole!.begin.valueOf()).toBe(0)
      expect(h.whole!.end.valueOf()).toBe(1)
    }
  })

  it('stacks whole SEQUENCES, not just single notes', () => {
    // `0 1, 2` is the two-note line against a held 2
    const haps = n('0 1, 2').query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(haps).toHaveLength(3)
    expect(degrees('0 1, 2').sort()).toEqual([0, 1, 2])
  })

  it('and composes with brackets either way round', () => {
    expect(degrees('[0,2] 4')).toEqual([0, 2, 4])
    /* Three ONSETS, not two voices: `[2 4]` is a two-note sequence, so
     * stacking it against a held 0 gives the 0 plus both of its notes. */
    expect(degrees('0, [2 4]').sort()).toEqual([0, 2, 4])
  })
})

describe('`,` and `|` do not mix at one level', () => {
  /* We used to accept `0|1, 2` and define `|` as binding tighter. Strudel's
   * grammar allows exactly one tail per level, so it refuses the whole string
   * — and a precedence we made up is worse than an error, because it silently
   * gives a reading no other Tidal-family runtime agrees with. */
  it('`0|1, 2` is refused', () => {
    expect(() => n('0|1, 2')).toThrow()
  })

  it('and so is the other order', () => {
    expect(() => n('0, 1|2')).toThrow()
  })

  it('the message names both operators and shows the fix', () => {
    /* An error is only better than a wrong reading if it says what to write. */
    expect(() => n('0|1, 2')).toThrow(/stack/)
    expect(() => n('0|1, 2')).toThrow(/choice/)
    expect(() => n('0|1, 2')).toThrow(/\[0\|1\], 2/)
  })

  it('bracketing either one makes it legal again, both ways round', () => {
    // the reading our old precedence gave: a choice, stacked against a held 2
    for (let cy = 0; cy < 8; cy++) {
      const d = degrees('[0|1], 2', cy)
      expect(d, `cycle ${cy}: ${d.join(' ')}`).toHaveLength(2)
      expect(d).toContain(2)
    }
    // and the other reading, which was unreachable before
    expect(() => degrees('0|[1, 2]')).not.toThrow()
  })

  it('each on its own is still fine, repeated as often as you like', () => {
    expect(degrees('0,2,4')).toEqual([0, 2, 4])
    expect(() => degrees('0|1|2')).not.toThrow()
  })
})

describe('an alternation stacks on a comma, like Strudel', () => {
  it('`<0,2,4>` is three rotations of one term each, so all three every cycle', () => {
    /* Not a chord by a different route: it is three single-element rotations
     * running together, which happens to look like one. `<0 1, 2 3>` below is
     * the case that tells them apart. */
    expect(degrees('<0,2,4>', 0).sort()).toEqual([0, 2, 4])
    expect(degrees('<0,2,4>', 1).sort()).toEqual([0, 2, 4])
  })

  it('`<0 1, 2 3>` advances BOTH rotations together', () => {
    expect(degrees('<0 1, 2 3>', 0).sort()).toEqual([0, 2])
    expect(degrees('<0 1, 2 3>', 1).sort()).toEqual([1, 3])
    expect(degrees('<0 1, 2 3>', 2).sort()).toEqual([0, 2])
  })

  it('voices of unequal length rotate at their own periods', () => {
    // 2 against 3: the pairing only repeats every 6 cycles
    const at = (cy: number): string => degrees('<0 1, 2 3 4>', cy).sort((a, b) => a - b).join(' ')
    expect([0, 1, 2, 3, 4, 5].map(at)).toEqual(['0 2', '1 3', '0 4', '1 2', '0 3', '1 4'])
    expect(at(6)).toBe('0 2')
  })

  it('the single-voice cases did not move', () => {
    expect(degrees('<0 1>', 0)).toEqual([0])
    expect(degrees('<0 1>', 1)).toEqual([1])
    /* Weights still give a term N cycles' WIDTH, which means ONE long note:
     * cycles 1 and 2 have no onset because the 0 is still sounding, and that
     * is the difference from `<0!3 4>`, which would re-articulate. */
    expect(degrees('<0@3 4>', 0)).toEqual([0])
    expect(degrees('<0@3 4>', 1)).toEqual([])
    expect(degrees('<0@3 4>', 2)).toEqual([])
    expect(degrees('<0@3 4>', 3)).toEqual([4])
    expect(degrees('<0!3 4>', 1)).toEqual([0])
  })

  it('and the bracketed forms still mean what they meant', () => {
    // alternate BETWEEN stacks — different from `<0,2>`, which plays both
    expect(degrees('<[0,2] [4,6]>', 0)).toEqual([0, 2])
    expect(degrees('<[0,2] [4,6]>', 1)).toEqual([4, 6])
    expect(degrees('[0,2,4]')).toEqual([0, 2, 4])
  })

  it('an empty alternation is still an error', () => {
    expect(() => n('<>')).toThrow()
    expect(() => n('<0 1')).toThrow(/unclosed/)
  })
})

describe('nothing else that uses commas moved', () => {
  it('polymeter still splits its voices on commas', () => {
    const haps = n('{0 1, 2 3 4}%4').query(new TimeSpan(F(0), F(1))).filter(hasOnset)
    expect(haps.length).toBeGreaterThan(4)
  })

  it('euclid still reads its arguments', () => {
    expect(degrees('0(3,8)')).toEqual([0, 0, 0])
  })

  it('a rest inside a stack is still a rest', () => {
    expect(degrees('0,~,4')).toEqual([0, 4])
  })
})
