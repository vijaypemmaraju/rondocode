import { describe, expect, it } from 'vitest'
import { checkFixedPoint, genProgram, shrink, stillFailing } from './fuzzgen'

/* Decompiler fuzzing: N seeded random programs, each held to the round-trip
 * contract (compile → decompile → compile is byte-identical JS). Failures
 * shrink to a minimal repro before reporting. Deterministic: a green run at
 * seed range [1, N] stays green forever.
 *
 * RONDO_FUZZ_N=5000 npx vitest run packages/rondo/test/fuzz.test.ts
 * for a longer sweep (or use packages/rondo/scripts/fuzz.ts). */

const N = Number(process.env['RONDO_FUZZ_N'] ?? 400)

describe('decompile fuzz', () => {
  it(`fixed point holds for ${N} generated programs`, () => {
    for (let seed = 1; seed <= N; seed++) {
      const src = genProgram(seed)
      const fail = checkFixedPoint(src)
      if (fail === null) continue
      // a generated program must COMPILE — a gen-compile failure is a
      // generator/compiler drift bug and reports the raw source instead
      const small = fail.kind === 'gen-compile' ? src : shrink(src, stillFailing)
      const finalFail = fail.kind === 'gen-compile' ? fail : checkFixedPoint(small)
      expect.fail(
        `seed ${seed}: ${fail.kind}\n` +
          `--- ${fail.kind === 'gen-compile' ? 'generated (does not compile)' : 'shrunk repro'} ---\n${small}\n` +
          `--- detail ---\n${JSON.stringify(finalFail, null, 2)}`,
      )
    }
  })

  it('the generator is deterministic (same seed, same program)', () => {
    expect(genProgram(7)).toBe(genProgram(7))
    expect(genProgram(7)).not.toBe(genProgram(8))
  })

  it('the shrinker preserves the failure property it is given', () => {
    // synthetic "failure": any program mentioning tanh. The shrunk result
    // must still mention it and still be smaller-or-equal.
    let victim = ''
    for (let seed = 1; seed < 200; seed++) {
      const s = genProgram(seed)
      if (s.includes('tanh')) {
        victim = s
        break
      }
    }
    expect(victim).not.toBe('')
    const pred = (s: string): boolean => s.includes('tanh')
    const small = shrink(victim, pred)
    expect(small.includes('tanh')).toBe(true)
    expect(small.length).toBeLessThanOrEqual(victim.length)
  })
})
