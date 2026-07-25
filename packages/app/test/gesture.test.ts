import { describe, expect, it } from 'vitest'
import { LiveWriter, attachGesture, verifiedChanges } from '../src/editor/rondo/gesture'
import type { Drag, WriteHost } from '../src/editor/rondo/gesture'

/* The widget gesture protocol's pure parts: write-verify (live + deferred)
 * and the single-flight / pointer-filter / lifecycle plumbing, exercised
 * against a fake document and a fake element. */

/** A minimal doc the writers can edit for real. */
function host(initial: string): WriteHost & { text: () => string } {
  let doc = initial
  return {
    state: {
      get doc() {
        return { sliceString: (a: number, b: number) => doc.slice(a, b) }
      },
    },
    dispatch: (spec) => {
      const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
      // apply back-to-front so earlier offsets stay valid
      for (const c of [...list].sort((x, y) => y.from - x.from)) {
        doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to)
      }
    },
    text: () => doc,
  }
}

describe('LiveWriter (live per-move rewrites with write-verify)', () => {
  it('serially rewrites one range, tracking its moving end', () => {
    const h = host('cutoff = knob 800 80..8000')
    const w = new LiveWriter(h, 14, 17) // '800'
    expect(w.write('1200')).toBe(true)
    expect(h.text()).toBe('cutoff = knob 1200 80..8000')
    expect(w.write('95')).toBe(true)
    expect(h.text()).toBe('cutoff = knob 95 80..8000')
    expect(w.to).toBe(16)
  })

  it('permanently aborts on a concurrent edit instead of splicing garbage', () => {
    const h = host('adsr .003 .2 .3 .1')
    const w = new LiveWriter(h, 5, 18)
    expect(w.write('0.01 .2 .3 .1')).toBe(true)
    // someone else edits under the gesture
    h.dispatch({ changes: { from: 0, to: 4, insert: 'envX' } })
    const before = h.text()
    expect(w.write('0.02 .2 .3 .1')).toBe(true) // range text still matches → fine
    // now corrupt the range itself
    h.dispatch({ changes: { from: 5, to: 6, insert: 'Z' } })
    const corrupted = h.text()
    expect(w.write('0.03 .2 .3 .1')).toBe(false)
    expect(h.text()).toBe(corrupted) // no write happened
    expect(w.write('0.04 .2 .3 .1')).toBe(false) // and it stays aborted
    expect(before.length).toBeGreaterThan(0)
  })

  it('skips the dispatch when the text is unchanged (no no-op transactions)', () => {
    const h = host('0 3 5')
    let dispatches = 0
    const orig = h.dispatch.bind(h)
    h.dispatch = (spec) => { dispatches++; orig(spec) }
    const w = new LiveWriter(h, 0, 5)
    expect(w.write('0 3 5')).toBe(true)
    expect(dispatches).toBe(0)
  })
})

describe('verifiedChanges (deferred commit-at-end splices)', () => {
  it('applies multiple ranges when every expected text still holds', () => {
    const h = host('kick ~ kick ~\n~ hat ~ hat')
    const ok = verifiedChanges(h, [
      { from: 0, to: 13, expected: 'kick ~ kick ~', insert: 'kick kick kick ~' },
      { from: 14, to: 25, expected: '~ hat ~ hat', insert: 'hat ~ ~ hat' },
    ])
    expect(ok).toBe(true)
    expect(h.text()).toBe('kick kick kick ~\nhat ~ ~ hat')
  })

  it('drops the WHOLE write when any range is stale', () => {
    const h = host('kick ~ kick ~\n~ hat ~ hat')
    const before = h.text()
    const ok = verifiedChanges(h, [
      { from: 0, to: 13, expected: 'kick ~ kick ~', insert: 'x' },
      { from: 14, to: 25, expected: 'SOMETHING ELSE', insert: 'y' },
    ])
    expect(ok).toBe(false)
    expect(h.text()).toBe(before)
  })
})

/** A fake element: enough EventTarget for attachGesture, with manual firing. */
function fakeEl(): HTMLElement & { fire: (type: string, ev: Partial<PointerEvent>) => void } {
  const handlers = new Map<string, Set<(e: Event) => void>>()
  const el = {
    addEventListener: (t: string, fn: (e: Event) => void) => {
      if (!handlers.has(t)) handlers.set(t, new Set())
      handlers.get(t)!.add(fn)
    },
    removeEventListener: (t: string, fn: (e: Event) => void) => handlers.get(t)?.delete(fn),
    setPointerCapture: () => {},
    fire: (t: string, ev: Partial<PointerEvent>) => {
      const e = { pointerId: 1, preventDefault: () => {}, stopPropagation: () => {}, ...ev }
      for (const fn of [...(handlers.get(t) ?? [])]) fn(e as unknown as Event)
    },
  }
  return el as unknown as HTMLElement & { fire: (type: string, ev: Partial<PointerEvent>) => void }
}

describe('attachGesture (single-flight, pointer filter, lifecycle)', () => {
  it('runs one gesture: begin → moves → end, and drag.active spans it exactly', () => {
    const el = fakeEl()
    const drag: Drag = { active: false, ended: false }
    const log: string[] = []
    attachGesture(el, drag, 'element', () => ({
      onMove: () => log.push(`move active=${drag.active}`),
      onEnd: () => log.push(`end active=${drag.active}`),
    }))
    el.fire('pointerdown', { pointerId: 1 })
    expect(drag.active).toBe(true)
    el.fire('pointermove', { pointerId: 1 })
    el.fire('pointerup', { pointerId: 1 })
    expect(drag.active).toBe(false)
    // active is already false inside onEnd, so end-writes rebuild via drag.ended
    expect(log).toEqual(['move active=true', 'end active=false'])
    // listeners detached: further moves do nothing
    el.fire('pointermove', { pointerId: 1 })
    expect(log).toHaveLength(2)
  })

  it('SINGLE-FLIGHT: a second pointerdown during a gesture is ignored', () => {
    const el = fakeEl()
    const drag: Drag = { active: false, ended: false }
    let begins = 0
    attachGesture(el, drag, 'element', () => { begins++; return {} })
    el.fire('pointerdown', { pointerId: 1 })
    el.fire('pointerdown', { pointerId: 2 }) // second finger
    expect(begins).toBe(1)
    el.fire('pointerup', { pointerId: 1 })
    el.fire('pointerdown', { pointerId: 2 }) // after release it's allowed
    expect(begins).toBe(2)
  })

  it("POINTER FILTER: another pointer's moves and ups never reach the gesture", () => {
    const el = fakeEl()
    const drag: Drag = { active: false, ended: false }
    const log: string[] = []
    attachGesture(el, drag, 'element', () => ({
      onMove: () => log.push('move'),
      onEnd: () => log.push('end'),
    }))
    el.fire('pointerdown', { pointerId: 1 })
    el.fire('pointermove', { pointerId: 2 }) // stray finger
    el.fire('pointerup', { pointerId: 2 }) // must NOT end the gesture
    expect(drag.active).toBe(true)
    expect(log).toEqual([])
    el.fire('pointercancel', { pointerId: 1 })
    expect(log).toEqual(['end'])
    expect(drag.active).toBe(false)
  })

  it('a rejected begin (null) leaves everything untouched', () => {
    const el = fakeEl()
    const drag: Drag = { active: false, ended: false }
    attachGesture(el, drag, 'element', () => null)
    el.fire('pointerdown', { pointerId: 1 })
    expect(drag.active).toBe(false)
  })
})
