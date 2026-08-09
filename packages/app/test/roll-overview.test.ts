import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import {
  MAX_OVERVIEW_BARS,
  MAX_OVERVIEW_CELLS,
  RollOverviewWidget,
  addLineEdit,
  blockWidgetField,
  findAddTarget,
  richRollCells,
  rollOverviewBlockDecos,
  rollOverviewData,
  scanRichPlays,
  transposePreviewShift,
  transposeSteps,
} from '../src/editor/rondo/widgets'
import type { Hooks } from '../src/editor/rondo/widgets'
import { LiveWriter } from '../src/editor/rondo/gesture'
import type { Drag } from '../src/editor/rondo/gesture'

/* The multi-cycle roll overview's pure parts: period detection (query cycles
 * until the pattern repeats, capped), the honesty guards (no partial views,
 * no soup), whole-period cell layout, block-deco placement, and the
 * whole-roll transpose handle's add-line write derivation. DOM/gesture glue
 * reuses the shared attachGesture/LiveWriter protocol and is verified
 * on-device with synthetic pointer sequences. */

const hooks: Hooks = { requestEval: () => {} }
const drag: Drag = { active: false, ended: false }

describe('rollOverviewData (period detection by querying successive cycles)', () => {
  it('a true single-cycle figure reports period 1 with the cycle-0 cells', () => {
    const d = rollOverviewData('0(3,8)')!
    expect(d.period).toBe(1)
    const legacy = richRollCells('0(3,8)')!
    expect(d.rows).toBe(legacy.rows)
    expect(d.cells).toEqual(legacy.cells)
  })

  it('a 2-arm alternation lays both bars side by side in period units', () => {
    const d = rollOverviewData('<0 3>')!
    expect(d.period).toBe(2)
    expect(d.rows).toBe(2)
    expect(d.cells).toEqual([
      { x0: 0, x1: 1, deg: 0, row: 0 },
      { x0: 1, x1: 2, deg: 3, row: 1 },
    ])
  })

  it('an 8-arm alternation spans 8 bars — bar k holds arm k', () => {
    const d = rollOverviewData('<0 1 2 3 4 5 6 7>')!
    expect(d.period).toBe(8)
    expect(d.rows).toBe(8)
    expect(d.cells.map((c) => c.x0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(d.cells.map((c) => c.deg)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('rows span the DISTINCT degrees of the whole period, not one bar', () => {
    const d = rollOverviewData('<[0 3] [3 5]>')!
    expect(d.period).toBe(2)
    expect(d.rows).toBe(3) // degrees 0, 3, 5 across both bars
    // bar 1's cells sit at x in [1, 2)
    expect(d.cells.filter((c) => c.x0 >= 1).map((c) => c.deg)).toEqual([3, 5])
  })

  it('HONESTY: a pattern that never repeats within the cap renders nothing', () => {
    // 9 arms > MAX_OVERVIEW_BARS: a partial 8-bar view would lie — null, and
    // the cycle-0-only thumbnail must never come back in any fallback path
    expect(rollOverviewData('<0 1 2 3 4 5 6 7 8>')).toBeNull()
    expect(MAX_OVERVIEW_BARS).toBe(8)
    // degraded patterns vary per cycle (cycle-seeded rand, deterministic):
    // they never repeat within the probe, so they render nothing at all —
    // the old cycle-0 thumbnail showed ONE roll of dice as if it were the loop
    expect(rollOverviewData('0(3,8)?')).toBeNull()
    expect(rollOverviewData('0 3 5 7?')).toBeNull()
  })

  it('HONESTY: past the cell budget the overview renders nothing (no soup)', () => {
    // 8 arms x 40 cells = 320 > 256
    const arms = Array.from({ length: 8 }, (_, k) => `${k}*40`).join(' ')
    expect(rollOverviewData(`<${arms}>`)).toBeNull()
    // and the same budget guards the single-cycle inline roll
    expect(rollOverviewData('0*300')).toBeNull()
    expect(MAX_OVERVIEW_CELLS).toBe(256)
  })

  it('no notes / unparseable → null (never throws)', () => {
    expect(rollOverviewData('<~ ~>')).toBeNull()
    expect(rollOverviewData('0(3,')).toBeNull()
  })
})

describe('rollOverviewBlockDecos (block placement below the notation line)', () => {
  it('a multi-cycle play line gets ONE block deco anchored at the LINE end', () => {
    const src = 'play z\n  <0 3> [5 7]  scale:a-min  # riff\n  gain: .5\n'
    const decos = rollOverviewBlockDecos(src, 400, hooks, drag)
    expect(decos).toHaveLength(1)
    expect(decos[0]!.value.spec.block).toBe(true) // below the line, not mid-wrap
    expect(decos[0]!.value.spec.side).toBe(1)
    // anchored at the END of the whole line (after scale + comment): an
    // inline anchor is what floated at a weird mid-wrap position
    expect(decos[0]!.from).toBe(src.indexOf('# riff') + '# riff'.length)
    const w = decos[0]!.value.spec.widget as RollOverviewWidget
    expect(w.data.period).toBe(2)
    expect(w.width).toBe(400)
  })

  it('single-cycle figures stay OFF the block path (they keep the inline roll)', () => {
    expect(rollOverviewBlockDecos('play z\n  0(3,8)\n', 400, hooks, drag)).toHaveLength(0)
  })

  it('HONESTY: unrepresentable patterns get no block deco either', () => {
    expect(rollOverviewBlockDecos('play z\n  <0 1 2 3 4 5 6 7 8>\n', 400, hooks, drag)).toHaveLength(0)
    const arms = Array.from({ length: 8 }, (_, k) => `${k}*40`).join(' ')
    expect(rollOverviewBlockDecos(`play z\n  <${arms}>\n`, 400, hooks, drag)).toHaveLength(0)
  })
})

describe('transpose drag math (one roll row = one degree step)', () => {
  it('quantizes vertical travel to whole steps of the roll row height', () => {
    expect(transposeSteps(0, 12)).toBe(0)
    expect(transposeSteps(5, 12)).toBe(0) // inside the first half row
    expect(transposeSteps(7, 12)).toBe(1)
    expect(transposeSteps(30, 12)).toBe(3) // 2.5 rows rounds up
    expect(transposeSteps(-13, 12)).toBe(-1)
    expect(transposeSteps(24, 8)).toBe(3) // tighter rows, finer steps
  })

  it('preview shift slides the cell layer one row per step, up for +', () => {
    expect(transposePreviewShift(2, 12)).toBe(-24)
    expect(transposePreviewShift(-1, 8)).toBe(8)
    expect(transposePreviewShift(0, 12)).toBe(0)
  })
})

describe('findAddTarget (the transpose handle\'s write target)', () => {
  const notationFrom = (src: string): number => scanRichPlays(src)[0]!.from

  it('finds an existing `add N` line and pinpoints the N literal', () => {
    const src = 'play z\n  <0 3> [5 7]\n  add 2\n'
    const t = findAddTarget(src, notationFrom(src))!
    expect(t.base).toBe(2)
    expect(src.slice(t.numFrom!, t.numTo!)).toBe('2') // the drag rewrites exactly this
    expect(t.insertAt).toBeUndefined()
  })

  it('negative values and trailing comments still match', () => {
    const src = 'play z\n  <0 3>\n  add -12  # down an octave-ish\n'
    const t = findAddTarget(src, notationFrom(src))!
    expect(t.base).toBe(-12)
    expect(src.slice(t.numFrom!, t.numTo!)).toBe('-12')
  })

  it('with no add line, reports the insert point after the LAST notation line', () => {
    const src = 'play z\n  <0 3> [5 7]  scale:a-min\n  <7 5> 3\n  gain: .5\n'
    const t = findAddTarget(src, notationFrom(src))!
    expect(t.base).toBe(0)
    expect(t.numFrom).toBeUndefined()
    expect(src.slice(0, t.insertAt!)).toBe('play z\n  <0 3> [5 7]  scale:a-min\n  <7 5> 3')
    expect(t.insertPrefix).toBe('\n  add ')
  })

  it('an add line the handle cannot own disables the handle (null)', () => {
    const a = 'play z\n  <0 3>\n  add .5\n'
    expect(findAddTarget(a, notationFrom(a))).toBeNull()
    const b = 'play z\n  <0 3>\n  add <0 7>\n'
    expect(findAddTarget(b, notationFrom(b))).toBeNull()
  })

  it('only play blocks qualify; a later block\'s add line never leaks in', () => {
    const src = 'play z\n  <0 3>\n\nplay t\n  <5 7>\n  add 5\n'
    const t = findAddTarget(src, notationFrom(src))!
    expect(t.base).toBe(0) // block s has NO add line — block t's must not count
    expect(src.slice(0, t.insertAt!)).toBe('play z\n  <0 3>')
  })

  it('section-nested play blocks keep their indent in the inserted line', () => {
    const src = 'section drop 4\n  play z\n    <0 3>\n'
    const t = findAddTarget(src, src.indexOf('<0 3>'))!
    expect(t.insertPrefix).toBe('\n    add ')
    // and an existing nested add line is found
    const src2 = 'section drop 4\n  play z\n    <0 3>\n    add 3\n'
    expect(findAddTarget(src2, src2.indexOf('<0 3>'))!.base).toBe(3)
  })
})

describe('addLineEdit (write derivation)', () => {
  it('updates an existing literal in place', () => {
    const src = 'play z\n  <0 3>\n  add 2\n'
    const t = findAddTarget(src, src.indexOf('<0 3>'))!
    const e = addLineEdit(t, 5)!
    expect(src.slice(0, e.from)).toBe('play z\n  <0 3>\n  add ')
    expect(src.slice(e.from, e.to)).toBe('2')
    expect(e.insert).toBe('5')
  })

  it('inserts a whole `add N` line when the block has none', () => {
    const src = 'play z\n  <0 3>\n  gain: .5\n'
    const t = findAddTarget(src, src.indexOf('<0 3>'))!
    const e = addLineEdit(t, -3)!
    expect(e.from).toBe(e.to) // a pure insert
    const next = src.slice(0, e.from) + e.insert + src.slice(e.to)
    expect(next).toBe('play z\n  <0 3>\n  add -3\n  gain: .5\n')
  })

  it('no-op transposes derive no edit (release in place, or back to start)', () => {
    const src = 'play z\n  <0 3>\n  add 2\n'
    const t = findAddTarget(src, src.indexOf('<0 3>'))!
    expect(addLineEdit(t, 2)).toBeNull()
    const bare = findAddTarget('play z\n  <0 3>\n', 9)!
    expect(addLineEdit(bare, 0)).toBeNull() // never writes `add 0` from rest
  })
})

describe('transpose write path (LIVE add-line rewrites + single-step undo)', () => {
  /* The add-line edit lives on a DIFFERENT line than the widget's anchor, so
   * both roll forms may live-write it per move; this pins the mid-gesture
   * doc samples and the one-step undo, with the REAL LiveWriter against a
   * REAL EditorState (the wavedef bar-drag test's shape). */

  const cmHost = (doc: string) => {
    let state = EditorState.create({ doc, extensions: [history()] })
    return {
      get state() { return state },
      dispatch(spec: { changes: { from: number; to: number; insert: string } | { from: number; to: number; insert: string }[] }) {
        state = state.update({ changes: spec.changes }).state
      },
      undoOnce(): boolean {
        return undo({ state, dispatch: (tr: Transaction) => { state = tr.state } })
      },
      text: () => state.doc.toString(),
    }
  }

  it('rewrites `add N` on EVERY step — sampled mid-gesture, before release', () => {
    const src = 'play z\n  <0 3> [5 7]\n  add 2\n'
    const h = cmHost(src)
    const t = findAddTarget(h.text(), h.text().indexOf('<0 3>'))!
    const w = new LiveWriter(h, t.numFrom!, t.numTo!)
    for (const steps of [1, 2, -1]) { // three pointermoves' quantized steps
      expect(w.write(String(t.base + steps))).toBe(true)
      // MID-GESTURE the doc already carries the new transpose (audible on eval)
      expect(findAddTarget(h.text(), h.text().indexOf('<0 3>'))!.base).toBe(t.base + steps)
    }
    expect(h.text()).toBe('play z\n  <0 3> [5 7]\n  add 1\n')
  })

  it('undo after the drag restores the pre-drag doc in ONE step', () => {
    const src = 'play z\n  <0 3> [5 7]\n  add 2\n'
    const h = cmHost(src)
    const t = findAddTarget(h.text(), h.text().indexOf('<0 3>'))!
    const w = new LiveWriter(h, t.numFrom!, t.numTo!)
    for (const n of [3, 4, 7]) w.write(String(n))
    expect(h.text()).not.toBe(src)
    expect(h.undoOnce()).toBe(true)
    expect(h.text()).toBe(src) // one step, not three
  })

  it('a concurrent edit aborts the writer (the gesture goes quiet)', () => {
    const src = 'play z\n  <0 3>\n  add 2\n'
    const h = cmHost(src)
    const t = findAddTarget(h.text(), h.text().indexOf('<0 3>'))!
    const w = new LiveWriter(h, t.numFrom!, t.numTo!)
    expect(w.write('3')).toBe(true)
    // someone types over the add line mid-gesture
    h.dispatch({ changes: { from: t.numFrom!, to: t.numFrom! + 1, insert: '9' } })
    expect(w.write('4')).toBe(false) // aborted, no blind splice
    expect(h.text()).toContain('add 9')
  })
})

describe('blockWidgetField serves the overview (map mid-drag, rebuild once)', () => {
  const widgetsIn = (state: EditorState): RollOverviewWidget[] => {
    const out: RollOverviewWidget[] = []
    for (const v of state.facet(EditorView.decorations)) {
      if (typeof v === 'function') continue
      ;(v as DecorationSet).between(0, state.doc.length, (_f, _t, deco) => {
        const w = deco.spec['widget']
        if (w instanceof RollOverviewWidget) out.push(w)
      })
    }
    return out
  }

  it('keeps the widget instance across live add-writes, swaps once at end', () => {
    const d: Drag = { active: false, ended: false }
    const doc = 'play z\n  <0 3> [5 7]\n  add 2\n'
    let state = EditorState.create({ doc, extensions: [blockWidgetField(hooks, d)] })
    const [w0] = widgetsIn(state)
    expect(w0).toBeDefined()
    expect(w0!.data.period).toBe(2)

    // pointerdown → live add rewrite ('2' → '-1', LENGTH CHANGES): mapped
    d.active = true
    const at = doc.indexOf('add 2') + 4
    state = state.update({ changes: { from: at, to: at + 1, insert: '-1' } }).state
    expect(widgetsIn(state)[0]).toBe(w0) // same instance: DOM survives the move

    // pointerup → onEnd: active off, ended on, one empty dispatch
    d.active = false
    d.ended = true
    state = state.update({}).state
    const [w2] = widgetsIn(state)
    expect(w2).not.toBe(w0) // rebuilt ONCE with fresh offsets

    d.ended = false
    state = state.update({}).state
    expect(widgetsIn(state)[0]).toBe(w2) // quiet transactions churn nothing
  })

  it('a single-cycle play line never reaches the block field', () => {
    const state = EditorState.create({
      doc: 'play z\n  0(3,8)\n',
      extensions: [blockWidgetField(hooks, drag)],
    })
    expect(widgetsIn(state)).toHaveLength(0)
  })
})
