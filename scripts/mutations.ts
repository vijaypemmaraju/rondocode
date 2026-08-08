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

  /* ======================================================================= *
   * THE OLDER CODE. The mutations above cover work added recently, which is
   * the code most likely to be remembered and least likely to have rotted.
   * These cover the load-bearing parts that have been stable long enough for
   * a contract to go quietly unasserted.
   * ======================================================================= */

  /* ---- pattern: the arithmetic everything else stands on ----------------- */
  {
    label: 'fraction: results stop reducing to lowest terms',
    file: 'packages/pattern/src/fraction.ts',
    find: 'const g = gcd(Math.abs(n), d) // >= 1: d is positive here',
    replace: 'const g = 1 // >= 1: d is positive here',
    tests: 'packages/pattern/test/fraction.test.ts',
  },
  {
    label: 'scales: the minor scale gets a major seventh',
    file: 'packages/pattern/src/scales.ts',
    find: 'minor: [0, 2, 3, 5, 7, 8, 10],',
    replace: 'minor: [0, 2, 3, 5, 7, 8, 11],',
    tests: 'packages/pattern/test/scales.test.ts',
  },
  {
    label: 'scales: a degree past the scale length stops climbing octaves',
    file: 'packages/pattern/src/scales.ts',
    find: 'return intervals[idx]! + period * oct',
    replace: 'return intervals[idx]!',
    tests: 'packages/pattern/test/scales.test.ts',
  },
  {
    label: 'euclid: a saturated rhythm (pulses >= steps) goes silent',
    file: 'packages/pattern/src/euclid.ts',
    find: 'if (pulses >= steps) return new Array<boolean>(steps).fill(true)',
    replace: 'if (pulses >= steps) return new Array<boolean>(steps).fill(false)',
    tests: 'packages/pattern/test/euclid.test.ts',
  },
  {
    label: 'chords: drop2 drops the wrong voice',
    file: 'packages/pattern/src/chords.ts',
    find: 'drop2: (ns) => ns.map((x, i) => (i === ns.length - 2 ? x - 12 : x)),',
    replace: 'drop2: (ns) => ns.map((x, i) => (i === ns.length - 3 ? x - 12 : x)),',
    tests: 'packages/pattern/test/chords.test.ts',
  },
  {
    label: 'midi export: the tick division silently halves',
    file: 'packages/pattern/src/midiExport.ts',
    find: 'const tpq = opts.ticksPerQuarter ?? 480',
    replace: 'const tpq = opts.ticksPerQuarter ?? 240',
    tests: 'packages/pattern/test/midiExport.test.ts',
  },

  /* ---- engine: the last line of defence before the speakers -------------- */
  {
    label: 'engine: the master clip ceiling stops clipping',
    file: 'packages/engine/src/realtime.ts',
    find: 'export const CLIP_THRESHOLD = 0.95',
    replace: 'export const CLIP_THRESHOLD = 100',
    tests: 'packages/engine/test/realtime.test.ts',
  },
  {
    label: 'engine: a NaN sample reaches the output instead of being zeroed',
    file: 'packages/engine/src/realtime.ts',
    find: 'Number.isFinite(v) ? softClipTanh(v, CLIP_THRESHOLD) : 0',
    replace: 'softClipTanh(v, CLIP_THRESHOLD)',
    tests: 'packages/engine/test/realtime.test.ts',
  },
  {
    label: 'compressor: the knee band stops easing (the engine kernel)',
    file: 'packages/engine/src/dsp/compress.ts',
    find: 'const slope = 1 - 1 / ratio // 0 at 1:1, ->1 at ∞:1',
    replace: 'const slope = 1 // 0 at 1:1, ->1 at ∞:1',
    tests: 'packages/engine/test/compress.test.ts packages/app/test/compcurve.test.ts',
  },

  /* ---- the app: tempo and the export ceiling ---------------------------- */
  {
    label: 'session: the cps clamp lets a program run at any tempo',
    file: 'packages/app/src/session/evalCode.ts',
    find: 'export const clampCps = (x: number): number => Math.min(4, Math.max(0.05, x))',
    replace: 'export const clampCps = (x: number): number => x',
    tests: 'packages/app/test/evalCode.test.ts',
  },
  {
    label: 'render: the 0.89 peak ceiling stops applying',
    file: 'packages/server/src/render-runner.ts',
    find: 'const normalized = peak > 0.89',
    replace: 'const normalized = false && peak > 0.89',
    tests: 'packages/server/test/render-runner.test.ts',
  },

  /* ---- pattern: the seams a partial query window exposes ----------------- */
  {
    label: 'types: a hap that merely OVERLAPS the window counts as an onset',
    file: 'packages/pattern/src/types.ts',
    find: 'return h.whole !== undefined && h.whole.begin.eq(h.part.begin)',
    replace: 'return h.whole !== undefined',
    tests: 'packages/pattern/test/types.test.ts packages/pattern/test/scheduler.test.ts',
  },
  {
    label: 'scheduler: a window is re-queried, so onsets fire twice',
    file: 'packages/pattern/src/scheduler.ts',
    find: 'this.queried = end',
    replace: '',
    tests: 'packages/pattern/test/scheduler.test.ts',
  },
  {
    label: 'rand: the time hash stops depending on the DENOMINATOR',
    file: 'packages/pattern/src/rand.ts',
    find: '  h = mix(h, dLo)\n  h = mix(h, dHi)',
    replace: '',
    tests: 'packages/pattern/test/signal.test.ts packages/pattern/test/combinators.test.ts',
  },
  {
    label: 'midi import: running status is not reused (events go unparsed)',
    file: 'packages/pattern/src/midi.ts',
    find: 'status = running // running status: reuse last status byte',
    replace: '// running status dropped',
    tests: 'packages/pattern/test/midi.test.ts packages/app/test/midi-import.test.ts',
  },

  /* ---- rondo: the two languages, and where errors point ------------------ */
  {
    label: 'format: formatting is no longer idempotent',
    file: 'packages/rondo/src/format.ts',
    find: 'export function formatRondo(src: string): string {',
    replace: 'export function formatRondo(src: string): string {\n  if (src.endsWith("\\n\\n")) return src.slice(0, -1)',
    tests: 'packages/rondo/test/format.test.ts packages/app/test/format.test.ts',
  },

  /* ---- the singing pipeline: numeric code with no ear on it -------------- */
  {
    label: 'sing: F0 estimation takes the FIRST peak, not the best one',
    file: 'packages/app/src/sing/psola.ts',
    find: 'const minLag = Math.floor(sr / fmax)',
    replace: 'const minLag = Math.max(1, Math.floor(sr / fmax) >> 1)',
    tests: 'packages/app/test/psola.test.ts',
  },
  {
    label: 'sing: forced alignment cannot stay in a state (no self-loop)',
    file: 'packages/app/src/sing/forcedalign.ts',
    find: 'for (let s = 0; s < S; s++) ext[s] = s % 2 === 0 ? blank : tokens[(s - 1) >> 1]!',
    replace: 'for (let s = 0; s < S; s++) ext[s] = s % 2 === 1 ? blank : tokens[(s - 1) >> 1] ?? blank',
    tests: 'packages/app/test/forcedalign.test.ts',
  },

  /* ---- the visual API, which the docs table is generated FROM ------------ */
  {
    label: 'viz: a uniform is exposed to shaders but not in the struct',
    file: 'packages/app/src/shaderviz/api.ts',
    find: "const scalars = VIZ_GLOBALS.filter((g) => g.type === 'f32')",
    replace: "const scalars = VIZ_GLOBALS.filter((g) => g.type === 'f32').slice(1)",
    tests: 'packages/app/test/viz-api.test.ts packages/app/test/docs.test.ts',
  },

  {
    label: 'sing: estimateF0 ignores the fmax it was handed',
    file: 'packages/app/src/sing/psola.ts',
    find: 'const minLag = Math.floor(sr / fmax)',
    replace: 'const minLag = Math.floor(sr / 500)',
    tests: 'packages/app/test/psola.test.ts',
  },
  {
    label: 'sing: a silent frame is treated as pitched instead of skipped',
    file: 'packages/app/src/sing/psola.ts',
    find: 'if (e0 < 1e-6) continue',
    replace: '',
    tests: 'packages/app/test/psola.test.ts',
  },

  /* ---- the tap palette: the phone surface of the grammar ----------------- */
  {
    label: 'palette: argument position goes blind again (block chips only)',
    file: 'packages/app/src/editor/rondo/palette.ts',
    find: '  const args = argChips(doc, pos)\n  if (args !== null) return args',
    replace: '',
    tests: 'packages/app/test/rondo-palette.test.ts',
  },
  {
    label: 'palette: a beat row stops offering the kit',
    file: 'packages/app/src/editor/rondo/palette.ts',
    find: "    case 'beat': {",
    replace: "    case '__never_beat': {",
    tests: 'packages/app/test/rondo-palette.test.ts',
  },
  {
    label: 'palette: a sing block falls back to top-level starters',
    file: 'packages/app/src/editor/rondo/palette.ts',
    find: "    case 'sing': {",
    replace: "    case '__never_sing': {",
    tests: 'packages/app/test/rondo-palette.test.ts',
  },
  {
    label: 'palette: the synth header forgets its voice options',
    file: 'packages/app/src/editor/rondo/palette.ts',
    find: 'const head = /^synth[ \\t]+[a-zA-Z_]\\w*[ \\t]/.exec(line)',
    replace: 'const head = null as RegExpExecArray | null',
    tests: 'packages/app/test/rondo-palette.test.ts',
  },

  /* ---- audio devices: the precedence a live rig depends on --------------- */
  {
    label: 'devices: the code override stops beating the saved setting',
    file: 'packages/app/src/audio/devices.ts',
    find: "  if (requested !== undefined && requested !== '') {",
    replace: '  if (false) {',
    tests: 'packages/app/test/devices.test.ts',
  },
  {
    label: 'devices: a device that is NOT in the room falls back SILENTLY',
    file: 'packages/app/src/audio/devices.ts',
    find: '  if (c.fellBackFrom === undefined) return null',
    replace: '  return null',
    tests: 'packages/app/test/devices.test.ts',
  },
  {
    label: 'devices: matching by label stops working (ids only)',
    file: 'packages/app/src/audio/devices.ts',
    find: '  return w !== \'\' && norm(d.label).includes(w)',
    replace: '  return false',
    tests: 'packages/app/test/devices.test.ts',
  },
  {
    label: 'devices: the engine quantum drops out of the latency budget',
    file: 'packages/app/src/audio/devices.ts',
    find: '    roundTripMs: baseMs + outputMs + inputMs + quantumMs,',
    replace: '    roundTripMs: baseMs + outputMs + inputMs,',
    tests: 'packages/app/test/devices.test.ts',
  },

  /* ---- the noise gate: the live-mic node ---------------------------------- */
  {
    label: 'gate: hysteresis collapses, so a signal at the threshold chatters',
    file: 'packages/engine/src/dsp/gate.ts',
    find: '  if (levelDb < threshold - Math.max(0, hysteresis)) return false',
    replace: '  if (levelDb < threshold) return false',
    tests: 'packages/engine/test/gate.test.ts',
  },
  {
    label: 'gate: HOLD is ignored, so a sung word gets chopped at every dip',
    file: 'packages/engine/src/dsp/gate.ts',
    find: '      } else if (hold > 0) {',
    replace: '      } else if (false) {',
    tests: 'packages/engine/test/gate.test.ts',
  },
  {
    label: 'gate: closed means MUTE instead of the configured range',
    file: 'packages/engine/src/dsp/gate.ts',
    find: '      const target = open ? 1 : floor',
    replace: '      const target = open ? 1 : 0',
    tests: 'packages/engine/test/gate.test.ts',
  },
  {
    label: 'gate: it starts OPEN, letting a block of bleed through',
    file: 'packages/engine/src/dsp/gate.ts',
    find: '    this.gain = this.rangeLin\n  }\n\n  process(',
    replace: '    this.gain = 1\n  }\n\n  process(',
    tests: 'packages/engine/test/gate.test.ts',
  },

  {
    label: 'gate: the js{} escape cannot see noisegate (decompile fixed point)',
    file: 'packages/rondo/src/codegen.ts',
    // anchored on ONE token, not on its neighbours: this mutation went stale
    // twice because every new node rewrote the names either side of it
    find: "'noisegate', ",
    replace: "",
    tests: 'packages/app/test/one-structural-list.test.ts packages/rondo/test/fuzz.test.ts',
  },

  /* ---- the de-esser: selectivity is the whole contract ------------------- */
  {
    label: 'deess: the detector goes full-band, so a vowel ducks the sibilance',
    file: 'packages/engine/src/dsp/deess.ts',
    find: '      const lin = Math.abs(det)',
    replace: '      const lin = Math.abs(x)',
    tests: 'packages/engine/test/deess.test.ts',
  },
  {
    label: 'deess: the LOW band gets ducked too (a broadband compressor again)',
    file: 'packages/engine/src/dsp/deess.ts',
    find: '      out[i] = low + high * g',
    replace: '      out[i] = (low + high) * g',
    tests: 'packages/engine/test/deess.test.ts',
  },
  {
    label: 'deess: the detector falls back to the leaky subtracted band',
    file: 'packages/engine/src/dsp/deess.ts',
    find: '      const lin = Math.abs(det)',
    replace: '      const lin = Math.abs(high)',
    tests: 'packages/engine/test/deess.test.ts',
  },
  {
    label: 'deess: the split collapses to one pole and stops separating',
    file: 'packages/engine/src/dsp/deess.ts',
    find: '      low2 += (low1 - low2) * this.lp',
    replace: '      low2 = low1',
    tests: 'packages/engine/test/deess.test.ts',
  },
  {
    label: 'deess: it ducks below the threshold as well as above',
    file: 'packages/engine/src/dsp/deess.ts',
    find: '  if (over <= 0) return 1',
    replace: '  if (over <= -200) return 1',
    tests: 'packages/engine/test/deess.test.ts',
  },

  {
    label: 'mic: auto stops enabling echo cancellation on a phone (it howls)',
    file: 'packages/app/src/audio/devices.ts',
    find: '  return isMobile ? { ...VOICE_CAPTURE } : { ...RAW_CAPTURE }',
    replace: '  return { ...RAW_CAPTURE }',
    tests: 'packages/app/test/devices.test.ts',
  },
  {
    label: 'mic: an explicit choice stops beating the platform guess',
    file: 'packages/app/src/audio/devices.ts',
    find: "  if (setting === 'raw') return { ...RAW_CAPTURE }",
    replace: "  if (setting === 'raw' && !isMobile) return { ...RAW_CAPTURE }",
    tests: 'packages/app/test/devices.test.ts',
  },
  {
    label: 'mic: automatic GAIN control creeps in with the voice path',
    file: 'packages/app/src/audio/devices.ts',
    find: '  echoCancellation: true,\n  noiseSuppression: true,\n  autoGainControl: false,',
    replace: '  echoCancellation: true,\n  noiseSuppression: true,\n  autoGainControl: true,',
    tests: 'packages/app/test/devices.test.ts',
  },

  /* ---- the look-ahead limiter: the ceiling is a guarantee ---------------- */
  {
    label: 'limiter: the final clamp goes, so a release curve can overshoot',
    file: 'packages/engine/src/dsp/limiter.ts',
    find: '      const applied = g < needNow ? g : needNow',
    replace: '      const applied = g',
    tests: 'packages/engine/test/limiter.test.ts',
  },
  {
    label: 'limiter: it looks at the current sample only, not the window',
    file: 'packages/engine/src/dsp/limiter.ts',
    find: '      const target = this.req[this.dq[this.dqHead]!]!',
    replace: '      const target = need',
    tests: 'packages/engine/test/limiter.test.ts',
  },
  {
    label: 'limiter: gain reduction eases in instead of applying at once',
    file: 'packages/engine/src/dsp/limiter.ts',
    find: '      g = target < g ? target : g + (target - g) * this.rel',
    replace: '      g = g + (target - g) * this.rel',
    tests: 'packages/engine/test/limiter.test.ts',
  },
  {
    label: 'limiter: below the ceiling it stops being a pure delay',
    file: 'packages/engine/src/dsp/limiter.ts',
    find: '  if (!(lin > ceilingLin)) return 1',
    replace: '  if (!(lin > ceilingLin * 0.5)) return 1',
    tests: 'packages/engine/test/limiter.test.ts',
  },
  {
    label: 'limiter: reset() leaves stale audio in the delay line',
    file: 'packages/engine/src/dsp/limiter.ts',
    find: '    if (this.sr > 0) this.resize(this.sr)',
    replace: '    this.gain = 1',
    tests: 'packages/engine/test/limiter.test.ts',
  },

  /* ---- offline mic injection: the thing that made the chain testable ----- */
  {
    label: 'render: a supplied mic signal never reaches the graph (silence again)',
    file: 'packages/engine/src/render.ts',
    find: '      for (let i = 0; i < end - cursor; i++) blk[i] = micIn[cursor + i] ?? 0',
    replace: '      for (let i = 0; i < end - cursor; i++) blk[i] = 0',
    tests: 'packages/engine/test/mic-chain.test.ts',
  },
  // NOT mutated: clearing the mic block past a short chunk is defensive, and
  // provably unobservable — kernels only read `n` samples, so the stale tail
  // is never seen. Removing it leaves every test green because it genuinely
  // changes nothing today. It stays because a kernel that read a whole block
  // would otherwise see the previous chunk's audio, and it costs nothing.

  /* ---- mic device, named from the code ----------------------------------- */
  {
    label: 'mic: a device named in the code never reaches the host',
    file: 'packages/engine/src/samples.ts',
    find: "    if (typeof d === 'string' && d !== '') return d",
    replace: '    if (false) return String(d)',
    tests: 'packages/app/test/mic-device.test.ts',
  },

  /* ---- open-source hygiene: things a public repo must not carry --------- */
  {
    label: 'repo: the render mirror is hardcoded to one person path again',
    file: 'packages/server/src/render-tools.ts',
    find: "  mirrorDir: process.env['RONDOCODE_RENDER_MIRROR'] ?? null,",
    replace: "  mirrorDir: '/Users/vijaypemmaraju/Dropbox/rondocode-renders',",
    tests: 'packages/app/test/repo-hygiene.test.ts',
  },

  {
    label: 'parser: a named arg binds to the nearest call, not the nearest that ACCEPTS it',
    file: 'packages/rondo/src/parser.ts',
    find: "    if (spec?.named?.[peeked.v] === undefined) {\n      c.decline(peeked.v, by)\n      break\n    }",
    replace: '',
    tests: 'packages/rondo/test/compile.test.ts packages/app/test/mic-device.test.ts',
  },
  {
    label: 'parser: the "no such named arg" diagnostic degrades to "unexpected tokens"',
    file: 'packages/rondo/src/parser.ts',
    find: '    if (by !== undefined) return `\\`${by}\\` has no \\`${arg}:\\` argument`',
    replace: '    if (false) return fallback',
    tests: 'packages/rondo/test/compile.test.ts',
  },

  /* ---- the mic channel strip example: its comments are claims ------------ */
  {
    label: 'example: the strip loses its gate (room tone comes through)',
    file: 'packages/app/src/examples/index.ts',
    find: '  noisegate threshold:-42 range:-35 hold:60 release:120\n  eq hp 90 peak 3000 2 1.2',
    replace: '  eq hp 90 peak 3000 2 1.2',
    tests: 'packages/app/test/mic-strip-example.test.ts',
  },
  {
    label: 'example: the strip loses its limiter (no ceiling)',
    file: 'packages/app/src/examples/index.ts',
    find: '    limiter ceiling:-1 lookahead:5',
    replace: '',
    tests: 'packages/app/test/mic-strip-example.test.ts',
  },
  {
    label: 'example: the compressor is turned off (ratio 1)',
    file: 'packages/app/src/examples/index.ts',
    find: '  compress threshold:-20 ratio:3 attack:8 release:120 makeup:6',
    replace: '  compress threshold:-20 ratio:1 attack:8 release:120 makeup:6',
    tests: 'packages/app/test/mic-strip-example.test.ts',
  },

  {
    /* `syncsaw` is named in exactly ONE place in the guide, so dropping it
     * from that list is precisely the state this guard exists to catch: a node
     * fully documented in the reference and invisible to anyone reading the
     * guide. Renaming a section id was the first attempt and proved nothing —
     * the prose was still there. */
    label: 'docs: a DSP node is reference-only, never taught in the guide',
    file: 'packages/app/src/docs/content.ts',
    find: 'wavetable syncsaw`',
    replace: 'wavetable`',
    tests: 'packages/app/test/docs.test.ts',
  },

  /* ---- per-note expression: the value belongs to the NOTE ---------------- */
  {
    label: 'notation: a note expression is dropped on the floor',
    file: 'packages/pattern/src/mini.ts',
    find: '    const v: MiniValue = expr === undefined ? base : { ...base, expr }',
    replace: '    const v: MiniValue = base',
    tests: 'packages/pattern/test/note-expression.test.ts',
  },
  {
    label: 'notation: the expression suffix stops parsing (a lone quote passes)',
    file: 'packages/pattern/src/mini.ts',
    find: "  if (j === digits) return undefined // a lone quote is not an expression",
    replace: '  if (j === digits) return { expr: 0, next: j }',
    tests: 'packages/pattern/test/note-expression.test.ts',
  },
  {
    label: "notation: words lose their expression (c4 and kick words)",
    file: 'packages/pattern/src/mini.ts',
    find: '      const wex = readExpr(src, j)',
    replace: '      const wex = undefined as ReturnType<typeof readExpr>',
    tests: 'packages/pattern/test/note-expression.test.ts',
  },
  {
    label: 'controls: the expression never reaches the synth as a param',
    file: 'packages/pattern/src/controls.ts',
    find: '      if (v.expr !== undefined) out.expr = v.expr\n      return out\n    })\n  }\n  return reify(x).withValue',
    replace: '      return out\n    })\n  }\n  return reify(x).withValue',
    tests: 'packages/pattern/test/note-expression.test.ts',
  },

  // NOT mutated: the per-note CURVE is a composition of primitives, not new
  // shipped code — a synth blending two envelopes by a per-note param. There
  // is nothing to break but the test's own fixture, and a mutation of that
  // proves nothing. The data flow it depends on IS pinned, by the four
  // `notation:`/`controls:` mutations above; the audio is pinned by
  // note-curve.test.ts.

  /* ---- the note-bends example: its header makes four claims -------------- */
  {
    label: 'example: the note value stops signing the bend (all notes alike)',
    file: 'packages/app/src/examples/index.ts',
    find: '  bend = shape * expr + 1',
    replace: '  bend = shape + 1',
    tests: 'packages/app/test/note-bends-example.test.ts',
  },
  {
    label: 'example: the bend never resolves back to the written pitch',
    file: 'packages/app/src/examples/index.ts',
    find: '  shape = env .07 .06 .2 0 .3 0',
    replace: '  shape = env .07 .06 .2 .06 .3 .06',
    tests: 'packages/app/test/note-bends-example.test.ts',
  },
  {
    label: 'example: the subgroup notes lose their own values',
    file: 'packages/app/src/examples/index.ts',
    find: "  ~ ~ [12'1 11'-1] ~",
    replace: '  ~ ~ [12 11] ~',
    tests: 'packages/app/test/note-bends-example.test.ts',
  },
]
