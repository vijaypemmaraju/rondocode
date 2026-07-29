/* ------------------------------------------------------------------------- *
 * Per-tab persistence.
 *
 * localStorage is shared by every tab on the origin. The active project id and
 * the editor buffer both lived there, so two tabs on two projects were writing
 * the same two keys: whichever tab you typed in last owned "the active
 * project", and each boot reconciled "the buffer is the freshest copy of the
 * active project" — which is how one project's code ended up inside another.
 * The owner guard in library.ts made that reconcile REFUSE rather than
 * clobber; it could not stop the tabs from fighting over the keys.
 *
 * sessionStorage is scoped to the tab and survives reload, which is exactly
 * the lifetime these values want. localStorage stays on as the SEED: a freshly
 * opened tab inherits whatever you had open last, then owns its own copy from
 * that moment on. So:
 *
 *   - a new tab still resumes where you were (the seed is read once)
 *   - after that first read, nothing another tab does can move this one
 *   - a reload keeps the tab on ITS project, not the last-touched one
 *
 * The adopt-on-first-read is the load-bearing part. Reading through to
 * localStorage on every miss would look identical on the happy path and
 * reintroduce the whole bug the moment a tab had not written yet.
 * ------------------------------------------------------------------------- */

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null // private mode / storage denied
  }
}

const local = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Marks a key as ADOPTED by this tab. Kept separate from the value so an
 *  empty string stays an empty string: overloading '' as "not adopted" would
 *  make clearing the editor indistinguishable from a fresh tab, and hand the
 *  starter example back to someone who had just selected-all and deleted. */
const MARK = (key: string): string => `${key}::tab-owned`

/**
 * Read a per-tab value.
 *
 * On this tab's FIRST read of `key` the value is adopted from localStorage —
 * the cross-tab seed — and copied into sessionStorage. Every read after that
 * is answered from sessionStorage alone, so another tab writing the seed can
 * never move this tab.
 */
export function tabGet(key: string): string | null {
  const ss = session()
  if (ss !== null && ss.getItem(MARK(key)) !== null) return ss.getItem(key)
  const ls = local()
  const seed = ls !== null ? ls.getItem(key) : null
  // Adopt even a MISS, so the next read is answered locally: without the mark
  // a tab that has not written yet would keep reading the seed and follow
  // another tab's project.
  if (ss !== null) {
    try {
      ss.setItem(MARK(key), '1')
      if (seed !== null) ss.setItem(key, seed)
    } catch {
      /* quota/denied: fall through — worst case is the old shared behaviour */
    }
  }
  return seed
}

/** Write a per-tab value, and refresh the cross-tab seed so the NEXT freshly
 *  opened tab starts where this one is. Nothing reads the seed after a tab has
 *  adopted, so this cannot move a tab that is already open. */
export function tabSet(key: string, value: string): void {
  const ss = session()
  if (ss !== null) {
    try {
      ss.setItem(key, value)
      ss.setItem(MARK(key), '1')
    } catch {
      /* ignore: persistence is best-effort, see loadDoc's catch */
    }
  }
  const ls = local()
  if (ls !== null) {
    try {
      ls.setItem(key, value)
    } catch {
      /* ignore */
    }
  }
}

/** Drop a per-tab value (and its seed). The tab stays ADOPTED: it deliberately
 *  has nothing, which is not the same as never having looked. */
export function tabRemove(key: string): void {
  const ss = session()
  try {
    ss?.removeItem(key)
    ss?.setItem(MARK(key), '1')
  } catch {
    /* ignore */
  }
  try {
    local()?.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** True when this tab has adopted `key` — i.e. it owns its own copy and is no
 *  longer following the seed. Exported for the boot reconcile, which must know
 *  whether "no value" means "fresh tab" or "deliberately empty". */
export function tabHasOwn(key: string): boolean {
  const ss = session()
  return ss !== null && ss.getItem(MARK(key)) !== null
}
