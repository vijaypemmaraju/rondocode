import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { Decoration } from '@codemirror/view'
import { detect } from '../src/editor/widgets/detect'
import { renderableWidgets } from '../src/editor/widgets/widgets'
import { scrubText } from '../src/editor/widgets/scrub'
import { EXAMPLES } from '../src/examples'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* Headless decoration test: build a real EditorState (node, no DOM), reuse
 * its syntax tree for detect() — the exact hot path the view plugin runs —
 * and assert the replace ranges that would be decorated. The full plugin
 * (widget toDOM, pointer handling) needs a real EditorView + DOM and is
 * exercised manually in the browser instead. */

const state = (doc: string): EditorState =>
  EditorState.create({ doc, extensions: [javascript()] })

const widgetsOf = (doc: string) => {
  const s = state(doc)
  const tree = ensureSyntaxTree(s, s.doc.length, 5000)
  expect(tree).not.toBeNull()
  return detect(s.doc.toString(), tree!)
}

describe('widget decorations (headless)', () => {
  const doc = [
    `p('a', n('0 3 5').gain(slider(0.8, 0, 1)).sound('x'))`,
    `const on = toggle(true)`,
    `const scale = pick('a minor', 'a minor', 'c major')`,
  ].join('\n')

  it('detect over an EditorState syntax tree finds all three widgets', () => {
    const { widgets } = widgetsOf(doc)
    expect(widgets.map((w) => w.kind)).toEqual(['slider', 'toggle', 'pick'])
  })

  it('renderableWidgets keeps single-line calls and honors revealed ranges', () => {
    const { widgets } = widgetsOf(doc)
    const slider = widgets[0]!
    // reveal the slider: it must drop out, the others stay
    const shown = renderableWidgets(doc, widgets, [{ from: slider.from, to: slider.to }])
    expect(shown.map((w) => w.kind)).toEqual(['toggle', 'pick'])
    // no reveals: all three render
    expect(renderableWidgets(doc, widgets, [])).toHaveLength(3)
  })

  it('multi-line widget calls are never decorated (plugin replace limit)', () => {
    const multi = `slider(\n  0.5,\n  0, 1)`
    const { widgets } = widgetsOf(multi)
    expect(widgets).toHaveLength(1) // detected…
    expect(renderableWidgets(multi, widgets, [])).toHaveLength(0) // …but not rendered
  })

  it('replace decorations build headlessly over the detected ranges', () => {
    const { widgets } = widgetsOf(doc)
    const set = Decoration.set(
      widgets.map((w) => Decoration.replace({}).range(w.from, w.to)),
      true,
    )
    const got: { from: number; to: number }[] = []
    const cursor = set.iter()
    while (cursor.value !== null) {
      got.push({ from: cursor.from, to: cursor.to })
      cursor.next()
    }
    expect(got).toEqual(widgets.map((w) => ({ from: w.from, to: w.to })))
  })
})

describe('acid slider idiom (end-to-end regression)', () => {
  it('uncomment → detect → drag-rewrite → re-eval stays green', () => {
    // the exact doc a user gets by uncommenting the shipped hint line (the
    // slider idiom lives in the "acid" example, not necessarily EXAMPLES[0])
    const acidBase = EXAMPLES.find((e) => e.name === 'acid')!.code
    const acid = acidBase.replace('// .ctrl(', '.ctrl(')
    expect(acid).not.toBe(acidBase) // the hint line exists

    const { widgets } = detect(acid)
    const slider = widgets.find((w) => w.kind === 'slider')
    expect(slider).toBeDefined()
    expect(slider!.args.map((a) => a.value)).toEqual([1200, 200, 2400])
    expect(evalCode(acid, baseScope).ok).toBe(true)

    // scrub the value literal 40px right and splice — the drag path
    const arg = slider!.args[0]!
    const next = scrubText(arg.value as number, 40, !/[.eE]/.test(arg.raw))
    expect(next).toBe('1250') // 10%/100px of 1200, quantized to 10s
    const doc2 = acid.slice(0, arg.from) + next + acid.slice(arg.to)
    expect(evalCode(doc2, baseScope).ok).toBe(true)
  })
})
