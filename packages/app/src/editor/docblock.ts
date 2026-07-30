/* ------------------------------------------------------------------------- *
 * The doc block: one rendering, every surface that explains a word.
 *
 * A hover tooltip and a completion info panel say the same thing about the
 * same word, so they are the same block: a monospace signature in the accent
 * colour, a summary, and an optional example. The theme styles `.cm-dsl-doc`
 * and its three children; `.cm-completionInfo` deliberately carries no padding
 * of its own because THIS is what supplies it.
 *
 * That last detail is why this module exists. rondo's hover and completions
 * were building their own markup with their own class names, which had no
 * theme rules at all — so the same documentation that renders as a formatted
 * card over JavaScript rendered as unstyled text jammed against the tooltip
 * border over rondo. The content was never the problem; the wrapper was. A
 * shared renderer is the only way that cannot drift back apart.
 * ------------------------------------------------------------------------- */

/** What every documented word has: how it is spelled, what it does, and (when
 *  it earns one) a line you could type. */
export interface DocBlock {
  signature: string
  summary: string
  example?: string
}

/** One doc card. Text nodes throughout — a summary is prose from a table, not
 *  markup, and building it with innerHTML would make a docs typo an injection. */
export function renderDocBlock(d: DocBlock): HTMLElement {
  const root = document.createElement('div')
  root.className = 'cm-dsl-doc'
  const sig = document.createElement('div')
  sig.className = 'cm-dsl-doc-signature'
  sig.textContent = d.signature
  const summary = document.createElement('div')
  summary.className = 'cm-dsl-doc-summary'
  summary.textContent = d.summary
  root.append(sig, summary)
  if (d.example !== undefined && d.example !== '') {
    const ex = document.createElement('code')
    ex.className = 'cm-dsl-doc-example'
    ex.textContent = d.example
    root.append(ex)
  }
  return root
}

/** Several cards stacked, for a name that is more than one thing (`mul` is a
 *  Pattern method AND a Sig method). The theme rules the divider between them. */
export function renderDocBlocks(blocks: readonly DocBlock[]): HTMLElement {
  const root = document.createElement('div')
  root.className = 'cm-dsl-hover'
  for (const b of blocks) root.append(renderDocBlock(b))
  return root
}
