/* ------------------------------------------------------------------------- *
 * Bake-phase telemetry that survives a tab kill. iOS terminates a tab that
 * runs out of memory with NO error, no unload event, nothing in the console -
 * the page just reloads blank. So the vocal bake writes its current phase to
 * localStorage at every stage boundary; if the marker is still there on the
 * next boot without the terminal 'done' marker, the last bake died mid-phase
 * and takeCrashReport() says where. Storage failures are swallowed: telemetry
 * must never break the bake it is observing.
 * ------------------------------------------------------------------------- */

const KEY = 'rc.singPhase'

/** The terminal marker a bake writes when it finished cleanly. */
export const DONE_PHASE = 'done'

export interface CrashReport {
  /** The last phase the dead bake reached ('download:vocoder', 'align', ...). */
  phase: string
  /** Date.now() when that phase started. */
  when: number
}

/** Record that the bake just entered `phase`. Call at every stage boundary;
 *  the last write before a tab kill is the crash report. */
export function markPhase(phase: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ phase, when: Date.now() }))
  } catch {
    /* storage blocked or full: telemetry is best-effort */
  }
}

/** Forget the marker after a bake completed cleanly. */
export function clearPhase(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

/** If the LAST bake died mid-phase (a marker exists and it is not the terminal
 *  'done'), return where it stopped and clear the marker (one report per
 *  crash). Returns null on a clean slate, a completed bake, bad data, or
 *  blocked storage. */
export function takeCrashReport(): CrashReport | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    localStorage.removeItem(KEY)
    const parsed = JSON.parse(raw) as { phase?: unknown; when?: unknown }
    if (typeof parsed.phase !== 'string' || parsed.phase === DONE_PHASE) return null
    return { phase: parsed.phase, when: typeof parsed.when === 'number' ? parsed.when : 0 }
  } catch {
    return null
  }
}
