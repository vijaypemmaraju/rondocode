import { describe, expect, it } from 'vitest'
import { sampleNamesIn, synth, usesMicIn } from '../src/index'

/* What a graph needs from OUTSIDE itself: a sample bank, or an input device.
 *
 * An offline render has neither, so those voices are digital zero — and the
 * headless scripts used to report "wrote out.wav" over exactly that, with the
 * only explanation in a comment three files away. These two walks are what let
 * a renderer say WHY a file is silent, and what stops the audio sweep from
 * flagging a working example as broken.
 *
 * The app asks the same question for a different reason (whether to request
 * microphone permission) and reads the same walk — see synthsUseMic. */

describe('sampleNamesIn', () => {
  it('finds the sample a sample() voice plays', () => {
    const s = synth(({ gate, sample }) => sample(gate, 'break'))
    expect(sampleNamesIn(s.graph)).toEqual(['break'])
  })

  it('finds the sample a granular() cloud plays', () => {
    const s = synth(({ gate, granular }) => granular(gate, 'pad', { size: 0.2 }))
    expect(sampleNamesIn(s.graph)).toEqual(['pad'])
  })

  it('reports each name ONCE, however many voices play it', () => {
    const s = synth(({ gate, sample }) => sample(gate, 'break').add(sample(gate, 'break')))
    expect(sampleNamesIn(s.graph)).toEqual(['break'])
  })

  it('collects every distinct name', () => {
    const s = synth(({ gate, sample, granular }) => sample(gate, 'vox').add(granular(gate, 'riser')))
    expect(sampleNamesIn(s.graph).sort()).toEqual(['riser', 'vox'])
  })

  it('is empty for a synth that plays no samples — the common case', () => {
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)))
    expect(sampleNamesIn(s.graph)).toEqual([])
  })
})

describe('usesMicIn', () => {
  it('is true for a graph that reads the microphone', () => {
    const s = synth(({ mic, svf }) => svf(mic(), 800))
    expect(usesMicIn(s.graph)).toBe(true)
  })

  it('is false for one that does not', () => {
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)))
    expect(usesMicIn(s.graph)).toBe(false)
  })

  it('sees a mic in a POST chain too, not only the voice', () => {
    // the post chain is a separate graph; a caller checking only .graph would
    // miss a vocoder fed from the mic downstream of the voices
    const s = synth(({ note, gate, adsr, saw }) => saw(note.freq).mul(adsr(gate)), ({ input, mic }) => input.add(mic()))
    expect(usesMicIn(s.graph)).toBe(false)
    expect(s.post).toBeDefined()
    expect(usesMicIn(s.post!)).toBe(true)
  })
})
