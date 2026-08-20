import { describe, it, expect } from 'vitest'
import { DDSP_MODELS, ensureDdspModels, primeDdspModel, ddspModelNamesInGraph, ddspModelUrl } from '../src/audio/ddspModels'
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
