import { describe, expect, it } from 'vitest'
import { compile, decompile } from '@rondocode/rondo'
import { RECIPES } from '../src/docs/cookbook'
import { SHIPPED_EXAMPLES } from '../src/examples'

/* ------------------------------------------------------------------------- *
 * Every shipped program survives rondo -> JavaScript -> rondo, with NO ESCAPE
 * HATCH.
 *
 * The existing decompile tests pin the fixed point: the JS you get back
 * matches. They are satisfied by a `js{ … }` blob, which round-trips
 * perfectly while being exactly the thing the language exists to avoid --
 * open a program in the other language and find a wall of JavaScript where the
 * music was.
 *
 * Found by this test: a section holding BOTH a `play` and a `beat` fell out
 * whole. Either kind alone was fine, which is what hid it. `reverse cymbal`
 * and `buildup + drop` each lost three blocks that way.
 * ------------------------------------------------------------------------- */

interface Prog { label: string; rondo: string }
const programs: Prog[] = [
  ...RECIPES.map((r) => ({ label: `recipe:${r.id}`, rondo: r.code })),
  /* SHIPPED, not EXAMPLES: `./local/` is gitignored working material, so
   * including it would fail on the author's machine and pass in CI -- the
   * worst way round. */
  ...SHIPPED_EXAMPLES.filter((e) => e.rondo !== undefined).map((e) => ({ label: `example:${e.name}`, rondo: e.rondo! })),
]

/** A `js` block or an inline `js{ … }` in decompiled rondo. */
const escapeHatches = (rondo: string): string[] =>
  rondo.split('\n').filter((l) => /^js$/.test(l.trim()) || /js\{/.test(l))

describe('rondo -> js -> rondo', () => {
  it('has a real corpus, since an empty one would pass', () => {
    expect(programs.length).toBeGreaterThan(60)
  })

  describe.each(programs.map((p) => [p.label, p] as const))('%s', (_label, p) => {
    it('comes back as rondo, with no js escape hatch', () => {
      const a = compile(p.rondo)
      expect(a.ok, a.ok ? '' : JSON.stringify(a.errors)).toBe(true)
      if (!a.ok) return
      const back = decompile(a.code)
      const hatches = escapeHatches(back)
      expect(hatches, `fell out to JavaScript:\n${hatches.join('\n')}`).toEqual([])
    })

    it('and means the same thing', () => {
      const a = compile(p.rondo)
      if (!a.ok) return
      const b = compile(decompile(a.code))
      expect(b.ok, b.ok ? '' : JSON.stringify(b.errors)).toBe(true)
      if (!b.ok) return
      expect(b.code.replace(/\s+/g, ' ').trim()).toBe(a.code.replace(/\s+/g, ' ').trim())
    })
  })
})
