import { describe, expect, it } from 'vitest'
import { localBindings, macroNames, optionsFor, rondoPositionAt } from '../src/editor/rondo/complete'
import { OPTIONS } from '../src/editor/rondo'
import type { Completion } from '@codemirror/autocomplete'

/* ------------------------------------------------------------------------- *
 * Completion is only useful if it is RIGHT for where you are.
 *
 * The old source filtered one flat list by prefix, so typing `s` inside a
 * filter call offered `saw`, `scale:`, `struct`, `slow` and `sample` — four of
 * which are syntax errors there. What is asserted below is therefore not
 * "something is offered" but "the wrong things are NOT", which is the half
 * that decides whether the list is worth reading.
 * ------------------------------------------------------------------------- */

const DOC = [
  'macro bright 1480 500..7300 log',
  '',
  'synth lead',
  '  saw note',
  '  svf 900 ',
  '  * env',
  '  env = adsr .003 .2 .3 .1',
  '  cut = knob 800 80..8000 log',
  '',
  'play arp',
  '  0 3 5',
  '  ',
].join('\n')

const endOf = (needle: string): number => DOC.indexOf(needle) + needle.length
const labels = (where: ReturnType<typeof rondoPositionAt>, doc = DOC, pos = 0): string[] =>
  optionsFor(where, OPTIONS as readonly Completion[], {
    locals: localBindings(doc, pos),
    macros: macroNames(doc),
  }).map((o) => String(o.label))

describe('where the cursor is', () => {
  it('column 0 is the top level', () => {
    expect(rondoPositionAt(DOC, DOC.indexOf('\n\n') + 1)).toEqual({ kind: 'top' })
  })

  it('after a builtin and its positional, you are in its ARGUMENTS', () => {
    expect(rondoPositionAt(DOC, endOf('  svf 900 '))).toEqual({ kind: 'args', builtin: 'svf', block: 'synth' })
  })

  it('the value slot of a named arg knows both the call and the arg', () => {
    const d = 'synth lead\n  svf 900 mode:'
    expect(rondoPositionAt(d, d.length)).toEqual({ kind: 'named', builtin: 'svf', arg: 'mode' })
  })

  it('a play block body is a pattern, not a signal chain', () => {
    expect(rondoPositionAt(DOC, endOf('  0 3 5\n  '))).toEqual({ kind: 'play' })
  })

  it('a bare indented line in a synth is signal position', () => {
    expect(rondoPositionAt(DOC, endOf('  saw note\n  '))).toEqual({ kind: 'synth', block: 'synth' })
  })
})

describe('what is offered there', () => {
  it('inside a call: THAT call’s named args, and no oscillators', () => {
    const got = labels({ kind: 'args', builtin: 'svf', block: 'synth' }, DOC, endOf('  svf 900 '))
    expect(got).toContain('res:')
    expect(got).toContain('mode:')
    // the complaint, precisely: a filter's argument list is not the whole language
    expect(got).not.toContain('saw')
    expect(got).not.toContain('scale:')
    expect(got).not.toContain('synth')
  })

  it('inside a call: this block’s bindings and the project’s macros, which ARE legal', () => {
    const got = labels({ kind: 'args', builtin: 'svf', block: 'synth' }, DOC, endOf('  svf 900 '))
    expect(got).toContain('env')    // a binding two lines below
    expect(got).toContain('cut')
    expect(got).toContain('bright') // the macro
  })

  it('after `mode:`: only the values that filter accepts', () => {
    const got = labels({ kind: 'named', builtin: 'svf', arg: 'mode' })
    expect(got).toContain('lp')
    expect(got).toContain('hp')
    expect(got).not.toContain('res:')
    expect(got).not.toContain('saw')
  })

  it('after a named arg with no static values, nothing rather than a guess', () => {
    // sample names are runtime data; inventing a list would be fiction
    expect(labels({ kind: 'named', builtin: 'svf', arg: 'nosuch' })).toEqual([])
  })

  it('at the top level: block headers, and not the pipeline vocabulary', () => {
    const got = labels({ kind: 'top' })
    expect(got).toEqual(expect.arrayContaining(['synth', 'play', 'macro', 'bpm', 'bus']))
    expect(got).not.toContain('saw')
    expect(got).not.toContain('res:')
  })

  it('in a play body: modifiers, and not oscillators', () => {
    const got = labels({ kind: 'play' })
    expect(got).toEqual(expect.arrayContaining(['scale', 'gain', 'dur', 'every', 'rev']))
    expect(got).toContain('overchord:')
    expect(got).not.toContain('saw')
    expect(got).not.toContain('ladder')
  })

  it('in a synth body: builtins plus what this document defines', () => {
    const got = labels({ kind: 'synth', block: 'synth' }, DOC, endOf('  saw note\n  '))
    expect(got).toEqual(expect.arrayContaining(['saw', 'ladder', 'knob', 'post']))
    expect(got).toContain('env')
    expect(got).toContain('bright')
  })
})

describe('what the document knows', () => {
  it('collects the bindings of the ENCLOSING block only', () => {
    const doc = [
      'synth one', '  saw note', '  a = 1', '',
      'synth two', '  saw note', '  b = 2',
    ].join('\n')
    expect(localBindings(doc, doc.indexOf('  a = 1'))).toEqual(['a'])
    expect(localBindings(doc, doc.indexOf('  b = 2'))).toEqual(['b'])
  })

  it('finds macros wherever they are declared, and ignores commented ones', () => {
    expect(macroNames('macro a 1 0..2\n# macro b 1 0..2\nmacro c 2 0..4\n')).toEqual(['a', 'c'])
  })
})
