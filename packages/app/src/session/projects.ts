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

export type StoreName = 'projects' | 'versions'

/** The minimal async storage the store needs — no indexes: version sets per
 *  project are small, so we filter in memory. Both backends implement this. */
export interface Db {
  all<T>(store: StoreName): Promise<T[]>
  get<T>(store: StoreName, id: string): Promise<T | undefined>
  put(store: StoreName, value: Project | Version): Promise<void>
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

  /** Record which language a project is written in (the editor's toggle). */
  async setProjectLang(id: string, lang: 'rondocode' | 'rondo'): Promise<void> {
    const p = await this.getProject(id)
    if (!p || p.lang === lang) return
    await this.db.put('projects', { ...p, lang, updatedAt: this.now() })
  }

  async renameProject(id: string, name: string): Promise<void> {
    const p = await this.getProject(id)
    if (!p) return
    await this.db.put('projects', { ...p, name, updatedAt: this.now() })
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
    await this.db.del('projects', id)
  }

  /** Autosave path: update the working code + updatedAt. Does NOT snapshot. */
  async saveCode(id: string, code: string): Promise<void> {
    const p = await this.getProject(id)
    if (!p || p.code === code) return
    await this.db.put('projects', { ...p, code, updatedAt: this.now() })
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
    await this.db.put('projects', { ...p, code: target.code, updatedAt: this.now() })
    return target.code
  }
}

/* ---- in-memory backend (tests, and a safe fallback if IDB is unavailable) --- */

export class MemoryDb implements Db {
  private stores: Record<StoreName, Map<string, Project | Version>> = {
    projects: new Map(),
    versions: new Map(),
  }

  async all<T>(store: StoreName): Promise<T[]> {
    return [...this.stores[store].values()].map((v) => structuredClone(v)) as T[]
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    const v = this.stores[store].get(id)
    return v === undefined ? undefined : (structuredClone(v) as T)
  }

  async put(store: StoreName, value: Project | Version): Promise<void> {
    this.stores[store].set(value.id, structuredClone(value))
  }

  async del(store: StoreName, id: string): Promise<void> {
    this.stores[store].delete(id)
  }
}
