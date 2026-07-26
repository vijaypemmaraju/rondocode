/* ------------------------------------------------------------------------- *
 * Session lifecycle for the singing models. Two pieces:
 *
 * ModelSlot - one lazily-created, disposable singleton. Every sing module used
 * to pin its ORT sessions in bare module variables forever; on a phone that
 * stacks TTS (~398MB) + aligner (~357MB) + RVC (~490MB) of session weight in
 * one tab and iOS kills it. A slot keeps the same load-once behavior but adds
 * dispose(): release the session, null the value, and reset the loading
 * promise so a LATER load starts clean (the model bytes stay in the Cache API,
 * so re-creating is a disk read, not a re-download).
 *
 * runStages - the bake's stage order as data plus a driver. On constrained
 * devices each stage's dispose runs in a finally as soon as the stage ends
 * (success OR failure), so at most one stage's sessions are alive at a time
 * and a failed bake never leaves hundreds of MB pinned. On desktop dispose is
 * skipped and the singletons persist across bakes, exactly as before.
 * ------------------------------------------------------------------------- */

/** A lazily-created, disposable singleton holding a loaded model/session. */
export class ModelSlot<T> {
  private value: T | null = null
  private loading: Promise<T> | null = null

  constructor(private readonly release: (v: T) => Promise<void> | void) {}

  /** The loaded value, or null before load / after dispose. */
  get(): T | null {
    return this.value
  }

  /** Load once; concurrent callers share the in-flight promise. A failed load
   *  resets the slot so the next call retries. After dispose(), a new load
   *  starts fresh. */
  load(create: () => Promise<T>): Promise<T> {
    if (this.value !== null) return Promise.resolve(this.value)
    if (this.loading === null) {
      const p: Promise<T> = create().then(
        (v) => {
          // publish only if this load is still current (not disposed mid-flight)
          if (this.loading === p) this.value = v
          return v
        },
        (e: unknown) => {
          if (this.loading === p) this.loading = null
          throw e instanceof Error ? e : new Error(String(e))
        },
      )
      this.loading = p
    }
    return this.loading
  }

  /** Release the held value (if any) and reset so a later load starts clean.
   *  Safe to call twice, and safe mid-load: a pending load is awaited and its
   *  result released, never left pinned. */
  async dispose(): Promise<void> {
    const pending = this.loading
    this.loading = null
    const v = this.value
    this.value = null
    if (v !== null) {
      await this.releaseSafe(v)
    } else if (pending !== null) {
      let loaded: T | null = null
      try {
        loaded = await pending
      } catch {
        /* the load failed: nothing to release */
      }
      if (loaded !== null) await this.releaseSafe(loaded)
    }
  }

  private async releaseSafe(v: T): Promise<void> {
    try {
      await this.release(v)
    } catch {
      /* releasing a dead session must not mask the bake's own result */
    }
  }
}

/** The bake's model stages, in pipeline order. */
export const SING_STAGE_ORDER = ['tts', 'align', 'rvc'] as const
export type SingStageName = (typeof SING_STAGE_ORDER)[number]

export interface SingStage {
  name: SingStageName
  run: () => Promise<void>
  dispose: () => Promise<void> | void
}

/** Run the stages in order. With `sequential` (constrained devices), each
 *  stage's dispose runs in a finally the moment the stage ends - success or
 *  failure - so peak session memory is the largest single stage, not the sum,
 *  and an error mid-bake still tears its stage down before propagating.
 *  Without it, dispose is never called (module singletons persist). */
export async function runStages(stages: readonly SingStage[], sequential: boolean): Promise<void> {
  for (const stage of stages) {
    try {
      await stage.run()
    } finally {
      if (sequential) await stage.dispose()
    }
  }
}
