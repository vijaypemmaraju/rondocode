import type { ProjectStore, StoredSample } from '../session/projects'
import type { SampleBankHost } from './resample'

/* ------------------------------------------------------------------------- *
 * PER-PROJECT SAMPLE PERSISTENCE.
 *
 * A sample the user made — a mic take, a resampled loop, a dropped file — used
 * to live for exactly as long as the tab did. So `sample(gate, 'take1')` in a
 * SAVED project played today and rendered silence tomorrow, with the code
 * unchanged and nothing to explain it. Bouncing four bars back into the bank
 * and building on top of them is a workflow the app advertises; it only works
 * inside one sitting.
 *
 * This syncs the bank to the project store, both directions:
 *   activate(projectId)  loads that project's stored samples into the engine
 *   any bank change      writes new/changed ones, drops removed ones
 *
 * WHY A WATCHER AND NOT A CALL AT EACH SITE. Samples enter the bank from five
 * places (file input, mic recorder, resample-to-loop, resynthesis, sing bakes)
 * and each would have had to remember to persist. One diff against the bank
 * cannot forget, and a sixth source is covered the day it lands.
 * ------------------------------------------------------------------------- */

/** Baked `sing()` vocals, named `singclip…` by the evaluator. Excluded on
 *  purpose: they are DERIVED from the code that is already saved, they are the
 *  largest thing in the bank (seconds of neural audio per clip), and a stale
 *  one would shadow the re-bake after an edit to the lyrics. Everything else
 *  in the bank is something the user captured and cannot regenerate. */
const isDerived = (name: string): boolean => name.startsWith('singclip')

export interface SamplePersistenceOpts {
  audio: Omit<SampleBankHost, 'getSamples'> & {
    getSamples: () => { name: string; builtIn?: boolean }[]
    onSamplesChanged: (fn: () => void) => () => void
    /** Needed on a project SWITCH: the outgoing project's takes have to leave
     *  the bank, or they follow you into the next project and get written
     *  there too — one `take1` silently becoming two projects' `take1`. */
    removeSample: (name: string) => void
  }
  store: Pick<ProjectStore, 'listSamples' | 'putSample' | 'deleteSample'>
  /** Report a failure to the user; storage can be full or blocked. */
  onError?: (message: string) => void
}

export interface SamplePersistence {
  /** Load `projectId`'s stored samples into the bank, and start syncing to it.
   *  Call again on a project switch: the new project's samples replace the
   *  old project's in what gets written. */
  activate: (projectId: string) => Promise<void>
  /** Stop watching (the samples already written stay written). */
  dispose: () => void
}

export function mountSamplePersistence({ audio, store, onError }: SamplePersistenceOpts): SamplePersistence {
  let projectId: string | null = null
  /** What was written for the ACTIVE project: name -> the exact buffer stored.
   *  Diffing by NAME alone was not enough — re-rendering `take1` removes and
   *  re-adds the same name in one tick, so by the time the write ran the name
   *  looked already-written and the OLD audio stayed in the store. Comparing
   *  the buffer identity catches a replacement; it also avoids re-reading
   *  megabytes from the store on every bank change. */
  let written = new Map<string, Float32Array>()
  let unsub: (() => void) | null = null
  /** Serialises syncs: a mic take landing mid-write must not interleave. */
  let queue: Promise<void> = Promise.resolve()

  const userSamples = (): string[] =>
    audio
      .getSamples()
      .filter((s) => s.builtIn !== true && !isDerived(s.name))
      .map((s) => s.name)

  const sync = (): void => {
    queue = queue.then(async () => {
      const id = projectId
      if (id === null) return
      const live = userSamples()
      const bank = audio.loadedSamples
      try {
        for (const name of live) {
          const pcm = bank[name]
          if (pcm === undefined) continue // recorded in the list but not yet loaded
          if (written.get(name) === pcm.data) continue // same buffer, already stored
          await store.putSample(id, name, pcm.data, pcm.sampleRate)
          written.set(name, pcm.data)
        }
        for (const name of [...written.keys()]) {
          if (live.includes(name)) continue
          await store.deleteSample(id, name)
          written.delete(name)
        }
      } catch (e) {
        // Storage is finite and can be denied. Say so once rather than
        // silently dropping the take the user just made.
        onError?.(`could not save samples: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
  }

  const activate = async (id: string): Promise<void> => {
    unsub?.()
    unsub = null
    // The outgoing project's samples leave with it. Only the ones this layer
    // put there: a sample loaded some other way is not ours to unload.
    for (const name of written.keys()) audio.removeSample(name)
    projectId = id
    written = new Map()
    let stored: StoredSample[]
    try {
      stored = await store.listSamples(id)
    } catch (e) {
      onError?.(`could not read saved samples: ${e instanceof Error ? e.message : String(e)}`)
      stored = []
    }
    for (const s of stored) {
      audio.loadSamplePcm(s.name, s.data, s.sampleRate, false)
      // record the buffer the BANK now holds, which is what a later diff sees
      written.set(s.name, audio.loadedSamples[s.name]?.data ?? s.data)
    }
    // Subscribe AFTER the restore, so loading what we just read back does not
    // immediately re-write it.
    unsub = audio.onSamplesChanged(sync)
  }

  return {
    activate,
    dispose: () => {
      unsub?.()
      unsub = null
      projectId = null
    },
  }
}
