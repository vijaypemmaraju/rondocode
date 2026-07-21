/* ------------------------------------------------------------------------- *
 * docs-gen: pure DocEntry[] → markdown for the MCP `rondocode://docs/*`
 * resources. The data source of truth lives in the app package
 * (packages/app/src/docs/dsl-docs.ts, coverage-pinned against the live
 * objects there); this module only formats it, so the reference an agent
 * reads over MCP can never drift from what the editor's tooltips show.
 *
 * Markdown safety: signatures and examples are real rondocode and may
 * contain backticks (the m`...` tagged template). Inline code uses a
 * CommonMark code span whose delimiter is one backtick longer than the
 * longest run inside the content, space-padded when the content starts or
 * ends with a backtick — never a naive `${'`'}${s}${'`'}`.
 * ------------------------------------------------------------------------- */

// Deep import from the app package source (read-only). Relative path on
// purpose: @rondocode/app has no exports map for deep specifiers, and this
// file needs only the pure data module (no DOM, no deps).
import type { DocEntry } from '../../app/src/docs/dsl-docs'
import type { Example } from '../../app/src/examples/index'

/** Wrap `s` in a CommonMark inline code span that survives any backticks
 *  inside it (delimiter = longest internal backtick run + 1, space padding
 *  when the content itself starts/ends with a backtick). */
export const codeSpan = (s: string): string => {
  const runs = s.match(/`+/g)
  const delim = '`'.repeat(runs === null ? 1 : Math.max(...runs.map((r) => r.length)) + 1)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${delim}${pad}${s}${pad}${delim}`
}

/** A ``` fence that cannot be terminated early by the body (grows past the
 *  longest backtick run in it). */
const fenceFor = (body: string): string => {
  const runs = body.match(/`+/g)
  const n = runs === null ? 0 : Math.max(...runs.map((r) => r.length))
  return '`'.repeat(Math.max(3, n + 1))
}

/** Section order + headings for the generated reference, one per DocEntry
 *  kind. The blurb tells an agent what the section's names are FOR. */
const SECTIONS: { kind: DocEntry['kind']; heading: string; blurb: string }[] = [
  {
    kind: 'global',
    heading: 'Globals',
    blurb:
      'Names available at the top level of every eval: pattern constructors, signal generators, editor widgets, and the per-eval registration calls (p, defineSynth, setCps).',
  },
  {
    kind: 'pattern-method',
    heading: 'Pattern methods',
    blurb:
      'Chainable methods on every Pattern — time manipulation, arithmetic, structure, randomness, layering, and the control methods (.sound, .gain, .ctrl, …) that turn values into playable events.',
  },
  {
    kind: 'synth-ctx',
    heading: 'Synth building',
    blurb:
      'Members of the context object passed to synth(build): oscillators, filters, envelopes and per-voice inputs (note, gate, velocity) you wire into a DSP graph. The build function returns the voice output Sig.',
  },
  {
    kind: 'sig-method',
    heading: 'Signal math',
    blurb:
      'Methods on Sig (the audio-graph value inside synth()): arithmetic, shaping and range mapping for combining oscillators, envelopes and params.',
  },
  {
    kind: 'mini-syntax',
    heading: 'Mini-notation',
    blurb:
      "Operators inside pattern strings like n('0 3 [5 7]') — the compact rhythm/melody language used by n(), note(), sound() and mini().",
  },
]

const renderEntry = (e: DocEntry): string => {
  const head = `- **${e.name}** — ${codeSpan(e.signature)}\n  ${e.summary}`
  return e.example === undefined ? head : `${head}\n  e.g. ${codeSpan(e.example)}`
}

/**
 * Render the full DSL reference as markdown, grouped by kind in SECTIONS
 * order. Entries keep their input order within a section (the data file
 * already clusters related names). Unknown kinds would be silently dropped —
 * SECTIONS covers the DocEntry union, and the type keeps it that way.
 */
export function dslReferenceMarkdown(entries: DocEntry[]): string {
  const parts: string[] = [
    '# rondocode DSL reference',
    '',
    'Every name in the rondocode surface: signature, what it does musically, and a one-line example. Generated from the live documentation data (the same source as editor completions), so it matches the running app exactly.',
    '',
  ]
  for (const section of SECTIONS) {
    const of = entries.filter((e) => e.kind === section.kind)
    if (of.length === 0) continue
    parts.push(`## ${section.heading}`, '', section.blurb, '')
    for (const e of of) parts.push(renderEntry(e), '')
  }
  return parts.join('\n')
}

/**
 * Render the shipped examples as markdown: name, a one-line description
 * (the first comment line of the source, `//` stripped), and the full code
 * in a fenced block. These are known-good programs — each evals clean and
 * makes sound — so they double as templates for eval_code.
 */
export function examplesMarkdown(examples: Example[]): string {
  const parts: string[] = [
    '# rondocode examples',
    '',
    'Five complete, known-working programs (each one evals clean and plays). Use them as starting points for eval_code: send one verbatim to hear it, then edit.',
    '',
  ]
  for (const ex of examples) {
    const firstLine = ex.code.split('\n', 1)[0] ?? ''
    const description = firstLine.replace(/^\/\/\s*/, '')
    const fence = fenceFor(ex.code)
    parts.push(`## ${ex.name}`, '', description, '', `${fence}js`, ex.code.trimEnd(), fence, '')
  }
  return parts.join('\n')
}
