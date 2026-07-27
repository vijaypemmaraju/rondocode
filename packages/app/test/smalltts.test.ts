import { describe, expect, it } from 'vitest'
import { SUPERTONIC_BASE, TTS_INT8_MODELS, supertonicModelUrls } from '../src/sing/config'
import { takeCount } from '../src/sing/neural'

/* The small-TTS selection + fallback contract (PR: phones get int8 builds of
 * the two big Supertonic models): the sequential (constrained-device) path
 * prefers the int8 URL from SING_MODELS_BASE, the fp32 HuggingFace URL is
 * ALWAYS the fallback (so a not-yet-uploaded int8 build can never brick
 * singing), models without a validated int8 build stay fp32 everywhere, and
 * desktop stays fp32. Mirrors test/smallaligner.test.ts. */

describe('supertonicModelUrls', () => {
  it('prefers the int8 build with the fp32 build as fallback on the sequential path', () => {
    for (const name of ['vector_estimator', 'vocoder']) {
      const urls = supertonicModelUrls(name, true)
      expect(urls).toHaveLength(2)
      expect(urls[0]!.endsWith(`/tts_${name}-int8.onnx`)).toBe(true)
      expect(urls[1]).toBe(`${SUPERTONIC_BASE}/onnx/${name}.onnx`)
    }
  })

  it('models without a validated int8 build stay fp32 even on the sequential path', () => {
    for (const name of ['duration_predictor', 'text_encoder']) {
      expect(supertonicModelUrls(name, true)).toEqual([`${SUPERTONIC_BASE}/onnx/${name}.onnx`])
    }
  })

  it('desktop (not sequential) uses only the fp32 build for every model', () => {
    for (const name of ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder']) {
      expect(supertonicModelUrls(name, false)).toEqual([`${SUPERTONIC_BASE}/onnx/${name}.onnx`])
    }
  })

  it('exactly the two big models carry an int8 build', () => {
    expect([...TTS_INT8_MODELS].sort()).toEqual(['vector_estimator', 'vocoder'])
  })
})

describe('takeCount', () => {
  it('is 1 on the sequential (phone) path - takes are synthesized up front there, so best-of-N multiplies peak memory', () => {
    expect(takeCount(true)).toBe(1)
  })

  it('keeps best-of-3 on desktop', () => {
    expect(takeCount(false)).toBe(3)
  })
})
