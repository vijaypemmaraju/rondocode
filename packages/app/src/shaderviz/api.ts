/* ------------------------------------------------------------------------- *
 * THE VISUAL API, DECLARED ONCE.
 *
 * A `visual(…)` shader reads a set of module globals — time, level, bass, a
 * hit_<synth> per synth, and so on. That set used to be written out in FOUR
 * places: the WGSL prelude in renderer.ts, the uniform packing in its frame
 * loop, the highlighter's API_VARS plus its completion list in editor/wgsl.ts,
 * and the docs. Adding one global meant editing all four, and `dt` proves what
 * happens when you don't: it was packed into the uniform buffer and uploaded
 * every frame for months, with no `var<private> dt` for a shader to read it
 * through. Paid for, unreachable, and nothing failed.
 *
 * So the list lives here and everything else is derived from it:
 *
 *   renderer.ts      struct fields, globals, the fs() assigns, and the float
 *                    index each value is written to
 *   editor/wgsl.ts   highlighting + completions (with these descriptions)
 *   docs/content.ts  the reference table
 *
 * `packages/app/test/viz-api.test.ts` walks the source and fails if any of
 * them rebuilds the list instead of importing it.
 * ------------------------------------------------------------------------- */

export type VizType = 'f32' | 'vec2f'

/** Where a value comes from, which is how the docs group them. */
export type VizGroup = 'canvas' | 'transport' | 'audio' | 'input'

export interface VizGlobal {
  name: string
  type: VizType
  /** One line. Used as the completion detail AND the docs cell, so it has to
   *  read as a definition rather than a hint. */
  detail: string
  group: VizGroup
}

/** Every scalar/vector global. ORDER IS FREE: vizLayout() places vec2f values
 *  first so the std140-ish alignment rules hold however this list is sorted. */
export const VIZ_GLOBALS: readonly VizGlobal[] = [
  { name: 'res', type: 'vec2f', detail: 'canvas resolution in px', group: 'canvas' },
  { name: 'pointer', type: 'vec2f', detail: 'pointer position in uv space, 0..1 (centre when untouched)', group: 'input' },

  { name: 'time', type: 'f32', detail: 'audio clock, seconds', group: 'transport' },
  { name: 'dt', type: 'f32', detail: 'seconds since the previous frame', group: 'transport' },
  { name: 'cps', type: 'f32', detail: 'tempo, cycles per second', group: 'transport' },
  { name: 'phase', type: 'f32', detail: 'position within the current cycle, 0..1', group: 'transport' },
  { name: 'cycle', type: 'f32', detail: 'cycles elapsed since play, counting from 0; the whole number `phase` drops', group: 'transport' },
  { name: 'playing', type: 'f32', detail: '1 while the transport runs, 0 when stopped', group: 'transport' },

  { name: 'level', type: 'f32', detail: 'overall loudness 0..1', group: 'audio' },
  { name: 'bass', type: 'f32', detail: 'low-band energy 0..1 (30-200 Hz)', group: 'audio' },
  { name: 'mid', type: 'f32', detail: 'mid-band energy 0..1 (200-2000 Hz)', group: 'audio' },
  { name: 'treble', type: 'f32', detail: 'high-band energy 0..1 (2-12 kHz)', group: 'audio' },
  { name: 'centroid', type: 'f32', detail: 'spectral centroid 0..1: where the energy sits, i.e. brightness as ONE number', group: 'audio' },
  { name: 'flux', type: 'f32', detail: 'spectral flux 0..1: how much the spectrum just changed, so it catches onsets from the mic and samples that `hit_` cannot see', group: 'audio' },
  { name: 'peak', type: 'f32', detail: 'loudest sample this frame, 0..1', group: 'audio' },
  { name: 'crest', type: 'f32', detail: 'peak over rms: high is punchy and dynamic, near 1 is a limited wall', group: 'audio' },
  { name: 'left', type: 'f32', detail: 'left-channel loudness 0..1', group: 'audio' },
  { name: 'right', type: 'f32', detail: 'right-channel loudness 0..1', group: 'audio' },
  { name: 'width', type: 'f32', detail: 'stereo width 0..1, where 0 is mono and higher is wider', group: 'audio' },
  { name: 'duck', type: 'f32', detail: 'the sidechain envelope itself, 1 open and dipping toward 1-depth on every source hit: the real pump, not an approximation of it', group: 'audio' },
  { name: 'mic', type: 'f32', detail: 'live input loudness 0..1, 0 when the mic is off', group: 'audio' },
  { name: 'beat', type: 'f32', detail: 'bass-driven pulse 0..1', group: 'audio' },
  { name: 'hit', type: 'f32', detail: 'note-onset envelope 0..1, loudest across all synths', group: 'audio' },
  { name: 'click', type: 'f32', detail: 'pointer-press envelope 0..1, decaying like a note onset', group: 'input' },
]

/** Texture-backed helpers. */
export const VIZ_FNS: readonly { name: string; sig: string; detail: string }[] = [
  { name: 'spectrum', sig: 'spectrum(x: f32) -> f32', detail: 'FFT magnitude 0..1 at x (0..1 across the spectrum)' },
  { name: 'waveform', sig: 'waveform(x: f32) -> f32', detail: 'waveform sample -1..1 at x (0..1 across the window)' },
]

/** Up to this many synths get per-synth globals, and this many params get a
 *  ctl_ global. Both are packed as array<vec4f, 4>. */
export const MAX_CHANNELS = 16

/** Globals generated PER SYNTH in the program, as `<prefix><synth>`. `field`
 *  is the uniform array each one is packed into. */
export const VIZ_SYNTH_GLOBALS: readonly { prefix: string; field: string; detail: string }[] = [
  { prefix: 'hit_', field: 'hits', detail: 'onset envelope for that synth, 0..1, decaying over ~0.12 s' },
  { prefix: 'lvl_', field: 'lvls', detail: "that synth's own loudness 0..1; unlike hit_, it stays up while a note is held, so a pad that swells reads as a swell" },
  { prefix: 'note_', field: 'notes', detail: 'the last note that synth played, as a MIDI number (0 before its first note)' },
  { prefix: 'vel_', field: 'vels', detail: 'the last velocity (pattern gain) that synth was sent, 0..1' },
]

/** A macro / knob / switch declared in the program, as `ctl_<name>`. */
export const VIZ_PARAM_PREFIX = 'ctl_'
export const VIZ_PARAM_FIELD = 'ctls'
export const VIZ_PARAM_DETAIL =
  'the live value of the macro, knob or switch of that name, in its own units, so the visual answers the control you are actually turning'

/* ---- uniform layout ------------------------------------------------------ */

/** A vec2f needs 8-byte alignment and array<vec4f> needs 16, so the vec2f
 *  values go first and the scalar block is padded to a multiple of 4 floats.
 *  Doing it here rather than by hand is what lets a row be added to the list
 *  above at any position without anyone reasoning about offsets. */
export interface VizLayout {
  /** WGSL struct field lines, in order. */
  fields: string[]
  /** Float index into the uniform array for each global. */
  index: Record<string, number>
  /** Float index where the per-synth channel block starts (16-byte aligned). */
  base: number
}

export function vizLayout(): VizLayout {
  const vecs = VIZ_GLOBALS.filter((g) => g.type === 'vec2f')
  const scalars = VIZ_GLOBALS.filter((g) => g.type === 'f32')
  const fields: string[] = []
  const index: Record<string, number> = {}
  let at = 0
  for (const g of vecs) {
    fields.push(`  ${g.name}: vec2f,`)
    index[g.name] = at
    at += 2
  }
  for (const g of scalars) {
    fields.push(`  ${g.name}: f32,`)
    index[g.name] = at
    at += 1
  }
  while (at % 4 !== 0) {
    fields.push(`  _pad${at}: f32,`)
    at += 1
  }
  return { fields, index, base: at }
}
