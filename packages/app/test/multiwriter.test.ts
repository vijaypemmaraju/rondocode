import { describe, expect, it } from 'vitest'
import { MultiLiveWriter } from '../src/editor/rondo/gesture'
import type { WriteHost } from '../src/editor/rondo/gesture'

/* A param declared in both a synth body and its post chain is ONE control at
 * runtime. Two independent knobs let the declarations drift, and then the two
 * halves scale the same value differently — silently. So a drag must move all
 * of them, LIVE, which means surviving the thing that broke the wavedef
 * editor: a rewrite whose length changes shifts every offset after it. */

/** A fake document the writer can edit for real. */
function host(initial: string): WriteHost & { text: () => string } {
  let doc = initial
  const state = {
    get doc() {
      return {
        toString: () => doc,
        get length() { return doc.length },
        sliceString: (a: number, b: number) => doc.slice(a, b),
      }
    },
  }
  return {
    get state() { return state as unknown as WriteHost['state'] },
    dispatch: (tr: { changes?: unknown }) => {
      const cs = (Array.isArray(tr.changes) ? tr.changes : [tr.changes]) as {
        from: number; to: number; insert: string
      }[]
      // apply against ORIGINAL positions, like CodeMirror does
      for (const c of [...cs].sort((a, b) => b.from - a.from)) {
        doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to)
      }
    },
    text: () => doc,
  } as WriteHost & { text: () => string }
}

const SRC = "bright = knob 1480 500..7300\n  post\n    bright = knob 1480 500..7300"
const ranges = (s: string): { from: number; to: number }[] => {
  const out: { from: number; to: number }[] = []
  const re = /knob (\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) out.push({ from: m.index + 5, to: m.index + 5 + m[1]!.length })
  return out
}

describe('MultiLiveWriter', () => {
  it('writes every declaration in one go', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    expect(w.write('2000')).toBe(true)
    expect(h.text().match(/knob 2000/g)).toHaveLength(2)
  })

  it('survives a SHORTER value, which shifts everything after it', () => {
    // 1480 -> 900 moves the second declaration back a character. Writing them
    // one at a time would splice the wrong chars on the second.
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    expect(w.write('900')).toBe(true)
    expect(h.text()).toBe("bright = knob 900 500..7300\n  post\n    bright = knob 900 500..7300")
  })

  it('survives a LONGER value', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    expect(w.write('12345')).toBe(true)
    expect(h.text()).toBe("bright = knob 12345 500..7300\n  post\n    bright = knob 12345 500..7300")
  })

  it('keeps tracking across MANY writes, as a drag does', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    for (const v of ['900', '1200', '7', '58000', '1480']) expect(w.write(v)).toBe(true)
    expect(h.text()).toBe(SRC) // back where it started, no drift
  })

  it('aborts when the document moved underneath, rather than splicing blind', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    h.dispatch({ changes: { from: 0, to: 0, insert: 'x'.repeat(20) } }) // someone else edited
    expect(w.write('900')).toBe(false)
    expect(h.text()).toContain('knob 1480') // untouched
  })

  it('stays aborted once aborted', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    h.dispatch({ changes: { from: 0, to: 0, insert: 'xxxxx' } })
    expect(w.write('900')).toBe(false)
    expect(w.write('900')).toBe(false)
  })

  it('a single range behaves exactly like the old single writer', () => {
    const one = "knob 1480"
    const h = host(one)
    const w = new MultiLiveWriter(h, [{ from: 5, to: 9 }])
    expect(w.write('42')).toBe(true)
    expect(h.text()).toBe('knob 42')
    expect(w.text).toBe("42")
  })

  it('is a no-op when the text already matches', () => {
    const h = host(SRC)
    const w = new MultiLiveWriter(h, ranges(SRC))
    expect(w.write('1480')).toBe(true)
    expect(h.text()).toBe(SRC)
  })
})
