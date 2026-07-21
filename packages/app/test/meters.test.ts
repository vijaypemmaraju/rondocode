import { describe, expect, it } from 'vitest'
import { METER_RELEASE_MS, meterAnchors, nextDisplay, scanSynthDecls } from '../src/editor/meters'

/* Pure pieces of the inline synth meters: the declaration scanner (must
 * mirror transformSynthDecls in evalCode.ts — those names ARE the engine
 * channel names), the anchor placement (end of the `synth(` line), and the
 * peak-hold smoothing (attack instant, ~300 ms exponential release).
 * DOM/rAF paths are intentionally untested (node environment). */

const names = (doc: string): string[] => scanSynthDecls(doc).map((d) => d.name)

describe('scanSynthDecls', () => {
  it('finds top-level const and let synth declarations, in doc order', () => {
    const doc = `const kick = synth((p) => osc('sine'))\nlet bass = synth({})\n`
    expect(names(doc)).toEqual(['kick', 'bass'])
    // `at` points at the synth callee itself
    const decls = scanSynthDecls(doc)
    expect(doc.slice(decls[0]!.at, decls[0]!.at + 5)).toBe('synth')
  })

  it('ignores var declarations (they never register a synth)', () => {
    expect(names('var kick = synth({})')).toEqual([])
  })

  it('requires a DIRECT synth(...) call: wrappers and members do not count', () => {
    expect(names('const a = id(synth({}))')).toEqual([])
    expect(names('const b = lib.synth({})')).toEqual([])
    expect(names('const c = synth')).toEqual([])
  })

  it('ignores declarations inside functions/blocks (top level only)', () => {
    expect(names('function f() { const inner = synth({}) }')).toEqual([])
    expect(names('{ const inner = synth({}) }')).toEqual([])
  })

  it('handles multiple declarators, pairing each name with ITS initializer', () => {
    const doc = 'const a = 1, pad = synth({}), b = other(), lead = synth({})'
    expect(names(doc)).toEqual(['pad', 'lead'])
  })

  it('finds a multi-line synth call', () => {
    expect(names('const pad = synth({\n  osc: 1,\n})')).toEqual(['pad'])
  })

  it('survives a malformed doc (lezer error tolerance)', () => {
    expect(names('const kick = synth({})\nconst broken = (((')).toEqual(['kick'])
  })
})

describe('meterAnchors', () => {
  it('anchors at the end of the line holding the synth call', () => {
    const doc = `const kick = synth({})\nconst bass = synth({})\n`
    const anchors = meterAnchors(doc, scanSynthDecls(doc))
    expect(anchors).toEqual([
      { name: 'kick', pos: doc.indexOf('\n') },
      { name: 'bass', pos: doc.indexOf('\n', doc.indexOf('bass')) },
    ])
  })

  it('multi-line call: the FIRST line (the one with `synth(`) hosts the bar', () => {
    const doc = 'const pad = synth({\n  osc: 1,\n})'
    const anchors = meterAnchors(doc, scanSynthDecls(doc))
    expect(anchors).toEqual([{ name: 'pad', pos: 'const pad = synth({'.length }])
  })

  it('a final line without trailing newline anchors at doc end', () => {
    const doc = 'const kick = synth({})'
    expect(meterAnchors(doc, scanSynthDecls(doc))).toEqual([{ name: 'kick', pos: doc.length }])
  })
})

describe('nextDisplay smoothing', () => {
  it('attack is instant: a louder rms replaces the display immediately', () => {
    expect(nextDisplay(0.1, 0.5, 16)).toBe(0.5)
    expect(nextDisplay(0, 0.3, 0)).toBe(0.3)
  })

  it('release follows exp(-dt/tau): one tau leaves 1/e of the level', () => {
    const d = nextDisplay(0.6, 0, METER_RELEASE_MS)
    expect(d).toBeCloseTo(0.6 / Math.E, 10)
  })

  it('dt 0 with silence keeps the display unchanged', () => {
    expect(nextDisplay(0.4, 0, 0)).toBe(0.4)
  })

  it('decay is monotonic and reaches (near) zero', () => {
    let d = 0.8
    for (let i = 0; i < 100; i++) {
      const next = nextDisplay(d, 0, 27)
      expect(next).toBeLessThanOrEqual(d)
      d = next
    }
    expect(d).toBeLessThan(0.001)
  })

  it('non-finite or negative rms is treated as silence', () => {
    expect(nextDisplay(0.5, Number.NaN, METER_RELEASE_MS)).toBeCloseTo(0.5 / Math.E, 10)
    expect(nextDisplay(0.5, -1, METER_RELEASE_MS)).toBeCloseTo(0.5 / Math.E, 10)
    expect(nextDisplay(0, Number.POSITIVE_INFINITY, 16)).toBe(0)
  })
})
