import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { compile } from '../src/compile'
// Deep source imports across packages are the established pattern here (see
// packages/server/src/render-runner.ts). Vitest/Vite resolve the raw TS.
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'

const acid = readFileSync(fileURLToPath(new URL('../examples/acid.rondo', import.meta.url)), 'utf8')
const pad = readFileSync(fileURLToPath(new URL('../examples/pad.rondo', import.meta.url)), 'utf8')

describe('rondo end-to-end: source → transpile → evalCode → sound', () => {
  it('the acid example compiles and evals clean with no error diagnostics', () => {
    const c = compile(acid)
    expect(c.ok, JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.synths.has('acid')).toBe(true)
    expect(result.patterns.has('acid')).toBe(true)
    expect(result.cps).toBe(0.6)
  })

  it('the compiled pattern produces sounding events (numeric note + routed sound)', () => {
    const c = compile(acid)
    if (!c.ok) throw new Error(JSON.stringify(c.errors))
    const result = evalCode(c.code, baseScope)
    const pat = result.patterns.get('acid')!
    const sounding = pat
      .query(new TimeSpan(F(0), F(2)))
      .filter(hasOnset)
      .filter((h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string')
    expect(sounding.length).toBeGreaterThan(0)
    for (const h of sounding) expect(result.synths.has(h.value.sound as string)).toBe(true)
  })

  it('the pad example (post chain + drivable post param) evals clean', () => {
    const c = compile(pad)
    expect(c.ok, JSON.stringify(c.errors)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    // a .ctrl('wet') driving a POST param('wet') is exactly the interaction the
    // API audit made valid — it must eval with no error diagnostics
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.synths.get('pad')?.post).toBeDefined()
  })
})
