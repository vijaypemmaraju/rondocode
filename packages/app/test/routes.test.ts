import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SECTIONS } from '../src/docs/content'
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
