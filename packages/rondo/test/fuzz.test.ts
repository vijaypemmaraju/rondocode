import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
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

  it('the shrinker minimizes a planted failure to a strictly smaller, still-failing repro', () => {
    // a multi-block program where exactly ONE line carries the planted
    // "failure" (the tanh transform). The predicate mirrors stillFailing's
    // shape: the candidate must still COMPILE and still exhibit the failure —
    // so the shrinker may only cut what is genuinely irrelevant.
    const victim = [
      'synth padx',
      '  saw',
      '  * en2',
      '  tanh',
      '  en2 = adsr .01 .1 .5 .1',
      '',
      'play padx',
      '  0 3 5',
      '  scale: c-maj',
      '',
      'cps .5',
      '',
    ].join('\n')
    const pred = (s: string): boolean => compile(s).ok && s.includes('tanh')
    expect(pred(victim)).toBe(true)
    const small = shrink(victim, pred)
    // strictly smaller, still failing — and the unrelated blocks are gone
    expect(pred(small)).toBe(true)
    expect(small.length).toBeLessThan(victim.length)
    expect(small).toContain('tanh')
    expect(small).not.toContain('play')
    expect(small).not.toContain('cps')
    expect(small).not.toContain('adsr') // the now-unused binding got cut too
  })
})
