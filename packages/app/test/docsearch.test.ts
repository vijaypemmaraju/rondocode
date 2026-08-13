import { describe, expect, it } from 'vitest'
import { highlight, matchesAll, rank, score, snippet, terms } from '../src/docs/search'
import { filterGroups, referenceGroups } from '../src/editor/reference'
import { crossRouteHits, sectionsFor } from '../src/docs/routes'
import { blockProse, blockText } from '../src/docs/content'
import { DSL_DOCS } from '../src/docs/dsl-docs'

/* ------------------------------------------------------------------------- *
 * The measured complaint, as tests.
 *
 * Docs search matched the RAW query as one substring, so on the shipped docs
 * `reverb` found 5 reference entries and `mix` found 17 while `reverb mix`
 * found ZERO, and the guide reported "no matches on this page" for
 * `wavetable warp` with both words on it. Meanwhile `gate` matched 32 of 44
 * sections in document order, which is a shorter page rather than an answer.
 *
 * So the two things worth pinning are: every term must match (AND), and the
 * results must come back in an order a reader would defend.
 * ------------------------------------------------------------------------- */

describe('terms', () => {
  it('splits on whitespace and lowercases', () => {
    expect(terms('Reverb  MIX ')).toEqual(['reverb', 'mix'])
  })

  it('is empty for an empty query', () => {
    expect(terms('   ')).toEqual([])
  })

  it('KEEPS punctuation, which is half of what this language is called by', () => {
    /* `0'gain:.8`, `*n` and `(3,8)` are things a reader searches for. Stripping
     * symbols would make the mini-notation reference unsearchable by its own
     * names. */
    expect(terms("0'gain:.8")).toEqual(["0'gain:.8"])
    expect(terms('(3,8) euclid')).toEqual(['(3,8)', 'euclid'])
  })
})

describe('matchesAll', () => {
  it('requires EVERY term, not the query as one string', () => {
    // the whole bug: these words are both there, in the other order
    const text = 'set the mix on a reverb to taste'
    expect(matchesAll(text, terms('reverb mix'))).toBe(true)
    expect(text.includes('reverb mix'), 'the old behaviour').toBe(false)
  })

  it('is false when any term is missing', () => {
    expect(matchesAll('reverb and delay', terms('reverb chorus'))).toBe(false)
  })

  it('an empty query matches everything', () => {
    expect(matchesAll('anything', [])).toBe(true)
  })
})

describe('score', () => {
  it('refuses a non-match', () => {
    expect(score('reverb', 'a room', terms('chorus'))).toBe(-1)
  })

  it('a TITLE hit outranks any number of body hits', () => {
    /* Searching `samples` should surface "Samples & granular" above every
     * section that merely mentions the word — which is exactly what document
     * order failed to do. */
    const titled = score('samples & granular', 'plays a loaded buffer', terms('samples'))
    const mentioned = score('mastering', 'samples samples samples samples', terms('samples'))
    expect(titled).toBeGreaterThan(mentioned)
  })

  it('an exact title wins outright', () => {
    const exact = score('sidechain', 'x', terms('sidechain'))
    const partial = score('sidechain and ducking', 'x', terms('sidechain'))
    expect(exact).toBeGreaterThan(partial)
  })

  it('the query as a PHRASE outranks the same words scattered', () => {
    const phrase = score('a', 'set the reverb mix here', terms('reverb mix'))
    const apart = score('a', 'reverb ... and elsewhere the mix', terms('reverb mix'))
    expect(phrase).toBeGreaterThan(apart)
  })

  it('an empty query scores neutral rather than rejecting', () => {
    expect(score('anything', 'at all', [])).toBe(0)
  })
})

describe('rank', () => {
  const items = [
    { t: 'mastering', b: 'a limiter and some gate talk' },
    { t: 'noise gate', b: 'opens above a threshold' },
    { t: 'drums', b: 'gate gate gate' },
  ]
  const fields = (x: { t: string; b: string }) => ({ title: x.t, body: x.b })

  it('puts the section ABOUT the word first', () => {
    const out = rank(items, terms('gate'), fields)
    expect(out[0]!.item.t).toBe('noise gate')
  })

  it('drops non-matches instead of showing them', () => {
    expect(rank(items, terms('supersaw'), fields)).toEqual([])
  })

  it('is STABLE, so a tie reads as document order', () => {
    /* Results that reshuffle between keystrokes are worse than results in a
     * boring order. */
    const tied = [{ t: 'a', b: 'zzz' }, { t: 'b', b: 'zzz' }, { t: 'c', b: 'zzz' }]
    expect(rank(tied, terms('zzz'), fields).map((r) => r.item.t)).toEqual(['a', 'b', 'c'])
  })

  it('returns everything for an empty query, unreordered', () => {
    expect(rank(items, [], fields).map((r) => r.item.t)).toEqual(['mastering', 'noise gate', 'drums'])
  })
})

describe('highlight', () => {
  it('marks the terms and leaves the rest alone', () => {
    const parts = highlight('a reverb tail', terms('reverb'))
    expect(parts.map((p) => p.text).join('')).toBe('a reverb tail')
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['reverb'])
  })

  it('PRESERVES case in the output while matching case-insensitively', () => {
    const parts = highlight('Reverb Room', terms('reverb'))
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Reverb'])
  })

  it('marks every occurrence, and every term', () => {
    const parts = highlight('mix the reverb mix', terms('reverb mix'))
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['mix', 'reverb', 'mix'])
  })

  it('MERGES overlapping terms rather than nesting them', () => {
    // `lf` sits inside `lfo`; one run, not a fragment inside a fragment
    const parts = highlight('an lfo here', terms('lfo lf'))
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['lfo'])
  })

  it('round-trips the text exactly, always', () => {
    for (const q of ['reverb', 'mix reverb', 'zzz', '']) {
      const src = 'Reverb and MIX, mixed.'
      expect(highlight(src, terms(q)).map((p) => p.text).join('')).toBe(src)
    }
  })

  it('a non-match is one plain run', () => {
    expect(highlight('nothing here', terms('supersaw'))).toEqual([{ text: 'nothing here', hit: false }])
  })
})

describe('snippet', () => {
  const long = `${'filler '.repeat(40)}the reverb mix control ${'tail '.repeat(40)}`

  it('returns short text whole, with whitespace collapsed', () => {
    expect(snippet('a  short\n line', terms('short'))).toBe('a short line')
  })

  it('WINDOWS around the first hit rather than the start', () => {
    const s = snippet(long, terms('reverb'))
    expect(s).toContain('reverb')
    expect(s.length).toBeLessThan(200)
  })

  it('marks a cut edge so a fragment does not read as a sentence', () => {
    expect(snippet(long, terms('reverb')).startsWith('…')).toBe(true)
  })

  it('falls back to the head when nothing matches', () => {
    const s = snippet(long, terms('supersaw'))
    expect(s.startsWith('filler')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })

  it('never returns more than the width plus its ellipses', () => {
    for (const q of ['reverb', 'tail', 'filler']) {
      expect(snippet(long, terms(q), 80).length).toBeLessThanOrEqual(82)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * The same rules, on the real docs. These are the queries that were measured
 * failing in a browser, so they are worth pinning against actual content
 * rather than fixtures: a scoring change that looks fine in the abstract can
 * still put the wrong section first.
 * ------------------------------------------------------------------------- */

describe('the real reference answers multi-word queries', () => {
  const groups = referenceGroups('js', [], DSL_DOCS)
  const hits = (q: string): number =>
    filterGroups(groups, q).reduce((n, g) => n + g.entries.length, 0)
  const top = (q: string): string => filterGroups(groups, q)[0]?.entries[0]?.signature ?? ''

  it('finds what two words describe, which used to find nothing', () => {
    // measured before: reverb 5, mix 17, "reverb mix" ZERO
    expect(hits('reverb')).toBeGreaterThan(0)
    expect(hits('mix')).toBeGreaterThan(0)
    expect(hits('reverb mix'), 'the reported failure').toBeGreaterThan(0)
    for (const q of ['wavetable warp', 'sample slices', 'lfo sync']) {
      expect(hits(q), q).toBeGreaterThan(0)
    }
  })

  it('leads with the symbol the query NAMES', () => {
    /* Matching every field shown means a common word hits many rows: `mix`
     * matched 17, and ranked by argument lists it put `supersaw(freq, opts?:
     * { detune?, mix? })` level with `mix` itself. */
    for (const name of ['mix', 'reverb', 'note', 'scale', 'sidechain']) {
      expect(top(name).toLowerCase().startsWith(name), `${name} -> ${top(name)}`).toBe(true)
    }
  })

  it('an empty query returns everything, in browsing order', () => {
    expect(filterGroups(groups, '  ')).toEqual([...groups])
  })
})

describe('cross-route hits', () => {
  it('answer two-word queries too', () => {
    expect(crossRouteHits('supersaw lead', 'guide').length).toBeGreaterThan(0)
  })

  it('say WHICH reference symbol matched', () => {
    /* Collapsing every reference row to the bare words "the reference" threw
     * away the only useful thing about the hit. */
    const hit = crossRouteHits('supersaw', 'troubleshooting').find((h) => h.view === 'reference')
    expect(hit?.title).toContain('supersaw')
  })

  it('still collapse to ONE reference hit, not one per symbol', () => {
    expect(crossRouteHits('sine', 'guide').filter((h) => h.view === 'reference')).toHaveLength(1)
  })
})

describe('ranking the real guide sections', () => {
  /* Built the way docs.ts builds it: prose is what a section is ABOUT, the
   * full text (code included) is a weaker signal, and the section id counts as
   * a title because the titles here are editorial. */
  const secs = sectionsFor('guide').map((s) => ({
    id: s.id,
    title: s.title,
    prose: `${s.title} ${s.blocks.map((b) => blockProse(b)).join(' ')}`.toLowerCase(),
    all: `${s.title} ${s.blocks.map((b) => blockText(b)).join(' ')}`.toLowerCase(),
  }))
  const top = (q: string): string =>
    rank(secs, terms(q), (s) => ({
      title: `${s.title} ${s.id}`.toLowerCase(),
      body: s.prose,
      weak: s.all,
    }))[0]?.item.id ?? ''

  it('CODE COUNTS FOR LESS than prose', () => {
    /* The measured failures. `gate` appears in every `adsr(gate, …)` call, so
     * scoring code equally put "Patterns & mini-notation" first; `reverb mix`
     * put "Singing" first because its post chain happens to contain both
     * words. Neither section is about either thing. */
    expect(top('gate'), 'gate went to a section full of adsr(gate, …)').toBe('dynamics')
    expect(top('reverb mix'), 'reverb mix went to a section with a matching post chain').toBe('mastering')
  })

  it('the section ID carries the topic when the title is editorial', () => {
    // the sidechain section is called "The pump"
    expect(top('sidechain')).toBe('sidechain')
  })

  it('and the obvious lookups land where a reader expects', () => {
    expect(top('samples')).toBe('samples')
    expect(top('lfo')).toBe('modulation')
    expect(top('chord')).toBe('notes')
  })
})
