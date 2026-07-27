import { describe, expect, it } from 'vitest'
import { clearSegCache } from '../src/sing/neural'

/* The shared-speech cache is exercised end to end by the harmony path; here we
 * pin the part that is testable without the models: the cache is clearable and
 * the module exposes it (a language or model change must be able to drop it). */

describe('shared speech cache', () => {
  it('exposes a clear for model/language changes', () => {
    expect(typeof clearSegCache).toBe('function')
    expect(() => { clearSegCache(); clearSegCache() }).not.toThrow()
  })
})
