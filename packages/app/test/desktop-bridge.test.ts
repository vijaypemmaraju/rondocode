import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { extFor, isDesktop, midiSend, openProjectDialog, openVirtualMidi, writeRender } from '../src/desktop/bridge'

/* The bridge is the ONLY module that knows a native shell might exist. Its
 * contract is therefore mostly about the BROWSER: every capability must answer
 * truthfully rather than throwing, so callers can ask "can I?" instead of
 * sniffing a user agent. */

const setShell = (invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>): void => {
  ;(globalThis as Record<string, unknown>)['__TAURI__'] = { core: { invoke } }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)['__TAURI__']
  vi.restoreAllMocks()
})

describe('in a browser', () => {
  it('reports that it is not the desktop', () => {
    expect(isDesktop()).toBe(false)
  })

  it('openVirtualMidi returns null rather than throwing', async () => {
    // playback must never depend on a port that cannot exist here
    await expect(openVirtualMidi()).resolves.toBeNull()
  })

  it('a file command rejects with a message that names the command', async () => {
    await expect(openProjectDialog()).rejects.toThrow(/open_project_dialog/)
  })
})

describe('in the desktop shell', () => {
  it('detects the shell and forwards commands', async () => {
    const invoke = vi.fn().mockResolvedValue({ path: '/x/a.rondo', name: 'a', code: 'saw', lang: 'rondo' })
    setShell(invoke)
    expect(isDesktop()).toBe(true)
    const f = await openProjectDialog()
    expect(invoke).toHaveBeenCalledWith('open_project_dialog', undefined)
    expect(f?.lang).toBe('rondo')
  })

  it('a cancelled dialog is null, not undefined', async () => {
    setShell(vi.fn().mockResolvedValue(null))
    await expect(openProjectDialog()).resolves.toBeNull()
  })

  it('sends bytes as a plain array, which is what survives the IPC boundary', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    setShell(invoke)
    await midiSend(new Uint8Array([0x90, 60, 100]))
    expect(invoke).toHaveBeenCalledWith('midi_send', { bytes: [0x90, 60, 100] })
    // a typed array would arrive as an object with numeric keys
    expect(Array.isArray((invoke.mock.calls[0]![1] as { bytes: unknown }).bytes)).toBe(true)
  })

  it('render bytes cross the boundary the same way', async () => {
    const invoke = vi.fn().mockResolvedValue('/out/mix.wav')
    setShell(invoke)
    await writeRender('/out', 'mix.wav', new Uint8Array([1, 2, 3]))
    expect(invoke).toHaveBeenCalledWith('write_render', { dir: '/out', name: 'mix.wav', bytes: [1, 2, 3] })
  })

  it('a failing port yields null instead of taking the caller down', async () => {
    setShell(vi.fn().mockRejectedValue(new Error('OSStatus -10830')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(openVirtualMidi()).resolves.toBeNull()
  })

  it('a send failure is logged, never thrown at the caller mid-playback', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('rondocode') // midi_open
      .mockRejectedValue(new Error('port went away')) // midi_send
    setShell(invoke)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sink = await openVirtualMidi()
    expect(sink).not.toBeNull()
    expect(() => sink!.send([0xf8])).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(warn).toHaveBeenCalled()
  })
})

describe('extensions follow the language', () => {
  it('maps each language to the extension it is read back as', () => {
    // files.rs reads .rondo as rondo and everything else as JS, so these two
    // must agree or a saved file reopens in the wrong grammar
    expect(extFor('rondo')).toBe('.rondo')
    expect(extFor('rondocode')).toBe('.js')
  })
})

describe('the library actually calls the bridge', () => {
  /* Same standard applied to the MIDI importer: a capability that exists and
   * cannot be reached is not a capability. These pin the wiring. */
  const lib = readFileSync(join(__dirname, '../src/editor/library.ts'), 'utf8')

  it('shows the file buttons ONLY on desktop, not as dead chrome in a browser', () => {
    expect(lib).toContain('isDesktop()')
    const guard = lib.indexOf('if (isDesktop())')
    expect(guard).toBeGreaterThan(-1)
    expect(lib.indexOf("'open file'")).toBeGreaterThan(guard)
    expect(lib.indexOf("'save file'")).toBeGreaterThan(guard)
  })

  it('opens through the native dialog and creates the project in the file’s language', () => {
    expect(lib).toContain('openProjectDialog()')
    // f.lang comes from the extension, so a .rondo must not land under JS
    expect(lib).toMatch(/createProject\(f\.name, f\.code, f\.lang\)/)
  })

  it('remembers the path so Save does not re-prompt every time', () => {
    expect(lib).toMatch(/filePath !== null/)
    expect(lib).toContain('saveProject(filePath, code)')
    expect(lib).toContain('saveProjectDialog(suggested, code)')
  })

  it('suggests a name with the extension the current language reads back as', () => {
    expect(lib).toMatch(/extFor\(editor\.getLang\(\)\)/)
  })

  it('a language toggle re-extensions the open workspace file', () => {
    // The bug this pins: onLang wrote only the IndexedDB row, so toggling a
    // workspace project to rondo left rondo source in a .js file and the next
    // open evaluated it as JavaScript.
    const lang = lib.indexOf('editor.onLang(')
    expect(lang).toBeGreaterThan(-1)
    const body = lib.slice(lang, lang + 1400)
    expect(body).toContain('setWorkspaceLang(')
    expect(body).toMatch(/openPath !== null/)
    // and the new path is adopted, or the next save recreates the old file
    expect(body).toMatch(/openPath = moved/)
  })

  it('lets go of the file when the open project stops being that file', () => {
    // Otherwise the autosave keeps writing an unrelated project's code into
    // the last workspace file that happened to be open.
    const sw = lib.indexOf('const switchTo =')
    expect(sw).toBeGreaterThan(-1)
    // to the END of switchTo, not a character count: a fixed window measures
    // how much COMMENT the function carries, and adding four lines of it broke
    // this test while the behaviour it names was untouched
    expect(lib.slice(sw, lib.indexOf('\n  }', sw))).toMatch(/openPath = null/)
    const forget = lib.indexOf("'use app storage'")
    expect(forget).toBeGreaterThan(-1)
    expect(lib.slice(forget, forget + 600)).toMatch(/openPath = null/)
  })

  it('a cancelled dialog leaves the project untouched', () => {
    // both paths bail on null rather than writing an empty file or clobbering
    expect(lib).toMatch(/if \(f === null\) return/)
    expect(lib).toMatch(/if \(written === null\) return/)
  })
})

describe('the workspace: a directory as the project list', () => {
  // no DOM in this suite, and the bridge deliberately swallows storage
  // failures — so without a stub every assertion here would pass vacuously
  const store = new Map<string, string>()
  beforeAll(() => {
    ;(globalThis as Record<string, unknown>)['localStorage'] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterAll(() => {
    delete (globalThis as Record<string, unknown>)['localStorage']
  })
  afterEach(() => store.clear())

  it('has no workspace until one is chosen, even on desktop', async () => {
    const { hasWorkspace, setWorkspaceDir, workspaceDir } = await import('../src/desktop/bridge')
    setShell(vi.fn())
    setWorkspaceDir(null)
    expect(workspaceDir()).toBeNull()
    expect(hasWorkspace()).toBe(false)
  })

  it('remembers the folder, so it survives a restart', async () => {
    const { hasWorkspace, setWorkspaceDir, workspaceDir } = await import('../src/desktop/bridge')
    setShell(vi.fn())
    setWorkspaceDir('/Users/x/Music/rondo')
    expect(workspaceDir()).toBe('/Users/x/Music/rondo')
    expect(hasWorkspace()).toBe(true)
  })

  it('never claims a workspace in the browser, whatever is stored', async () => {
    const { hasWorkspace, setWorkspaceDir } = await import('../src/desktop/bridge')
    setWorkspaceDir('/Users/x/Music/rondo') // stale value from a desktop run
    expect(hasWorkspace()).toBe(false) // no shell → no filesystem
  })

  it('creates a file with the extension its language reads back as', async () => {
    const invoke = vi.fn().mockResolvedValue('/w/tune.rondo')
    setShell(invoke)
    const { createInWorkspace } = await import('../src/desktop/bridge')
    await createInWorkspace('/w', 'tune', 'rondo', 'saw note')
    expect(invoke).toHaveBeenCalledWith('create_in_workspace', {
      dir: '/w', name: 'tune', ext: '.rondo', code: 'saw note',
    })
  })

  it('switching language moves the file, because the extension IS the language', async () => {
    const invoke = vi.fn().mockResolvedValue('/w/tune.rondo')
    setShell(invoke)
    const { setWorkspaceLang } = await import('../src/desktop/bridge')
    expect(await setWorkspaceLang('/w/tune.js', 'rondo')).toBe('/w/tune.rondo')
    expect(invoke).toHaveBeenCalledWith('set_workspace_ext', { path: '/w/tune.js', ext: '.rondo' })
  })

  it('picking a workspace remembers it; cancelling leaves it unset', async () => {
    const { pickWorkspace, workspaceDir } = await import('../src/desktop/bridge')
    setShell(vi.fn().mockResolvedValue(null)) // cancelled
    expect(await pickWorkspace()).toBeNull()
    expect(workspaceDir()).toBeNull()

    setShell(vi.fn().mockResolvedValue('/w'))
    expect(await pickWorkspace()).toBe('/w')
    expect(workspaceDir()).toBe('/w')
  })
})
