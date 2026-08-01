import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { checkFixedPoint, genProgram, normalizedProgram, shrink, stillFailing } from './fuzzgen'

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

/* The fixed-point check compares programs with single-use `const`s folded in,
 * because the decompiler may now answer with a binding where the source had an
 * inline expression. That relaxation has to normalize NAMING and nothing else,
 * or the whole sweep goes quietly vacuous. */
describe('the fixed-point comparison is not vacuous', () => {
  const prog = (body: string): string =>
    `const s = synth(({ note, gate, saw, adsr }) => {\n${body}\n})\n`

  it('sees a binding and its inline form as the same program', () => {
    const inline = prog('  return saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 }))')
    const named = prog(
      '  const env = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 })\n' +
        '  return saw(note.freq).mul(env)',
    )
    expect(normalizedProgram(named)).toBe(normalizedProgram(inline))
  })

  it('still sees a CHANGED VALUE as a different program', () => {
    const a = prog('  const env = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 })\n  return saw(note.freq).mul(env)')
    const b = prog('  const env = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.3 })\n  return saw(note.freq).mul(env)')
    expect(normalizedProgram(a)).not.toBe(normalizedProgram(b))
  })

  it('still sees a DIFFERENT SHAPE as a different program', () => {
    const a = prog('  return saw(note.freq).mul(0.5).tanh()')
    const b = prog('  return saw(note.freq).tanh().mul(0.5)')
    expect(normalizedProgram(a)).not.toBe(normalizedProgram(b))
  })

  it('does not fold a binding used TWICE, so a shared signal stays shared', () => {
    // folding this one would turn one oscillator into two
    const shared = prog('  const o = saw(note.freq)\n  return o.mul(o)')
    const twice = prog('  return saw(note.freq).mul(saw(note.freq))')
    expect(normalizedProgram(shared)).not.toBe(normalizedProgram(twice))
  })

  it('scopes "used once" per function, not per file', () => {
    // two synths may each bind `amp`. Counted file-wide `amp` looks used four
    // times and NEITHER folds, so the pair stops matching its inline twin.
    const pair = (a: string, b: string): string =>
      `const s = synth(({ note, gate, saw, adsr }) => {\n${a}\n})\n\n` +
      `const t = synth(({ note, gate, saw, adsr }) => {\n${b}\n})\n`
    const named = pair(
      '  const amp = adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 })\n  return saw(note.freq).mul(amp)',
      '  const amp = adsr(gate, { a: 0.02, d: 0.2, s: 0.4, r: 0.3 })\n  return saw(note.freq).mul(amp)',
    )
    const inline = pair(
      '  return saw(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.5, r: 0.2 }))',
      '  return saw(note.freq).mul(adsr(gate, { a: 0.02, d: 0.2, s: 0.4, r: 0.3 }))',
    )
    expect(normalizedProgram(named)).toBe(normalizedProgram(inline))
  })
})
