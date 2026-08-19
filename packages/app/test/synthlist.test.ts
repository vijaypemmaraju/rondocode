import { describe, expect, it } from 'vitest'
import { synthListView } from '../src/midi/synthlist'
import { outlineOf } from '../src/editor/outline'

/* ------------------------------------------------------------------------- *
 * The reported bug, as a test.
 *
 * "I keep loading presets but the MIDI dialog isn't refreshing so I keep just
 * getting the same 4 FM instruments no matter what I later load." The list came
 * from the RUNNING program, and loading a preset deliberately does not run one,
 * so the panel described a tune that was no longer on screen.
 *
 * And the half before it: "I had to hit run and it began getting midi" -- the
 * keyboard was silent for a reason nothing in the panel could show.
 * ------------------------------------------------------------------------- */

describe('synthListView', () => {
  it('offers what is in the BUFFER, not what is running', () => {
    // the exact report: preset A ran, preset B was loaded over it
    const v = synthListView(['gamma'], ['alpha', 'beta'])
    expect(v.options.map((o) => o.value), 'the old preset must be gone').toEqual(['gamma'])
  })

  it('marks a synth the engine has never been given', () => {
    const v = synthListView(['gamma'], ['alpha'])
    expect(v.options[0]?.label).toBe('gamma (not running)')
    expect(v.options[0]?.running).toBe(false)
  })

  it('says nothing when everything offered is playable', () => {
    const v = synthListView(['a', 'b'], ['a', 'b'])
    expect(v.notice).toBe('')
    expect(v.options.every((o) => o.running)).toBe(true)
  })

  it('explains the silence when NOTHING is staged', () => {
    /* The first-run case, and the one behind "I had to hit run". Naming the
     * synths here would just be the whole list, which says less than the
     * reason does. */
    const v = synthListView(['a', 'b'], [])
    expect(v.notice).toContain('press Run')
    expect(v.notice).not.toContain('a, b')
  })

  it('names the ones that are missing when SOME are staged', () => {
    // a synth added since the last Run: the specific name is the useful part
    const v = synthListView(['a', 'b'], ['a'])
    expect(v.notice).toContain('b')
    expect(v.notice).not.toMatch(/\ba\b,/)
  })

  it('falls back to the staged program when the buffer yields nothing', () => {
    // a parse that failed mid-edit must not empty the picker
    expect(synthListView([], ['alpha']).options.map((o) => o.value)).toEqual(['alpha'])
  })

  it('is empty, quietly, when there is nothing either way', () => {
    expect(synthListView([], [])).toEqual({ options: [], notice: '' })
  })

  it('keeps the order they were written in', () => {
    expect(synthListView(['z', 'a', 'm'], []).options.map((o) => o.value)).toEqual(['z', 'a', 'm'])
  })
})

describe('the buffer half, in both languages', () => {
  /* The picker reads synth names through the outline, so a preset in either
   * language has to yield them -- the reporter was loading presets, which may
   * be either. */
  const namesIn = (doc: string, lang: 'rondo' | 'rondocode'): string[] =>
    outlineOf(doc, lang).filter((i) => i.kind === 'synth').map((i) => i.name)

  it('finds rondo synths', () => {
    expect(namesIn('synth alpha\n  saw note\n\nsynth beta\n  sine note\n', 'rondo')).toEqual(['alpha', 'beta'])
  })

  it('finds rondocode synths', () => {
    const js = "const alpha = synth(({ saw, note }) => saw(note.freq))\nconst beta = synth(({ sine, note }) => sine(note.freq))\n"
    expect(namesIn(js, 'rondocode')).toEqual(['alpha', 'beta'])
  })

  it('end to end: loading over a running preset swaps the list', () => {
    const staged = namesIn('synth alpha\n  saw note\n\nsynth beta\n  sine note\n', 'rondo')
    const loaded = namesIn('synth gamma\n  tri note\n', 'rondo')
    const v = synthListView(loaded, staged)
    expect(v.options.map((o) => o.label)).toEqual(['gamma (not running)'])
    expect(v.notice).toContain('gamma')
  })
})
