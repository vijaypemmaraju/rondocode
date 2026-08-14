import { describe, expect, it } from 'vitest'
import { Fraction, TimeSpan, miniParse } from '../src/index'

/* ------------------------------------------------------------------------- *
 * `$a=[bd sn] $a ~ $a $a` -- name a figure, then use it.
 *
 * A long pattern had no way to say "this bit again": you wrote it out, and
 * changing it meant changing every copy. This is the same idea `patdef` gives
 * a rondo block, but inside one string, so it works in JavaScript too.
 *
 * THE SIGIL IS THE SAFETY. A bare word is already a legal atom -- the sample
 * called `a` -- so an unsigilled reference would turn a typo in the definition
 * into a sample that plays rather than an error.
 * ------------------------------------------------------------------------- */

const events = (src: string): string[] => {
  const { pattern } = miniParse(src)
  return pattern.query(new TimeSpan(new Fraction(0), new Fraction(1)))
    .sort((a, b) => a.whole!.begin.valueOf() - b.whole!.begin.valueOf())
    .map((h) => `${String((h.value as { value: unknown }).value)}@${(h.whole!.begin.valueOf() * 8).toFixed(1)}`)
}

describe('a named figure', () => {
  it('plays wherever it is referenced', () => {
    expect(events('$a=[bd sn] $a ~ $a $a'))
      .toEqual(['bd@0.0', 'sn@1.0', 'bd@4.0', 'sn@5.0', 'bd@6.0', 'sn@7.0'])
  })

  it('is the same as writing it out', () => {
    expect(events('$a=[bd sn] $a ~ $a $a')).toEqual(events('[bd sn] ~ [bd sn] [bd sn]'))
  })

  it('holds a single atom as happily as a group', () => {
    expect(events('$a=bd $a $a')).toEqual(['bd@0.0', 'bd@4.0'])
  })

  it('takes several definitions on one line', () => {
    expect(events('$a=[bd sn] $b=[hh hh] $a $b'))
      .toEqual(['bd@0.0', 'sn@2.0', 'hh@4.0', 'hh@6.0'])
  })

  it('nests, and takes the ordinary suffixes', () => {
    expect(events('$a=[bd sn] [$a $a]')).toEqual(events('$a=[bd sn] $a*2'))
    expect(events('$a=[bd sn] $a*2')).toEqual(['bd@0.0', 'sn@2.0', 'bd@4.0', 'sn@6.0'])
  })
})

describe('what it refuses, and why', () => {
  it('an undefined name, listing what IS defined', () => {
    /* The reason for the sigil. Without it `$a` would be the sample `a`, and a
     * mistyped definition would play something rather than say anything. */
    expect(() => miniParse('$a ~')).toThrow(/'\$a' is not defined/)
    expect(() => miniParse('$a=[bd] $b')).toThrow(/Defined here: \$a/)
  })

  it('a redefinition, rather than quietly taking the last one', () => {
    expect(() => miniParse('$a=[bd sn] $a=[hh] $a')).toThrow(/already defined/)
  })

  it('a definition with nothing after it', () => {
    expect(() => miniParse('$a=[bd sn]')).toThrow(/never plays one/)
  })

  it('a `$` with no name', () => {
    expect(() => miniParse('$1=[bd] $1')).toThrow(/needs a name/)
    expect(() => miniParse('bd $ sn'), 'a sigil must not reach across a space').toThrow(/straight after/)
  })

  it('a figure cannot refer to itself, since it is not defined yet', () => {
    expect(() => miniParse('$a=$a $a')).toThrow(/not defined/)
  })
})

describe('it does not disturb what was already there', () => {
  it('a plain pattern is untouched', () => {
    expect(events('bd sn')).toEqual(['bd@0.0', 'sn@4.0'])
  })

  it('and `$` is not otherwise a legal character, so nothing could have used it', () => {
    // it was rejected outright before, so no existing pattern can contain one
    expect(() => miniParse('bd $ sn')).toThrow()
  })
})
