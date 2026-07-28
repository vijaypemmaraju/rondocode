import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLocalExamples } from '../src/examples/local-loader.prod'

/* Private examples leaked into a production bundle once, and the way it
 * happened is worth pinning precisely: `import.meta.glob(..., { eager: true })`
 * is rewritten into STATIC IMPORTS at build time, so every file in
 * src/examples/local/ was bundled even though nothing in the UI listed it.
 *
 * That means a runtime `if (import.meta.env.DEV)` guard is NOT a fix — it hides
 * the examples while still shipping their source. Only refusing to resolve the
 * module keeps them out, which is what the production alias does. */

const root = join(__dirname, '..')

describe('the production stand-in', () => {
  it('returns nothing, so a release lists no private examples', () => {
    expect(loadLocalExamples()).toEqual([])
  })

  it('contains no glob and no import of ./local — the whole point of it', () => {
    const raw = readFileSync(join(root, 'src/examples/local-loader.prod.ts'), 'utf8')
    // comments may DISCUSS ./local; only executable code matters here
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toContain('import.meta.glob')
    expect(code).not.toContain('./local')
  })
})

describe('the build excludes the real loader', () => {
  const cfg = readFileSync(join(root, 'vite.config.ts'), 'utf8')

  it('aliases local-loader away in a production build', () => {
    expect(cfg).toContain("mode === 'production'")
    expect(cfg).toContain('local-loader.prod.ts')
  })

  it('keeps the alias OFF in development, where local examples are the point', () => {
    // the ternary's other arm must be empty, not another alias
    expect(cfg).toMatch(/mode === 'production'[\s\S]{0,200}:\s*\[\]/)
  })
})

describe('the glob still lives in exactly one module', () => {
  it('only local-loader.ts globs ./local, so there is one thing to alias', () => {
    // a second glob elsewhere would silently reopen the hole
    const files = ['src/examples/index.ts', 'src/examples/local-loader.ts']
    const withGlob = files.filter((f) => readFileSync(join(root, f), 'utf8').includes("glob('./local"))
    expect(withGlob).toEqual(['src/examples/local-loader.ts'])
  })
})
