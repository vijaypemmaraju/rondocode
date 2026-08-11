import { describe, expect, it } from 'vitest'
import { SCOPE_GAIN, SCOPE_H, SCOPE_W, scopeAnchors, scopePoints, scopeSilent } from '../src/editor/rondo/scope'

/* ------------------------------------------------------------------------- *
 * The inline scope's pure parts: where it hangs, and how a trace maps to the
 * box. Both are things that go wrong silently — a scope anchored one line off
 * still draws, and a scope that auto-scales still looks plausible while
 * telling you nothing true about level.
 * ------------------------------------------------------------------------- */

const ys = (pts: string): number[] => pts.split(' ').map((p) => Number(p.split(',')[1]))
const xs = (pts: string): number[] => pts.split(' ').map((p) => Number(p.split(',')[0]))

describe('scopePoints', () => {
  it('maps silence to a flat line down the middle', () => {
    const pts = scopePoints(new Float32Array(8))
    expect(ys(pts).every((y) => y === SCOPE_H / 2)).toBe(true)
  })

  it('an EMPTY trace still draws a centre line rather than nothing', () => {
    // a widget with an empty `points` renders as a missing element, which
    // reads as "broken" rather than "silent"
    const pts = scopePoints([])
    expect(pts).not.toBe('')
    expect(ys(pts).every((y) => y === SCOPE_H / 2)).toBe(true)
  })

  it('draws a MIRRORED band: equal deflection above and below the centre', () => {
    /* Not a signed line. At ~2.7ms a point the polarity of a block peak
     * alternates essentially at random, so a signed trace read as noise in the
     * browser for a saw and a sine alike. Magnitude mirrored is what a
     * waveform overview looks like, and what is actually legible at 14px. */
    const pts = scopePoints([0.5])
    const y = ys(pts)
    expect(y).toHaveLength(2) // one point up, the same point back down
    expect(y[0]!).toBeLessThan(SCOPE_H / 2)
    expect(y[1]!).toBeGreaterThan(SCOPE_H / 2)
    expect(SCOPE_H / 2 - y[0]!).toBeCloseTo(y[1]! - SCOPE_H / 2, 6)
  })

  it('a negative sample draws the same band as its positive twin', () => {
    expect(scopePoints([-0.5])).toBe(scopePoints([0.5]))
  })

  it('spans the full width, first point to last', () => {
    const x = xs(scopePoints(new Float32Array(16)))
    expect(Math.min(...x)).toBe(0)
    expect(Math.max(...x)).toBe(SCOPE_W)
  })

  it('closes: the band returns along the bottom so it fills', () => {
    const x = xs(scopePoints(new Float32Array(8)))
    // 8 up then 8 back, so the x sequence rises then falls
    expect(x).toHaveLength(16)
    expect(x[7]).toBe(SCOPE_W)
    expect(x[8]).toBe(SCOPE_W)
    expect(x[15]).toBe(0)
  })

  it('CLAMPS past full scale instead of drawing outside the box', () => {
    for (const v of [1, 5, -5, 100]) {
      const y = ys(scopePoints([v]))[0]!
      expect(y, `${v} left the box`).toBeGreaterThanOrEqual(0)
      expect(y, `${v} left the box`).toBeLessThanOrEqual(SCOPE_H)
    }
  })

  it('uses the METERS scale, so a scope and its meter agree', () => {
    /* Not auto-gain. A trace normalised to its own maximum would draw silence
     * as a full-height wave, which is the one thing a level display must never
     * do. Half-scale on the meter (rms*160 = 50%) is half-height here. */
    const half = 0.5 / SCOPE_GAIN
    const y = ys(scopePoints([half]))[0]!
    expect(y).toBeCloseTo(SCOPE_H / 2 - (SCOPE_H / 2) * 0.5, 5)
  })

  it('a louder trace draws a TALLER band than a quieter one', () => {
    const height = (v: number): number => {
      const y = ys(scopePoints([v]))
      return y[1]! - y[0]!
    }
    expect(height(0.5)).toBeGreaterThan(height(0.1))
    expect(height(0.1)).toBeGreaterThan(height(0))
  })

  it('a quiet trace stays SMALL rather than filling the box', () => {
    const quiet = ys(scopePoints([0.01, -0.01]))
    for (const y of quiet) expect(Math.abs(y - SCOPE_H / 2)).toBeLessThan(1)
  })

  it('survives non-finite samples rather than emitting NaN into the DOM', () => {
    const pts = scopePoints([NaN, Infinity, -Infinity, 0.2])
    expect(pts).not.toContain('NaN')
    for (const y of ys(pts)) expect(Number.isFinite(y)).toBe(true)
  })
})

describe('scopeSilent', () => {
  it('is true for zeros and false for anything audible', () => {
    expect(scopeSilent(new Float32Array(8))).toBe(true)
    expect(scopeSilent([0, 0, 0.5])).toBe(false)
    expect(scopeSilent([0, 0, -0.5])).toBe(false)
  })
})

describe('scopeAnchors', () => {
  it('finds each synth header and anchors at the END of its line', () => {
    const doc = 'synth lead\n  saw\n\nsynth sub voices:4\n  sine\n'
    const a = scopeAnchors(doc)
    expect(a.map((x) => x.name)).toEqual(['lead', 'sub'])
    expect(doc.slice(0, a[0]!.pos)).toBe('synth lead')
    expect(doc.slice(0, a[1]!.pos).endsWith('synth sub voices:4')).toBe(true)
  })

  it('ignores a synth named inside a COMMENT', () => {
    /* A widget drawn on a commented-out line claims a channel that does not
     * exist, and would sit there flat forever. */
    expect(scopeAnchors('# synth ghost\n  saw\n')).toEqual([])
    expect(scopeAnchors('synth real  # synth ghost\n').map((x) => x.name)).toEqual(['real'])
  })

  it('anchors before a trailing comment, not after it', () => {
    const doc = 'synth lead  # the lead\n'
    const [a] = scopeAnchors(doc)
    expect(doc.slice(0, a!.pos)).toBe('synth lead')
  })

  it('ignores indented lines: only a TOP-LEVEL synth opens a block', () => {
    expect(scopeAnchors('play x\n  synth notreally\n')).toEqual([])
  })

  it('ignores headers that are not synths', () => {
    expect(scopeAnchors('play lead\n  0 3 5\nsection a 8\ncps .5\n')).toEqual([])
  })

  it('needs a name', () => {
    expect(scopeAnchors('synth\n  saw\n')).toEqual([])
  })

  it('offsets stay right across multi-line docs with blank lines', () => {
    const doc = 'cps .5\n\n\nsynth a\n  saw\n\nsynth b\n  sine\n'
    for (const { name, pos } of scopeAnchors(doc)) {
      expect(doc.slice(pos - name.length, pos), `anchor for ${name}`).toBe(name)
    }
  })
})
