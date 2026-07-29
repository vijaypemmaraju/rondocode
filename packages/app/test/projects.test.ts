import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryDb, ProjectStore } from '../src/session/projects'

/* Domain rules for the projects/history store, exercised against MemoryDb.
 * now/uid are injected so ids and timestamps are deterministic: uid is a
 * counter ("v1", "v2", …) and the clock only ticks when a test calls tick(). */

const makeStore = (opts: { maxVersions?: number } = {}) => {
  let clock = 1000
  let seq = 0
  const store = new ProjectStore(new MemoryDb(), {
    now: () => clock,
    uid: () => `id${++seq}`,
    maxVersions: opts.maxVersions,
  })
  return { store, tick: (by = 1) => (clock += by) }
}

describe('ProjectStore projects', () => {
  it('remembers a project language: at creation, via setProjectLang, and through duplicate', async () => {
    const { store } = makeStore()
    const p = await store.createProject('tune', 'synth s\n  saw\n', 'rondo')
    expect((await store.getProject(p.id))!.lang).toBe('rondo')
    await store.setProjectLang(p.id, 'rondocode')
    expect((await store.getProject(p.id))!.lang).toBe('rondocode')
    const copy = (await store.duplicateProject(p.id))!
    expect((await store.getProject(copy.id))!.lang).toBe('rondocode')
    // legacy record: no lang at all — stays undefined for the caller to sniff
    const legacy = await store.createProject('old', 'const x = 1')
    expect((await store.getProject(legacy.id))!.lang).toBeUndefined()
  })

  it('creates a project with an initial snapshot and lists it', async () => {
    const { store } = makeStore()
    const p = await store.createProject('untitled', 'n("0 3")')
    expect(p.name).toBe('untitled')
    expect(p.code).toBe('n("0 3")')
    expect(await store.listProjects()).toHaveLength(1)
    const versions = await store.listVersions(p.id)
    expect(versions).toHaveLength(1) // initial snapshot
    expect(versions[0]!.code).toBe('n("0 3")')
  })

  it('lists projects newest-updated first', async () => {
    const { store, tick } = makeStore()
    const a = await store.createProject('a', 'x')
    tick()
    const b = await store.createProject('b', 'y')
    tick()
    await store.saveCode(a.id, 'x2') // touches a → most recent
    const names = (await store.listProjects()).map((p) => p.name)
    expect(names).toEqual(['a', 'b'])
    expect(b).toBeDefined()
  })

  it('renames without touching code', async () => {
    const { store } = makeStore()
    const p = await store.createProject('old', 'code')
    await store.renameProject(p.id, 'new')
    const got = await store.getProject(p.id)
    expect(got!.name).toBe('new')
    expect(got!.code).toBe('code')
  })

  it('duplicates code under a new name with a fresh timeline', async () => {
    const { store } = makeStore()
    const p = await store.createProject('song', 'melody')
    await store.snapshot(p.id, 'melody v2', 'checkpoint')
    const copy = await store.duplicateProject(p.id)
    expect(copy!.name).toBe('song copy')
    expect(copy!.code).toBe('melody') // current working code, not the label
    // copy has only its own initial snapshot, not the original's history
    expect(await store.listVersions(copy!.id)).toHaveLength(1)
  })

  it('deletes a project and its versions', async () => {
    const { store } = makeStore()
    const p = await store.createProject('doomed', 'code')
    await store.snapshot(p.id, 'code2')
    await store.deleteProject(p.id)
    expect(await store.getProject(p.id)).toBeUndefined()
    expect(await store.listVersions(p.id)).toHaveLength(0)
  })
})

describe('ProjectStore history', () => {
  it('snapshots only when code changed (dedup)', async () => {
    const { store, tick } = makeStore()
    const p = await store.createProject('p', 'a') // initial snapshot 'a'
    expect(await store.snapshot(p.id, 'a')).toBeUndefined() // same → deduped
    tick()
    expect(await store.snapshot(p.id, 'b')).toBeDefined()
    expect((await store.listVersions(p.id)).map((v) => v.code)).toEqual(['b', 'a'])
  })

  it('keeps a labeled snapshot even when it equals the latest code', async () => {
    const { store } = makeStore()
    const p = await store.createProject('p', 'a')
    const v = await store.snapshot(p.id, 'a', 'named') // dedup skipped for labels
    expect(v).toBeDefined()
    expect(v!.label).toBe('named')
  })

  it('caps unlabeled snapshots at maxVersions, evicting oldest', async () => {
    const { store, tick } = makeStore({ maxVersions: 3 })
    const p = await store.createProject('p', 'v0') // 1 snapshot
    for (let i = 1; i <= 5; i++) {
      tick()
      await store.snapshot(p.id, `v${i}`)
    }
    const versions = await store.listVersions(p.id)
    expect(versions).toHaveLength(3) // capped
    expect(versions.map((v) => v.code)).toEqual(['v5', 'v4', 'v3']) // newest kept
  })

  it('never evicts labeled snapshots', async () => {
    const { store, tick } = makeStore({ maxVersions: 2 })
    const p = await store.createProject('p', 'v0')
    await store.snapshot(p.id, 'v0-keep', 'important') // labeled
    for (let i = 1; i <= 4; i++) {
      tick()
      await store.snapshot(p.id, `v${i}`)
    }
    const labels = (await store.listVersions(p.id)).filter((v) => v.label).map((v) => v.label)
    expect(labels).toContain('important')
  })

  it('restore sets working code and snapshots the current code first', async () => {
    const { store, tick } = makeStore()
    const p = await store.createProject('p', 'first')
    tick()
    await store.saveCode(p.id, 'second') // working code moved on, no snapshot
    const versions = await store.listVersions(p.id)
    const firstVersion = versions.find((v) => v.code === 'first')!
    tick()
    const restored = await store.restore(p.id, firstVersion.id)
    expect(restored).toBe('first')
    expect((await store.getProject(p.id))!.code).toBe('first')
    // 'second' was preserved as a snapshot before restoring
    expect((await store.listVersions(p.id)).some((v) => v.code === 'second')).toBe(true)
  })

  it('saveCode is a no-op when code is unchanged', async () => {
    const { store } = makeStore()
    const p = await store.createProject('p', 'same')
    const before = (await store.getProject(p.id))!.updatedAt
    await store.saveCode(p.id, 'same')
    expect((await store.getProject(p.id))!.updatedAt).toBe(before)
  })
})

/* ------------------------------------------------------------------------- *
 * Two tabs on the SAME project.
 *
 * Scoping the active project per tab stopped two tabs from fighting over which
 * project is open; it cannot stop you opening one project twice. Then both
 * tabs autosave to one record and the later write erases the earlier one with
 * no trace, which is the part that actually loses work.
 *
 * `expect` turns the autosave into a compare-and-set. A TAB here is just a
 * remembered `updatedAt` — which is exactly what a tab is, as far as the store
 * can tell.
 * ------------------------------------------------------------------------- */
describe('ProjectStore autosave: two tabs, one project', () => {
  it('a normal save advances the version it hands back', async () => {
    const { store, tick } = makeStore()
    const p = await store.createProject('tune', 'a')
    tick()
    const r = await store.saveCode(p.id, 'b', p.updatedAt)
    expect(r).toEqual({ kind: 'saved', updatedAt: 1001 })
    expect((await store.getProject(p.id))!.code).toBe('b')
  })

  it('an unchanged save is not a conflict, and keeps the version', async () => {
    // both tabs idling on the same text must not fork each other forever
    const { store } = makeStore()
    const p = await store.createProject('tune', 'a')
    expect(await store.saveCode(p.id, 'a', p.updatedAt)).toEqual({ kind: 'unchanged', updatedAt: p.updatedAt })
  })

  it('REFUSES a write over another tab’s, and hands back what it found', async () => {
    const { store, tick } = makeStore()
    const p = await store.createProject('tune', 'a')
    const tab1 = p.updatedAt
    const tab2 = p.updatedAt

    tick()
    expect(await store.saveCode(p.id, 'tab1 edit', tab1)).toMatchObject({ kind: 'saved' })

    tick()
    const r = await store.saveCode(p.id, 'tab2 edit', tab2)
    expect(r.kind).toBe('conflict')
    // the loser gets the winner's record, so it can keep BOTH versions
    if (r.kind === 'conflict') expect(r.theirs.code).toBe('tab1 edit')
    // and nothing was overwritten
    expect((await store.getProject(p.id))!.code).toBe('tab1 edit')
  })

  it('the same tab can keep saving after its own write', async () => {
    const { store, tick } = makeStore()
    const p = await store.createProject('tune', 'a')
    let v = p.updatedAt
    for (const code of ['b', 'c', 'd']) {
      tick()
      const r = await store.saveCode(p.id, code, v)
      expect(r.kind).toBe('saved')
      if (r.kind === 'saved') v = r.updatedAt
    }
    expect((await store.getProject(p.id))!.code).toBe('d')
  })

  it('a deleted project reports gone rather than resurrecting itself', async () => {
    const { store } = makeStore()
    const p = await store.createProject('tune', 'a')
    await store.deleteProject(p.id)
    expect(await store.saveCode(p.id, 'b', p.updatedAt)).toEqual({ kind: 'gone' })
    expect(await store.getProject(p.id)).toBeUndefined()
  })

  it('without an expectation it is the old last-write-wins put', async () => {
    // the single-tab path, and every caller that just read the record
    const { store, tick } = makeStore()
    const p = await store.createProject('tune', 'a')
    tick()
    await store.saveCode(p.id, 'other tab', p.updatedAt)
    tick()
    expect(await store.saveCode(p.id, 'blind')).toMatchObject({ kind: 'saved' })
    expect((await store.getProject(p.id))!.code).toBe('blind')
  })
})
