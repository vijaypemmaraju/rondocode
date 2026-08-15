import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { syntaxTree } from '@codemirror/language'
import { StreamLanguage } from '@codemirror/language'
import { scrubLitAt as scrubLitAtRaw } from '../src/editor/widgets/scrub'
import { detect } from '../src/editor/widgets/detect'

/* A budget that cannot run out. The production one is 50ms, which is generous
 * in an editor and not generous under a suite running a worker per core: this
 * file flaked on it once, finding no number because the parse it asked for did
 * not finish in time. A wall-clock budget in a correctness test measures the
 * machine. */
const scrubLitAt = (state: Parameters<typeof scrubLitAtRaw>[0], pos: number): ReturnType<typeof scrubLitAtRaw> =>
  scrubLitAtRaw(state, pos, 60_000)

/* ------------------------------------------------------------------------- *
 * Scrubbing a number in a long document.
 *
 * `syntaxTree` returns only what has been parsed so far, and the initial parse
 * runs on a time budget: a bare state stops at 3007 characters however long the
 * document is. `detect` walks that tree, so past the boundary it finds NO
 * numbers, and the plain-text fallback does not cover it (that is gated on the
 * grammar, so a JavaScript document stays on the tree path).
 *
 * Measured in a browser, this does not bite today: CodeMirror parses the
 * viewport and you can only point at what you can see. A number 3392 characters
 * in was underlined within 400ms of load. So this is the guarantee made
 * explicit rather than a bug being closed -- the interaction no longer depends
 * on a viewport pass nobody asked it to depend on.
 * ------------------------------------------------------------------------- */

const PAST_BUDGET = 8000
const pad = `// ${'x'.repeat(60)}\n`.repeat(Math.ceil(PAST_BUDGET / 64))
const js = (doc: string): EditorState => EditorState.create({ doc, extensions: [javascript()] })

describe('the parse budget', () => {
  it('really does stop short, which is the whole premise', () => {
    const doc = `${pad}setCps(0.5)\n`
    const state = js(doc)
    expect(doc.length).toBeGreaterThan(3007)
    expect(syntaxTree(state).length, 'if this ever covers the doc, the tests below prove nothing')
      .toBeLessThan(doc.length)
  })

  it('and `detect` on that short tree finds nothing past it', () => {
    const doc = `${pad}setCps(0.5)\n`
    const state = js(doc)
    const nums = detect(doc, syntaxTree(state)).numbers
    expect(nums.filter((n) => n.from > 3007), 'the raw path, for contrast').toEqual([])
  })
})

describe('scrubLitAt', () => {
  it('finds a number past the budget boundary', () => {
    const doc = `${pad}setCps(0.5)\n`
    const at = doc.lastIndexOf('0.5')
    expect(at).toBeGreaterThan(3007)
    expect(scrubLitAt(js(doc), at)?.value).toBe(0.5)
  })

  it('finds one in a short document too, unchanged', () => {
    const doc = 'setCps(0.5)\n'
    expect(scrubLitAt(js(doc), doc.indexOf('0.5'))?.value).toBe(0.5)
  })

  it('returns null where there is no number', () => {
    const doc = `${pad}setCps(0.5)\n`
    expect(scrubLitAt(js(doc), doc.lastIndexOf('setCps'))).toBeNull()
  })

  it('still refuses digits inside a mini-notation string', () => {
    /* The rule the grammar gate protects: a JS document whose only digits are
     * pattern steps must keep them non-scrubbable, or dragging a note number
     * would rewrite the music. Forcing the parse must not weaken it. */
    const doc = `${pad}p('a', n('0 3 5 7'))\n`
    expect(scrubLitAt(js(doc), doc.lastIndexOf('3'))).toBeNull()
  })

  it('falls back to a text scan for rondo, past the boundary as well', () => {
    // a StreamLanguage tree is not 'Script', so the text path applies
    const rondo = StreamLanguage.define({ token: (s) => { s.next(); return null } })
    const doc = `${'# comment padding padding padding padding padding\n'.repeat(200)}synth a\n  svf 1234\n`
    expect(doc.length).toBeGreaterThan(3007)
    const state = EditorState.create({ doc, extensions: [rondo] })
    expect(scrubLitAt(state, doc.lastIndexOf('1234'))?.value).toBe(1234)
  })
})

describe('the production budget, not the test one', () => {
  /* The override above buys load-independence and costs coverage: with every
   * call passing 60s, nothing here would notice `PARSE_BUDGET_MS` being set to
   * zero, and the editor would quietly stop finding numbers past the initial
   * parse. Confirmed by sabotage -- that mutation survived until this test.
   *
   * So one case goes through the DEFAULT, on a document just past the 3007
   * boundary. That parses in about a millisecond, so 50ms is fifty times the
   * headroom, which is enough to be load-independent without being a promise
   * about the machine. */
  it('finds a number past the boundary on the real default', () => {
    /* 20k, because doc LENGTH is not the precondition -- what matters is that
     * the initial parse actually stopped short of the cursor, and for a small
     * document it does not. The first version of this test used 4k, where the
     * parse covers everything, so it exercised nothing and a zero budget
     * survived the sabotage. Measured, 20k parses cold in 1.8ms, so 50ms is
     * still twenty-five times the headroom. */
    const doc = `${`// ${'x'.repeat(60)}\n`.repeat(320)}setCps(0.5)\n`
    const at = doc.lastIndexOf('0.5')
    const state = js(doc)
    expect(syntaxTree(state).length, 'the initial parse must fall short, or this proves nothing')
      .toBeLessThan(at)
    // NB: scrubLitAtRaw, so the default budget is the one under test
    expect(scrubLitAtRaw(state, at)?.value).toBe(0.5)
  })
})
