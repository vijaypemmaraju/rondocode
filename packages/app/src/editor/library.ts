/* ------------------------------------------------------------------------- *
 * The library UI: named projects + per-project version history, layered onto
 * the editor via its seams (getDoc/loadCode/onDoc/onEval). Data lives in
 * IndexedDB (session/projects.ts); this module is the glue + the DOM.
 *
 * Boot: open IndexedDB (falling back to an in-memory store if unavailable so
 * the editor still runs), then reconcile the active project with the buffer
 * the editor already restored from localStorage — the buffer is the freshest
 * copy, so it wins and is saved back into the active project.
 *
 * Autosave rides editor.onDoc (working code, debounced, no history). History
 * grows only on editor.onEval (an explicit Run) or a manual snapshot.
 * ------------------------------------------------------------------------- */

import type { EditorHandle } from './editor'
import { icon, iconEl } from '../ui/icons'
import { overlayClosed, overlayOpened } from '../ui/overlays'
import { tooltip } from '../ui/tooltip'
import { EXAMPLES } from '../examples'
import { MemoryDb, ProjectStore } from '../session/projects'
import type { Project } from '../session/projects'
import { openIdb } from '../session/idb'
import { decodeShare, encodeShare, readShareHash, shareUrl } from '../session/share'

const ACTIVE_KEY = 'rondocode-active-project'
const SAVE_DEBOUNCE_MS = 600

const BLANK_STARTER = `// new tune. define a synth, then p('name', pattern) to play it.
const blip = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('lead', n('0 3 5 7').scale('c major').sound('blip'))

setCps(0.5)
`

const getActiveId = (): string | undefined => {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? undefined
  } catch {
    return undefined
  }
}
const setActiveId = (id: string): void => {
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    // private mode: active project just won't persist across reloads
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Compact relative time: "just now", "5m", "3h", "2d", else a short date. */
const ago = (t: number, now: number): string => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export interface LibraryHandle {
  dispose(): void
}

export async function mountLibrary(editor: EditorHandle): Promise<LibraryHandle> {
  // IndexedDB, or an in-memory fallback so the editor still works (no persistence).
  let store: ProjectStore
  try {
    store = new ProjectStore(await openIdb())
  } catch (e) {
    console.warn('[library] IndexedDB unavailable; projects will not persist', e)
    store = new ProjectStore(new MemoryDb())
  }

  // ---- reconcile active project with the buffer the editor already loaded ----
  const bootCode = editor.getDoc()
  let projects = await store.listProjects()
  const storedId = getActiveId()

  // A share link (#s=…) opens the shared tune as a NEW project, then strips the
  // hash so a reload doesn't re-import it. This wins over the stored active.
  let active: Project | undefined
  const sharePayload = readShareHash(location.hash)
  if (sharePayload) {
    const shared = await decodeShare(sharePayload)
    if (shared) {
      active = await store.createProject(shared.name, shared.code)
      editor.loadCode(shared.code)
      try {
        history.replaceState(null, '', location.pathname + location.search)
      } catch {
        // history unavailable: harmless — the hash just lingers
      }
    }
  }

  if (!active) {
    active = storedId ? await store.getProject(storedId) : undefined
    if (!active) {
      // first run (or a stale id): adopt the current buffer as "untitled".
      active = projects[0] ?? (await store.createProject('untitled', bootCode))
    }
    // The buffer is the freshest copy of the active project — reconcile it in.
    await store.saveCode(active.id, bootCode)
  }
  let activeId: string = active.id
  setActiveId(activeId)

  // Pending debounced autosave (see the autosave wiring below), captured with
  // the project id it belongs to. flushSave() writes it immediately — called
  // before every project switch and on dispose so no edit is lost or misfiled.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSave: { id: string; code: string } | undefined
  const flushSave = (): void => {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (pendingSave !== undefined) {
      void store.saveCode(pendingSave.id, pendingSave.code)
      pendingSave = undefined
    }
  }

  // ---- top-bar control -------------------------------------------------------
  const projectBtn = el('button', 'btn project-btn')
  projectBtn.type = 'button'
  projectBtn.setAttribute('aria-expanded', 'false')
  const setLabel = (name: string): void => {
    // name (ellipsizes) + a fixed chevron, so the affordance survives a long
    // name; full name in the title since the button truncates.
    projectBtn.replaceChildren(el('span', 'project-name', name), iconEl('chevron'))
    tooltip(projectBtn, `${name} (projects, Cmd/Ctrl+P)`)
  }
  setLabel(active.name)
  // place right after the logo
  editor.topbar.insertBefore(projectBtn, editor.topbar.children[1] ?? null)

  // ---- sheet -----------------------------------------------------------------
  const backdrop = el('div', 'sheet-backdrop hidden')
  const sheet = el('aside', 'sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', 'projects')
  backdrop.append(sheet)
  document.body.append(backdrop)

  const closeSheet = (): void => {
    backdrop.classList.add('hidden')
    projectBtn.setAttribute('aria-expanded', 'false')
    overlayClosed(closeSheet)
    projectBtn.focus() // restore focus to the trigger
  }
  const openSheet = (): void => {
    overlayOpened(closeSheet) // close any other open sheet
    backdrop.classList.remove('hidden')
    projectBtn.setAttribute('aria-expanded', 'true')
    void render().then(() => (sheet.querySelector('input, button') as HTMLElement | null)?.focus())
  }
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSheet()
  })
  projectBtn.addEventListener('click', () => {
    if (backdrop.classList.contains('hidden')) openSheet()
    else closeSheet()
  })

  // Switch the editor to a project's working code and mark it active.
  const switchTo = async (p: Project): Promise<void> => {
    // Persist the OUTGOING project's edits before loading the new one: a switch
    // made before the autosave debounce fired must neither drop those edits nor
    // let the pending save (bound to the old id) clobber the incoming project.
    flushSave()
    activeId = p.id
    active = p
    setActiveId(p.id)
    setLabel(p.name)
    editor.loadCode(p.code)
  }

  // ---- rendering -------------------------------------------------------------
  const render = async (): Promise<void> => {
    projects = await store.listProjects()
    const current = (await store.getProject(activeId)) ?? projects[0]
    if (!current) return
    active = current
    setLabel(current.name)
    const now = Date.now()

    sheet.replaceChildren()

    // header
    const header = el('div', 'sheet-head')
    header.append(el('h2', 'sheet-title', 'projects'))
    const closeBtn = el('button', 'sheet-close')
    closeBtn.type = 'button'
    closeBtn.innerHTML = icon('x')
    closeBtn.setAttribute('aria-label', 'close')
    closeBtn.addEventListener('click', closeSheet)
    header.append(closeBtn)
    sheet.append(header)

    // active project: rename + actions
    const activeCard = el('div', 'lib-active')
    const nameInput = el('input', 'lib-name') as HTMLInputElement
    nameInput.value = current.name
    nameInput.setAttribute('aria-label', 'project name')
    const commitName = async (): Promise<void> => {
      const name = nameInput.value.trim() || 'untitled'
      nameInput.value = name
      await store.renameProject(current.id, name)
      setLabel(name)
    }
    nameInput.addEventListener('blur', () => void commitName())
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') nameInput.blur()
    })
    activeCard.append(nameInput)

    const actions = el('div', 'lib-actions')
    const dupBtn = el('button', 'lib-mini', 'duplicate')
    dupBtn.type = 'button'
    dupBtn.addEventListener('click', () => {
      void (async () => {
        const copy = await store.duplicateProject(current.id)
        if (copy) await switchTo(copy)
        await render()
      })()
    })
    const delBtn = el('button', 'lib-mini lib-danger', 'delete')
    delBtn.type = 'button'
    let armed = false
    delBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true
        delBtn.textContent = 'tap to confirm'
        setTimeout(() => {
          armed = false
          delBtn.textContent = 'delete'
        }, 3000)
        return
      }
      void (async () => {
        await store.deleteProject(current.id)
        const rest = await store.listProjects()
        const next = rest[0] ?? (await store.createProject('untitled', BLANK_STARTER))
        await switchTo(next)
        await render()
      })()
    })
    actions.append(dupBtn, delBtn)
    activeCard.append(actions)
    sheet.append(activeCard)

    // new project + new from example
    const newRow = el('div', 'lib-new')
    const newBtn = el('button', 'lib-mini', 'new')
    newBtn.type = 'button'
    newBtn.addEventListener('click', () => {
      void (async () => {
        const p = await store.createProject('untitled', BLANK_STARTER)
        await switchTo(p)
        await render()
      })()
    })
    const examplePick = el('select', 'lib-example') as HTMLSelectElement
    const ph = el('option', undefined, 'new from example…')
    ph.value = ''
    ph.disabled = true
    ph.selected = true
    examplePick.append(ph)
    EXAMPLES.forEach((ex, i) => {
      const opt = el('option', undefined, ex.name)
      opt.value = String(i)
      examplePick.append(opt)
    })
    examplePick.addEventListener('change', () => {
      const ex = EXAMPLES[Number(examplePick.value)]
      if (!ex) return
      void (async () => {
        const p = await store.createProject(ex.name, ex.code)
        await switchTo(p)
        await render()
      })()
    })
    newRow.append(newBtn, examplePick)
    sheet.append(newRow)

    // export / import a project as a .json file
    const ioRow = el('div', 'lib-new')
    const exportBtn = el('button', 'lib-mini', 'export')
    exportBtn.type = 'button'
    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ name: current.name, code: current.code }, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${current.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'project'}.rondo.json`
      a.click()
      URL.revokeObjectURL(url)
      exportBtn.textContent = 'exported'
      setTimeout(() => (exportBtn.textContent = 'export'), 1800)
    })
    const importBtn = el('button', 'lib-mini', 'import')
    importBtn.type = 'button'
    const importInput = el('input') as HTMLInputElement
    importInput.type = 'file'
    importInput.accept = 'application/json,.json'
    importInput.hidden = true
    importBtn.addEventListener('click', () => importInput.click())
    importInput.addEventListener('change', () => {
      const f = importInput.files?.[0]
      importInput.value = ''
      if (!f) return
      void (async () => {
        try {
          const data = JSON.parse(await f.text()) as { name?: unknown; code?: unknown }
          if (typeof data.code !== 'string') throw new Error('file has no code')
          const p = await store.createProject(
            typeof data.name === 'string' ? data.name : 'imported',
            data.code,
          )
          await switchTo(p)
          await render()
        } catch (e) {
          console.warn('[library] import failed', e)
          importBtn.textContent = 'import failed'
          setTimeout(() => (importBtn.textContent = 'import'), 1800)
        }
      })()
    })
    // share: encode the current tune into a link and copy it (no backend)
    const shareBtn = el('button', 'lib-mini', 'share')
    shareBtn.type = 'button'
    shareBtn.addEventListener('click', () => {
      void (async () => {
        const flash = (msg: string): void => {
          shareBtn.textContent = msg
          setTimeout(() => (shareBtn.textContent = 'share'), 1800)
        }
        try {
          const payload = await encodeShare({ name: current.name, code: editor.getDoc() })
          const url = shareUrl(location.origin, location.pathname, payload)
          await navigator.clipboard.writeText(url)
          flash('link copied')
        } catch (e) {
          console.warn('[library] share failed', e)
          flash('copy failed')
        }
      })()
    })
    ioRow.append(shareBtn, exportBtn, importBtn, importInput)
    sheet.append(ioRow)

    // project list
    const list = el('div', 'lib-list')
    for (const p of projects) {
      const row = el('button', 'lib-row' + (p.id === current.id ? ' active' : ''))
      row.type = 'button'
      const rowName = el('span', 'lib-row-name', p.name)
      tooltip(rowName, p.name) // full name; the row ellipsizes
      row.append(rowName)
      row.append(el('span', 'lib-row-time', ago(p.updatedAt, now)))
      row.addEventListener('click', () => {
        void (async () => {
          await switchTo(p)
          await render()
        })()
      })
      list.append(row)
    }
    sheet.append(list)

    // history — name a version (optional) then snapshot; unnamed snapshots
    // dedupe against the latest, named ones are always kept.
    const histHead = el('div', 'lib-hist-head')
    histHead.append(el('h3', 'lib-subtitle', 'history'))
    const snapName = el('input', 'lib-snap-name') as HTMLInputElement
    snapName.placeholder = 'name a version…'
    snapName.setAttribute('aria-label', 'snapshot name')
    const snapBtn = el('button', 'lib-mini', 'snapshot')
    snapBtn.type = 'button'
    const doSnap = async (): Promise<void> => {
      await store.snapshot(current.id, editor.getDoc(), snapName.value.trim() || undefined)
      snapName.value = ''
      await render()
    }
    snapName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void doSnap()
    })
    snapBtn.addEventListener('click', () => void doSnap())
    histHead.append(snapName, snapBtn)
    sheet.append(histHead)

    const versions = await store.listVersions(current.id)
    const hist = el('div', 'lib-hist')
    if (versions.length === 0) {
      hist.append(el('div', 'lib-empty', 'no history yet; run to snapshot'))
    }
    versions.forEach((v, i) => {
      const row = el('button', 'lib-vrow')
      row.type = 'button'
      const dot = el('span', 'lib-vdot' + (i === 0 ? ' latest' : ''))
      row.append(dot)
      const meta = el('span', 'lib-vmeta')
      meta.append(el('span', 'lib-vtime', ago(v.createdAt, now)))
      if (v.label) meta.append(el('span', 'lib-vlabel', v.label))
      row.append(meta)
      row.append(el('span', 'lib-vaction', 'restore'))
      row.addEventListener('click', () => {
        void (async () => {
          const code = await store.restore(current.id, v.id)
          if (code !== undefined) editor.loadCode(code)
          await render()
        })()
      })
      hist.append(row)
    })
    sheet.append(hist)
  }

  // ---- autosave + snapshot wiring --------------------------------------------
  // Debounced autosave of the working buffer into the active project. The save
  // is bound to the project id at SCHEDULE time (captured in pendingSave), NOT
  // read when the timer fires: a fast project switch must never let an edit made
  // in one project land in another. switchTo flushes this before loading.
  const offDoc = editor.onDoc((code) => {
    pendingSave = { id: activeId, code }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  })
  const offEval = editor.onEval(({ code, ok }) => {
    if (!ok) return
    void store.snapshot(activeId, code) // deduped against the latest snapshot
  })

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) {
      closeSheet()
      return
    }
    // Cmd/Ctrl-P toggles the project library (P for projects; preventDefault
    // stops the browser print dialog).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault()
      if (backdrop.classList.contains('hidden')) openSheet()
      else closeSheet()
    }
  }
  document.addEventListener('keydown', onKey)

  const dispose = (): void => {
    offDoc()
    offEval()
    flushSave() // persist any debounced edit before tearing down
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    projectBtn.remove()
  }

  return { dispose }
}
