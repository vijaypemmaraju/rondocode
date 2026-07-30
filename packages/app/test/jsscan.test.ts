import { describe, expect, it } from 'vitest'
import { scanBeatsJs, scanEnvPointsJs, scanEnvsJs, scanKnobsJs, scanPlaysJs, scanRichPlaysJs, scanUnisonHeadersJs, scanWavedefsJs, scanWavetableCallsJs } from '../src/editor/widgets/jsscan'
import { scanEnvs, scanPlays, scanBeats, beatSplitTokens, rollPreviewMidi } from '../src/editor/rondo/widgets'
import { compile as compileRondo } from '@rondocode/rondo'
import { scanEnvPoints } from '../src/editor/rondo/envpoints'

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

/* ------------------------------------------------------------------------- *
 * The breakpoint editor, in JavaScript.
 *
 * Nothing about the WRITER had to change: it edits character ranges, and a
 * number inside a JS array literal is a range like any other. The editor was
 * rondo-only because nobody had read the spans out of the tree — so what is
 * tested is the spans, and that both languages describe the same shape.
 * ------------------------------------------------------------------------- */
describe('scanEnvPointsJs: env(gate, [[t, l], …]) becomes a shape', () => {
  const JS = [
    `const bell = synth(({ gate, env, saw, note }) => {`,
    `  const e = env(gate, [[0.005, 1], [0.15, 0.4, 3], [0.5, 0.6]], { release: 0.3, curve: 2 })`,
    `  return saw(note.freq).mul(e)`,
    `})`,
  ].join('\n')

  it('reads every breakpoint, with a span on each number', () => {
    const [s] = scanEnvPointsJs(JS)
    expect(s!.points.map((p) => [p.time, p.level])).toEqual([[0.005, 1], [0.15, 0.4], [0.5, 0.6]])
    expect(s!.points.map((p) => JS.slice(p.timeSpan.from, p.timeSpan.to))).toEqual(['0.005', '0.15', '0.5'])
    expect(s!.points.map((p) => JS.slice(p.levelSpan.from, p.levelSpan.to))).toEqual(['1', '0.4', '0.6'])
  })

  it('carries a per-point curve and the envelope-wide one', () => {
    const [s] = scanEnvPointsJs(JS)
    expect(s!.points.map((p) => p.curve)).toEqual([undefined, 3, undefined])
    expect(JS.slice(s!.points[1]!.curveSpan!.from, s!.points[1]!.curveSpan!.to)).toBe('3')
    expect(s!.curve).toBe(2)
  })

  it('describes the same shape rondo does', () => {
    const rd = '  e = env .005 1 .15 .4:3 .5 .6 curve:2\n'
    const [j] = scanEnvPointsJs(JS)
    const [r] = scanEnvPoints(rd)
    expect(j!.points.map((p) => [p.time, p.level, p.curve]))
      .toEqual(r!.points.map((p) => [p.time, p.level, p.curve]))
    expect(j!.curve).toBe(r!.curve)
  })

  it('knows its synth, for the note marker', () => {
    expect(scanEnvPointsJs(JS)[0]!.synth).toBe('bell')
  })

  it('DECLINES a computed breakpoint — the drawn shape would not be the played one', () => {
    expect(scanEnvPointsJs('env(gate, [[0.1, 1], [dur, 0.5]])')).toEqual([])
    expect(scanEnvPointsJs('env(gate, points)')).toEqual([])
    expect(scanEnvPointsJs('env(gate, [[0.1, 1, 2, 3]])')).toEqual([]) // four is not a breakpoint
  })

  it('takes a single-point envelope, which is legal', () => {
    expect(scanEnvPointsJs('env(gate, [[0.1, 1]])')[0]!.points).toHaveLength(1)
  })
})

describe('curve insertion, JavaScript side', () => {
  it('inserts `, 3` as a third array element', () => {
    const src = 'env(gate, [[0.1, 1], [0.3, 0.2]])'
    const [s] = scanEnvPointsJs(src)
    const ins = s!.points[0]!.curveInsert!
    expect(ins.prefix).toBe(', ')
    expect(src.slice(0, ins.at) + `${ins.prefix}3` + src.slice(ins.at))
      .toBe('env(gate, [[0.1, 1, 3], [0.3, 0.2]])')
  })

  it('rewrites an existing one instead — same as rondo', () => {
    const [s] = scanEnvPointsJs('env(gate, [[0.1, 1, 4]])')
    expect(s!.points[0]!.curveSpan).toBeDefined()
    expect(s!.points[0]!.curveInsert).toBeUndefined()
  })

  it('the two languages agree on WHICH point takes the curve', () => {
    // the drag is shared, so a disagreement here would bend a different
    // segment depending on the language
    const j = scanEnvPointsJs('env(gate, [[0.1, 1], [0.3, 0.2]])')[0]!
    const r = scanEnvPoints('  e = env .1 1 .3 .2\n')[0]!
    expect(j.points.map((p) => p.curveInsert !== undefined))
      .toEqual(r.points.map((p) => p.curveInsert !== undefined))
  })
})

/* ------------------------------------------------------------------------- *
 * The roll family, in JavaScript.
 *
 * rondo carries mini-notation unquoted; JS carries it inside a string literal.
 * That was the whole reason this stayed rondo-only — and it turns out to need
 * no writer change either, because handing the widget the string's INTERIOR
 * span means its existing writer cannot leave the quotes.
 * ------------------------------------------------------------------------- */
describe('scanPlaysJs: the editable step grid', () => {
  const JS = [
    `p('bass', n('0 3 5 7').scale('a minor').sound('acid'))`,
    `p('neg', n('-1 0 ~ 3').sound('acid'))`,
    `p('rich', n('<0 3> 5 [7,9]').sound('acid'))`,
    `p('names', note('c4 e4').sound('acid'))`,
  ].join('\n')

  it('spans the string INTERIOR, so a rewrite stays inside the quotes', () => {
    const [r] = scanPlaysJs(JS)
    expect(JS.slice(r!.from, r!.to)).toBe('0 3 5 7')
    expect(JS[r!.from - 1]).toBe("'")
    expect(JS[r!.to]).toBe("'")
  })

  it('reads the steps, the synth and the scale off the chain', () => {
    const [r] = scanPlaysJs(JS)
    expect(r!.steps).toEqual([0, 3, 5, 7])
    expect(r!.synth).toBe('acid')
    expect(r!.scale).toBe('a-minor')
  })

  it('previews the same NOTE rondo does, despite spelling the scale differently', () => {
    // rondo says `a-min`, JS says `a minor`; expandScale reads a dashless
    // string as "root + major", so the dash is load-bearing
    const js = scanPlaysJs(JS)[0]!
    const rd = scanPlays('play bass\n  0 3 5 7  scale:a-min\n')[0]!
    expect(rollPreviewMidi(js.scale, 3)).toBe(rollPreviewMidi(rd.scale, 3))
  })

  it('takes negatives and rests, exactly as rondo does', () => {
    expect(scanPlaysJs(JS)[1]!.steps).toEqual([-1, 0, null, 3])
  })

  it('leaves richer notation to the read-only overview', () => {
    expect(scanPlaysJs(JS).map((r) => r.content)).not.toContain('<0 3> 5 [7,9]')
    expect(scanRichPlaysJs(JS).map((r) => r.content)).toEqual(['<0 3> 5 [7,9]'])
  })

  it('ignores note NAMES — n() is degrees, note() is another family', () => {
    expect(scanPlaysJs(JS).some((r) => r.content.includes('c4'))).toBe(false)
  })

  it('declines a string with an escape, whose interior offsets would lie', () => {
    expect(scanPlaysJs(`p('x', n('0 \\\\u0033'))`)).toEqual([])
  })

  it('agrees with the rondo scan on the same music', () => {
    const js = scanPlaysJs(`p('bass', n('0 3 5 7').scale('a minor').sound('acid'))`)[0]!
    const rd = scanPlays('play bass synth:acid\n  0 3 5 7  scale:a-min\n')[0]!
    expect(js.steps).toEqual(rd.steps)
    expect(js.content).toBe(rd.content)
    expect(js.synth).toBe(rd.synth)
  })
})

/* ------------------------------------------------------------------------- *
 * beat blocks, in JavaScript.
 *
 * What a rondo `beat` block COMPILES TO answers what the JS equivalent is —
 * `p(name, stack(s(…), s(…)))` — so this is not a guess about mapping, it is
 * the same program written the other way round. The strongest test available
 * is therefore: scan the compiled output and get the rows the rondo scan gets
 * from the source.
 * ------------------------------------------------------------------------- */
describe('scanBeatsJs', () => {
  const RD = 'synth kick\n  sine 60\n\nbeat\n  kick ~ kick ~\n  ~ ~ snare ~\n  ~ hat:.6 ~ hat\n'

  it('gets the SAME rows from the compiled JS as rondo gets from the source', () => {
    const c = compileRondo(RD)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const js = scanBeatsJs(c.code)[0]!.rows
    const rd = scanBeats(RD)[0]!.rows
    expect(js.map((r) => [r.word, r.steps])).toEqual(rd.map((r) => [r.word, r.steps]))
  })

  it('reports where the velocities live, since JS keeps them in their own pattern', () => {
    const src = `p('d', stack(s('~ hat ~ hat').gain('~ 0.6 ~ 1')))`
    const [row] = scanBeatsJs(src)[0]!.rows
    expect(src.slice(row!.gainSpan!.from, row!.gainSpan!.to)).toBe('~ 0.6 ~ 1')
    expect(row!.steps).toEqual([null, 0.6, null, 1])
  })

  it('a row with no gain pattern is all full-velocity, and has no gain span', () => {
    const [row] = scanBeatsJs(`p('d', s('kick ~ kick ~'))`)[0]!.rows
    expect(row!.steps).toEqual([1, null, 1, null])
    expect(row!.gainSpan).toBeUndefined()
  })

  it('DECLINES a gain pattern that does not line up step for step', () => {
    // writing into it would silently retime the row it belongs to
    const [row] = scanBeatsJs(`p('d', s('kick ~ kick ~').gain('1 0.5'))`)[0]!.rows
    expect(row!.gainSpan).toBeUndefined()
    expect(row!.steps).toEqual([1, null, 1, null])
  })

  it('needs a single instrument per row, like rondo', () => {
    expect(scanBeatsJs(`p('d', s('kick snare kick ~'))`)).toEqual([])
    expect(scanBeatsJs(`p('d', s('kick'))`)).toEqual([]) // one step is not a sequencer
  })

  it('beatSplitTokens is the inverse — what a write puts back', () => {
    expect(beatSplitTokens([1, null, 0.6, 1], 'hat')).toEqual(['hat ~ hat hat', '1 ~ 0.6 1'])
  })
})
