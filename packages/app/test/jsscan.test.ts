import { describe, expect, it } from 'vitest'
import { scanEnvsJs, scanKnobsJs, scanUnisonHeadersJs, scanWavedefsJs, scanWavetableCallsJs } from '../src/editor/widgets/jsscan'
import { scanEnvs } from '../src/editor/rondo/widgets'

/* The JavaScript half of the widget scanners. They must produce EXACTLY the
 * descriptors the rondo scanners produce, because the widgets downstream are
 * the same objects — the offsets they hand back are what a drag rewrites, so
 * an off-by-one here corrupts source rather than merely drawing wrong. */

const at = (src: string, from: number, to: number): string => src.slice(from, to)

describe('scanKnobsJs: param() becomes a knob', () => {
  it('reads the default, range and curve, and points at the DEF literal', () => {
    const src = "const cut = param('cutoff', 1200, { min: 100, max: 6000, curve: 'log' })"
    const [k] = scanKnobsJs(src)
    expect(k).toBeDefined()
    expect(at(src, k!.defFrom, k!.defTo)).toBe('1200') // what a drag rewrites
    expect(k!.value).toBe(1200)
    expect(k!.lo).toBe(100)
    expect(k!.hi).toBe(6000)
    expect(k!.log).toBe(true)
    expect(k!.name).toBe('cutoff')
  })

  it('defaults to 0..1 linear when the options are omitted, like param() does', () => {
    const [k] = scanKnobsJs("const amp = param('amp', 0.5)")
    expect(k!.lo).toBe(0)
    expect(k!.hi).toBe(1)
    expect(k!.log).toBe(false)
  })

  it('accepts reordered and partial options objects', () => {
    const [k] = scanKnobsJs("param('x', 3, { curve: 'log', max: 10, min: 1 })")
    expect([k!.lo, k!.hi, k!.log]).toEqual([1, 10, true])
  })

  it('routes to the enclosing synth so a drag reaches the right voice', () => {
    const src = [
      "const lead = synth(({ param, saw, note }) => {",
      "  const cut = param('cutoff', 1200, { min: 100, max: 6000 })",
      '  return saw(note.freq)',
      '})',
    ].join('\n')
    expect(scanKnobsJs(src)[0]!.synth).toBe('lead')
  })

  it('finds a call split across lines (a tree, not a line regex)', () => {
    const src = "const c = param(\n  'cutoff',\n  800,\n  { min: 20, max: 9000 },\n)"
    const [k] = scanKnobsJs(src)
    expect(k!.value).toBe(800)
    expect(at(src, k!.defFrom, k!.defTo)).toBe('800')
  })

  it('skips a non-literal default: there is nothing to write back to', () => {
    expect(scanKnobsJs("param('cut', baseFreq, { min: 1, max: 2 })")).toEqual([])
    expect(scanKnobsJs("param('cut', 100 * 2, { min: 1, max: 2 })")).toEqual([])
  })

  it('skips a degenerate range rather than drawing a dial that cannot turn', () => {
    expect(scanKnobsJs("param('x', 5, { min: 10, max: 10 })")).toEqual([])
    expect(scanKnobsJs("param('x', 5, { min: 10, max: 1 })")).toEqual([])
  })

  it('ignores a method named param, which is a different thing entirely', () => {
    expect(scanKnobsJs("obj.param('cut', 1200, { min: 1, max: 2 })")).toEqual([])
  })

  it('finds every knob in a multi-synth doc', () => {
    const src = [
      "const a = synth(({ param }) => param('one', 1, { min: 0, max: 2 }))",
      "const b = synth(({ param }) => param('two', 2, { min: 0, max: 4 }))",
    ].join('\n')
    expect(scanKnobsJs(src).map((k) => [k.name, k.synth])).toEqual([['one', 'a'], ['two', 'b']])
  })
})

describe('scanUnisonHeadersJs: the voice fan', () => {
  it('reads unison options off the synth call', () => {
    const [u] = scanUnisonHeadersJs('const lead = synth(fn, { unison: 5, detune: 14 })')
    expect(u!.unison).toBe(5)
    expect(u!.detune).toBe(14)
    expect(u!.synth).toBe('lead')
  })

  it('fills the engine defaults for what is unspecified', () => {
    const [u] = scanUnisonHeadersJs('const l = synth(fn, { unison: 3 })')
    expect([u!.detune, u!.curve, u!.blend, u!.octaves]).toEqual([15, 1, 1, 0])
  })

  it('ignores a synth with no unison, or unison 1 (there is no fan)', () => {
    expect(scanUnisonHeadersJs('const l = synth(fn, { mono: true })')).toEqual([])
    expect(scanUnisonHeadersJs('const l = synth(fn, { unison: 1 })')).toEqual([])
  })

  it('handles the three-argument form (voice, post, opts)', () => {
    const [u] = scanUnisonHeadersJs('const l = synth(voice, post, { unison: 7 })')
    expect(u!.unison).toBe(7)
  })
})

describe('scanWavetableCallsJs: the ribbon', () => {
  it('reads the table name and a literal pos', () => {
    const [c] = scanWavetableCallsJs("wavetable(note.freq, 0.3, { table: 'vox' })")
    expect(c!.table).toBe('vox')
    expect(c!.posLiteral).toBe(0.3)
  })

  it('leaves pos undefined when it is a signal, rather than inventing one', () => {
    const [c] = scanWavetableCallsJs("wavetable(note.freq, scan, { table: 'vox' })")
    expect(c!.posLiteral).toBeUndefined()
  })

  it("defaults the table to 'basic', matching the engine", () => {
    expect(scanWavetableCallsJs('wavetable(note.freq)')[0]!.table).toBe('basic')
  })

  it('carries a known warp mode and its amount', () => {
    const [c] = scanWavetableCallsJs("wavetable(f, 0.2, { table: 't', warp: 'sync', warpAmt: 0.7 })")
    expect(c!.warp).toBe('sync')
    expect(c!.warpAmt).toBe(0.7)
  })

  it('defaults warpAmt to the kernel default when warp is set without one', () => {
    expect(scanWavetableCallsJs("wavetable(f, 0.2, { table: 't', warp: 'bend' })")[0]!.warpAmt).toBe(0.5)
  })

  it('drops an unknown warp word instead of passing it through', () => {
    expect(scanWavetableCallsJs("wavetable(f, 0, { table: 't', warp: 'nope' })")[0]!.warp).toBeUndefined()
  })
})

describe('scanWavedefsJs: the bar editor', () => {
  it('reads frames and the exact range of every number', () => {
    const src = "defineWavetable('vox', [[1, 0.5], [0.2, 1]])"
    const [w] = scanWavedefsJs(src)
    expect(w!.name).toBe('vox')
    expect(w!.frames).toEqual([[1, 0.5], [0.2, 1]])
    // the ranges are what a bar drag rewrites — they must slice back exactly
    expect(w!.ranges.map((f) => f.map((r) => at(src, r.from, r.to)))).toEqual([
      ['1', '0.5'],
      ['0.2', '1'],
    ])
  })

  it('skips a table with a computed value: a drag would destroy the expression', () => {
    expect(scanWavedefsJs("defineWavetable('v', [[1, amp], [0.2, 1]])")).toEqual([])
    expect(scanWavedefsJs("defineWavetable('v', [[1, 2 * 0.5]])")).toEqual([])
  })

  it('skips a non-array table and an empty frame', () => {
    expect(scanWavedefsJs("defineWavetable('v', table)")).toEqual([])
    expect(scanWavedefsJs("defineWavetable('v', [[]])")).toEqual([])
  })

  it('handles negative partials', () => {
    const [w] = scanWavedefsJs("defineWavetable('v', [[1, -0.5]])")
    expect(w!.frames).toEqual([[1, -0.5]])
  })
})

describe('scanning never throws on broken source', () => {
  // the editor scans on every keystroke, so half-typed code is the normal case
  const BROKEN = ["const a = param('x',", 'synth(({ ', 'defineWavetable(', 'wavetable(f, ', '((((']
  it.each(BROKEN)('survives %j', (src) => {
    expect(() => {
      scanKnobsJs(src)
      scanUnisonHeadersJs(src)
      scanWavetableCallsJs(src)
      scanWavedefsJs(src)
    }).not.toThrow()
  })
})

/* ------------------------------------------------------------------------- *
 * The envelope, in JavaScript.
 *
 * It came across once the widget stopped rebuilding rondo's space-joined
 * `adsr A D S R` region and started writing the four VALUES in place — the
 * only thing the two spellings share. So the contract tested here is that both
 * scanners describe the same curve, and that the spans point at the numbers.
 * ------------------------------------------------------------------------- */
describe('scanEnvsJs: adsr(gate, { a, d, s, r }) becomes a curve', () => {
  const JS = [
    `const acid = synth(({ note, gate, adsr, saw }) => {`,
    `  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })`,
    `  return saw(note.freq).mul(env)`,
    `})`,
  ].join('\n')

  it('reads the four stages and points at each literal', () => {
    const [e] = scanEnvsJs(JS)
    expect([e!.a, e!.d, e!.s, e!.r]).toEqual([0.003, 0.2, 0.3, 0.1])
    expect(e!.ranges!.map((r) => JS.slice(r.from, r.to))).toEqual(['0.003', '0.2', '0.3', '0.1'])
  })

  it('describes the same curve rondo does, from the same synth', () => {
    const rd = 'synth acid\n  saw note\n  * env\n  env = adsr .003 .2 .3 .1\n'
    const [j] = scanEnvsJs(JS)
    const [r] = scanEnvs(rd)
    expect([j!.a, j!.d, j!.s, j!.r]).toEqual([r!.a, r!.d, r!.s, r!.r])
    expect(j!.synth).toBe(r!.synth)
    // and each points at its OWN spelling, which a drag preserves
    expect(rd.slice(r!.ranges![0]!.from, r!.ranges![0]!.to)).toBe('.003')
  })

  it('orders the spans a/d/s/r however the object was written', () => {
    const src = `adsr(gate, { r: 0.1, a: 0.003, s: 0.3, d: 0.2 })`
    const [e] = scanEnvsJs(src)
    expect([e!.a, e!.d, e!.s, e!.r]).toEqual([0.003, 0.2, 0.3, 0.1])
    expect(e!.ranges!.map((x) => src.slice(x.from, x.to))).toEqual(['0.003', '0.2', '0.3', '0.1'])
  })

  it('gives repeated values DISTINCT spans, so a drag cannot rewrite the wrong one', () => {
    const src = `adsr(gate, { a: 0.1, d: 0.1, s: 0.1, r: 0.1 })`
    const spans = scanEnvsJs(src)[0]!.ranges!
    expect(new Set(spans.map((r) => r.from)).size).toBe(4)
  })

  it('yields nothing when a stage is not a literal — there is nothing to drag', () => {
    // `adsr(gate, { r: relKnob })` is a real thing to write; it just cannot
    // also be a handle, and three live corners plus one dead one is worse
    // than none
    expect(scanEnvsJs(`adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: relKnob })`)).toEqual([])
    expect(scanEnvsJs(`adsr(gate, { a: 0.003, d: 0.2, s: 0.3 })`)).toEqual([])
  })

  it('rondo carries the spans too, so ONE writer serves both languages', () => {
    const rd = 'synth x\n  * env\n  env = adsr .1 .1 .1 .1\n'
    const spans = scanEnvs(rd)[0]!.ranges!
    expect(spans).toHaveLength(4)
    expect(new Set(spans.map((r) => r.from)).size).toBe(4) // no aliasing on equal values
  })
})
