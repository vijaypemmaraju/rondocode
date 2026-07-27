import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { WAVETABLE_MAX_PARTIALS, clearCustomWavetables, defineWavetable, getWavetable, getWavetableBank } from '@rondocode/engine'
import {
  MAX_PARTIALS,
  WavedefWidget,
  appendPartialEdit,
  barLayout,
  barValue,
  downsampleWave,
  morphWave,
  partialWave,
  previewFrames,
  removePartialEdit,
  rescanWavedef,
  scanWavedefs,
  scanWavetableCalls,
  wavedefBlockDecos,
} from '../src/editor/rondo/wavetable'
import { wavedefField } from '../src/editor/rondo/widgets'
import type { Hooks } from '../src/editor/rondo/widgets'
import { LiveWriter } from '../src/editor/rondo/gesture'
import type { Drag } from '../src/editor/rondo/gesture'
import { formatNumber } from '../src/editor/widgets/rewrite'

/* Pure parts of the wavetable widgets: scanning, rewrite-range derivation,
 * bar geometry, waveform math, and the wavedef editor's POSITION/WRITE
 * contract (block placement + gesture-time rescan). DOM/gesture glue stays
 * thin (it reuses the shared attachGesture/LiveWriter protocol) and is
 * verified on-device with synthetic pointer sequences. */

const hooks: Hooks = { requestEval: () => {} }
const drag: Drag = { active: false, ended: false }

describe('scanWavedefs', () => {
  it('parses frames, values and per-number source ranges', () => {
    const src = 'wavedef vox 1 .3 / .5 1 .6\n'
    const [wd] = scanWavedefs(src)
    expect(wd).toBeDefined()
    expect(wd!.name).toBe('vox')
    expect(wd!.frames).toEqual([[1, 0.3], [0.5, 1, 0.6]])
    // ranges point at the exact number tokens
    const texts = wd!.ranges.map((fr) => fr.map((r) => src.slice(r.from, r.to)))
    expect(texts).toEqual([['1', '.3'], ['.5', '1', '.6']])
    expect(wd!.at).toBe(src.indexOf('.6') + 2)
  })

  it('offsets are absolute across lines and comments are ignored', () => {
    const src = 'cps .5\n\nwavedef a 1 / .5  # bright\nwavedef b 0 1 / 1 0\n'
    const defs = scanWavedefs(src)
    expect(defs.map((d) => d.name)).toEqual(['a', 'b'])
    const a = defs[0]!
    expect(src.slice(a.ranges[1]![0]!.from, a.ranges[1]![0]!.to)).toBe('.5')
    // the widget anchor stops before the comment
    expect(src.slice(a.at - 2, a.at)).toBe('.5')
  })

  it('skips lines that are not purely numbers and slashes (mid-edit safety)', () => {
    expect(scanWavedefs('wavedef vox 1 x / 1\n')).toEqual([])
    expect(scanWavedefs('wavedef vox 1 / / 1\n')).toEqual([])
    expect(scanWavedefs('wavedef vox\n')).toEqual([])
    // negatives and a single frame are fine (the parser flags <2 frames; the
    // widget still renders while the second frame is being typed)
    expect(scanWavedefs('wavedef vox 1 -.5\n')[0]!.frames).toEqual([[1, -0.5]])
  })
})

describe('scanWavetableCalls', () => {
  const SRC = [
    'synth lead',
    '  wavetable note scan table:vox',
    '  * env',
    '  env = adsr .01 .1 .8 .1',
    '  scan = env -> .1...9',
    '',
    'synth pad',
    '  wavetable note .35 table:harmonic',
    '',
    'synth plain',
    '  wavetable',
    '',
    'play lead',
    '  0 3 5',
    '',
  ].join('\n')

  it('finds calls with their synth, table and literal pos', () => {
    const calls = scanWavetableCalls(SRC)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ synth: 'lead', table: 'vox' })
    expect(calls[0]!.posLiteral).toBeUndefined() // pos is the `scan` binding
    expect(calls[1]).toMatchObject({ synth: 'pad', table: 'harmonic', posLiteral: 0.35 })
    expect(calls[2]).toMatchObject({ synth: 'plain', table: 'basic', posLiteral: 0 })
  })

  it('binding lines and rich argument shapes: table read, pos left as a signal', () => {
    const calls = scanWavetableCalls('synth s\n  o = wavetable note sine 2 table:pwm\n  o\n')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.table).toBe('pwm')
    expect(calls[0]!.posLiteral).toBeUndefined() // `sine 2` is not a simple atom pair
  })

  it('ignores wavetable outside a synth block and inside comments', () => {
    expect(scanWavetableCalls('play x\n  0 1\n')).toEqual([])
    expect(scanWavetableCalls('synth s\n  saw  # wavetable .5\n')).toEqual([])
  })
})

describe('bar geometry', () => {
  it('targets 44px columns and floors at 20px with scroll', () => {
    expect(barLayout(4, 400)).toEqual({ barW: 44, totalW: 176, scroll: false })
    expect(barLayout(10, 300)).toEqual({ barW: 30, totalW: 300, scroll: false })
    expect(barLayout(32, 300)).toEqual({ barW: 20, totalW: 640, scroll: true })
  })

  it('barValue maps pointer y to a 2-decimal amplitude, clamped', () => {
    expect(barValue(100, 100, 100)).toBe(1) // at the top
    expect(barValue(200, 100, 100)).toBe(0) // at the bottom
    expect(barValue(150, 100, 100)).toBe(0.5)
    expect(barValue(-50, 100, 100)).toBe(1) // above: clamp
    expect(barValue(1234, 100, 100)).toBe(0) // below: clamp
    expect(barValue(133.3333, 100, 100)).toBe(0.67) // snapped
  })
})

describe('rewrite range derivation (append / remove partial)', () => {
  const src = 'wavedef vox 1 .3 / .5 1\n'
  const scan = scanWavedefs(src)[0]!

  it('append inserts " 0" after the frame\'s last number', () => {
    const e0 = appendPartialEdit(scan, 0)!
    expect(src.slice(0, e0.from)).toBe('wavedef vox 1 .3')
    expect(e0).toMatchObject({ insert: ' 0' })
    expect(e0.from).toBe(e0.to)
    const e1 = appendPartialEdit(scan, 1)!
    expect(src.slice(0, e1.from)).toBe('wavedef vox 1 .3 / .5 1')
  })

  it('append refuses past the 32-partial cap', () => {
    const big = `wavedef big ${Array.from({ length: 32 }, () => '1').join(' ')} / 1\n`
    const s = scanWavedefs(big)[0]!
    expect(appendPartialEdit(s, 0)).toBeNull()
    expect(appendPartialEdit(s, 1)).not.toBeNull()
  })

  it('remove deletes the last number (with its separating space)', () => {
    const e = removePartialEdit(scan, 0)!
    expect(src.slice(e.from, e.to)).toBe(' .3')
    expect(e.insert).toBe('')
  })

  it('remove refuses to empty a frame', () => {
    const one = scanWavedefs('wavedef x 1 / 1 .5\n')[0]!
    expect(removePartialEdit(one, 0)).toBeNull()
    expect(removePartialEdit(one, 1)).not.toBeNull()
  })
})

describe('waveform math', () => {
  it('partialWave of a lone fundamental is a unit sine', () => {
    const w = partialWave([1], 8)
    expect(w[0]).toBeCloseTo(0, 6)
    expect(w[2]).toBeCloseTo(1, 6) // sin(pi/2)
    expect(w[6]).toBeCloseTo(-1, 6)
  })

  it('partialWave normalizes the peak to 1 whatever the amplitudes', () => {
    const w = partialWave([0.2, 0.05, 0.01], 128)
    const peak = Math.max(...Array.from(w).map(Math.abs))
    expect(peak).toBeCloseTo(1, 6)
  })

  it('morphWave interpolates sample-wise between adjacent frames', () => {
    const a = new Float32Array([0, 0, 0])
    const b = new Float32Array([1, 1, 1])
    expect(Array.from(morphWave([a, b], 0.5))).toEqual([0.5, 0.5, 0.5])
    expect(Array.from(morphWave([a, b], 0))).toEqual([0, 0, 0])
    expect(Array.from(morphWave([a, b], 1))).toEqual([1, 1, 1])
    // clamped out-of-range t
    expect(Array.from(morphWave([a, b], 2))).toEqual([1, 1, 1])
  })

  it('downsampleWave keeps length and range', () => {
    const src = new Float32Array(2048).map((_, i) => Math.sin((2 * Math.PI * i) / 2048))
    const d = downsampleWave(src, 96)
    expect(d.length).toBe(96)
    expect(Math.max(...Array.from(d))).toBeGreaterThan(0.9)
  })
})

describe('wavedef editor contract (block placement + gesture-time rescan)', () => {
  /* THE bug this pins against: the editor used to be an INLINE widget after
   * the line's text, so a live bar drag that changed a number's LENGTH
   * ('.3' → '0.55') reflowed the line and shifted the widget under the
   * pointer. The contract now: BLOCK widget below the line (position cannot
   * depend on the line's text length), VALUE drags live-write per move, and
   * structural [+]/[x] edits stay deferred to gesture end. */

  it('decorates wavedef lines as BLOCK widgets anchored at the LINE END', () => {
    const src = 'cps .5\nwavedef vox 1 .3 / .5 1  # bright\nwavedef b 0 1 / 1 0\n'
    const decos = wavedefBlockDecos(src, 400, hooks, drag)
    expect(decos).toHaveLength(2)
    for (const d of decos) {
      expect(d.value.spec.block).toBe(true) // below the line, not in its flow
      expect(d.value.spec.side).toBe(1)
    }
    // anchored at the line's END (after any trailing comment), never at the
    // code part's end — an in-line anchor is what shifted under drags
    expect(decos[0]!.from).toBe(src.indexOf('# bright') + '# bright'.length)
    expect(decos[1]!.from).toBe(src.length - 1)
  })

  it('eq() is OFFSET-FREE: edits elsewhere keep the DOM; content changes do not', () => {
    const a = scanWavedefs('wavedef vox 1 .3 / .5 1\n')[0]!
    // the same wavedef, shifted by an unrelated line above it
    const b = scanWavedefs('cps .5\nwavedef vox 1 .3 / .5 1\n')[0]!
    expect(a.at).not.toBe(b.at)
    const wa = new WavedefWidget(a, 400, hooks, drag)
    expect(wa.eq(new WavedefWidget(b, 400, hooks, drag))).toBe(true) // no flicker
    // …but a value/name/width change must produce a fresh DOM
    const edited = scanWavedefs('wavedef vox 1 .35 / .5 1\n')[0]!
    expect(wa.eq(new WavedefWidget(edited, 400, hooks, drag))).toBe(false)
    const renamed = scanWavedefs('wavedef pox 1 .3 / .5 1\n')[0]!
    expect(wa.eq(new WavedefWidget(renamed, 400, hooks, drag))).toBe(false)
    expect(wa.eq(new WavedefWidget(b, 360, hooks, drag))).toBe(false)
  })

  it('rescanWavedef re-derives CURRENT write ranges at gesture time', () => {
    // the widget was built against this doc…
    const values = scanWavedefs('wavedef vox 1 .3 / .5 1\n')[0]!.frames
    // …but by pointerdown the doc gained a line above (stale build offsets)
    const now = 'cps .5\nwavedef vox 1 .3 / .5 1\n'
    const cur = rescanWavedef(now, 'vox', values)
    expect(cur).not.toBeNull()
    const r = cur!.ranges[0]![1]!
    expect(now.slice(r.from, r.to)).toBe('.3') // the drag writes exactly this
  })

  it('rescanWavedef refuses when the def was renamed or its values changed', () => {
    const values = scanWavedefs('wavedef vox 1 .3 / .5 1\n')[0]!.frames
    expect(rescanWavedef('wavedef pox 1 .3 / .5 1\n', 'vox', values)).toBeNull()
    expect(rescanWavedef('wavedef vox 1 .9 / .5 1\n', 'vox', values)).toBeNull()
    expect(rescanWavedef('', 'vox', values)).toBeNull()
  })

  it('rescanWavedef picks the values-matching def among same-name doppelgangers', () => {
    const src = 'wavedef vox 1 1 / 0 0\nwavedef vox 1 .3 / .5 1\n'
    const values = [[1, 0.3], [0.5, 1]]
    const cur = rescanWavedef(src, 'vox', values)!
    const r = cur.ranges[0]![1]!
    expect(src.slice(r.from, r.to)).toBe('.3') // the SECOND def, not the first
  })
})

describe('previewFrames source resolution', () => {
  afterEach(() => clearCustomWavetables())

  it('the widget partial cap mirrors the engine constant (deliberate duplicate)', () => {
    // duplicated so the widget module never statically imports the engine
    // (docs eager-graph boundary) — this pin is what keeps the two in step
    expect(MAX_PARTIALS).toBe(WAVETABLE_MAX_PARTIALS)
  })

  it('doc wavedefs win (fresh while typing), then the injected bank, then null', () => {
    const doc = scanWavedefs('wavedef fresh 1 / 0 1\n')
    const fromDoc = previewFrames('fresh', doc, getWavetableBank)
    expect(fromDoc).not.toBeNull()
    expect(fromDoc!).toHaveLength(2)
    // built-in bank through the injected lookup
    const basic = previewFrames('basic', [], getWavetableBank)
    expect(basic!.length).toBe(getWavetable('basic').length)
    // registry custom (last successful eval)
    defineWavetable('evaled', [[1], [0, 1], [0, 0, 1]])
    expect(previewFrames('evaled', [], getWavetableBank)!).toHaveLength(3)
    // nowhere / no injected bank (the docs page before the engine loads)
    expect(previewFrames('ghost', [], getWavetableBank)).toBeNull()
    expect(previewFrames('basic', [])).toBeNull()
  })
})

describe('bar drag write path (LIVE per-move rewrites + single-step undo)', () => {
  /* Pins verification (a) and (e) of the drag-contract fix headlessly: the
   * doc must change on every pointerMOVE (not only at release — the shipped
   * bug), and undo after the whole drag must restore the pre-drag doc in ONE
   * step (LiveWriter's serial same-range writes coalesce in history exactly
   * like the knob's). Uses the REAL LiveWriter against a REAL EditorState. */

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

  it('rewrites the doc on EVERY move — sampled mid-gesture, before release', () => {
    const src = 'wavedef vox 1 .3 / .5 1\n'
    const h = cmHost(src)
    // gesture start: fresh scan of the CURRENT doc (what the widget does)
    const scan = rescanWavedef(h.text(), 'vox', [[1, 0.3], [0.5, 1]])!
    const r = scan.ranges[0]![1]! // the '.3'
    const w = new LiveWriter(h, r.from, r.to)
    for (const v of [0.13, 0.55, 0.9]) { // three pointermoves
      expect(w.write(formatNumber(v, { step: 0.01, min: 0 }))).toBe(true)
      // MID-GESTURE the doc already carries the new value (audible on eval)
      expect(scanWavedefs(h.text())[0]!.frames[0]![1]).toBe(v)
    }
    expect(h.text()).toBe('wavedef vox 1 0.9 / .5 1\n')
  })

  it('undo after the drag restores the pre-drag doc in ONE step', () => {
    const src = 'wavedef vox 1 .3 / .5 1\n'
    const h = cmHost(src)
    const scan = rescanWavedef(h.text(), 'vox', [[1, 0.3], [0.5, 1]])!
    const r = scan.ranges[0]![1]!
    const w = new LiveWriter(h, r.from, r.to)
    for (const v of [0.13, 0.55, 0.9]) w.write(formatNumber(v, { step: 0.01, min: 0 }))
    expect(h.text()).not.toBe(src)
    expect(h.undoOnce()).toBe(true)
    expect(h.text()).toBe(src) // one step, not three
  })
})

describe('wavedefField rebuild lifecycle (map mid-drag, rebuild ONCE at end)', () => {
  /* Pins verification (c) headlessly: while drag.active the field MAPS its
   * decorations (the dragged DOM and its pointer capture survive every live
   * write); the gesture-end dispatch (drag.ended) rebuilds exactly once with
   * fresh ranges; quiet transactions after the flag clears rebuild nothing. */

  const widgetsIn = (state: EditorState): WavedefWidget[] => {
    const out: WavedefWidget[] = []
    for (const v of state.facet(EditorView.decorations)) {
      if (typeof v === 'function') continue
      ;(v as DecorationSet).between(0, state.doc.length, (_f, _t, deco) => {
        const w = deco.spec['widget']
        if (w instanceof WavedefWidget) out.push(w)
      })
    }
    return out
  }

  it('keeps the widget instance across live writes, swaps it once at gesture end', () => {
    const d: Drag = { active: false, ended: false }
    let state = EditorState.create({
      doc: 'wavedef vox 1 .3 / .5 1\n',
      extensions: [wavedefField(hooks, d)],
    })
    const [w0] = widgetsIn(state)
    expect(w0).toBeDefined()

    // pointerdown → live write ('.3' → '0.55' — LENGTH CHANGES): mapped, kept
    d.active = true
    state = state.update({ changes: { from: 14, to: 16, insert: '0.55' } }).state
    expect(widgetsIn(state)[0]).toBe(w0) // same instance: DOM survives the move

    // pointerup → onEnd: active off, ended on, one empty dispatch
    d.active = false
    d.ended = true
    state = state.update({}).state
    const [w2] = widgetsIn(state)
    expect(w2).not.toBe(w0) // rebuilt ONCE…
    expect(w2!.scan.frames[0]![1]).toBe(0.55) // …with the fresh post-drag scan

    // the main plugin consumes the flag after its own rebuild; from then on
    // quiet transactions must not churn the widget
    d.ended = false
    state = state.update({}).state
    expect(widgetsIn(state)[0]).toBe(w2)
  })

  it('an external edit while NO gesture is live rebuilds with fresh ranges', () => {
    const d: Drag = { active: false, ended: false }
    let state = EditorState.create({
      doc: 'wavedef vox 1 .3 / .5 1\n',
      extensions: [wavedefField(hooks, d)],
    })
    const [w0] = widgetsIn(state)
    state = state.update({ changes: { from: 0, to: 0, insert: 'cps .5\n' } }).state
    const [w1] = widgetsIn(state)
    expect(w1).not.toBe(w0) // rebuilt (fresh at/ranges)…
    expect(w1!.eq(w0!)).toBe(true) // …but eq() keeps the DOM: no flicker
  })
})
