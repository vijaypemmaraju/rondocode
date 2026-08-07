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

import type { EditorHandle, EditorLang } from './editor'
import { icon, iconEl } from '../ui/icons'
import { overlayClosed, overlayOpened } from '../ui/overlays'
import { tooltip } from '../ui/tooltip'
import { EXAMPLES } from '../examples'
import { MemoryDb, ProjectStore, findProjectNamed } from '../session/projects'
import { mountSamplePersistence } from './samplestore'
import { workspaceSampleStore } from './worksamples'
import type { Project } from '../session/projects'
import { openIdb } from '../session/idb'
import { decodeShare, encodeShare, readShareHash, sharePayloadFor, shareUrl } from '../session/share'
import {
  createInWorkspace, extFor, hasWorkspace, isDesktop, listWorkspace, openProjectDialog,
  openProjectPath, pickWorkspace, renameInWorkspace, saveProject, saveProjectDialog,
  setWorkspaceDir, setWorkspaceLang, trashFile, workspaceDir,
} from '../desktop/bridge'
import type { WorkspaceEntry } from '../desktop/bridge'
import { compile as compileRondo } from '@rondocode/rondo'
import { tabGet, tabSet } from '../session/tabstore'

const ACTIVE_KEY = 'rondocode-active-project'
/** Which project this TAB's editor buffer currently holds.
 *
 *  The buffer and the active id are per-tab now (see session/tabstore.ts), so
 *  two tabs can no longer fight over them. This stays as the second line of
 *  defence: boot reconciles "the buffer is the freshest copy of the active
 *  project", and that claim should be CHECKED rather than assumed — a legacy
 *  profile, a restored session, or storage that refused a write can all leave
 *  the two out of step. A missed reconcile costs the last few keystrokes; a
 *  wrong one costs a whole project. */
const DOC_OWNER_KEY = 'rondocode-doc-owner'

const readDocOwner = (): string | null => {
  const v = tabGet(DOC_OWNER_KEY)
  return v === null || v === '' ? null : v
}

const writeDocOwner = (id: string): void => {
  tabSet(DOC_OWNER_KEY, id)
}

/** The name a conflicted tab forks under.
 *
 *  "(copy)", NOT "(this tab)". A name lives in the project list forever and
 *  is read from every tab, where "this tab" is not true of anything: the
 *  copy was made by whichever tab lost the race, is opened later from tabs
 *  that had nothing to do with it, and outlives every tab involved. It read
 *  as the app describing itself rather than the file.
 *
 *  Numbered rather than suffixed again, because the suffix compounds: a
 *  project that forked three times became "language (copy) (copy) (copy)",
 *  which is both ugly and useless for telling the copies apart.
 *
 *  It also still absorbs the OLD spelling, so a project already carrying
 *  "(this tab)" from a previous version numbers up instead of growing a
 *  second, different suffix. Pure, so the naming is testable without a
 *  database. */
export function forkName(base: string): string {
  const m = /^(.*?) \((?:copy|this tab)(?: (\d+))?\)$/.exec(base)
  if (m === null) return `${base} (copy)`
  return `${m[1]} (copy ${m[2] === undefined ? 2 : Number(m[2]) + 1})`
}

/** May the shared buffer be reconciled into `projectId`?
 *
 *  Only when the buffer is known to belong to it. An UNKNOWN owner is treated
 *  as "yes" for exactly one case — a legacy profile that predates this key and
 *  has only ever had one tab — and as "no" the moment a different owner is
 *  recorded. Pure, so the decision is testable without storage. */
export function bufferBelongsTo(owner: string | null, projectId: string): boolean {
  return owner === null || owner === projectId
}
const SAVE_DEBOUNCE_MS = 600

const BLANK_STARTER = `// new tune. define a synth, then p('name', pattern) to play it.
const blip = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))

p('lead', n('0 3 5 7').scale('c major').sound('blip'))

setCps(0.5)
`

const BLANK_STARTER_RONDO = `# new tune. a synth, a pattern, a tempo.

synth blip
  sine
  * env
  env = adsr .005 .15 0 .1

play blip
  0 3 5 7  scale:c-maj

cps .5
`

/** The blank starter for the editor's CURRENT language. */
const blankStarter = (lang: 'rondocode' | 'rondo'): string =>
  lang === 'rondo' ? BLANK_STARTER_RONDO : BLANK_STARTER

/** Which language is a LEGACY project (no lang field) written in? A rondo doc
 *  compiles as rondo; a JS doc essentially never does (\`const\` is an unknown
 *  block). Cheap, deterministic, only runs for pre-lang records. */
const sniffLang = (code: string): 'rondocode' | 'rondo' =>
  compileRondo(code).ok ? 'rondo' : 'rondocode'

/** Fired on window whenever the active project is (re)established, with the id
 *  in `detail`. Features that keep per-project state OUTSIDE the project record
 *  — the MIDI rig, for one — listen for this instead of the library handing
 *  them a reference, which keeps the library free of their concerns. It fires
 *  once during mount too, so a listener that subscribed first is never left
 *  without an id. */
export const ACTIVE_PROJECT_EVENT = 'rondocode:active-project'

/** The active project's id, or undefined before the library has mounted (or in
 *  private mode, where nothing persists). */
export const getActiveProjectId = (): string | undefined => {
  // PER TAB: a second tab picks this up once, as a seed, and owns it after
  // that — so switching projects here can never move another open tab
  const v = tabGet(ACTIVE_KEY)
  return v === null || v === '' ? undefined : v
}
const getActiveId = getActiveProjectId
const setActiveId = (id: string): void => {
  tabSet(ACTIVE_KEY, id)
  window.dispatchEvent(new CustomEvent(ACTIVE_PROJECT_EVENT, { detail: id }))
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
  /** The project store this library opened. Exposed so the synth shelf can
   *  hold SNIPPETS in it — the library is what decides whether that is
   *  IndexedDB or the in-memory fallback, and a second opener would be a
   *  second answer to that question. */
  store: ProjectStore
  /** The "new" button's path, exposed for the onboarding flow: create a
   *  project and switch the editor to it. The current project is saved and
   *  kept, never clobbered. */
  createAndOpen(name: string, code: string, lang: EditorLang): Promise<void>
  /** Switch to the most recently updated project with this exact name.
   *  Returns false (touching nothing) when no such project exists. */
  openByName(name: string): Promise<boolean>
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
      active = await store.createProject(shared.name, shared.code, shared.lang === 'rondo' ? 'rondo' : 'rondocode')
      // the payload knows its language — a rondo tune must open in rondo mode
      // (and a JS tune must not squiggle under a phone's rondo default)
      editor.setLang(shared.lang === 'rondo' ? 'rondo' : 'rondocode')
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
    // The buffer is the freshest copy of the active project ONLY when it
    // actually came from it. Another tab may have left its own code here, and
    // writing that in would overwrite this project with a different one.
    if (bufferBelongsTo(readDocOwner(), active.id)) {
      // unconditional: this is the boot read-then-write, so there is no
      // earlier version to compare against yet
      const r = await store.saveCode(active.id, bootCode)
      if (r.kind === 'saved' || r.kind === 'unchanged') active = { ...active, updatedAt: r.updatedAt }
    }
  }
  let activeId: string = active.id
  setActiveId(activeId)
  writeDocOwner(activeId)

  // A project's samples are part of the project. Without this the takes a user
  // resamples, records or drops in live only as long as the tab does, and a
  // saved `sample(gate, 'take1')` renders silence the next morning.
  // With a workspace the FILE is the project, so its samples belong beside it
  // on disk (worksamples.ts) rather than in IndexedDB — a database next to a
  // file the user copies, commits and hands over would be lost by all three.
  // Same interface either way, so the persistence layer never branches.
  const samples = mountSamplePersistence({
    audio: editor.audio,
    store: hasWorkspace() ? workspaceSampleStore() : store,
    onError: (m) => console.warn(`[library] ${m}`),
  })
  /** Point the sample layer at the current project. The KEY differs by mode:
   *  an IndexedDB row id in the browser, the file's PATH in a workspace. In a
   *  workspace with nothing open yet there is no key at all, and activating on
   *  the IndexedDB id would have the workspace store resolving a uuid as a
   *  file path — inventing folders next to nothing. */
  const activateSamples = (): void => {
    if (!hasWorkspace()) {
      void samples.activate(activeId)
      return
    }
    if (openPath !== null) void samples.activate(openPath)
  }

  // Pending debounced autosave (see the autosave wiring below), captured with
  // the project id it belongs to. flushSave() writes it immediately — called
  // before every project switch and on dispose so no edit is lost or misfiled.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSave: { id: string; code: string } | undefined

  /** The `updatedAt` this tab last saw for the project it is editing. The
   *  second half of the two-tab fix: tabs no longer SHARE a project id
   *  (session/tabstore.ts), but two tabs can still be opened on the SAME one,
   *  and then both autosave to one record. */
  let baseVersion: number | undefined = active.updatedAt

  /**
   * Autosave with a conflict check, and FORK rather than pick a winner.
   *
   * If another tab wrote this project since we last saw it, overwriting would
   * throw their edit away and keeping quiet would throw ours away — there is
   * no version of "resolve it silently" that does not lose someone's work. So
   * this tab moves its own code to a new project and leaves theirs alone.
   * Both survive, and the fork is visible in the library rather than being a
   * dialog to dismiss under time pressure.
   */
  const autosave = async (id: string, code: string): Promise<void> => {
    const r = await store.saveCode(id, code, baseVersion)
    if (r.kind === 'saved' || r.kind === 'unchanged') { baseVersion = r.updatedAt; return }
    if (r.kind === 'gone') return // deleted in another tab: nothing to write to
    const forked = await store.createProject(forkName(r.theirs.name), code, r.theirs.lang)
    // SAY SO. This moves the user's work to a DIFFERENT project, and until now
    // the only trace was a console.warn — so the project name changed under
    // them with no explanation anywhere they were looking. Losing nothing is
    // only half the job; the other half is knowing it happened.
    activeId = forked.id
    baseVersion = forked.updatedAt
    setActiveId(activeId)
    writeDocOwner(activeId)
    // the fork is a different project, so its samples are its own from here
    activateSamples()
    if (pendingSave !== undefined) pendingSave = { id: forked.id, code: pendingSave.code }
    // the list is declared below; autosave only ever runs after mount
    await render()
    notice(`'${r.theirs.name}' was changed in another tab, so your edits here are now '${forked.name}'. Both are in the project list.`)
    console.warn(`[library] '${r.theirs.name}' changed in another tab — these edits are now '${forked.name}'`)
  }
  const flushSave = (): void => {
    clearTimeout(saveTimer)
    saveTimer = undefined
    if (pendingSave !== undefined) {
      void autosave(pendingSave.id, pendingSave.code)
      // With a workspace, the FILE is the project — the same debounce that
      // saves the database row writes the file, so an edit is never only in
      // one of the two places. IndexedDB stays written as a crash cushion.
      if (openPath !== null) {
        const path = openPath
        void saveProject(path, pendingSave.code).catch((e: unknown) =>
          console.warn('[library] writing', path, 'failed', e),
        )
      }
      pendingSave = undefined
    }
  }

  // ---- top-bar control -------------------------------------------------------
  /* A line the user actually sees, for the one thing here that happens TO
   * them rather than because of them. Dismissable, and it stays until it is
   * dismissed: a fork that scrolls past in three seconds is the same as no
   * notice at all. */
  const noticeBar = el('div', 'lib-notice hidden')
  noticeBar.setAttribute('role', 'status')
  const noticeText = el('span', 'lib-notice-text')
  const noticeClose = el('button', 'lib-notice-close', '\u00d7')
  noticeClose.type = 'button'
  noticeClose.setAttribute('aria-label', 'dismiss')
  noticeClose.addEventListener('click', () => noticeBar.classList.add('hidden'))
  noticeBar.append(noticeText, noticeClose)
  document.body.append(noticeBar)
  const notice = (msg: string): void => {
    noticeText.textContent = msg
    noticeBar.classList.remove('hidden')
  }

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

  // A new project opens in the language you are CURRENTLY working in.
  //
  // It used to prefer the onboarding survey answer (rc.langPref), which meant
  // one answer at first run outranked the toggle forever: flip the editor to
  // rondo, hit new, and get JavaScript back. The survey still seeds the very
  // first language — editor.ts's initialLang() reads it — so consulting it
  // again here only overrode the user's later, more explicit choice.
  const newProjectLang = (): EditorLang => editor.getLang()

  // Switch the editor to a project's working code and mark it active.
  const switchTo = async (p: Project): Promise<void> => {
    // Persist the OUTGOING project's edits before loading the new one: a switch
    // made before the autosave debounce fired must neither drop those edits nor
    // let the pending save (bound to the old id) clobber the incoming project.
    flushSave()
    activeId = p.id
    active = p
    // …AND the version to compare-and-set against. Left on the OUTGOING
    // project's updatedAt, the first autosave here mismatched and was reported
    // as a foreign write: "changed in another tab" plus a fork, on a project
    // nobody else had touched. Opening an example hit it every time.
    baseVersion = p.updatedAt
    // the outgoing project's samples leave the bank with it, and this one's
    // load in — a take belongs to the tune it was made for
    activateSamples()
    // An IndexedDB project is not the file that was open: drop the path FIRST,
    // or the next autosave writes this project's code into that file, and the
    // language toggle below re-extensions it. (openFile sets its own path.)
    openPath = null
    setActiveId(p.id)
    writeDocOwner(p.id) // this tab's buffer now holds THIS project
    setLabel(p.name)
    // a project remembers its language; legacy records are sniffed once
    editor.setLang(p.lang ?? sniffLang(p.code))
    editor.loadCode(p.code)
  }

  // ---- rendering -------------------------------------------------------------
  /** The workspace list: one row per project FILE, newest first. Open, rename
   *  and trash act on the file itself — there is no database copy to drift. */
  const renderWorkspaceList = async (sheet: HTMLElement, now: number): Promise<void> => {
    const dir = workspaceDir()
    if (dir === null) return
    let entries: WorkspaceEntry[]
    try {
      entries = await listWorkspace(dir)
    } catch (e) {
      // a moved or unmounted folder must NOT read as "no projects"
      console.warn('[library] workspace unreadable', e)
      const err = el('div', 'lib-empty', `cannot read ${dir} — was it moved?`)
      sheet.append(err)
      return
    }

    const openFile = async (path: string): Promise<void> => {
      const f = await openProjectPath(path)
      openPath = f.path
      // a workspace project is identified by its PATH: that is the key its
      // samples are filed under, and the previous file's leave the bank here
      activateSamples()
      editor.setLang(f.lang)
      editor.loadCode(f.code)
      setLabel(f.name)
      await render()
    }

    const newRow = el('div', 'lib-ws-new')
    const newName = el('input', 'lib-snap-name') as HTMLInputElement
    newName.placeholder = 'new project name…'
    newName.setAttribute('aria-label', 'new project name')
    const newBtn = el('button', 'lib-mini', 'new file')
    newBtn.type = 'button'
    const doNew = async (): Promise<void> => {
      const name = newName.value.trim()
      if (name === '') return
      try {
        const lang = newProjectLang()
        const path = await createInWorkspace(dir, name, lang, blankStarter(lang))
        newName.value = ''
        await openFile(path)
      } catch (e) {
        console.warn('[library] create failed', e)
        newBtn.textContent = String(e).includes('exists') ? 'name taken' : 'create failed'
        setTimeout(() => (newBtn.textContent = 'new file'), 1800)
      }
    }
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doNew() })
    newBtn.addEventListener('click', () => void doNew())
    newRow.append(newName, newBtn)
    sheet.append(newRow)

    if (entries.length === 0) {
      sheet.append(el('div', 'lib-empty', 'no .rondo or .js files here yet'))
      return
    }

    const list = el('div', 'lib-list')
    for (const entry of entries) {
      const row = el('div', 'lib-row' + (entry.path === openPath ? ' active' : ''))
      const open = el('button', 'lib-row-open')
      open.type = 'button'
      const rowName = el('span', 'lib-row-name', entry.name)
      tooltip(rowName, entry.path)
      open.append(rowName, el('span', 'lib-row-time', ago(entry.modified, now)))
      open.addEventListener('click', () => {
        void (async () => {
          try { await openFile(entry.path) } catch (e) { console.warn('[library] open failed', e) }
        })()
      })

      const ren = el('button', 'lib-mini', 'rename')
      ren.type = 'button'
      ren.addEventListener('click', () => {
        void (async () => {
          const next = prompt('rename project', entry.name)
          if (next === null || next.trim() === '' || next === entry.name) return
          try {
            const moved = await renameInWorkspace(entry.path, next.trim())
            if (openPath === entry.path) openPath = moved
            await render()
          } catch (e) {
            console.warn('[library] rename failed', e)
          }
        })()
      })

      const del = el('button', 'lib-mini lib-danger', 'delete')
      del.type = 'button'
      del.title = 'move to the Trash'
      del.addEventListener('click', () => {
        void (async () => {
          try {
            await trashFile(entry.path)
            if (openPath === entry.path) openPath = null
            await render()
          } catch (e) {
            console.warn('[library] delete failed', e)
          }
        })()
      })

      row.append(open, ren, del)
      list.append(row)
    }
    sheet.append(list)
  }

  /** Path of the workspace file currently open, or null. The single piece of
   *  state the file-backed library needs: everything else lives on disk. */
  let openPath: string | null = null
  // Boot: in the browser this loads the active project's samples now. In a
  // workspace it is a no-op until a file is opened, because until then there
  // is no project to key them to.
  activateSamples()

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
      const at = await store.renameProject(current.id, name)
      // our own write: adopt it, or the next autosave sees a moved record and
      // forks the project we just renamed
      if (at !== undefined && current.id === activeId) baseVersion = at
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
        const lang = newProjectLang()
        const next = rest[0] ?? (await store.createProject('untitled', blankStarter(lang), lang))
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
        const lang = newProjectLang()
        const p = await store.createProject('untitled', blankStarter(lang), lang)
        await switchTo(p)
        await render()
      })()
    })
    // The language is an EXPLICIT part of the choice, never inferred from the
    // editor's current mode: examples group by language, and picking one
    // creates a project in that language (switchTo flips the editor to match).
    const examplePick = el('select', 'lib-example') as HTMLSelectElement
    const ph = el('option', undefined, 'new from example…')
    ph.value = ''
    ph.disabled = true
    ph.selected = true
    examplePick.append(ph)
    const rondoGroup = el('optgroup') as HTMLOptGroupElement
    rondoGroup.label = 'rondo'
    const jsGroup = el('optgroup') as HTMLOptGroupElement
    jsGroup.label = 'javascript'
    EXAMPLES.forEach((ex, i) => {
      if (ex.rondo !== undefined) {
        const opt = el('option', undefined, ex.name)
        opt.value = `r:${i}`
        rondoGroup.append(opt)
      }
      const opt = el('option', undefined, ex.name)
      opt.value = `j:${i}`
      jsGroup.append(opt)
    })
    // rondo first when the editor is IN rondo (the likelier intent stays one
    // flick away) — but both groups are always there, labeled
    examplePick.append(...(editor.getLang() === 'rondo' ? [rondoGroup, jsGroup] : [jsGroup, rondoGroup]))
    examplePick.addEventListener('change', () => {
      const m = /^([jr]):(\d+)$/.exec(examplePick.value)
      const ex = m ? EXAMPLES[Number(m[2])] : undefined
      if (!m || !ex) return
      const useRondo = m[1] === 'r' && ex.rondo !== undefined
      const code = useRondo ? ex.rondo! : ex.code
      void (async () => {
        const p = await store.createProject(ex.name, code, useRondo ? 'rondo' : 'rondocode')
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
    // one button, whatever you hand it: a project .json or a MIDI file
    importInput.accept = 'application/json,.json,audio/midi,.mid,.midi'
    importInput.hidden = true
    importBtn.addEventListener('click', () => importInput.click())
    importInput.addEventListener('change', () => {
      const f = importInput.files?.[0]
      importInput.value = ''
      if (!f) return
      void (async () => {
        try {
          const stem = f.name.replace(/\.[^.]+$/, '') || 'imported'
          if (/\.midi?$/i.test(f.name)) {
            // MIDI: the importer already exists and is tested; it was simply
            // never reachable from the app. It emits JavaScript, so the project
            // is created in that language whatever the editor is currently in.
            const { midiToRondocode } = await import('../midi/import')
            const { code, bpm, bars } = midiToRondocode(await f.arrayBuffer(), { name: stem })
            const p = await store.createProject(stem, code, 'rondocode')
            await switchTo(p)
            await render()
            importBtn.textContent = `${bars} bars @ ${Math.round(bpm)}`
            setTimeout(() => (importBtn.textContent = 'import'), 2400)
            return
          }
          const data = JSON.parse(await f.text()) as { name?: unknown; code?: unknown }
          if (typeof data.code !== 'string') throw new Error('file has no code')
          const p = await store.createProject(
            typeof data.name === 'string' ? data.name : stem,
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
          const payload = await encodeShare(sharePayloadFor(current.name, editor.getDoc(), editor.getLang()))
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

    // DESKTOP ONLY: real files. In the browser a project lives in IndexedDB and
    // leaves as a download; in the shell it can have a home on disk, so these
    // appear only where they can actually work rather than as dead chrome.
    if (isDesktop()) {
      /** Remembered so Save can write without asking again. */
      let filePath: string | null = null
      const flashOn = (b: HTMLButtonElement, label: string, msg: string): void => {
        b.textContent = msg
        setTimeout(() => (b.textContent = label), 1800)
      }

      const openFileBtn = el('button', 'lib-mini', 'open file')
      openFileBtn.type = 'button'
      openFileBtn.addEventListener('click', () => {
        void (async () => {
          try {
            const f = await openProjectDialog()
            if (f === null) return // cancelled
            const p = await store.createProject(f.name, f.code, f.lang)
            filePath = f.path
            await switchTo(p)
            await render()
          } catch (e) {
            console.warn('[library] open file failed', e)
            flashOn(openFileBtn, 'open file', 'open failed')
          }
        })()
      })

      const saveFileBtn = el('button', 'lib-mini', 'save file')
      saveFileBtn.type = 'button'
      saveFileBtn.addEventListener('click', () => {
        void (async () => {
          try {
            const code = editor.getDoc()
            if (filePath !== null) {
              await saveProject(filePath, code)
              flashOn(saveFileBtn, 'save file', 'saved')
              return
            }
            // no home yet: ask once, then remember it for later saves
            const suggested = `${current.name}${extFor(editor.getLang())}`
            const written = await saveProjectDialog(suggested, code)
            if (written === null) return // cancelled
            filePath = written
            flashOn(saveFileBtn, 'save file', 'saved')
          } catch (e) {
            console.warn('[library] save file failed', e)
            flashOn(saveFileBtn, 'save file', 'save failed')
          }
        })()
      })

      ioRow.append(openFileBtn, saveFileBtn)
    }
    sheet.append(ioRow)

    // project list
    /* ---- workspace bar (desktop) --------------------------------------- *
     * The folder IS the library here, so it needs to be visible and
     * changeable, not hidden in a setting. Shown on desktop whether or not one
     * is chosen: with none, this is the call to action. */
    if (isDesktop()) {
      const wsRow = el('div', 'lib-ws')
      const dir = workspaceDir()
      const label = el('span', 'lib-ws-path', dir ?? 'no folder yet — projects live in the app')
      if (dir !== null) tooltip(label, dir) // the row ellipsizes a long path
      const pick = el('button', 'lib-mini', dir === null ? 'choose folder' : 'change')
      pick.type = 'button'
      pick.addEventListener('click', () => {
        void (async () => {
          try {
            const chosen = await pickWorkspace()
            if (chosen === null) return // cancelled
            await render()
          } catch (e) {
            console.warn('[library] choosing a workspace failed', e)
          }
        })()
      })
      wsRow.append(el('span', 'lib-ws-label', 'folder'), label, pick)
      if (dir !== null) {
        const forget = el('button', 'lib-mini', 'use app storage')
        forget.type = 'button'
        forget.title = 'stop using the folder; projects go back to living in the app'
        forget.addEventListener('click', () => {
          // Flush first, then let go of the file: leaving the workspace must
          // save what is on screen, and must not keep writing to a folder the
          // user just stopped using.
          void (async () => { flushSave(); openPath = null; setWorkspaceDir(null); await render() })()
        })
        wsRow.append(forget)
      }
      sheet.append(wsRow)
    }

    // With a workspace, the FILES are the list — the IndexedDB rows below are
    // not consulted at all, so there is exactly one source of truth on screen.
    if (hasWorkspace()) {
      await renderWorkspaceList(sheet, now)
      // no snapshot history here on purpose: those are IndexedDB versions of
      // IndexedDB projects. A file's history is whatever you version it with.
      return
    }

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
  // the active project remembers its language: persist on every toggle (this
  // also migrates legacy no-lang records the first time switchTo sniffs them)
  const offLang = editor.onLang((lang) => {
    // …and the same for the language toggle, which is the one that bit: every
    // js/rondo switch moved updatedAt, so the next autosave forked. Toggle
    // three times and you had "language (this tab) (this tab) (this tab)".
    const id = activeId
    void store.setProjectLang(id, lang).then((at) => {
      if (at !== undefined && id === activeId) baseVersion = at
    })
    // ON DESKTOP THE EXTENSION IS THE LANGUAGE. A workspace file has no
    // database row behind it — the listing reads .rondo/.js back as the
    // project's language — so a toggle that only wrote the row above would
    // leave rondo source in a .js file, and the next open would hand it to the
    // JavaScript evaluator. Move the file BEFORE the pending save flushes, so
    // the debounced write lands on the new path rather than recreating the old
    // one. A clash (both names taken) leaves the file where it is: the edit is
    // still saved, and renaming over someone else's project would be worse.
    if (openPath !== null) {
      const from = openPath
      void setWorkspaceLang(from, lang).then(
        (moved) => {
          if (openPath === from) openPath = moved
          void render()
        },
        (e: unknown) => console.warn('[library] switching', from, 'to', lang, 'failed', e),
      )
    }
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
    offLang()
    flushSave() // persist any debounced edit before tearing down
    samples.dispose()
    noticeBar.remove()
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    projectBtn.remove()
  }

  return {
    store,
    dispose,
    createAndOpen: async (name, code, lang) => {
      const p = await store.createProject(name, code, lang)
      await switchTo(p)
      await render()
    },
    openByName: async (name) => {
      const p = findProjectNamed(await store.listProjects(), name)
      if (!p) return false
      await switchTo(p)
      await render()
      return true
    },
  }
}
