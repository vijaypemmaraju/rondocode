import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHIPPED_EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * The repo's MARKDOWN has no tests, and an audit found it asserting things
 * that had quietly stopped being true:
 *
 *   - README told you to render `"veldt (full)"`, an example deleted long
 *     enough ago that it only exists in git history. Copy-pasting the one
 *     command in that section failed.
 *   - the MCP examples resource announced "Five complete, known-working
 *     programs" while serving 29 of them, and the agent guide repeated it.
 *
 * Both are the same shape: prose stating a fact about code, with nothing
 * checking it. These are the claims a machine can verify — example names and
 * commands. Prose about BEHAVIOUR still needs a human, which is why the audit
 * is worth repeating rather than replacing with this file.
 * ------------------------------------------------------------------------- */

const ROOT = join(__dirname, '../../..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const MARKDOWN = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/perf-frames.md',
  'docs/reference/agent-guide.md',
  'docs/sing-models.md',
  'packages/desktop/README.md',
  'packages/dsp-rs/README.md',
]

describe('the markdown does not name things that stopped existing', () => {
  it('finds the docs (a broken path list would make this vacuous)', () => {
    for (const m of MARKDOWN) expect(existsSync(join(ROOT, m)), m).toBe(true)
  })

  it('every example named in a render command actually ships', () => {
    const names = new Set(SHIPPED_EXAMPLES.map((e) => e.name))
    const bad: string[] = []
    for (const doc of MARKDOWN) {
      // `render-example.ts "name" <cycles> <out>` — the quoted argument
      for (const m of read(doc).matchAll(/render-example\.ts\s+"([^"]+)"/g)) {
        if (!names.has(m[1]!)) bad.push(`${doc}: "${m[1]}"`)
      }
    }
    expect(bad, `render commands naming examples that do not exist: ${bad.join(', ')}`).toEqual([])
  })

  it('every repo path in backticks exists', () => {
    const bad: string[] = []
    for (const doc of MARKDOWN) {
      for (const m of read(doc).matchAll(/`([a-zA-Z0-9_@./-]*(?:packages|scripts|docs)\/[a-zA-Z0-9_./-]+)`/g)) {
        // Directories count: existsSync resolves them, and skipping anything
        // ending in '/' was a blind spot — a renamed directory sailed through.
        const rel = m[1]!.replace(/^\.\//, '').replace(/\/$/, '')
        if (!existsSync(join(ROOT, rel))) bad.push(`${doc}: ${rel}`)
      }
    }
    expect(bad, `paths named in docs that do not exist: ${bad.join(', ')}`).toEqual([])
  })

  it('every pnpm script the docs tell you to run is declared', () => {
    const scripts = (rel: string): Set<string> =>
      new Set(Object.keys((JSON.parse(read(rel)) as { scripts?: Record<string, string> }).scripts ?? {}))
    const root = scripts('package.json')
    /** Only FENCED lines are commands. The first version scanned the whole
     *  file and flagged the README's prose "pnpm workspace, TypeScript
     *  throughout" as a missing script. */
    const fenced = (src: string): string =>
      [...src.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!).join('\n')
    const bad: string[] = []
    for (const doc of MARKDOWN) {
      for (const m of fenced(read(doc)).matchAll(/^\s*pnpm\s+(?!--filter|dlx|install|tsx|exec|add|-)([a-z:-]+)/gm)) {
        if (!root.has(m[1]!)) bad.push(`${doc}: pnpm ${m[1]}`)
      }
    }
    expect(bad, `documented scripts that do not exist: ${bad.join(', ')}`).toEqual([])
  })
})
