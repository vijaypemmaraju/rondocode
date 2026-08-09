import { describe, expect, it } from 'vitest'
import { BEND_RANGE, bendPath, laneText, scanBendLanes } from '../src/editor/rondo/bendlane'
import type { BendNote } from '../src/editor/rondo/bendlane'

/* ------------------------------------------------------------------------- *
 * THE BEND LANE.
 *
 * The curve started life inside the piano-roll cell and did not fit: the cell
 * is 12px square (16 on touch), which is enough to say WHICH notes carry a
 * value and hopeless for saying how much — every curve read the same. So the
 * shape moved to a full-width lane under the notation, the placement a
 * multi-cycle figure already uses for its clip overview.
 *
 * IT DRAWS A LEVEL, NOT A TRAJECTORY, and that is the load-bearing decision.
 * The lane knows the note's VALUE and nothing else; what the pitch actually
 * does is whatever the synth's own shape makes of it, which is arbitrary code.
 * The first version drew a curve settling into the note and was simply wrong
 * about the example on screen — that envelope starts AT pitch, rises, and
 * comes back. Same honesty rule the filter curves follow.
 * ------------------------------------------------------------------------- */

const W = 100
const H = 40

describe('scanBendLanes only appears where it is earned', () => {
  const doc = (notation: string): string =>
    `synth lead\n  saw\n\nplay lead\n  ${notation}\n  scale: a-min\n\ncps .5\n`

  it('gives a line with values a lane', () => {
    const lanes = scanBendLanes(doc("0'1 3'0 5'-1 7"))
    expect(lanes.length).toBe(1)
    expect(lanes[0]!.notes.map((n) => n.expr)).toEqual([1, 0, -1, undefined])
    expect(lanes[0]!.notes.map((n) => n.step)).toEqual([0, 3, 5, 7])
  })

  it('gives an ordinary line NOTHING — no empty automation row', () => {
    expect(scanBendLanes(doc('0 3 5 7'))).toEqual([])
    expect(scanBendLanes(doc('0 ~ 5 ~'))).toEqual([])
  })

  it('carries rests through as slots with no note', () => {
    const [lane] = scanBendLanes(doc("0'1 ~ 5'-1"))
    expect(lane!.notes.map((n) => n.step)).toEqual([0, null, 5])
  })

  it('keeps accidentals, so a drag cannot drop them', () => {
    const [lane] = scanBendLanes(doc("2#'1 4b"))
    expect(lane!.notes.map((n) => [n.step, n.acc, n.expr])).toEqual([[2, 1, 1], [4, -1, undefined]])
  })
})

describe('bendPath draws the VALUE', () => {
  const mid = H / 2

  it('is a flat line on the centre for no value and for zero', () => {
    expect(bendPath(undefined, W, H)).toBe(`M0 ${mid} L${W} ${mid}`)
    expect(bendPath(0, W, H)).toBe(`M0 ${mid} L${W} ${mid}`)
  })

  it('steps UP for a positive value and DOWN for a negative one', () => {
    // y grows downward in SVG, so "up" is a SMALLER y than the centre
    const up = Number(/L0 ([\d.]+)/.exec(bendPath(1, W, H))![1])
    const down = Number(/L0 ([\d.]+)/.exec(bendPath(-1, W, H))![1])
    expect(up, 'a positive value did not go up').toBeLessThan(mid)
    expect(down, 'a negative value did not go down').toBeGreaterThan(mid)
  })

  it('is symmetric about the centre', () => {
    const up = Number(/L0 ([\d.]+)/.exec(bendPath(0.5, W, H))![1])
    const down = Number(/L0 ([\d.]+)/.exec(bendPath(-0.5, W, H))![1])
    expect(mid - up).toBeCloseTo(down - mid, 5)
  })

  it('a half value sits half as far from the centre as a whole one', () => {
    const half = mid - Number(/L0 ([\d.]+)/.exec(bendPath(0.5, W, H))![1])
    const full = mid - Number(/L0 ([\d.]+)/.exec(bendPath(1, W, H))![1])
    expect(half).toBeCloseTo(full / 2, 5)
  })

  it('clamps past the range rather than drawing outside the lane', () => {
    expect(bendPath(5, W, H)).toBe(bendPath(BEND_RANGE, W, H))
    expect(bendPath(-5, W, H)).toBe(bendPath(-BEND_RANGE, W, H))
  })

  it('returns to the centre at both ends — it is a lane, not a ramp', () => {
    // starting and ending on the centre is what makes a row of these read as
    // steps rather than as one continuous line wandering off
    const d = bendPath(1, W, H)
    expect(d.startsWith(`M0 ${mid} `), d).toBe(true)
    expect(d.endsWith(`${mid}`), d).toBe(true)
  })
})


describe('laneText: a drag rewrites only what it touched', () => {
  const note = (
    i: number, step: number | null, acc?: number, expr?: number,
    lanes?: Record<string, number>,
  ): BendNote => ({ i, step, acc, expr, lanes })

  it('keeps an accidental the drag never touched', () => {
    // dropping it would move the note a semitone — a far worse bug than the
    // one the drag was fixing
    expect(laneText([note(0, 2, 1, 0.5), note(1, 4, -1, undefined)])).toBe("2#'.5 4b")
  })

  it('keeps rests as rests', () => {
    expect(laneText([note(0, 0, undefined, 1), note(1, null), note(2, 5)])).toBe("0'1 ~ 5")
  })

  it('keeps the OTHER lanes a bend drag never touched', () => {
    // a bend changes `expr`; deleting the velocity beside it would be the same
    // invisible class of bug as dropping an accidental
    expect(laneText([note(0, 0, undefined, 1, { expr: 1, vel: 0.8 })])).toBe("0'1'vel:.8")
    expect(laneText([note(0, 5, undefined, undefined, { chance: 0.5 })])).toBe("5'chance:.5")
  })

  it('writes nothing where there is no value', () => {
    expect(laneText([note(0, 0), note(1, 3)])).toBe('0 3')
  })
})
