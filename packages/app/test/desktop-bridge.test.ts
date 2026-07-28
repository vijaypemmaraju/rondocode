import { afterEach, describe, expect, it, vi } from 'vitest'
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
