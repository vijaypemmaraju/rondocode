import { describe, it, expect } from 'vitest'
import {
  DDSP_MODELS,
  ensureDdspModels,
  primeDdspModel,
  primeDdspBody,
  parseWav16Mono,
  ddspModelNamesInGraph,
  ddspModelUrl,
} from '../src/audio/ddspModels'
import { ENUM_VALUE_TABLE } from '../src/editor/rondo/enums'

describe('ddsp model plumbing', () => {
  it('the editor enum cycle IS the shipped model list (pinned, both directions)', () => {
    expect(ENUM_VALUE_TABLE['ddsp']?.pos?.[0]).toEqual([...DDSP_MODELS])
  })

  it('model URLs follow the ddsp-<name>.bin convention under /ddsp/v1', () => {
    expect(ddspModelUrl('violin')).toMatch(/\/ddsp\/v1\/ddsp-violin\.bin$|\/ddsp-violin\.bin$/)
  })

  it('finds ddsp model names in a graph and nowhere else', () => {
    const graph = {
      nodes: [
        { type: 'ddsp', config: { model: 'violin' } },
        { type: 'ddsp', config: { model: 'custom-cello' } },
        { type: 'modal', config: { model: 'bell' } }, // modal's model is NOT a ddsp model
        { type: 'sine' },
      ],
    }
    // every ddsp node's name, shipped or not — the fetcher filters to shipped
    expect(ddspModelNamesInGraph(graph as never)).toEqual(['violin', 'custom-cello'])
    expect(ddspModelNamesInGraph({ nodes: [{ type: 'modal', config: { model: 'bell' } }] } as never)).toEqual([])
  })

  it('parseWav16Mono round-trips a 16-bit mono wav and rejects junk', () => {
    const n = 64
    const sr = 48000
    const bytes = new Uint8Array(44 + n * 2)
    const dv = new DataView(bytes.buffer)
    dv.setUint32(0, 0x52494646, false) // RIFF
    dv.setUint32(4, 36 + n * 2, true)
    dv.setUint32(8, 0x57415645, false) // WAVE
    dv.setUint32(12, 0x666d7420, false) // fmt
    dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true) // PCM
    dv.setUint16(22, 1, true) // mono
    dv.setUint32(24, sr, true)
    dv.setUint32(28, sr * 2, true)
    dv.setUint16(32, 2, true)
    dv.setUint16(34, 16, true)
    dv.setUint32(36, 0x64617461, false) // data
    dv.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 5) * 20000), true)
    const parsed = parseWav16Mono(bytes)
    expect(parsed).not.toBeNull()
    expect(parsed!.sampleRate).toBe(sr)
    expect(parsed!.data.length).toBe(n)
    expect(parsed!.data[5]!).toBeCloseTo(Math.round(Math.sin(1) * 20000) / 32768, 4)
    expect(parseWav16Mono(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })

  it('delivers primed body IRs alongside the model', () => {
    primeDdspModel('flute', new Uint8Array([9]))
    primeDdspBody('flute', Float32Array.from([0.5, -0.5]), 48000)
    const got: string[] = []
    ensureDdspModels(
      ['flute'],
      (name) => got.push(name),
      (sampleName, data, sr) => {
        got.push(sampleName)
        expect(data.length).toBe(2)
        expect(sr).toBe(48000)
      },
    )
    expect(got).toEqual(['flute', 'flutebody'])
  })

  it('delivers primed bytes without network, ignores non-shipped names', () => {
    const bytes = new Uint8Array([1, 2, 3])
    primeDdspModel('violin', bytes)
    const got: string[] = []
    ensureDdspModels(['violin', 'custom-cello', 'violin'], (name, b) => {
      got.push(name)
      expect(b).toBe(bytes)
    })
    expect(got).toEqual(['violin']) // deduped, and custom-cello never fetched
  })
})
