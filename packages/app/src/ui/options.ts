import { iconEl } from './icons'
import { isIOSWebKit } from '../sing/config'
import { tooltip } from './tooltip'
import { anchorPopover } from './viewport'
import { SETTING_META, getSetting, setSetting, onSettingsChange } from './settings'
import { latencyVerdict } from '../audio/devices'
import type { DeviceInfo, LatencyReport } from '../audio/devices'
import type { Settings } from './settings'
import type { EditorHandle } from '../editor/editor'

/* ------------------------------------------------------------------------- *
 * The Options panel: a header gear button that opens an anchored popover of
 * user preferences (ui/settings.ts). Each boolean setting renders as a labelled
 * toggle; the list is driven by SETTING_META, so adding a setting there adds a
 * row here automatically. Same anchored-popover mechanics as the samples/export
 * popovers (fixed box under the button, outside-click / Escape to dismiss).
 * ------------------------------------------------------------------------- */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const BOOL_KEYS = (Object.keys(SETTING_META) as (keyof Settings)[]).filter((k) => typeof getSetting(k) === 'boolean')

/** Actions other modules surface as panel rows (beyond the boolean toggles). */
export interface OptionsExtras {
  /** Clear the first-run flag and replay the intro tour (ui/tour.ts). */
  showTour?: () => void
  /** The audio stack, for the device pickers. Passed in rather than imported
   *  so this panel keeps knowing nothing about AudioSession. Absent before the
   *  context exists, in which case the section simply does not render. */
  audio?: {
    listDevices: () => Promise<{ inputs: DeviceInfo[]; outputs: DeviceInfo[]; labelled: boolean }>
    setPreferredDevices: (input?: string, output?: string) => Promise<void>
    latency: () => LatencyReport
    deviceWarnings: () => string[]
  }
}

/** Mount the Options panel on the editor's header. Returns a disposer. */
export function mountOptions(editor: EditorHandle, extras?: OptionsExtras): () => void {
  const btn = el('button', 'btn options-btn')
  btn.type = 'button'
  btn.append(iconEl('gear'), el('span', 'btn-label', 'options'))
  btn.setAttribute('aria-expanded', 'false')
  tooltip(btn, 'options')
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(btn, controls.firstChild)

  const pop = el('div', 'options-pop hidden')
  pop.append(el('div', 'options-head', 'options'))
  document.body.append(pop)

  // One toggle row per boolean setting, kept in sync with the store.
  const rows = new Map<keyof Settings, HTMLButtonElement>()
  for (const key of BOOL_KEYS) {
    const meta = SETTING_META[key]
    const row = el('button', 'opt-row')
    row.type = 'button'
    const text = el('div', 'opt-text')
    text.append(el('div', 'opt-label', meta.label), el('div', 'opt-help', meta.help))
    const sw = el('span', 'opt-switch')
    row.append(text, sw)
    const reflect = (): void => {
      const on = getSetting(key) === true
      row.classList.toggle('on', on)
      row.setAttribute('aria-checked', String(on))
    }
    row.setAttribute('role', 'switch')
    reflect()
    row.addEventListener('click', () => setSetting(key, !(getSetting(key) as boolean) as Settings[typeof key]))
    rows.set(key, row)
    pop.append(row)
  }

  /* AUDIO DEVICES. Two selects and a latency readout, because "which mic, and
   * how far behind am I?" are the two questions a live rig actually asks. The
   * readout is MEASURED (baseLatency + outputLatency + the capture track's own
   * latency + one render quantum), not estimated — a number you can act on by
   * plugging in an interface and watching it drop. */
  const audio = extras?.audio
  if (audio !== undefined) {
    const sec = el('div', 'opt-section')
    sec.append(el('div', 'opt-section-head', 'audio devices'))
    const mkPick = (
      key: 'inputDevice' | 'outputDevice',
      label: string,
    ): { row: HTMLElement; sel: HTMLSelectElement } => {
      const row = el('div', 'opt-row opt-row-static')
      const text = el('div', 'opt-text')
      text.append(el('div', 'opt-label', label), el('div', 'opt-help', SETTING_META[key].help))
      const sel = document.createElement('select')
      sel.className = 'opt-select'
      sel.setAttribute('aria-label', label)
      row.append(text, sel)
      sel.addEventListener('change', () => {
        setSetting(key, sel.value)
        void audio
          .setPreferredDevices(getSetting('inputDevice'), getSetting('outputDevice'))
          .then(refreshAudio)
      })
      return { row, sel }
    }
    const inPick = mkPick('inputDevice', 'Input device')
    const outPick = mkPick('outputDevice', 'Output device')
    const status = el('div', 'opt-help opt-audio-status')
    sec.append(inPick.row, outPick.row, status)
    pop.append(sec)

    const fill = (sel: HTMLSelectElement, devices: DeviceInfo[], chosen: string, labelled: boolean): void => {
      sel.replaceChildren()
      const def = document.createElement('option')
      def.value = ''
      def.textContent = 'System default'
      sel.append(def)
      for (const d of devices) {
        const o = document.createElement('option')
        o.value = d.deviceId
        // labels are blank until a permission has been granted ONCE — say so
        // rather than rendering a list of empty rows
        o.textContent = d.label !== '' ? d.label : labelled ? d.deviceId : 'name hidden until mic permission'
        sel.append(o)
      }
      // a saved device that is not plugged in right now must still show as the
      // selection, or the panel would silently look like you never chose it
      if (chosen !== '' && !devices.some((d) => d.deviceId === chosen)) {
        const o = document.createElement('option')
        o.value = chosen
        o.textContent = `${chosen} (not connected)`
        sel.append(o)
      }
      sel.value = chosen
    }

    async function refreshAudio(): Promise<void> {
      if (audio === undefined) return
      const { inputs, outputs, labelled } = await audio.listDevices()
      fill(inPick.sel, inputs, getSetting('inputDevice'), labelled)
      fill(outPick.sel, outputs, getSetting('outputDevice'), labelled)
      const l = audio.latency()
      const rt = Math.round(l.roundTripMs * 10) / 10
      const verdict = latencyVerdict(l.roundTripMs)
      const parts = [
        `round trip ~${rt} ms (${verdict})`,
        `in ${Math.round(l.inputMs)} · engine ${l.quantumMs.toFixed(1)} · out ${Math.round(l.baseMs + l.outputMs)}`,
        ...audio.deviceWarnings(),
      ]
      status.textContent = parts.join(' — ')
    }
    void refreshAudio()
    // devices come and go mid-session; a rig gets plugged in during setup
    globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', () => void refreshAudio())
  }

  // Action rows (not settings): same row style, tap runs the action.
  if (extras?.showTour) {
    const row = el('button', 'opt-row')
    row.type = 'button'
    const text = el('div', 'opt-text')
    text.append(
      el('div', 'opt-label', 'Show intro tour'),
      el('div', 'opt-help', 'Replay the intro: pick your language, open the welcome track, take the tour.'),
    )
    row.append(text)
    row.addEventListener('click', () => {
      close()
      extras.showTour?.()
    })
    pop.append(row)
  }

  // iOS only: the singing device-test switch. Phones are normally blocked
  // from the multi-GB vocal bake (singDialog explains why); this opt-in
  // shows the real consent flow instead, so a brave phone can try the
  // small-aligner build. A switch here because phones have no console to
  // set localStorage from.
  if (isIOSWebKit()) {
    const KEY = 'rc.singForce'
    const get = (): boolean => {
      try { return localStorage.getItem(KEY) === '1' } catch { return false }
    }
    const row = el('button', 'opt-row')
    row.type = 'button'
    const text = el('div', 'opt-text')
    text.append(
      el('div', 'opt-label', 'Try singing on this phone'),
      el('div', 'opt-help', 'Experimental: allow the vocal model download here. Large, and the tab may run out of memory. If it fails, the app will say where it stopped on the next try.'),
    )
    const sw = el('span', 'opt-switch')
    row.append(text, sw)
    row.setAttribute('role', 'switch')
    const reflect = (): void => {
      const on = get()
      row.classList.toggle('on', on)
      row.setAttribute('aria-checked', String(on))
    }
    reflect()
    row.addEventListener('click', () => {
      try { localStorage.setItem(KEY, get() ? '0' : '1') } catch { /* no storage: stays off */ }
      reflect()
    })
    pop.append(row)
  }

  // Reflect external changes (another surface, or a future keybinding).
  const offSettings = onSettingsChange(() => {
    for (const [key, row] of rows) {
      const on = getSetting(key) === true
      row.classList.toggle('on', on)
      row.setAttribute('aria-checked', String(on))
    }
  })

  let open = false
  const position = (): void => anchorPopover(pop, btn)
  const openPop = (): void => {
    pop.classList.remove('hidden') // visible first so anchorPopover can measure it
    position()
    open = true
    btn.setAttribute('aria-expanded', 'true')
    btn.classList.add('active')
  }
  const close = (): void => {
    pop.classList.add('hidden')
    open = false
    btn.setAttribute('aria-expanded', 'false')
    btn.classList.remove('active')
  }
  btn.addEventListener('click', () => (open ? close() : openPop()))

  const onDocClick = (e: MouseEvent): void => {
    if (!open) return
    const t = e.target as Node
    if (pop.contains(t) || btn.contains(t)) return
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (open && e.key === 'Escape') close()
  }
  const onResize = (): void => {
    if (open) position()
  }
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)

  return () => {
    offSettings()
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    pop.remove()
    btn.remove()
  }
}
