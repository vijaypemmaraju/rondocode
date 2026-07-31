import { describe, expect, it } from 'vitest'
import { DSL_DOCS } from '../src/docs/dsl-docs'
import { OPTIONS } from '../src/editor/rondo'
import { BUILTINS, KEYWORDS, MODIFIERS } from '../src/editor/rondo/words'
import { filterGroups, referenceGroups } from '../src/editor/reference'

/* ------------------------------------------------------------------------- *
 * The "?" reference must answer in the language you are writing.
 *
 * It was generated straight from DSL_DOCS, so a rondo user read
 * `svf(inp, cutoff, opts?)` for a language whose actual spelling is
 * `svf cutoff res:…`. That is the same complaint that produced rondoHover,
 * one surface later — this is the last one.
 * ------------------------------------------------------------------------- */
const titles = (lang: 'rondo' | 'rondocode'): string[] =>
  referenceGroups(lang, OPTIONS, DSL_DOCS).map((g) => g.title)

const allEntries = (lang: 'rondo' | 'rondocode') =>
  referenceGroups(lang, OPTIONS, DSL_DOCS).flatMap((g) => g.entries)

describe('referenceGroups', () => {
  it('gives a rondo project rondo signatures, never JS call shapes', () => {
    const svf = allEntries('rondo').find((e) => e.signature.startsWith('svf'))
    expect(svf?.signature).toBe('svf cutoff res:… mode:…')
    expect(svf?.signature).not.toContain('(')
  })

  it('gives a JS project the JS signatures it always had', () => {
    const svf = allEntries('rondocode').find((e) => e.signature.startsWith('svf'))
    expect(svf?.signature).toContain('(')
  })

  it('groups rondo the way the tokenizer classifies it', () => {
    expect(titles('rondo')).toEqual(['blocks', 'pattern modifiers', 'synth builtins', 'mini-notation'])
  })

  it('has no "other" group, meaning every documented word is classified', () => {
    // an OPTIONS word in none of the three sets would land here. It is kept as
    // a visible bucket rather than a silent drop, and must stay empty.
    expect(titles('rondo')).not.toContain('other')
  })

  it('files each word in exactly one group', () => {
    const groups = referenceGroups('rondo', OPTIONS, DSL_DOCS).filter((g) => g.title !== 'mini-notation')
    const sigs = groups.flatMap((g) => g.entries.map((e) => e.signature))
    expect(new Set(sigs).size).toBe(sigs.length)
  })

  it('lists every rondo word — the reference cannot be a subset of the language', () => {
    const listed = new Set(allEntries('rondo').map((e) => e.signature))
    for (const o of OPTIONS) {
      expect(listed.has(String(o.detail ?? o.label)), `${String(o.label)} missing`).toBe(true)
    }
  })

  it('shares mini-notation, because the notation itself is shared', () => {
    const mini = (lang: 'rondo' | 'rondocode') =>
      referenceGroups(lang, OPTIONS, DSL_DOCS).find((g) => g.title === 'mini-notation')
    expect(mini('rondo')).toEqual(mini('rondocode'))
    expect(mini('rondo')!.entries.length).toBeGreaterThan(5)
  })

  it('carries examples through, which is most of what a reference is for', () => {
    const withEx = allEntries('rondo').filter((e) => e.example !== undefined)
    expect(withEx.length).toBeGreaterThan(30)
  })

  it('keeps the sets it groups by non-empty, so a rename cannot empty a group', () => {
    for (const [name, set] of [['KEYWORDS', KEYWORDS], ['MODIFIERS', MODIFIERS], ['BUILTINS', BUILTINS]] as const) {
      expect(set.size, name).toBeGreaterThan(5)
    }
  })
})

describe('filterGroups', () => {
  const groups = referenceGroups('rondo', OPTIONS, DSL_DOCS)

  it('returns everything for an empty query', () => {
    expect(filterGroups(groups, '   ')).toEqual(groups)
  })

  it('drops groups that match nothing rather than showing empty headings', () => {
    const r = filterGroups(groups, 'ladder')
    expect(r.every((g) => g.entries.length > 0)).toBe(true)
    expect(r.flatMap((g) => g.entries).some((e) => e.signature.startsWith('ladder'))).toBe(true)
  })

  it('matches on the example too, so a word you can see is findable', () => {
    // 'a-min' appears only inside examples, never in a signature or summary
    const hits = filterGroups(groups, 'a-min').flatMap((g) => g.entries)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(filterGroups(groups, 'LADDER')).toEqual(filterGroups(groups, 'ladder'))
  })
})
