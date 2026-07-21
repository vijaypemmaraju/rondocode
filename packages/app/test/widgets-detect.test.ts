import { describe, expect, it } from 'vitest'
import { detect } from '../src/editor/widgets/detect'

/* detect(): pure doc-text → widget descriptors + scrubbable numbers.
 * Ranges are asserted via indexOf so the fixtures stay readable. */

const rangeOf = (doc: string, text: string): { from: number; to: number } => {
  const from = doc.indexOf(text)
  expect(from).toBeGreaterThanOrEqual(0)
  return { from, to: from + text.length }
}

describe('detect: widget calls', () => {
  it('finds a slider call nested in a method chain, with exact ranges', () => {
    const doc = `p('a', n('0 3').gain(slider(0.8, 0, 1)).sound('x'))`
    const { widgets } = detect(doc)
    expect(widgets).toHaveLength(1)
    const w = widgets[0]!
    expect(w.kind).toBe('slider')
    expect({ from: w.from, to: w.to }).toEqual(rangeOf(doc, 'slider(0.8, 0, 1)'))
    expect(w.args.map((a) => a.value)).toEqual([0.8, 0, 1])
    expect({ from: w.args[0]!.from, to: w.args[0]!.to }).toEqual(rangeOf(doc, '0.8'))
    expect(w.args[0]!.raw).toBe('0.8')
  })

  it('accepts slider arity 1..4 (all numbers), rejects 0 and 5', () => {
    expect(detect('slider(1)').widgets).toHaveLength(1)
    expect(detect('slider(1, 0, 2, 0.5)').widgets).toHaveLength(1)
    expect(detect('slider()').widgets).toHaveLength(0)
    expect(detect('slider(1, 0, 2, 0.5, 9)').widgets).toHaveLength(0)
    expect(detect("slider('a', 0, 1)").widgets).toHaveLength(0)
  })

  it('folds a unary minus into a literal argument', () => {
    const doc = 'xy(0.3, -0.7)'
    const { widgets } = detect(doc)
    expect(widgets).toHaveLength(1)
    expect(widgets[0]!.args[1]!.value).toBe(-0.7)
    expect({ from: widgets[0]!.args[1]!.from, to: widgets[0]!.args[1]!.to }).toEqual(
      rangeOf(doc, '-0.7'),
    )
  })

  it('toggle: exactly one boolean', () => {
    expect(detect('toggle(true)').widgets[0]?.kind).toBe('toggle')
    expect(detect('toggle(false)').widgets[0]?.args[0]?.value).toBe(false)
    expect(detect('toggle(1)').widgets).toHaveLength(0)
    expect(detect('toggle(true, false)').widgets).toHaveLength(0)
  })

  it('pick: value + options, raws keep quote style; a lone value is no widget', () => {
    const doc = `pick('a minor', 'a minor', "c major")`
    const { widgets } = detect(doc)
    expect(widgets).toHaveLength(1)
    expect(widgets[0]!.args.map((a) => a.raw)).toEqual([`'a minor'`, `'a minor'`, `"c major"`])
    expect(detect("pick('a')").widgets).toHaveLength(0)
  })

  it('xy: exactly two numbers', () => {
    expect(detect('xy(0.1, 0.2)').widgets).toHaveLength(1)
    expect(detect('xy(0.1)').widgets).toHaveLength(0)
    expect(detect('xy(0.1, 0.2, 0.3)').widgets).toHaveLength(0)
  })

  it('any non-literal argument disables the widget (code still valid text)', () => {
    expect(detect('slider(x * 2, 0, 10)').widgets).toHaveLength(0)
    expect(detect('slider(getV(), 0, 1)').widgets).toHaveLength(0)
    expect(detect("pick(mode, 'a', 'b')").widgets).toHaveLength(0)
  })

  it('strings with escapes are not literals (offset exactness)', () => {
    expect(detect("pick('a\\'b', 'c')").widgets).toHaveLength(0)
  })

  it('a valid widget inside an invalid outer widget call still renders', () => {
    const doc = 'slider(slider(0.5, 0, 1), 0, 1)'
    const { widgets } = detect(doc)
    expect(widgets).toHaveLength(1)
    expect({ from: widgets[0]!.from, to: widgets[0]!.to }).toEqual(
      rangeOf(doc, 'slider(0.5, 0, 1)'),
    )
  })

  it('method-property slider (obj.slider(1)) is not a widget', () => {
    expect(detect('foo.slider(1)').widgets).toHaveLength(0)
  })

  it('survives a malformed doc (lezer error tolerance): intact calls still found', () => {
    const doc = 'const a = slider(0.5, 0, 1)\nconst broken = ((('
    expect(detect(doc).widgets).toHaveLength(1)
  })
})

describe('detect: scrubbable numbers', () => {
  it('reports plain numbers with isInt from the source spelling', () => {
    const doc = 'a(0.003).b(800).c(1e3)'
    const nums = detect(doc).numbers
    expect(nums.map((n) => [n.value, n.isInt])).toEqual([
      [0.003, false],
      [800, true],
      [1000, false],
    ])
    expect({ from: nums[0]!.from, to: nums[0]!.to }).toEqual(rangeOf(doc, '0.003'))
  })

  it('excludes numbers hidden inside a valid widget call', () => {
    const doc = 'gain(slider(0.8, 0, 1)).dur(0.6)'
    expect(detect(doc).numbers.map((n) => n.value)).toEqual([0.6])
  })

  it('keeps numbers of an INVALID widget call (they are visible text)', () => {
    const doc = 'slider(x, 0, 10)'
    expect(detect(doc).numbers.map((n) => n.value)).toEqual([0, 10])
  })

  it('folds a directly-attached unary minus, skips hex/bigint', () => {
    const doc = 'f(-5).g(0x10).h(10n)'
    const nums = detect(doc).numbers
    expect(nums).toHaveLength(1)
    expect(nums[0]!.value).toBe(-5)
    expect(nums[0]!.isInt).toBe(true)
    expect({ from: nums[0]!.from, to: nums[0]!.to }).toEqual(rangeOf(doc, '-5'))
  })

  it('numbers inside strings/comments are not literals', () => {
    const doc = `s('bd 808') // 4x4\n`
    expect(detect(doc).numbers).toHaveLength(0)
  })
})
