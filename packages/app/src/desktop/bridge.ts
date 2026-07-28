/* ------------------------------------------------------------------------- *
 * The desktop seam.
 *
 * The web build is the whole UI in both places; this module is the ONLY thing
 * that knows a native shell might be underneath. Everything here degrades to
 * `null`/`false` in a browser, so callers can ask for a capability and get a
 * truthful answer instead of branching on a user agent.
 *
 * Nothing is imported statically from @tauri-apps: the desktop shell injects
 * its API onto `window.__TAURI__`, so a browser build carries no dead
 * dependency and the app keeps building with no tauri packages installed.
 * ------------------------------------------------------------------------- */

/** What the shell exposes. Structural, so no @tauri-apps types are needed. */
interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

const tauri = (): TauriGlobal | null => {
  const g = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__
  return g !== undefined && g !== null ? g : null
}

/** True when running inside the desktop shell. */
export const isDesktop = (): boolean => tauri() !== null

/** Call a shell command. Throws when not on desktop — guard with isDesktop(). */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = tauri()
  const fn = g?.core?.invoke ?? g?.invoke
  if (fn === undefined) throw new Error(`desktop command '${cmd}' is unavailable in the browser`)
  return (await fn(cmd, args)) as T
}

/* ---- local files --------------------------------------------------------- */

export interface OpenedFile {
  path: string
  name: string
  code: string
  /** 'rondo' for a .rondo file, 'rondocode' otherwise. */
  lang: 'rondo' | 'rondocode'
}

/** Native Open dialog. null when the user cancels. */
export const openProjectDialog = async (): Promise<OpenedFile | null> =>
  (await invoke<OpenedFile | null>('open_project_dialog')) ?? null

/** Read a path directly (recent files, drag-and-drop). */
export const openProjectPath = (path: string): Promise<OpenedFile> =>
  invoke<OpenedFile>('open_project_path', { path })

/** Write to a known path (Save). Returns the path written. */
export const saveProject = (path: string, code: string): Promise<string> =>
  invoke<string>('save_project', { path, code })

/** Native Save dialog (Save As). null when the user cancels. */
export const saveProjectDialog = async (suggested: string, code: string): Promise<string | null> =>
  (await invoke<string | null>('save_project_dialog', { suggested, code })) ?? null

/** Native folder picker for renders/stems. null when cancelled. */
export const chooseRenderFolder = async (): Promise<string | null> =>
  (await invoke<string | null>('choose_render_folder')) ?? null

/** Write bytes (a WAV, a .mid) into a chosen folder. Returns the full path. */
export const writeRender = (dir: string, name: string, bytes: Uint8Array): Promise<string> =>
  // Uint8Array does not survive the IPC boundary as-is; a plain array does
  invoke<string>('write_render', { dir, name, bytes: Array.from(bytes) })

/** The file extension a language should be saved under. */
export const extFor = (lang: 'rondo' | 'rondocode'): string => (lang === 'rondo' ? '.rondo' : '.js')

/* ---- DAW integration: the virtual MIDI port ------------------------------ */

/** Publish rondocode as a MIDI source your DAW can see. Idempotent — calling
 *  it twice keeps one port rather than showing a duplicate device. Returns the
 *  published name. */
export const midiOpen = (name?: string): Promise<string> =>
  invoke<string>('midi_open', name !== undefined ? { name } : {})

export const midiIsOpen = (): Promise<boolean> => invoke<boolean>('midi_is_open')

/** Send raw MIDI out of the virtual port. Takes the same bytes the WebMIDI
 *  output already builds, so both paths share one encoder. */
export const midiSend = (bytes: Uint8Array | number[]): Promise<void> =>
  invoke<void>('midi_send', { bytes: Array.from(bytes) })

/** A MIDI sink that writes to the virtual port, or null in a browser. Shaped
 *  like the WebMIDI output the app already drives, so the caller does not care
 *  which one it holds. */
export interface MidiSink {
  send(bytes: Uint8Array | number[]): void
}

/** Open the virtual port and return a sink for it. null off the desktop, or
 *  when CoreMIDI refuses (the reason is logged, never thrown at the caller:
 *  losing the port must not take playback down with it). */
export async function openVirtualMidi(name = 'rondocode'): Promise<MidiSink | null> {
  if (!isDesktop()) return null
  try {
    await midiOpen(name)
  } catch (e) {
    console.warn('[desktop] virtual MIDI port unavailable', e)
    return null
  }
  return {
    send(bytes) {
      void midiSend(bytes).catch((e: unknown) => console.warn('[desktop] midi send failed', e))
    },
  }
}
