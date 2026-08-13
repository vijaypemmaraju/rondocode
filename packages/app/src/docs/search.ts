/* ------------------------------------------------------------------------- *
 * DOCS SEARCH: the matching, the ranking and the snippets.
 *
 * Every surface used to do `text.includes(query)` with the RAW query, so any
 * search of more than one word found nothing at all. Measured on the shipped
 * docs: `reverb` matched 5 reference entries and `mix` matched 17, while
 * `reverb mix` matched ZERO; `wavetable warp` reported "no matches on this
 * page" although both words are on it. A reader typing the two words that
 * describe the thing they want is the normal case, and it was the one case
 * that could not work.
 *
 * So: TERMS, and all of them must appear (AND). That alone fixes every failing
 * query above. The rest of this file exists because the other half of the
 * complaint was the opposite problem — `gate` matched 32 of 44 guide sections,
 * in document order, with nothing to say where in each the word appeared. A
 * result you cannot rank and cannot see inside is a shorter page, not an
 * answer.
 *
 * Pure and framework-free, so the ranking is testable without a DOM and the
 * page, the reference panel and the cross-route index cannot drift into three
 * different ideas of what a match is.
 * ------------------------------------------------------------------------- */

/** Split a query into search terms: lowercased, whitespace-separated, no
 *  empties. Punctuation is KEPT — `0'gain:.8`, `*n` and `(3,8)` are things a
 *  reader searches for, and stripping symbols would make the mini-notation
 *  reference unsearchable by its own names. */
export function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t !== '')
}

/** Every term appears somewhere in `text`. `text` is assumed lowercased. */
export function matchesAll(text: string, ts: readonly string[]): boolean {
  for (const t of ts) if (!text.includes(t)) return false
  return true
}

/**
 * How well a title + body answer the query, or -1 for "not a match".
 *
 * A TITLE HIT OUTWEIGHS ANY NUMBER OF BODY HITS, because a section called
 * "Samples & granular" is what someone typing `samples` meant, and it would
 * otherwise sit below every section that happens to mention the word. The
 * whole query appearing as a PHRASE outranks the same words scattered, for the
 * same reason.
 *
 * Both are assumed lowercased; callers lowercase once when they build the
 * index rather than on every keystroke.
 */
/** How often `t` occurs in `text`. Both lowercased. */
function count(text: string, t: string): number {
  if (t === '') return 0
  let n = 0
  let at = text.indexOf(t)
  while (at !== -1) {
    n++
    at = text.indexOf(t, at + t.length)
  }
  return n
}

/** Ceiling on how much one term's repetition can contribute.
 *
 *  HOW OFTEN a word appears is the signal that survives editorial titles. No
 *  guide section is called "sidechain" — the one about it is called "The pump"
 *  — so title weighting alone left every match tied at the same score and
 *  falling back to document order, which is how "Live controls in the code"
 *  came top for `sidechain`. The section that says the word twelve times is
 *  the one about it.
 *
 *  Capped so a single long section cannot win on bulk alone. */
const BODY_CAP = 12

export function score(title: string, body: string, ts: readonly string[], weak = ''): number {
  if (ts.length === 0) return 0
  const hay = `${title} ${body} ${weak}`
  if (!matchesAll(hay, ts)) return -1
  let n = 0
  for (const t of ts) {
    if (title.includes(t)) n += 10
    n += Math.min(count(body, t), BODY_CAP)
    // CODE COUNTS FOR LESS. Every example calls `adsr(gate, …)` and half of
    // them end in a `mix:` — words that say nothing about what the section is
    // for. Still counted, so a symbol only shown in code is findable.
    n += Math.min(count(weak, t), BODY_CAP) * 0.25
  }
  // an exact title is the strongest signal there is
  const phrase = ts.join(' ')
  if (title === phrase) n += 50
  else if (title.includes(phrase)) n += 20
  else if (body.includes(phrase)) n += 5
  return n
}

export interface Ranked<T> {
  item: T
  score: number
}

/**
 * Rank items by `score`, dropping non-matches. STABLE: equal scores keep their
 * original order, so a tie reads as document order rather than as noise that
 * reshuffles between keystrokes.
 */
export function rank<T>(
  items: readonly T[],
  ts: readonly string[],
  fields: (item: T) => { title: string; body: string; weak?: string },
): Ranked<T>[] {
  const out: (Ranked<T> & { i: number })[] = []
  items.forEach((item, i) => {
    const f = fields(item)
    const s = score(f.title, f.body, ts, f.weak ?? '')
    if (s >= 0) out.push({ item, score: s, i })
  })
  out.sort((a, b) => b.score - a.score || a.i - b.i)
  return out.map(({ item, score: s }) => ({ item, score: s }))
}

/** A run of text, flagged when it is one of the search terms. */
export interface Part {
  text: string
  hit: boolean
}

/**
 * Split `text` into plain and matching runs, for rendering with the terms
 * marked. Case is PRESERVED in the output — the reader gets their prose back,
 * not a lowercased copy — while matching is case-insensitive.
 *
 * Overlapping terms are merged rather than nested, so `lfo` and `lf` together
 * produce one run instead of a fragment inside a fragment.
 */
export function highlight(text: string, ts: readonly string[]): Part[] {
  if (ts.length === 0 || text === '') return text === '' ? [] : [{ text, hit: false }]
  const low = text.toLowerCase()
  const spans: [number, number][] = []
  for (const t of ts) {
    if (t === '') continue
    let at = low.indexOf(t)
    while (at !== -1) {
      spans.push([at, at + t.length])
      at = low.indexOf(t, at + 1)
    }
  }
  if (spans.length === 0) return [{ text, hit: false }]
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last !== undefined && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
    else merged.push([s[0], s[1]])
  }
  const parts: Part[] = []
  let at = 0
  for (const [a, b] of merged) {
    if (a > at) parts.push({ text: text.slice(at, a), hit: false })
    parts.push({ text: text.slice(a, b), hit: true })
    at = b
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}

/**
 * A window of `text` around the first term, for showing WHERE a hit is.
 *
 * The point of the snippet is that a result list beats a filtered page: with
 * `gate` matching 32 sections, the question is never "which sections mention
 * it" but "which one is about it", and a line of context answers that at a
 * glance. Cut edges are marked with an ellipsis so a fragment does not read as
 * a whole sentence.
 */
export function snippet(text: string, ts: readonly string[], width = 150): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const low = flat.toLowerCase()
  let at = -1
  for (const t of ts) {
    const i = low.indexOf(t)
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  if (at === -1) return `${flat.slice(0, width).trimEnd()}…`
  // centre the window on the hit, then pull back inside the string
  let from = Math.max(0, at - Math.floor(width / 3))
  if (from + width > flat.length) from = Math.max(0, flat.length - width)
  const body = flat.slice(from, from + width).trim()
  return `${from > 0 ? '…' : ''}${body}${from + width < flat.length ? '…' : ''}`
}
