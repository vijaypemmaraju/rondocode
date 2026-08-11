import { describe, expect, it } from 'vitest'
import { F, TimeSpan, mini } from '../src/index'
import type { MiniValue, Pattern } from '../src/index'

/* ------------------------------------------------------------------------- *
 * THE THREE THINGS THE GRAMMAR SAID WERE "v2".
 *
 *   patterned arguments   `0*<2 3>`, `bd(<3 5>,8)`
 *   ranges                `0 .. 3`
 *   dot groups            `0 . 1 2 . 3`
 *
 * Each was a deliberate deferral rather than an oversight, and each is the
 * obvious next thing to type after learning the operator it extends: `*` with
 * a literal invites `*<2 3>`, and a scale invites `0 .. 7`.
 *
 * Every expectation here was READ OFF Strudel's own parser and engine rather
 * than derived from what the notation ought to mean, because the ways these
 * can be subtly wrong (which pattern supplies the structure, where a clipped
 * hap begins) are exactly the ways that a plausible-looking implementation
 * differs from the reference.
 * ------------------------------------------------------------------------- */

/**
 * `value@part.begin` for one cycle, in time order.
 *
 * Deliberately paired with {@link spans} rather than used alone: the join that
 * builds a patterned argument gets the onsets right EITHER WAY, and differs
 * only in the wholes. Swapping innerBind for outerBind in the parser left
 * every `part.begin` in this file untouched while turning each note of
 * `0*<2 3>` into a full-cycle note, which is a duration bug the ear would
 * catch long before this suite did. Assert both.
 */
const cyc = (src: string, cycle = 0): string => {
  const p = mini(src) as Pattern<MiniValue>
  return p.query(new TimeSpan(F(cycle), F(cycle + 1)))
    .filter((h) => h.whole !== undefined)
    .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf())
    .map((h) => {
      const t = h.part.begin.sub(F(cycle))
      return `${String(h.value)}@${t.n}/${t.d}`
    })
    .join(' ')
}

/** The WHOLES — where each note actually starts and ends, which is what the
 *  engine turns into note length. */
const spans = (src: string, cycle = 0): string => {
  const p = mini(src) as Pattern<MiniValue>
  const f = (x: { n: number; d: number }): string => `${x.n}/${x.d}`
  return p.query(new TimeSpan(F(cycle), F(cycle + 1)))
    .filter((h) => h.whole !== undefined)
    .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf())
    .map((h) => `[${f(h.whole!.begin.sub(F(cycle)))},${f(h.whole!.end.sub(F(cycle)))}]`)
    .join(' ')
}

const values = (src: string, cycle = 0): (string | number)[] => {
  const p = mini(src) as Pattern<MiniValue>
  return p.query(new TimeSpan(F(cycle), F(cycle + 1)))
    .filter((h) => h.whole !== undefined)
    .sort((a, b) => a.part.begin.valueOf() - b.part.begin.valueOf())
    .map((h) => h.value as unknown as string | number)
}

describe('patterned `*` and `/` arguments', () => {
  it('`0*<2 3>` changes speed per cycle', () => {
    expect(cyc('0*<2 3>', 0)).toBe('0@0/1 0@1/2')
    expect(cyc('0*<2 3>', 1)).toBe('0@0/1 0@1/3 0@2/3')
    expect(cyc('0*<2 3>', 2)).toBe('0@0/1 0@1/2')
    /* Three THIRDS, not three full-cycle notes stacked. An outer join gives
     * the same three onsets and a note three times too long. */
    expect(spans('0*<2 3>', 1)).toBe('[0/1,1/3] [1/3,2/3] [2/3,1/1]')
  })

  it('`0*[2 3]` changes speed WITHIN the cycle', () => {
    /* The load-bearing case. Structure comes from the sped-up pattern and the
     * haps are clipped to the half that selected the factor, so the third
     * onset lands at 1/2 (a hap that began at 1/3, clipped) rather than the
     * pattern being re-divided into halves. An outer join would give 2 events. */
    expect(cyc('0*[2 3]')).toBe('0@0/1 0@1/2 0@2/3')
    // the wholes are where inner and outer joins actually part company
    expect(spans('0*[2 3]')).toBe('[0/1,1/2] [1/3,2/3] [2/3,1/1]')
  })

  it('a three-part factor divides the cycle three ways', () => {
    expect(cyc('0*[2 3 4]')).toBe('0@0/1 0@1/3 0@2/3 0@3/4')
  })

  it('the factor applies to whatever it is attached to, group included', () => {
    expect(cyc('[0 1]*<1 2>', 0)).toBe('0@0/1 1@1/2')
    expect(cyc('[0 1]*<1 2>', 1)).toBe('0@0/1 1@1/4 0@1/2 1@3/4')
  })

  it('`/` patterns too', () => {
    expect(cyc('0/[1 2]')).toBe('0@0/1 0@1/2')
    expect(cyc('0/<1 2>', 0)).toBe('0@0/1')
  })

  it('a scalar factor still builds exactly what it always did', () => {
    // the short-circuit: no join in the way for the overwhelmingly common form
    expect(cyc('0*2')).toBe(cyc('0*<2>'))
    expect(cyc('0*2')).toBe('0@0/1 0@1/2')
  })
})

describe('patterned euclid arguments', () => {
  it('the pulse count can alternate', () => {
    expect(cyc('0(<3 5>,8)', 0)).toBe('0@0/1 0@3/8 0@3/4')
    expect(cyc('0(<3 5>,8)', 1)).toBe('0@0/1 0@1/4 0@3/8 0@5/8 0@3/4')
    expect(spans('0(<3 5>,8)', 1))
      .toBe('[0/1,1/8] [1/4,3/8] [3/8,1/2] [5/8,3/4] [3/4,7/8]')
  })

  it('so can the step count', () => {
    expect(cyc('0(3,<8 16>)', 0)).toBe('0@0/1 0@3/8 0@3/4')
    expect(cyc('0(3,<8 16>)', 1)).toBe('0@0/1 0@5/16 0@5/8')
  })

  it('and both at once', () => {
    expect(cyc('0(<3 5>,<8 16>)', 1)).toBe('0@0/1 0@3/16 0@3/8 0@9/16 0@3/4')
  })

  it('a patterned rotation still rotates OUR way (left), as the reference says', () => {
    /* Deliberately not Strudel's direction. Ours is documented as rotating
     * left and this must not quietly acquire a second convention just because
     * the argument became patternable. */
    expect(cyc('0(3,8,<0 1>)', 0)).toBe(cyc('0(3,8)'))
    expect(cyc('0(3,8,<0 1>)', 1)).toBe(cyc('0(3,8,1)'))
  })

  it('a nonsense step count goes silent rather than throwing mid-query', () => {
    // it cannot be caught at parse time, and a query is the wrong place to throw
    expect(values('0(3,<8 0>)', 1)).toEqual([])
    expect(values('0(3,<8 0>)', 0).length).toBe(3)
  })
})

describe('`..` ranges', () => {
  it('expands an inclusive run into ordinary steps', () => {
    expect(values('0 .. 3')).toEqual([0, 1, 2, 3])
    expect(cyc('0 .. 3')).toBe('0@0/1 1@1/4 2@1/2 3@3/4')
  })

  it('counts down when the end is lower', () => {
    expect(values('3 .. 0')).toEqual([3, 2, 1, 0])
  })

  it('is ONE term, so it does not re-time the steps around it', () => {
    /* The property that decides this. As siblings, `0 .. 15 5` would squash
     * the 5 into a seventeenth of the bar; as a term the 5 keeps its half
     * however long the range is. */
    expect(cyc('0 .. 3 5')).toBe(cyc('[0 1 2 3] 5'))
    expect(cyc('a 0 .. 3')).toBe(cyc('a [0 1 2 3]'))
    expect(values('0 .. 2 5')).toEqual([0, 1, 2, 5])
    expect(cyc('0 .. 2 5')).toBe('0@0/1 1@1/6 2@1/3 5@1/2')
  })

  it('alone, it simply fills the cycle', () => {
    expect(cyc('0 .. 3')).toBe('0@0/1 1@1/4 2@1/2 3@3/4')
  })

  it('steps by 1 from the START, so a fraction keeps its fraction', () => {
    expect(values('0.5 .. 2')).toEqual([0.5, 1.5])
  })

  it('handles negatives', () => {
    expect(values('-2 .. 1')).toEqual([-2, -1, 0, 1])
  })

  it('works unspaced, where the old lexer said "malformed number"', () => {
    expect(values('0..3')).toEqual([0, 1, 2, 3])
    expect(values('0.5..2')).toEqual([0.5, 1.5])
  })

  it('works inside groups and alternations, as the same single term', () => {
    expect(values('[0 .. 3]')).toEqual([0, 1, 2, 3])
    /* One term means `<0 .. 3>` is `<[0 1 2 3]>` — the whole run every cycle,
     * NOT one number per cycle. Tempting as the latter reading is, a term that
     * changed meaning inside `<>` would be the real surprise. */
    expect(cyc('<0 .. 3>', 0)).toBe(cyc('[0 1 2 3]'))
    expect(cyc('<0 .. 3>', 1)).toBe(cyc('[0 1 2 3]'))
    expect(cyc('<0 .. 1 9>', 0)).toBe(cyc('[0 1]'))
    expect(cyc('<0 .. 1 9>', 1)).toBe(cyc('9'))
  })

  it('a single-step range is one step, not an error', () => {
    expect(values('2 .. 2')).toEqual([2])
  })

  it('a real decimal is still a malformed number', () => {
    // the '..' rule must not have swallowed the typo guard
    expect(() => mini('1.2.3')).toThrow(/malformed number/)
  })

  it('refuses what it cannot expand, instead of guessing', () => {
    expect(() => mini('a .. c')).toThrow()
    expect(() => mini('0 ..')).toThrow(/number on both sides/)
    expect(() => mini('0 .. 5000')).toThrow(/too long/)
    // an accidental or a lane would have to apply to every step or to none
    expect(() => mini('2# .. 5')).toThrow(/accidental or a lane/)
    expect(() => mini("0 .. 5'gain:.8")).toThrow(/accidental or a lane/)
  })
})

describe('`.` groups', () => {
  it('splits a sequence into EQUAL-width groups', () => {
    // three groups of a third, not four steps of a quarter
    expect(cyc('0 . 1 2 . 3')).toBe('0@0/1 1@1/3 2@1/2 3@2/3')
    expect(values('0 . 1 2 . 3')).toEqual([0, 1, 2, 3])
  })

  it('two groups split the cycle in half however many steps each holds', () => {
    expect(cyc('0 . 1 2')).toBe('0@0/1 1@1/2 2@3/4')
    expect(cyc('0 1 . 2')).toBe('0@0/1 1@1/4 2@1/2')
  })

  it('is exactly the bracketing it saves you writing', () => {
    expect(cyc('0 . 1 2 . 3')).toBe(cyc('[0] [1 2] [3]'))
    expect(cyc('0 . 1 2 . 3 4 5')).toBe(cyc('[0] [1 2] [3 4 5]'))
  })

  it('works inside brackets and on words', () => {
    expect(cyc('[0 . 1 2]')).toBe('0@0/1 1@1/2 2@3/4')
    expect(cyc('bd . sd sd')).toBe('bd@0/1 sd@1/2 sd@3/4')
  })

  it('binds tighter than `,`, which splits whole sequences', () => {
    /* Unlike `,` against `|` there is no ambiguity to refuse here: `.` groups
     * WITHIN a sequence and `,` separates sequences, so the nesting is forced. */
    expect(values('0 . 1, 2').sort()).toEqual([0, 1, 2])
    expect(cyc('0 . 1, 2')).toBe(cyc('[[0] [1]], 2'))
  })

  it('a dot with nothing after it is an error', () => {
    expect(() => mini('0 .')).toThrow()
    expect(() => mini('. 0')).toThrow()
  })
})

describe('the new operators compose with the old ones', () => {
  it('a range inside a dot group', () => {
    expect(cyc('0 .. 1 . 5')).toBe(cyc('[0 1] [5]'))
  })

  it('a patterned factor on a dot group member', () => {
    expect(cyc('0 . 1*<1 2>', 1)).toBe(cyc('[0] [1*2]'))
  })

  it('a range under a patterned factor', () => {
    expect(cyc('[0 .. 3]*<1 2>', 0)).toBe(cyc('[0 1 2 3]'))
  })

  it('and none of it disturbed a plain pattern', () => {
    expect(cyc('bd(3,8) [sn sn] ~')).toBe(cyc('bd(3,8) [sn sn] ~'))
    expect(values('0 1 2 3')).toEqual([0, 1, 2, 3])
  })
})
