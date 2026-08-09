import { describe, expect, it } from 'vitest'
import { GROUP_ORDER, SECTIONS, blockText, orderedSections } from '../src/docs/content'
import type { Block } from '../src/docs/content'
import { blockHtml, inlineHtml } from '../src/docs/blocks'
import { Pattern } from '@rondocode/pattern'
import { synth } from '@rondocode/engine'
import { STAGING_NAMES } from '../src/session/evalCode'
import type { PostCtx, Sig, SynthCtx } from '@rondocode/engine'
import { baseScope } from '../src/session/scope'
import { DSL_DOCS, docsByName, docsOfKind } from '../src/docs/dsl-docs'
import { BLOCK_KEYWORDS } from '@rondocode/rondo'
import { CHORD_QUALITIES } from '@rondocode/pattern'
import type { TableBlock } from '../src/docs/content'

/* ------------------------------------------------------------------------- *
 * Anti-drift: the docs data is pinned BIDIRECTIONALLY against the live
 * objects. Every name the runtime actually exposes must have a DocEntry of
 * the right kind, and every DocEntry of these kinds must name something
 * that exists. Add a combinator, a control, a ctx member or a Sig method
 * without documenting it — or document a name that is not real — and this
 * suite fails.
 * ------------------------------------------------------------------------- */

const namesOfKind = (kind: (typeof DSL_DOCS)[number]['kind']): string[] =>
  docsOfKind(kind).map((e) => e.name)

const assertBidirectional = (docNames: string[], liveNames: string[], what: string): void => {
  const docs = new Set(docNames)
  const live = new Set(liveNames)
  const undocumented = [...live].filter((n) => !docs.has(n))
  const phantom = [...docs].filter((n) => !live.has(n))
  expect(undocumented, `${what}: live names missing a DocEntry`).toEqual([])
  expect(phantom, `${what}: DocEntries naming nothing live`).toEqual([])
  // no duplicate entries for one (name, kind)
  expect(docNames.length, `${what}: duplicate DocEntries`).toBe(docs.size)
}

describe('docs coverage: globals', () => {
  it('covers every baseScope key plus the per-eval staging names, bidirectionally', () => {
    // p / defineSynth / setCps / setBpm / setTimeSig and friends are injected
    // per-eval by evalCode(), so they are part of the vocabulary even though
    // they are not baseScope keys. IMPORTED, not retyped: this list used to be
    // a second copy, and a new staging name could be added to the evaluator
    // and simply never noticed here.
    const NOT_A_GLOBAL_ENTRY = new Set([
      // Documented by the guide sections that own them (visuals, singing)
      // rather than as one-line global entries: each needs a whole page.
      'visual',
      'sing',
      // Internal: the probe-location hook the evaluator injects for inline
      // live values. Not vocabulary anyone writes.
      '__rcTap',
    ])
    const live = [
      ...Object.keys(baseScope),
      ...[...STAGING_NAMES].filter((n) => !NOT_A_GLOBAL_ENTRY.has(n)),
    ]
    assertBidirectional(namesOfKind('global'), live, 'globals')
  })
})

describe('docs coverage: Pattern methods', () => {
  it('covers every public Pattern.prototype method, bidirectionally', () => {
    // Internal plumbing, excluded deliberately: each is marked "not part of
    // the musical API" in pattern.ts (withQueryTime / withHapTime /
    // splitQueries / compressSpan) or is TS-private (bindWhole).
    const INTERNAL = new Set(['constructor', 'bindWhole', 'withQueryTime', 'withHapTime', 'splitQueries', 'compressSpan'])
    const live = Object.getOwnPropertyNames(Pattern.prototype).filter(
      (n) =>
        !INTERNAL.has(n) &&
        typeof (Pattern.prototype as unknown as Record<string, unknown>)[n] === 'function',
    )
    expect(live.length).toBeGreaterThan(40) // sanity: the prototype is populated
    assertBidirectional(namesOfKind('pattern-method'), live, 'pattern methods')
  })
})

describe('docs coverage: synth ctx and Sig', () => {
  // Probe a real synth() build: capture the ctx object and one Sig.
  let ctx!: SynthCtx
  let post!: PostCtx
  let sig!: Sig
  synth(
    (c) => {
      ctx = c
      sig = c.sine(440)
      return sig
    },
    // Probe the post-chain ctx too — its extra surface (`input`) is documented
    // under the same 'synth-ctx' kind, so the coverage set is the UNION.
    (pc) => {
      post = pc
      return pc.input
    },
  )

  it('covers every SynthCtx + PostCtx member, bidirectionally', () => {
    const live = [...new Set([...Object.keys(ctx), ...Object.keys(post)])]
    assertBidirectional(namesOfKind('synth-ctx'), live, 'synth ctx')
  })

  it('covers every Sig method, bidirectionally', () => {
    // 'bin' is SigImpl's TS-private binary-node helper (builder.ts).
    const INTERNAL = new Set(['constructor', 'bin'])
    const proto = Object.getPrototypeOf(sig) as Record<string, unknown>
    const live = Object.getOwnPropertyNames(proto).filter(
      (n) => !INTERNAL.has(n) && typeof proto[n] === 'function',
    )
    expect(live.length).toBeGreaterThan(5) // sanity
    assertBidirectional(namesOfKind('sig-method'), live, 'sig methods')
  })
})

describe('docs coverage: mini-notation syntax', () => {
  it('documents exactly the v1 grammar operators', () => {
    // Pinned by hand against the grammar in packages/pattern/src/mini.ts
    // (header comment, "Grammar (v1)"). A grammar change updates BOTH the
    // parser and this list + the mini-syntax DocEntries.
    const GRAMMAR = [
      'mini:seq', // a b c   — sequence
      'mini:~', //   ~       — rest
      'mini:_', //   _       — elongate previous step
      'mini:[]', //  [a b]   — subgroup (',' stacks)
      'mini:<>', //  <a b>   — alternation, one per cycle
      'mini:{}', //  {..}%n  — polymeter
      'mini:*', //   a*n     — faster within the slot
      'mini:/', //   a/n     — slower across cycles
      'mini:!', //   a!n     — duplicate step
      'mini:@', //   a@n     — weight
      'mini:(p,s,r)', // a(3,8) — euclidean rhythm
      'mini:?', //   a?p     — random drop
      'mini:|', //   a | b   — random choice per cycle

      "mini:'", // 0'2 0'vel:.8 — per-note lanes
    ]
    assertBidirectional(namesOfKind('mini-syntax'), GRAMMAR, 'mini syntax')
  })
})

describe('docs data shape', () => {
  it('every entry has a non-empty signature and a one-sentence summary', () => {
    for (const e of DSL_DOCS) {
      expect(e.signature.length, e.name).toBeGreaterThan(0)
      expect(e.summary.length, e.name).toBeGreaterThan(10)
    }
  })

  it('docsByName maps every entry and groups collisions', () => {
    expect(docsByName.get('mul')?.map((e) => e.kind).sort()).toEqual(['pattern-method', 'sig-method'])
    const total = [...docsByName.values()].reduce((a, l) => a + l.length, 0)
    expect(total).toBe(DSL_DOCS.length)
  })
})

describe('docs style rules', () => {
  it('no em dashes anywhere in the docs (house rule)', async () => {
    const { SECTIONS, HERO } = await import('../src/docs/content')
    expect(HERO.blurb.includes('—')).toBe(false)
    expect(HERO.tagline.includes('—')).toBe(false)
    for (const s of SECTIONS) {
      // blockText, not b.text: it reads EVERY prose field of every kind, so
      // table headers/cells, list items and note bodies are swept too.
      for (const b of s.blocks) {
        expect(blockText(b).includes('—'), `em dash in section '${s.id}'`).toBe(false)
      }
    }
    for (const e of DSL_DOCS) {
      expect(`${e.summary} ${e.signature}`.includes('—'), `em dash in dsl-docs '${e.name}'`).toBe(false)
    }
  })

  it('every section carries a nav group', async () => {
    const { SECTIONS } = await import('../src/docs/content')
    for (const s of SECTIONS) expect(s.group.length, `section '${s.id}' has no group`).toBeGreaterThan(0)
  })
})

describe('guide grouping', () => {
  it('every section group is listed in GROUP_ORDER', () => {
    const known = new Set(GROUP_ORDER)
    const unknown = [...new Set(SECTIONS.map((s) => s.group))].filter((g) => !known.has(g))
    expect(unknown).toEqual([]) // a new group must be placed deliberately
  })

  it('orderedSections emits each group exactly ONCE (the nav headings)', () => {
    const groups = orderedSections().map((s) => s.group)
    const headings = groups.filter((g, i) => g !== groups[i - 1])
    expect(headings).toEqual([...new Set(headings)]) // no group appears twice
    expect(headings).toEqual(GROUP_ORDER.filter((g) => groups.includes(g)))
  })

  it('keeps the authored order within a group, and loses no section', () => {
    const ordered = orderedSections()
    expect(ordered).toHaveLength(SECTIONS.length)
    for (const g of GROUP_ORDER) {
      const authored = SECTIONS.filter((s) => s.group === g).map((s) => s.id)
      const shown = ordered.filter((s) => s.group === g).map((s) => s.id)
      expect(shown).toEqual(authored)
    }
  })
})

/* ------------------------------------------------------------------------- *
 * Rich blocks: tables, lists and notes. Three separate contracts, and every
 * one of them fails SILENTLY if it breaks — a malformed table just loses a
 * column, a block the search cannot read just stops being findable. So each
 * is pinned here.
 * ------------------------------------------------------------------------- */

const allBlocks: { id: string; b: Block }[] = SECTIONS.flatMap((s) => s.blocks.map((b) => ({ id: s.id, b })))
const blocksOf = <K extends Block['kind']>(kind: K): Extract<Block, { kind: K }>[] =>
  allBlocks.map((x) => x.b).filter((b): b is Extract<Block, { kind: K }> => b.kind === kind)

describe('guide table data', () => {
  it('the guide actually uses the rich kinds (otherwise these tests pin nothing)', () => {
    expect(blocksOf('table').length).toBeGreaterThanOrEqual(8)
    expect(blocksOf('list').length).toBeGreaterThanOrEqual(1)
    expect(blocksOf('note').length).toBeGreaterThanOrEqual(3)
    // and the warn tone is in use, not just declared
    expect(blocksOf('note').some((n) => n.tone === 'warn')).toBe(true)
  })

  it('every row has exactly one cell per header, and no table is empty', () => {
    for (const { id, b } of allBlocks) {
      if (b.kind !== 'table') continue
      expect(b.headers.length, `table in '${id}' has no headers`).toBeGreaterThanOrEqual(2)
      expect(b.rows.length, `table in '${id}' has no rows`).toBeGreaterThanOrEqual(2)
      for (const [i, row] of b.rows.entries()) {
        expect(row.length, `table in '${id}', row ${i}: cell count`).toBe(b.headers.length)
        for (const cell of row) expect(cell.trim().length, `table in '${id}', row ${i}: empty cell`).toBeGreaterThan(0)
      }
    }
  })

  it('every list has items, and every note has a legal tone', () => {
    for (const { id, b } of allBlocks) {
      if (b.kind === 'list') expect(b.items.length, `list in '${id}'`).toBeGreaterThanOrEqual(2)
      if (b.kind === 'note') {
        expect(b.text.length, `note in '${id}'`).toBeGreaterThan(10)
        expect(['info', 'warn', undefined]).toContain(b.tone)
      }
    }
  })

  it('backticks in cells and items are balanced (an odd one renders as a stray tick)', () => {
    for (const { id, b } of allBlocks) {
      const fields = b.kind === 'table' ? [...b.headers, ...b.rows.flat()] : b.kind === 'list' ? b.items : []
      for (const f of fields) {
        expect((f.match(/`/g) ?? []).length % 2, `unbalanced backtick in '${id}': ${f}`).toBe(0)
      }
    }
  })
})

describe('blockText (the search index)', () => {
  it('reports every prose field of every kind', () => {
    expect(blockText({ kind: 'p', text: 'para' })).toContain('para')
    expect(blockText({ kind: 'note', text: 'careful' })).toContain('careful')
    expect(blockText({ kind: 'code', caption: 'cap', text: 'src' })).toContain('cap')
    expect(blockText({ kind: 'code', caption: 'cap', text: 'src' })).toContain('src')
    expect(blockText({ kind: 'list', items: ['one', 'two'] })).toContain('two')
    const t = blockText({ kind: 'table', caption: 'cap', headers: ['h1', 'h2'], rows: [['r1', 'r2']] })
    for (const word of ['cap', 'h1', 'h2', 'r1', 'r2']) expect(t).toContain(word)
  })

  it('makes the converted passages findable by the words that were in the prose', () => {
    // the docs-page search lowercases the joined blockText of a section
    const indexOf = (id: string): string =>
      SECTIONS.filter((s) => s.id === id)
        .flatMap((s) => s.blocks.map(blockText))
        .join(' ')
        .toLowerCase()
    expect(indexOf('rondo-mini')).toContain('polymeter') // table cell
    expect(indexOf('rondo-widgets')).toContain('step sequencer') // table cell
    expect(indexOf('samples')).toContain('resample row') // list item
    expect(indexOf('live-mic')).toContain('headphones') // note text
    expect(indexOf('effects')).toContain('dotted eighth') // table cell
  })
})

describe('block markup (docs page rendering)', () => {
  it('inline `code` spans work the same in every kind, through one formatter', () => {
    const span = inlineHtml('use `svf` here')
    expect(span).toBe('use <code>svf</code> here')
    expect(blockHtml({ kind: 'p', text: 'use `svf` here' })).toContain('<code>svf</code>')
    expect(blockHtml({ kind: 'note', text: 'use `svf` here' })).toContain('<code>svf</code>')
    expect(blockHtml({ kind: 'list', items: ['use `svf` here'] })).toContain('<code>svf</code>')
    expect(blockHtml({ kind: 'table', headers: ['a'], rows: [['use `svf` here']] })).toContain('<code>svf</code>')
  })

  it('escapes markup before it can reach the page', () => {
    const html = blockHtml({ kind: 'table', headers: ['<b>'], rows: [['<img src=x>']] })
    expect(html).not.toContain('<b>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x&gt;')
  })

  it('renders a table inside its own horizontal scroller (the PAGE must never scroll)', () => {
    const html = blockHtml({ kind: 'table', caption: 'cap', headers: ['a', 'b'], rows: [['1', 'x']] })
    expect(html.startsWith('<div class="doc-table-wrap">')).toBe(true)
    expect(html).toContain('<caption>cap</caption>')
    expect(html).toContain('<th scope="col"')
    expect(html).toContain('<td')
  })

  it('gives an all-numeric column tabular figures, and a mixed one none', () => {
    const html = blockHtml({
      kind: 'table',
      headers: ['cycles', 'name'],
      rows: [['1', 'a bar'], ['0.25', 'a quarter']],
    })
    // column 0 is numeric: header + both cells carry the class
    expect((html.match(/class="num"/g) ?? []).length).toBe(3)
    expect(html).toContain('<td class="num">0.25</td>')
    expect(html).toContain('<td>a quarter</td>')
  })

  it('renders ordered vs bulleted lists, and the warn tone of a note', () => {
    expect(blockHtml({ kind: 'list', items: ['a', 'b'], ordered: true })).toContain('<ol class="doc-list">')
    expect(blockHtml({ kind: 'list', items: ['a', 'b'] })).toContain('<ul class="doc-list">')
    expect(blockHtml({ kind: 'note', text: 'careful' })).toBe('<aside class="doc-note">careful</aside>')
    expect(blockHtml({ kind: 'note', text: 'careful', tone: 'warn' })).toContain('doc-note-warn')
  })

  it('renders EVERY block in the real guide to non-empty markup', () => {
    for (const { id, b } of allBlocks) {
      if (b.kind === 'code') continue // code blocks are live editors, built by docs.ts
      const html = blockHtml(b)
      expect(html.startsWith('<'), `block in '${id}' produced no element`).toBe(true)
      expect(html).not.toContain('undefined')
    }
  })
})

describe('the guide covers the editor, not just the language', () => {
  const text = SECTIONS.flatMap((s) => s.blocks.map(blockText)).join(' ').toLowerCase()

  it('teaches the touch scrub, its lens and its speed tiers', () => {
    expect(text).toContain('lens')
    expect(text).toMatch(/x10|x100/)
    expect(text).toContain('scrub')
  })

  it('teaches go-to-definition, comment toggle and the formatter', () => {
    expect(text).toContain('jump to its definition')
    expect(text).toMatch(/comments? a line/)
    expect(text).toContain('format')
  })

  it('says what the formatter will never do (the promise that makes it safe)', () => {
    expect(text).toMatch(/never change what your code compiles to/)
  })
})

describe('copy accuracy (claims must match the code)', () => {
  const text = SECTIONS.flatMap((s) => s.blocks.map((b) => blockText(b))).join(' ')

  it('the export section documents the 0.89 peak scale that renderMix applies', () => {
    // renderMix peak-normalizes a mix above 0.89 DOWN to it. The guide said
    // "nothing is normalized for you on the way out", which was false and
    // would mislead anyone reading the LUFS number.
    expect(text).toContain('0.89')
    expect(text).toMatch(/scaled DOWN|scaled down/)
  })

  it('does not claim an export is identical to what you heard', () => {
    expect(text).not.toMatch(/identical to what you (just )?heard/i)
  })
})

/* ------------------------------------------------------------------------- *
 * THE INVENTORIES, pinned to the code that defines them.
 *
 * An audit found the rondo cheat sheet promising "every block shape in the
 * language" while missing six of them (`patdef`, `timesig`, `level`, `macro`,
 * `switch`, `curvedef`), and the chord blurb listing a subset of the qualities
 * the parser accepts — including three the very commit that touched it had
 * just added. Both are the repo's usual bug: a list maintained by hand, with
 * nothing to notice when the real one grows.
 *
 * These do NOT check that the prose is good, only that it NAMES everything.
 * A row that says nothing useful still passes — but a keyword that exists and
 * is nowhere on the page cannot.
 * ------------------------------------------------------------------------- */

describe('the rondo cheat sheet really is every block shape', () => {
  const cheatSheet = ((): TableBlock => {
    const t = SECTIONS.flatMap((s) => s.blocks).find(
      (b): b is TableBlock => b.kind === 'table' && (b.caption ?? '').startsWith('Cheat sheet'),
    )
    if (t === undefined) throw new Error('the cheat sheet table is gone — this suite would be vacuous')
    return t
  })()

  const cells = cheatSheet.rows.map((r) => r[0] ?? '').join(' ')

  it('names every top-level block keyword the parser dispatches on', () => {
    // BLOCK_KEYWORDS is the parser's own list, imported rather than retyped:
    // adding a keyword there and not here is exactly the drift this catches.
    const missing = BLOCK_KEYWORDS.filter((k) => !new RegExp(`\`[^\`]*\\b${k}\\b`).test(cells))
    expect(missing, 'block keywords absent from the cheat sheet').toEqual([])
  })

  it('names the body-level words too, which open nothing at the top level', () => {
    // `post`/`send`/`sum`/`with` are not BLOCK_KEYWORDS (words.ts adds them for
    // highlighting), and `sum` — the language's only loop — was undocumented.
    for (const w of ['post', 'send', 'sum', 'with']) {
      expect(cells, `\`${w}\` is a keyword with no cheat-sheet row`).toContain(w)
    }
  })

  it('the guide explains each block keyword somewhere, not just the table', () => {
    // a cheat-sheet row on its own is a reminder, not documentation
    const prose = SECTIONS.flatMap((s) => s.blocks.map(blockText)).join(' ')
    const unexplained = BLOCK_KEYWORDS.filter(
      (k) => (prose.match(new RegExp(`\\b${k}\\b`, 'g')) ?? []).length < 2,
    )
    expect(unexplained, 'block keywords the guide only lists, never explains').toEqual([])
  })
})

describe('the chord blurb names every quality the parser accepts', () => {
  it('lists all of CHORD_QUALITIES, aliases included', () => {
    const entry = (docsByName.get('chord') ?? []).find((e) => e.kind === 'global')
    expect(entry, 'the chord DocEntry is gone').toBeDefined()
    const blurb = entry!.summary
    // word boundaries alone are not enough: `m7` appears inside `m7b5`, so a
    // list naming only the longer one would pass. Each quality must appear
    // where it is not immediately followed by more quality characters.
    const missing = CHORD_QUALITIES.filter((q) => {
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return !new RegExp(`(^|[^\\w])${esc}(?![\\w])`).test(blurb)
    })
    expect(missing, 'chord qualities the docs never name').toEqual([])
  })
})


/* ------------------------------------------------------------------------- *
 * EVERY DSP NODE IS TAUGHT SOMEWHERE, not only listed.
 *
 * The reference (dsl-docs) is pinned bidirectionally against the live objects,
 * so a node cannot exist without an entry. Nothing pinned the GUIDE, and the
 * difference showed: `noisegate`, `deess` and `limiter` shipped with full
 * reference entries and no mention in the guide at all. They only stopped
 * being invisible because a paragraph about the mic strip happened to name
 * them.
 *
 * "Mentioned once" is a low bar on purpose — this cannot judge whether the
 * prose is any good. What it can do is stop a node from being reference-only,
 * which is how someone learns a feature exists: by reading the guide, not by
 * scrolling the API list.
 * ------------------------------------------------------------------------- */
describe('the guide teaches every node the reference documents', () => {
  const guide = SECTIONS.flatMap((s) => s.blocks.map(blockText)).join(' ')

  it('finds the guide text (an empty string would pass everything)', () => {
    expect(guide.length).toBeGreaterThan(20_000)
  })

  it('names every synth-ctx node somewhere in the guide', () => {
    const missing = docsOfKind('synth-ctx')
      .map((e) => e.name)
      .filter((n) => !new RegExp(`\\b${n}\\b`).test(guide))
    expect(missing, 'nodes documented in the reference but never in the guide').toEqual([])
  })
})
