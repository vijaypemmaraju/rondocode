import { describe, expect, it } from 'vitest'
import { BUILTINS } from '@rondocode/rondo'
import { PORTS } from '../../engine/src/compile'

/* ------------------------------------------------------------------------- *
 * A named arg declared `sig` PROMISES you can hand it a signal — an LFO, a
 * knob, an envelope. That promise is kept in one of two ways and no others:
 *
 *   the node declares the arg as a SIGNAL INPUT, so the kernel reads it once
 *     per sample (delay.mix, ladder.res, supersaw.detune)
 *   rondo compiles it away into a Sig-level operation that never reaches a
 *     kernel at all (reverb.mix becomes `x.mix(reverb(x), amount)`)
 *
 * If it is NEITHER, the value arrives in the kernel's construction config,
 * the `typeof c[k] === 'number'` guard there rejects the Sig object, and the
 * node silently falls back to its default. The program compiles, runs, makes
 * sound, and ignores you.
 *
 * That is not hypothetical — it is what `convolve.mix` and `pitchshift.mix`
 * both did on the day they shipped, because their registry rows were copied
 * from `reverb`/`delay` without checking which of the two mechanisms those
 * used. Measured at the time: `mix:(lfo .25 -> 0..1)` produced output
 * byte-identical to `mix:1`.
 *
 * It is the same bug class an earlier audit closed by hand
 * (exposed-but-silently-breaks-on-a-value-type). This asserts it instead.
 * ------------------------------------------------------------------------- */

/** Named args that keep the promise WITHOUT a kernel input, because rondo
 *  lowers them into a Sig operation. Each needs a reason, and the reason is
 *  checkable by reading the emitted JS. */
const LOWERED_BY_RONDO = new Map<string, string>([
  ['reverb.mix', 'emits x.mix(reverb(x, …), amount) — the kernel has no mix'],
])

describe('every named arg declared `sig` can really take a signal', () => {
  const declared: { node: string; arg: string }[] = []
  for (const [node, spec] of Object.entries(BUILTINS)) {
    for (const [arg, kind] of Object.entries(spec.named ?? {})) {
      if (kind === 'sig') declared.push({ node, arg })
    }
  }

  it('finds some — an empty list would pass every case below', () => {
    expect(declared.length).toBeGreaterThan(10)
  })

  for (const { node, arg } of declared) {
    it(`${node}.${arg}`, () => {
      const key = `${node}.${arg}`
      const lowered = LOWERED_BY_RONDO.get(key)
      if (lowered !== undefined) {
        expect(lowered.length, `${key}: an exemption needs a reason`).toBeGreaterThan(20)
        return
      }
      const inputs = PORTS[node as keyof typeof PORTS]
      expect(inputs, `${node} declares '${arg}' as a signal but has no engine node`).toBeDefined()
      const names = inputs!.map((i) => i.name)
      // rondo is lowercase-only, so a camelCase port is reached through an
      // alias (`warpamt` -> `warpAmt`); resolve it before deciding
      const port = BUILTINS[node]?.alias?.[arg] ?? arg
      expect(
        names.includes(port),
        `${key} is declared \`sig\` in the rondo registry, but '${arg}' is not a signal `
          + `input of the '${node}' node — it will arrive as construction config, fail the `
          + `typeof number guard, and silently fall back to the default. Either make it an `
          + `input, declare it \`num\`, or add it to LOWERED_BY_RONDO with the reason.`,
      ).toBe(true)
    })
  }
})

describe('the exemption list cannot rot', () => {
  it('every exempted arg is still declared sig somewhere', () => {
    // an exemption for an arg that no longer exists is a comment pretending
    // to be a check
    for (const key of LOWERED_BY_RONDO.keys()) {
      const [node, arg] = key.split('.') as [string, string]
      expect(BUILTINS[node]?.named?.[arg], `${key} is exempted but no longer declared sig`).toBe('sig')
    }
  })

  it('and is genuinely NOT an engine input, or the exemption is pointless', () => {
    for (const key of LOWERED_BY_RONDO.keys()) {
      const [node, arg] = key.split('.') as [string, string]
      const names = (PORTS[node as keyof typeof PORTS] ?? []).map((i) => i.name)
      const port = BUILTINS[node]?.alias?.[arg] ?? arg
      expect(names.includes(port), `${key} IS an engine input — drop the exemption`).toBe(false)
    }
  })
})
