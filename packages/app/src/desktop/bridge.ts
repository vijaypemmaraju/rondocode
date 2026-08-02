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

/** Schedule bytes to land `delayMs` from now, timestamped in CoreMIDI. */
export const midiSendAt = (bytes: Uint8Array | number[], delayMs: number): Promise<void> =>
  invoke<void>('midi_send_at', { bytes: Array.from(bytes), delayMs })

/** A MIDI sink that writes to the virtual port, or null in a browser. Shaped
 *  like the WebMIDI output the app already drives, so the caller does not care
 *  which one it holds. */
export interface MidiSink {
  send(bytes: Uint8Array | number[]): void
  /** Send so the bytes LAND `delayMs` from now. CoreMIDI holds the packet until
   *  its timestamp, so this is exact where a JS timer was only as good as timer
   *  jitter. A delay <= 0 goes out immediately. */
  sendAt(bytes: Uint8Array | number[], delayMs: number): void
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
  const warn = (e: unknown): void => console.warn('[desktop] midi send failed', e)
  return {
    send(bytes) {
      void midiSend(bytes).catch(warn)
    },
    sendAt(bytes, delayMs) {
      void midiSendAt(bytes, delayMs).catch(warn)
    },
  }
}

/* ---- the workspace: a directory IS the project list ---------------------- *
 * The browser keeps projects in IndexedDB because it has nowhere else to put
 * them. On the desktop that is a second source of truth beside the real one,
 * so a folder of .rondo/.js files is the library instead: git works on it,
 * other editors work on it, and there is nothing to import or export. */

export interface WorkspaceEntry {
  path: string
  /** file stem — the project name the library shows. */
  name: string
  lang: 'rondo' | 'rondocode'
  /** ms since epoch, for "most recent first". */
  modified: number
}

/** Where the workspace lives. Kept in localStorage so it survives a restart;
 *  null until the user picks one. */
const WORKSPACE_KEY = 'rc.workspaceDir'

export function workspaceDir(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null // private mode / storage denied: behave as "not chosen"
  }
}

export function setWorkspaceDir(dir: string | null): void {
  try {
    if (dir === null) localStorage.removeItem(WORKSPACE_KEY)
    else localStorage.setItem(WORKSPACE_KEY, dir)
  } catch {
    /* ignore storage failures — the picker still works for this session */
  }
}

/** Pick a workspace folder and remember it. null when cancelled. */
export async function pickWorkspace(): Promise<string | null> {
  const dir = await chooseRenderFolder()
  if (dir !== null) setWorkspaceDir(dir)
  return dir
}

/** Project files in the workspace, newest first. Throws when the folder is
 *  gone — a moved or unmounted workspace must not read as "no projects". */
export const listWorkspace = (dir: string): Promise<WorkspaceEntry[]> =>
  invoke<WorkspaceEntry[]>('list_workspace', { dir })

/** Create a new project file. Refuses to clobber an existing one. */
export const createInWorkspace = (
  dir: string,
  name: string,
  lang: 'rondo' | 'rondocode',
  code: string,
): Promise<string> => invoke<string>('create_in_workspace', { dir, name, ext: extFor(lang), code })

/** Rename in place, keeping the extension. Returns the new path. */
export const renameInWorkspace = (path: string, newName: string): Promise<string> =>
  invoke<string>('rename_in_workspace', { path, newName })

/** Move a project to the extension its language reads back as. Returns the new
 *  path (the same one when it already matches).
 *
 *  A workspace file carries its language in its EXTENSION and nowhere else, so
 *  the editor's language toggle has to move the file too. Without this, a
 *  toggle leaves rondo source in a `.js` file and the next open evaluates it
 *  as JavaScript. Rejects when the other file already exists, rather than
 *  clobbering a project that happens to share the name. */
export const setWorkspaceLang = (path: string, lang: 'rondo' | 'rondocode'): Promise<string> =>
  invoke<string>('set_workspace_ext', { path, ext: extFor(lang) })

/** Move a project to the Trash — recoverable in Finder, unlike an unlink. */
export const trashFile = (path: string): Promise<void> => invoke<void>('trash_file', { path })

/** True when the desktop shell is running AND a workspace has been chosen:
 *  the condition for the library to read from disk instead of IndexedDB. */
export const hasWorkspace = (): boolean => isDesktop() && workspaceDir() !== null
