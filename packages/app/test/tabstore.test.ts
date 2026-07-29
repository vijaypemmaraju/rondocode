import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tabGet, tabHasOwn, tabRemove, tabSet } from '../src/session/tabstore'

/* ------------------------------------------------------------------------- *
 * Two tabs, two projects.
 *
 * The bug was structural: the active project id and the editor buffer were
 * single localStorage keys, which every tab on the origin shares. Whichever
 * tab you typed in last owned both, and boot then reconciled "the buffer is
 * the freshest copy of the active project" — one project's code into another.
 *
 * A TAB here is a sessionStorage instance; localStorage is the shared one.
 * That is exactly the browser's own model, so these tests reproduce the real
 * failure rather than a paraphrase of it.
 * ------------------------------------------------------------------------- */

class FakeStorage {
  private readonly m = new Map<string, string>()
  getItem = (k: string): string | null => this.m.get(k) ?? null
  setItem = (k: string, v: string): void => void this.m.set(k, v)
  removeItem = (k: string): void => void this.m.delete(k)
}

const g = globalThis as Record<string, unknown>
let shared: FakeStorage

/** Switch to a different TAB: a fresh sessionStorage over the same
 *  localStorage, which is what opening a second tab actually gives you. */
const openTab = (): FakeStorage => {
  const ss = new FakeStorage()
  g['sessionStorage'] = ss
  return ss
}

/** Go back to a tab opened earlier — its sessionStorage is still that tab. */
const switchTo = (ss: FakeStorage): void => {
  g['sessionStorage'] = ss
}

beforeEach(() => {
  shared = new FakeStorage()
  g['localStorage'] = shared
  openTab()
})

afterEach(() => {
  delete g['sessionStorage']
  delete g['localStorage']
})

describe('a tab owns its own value', () => {
  it('seeds from the shared value the first time, so a new tab resumes', () => {
    shared.setItem('active', 'proj-a')
    expect(tabGet('active')).toBe('proj-a')
  })

  it('ADOPTS on that first read, so a later shared write cannot move it', () => {
    shared.setItem('active', 'proj-a')
    expect(tabGet('active')).toBe('proj-a')
    shared.setItem('active', 'proj-b') // another tab switched projects
    expect(tabGet('active')).toBe('proj-a') // this tab stays put
  })

  it('adopts a MISS too — the case that would otherwise keep following', () => {
    // a tab that has not written yet must not inherit whatever the other tab
    // does next; without marking the miss it would read through forever
    expect(tabGet('active')).toBeNull()
    expect(tabHasOwn('active')).toBe(true)
    shared.setItem('active', 'proj-b')
    expect(tabGet('active')).toBeNull()
  })

  it('a write stays local, and refreshes the seed for the NEXT tab', () => {
    tabSet('active', 'proj-a')
    expect(tabGet('active')).toBe('proj-a')
    expect(shared.getItem('active')).toBe('proj-a') // the seed moved
  })
})

describe('the two-tab bug itself', () => {
  it('two tabs on two projects keep their own active project', () => {
    const tab1 = openTab()
    tabSet('active', 'proj-a')
    const tab2 = openTab()
    tabSet('active', 'proj-b')
    expect(tabGet('active')).toBe('proj-b')
    switchTo(tab1)
    expect(tabGet('active')).toBe('proj-a') // tab 2 did not move it
    switchTo(tab2)
    expect(tabGet('active')).toBe('proj-b') // nor did looking at tab 1
  })

  it('the BUFFER does not cross tabs, which is what corrupted a project', () => {
    const tab1 = openTab()
    tabSet('doc', 'the-a-project-code')
    const tab2 = openTab()
    tabSet('doc', 'the-b-project-code')
    switchTo(tab1)
    // typing in tab 2 does not rewrite what tab 1 is holding — this is the
    // exact overwrite the boot reconcile then turned into a lost project
    expect(tabGet('doc')).toBe('the-a-project-code')
    switchTo(tab2)
    expect(tabGet('doc')).toBe('the-b-project-code')
  })

  it('a RELOAD keeps a tab on its own project, not the last-touched one', () => {
    const tab1 = openTab()
    tabSet('active', 'proj-a')
    openTab()
    tabSet('active', 'proj-b') // the other tab moves on
    switchTo(tab1) // reload tab 1: same sessionStorage, fresh module state
    expect(tabGet('active')).toBe('proj-a')
  })

  it('a third tab opened later starts from the most recent, not the oldest', () => {
    tabSet('active', 'proj-a')
    openTab()
    tabSet('active', 'proj-b')
    openTab()
    expect(tabGet('active')).toBe('proj-b')
  })
})

describe('storage that refuses', () => {
  it('falls back to the shared value rather than losing the project', () => {
    // private mode: no sessionStorage at all. The old shared behaviour is the
    // worst case, and it is strictly better than an app that cannot boot.
    delete g['sessionStorage']
    shared.setItem('active', 'proj-a')
    expect(tabGet('active')).toBe('proj-a')
    expect(tabHasOwn('active')).toBe(false)
    expect(() => tabSet('active', 'proj-c')).not.toThrow()
    expect(shared.getItem('active')).toBe('proj-c')
  })

  it('survives a quota rejection on either store', () => {
    const boom = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    g['sessionStorage'] = boom
    expect(() => tabSet('active', 'x')).not.toThrow()
    expect(() => tabGet('active')).not.toThrow()
  })

  it('removes from both, so a cleared project does not come back as a seed', () => {
    tabSet('active', 'proj-a')
    tabRemove('active')
    expect(tabGet('active')).toBeNull()
    expect(shared.getItem('active')).toBeNull()
  })
})
