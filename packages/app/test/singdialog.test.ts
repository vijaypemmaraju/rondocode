import { describe, expect, it } from 'vitest'
import { ERROR_DISMISS_MS, singDialogNext } from '../src/ui/singDialogState'
import type { SingDialogEvent, SingDialogMode } from '../src/ui/singDialogState'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* The bake dialog's ERROR state is the only state a user needs to dismiss, and
 * it shipped without any way to do it. The transition rules are pure (this
 * suite has no DOM), so drive them directly. */

/** Replay a sequence of events and return the final mode. */
const run = (...evs: SingDialogEvent['kind'][]): SingDialogMode => {
  let mode: SingDialogMode = 'hidden'
  for (const kind of evs) mode = singDialogNext(mode, { kind } as SingDialogEvent).mode
  return mode
}

describe('sing dialog transitions', () => {
  it('an error shows the card and arms the auto-dismiss backstop', () => {
    const next = singDialogNext('hidden', { kind: 'error' })
    expect(next.mode).toBe('error')
    expect(next.armTimer).toBe(ERROR_DISMISS_MS)
  })

  it('dismissing hides the card AND cancels the pending timer', () => {
    // without clearTimer, the stale timeout would hide the NEXT error early
    const next = singDialogNext('error', { kind: 'dismiss' })
    expect(next.mode).toBe('hidden')
    expect(next.clearTimer).toBe(true)
    expect(next.armTimer).toBe(0)
  })

  it('the error outlives the idle event that follows a failed bake', () => {
    // singMgr reports progress:null right after a failure; treating that as
    // "hide" made the error card flash and vanish
    expect(run('error', 'idle')).toBe('error')
    expect(singDialogNext('error', { kind: 'idle' }).clearTimer).toBe(false)
  })

  it('Escape dismisses only an error, and is left for the editor otherwise', () => {
    const onError = singDialogNext('error', { kind: 'escape' })
    expect(onError.mode).toBe('hidden')
    expect(onError.handled).toBe(true)

    for (const mode of ['baking', 'hidden'] as const) {
      const next = singDialogNext(mode, { kind: 'escape' })
      expect(next.mode).toBe(mode) // unchanged
      expect(next.handled).toBe(false) // so the editor still sees the key
    }
  })

  it('a new bake replaces an error with progress, and idle then hides', () => {
    expect(run('error', 'progress')).toBe('baking')
    expect(run('error', 'progress', 'idle')).toBe('hidden')
  })

  it('the backstop fires to hidden', () => {
    expect(run('error', 'timeout')).toBe('hidden')
  })

  it('the auto-dismiss window is long enough to read a message', () => {
    // errors carry up to ~140 chars of detail; 8s was not enough to read one
    expect(ERROR_DISMISS_MS).toBeGreaterThanOrEqual(20_000)
  })
})

describe('sing dialog markup and styling', () => {
  const dir = join(__dirname, '../src/ui')
  const ts = readFileSync(join(dir, 'singDialog.ts'), 'utf8')
  const css = readFileSync(join(dir, 'singDialog.css'), 'utf8')

  it('renders a close button wired to the dismiss transition', () => {
    expect(ts).toContain('class="sing-close"')
    expect(ts).toMatch(/closeBtn\.addEventListener\('click'/)
  })

  it("the error card takes pointer events, or its close button is dead", () => {
    // .sing-dialog is pointer-events: none so a running bake never blocks the
    // editor. That is the exact reason a button in it could not be clicked.
    expect(css).toMatch(/\.sing-dialog\s*\{[^}]*pointer-events:\s*none/)
    expect(css).toMatch(/\.sing-dialog\.sing-error\s+\.sing-card\s*\{[^}]*pointer-events:\s*auto/)
  })

  it('an error waiting to be read does not dim the whole app', () => {
    expect(css).toMatch(/\.sing-dialog\.sing-error\s*\{[^}]*background:\s*transparent/)
  })

  it('the close affordance is error-only and thumb-sized', () => {
    expect(css).toMatch(/\.sing-close\s*\{[^}]*display:\s*none/)
    expect(css).toMatch(/\.sing-dialog\.sing-error\s+\.sing-close\s*\{[^}]*display:\s*block/)
    const box = /\.sing-close\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(box).toMatch(/width:\s*3[0-9]px/)
    expect(box).toMatch(/height:\s*3[0-9]px/)
  })
})
