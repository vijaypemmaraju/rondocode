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
 * `<0,2,4>` stays an error, deliberately: an alternation takes one term per
 * cycle, so a stack inside one has to say which arm it belongs to. What
 * changed there is the message.
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

describe('precedence: | binds tighter than ,', () => {
  it('`0|1, 2` is a choice STACKED with 2, not a choice between 0 and 1,2', () => {
    /* Read the other way round, cycle 0 would sometimes be a bare `0` with no
     * 2 at all. Every cycle must contain the 2. */
    for (let cy = 0; cy < 8; cy++) {
      const d = degrees('0|1, 2', cy)
      expect(d, `cycle ${cy}: ${d.join(' ')}`).toHaveLength(2)
      expect(d).toContain(2)
      expect(d.some((x) => x === 0 || x === 1)).toBe(true)
    }
  })
})

describe('an alternation still refuses a bare comma, but says why', () => {
  it('names the two things you probably meant', () => {
    expect(() => n('<0,2,4>')).toThrow(/stacks/)
    expect(() => n('<0,2,4>')).toThrow(/\[/)
  })

  it('and the bracketed forms both work', () => {
    // alternate BETWEEN stacks
    expect(degrees('<[0,2] [4,6]>', 0)).toEqual([0, 2])
    expect(degrees('<[0,2] [4,6]>', 1)).toEqual([4, 6])
    // or just a stack
    expect(degrees('[0,2,4]')).toEqual([0, 2, 4])
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
