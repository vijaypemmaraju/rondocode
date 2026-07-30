import { describe, expect, it } from 'vitest'
import { localBindings, macroNames, optionsFor, rondoPositionAt } from '../src/editor/rondo/complete'
import { KEYWORDS, MODIFIERS, OPTIONS } from '../src/editor/rondo'
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

/* ------------------------------------------------------------------------- *
 * Hover must answer in RONDO.
 *
 * Builtins used to fall through to the JS DSL's hover, which documents the
 * underlying CALL — `svf(inp, cutoff, opts?)` — for a language whose actual
 * spelling is `svf cutoff res:…`. Accurate about JavaScript, and about
 * nothing you can type in a .rondo file.
 * ------------------------------------------------------------------------- */
describe('rondo hover speaks rondo', () => {
  const byLabel = new Map(OPTIONS.map((o) => [String(o.label), o]))

  it('covers BUILTINS, not just block keywords', () => {
    for (const name of ['svf', 'ladder', 'reverb', 'delay', 'wavetable', 'adsr']) {
      expect(byLabel.has(name), name).toBe(true)
    }
  })

  it('every signature is rondo-shaped: no parens, no JS punctuation', () => {
    for (const o of OPTIONS) {
      const sig = String(o.detail ?? '')
      expect(sig, `${String(o.label)}: ${sig}`).not.toMatch(/\(|\)|=>|;/)
      // and it leads with the word itself, the way you would type it
      expect(sig.startsWith(String(o.label)), `${String(o.label)}: ${sig}`).toBe(true)
    }
  })

  it('the math ops are documented — they had no entry at all before', () => {
    for (const name of ['abs', 'floor', 'max', 'min', 'mod', 'sqrt', 'fold', 'syncsaw', 'lfsr']) {
      expect(byLabel.has(name), name).toBe(true)
    }
    expect(String(byLabel.get('max')!.detail)).toBe('max x')
    // the floored-mod surprise is the thing worth saying out loud
    expect(String(byLabel.get('mod')!.info)).toMatch(/FLOORED/)
  })

  it('so they are offered in a synth body too', () => {
    const got = labels({ kind: 'synth', block: 'synth' }, 'synth s\n  saw note\n', 0)
    expect(got).toEqual(expect.arrayContaining(['max', 'floor', 'abs']))
  })
})

/* ------------------------------------------------------------------------- *
 * Highlighting and documentation must agree.
 *
 * `slide:` was documented, completed, and hovering — and rendered as a plain
 * identifier, because the stream language's MODIFIERS set never learned it.
 * Sitting next to a coloured `gain:` that reads as "this one isn't real",
 * which is how it was reported. Eleven words were in that state.
 * ------------------------------------------------------------------------- */
describe('every documented word is highlighted', () => {
  it('has no OPTIONS keyword the tokenizer treats as a bare identifier', () => {
    const documented = OPTIONS.filter((o) => o.type === 'keyword').map((o) => String(o.label))
    const known = new Set([...KEYWORDS, ...MODIFIERS])
    // `scale:a-min` and friends are written with the colon in the label
    const missing = documented.filter((w) => !known.has(w.replace(/:$/, '')))
    expect(missing).toEqual([])
  })

  it('has no highlighted modifier that is undocumented — the other direction', () => {
    // a word that colours but has no hover or completion is just as confusing
    const documented = new Set(OPTIONS.map((o) => String(o.label).replace(/:$/, '')))
    const undocumented = [...MODIFIERS].filter((w) => !documented.has(w))
    expect(undocumented).toEqual([])
  })
})
