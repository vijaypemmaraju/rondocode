import { decodeWav, encodeWav } from '@rondocode/engine'
import { deleteProjectSample, listProjectSamples, writeProjectSample } from '../desktop/bridge'
import type { StoredSample } from '../session/projects'

/* ------------------------------------------------------------------------- *
 * The workspace's answer to per-project samples.
 *
 * mountSamplePersistence (samplestore.ts) syncs the sample bank to a store. In
 * the browser that store is IndexedDB, keyed by project row. On the DESKTOP a
 * project is a FILE, and the workspace exists so that copying, committing or
 * emailing that file moves the tune — a database sitting beside it would be
 * lost by all three. So the same interface is implemented over the sibling
 * `<stem>.samples/` folder, and the persistence layer above does not know or
 * care which one it is talking to.
 *
 * WAV rather than raw Float32: what lands in the folder should open in
 * QuickTime, in a DAW, in anything. 32-bit float keeps it lossless, so a take
 * round-trips through the folder bit for bit.
 * ------------------------------------------------------------------------- */

/** The project-store slice mountSamplePersistence needs. Declared here so the
 *  two implementations are checked against one shape. */
export interface ProjectSampleStore {
  listSamples: (projectId: string) => Promise<StoredSample[]>
  putSample: (projectId: string, name: string, data: Float32Array, sampleRate: number) => Promise<StoredSample>
  deleteSample: (projectId: string, name: string) => Promise<void>
}

/** A store over the workspace folder. `projectId` here is the project's PATH,
 *  which is what identifies a project when the file is the project. */
export function workspaceSampleStore(): ProjectSampleStore {
  return {
    listSamples: async (path) => {
      const files = await listProjectSamples(path)
      const out: StoredSample[] = []
      for (const f of files) {
        const wav = decodeWav(f.wav)
        // Mono is what the bank holds. decodeWav hands back the SAME array for
        // both channels on a mono file, so identity is the test; a genuinely
        // stereo file is folded rather than refused, because the folder is
        // user-visible and someone will drop one in there sooner or later.
        const data =
          wav.right === wav.left ? wav.left : wav.left.map((v, i) => (v + wav.right[i]!) / 2)
        out.push({
          id: `${path}#${f.name}`,
          projectId: path,
          name: f.name,
          data,
          sampleRate: wav.sampleRate,
          createdAt: 0, // the folder has no ordering to preserve; name order is stable
        })
      }
      return out
    },

    putSample: async (path, name, data, sampleRate) => {
      // 32-bit float: a take must survive the round trip through the folder
      // unchanged, or resampling something twice would quietly degrade it.
      await writeProjectSample(path, name, encodeWav(data, data, sampleRate, { bits: 32 }))
      return { id: `${path}#${name}`, projectId: path, name, data, sampleRate, createdAt: 0 }
    },

    deleteSample: async (path, name) => {
      await deleteProjectSample(path, name)
    },
  }
}
