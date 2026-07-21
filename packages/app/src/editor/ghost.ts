/* ------------------------------------------------------------------------- *
 * ghost.ts — Cursor-style inline LLM completions. On ~600ms idle the editor
 * asks the bridge server's /complete endpoint (packages/server/src/complete.ts)
 * to continue the code, and shows the result as dim ghost text after the
 * cursor. Tab accepts, Esc dismisses; any edit or cursor move clears it.
 *
 * Fail-open and unobtrusive: if the endpoint is unreachable or reports no API
 * key (GET /complete/status → {available:false}), the feature stays silent and
 * the editor works exactly as before. It never fights the docs autocomplete
 * popup (no ghost fetch while that is open).
 *
 * The completion request/response contract is server-owned; here we only
 * fetch, render, and accept. The pure accept/eligibility helpers are tested;
 * DOM/timer paths are exercised by hand.
 * ------------------------------------------------------------------------- */
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { StateEffect, StateField, Prec } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { completionStatus } from '@codemirror/autocomplete'

const IDLE_MS = 600

interface Ghost {
  from: number
  text: string
}

const setGhost = StateEffect.define<Ghost | null>()

/** Should we even ask for a completion at this cursor? Pure so it's testable:
 *  only at the end of a non-empty line, single cursor, and not while the docs
 *  autocomplete popup is open. */
export function ghostEligible(state: EditorState): boolean {
  if (completionStatus(state) !== null) return false
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return false // must be at line end
  return line.text.trim().length > 0 // skip blank lines
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ghost'
    span.textContent = this.text
    return span
  }
  override ignoreEvent(): boolean {
    return true
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    // Any doc change or selection move drops the current ghost unless the
    // transaction itself sets a new one.
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    if (tr.docChanged || tr.selection) return null
    return value
  },
  provide: (f) =>
    EditorView.decorations.from(f, (g): DecorationSet =>
      g === null || g.text === ''
        ? Decoration.none
        : Decoration.set([
            Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.from),
          ]),
    ),
})

/** Current ghost, or null. */
const currentGhost = (state: EditorState): Ghost | null => state.field(ghostField, false) ?? null

/** Accept the visible ghost: insert its text at the cursor and clear it.
 *  Returns false (letting Tab fall through to indent) when none is showing. */
function acceptGhost(view: EditorView): boolean {
  const g = currentGhost(view.state)
  if (g === null || g.text === '') return false
  view.dispatch({
    changes: { from: g.from, insert: g.text },
    selection: { anchor: g.from + g.text.length },
    effects: setGhost.of(null),
  })
  return true
}

function dismissGhost(view: EditorView): boolean {
  if (currentGhost(view.state) === null) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

export interface GhostOpts {
  /** Base URL of the completion server. Default: same host, port 6070. */
  baseUrl?: string
  /** Injected fetch for tests. Default: global fetch. */
  fetchImpl?: typeof fetch
}

function defaultBaseUrl(): string {
  // Same host as the page, bridge port. On an https page (tailscale) this
  // dials https://host:6070 which has no TLS listener → fetch fails → silent.
  const loc = location
  return `${loc.protocol}//${loc.hostname}:6070`
}

/** The idle-trigger view plugin: debounce, availability gate, fetch, render. */
function ghostPlugin(opts?: GhostOpts) {
  const baseUrl = opts?.baseUrl ?? defaultBaseUrl()
  const doFetch = opts?.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))

  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined
      private ctrl: AbortController | undefined
      private available: boolean | undefined // undefined = not yet checked
      private readonly chip: HTMLButtonElement

      constructor(readonly view: EditorView) {
        // Mobile "accept" chip (phones have no Tab key). Hidden until a ghost
        // shows; tap inserts it.
        this.chip = document.createElement('button')
        this.chip.className = 'cm-ghost-accept'
        this.chip.textContent = '⇥ accept'
        this.chip.style.display = 'none'
        this.chip.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          acceptGhost(view)
          view.focus()
        })
        view.dom.appendChild(this.chip)
        void this.checkAvailability(baseUrl, doFetch)
      }

      update(u: ViewUpdate): void {
        // Sync the mobile chip to ghost visibility.
        const showing = currentGhost(u.state) !== null
        this.chip.style.display = showing ? 'block' : 'none'
        if (u.docChanged || u.selectionSet) this.schedule()
      }

      private schedule(): void {
        if (this.available === false) return
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.ctrl?.abort()
        this.timer = setTimeout(() => void this.request(), IDLE_MS)
      }

      private async request(): Promise<void> {
        if (!ghostEligible(this.view.state)) return
        const state = this.view.state
        const pos = state.selection.main.head
        const prefix = state.doc.sliceString(0, pos)
        const suffix = state.doc.sliceString(pos)
        const ctrl = new AbortController()
        this.ctrl = ctrl
        try {
          const resp = await doFetch(`${baseUrl}/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prefix, suffix }),
            signal: ctrl.signal,
          })
          if (!resp.ok) return
          const data = (await resp.json()) as { completion?: unknown }
          const text = typeof data.completion === 'string' ? data.completion : ''
          if (text === '' || ctrl.signal.aborted) return
          // Only show it if the cursor hasn't moved since we asked.
          if (this.view.state.selection.main.head !== pos) return
          this.view.dispatch({ effects: setGhost.of({ from: pos, text }) })
        } catch {
          // network/abort — stay silent
        }
      }

      private async checkAvailability(base: string, f: typeof fetch): Promise<void> {
        try {
          const r = await f(`${base}/complete/status`)
          const d = (await r.json()) as { available?: unknown }
          this.available = d.available === true
        } catch {
          this.available = false
        }
      }

      destroy(): void {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.ctrl?.abort()
        this.chip.remove()
      }
    },
  )
}

const ghostTheme = EditorView.baseTheme({
  '.cm-ghost': { opacity: '0.42', fontStyle: 'italic' },
  '.cm-ghost-accept': {
    position: 'absolute',
    right: '10px',
    bottom: '10px',
    zIndex: '20',
    padding: '8px 14px',
    minHeight: '40px',
    borderRadius: '8px',
    border: '1px solid var(--c-line, #333)',
    background: 'var(--c-raised, #1c1c1c)',
    color: 'var(--c-text, #ddd)',
    font: 'inherit',
    cursor: 'pointer',
  },
})

/** The full ghost-completion extension. Add to the editor's extensions. */
export function ghostCompletion(opts?: GhostOpts) {
  return [
    ghostField,
    ghostPlugin(opts),
    ghostTheme,
    Prec.highest(
      keymap.of([
        // Tab accepts only when a ghost shows; otherwise returns false so the
        // normal indent binding still works.
        { key: 'Tab', run: acceptGhost },
        { key: 'Escape', run: dismissGhost },
      ]),
    ),
  ]
}
