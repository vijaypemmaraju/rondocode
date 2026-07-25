import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Pins the app's code-splitting boundaries by walking the STATIC import graph
 * from each HTML entry, the way Rollup does. Two invariants:
 *
 *   1. The neural sing stack (onnxruntime-web + phonemizer + the sing/ render
 *      internals) is never in the eager graph of either page — it may only be
 *      reached through singMgr's `await import('./neural')`, so its ~1.7 MB
 *      chunk downloads when a sing() bake actually starts, not on page load.
 *      (sing/singMgr.ts, sing/config.ts and sing/warp.ts are the deliberate
 *      light half of that boundary and ARE allowed eagerly.)
 *
 *   2. The docs page ("no editor, no audio until the first ▶") never eagerly
 *      pulls the preview player side: docs/player.ts, the audio engine, the
 *      WebGPU renderer and the sing UI all arrive via docs.ts's loadPlayer()
 *      dynamic import on the first play.
 *
 * A static import added anywhere along those paths silently drags the heavy
 * chunks back into every page load — this test is what fails instead. */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const PACKAGES = resolve(SRC, '../..')

/** Match static imports/re-exports at line starts; `import type` /
 *  `export type` don't survive to the bundle and are skipped via group 1.
 *  Dynamic `import()` never matches — which is the point. */
const STATIC_IMPORT_RES = [
  /^[ \t]*import\s+(type\s)?[^'"]*?from\s*['"]([^'"]+)['"]/gm, // import x from '...'
  /^[ \t]*import\s*()['"]([^'"]+)['"]/gm, // import '...' (side-effect)
  /^[ \t]*export\s+(type\s)?(?:\*[^'"]*?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/gm, // export ... from '...'
]

/** Resolve one specifier from `fromDir` to an absolute .ts path, a bare
 *  package name (kept as-is, prefixed 'pkg:'), or null for non-code assets. */
function resolveSpec(fromDir: string, spec: string): string | null {
  if (spec.includes('?')) return null // ?worker&url etc. — separate bundles, not this graph
  if (spec.endsWith('.css')) return null
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = resolve(fromDir, spec)
    for (const cand of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
      if (cand.endsWith('.ts') || cand.endsWith('.tsx')) {
        if (existsSync(cand)) return cand
      }
    }
    throw new Error(`eager-graph walker: cannot resolve '${spec}' from ${fromDir}`)
  }
  // workspace packages get walked too (their sources are right here);
  // everything else (node_modules) is a leaf recorded by name.
  const ws = /^@rondocode\/([^/]+)$/.exec(spec)
  if (ws) {
    const entry = resolve(PACKAGES, ws[1]!, 'src/index.ts')
    if (existsSync(entry)) return entry
  }
  return `pkg:${spec}`
}

/** The full static-import closure of `entry`: absolute .ts paths plus
 *  'pkg:<name>' leaves for third-party imports. */
function eagerClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [resolve(SRC, entry)]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || file.startsWith('pkg:')) {
      seen.add(file)
      continue
    }
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const re of STATIC_IMPORT_RES) {
      re.lastIndex = 0
      for (let m = re.exec(source); m !== null; m = re.exec(source)) {
        if (m[1] !== undefined) continue // import type / export type
        const dep = resolveSpec(dirname(file), m[2]!)
        if (dep !== null && !seen.has(dep)) queue.push(dep)
      }
    }
  }
  return seen
}

const has = (closure: Set<string>, rel: string): boolean =>
  rel.startsWith('pkg:') ? closure.has(rel) : closure.has(resolve(SRC, rel))

/** The neural stack: only ever reachable through singMgr's dynamic import. */
const NEURAL_STACK = [
  'pkg:onnxruntime-web',
  'pkg:phonemizer',
  'sing/neural.ts',
  'sing/supertonic.ts',
  'sing/phonemes.ts',
  'sing/rvc.ts',
  'sing/psola.ts',
  'sing/segment.ts',
  'sing/forcedalign.ts',
  'sing/lyrics.ts',
  'sing/modelcache.ts',
  'sing/g2p.ts',
  'sing/devhook.ts',
]

describe('eager import graph (code-splitting boundaries)', () => {
  const main = eagerClosure('main.ts')
  const docs = eagerClosure('docs.ts')

  it('walks the real graph (sanity)', () => {
    // If the walker broke, these would vanish and the negative assertions
    // below would pass vacuously.
    expect(has(main, 'editor/editor.ts')).toBe(true)
    expect(has(main, 'sing/singMgr.ts')).toBe(true) // the light half of the boundary
    expect(has(docs, 'docs/doceditor.ts')).toBe(true)
    expect(has(docs, 'session/share.ts')).toBe(true)
  })

  it('editor page never eagerly reaches the neural sing stack', () => {
    for (const mod of NEURAL_STACK) expect(has(main, mod), `${mod} leaked into main's eager graph`).toBe(false)
  })

  it('docs page never eagerly reaches the neural sing stack', () => {
    for (const mod of NEURAL_STACK) expect(has(docs, mod), `${mod} leaked into docs' eager graph`).toBe(false)
  })

  it('docs page loads the preview player + audio engine only on demand', () => {
    for (const mod of [
      'docs/player.ts',
      'audio/AudioSession.ts',
      'session/index.ts',
      'session/evalCode.ts',
      'shaderviz/renderer.ts',
      'ui/singDialog.ts',
      'sing/singMgr.ts',
    ]) {
      expect(has(docs, mod), `${mod} leaked into docs' eager graph`).toBe(false)
    }
    // the audio engine (workspace package, walked by source path)
    expect(docs.has(resolve(PACKAGES, 'engine/src/index.ts')), "@rondocode/engine leaked into docs' eager graph").toBe(
      false,
    )
  })
})
