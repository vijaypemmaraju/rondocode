import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECTIONS, runnableCodeBlocks } from '../src/docs/content'
import { compile, decompile } from '@rondocode/rondo'
import { DSL_DOCS } from '../src/docs/dsl-docs'
import { OPTIONS } from '../src/editor/rondo'
import { referenceGroups } from '../src/editor/reference'
import { ROUTES, SEARCH_INDEX, crossRouteHits, sectionsFor, viewForGroup, viewForPath } from '../src/docs/routes'

/* ------------------------------------------------------------------------- *
 * Four routes over one set of sections.
 *
 * The split exists because ONE page mounted 79 CodeMirror editors. The risks
 * it introduces are all of the "silently missing" kind: a section whose group
 * belongs to no route simply stops existing, and a search that no longer spans
 * the docs looks like the content was deleted. Both are pinned here.
 * ------------------------------------------------------------------------- */
describe('every section reaches exactly one route', () => {
  it('claims every group', () => {
    const groups = [...new Set(SECTIONS.map((s) => s.group))]
    const orphans = groups.filter((g) => viewForGroup(g) === undefined)
    expect(orphans, `groups on no route: ${orphans.join(', ')}`).toEqual([])
  })

  it('never claims a group twice', () => {
    const all = ROUTES.flatMap((r) => r.groups)
    expect(new Set(all).size).toBe(all.length)
  })

  it('loses no section: the four routes partition SECTIONS', () => {
    const routed = ROUTES.flatMap((r) => sectionsFor(r.view)).map((s) => s.id)
    expect(new Set(routed).size).toBe(routed.length) // no duplicates
    expect(routed.length).toBe(SECTIONS.length) // and none dropped
  })

  it('puts the cookbook and troubleshooting on their own routes', () => {
    expect(sectionsFor('cookbook').every((s) => s.group === 'cookbook')).toBe(true)
    expect(sectionsFor('troubleshooting').length).toBeGreaterThan(4)
    expect(sectionsFor('reference')).toEqual([]) // generated, not authored
  })

  it('actually cuts the landing page down', () => {
    const editors = (v: Parameters<typeof sectionsFor>[0]): number =>
      sectionsFor(v).reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'code').length, 0)
    const all = SECTIONS.reduce((n, s) => n + s.blocks.filter((b) => b.kind === 'code').length, 0)
    expect(editors('guide')).toBeLessThan(all * 0.75)
  })
})

describe('paths', () => {
  it('maps each route path to its view', () => {
    for (const r of ROUTES) expect(viewForPath(r.path)).toBe(r.view)
  })

  it('tolerates a trailing slash', () => {
    expect(viewForPath('/cookbook/')).toBe('cookbook')
  })

  it('falls back to the guide rather than rendering nothing', () => {
    expect(viewForPath('/nope')).toBe('guide')
    expect(viewForPath('/')).toBe('guide')
  })

  it('has an html entry per route, wired into the build', () => {
    const app = join(__dirname, '..')
    const vite = readFileSync(join(app, 'vite.config.ts'), 'utf8')
    for (const r of ROUTES) {
      const file = `${r.path.replace(/^\//, '')}.html`
      expect(() => readFileSync(join(app, file), 'utf8'), file).not.toThrow()
      expect(vite, `${file} not a build input`).toContain(file)
      // every page loads the SAME entry: the path picks the view
      expect(readFileSync(join(app, file), 'utf8')).toContain('/src/docs.ts')
    }
  })
})

describe('search still spans the whole docs', () => {
  it('indexes every section, on whichever route it lives', () => {
    for (const s of SECTIONS) {
      expect(SEARCH_INDEX.some((e) => e.id === s.id), s.id).toBe(true)
    }
  })

  it('finds a cookbook recipe from the troubleshooting page', () => {
    const hits = crossRouteHits('supersaw', 'troubleshooting')
    expect(hits.some((h) => h.view === 'cookbook')).toBe(true)
  })

  it('links cross-route hits with a usable href', () => {
    for (const h of crossRouteHits('kick', 'reference')) {
      expect(h.href).toMatch(/^\/(docs|cookbook|troubleshooting|reference)#/)
    }
  })

  it('never offers a hit on the page you are already on', () => {
    for (const r of ROUTES) {
      expect(crossRouteHits('the', r.view).every((h) => h.view !== r.view)).toBe(true)
    }
  })

  it('collapses the reference to ONE hit, not one per symbol', () => {
    const hits = crossRouteHits('sine', 'guide')
    expect(hits.filter((h) => h.view === 'reference')).toHaveLength(1)
  })

  it('returns nothing for an empty query', () => {
    expect(crossRouteHits('   ', 'guide')).toEqual([])
  })
})

describe('cross-route hits are ranked, not just the first eight', () => {
  /* Searching "supersaw" from another page surfaced eight guide sections that
   * merely mention the word, before the cookbook recipe literally titled
   * "Build a wide supersaw lead" — the cap was filling in authoring order. */
  it('puts title matches ahead of body matches', () => {
    const hits = crossRouteHits('supersaw', 'troubleshooting')
    const firstBody = hits.findIndex((h) => !h.title.toLowerCase().includes('supersaw'))
    const lastTitle = hits.map((h) => h.title.toLowerCase().includes('supersaw')).lastIndexOf(true)
    if (firstBody !== -1 && lastTitle !== -1) expect(lastTitle).toBeLessThan(firstBody)
  })

  it('keeps authoring order within a rank, so results are stable', () => {
    expect(crossRouteHits('a', 'guide')).toEqual(crossRouteHits('a', 'guide'))
  })
})

describe('the reference speaks both languages', () => {
  /* rondo is not the JavaScript API with different punctuation: a builtin is
   * `svf cutoff res:…` there and `svf(inp, cutoff, opts?)` here. A reference
   * showing only one is accurate about JavaScript and about nothing a rondo
   * user can type. It reuses referenceGroups(), the same one the in-editor
   * `?` panel uses, so the two cannot disagree about what a group contains. */
  const sigs = (lang: 'rondo' | 'rondocode'): string[] =>
    referenceGroups(lang, OPTIONS, DSL_DOCS).flatMap((g) => g.entries.map((e) => e.signature))

  it('gives rondo its own spelling, not the JS call shape', () => {
    expect(sigs('rondo')).toContain('svf cutoff res:… mode:…')
    expect(sigs('rondocode').some((x) => x.startsWith('svf('))).toBe(true)
  })

  it('offers a real choice: the two differ substantially', () => {
    const overlap = sigs('rondo').filter((x) => sigs('rondocode').includes(x))
    // mini-notation is genuinely shared; everything else should not be
    expect(overlap.length).toBeLessThan(sigs('rondo').length / 2)
  })

  it('renders a language toggle wired to both, remembered and linkable', () => {
    const src = readFileSync(join(__dirname, '../src/docs.ts'), 'utf8')
    expect(src).toContain("['rondocode', 'JavaScript']")
    expect(src).toContain("['rondo', 'rondo']")
    expect(src, 'choice is not linkable').toContain("searchParams.set('lang'")
    expect(src, 'choice is not remembered').toContain('localStorage.setItem(LANG_KEY')
  })

  it('reuses referenceGroups rather than growing a second grouping', () => {
    const src = readFileSync(join(__dirname, '../src/docs.ts'), 'utf8')
    expect(src).toContain('referenceGroups(lang, OPTIONS, DSL_DOCS)')
  })
})

describe('every snippet can be shown in either language', () => {
  /* The point of closing the round-trip gaps (#210-#212): the other language
   * is GENERATED from the one authored source, so the two cannot drift. This
   * checks the conversion the docs page performs, on the real content. */
  // runnableCodeBlocks excludes troubleshooting's deliberately-broken halves:
  // a snippet that does not compile cannot be shown in the other language, and
  // inLang() leaves those as authored rather than pretending otherwise.
  const blocks = runnableCodeBlocks()

  it('has snippets in both languages to begin with', () => {
    expect(blocks.filter((b) => b.lang === 'rondo').length).toBeGreaterThan(15)
    expect(blocks.filter((b) => b.lang === undefined).length).toBeGreaterThan(10)
  })

  it('converts every rondo snippet to JavaScript', () => {
    const bad = blocks.filter((b) => b.lang === 'rondo' && !compile(b.text).ok)
    expect(bad.map((b) => b.id)).toEqual([])
  })

  it('converts every rondo snippet BACK without a js block', () => {
    // a snippet that only survives one direction would show a `js{ }` blob to
    // half the readers, which is what this whole arc was about
    const bad = blocks.filter((b) => {
      if (b.lang !== 'rondo') return false
      const c = compile(b.text)
      if (!c.ok) return true
      const d = decompile(c.code)
      return d.includes('js{') || /^js$/m.test(d)
    })
    expect(bad.map((b) => b.id)).toEqual([])
  })

  it('wires a language toggle that persists and travels', () => {
    const src = readFileSync(join(__dirname, '../src/docs.ts'), 'utf8')
    expect(src).toContain('doc-langpick')
    expect(src, 'not remembered').toContain('DOC_LANG_KEY')
    expect(src, 'not linkable').toContain("url.searchParams.set('lang'")
    expect(src, 'no way back to as-written').toContain('searchParams.delete')
  })

  it('falls back to the authored source rather than showing a js blob', () => {
    const src = readFileSync(join(__dirname, '../src/docs.ts'), 'utf8')
    expect(src).toMatch(/if \(!d\.includes\('js\{'\)/)
  })
})
