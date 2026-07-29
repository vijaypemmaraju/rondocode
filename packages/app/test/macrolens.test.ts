import { describe, expect, it } from 'vitest'
import { evalMacroExpr, macroReadouts, scanMacroDecls, scanMacroUses } from '../src/editor/rondo/macrolens'
import { formatMacroValue, scanKnobs } from '../src/editor/rondo/widgets'

/* ------------------------------------------------------------------------- *
 * The macro readout: what the knob is doing, shown at each destination.
 *
 * The contract that matters is HONESTY. Every chip must be a value the engine
 * would actually compute, so anything outside plain arithmetic is dropped
 * rather than approximated: a wrong number next to a filter is worse than no
 * number at all.
 * ------------------------------------------------------------------------- */

const SRC = `macro bright 1480 500..7300 log

synth lead
  saw note
  svf bright res:.3
  * env
  env = adsr .003 .2 .3 .1

synth pad
  saw note
  svf bright * 0.5 res:.2
  post
    delay .25 fb sync:1
    fb = 0.6 - bright / 7300 * 0.55
`

describe('finding the declaration', () => {
  it('reads the name, default, range and curve, and the span a drag rewrites', () => {
    const [d] = scanMacroDecls(SRC)
    expect(d).toMatchObject({ name: 'bright', value: 1480, lo: 500, hi: 7300, log: true })
    expect(SRC.slice(d!.defFrom, d!.defTo)).toBe('1480')
  })

  it('a range-less declaration still yields usable knob bounds', () => {
    const [d] = scanMacroDecls('macro drive 2\n')
    expect(d).toMatchObject({ name: 'drive', value: 2, lo: 0, hi: 8, log: false })
  })

  it('ignores a macro inside a comment', () => {
    expect(scanMacroDecls('# macro bright 1480 500..7300 log\n')).toEqual([])
  })
})

describe('finding what the macro drives', () => {
  it('finds both the inline use and the binding, with the ratio intact', () => {
    const uses = scanMacroUses(SRC, scanMacroDecls(SRC))
    // `.25 fb` is listed because it DEPENDS on the macro (through fb), but it
    // is not arithmetic, so no chip is drawn for it — see macroReadouts
    expect(uses.map((u) => u.expr)).toEqual(['bright', 'bright * 0.5', '.25 fb', '0.6 - bright / 7300 * 0.55'])
    expect(uses.map((u) => u.label)).toEqual(['svf', 'svf', 'delay', 'fb'])
  })

  it('drops the named args, which are settings and not part of the value', () => {
    const uses = scanMacroUses('macro b 1 0..2\n\nsynth x\n  svf b * 3 res:.3\n', scanMacroDecls('macro b 1 0..2\n'))
    expect(uses[0]!.expr).toBe('b * 3')
  })

  it('leaves lines that touch no macro alone', () => {
    expect(scanMacroUses(SRC, scanMacroDecls(SRC)).some((u) => u.expr.includes('adsr'))).toBe(false)
  })
})

describe('the arithmetic', () => {
  const env = { bright: 4000, half: 2 }
  it('follows the same precedence the compiler emits', () => {
    expect(evalMacroExpr('0.6 - bright / 8000 * 0.5', env)).toBeCloseTo(0.35, 10)
    expect(evalMacroExpr('2 + 3 * 4', env)).toBe(14)
    expect(evalMacroExpr('2 ^ 3 ^ 2', env)).toBe(512) // right-associative
    expect(evalMacroExpr('(2 + 3) * 4', env)).toBe(20)
    expect(evalMacroExpr('-half + 5', env)).toBe(3)
  })

  it('refuses anything outside plain arithmetic, rather than guessing', () => {
    expect(evalMacroExpr('adsr .003 .2', env)).toBeUndefined()   // unknown name
    expect(evalMacroExpr('bright -> 200..2000', env)).toBeUndefined() // range map
    expect(evalMacroExpr('bright *', env)).toBeUndefined()       // incomplete
    expect(evalMacroExpr('bright / 0', env)).toBeUndefined()     // not finite
  })
})

describe('readouts: one knob, several destinations, live', () => {
  it('shows each destination’s OWN value, which is the point of the feature', () => {
    const decls = scanMacroDecls(SRC)
    const r = macroReadouts(SRC, decls)
    expect(r.map((x) => [x.label, Number(x.value.toFixed(4))])).toEqual([
      ['svf', 1480],        // 1:1
      ['svf', 740],         // half
      ['fb', Number((0.6 - 1480 / 7300 * 0.55).toFixed(4))],
    ])
  })

  it('a live value overrides the document, so a drag moves every chip at once', () => {
    const decls = scanMacroDecls(SRC)
    const r = macroReadouts(SRC, decls, { bright: 7300 })
    expect(r.map((x) => Number(x.value.toFixed(4)))).toEqual([7300, 3650, 0.05])
  })

  it('CASCADES: a binding built from a macro feeds the next expression', () => {
    const src = [
      'macro b 100 0..1000',
      '',
      'synth x',
      '  saw note',
      '  * top',
      '  mid = b * 2',
      '  top = mid + 5',
    ].join('\n')
    const r = macroReadouts(src, scanMacroDecls(src))
    expect(r.map((x) => [x.label, x.value])).toEqual([['*', 205], ['mid', 200], ['top', 205]])
  })

  it('scopes bindings to their synth, so one block cannot read another’s', () => {
    const src = [
      'macro b 10 0..100',
      '',
      'synth one',
      '  saw note',
      '  mid = b * 2',
      '',
      'synth two',
      '  saw note',
      '  * mid',
    ].join('\n')
    // `mid` is not in scope in synth two: no chip, rather than one showing 20
    expect(macroReadouts(src, scanMacroDecls(src)).map((x) => x.label)).toEqual(['mid'])
  })

  it('reports which macros a destination depends on, for highlighting', () => {
    const src = 'macro a 1 0..2\nmacro b 2 0..4\n\nsynth x\n  saw note\n  * c\n  c = a * b\n'
    const [chip] = macroReadouts(src, scanMacroDecls(src))
    expect(chip!.deps.sort()).toEqual(['a', 'b'])
  })

  it('anchors at the end of the code, not past a trailing comment', () => {
    const src = 'macro b 4 0..8\n\nsynth x\n  saw note\n  * b   # the macro\n'
    const [chip] = macroReadouts(src, scanMacroDecls(src))
    expect(src.slice(0, chip!.at).endsWith('* b')).toBe(true)
  })
})

describe('the macro line is a knob', () => {
  it('scans as a knob, flagged so the drag fans out instead of holding one synth', () => {
    const k = scanKnobs(SRC).find((x) => x.name === 'bright')!
    expect(k).toMatchObject({ value: 1480, lo: 500, hi: 7300, log: true, macro: true })
    expect(k.synth).toBeUndefined() // a macro has no owning synth — that is the point
    expect(SRC.slice(k.defFrom, k.defTo)).toBe('1480')
  })

  it('a synth-local knob is NOT flagged, so it keeps holding just its own param', () => {
    const src = 'synth lead\n  saw note\n  svf cut\n  cut = knob 800 80..8000 log\n'
    const k = scanKnobs(src).find((x) => x.name === 'cut')!
    expect(k.macro).toBeUndefined()
    expect(k.synth).toBe('lead')
  })
})

describe('the chip readout', () => {
  it('keeps a stable width as the value moves, so lines never reflow', () => {
    expect(formatMacroValue(7300)).toBe('7300')
    expect(formatMacroValue(74.25)).toBe('74.3')
    expect(formatMacroValue(1.5)).toBe('1.50')
    expect(formatMacroValue(0.48851)).toBe('0.489')
  })
})
