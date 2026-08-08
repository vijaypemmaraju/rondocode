import { describe, expect, it } from 'vitest'
import { micDeviceIn, synth } from '@rondocode/engine'
import { compile } from '@rondocode/rondo'
import { synthsMicDevice } from '../src/session/evalCode'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The in-code half of device selection: the app setting says what your rig
 * is, the code says what THIS project needs, and resolveDevice decides
 * between them (code wins). This pins the part that carries the name from the
 * source to the host — the graph itself never reads it, because the capture
 * is opened on the main thread.
 *
 * BOTH LANGUAGES now. `mic device:` in rondo was written and reverted once:
 * giving `mic` a named argument changed how the parser bound a FOLLOWING
 * `name:value`, so the shipped live-mic example (`vocoder mic bands:24`)
 * started attributing `bands:` to `mic`. The parser now binds a named arg to
 * the nearest call that ACCEPTS THAT NAME, which was the real fix. */

const staged = (src: string): ReturnType<typeof evalCode> => {
  const c = compile(src)
  expect(c.ok, c.ok ? '' : JSON.stringify(c.errors)).toBe(true)
  if (!c.ok) throw new Error('compile failed')
  const r = evalCode(c.code, baseScope)
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  return r
}

describe('micDeviceIn', () => {
  it('finds the device a mic node names', () => {
    const s = synth(({ mic }) => mic({ device: 'scarlett' }))
    expect(micDeviceIn(s.graph)).toBe('scarlett')
  })

  it('is undefined for a bare mic, and for a graph with no mic at all', () => {
    expect(micDeviceIn(synth(({ mic }) => mic()).graph)).toBeUndefined()
    expect(micDeviceIn(synth(({ saw, note }) => saw(note.freq)).graph)).toBeUndefined()
  })

  it('ignores an empty name rather than asking for a device called ""', () => {
    expect(micDeviceIn(synth(({ mic }) => mic({ device: '' })).graph)).toBeUndefined()
  })
})

describe('synthsMicDevice (what the app hands the audio session)', () => {
  it('carries a device named through the JS API into the staged synths', () => {
    const r = evalCode("const v = synth(({ mic, noisegate }) => noisegate(mic({ device: 'scarlett' }), { threshold: -38 }))\np('v', note('c3').sound('v'))\nsetCps(0.5)", baseScope)
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(synthsMicDevice(r.synths)).toBe('scarlett')
  })

  it('carries a rondo `mic device:` through compile and eval', () => {
    const r = staged('synth v\n  mic device:scarlett\n  noisegate threshold:-38\n\nplay v\n  c3\n  dur: .99\n\ncps .5\n')
    expect(synthsMicDevice(r.synths)).toBe('scarlett')
  })

  it('does not steal a named arg from the call wrapped around it', () => {
    // the regression that forced the first revert
    // vocoder needs a carrier from the running signal, hence the supersaw line
    const src = 'synth v\n  supersaw detune:.4\n  vocoder mic device:motu bands:24\n\nplay v\n  c3\n\ncps .5\n'
    const r = staged(src)
    expect(synthsMicDevice(r.synths), 'mic kept its own device').toBe('motu')
    const c = compile(src)
    expect(c.ok && c.code.includes('{ bands: 24 }'), 'the vocoder kept bands:').toBe(true)
    expect(c.ok && c.code.includes("{ detune: 0.4 }"), 'the supersaw kept detune:').toBe(true)
  })

  it('is undefined when nothing names a device', () => {
    const r = staged('synth v\n  mic\n\nplay v\n  c3\n\ncps .5\n')
    expect(synthsMicDevice(r.synths)).toBeUndefined()
  })
})

