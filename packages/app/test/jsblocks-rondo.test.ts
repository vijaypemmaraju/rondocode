import { describe, expect, it } from 'vitest'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { highlightTree } from '@lezer/highlight'
import { jsRegionRanges } from '../src/editor/jsblocks'
import { editorHighlightStyle } from '../src/editor/theme'

/* JavaScript highlighting inside rondo's escape hatches.
 *
 * A `js` block body and an inline `js{ … }` span are raw JavaScript, but the
 * rondo tokenizer painted them by rondo's rules — and `sample`, `gain`, `note`
 * and `mix` are rondo vocabulary too, so escaped JS came out coloured as music
 * (the exact bug wgsl-rondo.test.ts pins for `visual` bodies).
 *
 * The overlay runs the real lezer JS parser over the regions, so what these
 * pin is WHICH RANGES it is pointed at: the two escape-hatch spellings, the
 * block rule (indentation, exactly the parser's), and the traps — comments,
 * strings, shader bodies — where a `js{` is not an escape hatch. */

const DOC = `bpm 120

js
  const lay = elevenlabs('pad', { cycles: 8 })
  defineSynth('ambient', synth(({ gate, sample }) =>
    sample(gate, lay, { root: 57 })))

play lead
  0 3 5

js{ sidechain('kick', { depth: 0.7 }) }
`

/** The JS source the highlighter would paint, as one string. */
const jsOf = (src: string): string =>
  jsRegionRanges(src).map((r) => src.slice(r.from, r.to)).join('\n---\n')

/** The highlight classes the overlay would give `text` inside `src`. */
const classOf = (src: string, text: string): string | undefined => {
  for (const r of jsRegionRanges(src)) {
    const region = src.slice(r.from, r.to)
    const i = region.indexOf(text)
    if (i < 0) continue
    const tree = javascriptLanguage.parser.parse(region)
    let found: string | undefined
    highlightTree(tree, editorHighlightStyle, (from, to, classes) => {
      if (from <= i && to >= i + text.length) found = classes
    })
    return found
  }
  return undefined
}

describe('jsRegionRanges', () => {
  it('finds the body of a `js` block', () => {
    const body = jsOf(DOC)
    expect(body).toContain("const lay = elevenlabs('pad', { cycles: 8 })")
    expect(body).toContain("defineSynth('ambient'")
  })

  it('finds the inside of an inline js{ … } span (braces excluded)', () => {
    const body = jsOf(DOC)
    expect(body).toContain("sidechain('kick', { depth: 0.7 })")
    expect(body).not.toContain("js{")
  })

  it('stops at the block, so the music around it is never painted as JS', () => {
    const body = jsOf(DOC)
    expect(body).not.toContain('bpm')
    expect(body).not.toContain('play lead')
  })

  it('keeps a blank line inside the block rather than closing on one', () => {
    const doc = `js
  const a = 1

  const b = 2

bpm 120
`
    expect(jsOf(doc)).toContain('const b = 2')
    expect(jsOf(doc)).not.toContain('bpm')
  })

  it('finds the body of a `mask N` block, which is a JavaScript painter', () => {
    const src = "synth z\n  saw\n\nmask 4\n  const r = Math.hypot(x, y)\n  return r < 9 ? '#f40' : null\n\nplay mask\n  4\n"
    expect(jsOf(src)).toBe("  const r = Math.hypot(x, y)\n  return r < 9 ? '#f40' : null")
  })

  it('finds the body of a `draw N` block, which is a JavaScript painter too', () => {
    const src = "synth z\n  saw\n\ndraw 2\n  const x = i / n\n  return x < beat ? 1 : 0\n\nplay mask\n  0\n  draw: 2\n"
    expect(jsOf(src)).toBe('  const x = i / n\n  return x < beat ? 1 : 0')
  })

  it('is not opened by `js` used as anything but a header or a js{ span', () => {
    expect(jsRegionRanges('play js\n  0 3 5\n')).toEqual([])
    expect(jsRegionRanges('synth jsx\n  saw\n')).toEqual([])
  })

  it('ignores a js{ … } inside a rondo comment', () => {
    expect(jsRegionRanges("# js{ notActuallyCode() }\nbpm 120\n")).toEqual([])
  })

  it('ignores braces and hashes inside strings, like the lexer', () => {
    // the `#` is inside a string: stripComment must not cut the span short,
    // and the `}` inside the string must not close it
    const doc = `js{ p('x', sound('bd } # sn')) }\n`
    expect(jsOf(doc)).toBe(" p('x', sound('bd } # sn')) ")
  })

  it('does not read a { inside a visual body as an escape hatch', () => {
    const doc = `visual
  fn js{ let x = 1.0; }

bpm 120
`
    expect(jsRegionRanges(doc)).toEqual([])
  })

  it('paints an unterminated span to end of line — the state while typing', () => {
    expect(jsOf('js{ setCps(0.5')).toBe(' setCps(0.5')
  })

  it('finds several inline spans on one line', () => {
    expect(jsRegionRanges('js{ a() } js{ b() }\n')).toHaveLength(2)
  })

  it('finds a block that runs to the end of the document', () => {
    expect(jsOf('bpm 120\n\njs\n  masterGain(-4)\n')).toBe('  masterGain(-4)')
  })
})

describe('what the escaped JS gets painted as', () => {
  it('paints keywords, strings and numbers as JavaScript', () => {
    expect(classOf(DOC, 'const')).toBeDefined()
    expect(classOf(DOC, "'ambient'")).toBeDefined()
    expect(classOf(DOC, '57')).toBeDefined()
    // keyword and string must not share a class — that would be one colour
    expect(classOf(DOC, 'const')).not.toBe(classOf(DOC, "'ambient'"))
  })

  it('paints the collisions as JS, which is the whole bug', () => {
    // `synth` and `sidechain` are exactly the words rondo would have claimed
    // as its own keywords. Here both are ordinary JS call expressions, and
    // they must class like each other — and NOT like a real JS keyword.
    expect(classOf(DOC, 'synth')).toBeDefined()
    expect(classOf(DOC, 'synth')).toBe(classOf(DOC, 'sidechain'))
    expect(classOf(DOC, 'synth')).not.toBe(classOf(DOC, 'const'))
  })
})
