import { describe, expect, it } from 'vitest'
import { ChangeSet, EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { diffChanges, formatJsSource } from '../src/editor/format'
import { SHIPPED_EXAMPLES } from '../src/examples'
import { evalCode } from '../src/session/evalCode'
import { baseScope } from '../src/session/scope'

/* The editor-side formatting seam:
 *   - diffChanges must produce MINIMAL per-line changes whose application
 *     yields exactly the target text — this is what lets a whole-doc format
 *     keep undo history, decorations and the cursor alive (a full-buffer
 *     replace would not).
 *   - formatJsSource is prettier standalone in the repo house style; a
 *     formatted example must eval exactly like the original (the smoke gate).
 * The rondo formatter itself is fuzz-gated in packages/rondo/test/format.test.ts. */

/** Apply diffChanges' output the way the editor does. */
const apply = (a: string, b: string): string => {
  const changes = diffChanges(a, b)
  return EditorState.create({ doc: a }).update({ changes }).state.doc.toString()
}

describe('diffChanges', () => {
  it('returns [] for identical docs', () => {
    expect(diffChanges('a\nb\n', 'a\nb\n')).toEqual([])
  })

  const cases: [string, string, string][] = [
    ['indent fix', '   saw\n', '  saw\n'],
    ['line inserted', 'a\nc\n', 'a\nb\nc\n'],
    ['line deleted', 'a\nb\nc\n', 'a\nc\n'],
    ['middle rewrite', 'a\nXX\nc\n', 'a\nYY\nc\n'],
    ['last line, no trailing newline', 'a\nbb', 'a\ncc'],
    ['first line', 'XX\nb\n', 'YY\nb\n'],
    ['append at end', 'a\n', 'a\nb\n'],
    ['delete to empty', 'a\nb\n', ''],
    ['grow from empty', '', 'a\nb\n'],
    ['trailing newline added', 'a', 'a\n'],
    ['trailing newline removed', 'a\n', 'a'],
    ['blank lines collapsed', 'a\n\n\n\nb\n', 'a\n\nb\n'],
  ]
  for (const [name, a, b] of cases) {
    it(`round-trips: ${name}`, () => {
      expect(apply(a, b)).toBe(b)
    })
  }

  it('round-trips arbitrary line soups (fuzz)', () => {
    // mulberry32
    let s = 0xf0f0f0f0
    const rnd = (): number => {
      s |= 0
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const word = (): string => ['saw', '  saw', 'gain: .8', '', '0 3 5', '# hm', 'a  =  1'][Math.floor(rnd() * 7)]!
    for (let iter = 0; iter < 500; iter++) {
      const n = Math.floor(rnd() * 12)
      const al: string[] = []
      for (let i = 0; i < n; i++) al.push(word())
      // mutate: drop/insert/replace lines
      const bl = al.filter(() => rnd() > 0.25).map((l) => (rnd() < 0.3 ? word() : l))
      if (rnd() < 0.5) bl.splice(Math.floor(rnd() * (bl.length + 1)), 0, word())
      const a = al.join('\n')
      const b = bl.join('\n')
      expect(apply(a, b), `iter ${iter}\n--- a ---\n${a}\n--- b ---\n${b}`).toBe(b)
    }
  })

  it('touches only the changed characters (an indent fix leaves the word alone)', () => {
    const a = 'synth a\n      saw\n  env = adsr .01 .1 .5 .1\n'
    const b = 'synth a\n  saw\n  env = adsr .01 .1 .5 .1\n'
    const changes = diffChanges(a, b)
    expect(changes).toHaveLength(1)
    const c = changes[0]!
    // the hunk lies inside line 2's leading whitespace: 'saw' itself untouched
    expect(a.slice(c.from, c.to)).toMatch(/^[ ]*$/)
    expect(c.insert).toMatch(/^[ ]*$/)
  })

  it('leaves untouched lines out of every change range', () => {
    const a = 'cps .5\n\nsynth a\n      saw\n\nplay a\n  0 3   5\n'
    const b = 'cps .5\n\nsynth a\n  saw\n\nplay a\n  0 3 5\n'
    const changes = diffChanges(a, b)
    // line 3 ('synth a') must not intersect any change
    const from = a.indexOf('synth a')
    const to = from + 'synth a'.length
    for (const c of changes) expect(c.to <= from || c.from >= to).toBe(true)
  })

  it('maps the cursor through the ChangeSet onto the same text', () => {
    const a = 'synth a\n      saw\n  cutoff = knob 800 80..8000\n'
    const b = 'synth a\n  saw\n  cutoff = knob 800 80..8000\n'
    const cs = ChangeSet.of(diffChanges(a, b), a.length)
    // cursor sitting on 'knob' (line 3, untouched) stays on 'knob'
    const pos = a.indexOf('knob')
    expect(b.slice(cs.mapPos(pos), cs.mapPos(pos) + 4)).toBe('knob')
    // cursor at the end of the re-indented 'saw' line stays at that line end
    const sawEnd = a.indexOf('saw') + 3
    expect(cs.mapPos(sawEnd)).toBe(b.indexOf('saw') + 3)
  })

  it('a formatting transaction is a single undo step back to the original', () => {
    const a = 'synth a\n      saw\n\n\n\nplay a\n  gain:.8\n'
    const b = 'synth a\n  saw\n\nplay a\n  gain: .8\n'
    let st = EditorState.create({ doc: a, extensions: [history()] })
    st = st.update({ changes: diffChanges(a, b), userEvent: 'format' }).state
    expect(st.doc.toString()).toBe(b)
    let undone: EditorState | null = null
    undo({ state: st, dispatch: (tr) => { undone = tr.state } })
    expect(undone).not.toBeNull()
    expect(undone!.doc.toString()).toBe(a)
  })
})

describe('formatJsSource (prettier, house style)', () => {
  it('formats to the repo example style: no semis, single quotes, 2-space, bare arrows', async () => {
    const out = await formatJsSource('const x = "a";\nconst f = (y) => { return y; };\n')
    expect(out).toBe("const x = 'a'\nconst f = y => {\n  return y\n}\n")
  })

  it('returns null on unparseable source (never mangles broken code)', async () => {
    expect(await formatJsSource('const = = nope(')).toBe(null)
  })

  it('is idempotent on the shipped examples', async () => {
    for (const ex of SHIPPED_EXAMPLES.slice(0, 3)) {
      const once = await formatJsSource(ex.code)
      expect(once).not.toBe(null)
      expect(await formatJsSource(once!)).toBe(once)
    }
  })

  it('smoke: a formatted example evals clean and its patterns still sound', async () => {
    for (const ex of SHIPPED_EXAMPLES.slice(0, 3)) {
      const formatted = await formatJsSource(ex.code)
      expect(formatted, ex.name).not.toBe(null)
      const before = evalCode(ex.code, baseScope)
      const after = evalCode(formatted!, baseScope)
      expect(after.ok, ex.name).toBe(true)
      expect(after.diagnostics.filter((d) => d.severity === 'error'), ex.name).toEqual([])
      expect([...after.synths.keys()].sort()).toEqual([...before.synths.keys()].sort())
      expect([...after.patterns.keys()].sort()).toEqual([...before.patterns.keys()].sort())
      // sounding events intact: same onset count per pattern over 2 cycles
      const span = new TimeSpan(F(0), F(2))
      const sounding = (r: typeof before, name: string): number =>
        r.patterns.get(name)!.query(span).filter(hasOnset).filter(
          (h) => typeof h.value.note === 'number' && typeof h.value.sound === 'string',
        ).length
      for (const [name] of before.patterns) {
        expect(sounding(after, name), `${ex.name} pattern '${name}'`).toBe(sounding(before, name))
      }
    }
  })
})
