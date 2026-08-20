import { describe, expect, it } from 'vitest'
import { dragPush, feelMarkX, scanFeelLanes, FEEL_RANGE } from '../src/editor/rondo/feellane'
import { laneText } from '../src/editor/rondo/bendlane'
import { JS_SCAN } from '../src/editor/widgets/jsscan'

/* ------------------------------------------------------------------------- *
 * THE FEEL LANE.
 *
 * `'push:` is a feel judgment, and feel is tuned by EAR against a hot eval,
 * not by editing a fraction. The lane draws the written grid as a ruler and
 * a mark per note where the engine actually plays it; dragging the mark
 * sideways rewrites that one suffix.
 *
 * The contracts pinned here are the ones a drag must not break: it appears
 * only where a push already is (no empty automation rows), the mark's
 * position is gridpoint + push (the drawing's one claim), a release near the
 * gridpoint leaves NO residue in the source, and a rewrite keeps every
 * accidental and lane it did not touch.
 * ------------------------------------------------------------------------- */

const doc = (notation: string): string =>
  `synth lead\n  saw\n\nplay lead\n  ${notation}\n  scale: a-min\n\ncps .5\n`

describe('scanFeelLanes only appears where it is earned', () => {
  it('gives a line with a push a lane', () => {
    const lanes = scanFeelLanes(doc("0 3'push:.08 5 7"))
    expect(lanes.length).toBe(1)
    expect(lanes[0]!.notes.map((n) => n.lanes?.['push'])).toEqual([undefined, 0.08, undefined, undefined])
  })

  it('gives an ordinary line NOTHING, and a bend line nothing either', () => {
    expect(scanFeelLanes(doc('0 3 5 7'))).toEqual([])
    // a bend value is the OTHER lane's trigger; each row is earned separately
    expect(scanFeelLanes(doc("0'1 3'0 5 7"))).toEqual([])
    expect(scanFeelLanes(doc("0'gain:.8 3 5 7"))).toEqual([])
  })

  it('scans the JS dialect through the same interface', () => {
    const js = `const lead = synth(({ note, gate, adsr, saw }) =>\n  saw(note.freq).mul(adsr(gate, { a: .01, d: .1, s: .5, r: .1 })))\np('lead', n("0 3'push:.08 5 7").scale('a minor').sound('lead'))\n`
    const lanes = scanFeelLanes(js, JS_SCAN)
    expect(lanes.length).toBe(1)
    expect(lanes[0]!.notes.map((n) => n.lanes?.['push'])).toEqual([undefined, 0.08, undefined, undefined])
  })
})

describe('feelMarkX draws the one thing the lane claims', () => {
  it('puts an unpushed mark on its gridpoint and a pushed one off it', () => {
    expect(feelMarkX(2, undefined, 50)).toBe(100)
    expect(feelMarkX(2, 0.25, 50)).toBe(112.5)
    expect(feelMarkX(0, -0.1, 50)).toBe(-5)
  })
})

describe('dragPush folds pixels into the next suffix', () => {
  it('one slot of travel is the full range, and it clamps there', () => {
    expect(dragPush(0, 25, 50)).toBe(0.5)
    expect(dragPush(0, 50, 50)).toBe(FEEL_RANGE)
    expect(dragPush(0, 500, 50)).toBe(FEEL_RANGE)
    expect(dragPush(0, -500, 50)).toBe(-FEEL_RANGE)
  })

  it('a whisker from the gridpoint is NO value: exploring leaves no residue', () => {
    expect(dragPush(0.08, -4, 50)).toBeUndefined()
    expect(dragPush(0, 0.5, 50)).toBeUndefined()
  })

  it('starts from the note\'s own value, not from zero', () => {
    expect(dragPush(0.5, -10, 50)).toBe(0.3)
  })
})

describe('a feel drag rewrites only what it touched', () => {
  it('keeps accidentals, bends and other lanes on the line', () => {
    const lanes = scanFeelLanes(doc("0# 3'push:.08'gain:.6 5'1 ~"))
    const notes = lanes[0]!.notes.map((n) => ({ ...n, lanes: n.lanes === undefined ? undefined : { ...n.lanes } }))
    // the drag's own move: set note 1's push to .25
    notes[1]!.lanes = { ...(notes[1]!.lanes ?? {}), push: 0.25 }
    expect(laneText(notes)).toBe("0# 3'push:.25'gain:.6 5'1 ~")
  })

  it('a push snapped to undefined disappears from the source entirely', () => {
    const lanes = scanFeelLanes(doc("0 3'push:.08 5 7"))
    const notes = lanes[0]!.notes.map((n) => ({ ...n, lanes: n.lanes === undefined ? undefined : { ...n.lanes } }))
    delete notes[1]!.lanes!['push']
    expect(laneText(notes)).toBe('0 3 5 7')
  })
})
