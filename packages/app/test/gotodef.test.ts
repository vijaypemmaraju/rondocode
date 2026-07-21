import { describe, expect, it } from 'vitest'
import { definitionTarget, identifierAt } from '../src/editor/gotodef'

describe('identifierAt', () => {
  const doc = "p('x', n('0').sound('acid'))"
  it('spans the identifier under a position', () => {
    const at = identifierAt(doc, doc.indexOf('acid') + 1)
    expect(at).toEqual({ from: doc.indexOf('acid'), to: doc.indexOf('acid') + 4, text: 'acid' })
  })
  it('works at the start of a token', () => {
    expect(identifierAt('stack(s0, s1)', 6)!.text).toBe('s0')
  })
  it('returns null for numbers and punctuation', () => {
    expect(identifierAt("n('0 3')", 3)).toBeNull() // on the '0'
    expect(identifierAt('a + b', 2)).toBeNull() // on the '+'
  })
})

describe('definitionTarget', () => {
  const doc = [
    "const acid = synth(({ note }) => note.freq)",
    "const s0 = note('c4 e4')",
    "function helper(x) { return x }",
    "p('bass', s0.sound('acid'))",
  ].join('\n')

  it('finds a synth definition (preferSynth) for a .sound() name', () => {
    const t = definitionTarget(doc, 'acid', true)
    expect(doc.slice(t!.from, t!.to)).toBe('acid')
    expect(t!.from).toBe(doc.indexOf('const acid') + 'const '.length) // the decl, not the usage
  })

  it('finds a const/var definition for a plain identifier', () => {
    const t = definitionTarget(doc, 's0', false)
    expect(t!.from).toBe(doc.indexOf('const s0') + 'const '.length)
  })

  it('finds a function definition', () => {
    const t = definitionTarget(doc, 'helper', false)
    expect(t!.from).toBe(doc.indexOf('function helper') + 'function '.length)
  })

  it('returns null when there is no declaration (a built-in like stack)', () => {
    expect(definitionTarget(doc, 'stack', false)).toBeNull()
  })
})
