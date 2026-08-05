/* ------------------------------------------------------------------------- *
 * Projects + version history — the persistent library behind the editor.
 *
 * Client-side only (per-device): projects and their version snapshots live in
 * IndexedDB; there is no backend. Two seams keep the domain logic honest and
 * testable:
 *   - `Db` is the entire storage surface the store needs (two object stores,
 *     get/put/delete/all). `IdbDb` is the runtime backend; `MemoryDb` (below)
 *     backs the unit tests, so all the versioning/dedup/cap rules are exercised
 *     without a real IndexedDB.
 *   - `now`/`uid` are injected so tests get deterministic ids and timestamps
 *     (production defaults to Date.now + crypto.randomUUID).
 *
 * A Project holds the CURRENT working code (the live buffer). A Version is an
 * immutable snapshot taken on a successful run (or manually). Autosave updates
 * a project's code without adding history; only `snapshot()` grows the timeline.
 * ------------------------------------------------------------------------- */

export interface Project {
  id: string
  name: string
  code: string
  /** which language `code` is written in. Absent on legacy records — callers
   *  sniff (a rondo doc compiles as rondo; a JS doc doesn't). */
  lang?: 'rondocode' | 'rondo'
  createdAt: number
  updatedAt: number
}

export interface Version {
  id: string
  projectId: string
  code: string
  createdAt: number
  /** Optional human label ("before the drop"); auto-snapshots have none. */
  label?: string
}

/** What a compare-and-set autosave did. `conflict` carries the record as it
 *  actually is, so the caller can keep BOTH versions rather than pick one. */
export type SaveOutcome =
  | { kind: 'saved'; updatedAt: number }
  | { kind: 'unchanged'; updatedAt: number }
  | { kind: 'conflict'; theirs: Project }
  | { kind: 'gone' }

/** A sample that belongs to a project: a mic take, a resampled loop, or a file
 *  the user dropped in. Kept because the alternative is what it used to be —
 *  takes lived only for the session, so `sample(gate, 'take1')` in a SAVED
 *  file could not play the next morning. The audio is the same Float32 PCM the
 *  engine holds; structured clone stores a typed array as-is, so nothing is
 *  encoded or lost on the way in. */
export interface StoredSample {
  id: string
  projectId: string
  /** the name programs address it by (`take1`, `mic2`, a file's stem) */
  name: string
  data: Float32Array
  sampleRate: number
  createdAt: number
}

export type StoreName = 'projects' | 'versions' | 'samples'

/** The minimal async storage the store needs — no indexes: version sets per
 *  project are small, so we filter in memory. Both backends implement this. */
export interface Db {
  all<T>(store: StoreName): Promise<T[]>
  get<T>(store: StoreName, id: string): Promise<T | undefined>
  put(store: StoreName, value: Project | Version | StoredSample): Promise<void>
  del(store: StoreName, id: string): Promise<void>
}

export interface ProjectStoreOpts {
  now?: () => number
  uid?: () => string
  /** Cap on auto-snapshots kept per project (oldest evicted first). Labeled
   *  snapshots are never evicted — they were kept on purpose. */
  maxVersions?: number
}

const byUpdatedDesc = (a: Project, b: Project): number => b.updatedAt - a.updatedAt

/** Resolve a project by exact name from a listProjects() result (which is
 *  updatedAt-descending, so a duplicate name resolves to the freshest one).
 *  Pure: onboarding replay uses this to decide "reopen welcome" vs "recreate". */
export const findProjectNamed = <T extends { name: string }>(
  projects: readonly T[],
  name: string,
): T | undefined => projects.find((p) => p.name === name)
const byCreatedDesc = (a: Version, b: Version): number => b.createdAt - a.createdAt

export class ProjectStore {
  private now: () => number
  private uid: () => string
  private maxVersions: number

  constructor(
    private db: Db,
    opts: ProjectStoreOpts = {},
  ) {
    this.now = opts.now ?? Date.now
    this.uid = opts.uid ?? (() => crypto.randomUUID())
    this.maxVersions = opts.maxVersions ?? 100
  }

  async listProjects(): Promise<Project[]> {
    const all = await this.db.all<Project>('projects')
    return all.sort(byUpdatedDesc)
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.db.get<Project>('projects', id)
  }

  /** Create a project and take an initial snapshot of its code. */
  async createProject(name: string, code: string, lang?: 'rondocode' | 'rondo'): Promise<Project> {
    const t = this.now()
    const project: Project = { id: this.uid(), name, code, createdAt: t, updatedAt: t }
    if (lang !== undefined) project.lang = lang
    await this.db.put('projects', project)
    await this.snapshot(project.id, code)
    return project
  }

  /** Record which language a project is written in (the editor's toggle).
   *
   *  Returns the new `updatedAt`, or undefined when nothing was written. EVERY
   *  method that moves updatedAt has to hand it back: a caller tracking a base
   *  version for compare-and-set (see saveCode) would otherwise be stale the
   *  moment it renames or re-languages its own project, and its next autosave
   *  would read as a foreign write. */
  async setProjectLang(id: string, lang: 'rondocode' | 'rondo'): Promise<number | undefined> {
    const p = await this.getProject(id)
    if (!p || p.lang === lang) return undefined
    const updatedAt = this.now()
    await this.db.put('projects', { ...p, lang, updatedAt })
    return updatedAt
  }

  /** Rename in place. Returns the new `updatedAt` (see setProjectLang). */
  async renameProject(id: string, name: string): Promise<number | undefined> {
    const p = await this.getProject(id)
    if (!p) return undefined
    const updatedAt = this.now()
    await this.db.put('projects', { ...p, name, updatedAt })
    return updatedAt
  }

  /** Copy a project (code + a fresh "copy" name) into a new one. History is
   *  NOT copied — the copy starts its own timeline from the current code. */
  async duplicateProject(id: string): Promise<Project | undefined> {
    const p = await this.getProject(id)
    if (!p) return undefined
    return this.createProject(`${p.name} copy`, p.code, p.lang)
  }

  async deleteProject(id: string): Promise<void> {
    const versions = await this.listVersions(id)
    for (const v of versions) await this.db.del('versions', v.id)
    // its samples go with it: an orphaned take is megabytes nobody can reach
    for (const s of await this.listSamples(id)) await this.db.del('samples', s.id)
    await this.db.del('projects', id)
  }

  /** The samples belonging to `projectId`, oldest first. */
  async listSamples(projectId: string): Promise<StoredSample[]> {
    const all = await this.db.all<StoredSample>('samples')
    return all.filter((s) => s.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Store (or replace) one sample for a project. Replacing is by NAME, not
   *  id: reloading `take1` after re-rendering it has to overwrite the take
   *  programs already refer to, not leave two rows fighting over the name. */
  async putSample(
    projectId: string,
    name: string,
    data: Float32Array,
    sampleRate: number,
  ): Promise<StoredSample> {
    const existing = (await this.listSamples(projectId)).find((s) => s.name === name)
    const rec: StoredSample = {
      id: existing?.id ?? this.uid(),
      projectId,
      name,
      data,
      sampleRate,
      createdAt: existing?.createdAt ?? this.now(),
    }
    await this.db.put('samples', rec)
    return rec
  }

  /** Forget one sample of a project, by the name programs address it by. */
  async deleteSample(projectId: string, name: string): Promise<void> {
    for (const s of await this.listSamples(projectId)) {
      if (s.name === name) await this.db.del('samples', s.id)
    }
  }

  /**
   * Autosave path: update the working code + updatedAt. Does NOT snapshot.
   *
   * `expect` is the `updatedAt` this caller last saw. Pass it and the write
   * becomes a compare-and-set: if the record has moved since, ANOTHER TAB
   * wrote it, and blindly putting would erase their edit with ours. The store
   * refuses and hands back what it found, because only the caller can decide
   * what to do about it — and doing nothing is the one option that is always
   * wrong.
   *
   * Omit `expect` and it is the old last-write-wins put, which is correct for
   * the single-tab case and for callers that have just read the record.
   */
  async saveCode(id: string, code: string, expect?: number): Promise<SaveOutcome> {
    const p = await this.getProject(id)
    if (!p) return { kind: 'gone' }
    if (expect !== undefined && p.updatedAt !== expect) return { kind: 'conflict', theirs: p }
    if (p.code === code) return { kind: 'unchanged', updatedAt: p.updatedAt }
    const updatedAt = this.now()
    await this.db.put('projects', { ...p, code, updatedAt })
    return { kind: 'saved', updatedAt }
  }

  async listVersions(id: string): Promise<Version[]> {
    const all = await this.db.all<Version>('versions')
    return all.filter((v) => v.projectId === id).sort(byCreatedDesc)
  }

  /** Add a snapshot IF the code differs from the newest existing one (dedup),
   *  then evict the oldest UNLABELED snapshots past the cap. Returns the new
   *  version, or undefined when deduped away. */
  async snapshot(id: string, code: string, label?: string): Promise<Version | undefined> {
    const versions = await this.listVersions(id) // newest first
    if (versions.length && versions[0]!.code === code && label === undefined) return undefined
    const version: Version = { id: this.uid(), projectId: id, code, createdAt: this.now(), label }
    await this.db.put('versions', version)
    await this.evict(id)
    return version
  }

  private async evict(id: string): Promise<void> {
    const versions = await this.listVersions(id) // newest first
    const unlabeled = versions.filter((v) => v.label === undefined)
    const excess = unlabeled.length - this.maxVersions
    if (excess <= 0) return
    // drop the oldest unlabeled ones (tail of the desc list)
    for (const v of unlabeled.slice(unlabeled.length - excess)) await this.db.del('versions', v.id)
  }

  /** Restore a version's code as the project's working code. Snapshots the
   *  CURRENT code first (if it differs), so restoring is itself undoable.
   *  Returns the restored code for the caller to load into the editor. */
  async restore(id: string, versionId: string): Promise<string | undefined> {
    const p = await this.getProject(id)
    if (!p) return undefined
    const versions = await this.listVersions(id)
    const target = versions.find((v) => v.id === versionId)
    if (!target) return undefined
    if (p.code !== target.code) await this.snapshot(id, p.code)
    this.lastRestoreAt = this.now()
    await this.db.put('projects', { ...p, code: target.code, updatedAt: this.lastRestoreAt })
    return target.code
  }

  /** The `updatedAt` the last restoreVersion wrote — restoreVersion returns the
   *  CODE, so this is how a caller tracking a base version picks up its own
   *  write without a re-read. */
  lastRestoreAt: number | undefined
}

/* ---- in-memory backend (tests, and a safe fallback if IDB is unavailable) --- */

export class MemoryDb implements Db {
  private stores: Record<StoreName, Map<string, Project | Version | StoredSample>> = {
    projects: new Map(),
    versions: new Map(),
    samples: new Map(),
  }

  async all<T>(store: StoreName): Promise<T[]> {
    return [...this.stores[store].values()].map((v) => structuredClone(v)) as T[]
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    const v = this.stores[store].get(id)
    return v === undefined ? undefined : (structuredClone(v) as T)
  }

  async put(store: StoreName, value: Project | Version | StoredSample): Promise<void> {
    this.stores[store].set(value.id, structuredClone(value))
  }

  async del(store: StoreName, id: string): Promise<void> {
    this.stores[store].delete(id)
  }
}
