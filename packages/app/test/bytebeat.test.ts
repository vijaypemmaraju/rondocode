import { describe, expect, it } from 'vitest'
import { compile, decompile } from '@rondocode/rondo'
import { renderOffline } from '@rondocode/engine'
import { BYTEBEAT_EXAMPLES } from '../src/examples/bytebeat'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

describe('bytebeat integration', () => {
  it('compiles native Rondo formulas with clock modulation and mode options', () => {
    const c = compile(`synth bits
  clock = knob 8192 2000..16000
  bytebeat "t * ((t >> 10) & 7)" rate:clock mode:byte
  * adsr .01 .01 1 .03
  * .3

play bits
  c3
  slow 16
`)
    expect(c.ok, JSON.stringify(c)).toBe(true)
    if (!c.ok) return
    const result = evalCode(c.code, baseScope)
    expect(result.diagnostics).toEqual([])
    expect(result.synths.get('bits')?.graph.nodes.find(n => n.type === 'bytebeat')?.config)
      .toEqual({ expression: 't * ((t >> 10) & 7)', mode: 'byte' })
  })

  for (const example of BYTEBEAT_EXAMPLES) {
    it(`${example.name} renders audible finite audio, stages visuals and converts to Rondo`, () => {
      const staged = evalCode(example.code, baseScope)
      expect(staged.ok).toBe(true)
      expect(staged.visual).toContain('fn render(uv: vec2f) -> vec4f')
      expect(staged.visual).toContain('waveform(')
      const roundTrip = compile(decompile(example.code))
      expect(roundTrip.ok, JSON.stringify(roundTrip)).toBe(true)
      if (roundTrip.ok) {
        const converted = evalCode(roundTrip.code, baseScope)
        expect(converted.diagnostics).toEqual([])
        expect(converted.visual).toBe(staged.visual)
        expect([...converted.synths.values()].map(s => s.graph)).toEqual([...staged.synths.values()].map(s => s.graph))
      }
      for (const def of staged.synths.values()) {
        const audio = renderOffline(def, [{ type: 'noteOn', time: 0, note: 60 }], 2)
        expect(audio.left.every(Number.isFinite)).toBe(true)
        const rms = Math.sqrt(audio.left.reduce((sum, x) => sum + x * x, 0) / audio.left.length)
        expect(rms).toBeGreaterThan(0.001)
      }
    })
  }
})
