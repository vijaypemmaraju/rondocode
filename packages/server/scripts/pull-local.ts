/* ------------------------------------------------------------------------- *
 * pull-local — write the tune you are PLAYING back to its local example file.
 *
 * The loop was one-way. `render-local.ts` goes from a file to audio, and the
 * editor goes from a file to the screen, but nothing came back: edits made in
 * the browser lived in the project store and the file on disk quietly fell
 * behind. The only way back was to paste the buffer into a chat, which is
 * exactly how a whole round of work once landed on a stale copy of levels.ts.
 *
 *   pnpm pull-local levels          -> packages/app/src/examples/local/levels.ts
 *   pnpm pull-local levels --dry    -> print what would change, write nothing
 *
 * It reads `GET /doc` on the bridge, which answers with the EDITOR's text and
 * the language it is in. That is deliberately not `get_code`: that one returns
 * the session's evaluated JavaScript, and what you are editing may be rondo.
 *
 * WHY IT IS NOT A WEBSOCKET. The bridge hands the session to the newest
 * /session connection and closes the previous one, so a tool that dialled in
 * to ask what the tab was showing would disconnect the tab it was asking
 * about. Reading over HTTP cannot.
 * ------------------------------------------------------------------------- */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '../../rondo/src/index'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = join(HERE, '..', '..', 'app', 'src', 'examples', 'local')
const PORT = process.env.PORT ?? '6070'

interface Doc {
  text: string
  lang: 'rondo' | 'rondocode'
}

/**
 * Quote a source for a template literal.
 *
 * Three characters can end or escape out of one, and all three occur in real
 * tunes: a backslash in a comment, a backtick around an identifier in prose,
 * and `${` in anything. Missing any of them produces a file that either fails
 * to parse or, worse, silently interpolates. This bit twice before it lived in
 * one place.
 */
export const quoteForTemplate = (src: string): string =>
  src.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

/** The module text for an example, as the loader expects it (see
 *  examples/index.ts: `{ name, code, rondo? }`). */
export function exampleModule(name: string, doc: Doc, header: string): string {
  const js = doc.lang === 'rondo' ? compileOrThrow(doc.text) : doc.text
  const parts = [
    header,
    'export default {',
    `  name: ${JSON.stringify(`${name} (local)`)},`,
    `  code: \`${quoteForTemplate(js.trimEnd())}\n\`,`,
  ]
  // the rondo is the source of truth when there is one; the JS beside it is
  // GENERATED, so the two cannot drift into two different tunes
  if (doc.lang === 'rondo') parts.push(`  rondo: \`${quoteForTemplate(doc.text.trimEnd())}\n\`,`)
  parts.push('}', '')
  return parts.join('\n')
}

function compileOrThrow(rondo: string): string {
  const out = compile(rondo)
  if (!out.ok) {
    const first = out.errors[0]
    throw new Error(
      `the buffer does not compile, so nothing was written:\n  line ${first?.line}:${first?.col}  ${first?.message}`,
    )
  }
  return out.code
}

const HEADER = `/* LOCAL ONLY - gitignored, and a production build aliases the loader away.
 *
 * Pulled from the running editor with \`pnpm pull-local\`. Edit it in the app
 * and pull again; editing this file by hand works too, but the buffer in the
 * browser is the one that will overwrite it.
 */

`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const name = args.find((a) => !a.startsWith('-'))
  if (name === undefined) {
    console.error('usage: pnpm pull-local <name> [--dry]')
    process.exit(2)
  }

  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/doc`)
  } catch {
    console.error(
      `no bridge on port ${PORT}. Start one with \`pnpm bridge\` (or run the MCP server), `
      + 'then open the app so it has a session to read.',
    )
    process.exit(1)
  }
  if (res.status === 503) {
    console.error('the bridge is up but no browser session is connected: open or refresh the app.')
    process.exit(1)
  }
  if (!res.ok) {
    console.error(`bridge said ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  const doc = (await res.json()) as Doc
  if (typeof doc.text !== 'string' || doc.text.trim() === '') {
    console.error('the editor buffer is empty; refusing to overwrite a file with nothing.')
    process.exit(1)
  }

  const file = join(LOCAL_DIR, `${name}.ts`)
  const next = exampleModule(name, doc, HEADER)
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''

  if (prev === next) {
    console.log(`${name}: already identical (${doc.lang}, ${doc.text.length} chars)`)
    return
  }
  const verb = prev === '' ? 'create' : 'update'
  console.log(
    `${dry ? 'would ' : ''}${verb} ${file}\n`
    + `  language : ${doc.lang}\n`
    + `  buffer   : ${doc.text.length} chars\n`
    + `  on disk  : ${prev === '' ? '(new file)' : `${prev.length} chars`}`,
  )
  if (dry) return
  mkdirSync(LOCAL_DIR, { recursive: true })
  writeFileSync(file, next)
  console.log('written.')
}

// run only as a CLI; the exports above are what the tests drive
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
