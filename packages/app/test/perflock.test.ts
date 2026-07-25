import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { isLocked, lockExtension } from '../src/editor/perflock'

/* The performance lock's contract: user editing off, EVERYTHING programmatic
 * still on. Exercised headlessly on EditorState (no DOM needed) through the
 * same compartment-reconfigure path the header button uses. */

const mk = (locked: boolean, comp = new Compartment()): EditorState =>
  EditorState.create({ doc: 'cutoff = knob 800 80..8000', extensions: [comp.of(lockExtension(locked))] })

describe('performance lock', () => {
  it('unlocked: buffer is editable, not locked', () => {
    const st = mk(false)
    expect(st.facet(EditorView.editable)).toBe(true)
    expect(isLocked(st)).toBe(false)
  })

  it('locked: editable off, isLocked reports it', () => {
    const st = mk(true)
    expect(st.facet(EditorView.editable)).toBe(false)
    expect(isLocked(st)).toBe(true)
  })

  it('locked is NOT readOnly: history/undo chips and commands stay willing', () => {
    // readOnly would make @codemirror/commands history refuse — the lock
    // must block fingers, not programmatic edits
    expect(mk(true).readOnly).toBe(false)
  })

  it('widget rewrites still apply while locked (programmatic dispatch path)', () => {
    const st = mk(true)
    const tr = st.update({ changes: { from: 14, to: 17, insert: '1200' } })
    expect(tr.state.doc.toString()).toBe('cutoff = knob 1200 80..8000')
  })

  it('the compartment toggles the lock in place, both directions', () => {
    const comp = new Compartment()
    let st = mk(false, comp)
    st = st.update({ effects: comp.reconfigure(lockExtension(true)) }).state
    expect(isLocked(st)).toBe(true)
    st = st.update({ effects: comp.reconfigure(lockExtension(false)) }).state
    expect(isLocked(st)).toBe(false)
  })
})
