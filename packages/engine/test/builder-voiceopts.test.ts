import { describe, it, expect } from 'vitest'
import { synth } from '../src/builder'

/* voiceOpts plumbing + the two call shapes:
 *   synth(voiceFn, opts)             — 2nd arg is a plain object => opts, no post
 *   synth(voiceFn, postFn, opts)     — 3rd arg is opts
 *   synth(voiceFn)                   — nothing => voiceOpts undefined
 */
describe('synth() voiceOpts overloads', () => {
  it('no opts -> voiceOpts undefined, post undefined (backward compatible)', () => {
    const d = synth(({ note, saw }) => saw(note.freq))
    expect(d.voiceOpts).toBeUndefined()
    expect(d.post).toBeUndefined()
  })

  it('synth(voiceFn, opts): a plain-object 2nd arg is opts, not a post fn', () => {
    const d = synth(({ note, saw }) => saw(note.freq), { mono: true, glide: 0.1, unison: 3 })
    expect(d.post).toBeUndefined()
    expect(d.voiceOpts).toEqual({ mono: true, glide: 0.1, unison: 3, detune: 15, spread: 0.6 })
  })

  it('synth(voiceFn, postFn, opts): a function 2nd arg is the post chain, 3rd is opts', () => {
    const d = synth(
      ({ note, saw }) => saw(note.freq),
      ({ input }) => input,
      { unison: 7, detune: 30, spread: 1 },
    )
    expect(d.post).toBeDefined()
    expect(d.voiceOpts).toEqual({ mono: false, glide: 0, unison: 7, detune: 30, spread: 1 })
  })

  it('clamps unison to 1..9 and spread to 0..1; unison<1 or non-int is floored/clamped', () => {
    const d = synth(({ note, saw }) => saw(note.freq), { unison: 99, spread: 5, detune: -3 })
    expect(d.voiceOpts!.unison).toBe(9)
    expect(d.voiceOpts!.spread).toBe(1)
    expect(d.voiceOpts!.detune).toBe(0)
    const e = synth(({ note, saw }) => saw(note.freq), { unison: 0.4 })
    expect(e.voiceOpts!.unison).toBe(1)
  })

  it('opts.voices sets maxVoices (floored, clamped 1..64); absent by default', () => {
    expect(synth(({ note, saw }) => saw(note.freq)).maxVoices).toBeUndefined()
    expect(synth(({ note, saw }) => saw(note.freq), { unison: 5 }).maxVoices).toBeUndefined()
    expect(synth(({ note, saw }) => saw(note.freq), { voices: 12 }).maxVoices).toBe(12)
    expect(synth(({ note, saw }) => saw(note.freq), { voices: 0 }).maxVoices).toBe(1)
    expect(synth(({ note, saw }) => saw(note.freq), { voices: 200 }).maxVoices).toBe(64)
    expect(synth(({ note, saw }) => saw(note.freq), { voices: 3.9 }).maxVoices).toBe(3)
  })
})
