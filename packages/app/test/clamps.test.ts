import { describe, expect, it } from 'vitest'
import { scanClampedOpts } from '../src/editor/rondo/clamps'
import { clampMaxVoices, normalizeVoiceOpts } from '@rondocode/engine'

/** The resolver the app injects (editor.ts) — the engine's own clamps. */
const effective = (name: string, written: number): number =>
  name === 'voices'
    ? clampMaxVoices(written)
    : (normalizeVoiceOpts({ [name]: written }) as unknown as Record<string, number>)[name] ?? written

/* ------------------------------------------------------------------------- *
 * "You wrote 32; the engine is using 9."
 *
 * Voice options are clamped at synth() build, silently — the typed value stays
 * on screen and a different one plays. A real patch here carried
 * `unison:32 spread:32 humanize:32 curve:21`, ALL FOUR clamped, and read as if
 * the numbers meant something.
 *
 * The bounds are never restated in the editor: the scanner calls the engine's
 * own normalizeVoiceOpts. So the test worth writing is not "9 is the cap" —
 * that would just re-copy the number — but that a clamp is REPORTED and a
 * legal value is left alone.
 * ------------------------------------------------------------------------- */

const header = (opts: string): string => `synth s ${opts}\n  saw note\n`
const scanClampedOpts2 = (text: string) => scanClampedOpts(text, effective)

describe('clamped voice options are reported', () => {
  it('catches every option the engine will change', () => {
    const got = scanClampedOpts2(header('unison:32 spread:32 humanize:32 curve:21'))
    expect(got.map((c) => `${c.name} ${c.written}->${c.effective}`)).toEqual([
      'unison 32->9', 'spread 32->1', 'humanize 32->1', 'curve 21->5',
    ])
  })

  it('says NOTHING about a value used as written', () => {
    // a chip on every number is noise; the surprising ones have to stand out
    expect(scanClampedOpts2(header('unison:9 detune:26 spread:.9 curve:4 voices:16'))).toEqual([])
  })

  it('knows detune is unbounded above — 38 cents is a real setting', () => {
    // the mistake that prompted this: detune reads as 0..1 and is CENTS
    expect(scanClampedOpts2(header('detune:38'))).toEqual([])
    expect(scanClampedOpts2(header('detune:-5'))).toEqual([
      { name: 'detune', written: -5, effective: 0, at: expect.any(Number) },
    ])
  })

  it('handles `voices`, which is clamped separately into maxVoices', () => {
    expect(scanClampedOpts2(header('voices:200'))).toEqual([
      { name: 'voices', written: 200, effective: 64, at: expect.any(Number) },
    ])
    expect(scanClampedOpts2(header('voices:32'))).toEqual([])
  })

  it('anchors just past the number it is talking about', () => {
    const src = header('unison:32')
    const [c] = scanClampedOpts2(src)
    expect(src.slice(0, c!.at).endsWith('unison:32')).toBe(true)
  })

  it('looks only at headers, and not inside a comment', () => {
    expect(scanClampedOpts2('synth s\n  svf 900 res:32\n')).toEqual([]) // res is not a voice opt
    expect(scanClampedOpts2('# synth s unison:32\n')).toEqual([])
    expect(scanClampedOpts2('synth s unison:9  # unison:32 was clamped\n')).toEqual([])
  })

  it('reads the ENGINE for its bounds rather than restating them', () => {
    // the guarantee: change a clamp in the engine and this follows. Asserted
    // by agreeing with normalizeVoiceOpts rather than with a literal.
    const [c] = scanClampedOpts2(header('unison:32'))
    expect(c!.effective).toBe(normalizeVoiceOpts({ unison: 32 }).unison)
  })
})
