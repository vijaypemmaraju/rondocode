import { describe, expect, it } from 'vitest'
import { bufferBelongsTo } from '../src/editor/library'

/* Two tabs, two projects, one shared localStorage buffer.
 *
 * Both `rondocode-doc` (the editor buffer) and `rondocode-active-project` are
 * SINGLE keys, so a second tab overwrites the first's. Each tab still autosaves
 * to its own project id, so live editing is safe — the damage happens at boot,
 * where the library reconciles "the buffer is the freshest copy of the active
 * project" and writes it in. If the buffer came from the OTHER tab, that
 * overwrites one project with another's code.
 *
 * This is the guard on that write. It fails CLOSED: a missed reconcile costs
 * the last few keystrokes, a wrong one costs a whole project. */

describe('bufferBelongsTo', () => {
  it('reconciles when the buffer is known to be this project’s', () => {
    expect(bufferBelongsTo('p1', 'p1')).toBe(true)
  })

  it('REFUSES when the buffer belongs to another project — the whole bug', () => {
    expect(bufferBelongsTo('p2', 'p1')).toBe(false)
  })

  it('allows an unknown owner, for a legacy profile predating the key', () => {
    // one tab, one project, no owner ever recorded: reconciling is correct and
    // is what preserves unsaved work on upgrade
    expect(bufferBelongsTo(null, 'p1')).toBe(true)
  })

  it('stops allowing it the moment any owner is recorded', () => {
    // once a tab has claimed the buffer, "unknown" is no longer a possibility
    // we can be relaxed about
    expect(bufferBelongsTo('', 'p1')).toBe(false)
  })

  it('is exact, not prefix or case insensitive', () => {
    expect(bufferBelongsTo('p1', 'p10')).toBe(false)
    expect(bufferBelongsTo('P1', 'p1')).toBe(false)
  })
})

describe('the guard is actually wired to the dangerous write', () => {
  it('the boot reconcile is behind it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../src/editor/library.ts'), 'utf8')
    // comments may sit between the guard and the call; what must hold is that
    // the write is INSIDE the guard and nothing else is
    expect(src).toMatch(/if \(bufferBelongsTo\(readDocOwner\(\), active\.id\)\) \{(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*const r = await store\.saveCode\(active\.id, bootCode\)/)
  })

  it('switching projects claims the buffer for the new one', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const src = readFileSync(join(__dirname, '../src/editor/library.ts'), 'utf8')
    // otherwise the owner goes stale and a correct reconcile gets refused
    expect(src).toMatch(/setActiveId\(p\.id\)\s*\n\s*writeDocOwner\(p\.id\)/)
  })
})
