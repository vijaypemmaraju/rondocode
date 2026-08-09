import { describe, expect, it } from 'vitest'
import { applyEntries, bandTop, topmostVisible } from '../src/docs/spy'

/* ------------------------------------------------------------------------- *
 * The reported bug: click `recipe-one-knob` in the cookbook nav and the link
 * ABOVE it lights up.
 *
 * Measured in Chrome over CDP, not reasoned about — the first two guesses were
 * both wrong. Three causes, all real:
 *   1. THE JUMP LANDED SHORT. The docs render their code blocks asynchronously,
 *      so the document grows while the smooth scroll is travelling and the
 *      position the browser committed to is stale on arrival. The target came
 *      to rest ~220px low, with the previous section genuinely filling the
 *      band. The spy was reporting that honestly.
 *   2. THE OFFSET WAS DECLARED TWICE. `html` sets scroll-padding-top and the
 *      section had scroll-margin-top; the two ADD, so anchors landed at 232px
 *      instead of 116px, which put the previous section back in the band.
 *   3. LAST ENTRY WON. IntersectionObserver promises no ordering, and a
 *      callback only reports what CHANGED — so a section already in the band
 *      could not win at all.
 * ------------------------------------------------------------------------- */

const entry = (id: string, isIntersecting: boolean): IntersectionObserverEntry =>
  ({ target: { id } as HTMLElement, isIntersecting }) as IntersectionObserverEntry

describe('topmostVisible', () => {
  const ORDER = ['recipe-mic-strip', 'recipe-one-knob', 'recipe-pump']

  it('picks the topmost section when two share the band — NOT the last reported', () => {
    // the bug: after a jump to one-knob, mic-strip's tail is still in the band
    expect(topmostVisible(ORDER, new Set(['recipe-one-knob', 'recipe-mic-strip'])))
      .toBe('recipe-mic-strip')
  })

  it('is decided by document order, not by set insertion order', () => {
    /* The property that makes it independent of callback ordering: the same
     * two sections must give the same answer whichever arrived first. */
    const a = topmostVisible(ORDER, new Set(['recipe-pump', 'recipe-one-knob']))
    const b = topmostVisible(ORDER, new Set(['recipe-one-knob', 'recipe-pump']))
    expect(a).toBe('recipe-one-knob')
    expect(b).toBe(a)
  })

  it('returns the only one when just one is in the band', () => {
    expect(topmostVisible(ORDER, new Set(['recipe-pump']))).toBe('recipe-pump')
  })

  it('returns undefined for an empty band, meaning "keep what is lit"', () => {
    // above the first section and below the last; changing the highlight there
    // would be a guess
    expect(topmostVisible(ORDER, new Set())).toBeUndefined()
  })

  it('ignores ids that are not nav sections', () => {
    expect(topmostVisible(ORDER, new Set(['something-else']))).toBeUndefined()
  })
})

describe('applyEntries', () => {
  it('accumulates across callbacks — entries only ever describe CHANGES', () => {
    /* The second cause, isolated: a section that entered the band in an
     * earlier callback is absent from later ones, and must stay visible. */
    const visible = new Set<string>()
    applyEntries(visible, [entry('a', true)])
    applyEntries(visible, [entry('b', true)])
    expect([...visible].sort()).toEqual(['a', 'b'])
  })

  it('removes a section when it leaves', () => {
    const visible = new Set(['a', 'b'])
    applyEntries(visible, [entry('a', false)])
    expect([...visible]).toEqual(['b'])
  })

  it('a scroll past one section into the next lands on the next', () => {
    // end to end: a leaves the band as b enters, in one callback
    const visible = new Set(['a'])
    applyEntries(visible, [entry('b', true), entry('a', false)])
    expect(topmostVisible(['a', 'b', 'c'], visible)).toBe('b')
  })
})

describe('bandTop', () => {
  const withStyle = (style: Record<string, string>, fn: () => void): void => {
    const g = globalThis as { getComputedStyle?: unknown }
    const saved = g.getComputedStyle
    g.getComputedStyle = () => style
    try { fn() } finally { g.getComputedStyle = saved }
  }

  it('reads the SCROLLER\'s scroll-padding-top — where a click actually lands', () => {
    /* Measured in Chrome: with scroll-padding-top 116px on `html`, a clicked
     * section comes to rest at exactly 116. That is the band's top. */
    withStyle({ scrollPaddingTop: '116px' }, () => {
      expect(bandTop({} as Element)).toBe(116)
    })
  })

  it('does NOT read scroll-margin-top — declaring both doubles the offset', () => {
    /* scroll-padding (on the scroller) and scroll-margin (on the target) ADD.
     * Setting the same calc in both places landed anchors at 232px instead of
     * 116px, which put the previous section back inside the band — the very
     * bug this module exists to fix, reintroduced from the other side. */
    withStyle({ scrollPaddingTop: '116px', scrollMarginTop: '116px' }, () => {
      expect(bandTop({} as Element)).toBe(116)
    })
  })

  it('falls back when the value is absent or zero rather than pinning the band at 0', () => {
    withStyle({ scrollPaddingTop: 'auto' }, () => {
      expect(bandTop({} as Element)).toBe(96)
      expect(bandTop({} as Element, 80)).toBe(80)
    })
  })

  it('falls back with no element at all', () => {
    expect(bandTop(null)).toBe(96)
  })
})
