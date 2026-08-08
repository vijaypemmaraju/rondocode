/* THE MUTATIONS — one plausible bug per entry.
 *
 * Each is a change a tired person could actually make: a default that drifts,
 * a sign that flips, an arg that stops being read. `tests` names only the
 * files that are supposed to catch it, which is what keeps a full pass in
 * seconds instead of minutes.
 *
 * A mutation that SURVIVES is the finding: the contract in that test's title
 * is not being asserted. Add one whenever you add a feature — the mutation is
 * the proof that the feature's test works, and it costs one line.
 *
 * Keep `find` unique within its file. The runner refuses to guess.
 */

export interface Mutation {
  /** what the bug WOULD be, phrased as the damage — this is the report line. */
  label: string
  /** repo-relative source file. */
  file: string
  /** exact text to replace (must appear at least once). */
  find: string
  /** what to put there. */
  replace: string
  /** the test files that should catch it, space separated. */
  tests: string
}

export const MUTATIONS: Mutation[] = [
  /* ---- chords: data where a mistake is SILENT ---------------------------- */
  {
    label: 'chord: add2 loses its second',
    file: 'packages/pattern/src/chords.ts',
    find: "'2': [0, 2, 4, 7]",
    replace: "'2': [0, 4, 7]",
    tests: 'packages/pattern/test/chords.test.ts',
  },
  {
    label: 'chord: dim7 flattens to a plain diminished triad',
    file: 'packages/pattern/src/chords.ts',
    find: 'dim7: [0, 3, 6, 9]',
    replace: 'dim7: [0, 3, 6]',
    tests: 'packages/pattern/test/chords.test.ts',
  },
  {
    label: 'chord: m13 loses its ninth',
    file: 'packages/pattern/src/chords.ts',
    find: 'm13: [0, 3, 7, 10, 14, 21]',
    replace: 'm13: [0, 3, 7, 10, 21]',
    tests: 'packages/pattern/test/chords.test.ts',
  },
  {
    label: 'chord: the M alias drifts a semitone off maj',
    file: 'packages/pattern/src/chords.ts',
    find: 'M: [0, 4, 7]',
    replace: 'M: [0, 4, 8]',
    tests: 'packages/pattern/test/chords.test.ts',
  },

  /* ---- the compressor curve, which must not lie -------------------------- */
  {
    label: 'comp: the knee is ignored (every curve corners)',
    file: 'packages/app/src/editor/rondo/compcurve.ts',
    find: 'const knee = Math.max(0, s.knee)',
    replace: 'const knee = 0',
    tests: 'packages/app/test/compcurve.test.ts',
  },
  {
    label: 'comp: the ratio is inverted (it expands instead of compressing)',
    file: 'packages/app/src/editor/rondo/compcurve.ts',
    find: 'out = s.threshold + over / ratio',
    replace: 'out = s.threshold + over * ratio',
    tests: 'packages/app/test/compcurve.test.ts',
  },
  {
    label: 'comp: makeup leaks into the reported gain reduction',
    file: 'packages/app/src/editor/rondo/compcurve.ts',
    find: 'db + s.makeup - compResponse(db, s)',
    replace: 'db - compResponse(db, s)',
    tests: 'packages/app/test/compcurve.test.ts',
  },
  {
    label: 'comp: a `compress` line forgets which synth encloses it',
    file: 'packages/app/src/editor/rondo/compcurve.ts',
    find: "if (m[1] === 'compress' && synth !== undefined) scan.synth = synth",
    replace: '',
    tests: 'packages/app/test/compcurve.test.ts',
  },

  /* ---- the sidechain duck ------------------------------------------------ */
  {
    label: 'duck: recovery goes linear (a fade, not a pump)',
    file: 'packages/app/src/editor/rondo/duckcurve.ts',
    find: 'return 1 - d * Math.exp(-t / (release / 3))',
    replace: 'return 1 - d * Math.max(0, 1 - t / release)',
    tests: 'packages/app/test/duckcurve.test.ts',
  },
  {
    label: 'duck: release is ignored (one speed for every pump)',
    file: 'packages/app/src/editor/rondo/duckcurve.ts',
    find: 'return 1 - d * Math.exp(-t / (release / 3))',
    replace: 'return 1 - d * Math.exp(-t / 0.0667)',
    tests: 'packages/app/test/duckcurve.test.ts',
  },
  {
    label: 'duck: the per-channel spread collapses to one amount',
    file: 'packages/app/src/editor/rondo/duckcurve.ts',
    find: 'else scan.channels.push({ name: k, amount: v })',
    replace: 'else scan.channels.push({ name: k, amount: 1 })',
    tests: 'packages/app/test/duckcurve.test.ts',
  },
  {
    label: 'duck: the drawn default drifts off the one the DSL applies',
    file: 'packages/app/src/editor/rondo/duckcurve.ts',
    find: 'depth: 0.6, release: 0.18',
    replace: 'depth: 0.7, release: 0.2',
    tests: 'packages/app/test/duckcurve.test.ts',
  },
  {
    label: 'duck: the DSL default drifts off the ENGINE it defaults for',
    file: 'packages/app/src/session/evalCode.ts',
    find: 'export const DEFAULT_SIDECHAIN_DEPTH = 0.6',
    replace: 'export const DEFAULT_SIDECHAIN_DEPTH = 0.65',
    tests: 'packages/app/test/duckcurve.test.ts',
  },

  /* ---- activation: widgets lighting with the audio clock ----------------- */
  {
    label: 'activation: fires immediately, ignoring the scheduler lead time',
    file: 'packages/app/src/editor/rondo/activation.ts',
    find: 'const delayMs = Math.max(0, (ev.timeSec - now) * 1000)',
    replace: 'const delayMs = 0',
    tests: 'packages/app/test/activation.test.ts',
  },
  {
    label: 'activation: a late event schedules into the past',
    file: 'packages/app/src/editor/rondo/activation.ts',
    find: 'const delayMs = Math.max(0, (ev.timeSec - now) * 1000)',
    replace: 'const delayMs = (ev.timeSec - now) * 1000',
    tests: 'packages/app/test/activation.test.ts',
  },
  {
    label: 'activation: a non-finite time is scheduled anyway',
    file: 'packages/app/src/editor/rondo/activation.ts',
    find: 'if (!Number.isFinite(ev.timeSec)) continue',
    replace: '',
    tests: 'packages/app/test/activation.test.ts',
  },

  /* ---- the filter curve's live dot --------------------------------------- */
  {
    label: 'filtercurve: the knob NAME is discarded, so the dot cannot follow',
    file: 'packages/app/src/editor/rondo/filtercurve.ts',
    find: "{ value: def, knob: tok.text.split(' ').pop()! }",
    replace: '{ value: def }',
    tests: 'packages/app/test/filtercurve.test.ts packages/app/test/scan-parity.test.ts',
  },

  /* ---- rondo: the pieces the editor reads back ---------------------------- */
  {
    label: 'codegen: composed patdefs stop expanding',
    file: 'packages/rondo/src/codegen.ts',
    find: 'const inlinable = new Set([...defs.keys()].filter(isComposablePatDefName))',
    replace: 'const inlinable = new Set<string>()',
    tests: 'packages/rondo/test/compile.test.ts packages/app/test/flash.test.ts packages/app/test/patrefs.test.ts',
  },
  {
    label: 'parser: `section … with OTHER` is silently ignored',
    file: 'packages/rondo/src/parser.ts',
    find: "if (t.k === 'ident' && t.v === 'with') {",
    replace: "if (false && t.k === 'ident' && t.v === 'with') {",
    tests: 'packages/rondo/test/compile.test.ts packages/rondo/test/e2e.test.ts',
  },

  /* ---- the engine's math ops, which the language exposes verbatim -------- */
  {
    label: 'math: `sign` quietly does what `abs` does',
    file: 'packages/engine/src/builder.ts',
    find: "sign(): Sig { return this.#math('sign') }",
    replace: "sign(): Sig { return this.#math('abs') }",
    tests: 'packages/rondo/test/e2e.test.ts',
  },
  {
    label: 'math: `floor` becomes the identity',
    file: 'packages/engine/src/builder.ts',
    find: "floor(): Sig { return this.#math('floor') }",
    replace: 'floor(): Sig { return this }',
    tests: 'packages/rondo/test/e2e.test.ts',
  },

  /* ---- the two languages are one program --------------------------------- */
  {
    label: 'decompile: every program round-trips to nothing',
    file: 'packages/rondo/src/decompile.ts',
    find: 'export function decompile(',
    replace: 'export function decompile(src_UNUSED_FOR_MUTATION: string): string { return "" }\nfunction decompileReal(',
    tests: 'packages/app/test/cookbook.test.ts',
  },
]
