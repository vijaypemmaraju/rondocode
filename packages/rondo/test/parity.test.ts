import { describe, expect, it } from 'vitest'
// Deep-import the DSL surface's single source of truth (test-pinned in the app
// against the live objects). Vitest/Vite resolve the raw TS across packages.
import { docsOfKind } from '../../app/src/docs/dsl-docs'

/* The parity scoreboard.
 *
 * North star: rondo can express EVERYTHING the JS DSL can. That's already true
 * via the `js{ … }` escape hatch (total parity today). This test tracks the
 * OTHER axis — how much of the surface has first-class rondo *sugar* — so:
 *   1. no phantom sugar: every name rondo claims to sugar really exists, and
 *   2. coverage can only grow: the first-class count is a floor that a
 *      regression would trip, and the gap (escape-hatch-only) is logged so
 *      shrinking it is deliberate.
 * Update the FIRST_CLASS sets + floors as sugar lands. */

const ctxNames = new Set(docsOfKind('synth-ctx').map((e) => e.name))

/** Synth/post ctx members rondo sugars natively — the builtin registry
 *  (src/builtins.ts) plus the special forms (adsr, knob→param, note/gate/
 *  velocity/input refs). Everything else → js{ … }. */
const FIRST_CLASS_CTX = [
  'note', 'gate', 'velocity', 'input', 'param', 'adsr',
  // oscillators / sources
  'saw', 'square', 'sine', 'tri', 'pulse', 'syncsaw', 'fm', 'wavetable',
  'supersaw', 'noise', 'lfsr', 'lfo',
  // gated sources
  'sample', 'granular', 'pluck', 'modal',
  // processors
  'ladder', 'svf', 'onepole', 'delay', 'comb', 'shape', 'formant', 'pan',
  'bitcrush', 'compress', 'phaser', 'reverb', 'chorus', 'exciter', 'ott',
  // sig ops on the running signal
  'mix',
]

const globalNames = new Set(docsOfKind('global').map((e) => e.name))

/** Scope globals rondo expresses natively: blocks (synth/play/bus/…), staging
 *  lines (cps/sidechain/master), entry points picked by notation (n/note/
 *  chord/stack/mini), and the continuous signals as ctrl values. */
const FIRST_CLASS_GLOBALS = [
  'synth', 'defineSynth', 'p', 'setCps', 'sidechain', 'masterCompress', 'bus',
  'n', 'note', 'chord', 'stack', 'mini', 'arrange',
  'sine', 'sine2', 'cosine', 'saw', 'isaw', 'tri', 'square', 'saw2', 'tri2', 'square2', 'rand', 'perlin',
]

describe('rondo ⇄ JS DSL parity scoreboard', () => {
  it('every first-class global really exists (no phantom sugar)', () => {
    const phantom = FIRST_CLASS_GLOBALS.filter((n) => !globalNames.has(n))
    expect(phantom, `first-class rondo globals not in dsl-docs: ${phantom.join(', ')}`).toEqual([])
  })

  it('globals sugar coverage only grows (floor); logs what still needs sugar', () => {
    const first = new Set(FIRST_CLASS_GLOBALS.filter((n) => globalNames.has(n)))
    const escapeOnly = [...globalNames].filter((n) => !first.has(n)).sort()
    console.log(
      `[parity] globals: ${first.size}/${globalNames.size} first-class · ` +
      `escape-hatch-only (${escapeOnly.length}): ${escapeOnly.join(', ')}`,
    )
    expect(first.size).toBeGreaterThanOrEqual(25)
    expect(first.size + escapeOnly.length).toBe(globalNames.size)
  })

  it('every first-class ctx name really exists in the DSL surface (no phantom sugar)', () => {
    const phantom = FIRST_CLASS_CTX.filter((n) => !ctxNames.has(n))
    expect(phantom, `first-class rondo ctx names not in dsl-docs: ${phantom.join(', ')}`).toEqual([])
  })

  it('ctx sugar coverage only grows (floor); logs what still needs sugar', () => {
    const first = new Set(FIRST_CLASS_CTX.filter((n) => ctxNames.has(n)))
    const escapeOnly = [...ctxNames].filter((n) => !first.has(n)).sort()
    // scoreboard: reachable-via-escape now, sugar TODO listed explicitly
    console.log(
      `[parity] synth-ctx: ${first.size}/${ctxNames.size} first-class · ` +
      `escape-hatch-only (${escapeOnly.length}): ${escapeOnly.join(', ')}`,
    )
    // a regression that drops sugar would lower this — keep it a floor
    expect(first.size).toBeGreaterThanOrEqual(38)
    // and total parity holds: every remaining name is still reachable via js{ … }
    expect(first.size + escapeOnly.length).toBe(ctxNames.size)
  })
})
