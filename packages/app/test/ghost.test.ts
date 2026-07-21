import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { ghostEligible } from '../src/editor/ghost'

/* Pure eligibility logic for the ghost-text trigger. The DOM/fetch/timer
 * paths are exercised by hand in the browser; here we pin the gate that
 * decides whether we even ask for a completion. */

const stateAt = (doc: string, head: number): EditorState =>
  EditorState.create({ doc, selection: { anchor: head } })

describe('ghostEligible', () => {
  it('is true at the end of a non-empty line', () => {
    const doc = "p('bass', n('0 3'))"
    expect(ghostEligible(stateAt(doc, doc.length))).toBe(true)
  })

  it('is false mid-line (cursor not at line end)', () => {
    const doc = "p('bass', n('0 3'))"
    expect(ghostEligible(stateAt(doc, 5))).toBe(false)
  })

  it('is false on a blank line', () => {
    const doc = 'a\n\nb'
    expect(ghostEligible(stateAt(doc, 2))).toBe(false) // the empty middle line
  })

  it('is false with a non-empty selection', () => {
    const doc = 'sine(440)'
    const st = EditorState.create({ doc, selection: { anchor: 0, head: doc.length } })
    expect(ghostEligible(st)).toBe(false)
  })

  it('is true at end of the last line even without a trailing newline', () => {
    const doc = 'const x = 1\nconst y = 2'
    expect(ghostEligible(stateAt(doc, doc.length))).toBe(true)
  })
})
