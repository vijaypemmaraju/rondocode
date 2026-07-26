import { afterEach, describe, expect, it } from 'vitest'
import { markPhase, clearPhase, takeCrashReport, DONE_PHASE } from '../src/sing/bakephase'

/* Crash-point telemetry for the vocal bake (see bakephase.ts): iOS kills an
 * out-of-memory tab with NO error, so the bake writes its current phase to
 * localStorage at every stage boundary. On the next boot, a leftover marker
 * that never reached 'done' IS the crash report. */

/** Minimal localStorage stub backed by a Map. */
function stubStorage(): Map<string, string> {
  const m = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  }
  return m
}

/** localStorage where every call throws (private mode / storage blocked). */
function throwingStorage(): void {
  const boom = (): never => {
    throw new Error('storage denied')
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: boom, setItem: boom, removeItem: boom }
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('takeCrashReport', () => {
  it('returns null on a fresh boot (no marker)', () => {
    stubStorage()
    expect(takeCrashReport()).toBeNull()
  })

  it('returns the dead bake phase + timestamp when the marker never reached done', () => {
    stubStorage()
    const before = Date.now()
    markPhase('create:aligner')
    const report = takeCrashReport()
    expect(report?.phase).toBe('create:aligner')
    expect(report?.when).toBeGreaterThanOrEqual(before)
  })

  it('reports the LAST phase written (the crash point, not an earlier stage)', () => {
    stubStorage()
    markPhase('download:vocoder')
    markPhase('rvc')
    expect(takeCrashReport()?.phase).toBe('rvc')
  })

  it('clears the marker on read: one report per crash', () => {
    const m = stubStorage()
    markPhase('align')
    expect(takeCrashReport()).not.toBeNull()
    expect(m.size).toBe(0)
    expect(takeCrashReport()).toBeNull()
  })

  it('treats the terminal done marker as a clean bake (null, and cleared)', () => {
    const m = stubStorage()
    markPhase(DONE_PHASE)
    expect(takeCrashReport()).toBeNull()
    expect(m.size).toBe(0)
  })

  it('returns null after clearPhase (successful completion)', () => {
    stubStorage()
    markPhase('rvc')
    clearPhase()
    expect(takeCrashReport()).toBeNull()
  })

  it('returns null on malformed stored data instead of throwing', () => {
    const m = stubStorage()
    m.set('rc.singPhase', 'not json {')
    expect(takeCrashReport()).toBeNull()
    m.set('rc.singPhase', JSON.stringify({ when: 5 })) // no phase string
    expect(takeCrashReport()).toBeNull()
  })

  it('defaults a missing/bad timestamp to 0', () => {
    const m = stubStorage()
    m.set('rc.singPhase', JSON.stringify({ phase: 'align' }))
    expect(takeCrashReport()).toEqual({ phase: 'align', when: 0 })
  })
})

describe('blocked storage (all three are safe no-ops)', () => {
  it('markPhase / clearPhase / takeCrashReport never throw', () => {
    throwingStorage()
    expect(() => markPhase('align')).not.toThrow()
    expect(() => clearPhase()).not.toThrow()
    expect(takeCrashReport()).toBeNull()
  })

  it('everything is also safe with NO localStorage at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(() => markPhase('align')).not.toThrow()
    expect(() => clearPhase()).not.toThrow()
    expect(takeCrashReport()).toBeNull()
  })
})
