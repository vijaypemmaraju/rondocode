import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { hoverDocsAt, miniEntryForChar, selectEntries } from '../src/editor/hover'
import { docsByName } from '../src/docs/dsl-docs'

/* Pure lookup + classification tests for hover docs. The '|' marker places
 * the hover position (character offset the pointer is over). */

const at = (docWithCursor: string) => {
  const pos = docWithCursor.indexOf('|')
  if (pos === -1) throw new Error('marker | missing')
  const doc = docWithCursor.slice(0, pos) + docWithCursor.slice(pos + 1)
  return { state: EditorState.create({ doc, extensions: [javascript()] }), pos }
}

const namesAt = (docWithCursor: string): string[] => {
  const { state, pos } = at(docWithCursor)
  return (hoverDocsAt(state, pos)?.entries ?? []).map((e) => e.name)
}

describe('miniEntryForChar', () => {
  it('maps every operator char to its mini-syntax entry', () => {
    expect(miniEntryForChar('~')?.name).toBe('mini:~')
    expect(miniEntryForChar('[')?.name).toBe('mini:[]')
    expect(miniEntryForChar(']')?.name).toBe('mini:[]')
    expect(miniEntryForChar('<')?.name).toBe('mini:<>')
    expect(miniEntryForChar('}')?.name).toBe('mini:{}')
    expect(miniEntryForChar('%')?.name).toBe('mini:{}')
    expect(miniEntryForChar('*')?.name).toBe('mini:*')
    expect(miniEntryForChar('/')?.name).toBe('mini:/')
    expect(miniEntryForChar('!')?.name).toBe('mini:!')
    expect(miniEntryForChar('@')?.name).toBe('mini:@')
    expect(miniEntryForChar('(')?.name).toBe('mini:(p,s,r)')
    expect(miniEntryForChar('?')?.name).toBe('mini:?')
    expect(miniEntryForChar('|')?.name).toBe('mini:|')
    expect(miniEntryForChar('_')?.name).toBe('mini:_')
  })

  it('returns undefined for ordinary characters', () => {
    expect(miniEntryForChar('a')).toBeUndefined()
    expect(miniEntryForChar('0')).toBeUndefined()
    expect(miniEntryForChar(' ')).toBeUndefined()
  })
})

describe('hoverDocsAt: identifiers', () => {
  it('finds a pattern method under the cursor', () => {
    const docs = namesAt("n('0 3').eucl|id(3, 8)")
    expect(docs).toEqual(['euclid'])
  })

  it('finds globals and reports the exact token range', () => {
    const { state, pos } = at('setC|ps(0.5)')
    const r = hoverDocsAt(state, pos)!
    expect(r.entries[0]!.name).toBe('setCps')
    expect(state.sliceDoc(r.from, r.to)).toBe('setCps')
  })

  it('is silent on unknown identifiers and numbers', () => {
    expect(namesAt('someRando|mVar')).toEqual([])
    expect(namesAt('12|34')).toEqual([])
  })
})

describe('hoverDocsAt: context-sensitive kind selection', () => {
  it("'sine' is the signal global at top level, the oscillator inside synth", () => {
    const { state, pos } = at('si|ne.range(0, 1)')
    expect(hoverDocsAt(state, pos)!.entries.map((e) => e.kind)).toEqual(['global'])
    const s = at('const a = synth(({ note, sine }) => si|ne(note.freq))')
    expect(hoverDocsAt(s.state, s.pos)!.entries.map((e) => e.kind)).toEqual(['synth-ctx'])
  })

  it("'mul' resolves to the Sig method inside synth, the pattern method outside", () => {
    const top = at("n('0').mu|l(2)")
    expect(hoverDocsAt(top.state, top.pos)!.entries.map((e) => e.kind)).toEqual(['pattern-method'])
    const s = at('const a = synth(({ gate, adsr }) => adsr(gate).mu|l(2))')
    expect(hoverDocsAt(s.state, s.pos)!.entries.map((e) => e.kind)).toEqual(['sig-method'])
  })
})

describe('hoverDocsAt: mini operators inside strings', () => {
  it('documents operator characters inside string literals', () => {
    expect(namesAt("note('|~ c4 ~ c4')")).toEqual(['mini:~'])
    expect(namesAt("n('<0 4 |~ 2>')")).toEqual(['mini:~'])
    expect(namesAt("n('|<0 4 2>')")).toEqual(['mini:<>'])
    expect(namesAt("note('c5|*8')")).toEqual(['mini:*'])
    expect(namesAt("sound('bd|(3,8)')")).toEqual(['mini:(p,s,r)'])
    expect(namesAt("note('c5*8 |? 0.3')")).toEqual(['mini:?'])
    expect(namesAt("n('0 3 || 5 7')")).toEqual(['mini:|'])
  })

  it('is silent over plain letters and digits inside strings', () => {
    expect(namesAt("n('0 |3 5')")).toEqual([])
    expect(namesAt("sound('b|d sn')")).toEqual([])
  })
})

describe('selectEntries', () => {
  it('prefers context-appropriate kinds but never returns nothing for documented names', () => {
    const mul = docsByName.get('mul')!
    expect(selectEntries(mul, 'top').map((e) => e.kind)).toEqual(['pattern-method'])
    expect(selectEntries(mul, 'synth').map((e) => e.kind)).toEqual(['sig-method'])
    const onlyCtx = docsByName.get('adsr')!
    expect(selectEntries(onlyCtx, 'top')).toEqual(onlyCtx) // fallback: all
  })
})
