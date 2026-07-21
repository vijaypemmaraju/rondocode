import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { syntacticContext, rondocodeCompletionSource } from '../src/editor/complete'

/* ------------------------------------------------------------------------- *
 * Headless completion tests: build a real EditorState with the javascript
 * language (the same extension the editor mounts), place the cursor with a
 * '|' marker, and run the source against a constructed CompletionContext.
 * One suite per syntactic context class: after-dot-on-pattern, in-synth,
 * top-level, inside-string.
 * ------------------------------------------------------------------------- */

const ctxAt = (docWithCursor: string, explicit = false): CompletionContext => {
  const pos = docWithCursor.indexOf('|')
  if (pos === -1) throw new Error('marker | missing')
  const doc = docWithCursor.slice(0, pos) + docWithCursor.slice(pos + 1)
  const state = EditorState.create({ doc, extensions: [javascript()] })
  return new CompletionContext(state, pos, explicit)
}

const labels = (docWithCursor: string, explicit = false): string[] => {
  const result = rondocodeCompletionSource(ctxAt(docWithCursor, explicit))
  return result === null ? [] : result.options.map((o) => o.label)
}

describe('syntacticContext', () => {
  const classify = (docWithCursor: string): string => {
    const c = ctxAt(docWithCursor)
    return syntacticContext(c.state, c.pos)
  }

  it('classifies strings, synth bodies, and top level', () => {
    expect(classify("n('0 3|5')")).toBe('string')
    expect(classify('m`bd |sn`')).toBe('string')
    expect(classify('const a = synth(({ gate, adsr }) => adsr(|gate))')).toBe('synth')
    expect(classify("p('x', n('0').fast(|2))")).toBe('top')
    expect(classify('setCps(|0.5)')).toBe('top')
  })

  it('a string inside a synth body still reads as string', () => {
    expect(classify("synth(({ param }) => param('cut|off', 800))")).toBe('string')
  })
})

describe('after-dot on a pattern receiver', () => {
  it('offers pattern + control methods after a call chain', () => {
    const ls = labels("p('bass', n('0 0 3 5').|)")
    expect(ls).toContain('every')
    expect(ls).toContain('euclid')
    expect(ls).toContain('scale')
    expect(ls).toContain('gain')
    expect(ls).toContain('jux')
    // not the synth vocabulary, not globals
    expect(ls).not.toContain('adsr')
    expect(ls).not.toContain('tanh')
    expect(ls).not.toContain('synth')
  })

  it('offers pattern methods on known producers and short lambda params', () => {
    expect(labels('sine.|')).toContain('range')
    expect(labels('.every(4, x => x.|')).toContain('rev')
  })

  it('offers pattern methods with a typed prefix after the dot', () => {
    const result = rondocodeCompletionSource(ctxAt("n('0 3').eu|"))
    expect(result).not.toBeNull()
    expect(result!.options.map((o) => o.label)).toContain('euclid')
    // from points at the prefix start so CM filters by 'eu'
    expect(result!.from).toBe("n('0 3').".length)
  })

  it('stays quiet on implausible receivers (long unknown identifiers, numbers)', () => {
    expect(labels('Math.|')).toEqual([])
    expect(labels('const x = 0.|')).toEqual([])
  })
})

describe('inside a synth() callback', () => {
  it('offers ctx members bare', () => {
    const ls = labels('const a = synth((ctx) => { const e = ad| })')
    expect(ls).toContain('adsr')
    expect(ls).toContain('noise')
    expect(ls).toContain('ladder')
    // not the pattern vocabulary
    expect(ls).not.toContain('every')
    expect(ls).not.toContain('setCps')
  })

  it('offers Sig methods (and ctx members) after a dot', () => {
    const ls = labels('const a = synth(({ gate, adsr, saw, note }) => saw(note.freq).|)')
    expect(ls).toContain('tanh')
    expect(ls).toContain('pow')
    expect(ls).toContain('clip')
    expect(ls).not.toContain('every')
    expect(ls).not.toContain('degrade')
  })

  it('stays quiet after a numeric literal dot inside synth', () => {
    expect(labels('const a = synth(({ adsr, gate }) => adsr(gate, { a: 0.| }))')).toEqual([])
  })
})

describe('top level', () => {
  it('offers scope globals on a typed prefix', () => {
    const ls = labels('si|')
    expect(ls).toContain('sine')
    expect(ls).toContain('silence')
    expect(ls).toContain('synth')
    expect(ls).toContain('setCps')
    // methods never appear bare
    expect(ls).not.toContain('tanh')
    expect(ls).not.toContain('euclid')
  })

  it('offers nothing on an empty position unless explicitly invoked', () => {
    expect(labels('|')).toEqual([])
    expect(labels('|', true)).toContain('synth')
  })

  it('inserts plain names for values and snippets for functions', () => {
    const result = rondocodeCompletionSource(ctxAt('si|'))!
    const sine = result.options.find((o) => o.label === 'sine')!
    const synthOpt = result.options.find((o) => o.label === 'synth')!
    expect(sine.apply).toBeUndefined() // plain label insert
    expect(typeof synthOpt.apply).toBe('function') // snippet with cursor inside ()
  })
})

describe('inside string literals', () => {
  it('offers nothing inside plain mini-notation strings', () => {
    expect(labels("n('0 3 |')")).toEqual([]) // scale degrees — no vocab
    expect(labels('m`bd |`')).toEqual([]) // tagged template, not a call arg
    // even when explicitly invoked
    expect(labels("n('0 |')", true)).toEqual([])
  })

  it('completes chord names inside chord()', () => {
    const opts = labels("chord('C|')")
    expect(opts).toContain('Cmaj7')
    expect(opts).toContain('Am7')
    expect(opts).toContain('F#m')
  })

  it('completes note names inside note()', () => {
    const opts = labels("note('c|')")
    expect(opts).toContain('c4')
    expect(opts).toContain('g3')
  })

  it('completes scale names inside .scale()', () => {
    const opts = labels("n('0').scale('c ma|')")
    expect(opts).toContain('major')
    expect(opts).toContain('dorian')
  })

  it('completes sound names inside .sound()/s() — synths in the doc + demo samples', () => {
    const doc = "const bell = synth(x => x)\np('x', n('0').sound('b|'))"
    expect(labels(doc)).toContain('bell') // defined in the doc
    expect(labels(doc)).toContain('vox') // built-in demo sample
    expect(labels("s('|')", true)).toContain('riser')
  })
})
