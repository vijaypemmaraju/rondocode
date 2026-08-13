/* ------------------------------------------------------------------------- *
 * Four routes over one set of sections.
 *
 * The docs were one page: 59 sections and SEVENTY-NINE CodeMirror editors,
 * every one mounted on load, each carrying the widget layer, the intellisense
 * and the WGSL overlay. Splitting is mostly about that, not about length.
 *
 * Split by CONTENT TYPE rather than by topic, because that is how each is
 * reached: the guide is read, the cookbook is browsed, troubleshooting is
 * searched from a symptom, the reference is looked up. Topic groups already
 * exist inside the guide and read in sequence, so the guide stays whole.
 *
 * SEARCH IS THE THING A SPLIT BREAKS. One box used to filter everything, and
 * losing that would be a real regression, so the index here spans every route
 * and the search box reports hits on other pages as links. The index is built
 * from the same SECTIONS the pages render, so it cannot describe a page that
 * does not exist.
 * ------------------------------------------------------------------------- */

import { rank, terms } from './search'

import { SECTIONS, blockText, orderedSections } from './content'
import { DSL_DOCS } from './dsl-docs'

export type DocView = 'guide' | 'cookbook' | 'troubleshooting' | 'reference'

export interface RouteDef {
  view: DocView
  /** URL path. A static host serves `cookbook.html` at `/cookbook`. */
  path: string
  /** Tab label. Short: on a phone these sit in one scrolling strip. */
  label: string
  /** Section groups this route renders. Empty for the reference, which is
   *  generated rather than authored. */
  groups: readonly string[]
  /** Sub-heading under the tabs, so a route explains itself. */
  blurb: string
}

export const ROUTES: readonly RouteDef[] = [
  {
    view: 'guide',
    path: '/docs',
    label: 'guide',
    groups: ['start here', 'sound design', 'effects & mix', 'patterns & form', 'voice & visuals', 'the rondo language'],
    blurb: 'Read it through, or jump to a topic. Every snippet plays.',
  },
  {
    view: 'cookbook',
    path: '/cookbook',
    label: 'cookbook',
    groups: ['cookbook'],
    blurb: 'Complete programs for things you might want. Paste one and press play.',
  },
  {
    view: 'troubleshooting',
    path: '/troubleshooting',
    label: 'troubleshooting',
    groups: ['troubleshooting'],
    blurb: 'It looked right and it did not work. Each one shows the trap beside the fix.',
  },
  {
    view: 'reference',
    path: '/reference',
    label: 'reference',
    groups: [],
    blurb: 'Every function and symbol in the language.',
  },
]

const byView = new Map(ROUTES.map((r) => [r.view, r]))

export const routeFor = (view: DocView): RouteDef => byView.get(view)!

/** Which route a URL is on. Unknown paths fall back to the guide, so a stale
 *  link or a host that rewrites unknown paths still lands somewhere useful. */
export function viewForPath(pathname: string): DocView {
  const p = pathname.replace(/\/+$/, '') || '/'
  return ROUTES.find((r) => r.path === p)?.view ?? 'guide'
}

/** The group a section belongs to decides its route, so a new group must be
 *  claimed by exactly one. Returns undefined for an unclaimed group, which
 *  routesCoverEveryGroup (tested) requires to never happen. */
export function viewForGroup(group: string): DocView | undefined {
  return ROUTES.find((r) => r.groups.includes(group))?.view
}

/** Sections belonging to a route, in authored order. */
export function sectionsFor(view: DocView, sections = SECTIONS): typeof SECTIONS {
  const r = routeFor(view)
  return orderedSections(sections).filter((s) => r.groups.includes(s.group))
}

/* ------------------------------- the index -------------------------------- */

export interface IndexEntry {
  /** Anchor id within its page. */
  id: string
  title: string
  view: DocView
  /** `/cookbook#recipe-pump` — usable as an href from any route. */
  href: string
  /** Everything searchable, lowercased. */
  text: string
}

/** Every section and every reference entry, on every route.
 *
 *  Built once at module load from the same data the pages render. It is plain
 *  strings, so a route can search the whole docs without loading another
 *  page's editors, which is the entire reason the split is affordable. */
export const SEARCH_INDEX: readonly IndexEntry[] = (() => {
  const out: IndexEntry[] = []
  for (const s of SECTIONS) {
    const view = viewForGroup(s.group)
    if (view === undefined) continue
    const parts = [s.title, s.group, ...s.blocks.map(blockText)]
    out.push({
      id: s.id,
      title: s.title,
      view,
      href: `${routeFor(view).path}#${s.id}`,
      text: parts.join(' ').toLowerCase(),
    })
  }
  for (const e of DSL_DOCS) {
    out.push({
      id: `ref-${e.name}`,
      title: e.signature,
      view: 'reference',
      href: `/reference#reference`,
      text: `${e.name} ${e.signature} ${e.summary} ${e.example ?? ''}`.toLowerCase(),
    })
  }
  return out
})()

/** Hits for `q` that live on OTHER routes, so a search never silently omits
 *  half the docs just because the reader is on the wrong page. Capped: this is
 *  a "look over here" list, not a second results page. */
export function crossRouteHits(q: string, current: DocView, limit = 8): IndexEntry[] {
  const ts = terms(q)
  if (ts.length === 0) return []
  /* RANKED, not index order. Searching "supersaw" from another page turned up
   * eight guide sections that mention the word before the cookbook recipe
   * actually called "Build a wide supersaw lead", because the cap filled in
   * authoring order. A title match is what the reader meant.
   *
   * EVERY TERM must appear, rather than the query as one substring: two words
   * is how a reader describes a thing, and it was the one shape that could
   * never match. */
  const hits = rank(
    SEARCH_INDEX.filter((e) => e.view !== current),
    ts,
    (e) => ({ title: e.title.toLowerCase(), body: e.text }),
  ).map((r) => r.item)
  // one line per reference symbol would drown the section hits, so the
  // reference collapses to a single entry
  const seen = new Set<string>()
  const out: IndexEntry[] = []
  for (const h of hits) {
    const key = h.view === 'reference' ? 'reference' : h.id
    if (seen.has(key)) continue
    seen.add(key)
    /* Keep WHICH SYMBOL matched. Collapsing every reference row to the bare
     * words "the reference" threw away the one useful thing about the hit: a
     * search for `supersaw` ranks the `supersaw(...)` entry top, and then
     * showed a link that could have been about anything. */
    out.push(h.view === 'reference'
      ? { ...h, title: `the reference: ${h.title}`, id: 'reference' }
      : h)
    if (out.length >= limit) break
  }
  return out
}
