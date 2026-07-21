/* ------------------------------------------------------------------------- *
 * IndexedDB backend for the project store (browser runtime only — the store's
 * logic is tested against MemoryDb, so this thin wrapper stays untested here).
 *
 * One database, two object stores keyed by `id`. No indexes: the store filters
 * versions by projectId in memory (per-project sets are small). openIdb()
 * resolves to an IdbDb, or throws if IndexedDB is missing/blocked — callers
 * fall back to MemoryDb so the app still runs (just without persistence).
 * ------------------------------------------------------------------------- */

import type { Db, Project, StoreName, Version } from './projects'

const DB_NAME = 'rondocode'
const DB_VERSION = 1
const STORES: StoreName[] = ['projects', 'versions']

const promisify = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

export class IdbDb implements Db {
  constructor(private idb: IDBDatabase) {}

  private tx(store: StoreName, mode: IDBTransactionMode): IDBObjectStore {
    return this.idb.transaction(store, mode).objectStore(store)
  }

  async all<T>(store: StoreName): Promise<T[]> {
    return promisify(this.tx(store, 'readonly').getAll() as IDBRequest<T[]>)
  }

  async get<T>(store: StoreName, id: string): Promise<T | undefined> {
    return promisify(this.tx(store, 'readonly').get(id) as IDBRequest<T | undefined>)
  }

  async put(store: StoreName, value: Project | Version): Promise<void> {
    await promisify(this.tx(store, 'readwrite').put(value))
  }

  async del(store: StoreName, id: string): Promise<void> {
    await promisify(this.tx(store, 'readwrite').delete(id))
  }
}

/** Open (and if needed create) the rondocode IndexedDB. Rejects when IDB is
 *  unavailable (private mode / old browser) — the caller should fall back to
 *  an in-memory store so the editor still works without persistence. */
export function openIdb(): Promise<IdbDb> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(new IdbDb(req.result))
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
}
