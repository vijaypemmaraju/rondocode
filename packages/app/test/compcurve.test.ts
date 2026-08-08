import { describe, expect, it } from 'vitest'
import {
  COMP_DEFAULTS,
  compResponse,
  gainReduction,
  levelToDb,
  scanCompressors,
} from '../src/editor/rondo/compcurve'

/* `master threshold:-14 ratio:2.6 attack:12 release:150 makeup:2` was five
 * bare numbers with nothing in the editor saying what shape they make. The
 * curve is the shape; the number a user actually wants out of a compressor is
 * the GAIN REDUCTION, which is the distance from the unity diagonal. So the
 * maths is pinned here, away from any canvas. */

const S = { threshold: -20, ratio: 4, knee: 0, makeup: 0 }

describe('compResponse', () => {
  it('is 1:1 below the threshold — a compressor under its threshold does nothing', () => {
    expect(compResponse(-40, S)).toBeCloseTo(-40)
    expect(compResponse(-21, S)).toBeCloseTo(-21)
  })

  it('bends to the ratio above it', () => {
    // 12 dB over at 4:1 comes out 3 dB over
    expect(compResponse(-8, S)).toBeCloseTo(-17)
  })

  it('ratio 1 is a straight wire, whatever the threshold', () => {
    for (const db of [-50, -20, -3]) expect(compResponse(db, { ...S, ratio: 1 })).toBeCloseTo(db)
  })

  it('makeup lifts the whole curve, both sides of the threshold', () => {
    const up = { ...S, makeup: 6 }
    expect(compResponse(-40, up)).toBeCloseTo(-34)
    expect(compResponse(-8, up)).toBeCloseTo(-11)
  })

  it('a SOFT KNEE eases in instead of cornering', () => {
    const soft = { ...S, knee: 12 }
    // at the threshold itself the hard curve is still 1:1; the soft one has
    // already begun to bend, which is the whole point of a knee
    expect(compResponse(-20, soft)).toBeLessThan(compResponse(-20, S))
    // and outside the knee band the two agree again
    expect(compResponse(-40, soft)).toBeCloseTo(compResponse(-40, S))
    expect(compResponse(-2, soft)).toBeCloseTo(compResponse(-2, S), 1)
  })

  it('never bends the wrong way — output rises with input', () => {
    // a curve that dipped would be drawing an expander
    let prev = -Infinity
    for (let db = -60; db <= 0; db += 1) {
      const out = compResponse(db, { threshold: -30, ratio: 8, knee: 9, makeup: 3 })
      expect(out).toBeGreaterThan(prev)
      prev = out
    }
  })
})

describe('gainReduction', () => {
  it('is zero below the threshold and grows above it', () => {
    expect(gainReduction(-40, S)).toBeCloseTo(0)
    expect(gainReduction(-8, S)).toBeCloseTo(9) // 12 over at 4:1 keeps 3
  })

  it('ignores makeup — reduction is the DISTANCE the compressor pulls down', () => {
    // makeup moves the whole curve up; it is not less compression
    expect(gainReduction(-8, { ...S, makeup: 6 })).toBeCloseTo(gainReduction(-8, S))
  })
})

describe('levelToDb', () => {
  it('maps a 0..1 meter to dB, with silence at the floor', () => {
    expect(levelToDb(1)).toBeCloseTo(0)
    expect(levelToDb(0.5)).toBeCloseTo(-6.02, 1)
    expect(levelToDb(0)).toBe(-60)
  })
})

describe('scanCompressors', () => {
  it('finds a master line and reads its args', () => {
    const [c] = scanCompressors('master threshold:-14 ratio:2.6 makeup:2\n')
    expect(c!.kind).toBe('master')
    expect(c!.spec.threshold).toBe(-14)
    expect(c!.spec.ratio).toBe(2.6)
    expect(c!.spec.makeup).toBe(2)
  })

  it('fills omitted args from the ENGINE defaults, not from zero', () => {
    // every field here has a meaningful default, so unlike a filter cutoff
    // there is always an honest curve to draw — but it has to be the right one
    const [c] = scanCompressors('master threshold:-10\n')
    expect(c!.spec.ratio).toBe(COMP_DEFAULTS.ratio)
    expect(c!.spec.knee).toBe(COMP_DEFAULTS.knee)
  })

  it('ignores args that are not compressor args', () => {
    const [c] = scanCompressors('master threshold:-14 attack:12 release:150\n')
    expect(c!.spec.threshold).toBe(-14)
    expect(c!.spec.ratio).toBe(COMP_DEFAULTS.ratio)
  })

  it('attributes `compress` to its enclosing synth, and `master` to none', () => {
    const doc = 'synth pad\n  saw\n  compress threshold:-18 ratio:3\n\nmaster threshold:-8\n'
    const out = scanCompressors(doc)
    expect(out.map((c) => `${c.kind}:${c.synth ?? '-'}`)).toEqual(['compress:pad', 'master:-'])
  })

  it('anchors at the end of the line, past a trailing comment', () => {
    const doc = 'master threshold:-14 # glue\n'
    const [c] = scanCompressors(doc)
    expect(doc.slice(c!.at - 3, c!.at)).toBe('-14')
  })

  it('finds nothing in a document with no compressor', () => {
    expect(scanCompressors('synth p\n  saw\n\ncps .5\n')).toEqual([])
  })
})

/* PINNED AGAINST THE ENGINE. This module cannot import @rondocode/engine — it
 * sits in the docs page's eager graph, the same constraint filtercurve.ts
 * documents — so the knee maths is replicated here, and a replica that drifts
 * draws a curve that lies. The engine's own gainReductionDb is the reference. */
describe('the curve matches the engine, not just itself', () => {
  it('agrees with gainReductionDb across thresholds, ratios and knees', async () => {
    const { gainReductionDb } = await import('@rondocode/engine')
    for (const threshold of [-40, -24, -12, -3]) {
      for (const ratio of [1, 2, 4, 8, 20]) {
        for (const knee of [0, 3, 6, 12]) {
          for (let db = -60; db <= 0; db += 2.5) {
            const mine = gainReduction(db, { threshold, ratio, knee, makeup: 0 })
            const theirs = gainReductionDb(db, threshold, ratio, knee)
            expect(mine, `db=${db} thr=${threshold} ratio=${ratio} knee=${knee}`).toBeCloseTo(theirs, 6)
          }
        }
      }
    }
  })

  it('and makeup does not leak into the comparison', async () => {
    const { gainReductionDb } = await import('@rondocode/engine')
    expect(gainReduction(-6, { threshold: -20, ratio: 4, knee: 6, makeup: 9 }))
      .toBeCloseTo(gainReductionDb(-6, -20, 4, 6), 6)
  })
})
