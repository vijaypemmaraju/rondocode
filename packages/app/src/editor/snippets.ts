/* ------------------------------------------------------------------------- *
 * SNIPPETS: save any chunk of a document and paste it into another one.
 *
 * The synth library was a shelf of 19 fixed presets you could not add to, so
 * the only way to reuse something you wrote — a drum line, a bus, a whole
 * section — was to copy-paste between files and then own two of it.
 *
 * A SNIPPET CARRIES ITS SYNTHS. A drum line is four words:
 *
 *   beat
 *     kick ~ snare ~
 *
 * and those words are synth NAMES. Saved on its own it pastes into a document
 * that has never heard of `kick` and makes no sound, which is the same as not
 * having saved it. So saving walks what the selection references and brings
 * those definitions along — a snippet is the thing plus what it needs to be
 * that thing.
 *
 * Inserting then SKIPS a synth the target already defines, because pasting a
 * second `synth kick` is not a merge, it is a redefinition that changes the
 * drums somewhere else in the document you were not looking at.
 *
 * All of this is pure and text-level. A snippet that quietly drops a
 * dependency, or silently redefines an existing synth, is wrong in a way you
 * only notice when the music changes — so the rules are tested directly.
 * ------------------------------------------------------------------------- */

export type Lang = 'rondo' | 'rondocode'

/** A saved snippet. `code` already includes whatever synths it depends on. */
export interface Snippet {
  id: string
  name: string
  lang: Lang
  code: string
  createdAt: number
}

/** Rondo words that open a block or start a modifier, so they are never a
 *  synth reference even though they sit where one could. */
const RONDO_WORDS = new Set([
  'synth', 'play', 'beat', 'sing', 'section', 'song', 'bus', 'send', 'post', 'sum',
  'cps', 'bpm', 'timesig', 'level', 'patdef', 'macro', 'switch', 'sidechain', 'master',
  'curvedef', 'scaledef', 'wavedef', 'visual', 'js', 'scale', 'add', 'sub', 'dur', 'gain',
  'slow', 'fast', 'rev', 'arp', 'every', 'struct', 'euclid', 'degrade', 'palindrome',
])

/** The synth names a chunk of code plays. */
export function referencedSynths(code: string, lang: Lang): string[] {
  const out = new Set<string>()
  if (lang === 'rondocode') {
    // `.sound('x')` and `s('x')` — the two ways a pattern names a synth, and
    // `s(...)` is also a bare call, not only a method.
    //
    // The argument is MINI-NOTATION, not a name: `s('bd sn hh')` plays three
    // synths and `s('snare*4')` plays one four times. So the words are pulled
    // out of it rather than the string being taken whole, which would look
    // for a synth called "snare*4".
    for (const m of code.matchAll(/(?:\.sound|\bs)\([ \t]*['"`]([^'"`]+)['"`]/g)) {
      for (const w of m[1]!.matchAll(/[A-Za-z_]\w*/g)) out.add(w[0])
    }
    return [...out]
  }
  let block: 'beat' | 'play' | null = null
  for (const raw of code.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trimEnd()
    const text = line.trim()
    if (text === '') continue
    const indent = raw.length - raw.trimStart().length
    // `play NAME` routes to NAME unless `synth:OTHER` overrides it
    const play = /^play[ \t]+([A-Za-z_]\w*)/.exec(text)
    if (play) {
      block = 'play'
      const route = /[ \t]synth:([A-Za-z_]\w*)/.exec(text)
      out.add(route ? route[1]! : play[1]!)
      continue
    }
    if (/^beat\b/.test(text)) { block = 'beat'; continue }
    if (indent === 0) { block = null; continue }
    // a per-LINE route inside either block
    const lineRoute = /[ \t]synth:([A-Za-z_]\w*)/.exec(text)
    if (lineRoute) out.add(lineRoute[1]!)
    // a BEAT body's bare words ARE synth names — that is the whole notation
    if (block === 'beat') {
      for (const w of text.matchAll(/[A-Za-z_]\w*/g)) {
        const word = w[0]
        if (!RONDO_WORDS.has(word) && !/^\d/.test(word)) out.add(word)
      }
    }
  }
  return [...out]
}

/** Where each `synth NAME` (rondo) or `const NAME = synth(` (JS) block sits. */
export function synthBlocks(doc: string, lang: Lang): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>()
  const lines = doc.split('\n')
  const offs: number[] = []
  let at = 0
  for (const l of lines) { offs.push(at); at += l.length + 1 }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const text = raw.replace(/(^|\s)#.*$/, '').trim()
    const m =
      lang === 'rondo'
        ? /^synth[ \t]+([A-Za-z_]\w*)/.exec(text)
        : /^const[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*synth\b/.exec(raw)
    if (m === null) continue
    // a JS declaration is only a definition at the top level: an indented one
    // is inside a callback or a block, and is not this document's synth
    if (lang === 'rondocode' && raw.length - raw.trimStart().length !== 0) continue
    // the block runs to the next line at the same level or shallower
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l.trim() === '') continue
      const ind = l.length - l.trimStart().length
      if (lang === 'rondo' ? ind === 0 : ind === 0 && !/^[)}\]]/.test(l.trim())) break
      end = j
    }
    out.set(m[1]!, { from: offs[i]!, to: offs[end]! + lines[end]!.length })
  }
  return out
}

/**
 * The text to SAVE for `selection`: the selection plus every synth it plays
 * that the document defines.
 *
 * Definitions come first and in document order, because that is the order
 * they were written in and a reader of the snippet should see the same shape
 * they would have seen in the file it came from.
 */
export function collectSnippet(doc: string, selection: string, lang: Lang): string {
  const defined = synthBlocks(doc, lang)
  const needed = referencedSynths(selection, lang)
    .filter((n) => defined.has(n))
    // a synth the selection ALREADY contains is not a missing dependency
    .filter((n) => !selection.includes(defined.get(n)!.from === -1 ? n : doc.slice(defined.get(n)!.from, defined.get(n)!.to)))
  const blocks = needed
    .map((n) => ({ n, span: defined.get(n)! }))
    .sort((a, b) => a.span.from - b.span.from)
    .map((b) => doc.slice(b.span.from, b.span.to))
  return blocks.length === 0 ? selection.trim() : `${blocks.join('\n\n')}\n\n${selection.trim()}`
}

/**
 * The text to INSERT into `doc`, with any synth it already defines removed.
 *
 * Pasting a second `synth kick` is not a merge — it is a redefinition, and
 * the one that wins changes the drums elsewhere in a document you were not
 * looking at. Reports what it dropped so the UI can say so rather than
 * quietly delivering less than the snippet contained.
 */
export function insertableSnippet(
  doc: string,
  snippet: string,
  lang: Lang,
): { text: string; skipped: string[] } {
  const have = synthBlocks(doc, lang)
  if (have.size === 0) return { text: snippet, skipped: [] }
  const mine = synthBlocks(snippet, lang)
  const skipped: string[] = []
  // remove from the LAST block backwards so earlier offsets stay valid
  const drop = [...mine.entries()]
    .filter(([name]) => have.has(name))
    .sort((a, b) => b[1].from - a[1].from)
  let text = snippet
  for (const [name, span] of drop) {
    skipped.push(name)
    text = `${text.slice(0, span.from)}${text.slice(span.to)}`
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), skipped: skipped.reverse() }
}
