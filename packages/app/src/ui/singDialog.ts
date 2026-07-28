/* ------------------------------------------------------------------------- *
 * sing() render dialog. A centered overlay that appears while a vocal clip is
 * baking (model download + neural render) and hides when idle. Driven purely by
 * singMgr.onSingProgress — no imperative show/hide from callers. Mounted once
 * from the editor. Non-blocking while baking: it never steals focus or captures
 * input, so live edits keep flowing (background bakes are silent unless slow).
 * The ERROR state is the one exception - it takes pointer events so its close
 * button works, and the transition rules live in singDialogState.ts.
 * ------------------------------------------------------------------------- */
import './singDialog.css'
import { isIOSWebKit } from '../sing/config'
import { onSingProgress, onSingError } from '../sing/singMgr'
import { singDialogNext } from './singDialogState'
import type { SingDialogEvent, SingDialogMode, SingDialogNext } from './singDialogState'
import { takeCrashReport } from '../sing/bakephase'

/** First-time consent: singing needs a large one-time model download, so ask
 *  before kicking it off (only called when the models aren't cached yet).
 *  Resolves true to proceed, false to skip. */
export function confirmSingDownload(): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.className = 'sing-consent'
    // iOS/iPadOS: the full model set is more memory than a phone tab allows -
    // the old flow let users download gigabytes and THEN die. Explain and play
    // the track without the vocal instead. A ~3.5x smaller int8 aligner build
    // now exists (phonemes.ts prefers it on iOS), but this block stays until a
    // real device test passes. Escape hatch for that test: set
    // localStorage['rc.singForce'] = '1' to get the normal consent flow here.
    const force = ((): boolean => {
      try { return localStorage.getItem('rc.singForce') === '1' } catch { return false }
    })()
    if (isIOSWebKit() && !force) {
      el.innerHTML = `
      <div class="sing-consent-card" role="dialog" aria-modal="true">
        <div class="sing-consent-title">Singing needs a bigger device</div>
        <div class="sing-consent-body">Baking a vocal runs ~2.6&nbsp;GB of neural models, more memory than a phone browser tab allows. The track will play without the vocal here. On a laptop or desktop the same code sings.</div>
        <div class="sing-consent-actions">
          <button class="sing-consent-go" type="button">Play without vocal</button>
        </div>
      </div>`
      const done = (): void => {
        el.remove()
        resolve(false) // the declined path: play the track, skip the bake
      }
      el.querySelector('.sing-consent-go')!.addEventListener('click', done)
      document.body.appendChild(el)
      return
    }
    el.innerHTML = `
      <div class="sing-consent-card" role="dialog" aria-modal="true">
        <div class="sing-consent-title">Download voice models?</div>
        <div class="sing-consent-body">Singing runs a neural voice entirely on your device. The first play downloads the voice models (~2.6&nbsp;GB with the aligner), then they're cached, so later plays are instant. This can take a while on your connection.</div>
        <div class="sing-consent-actions">
          <button class="sing-consent-cancel" type="button">Not now</button>
          <button class="sing-consent-go" type="button">Download &amp; play</button>
        </div>
      </div>`
    document.body.appendChild(el)
    const done = (v: boolean): void => { el.remove(); resolve(v) }
    el.querySelector<HTMLButtonElement>('.sing-consent-cancel')!.addEventListener('click', () => done(false))
    el.querySelector<HTMLButtonElement>('.sing-consent-go')!.addEventListener('click', () => done(true))
    el.addEventListener('click', (e) => { if (e.target === el) done(false) })
    el.querySelector<HTMLButtonElement>('.sing-consent-go')!.focus()
  })
}

export function mountSingDialog(): void {
  if (document.getElementById('sing-dialog')) return

  // Crash-point telemetry: if the LAST bake died mid-phase (iOS kills an
  // out-of-memory tab with no error at all), say where it stopped - in the
  // console now, and in the bake dialog the next time a bake runs.
  const crash = takeCrashReport()
  if (crash) {
    // eslint-disable-next-line no-console
    console.warn(`[sing] last vocal bake stopped at "${crash.phase}" - the tab likely ran out of memory there`)
  }

  const el = document.createElement('div')
  el.id = 'sing-dialog'
  el.className = 'sing-dialog hidden'
  el.innerHTML = `
    <div class="sing-card">
      <button class="sing-close" type="button" title="dismiss" aria-label="dismiss">&times;</button>
      <div class="sing-title">baking vocals…</div>
      <div class="sing-label"></div>
      <div class="sing-bar"><div class="sing-fill"></div></div>
      <div class="sing-crashnote hidden"></div>
    </div>`
  document.body.appendChild(el)
  const label = el.querySelector<HTMLElement>('.sing-label')!
  const fill = el.querySelector<HTMLElement>('.sing-fill')!
  const crashNote = el.querySelector<HTMLElement>('.sing-crashnote')!
  if (crash) {
    crashNote.textContent = `last vocal bake stopped at ${crash.phase} - the tab likely ran out of memory there`
    crashNote.classList.remove('hidden')
  }

  const HUMAN: Record<string, string> = {
    download: 'downloading models',
    synthesize: 'speaking the words',
    align: 'aligning phonemes',
    sing: 'singing',
  }

  const title = el.querySelector<HTMLElement>('.sing-title')!
  const closeBtn = el.querySelector<HTMLButtonElement>('.sing-close')!
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  let mode: SingDialogMode = 'hidden'

  /** Run one event through the transition table and paint the result. */
  const send = (ev: SingDialogEvent): SingDialogNext => {
    const next = singDialogNext(mode, ev)
    mode = next.mode
    if (next.clearTimer) {
      clearTimeout(errorTimer)
      errorTimer = undefined
    }
    if (next.armTimer > 0) errorTimer = setTimeout(() => send({ kind: 'timeout' }), next.armTimer)
    el.classList.toggle('hidden', mode === 'hidden')
    el.classList.toggle('sing-error', mode === 'error')
    return next
  }

  // The dialog is a click-through overlay while a bake runs (you can keep
  // editing), which is exactly why the error state needs its own way out: the
  // card only accepts clicks in .sing-error (see the CSS), and this is it.
  closeBtn.addEventListener('click', () => send({ kind: 'dismiss' }))
  // Escape too — but only while an error shows; swallowing Escape during a
  // bake would steal it from the editor.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (send({ kind: 'escape' }).handled) e.preventDefault()
  })

  // A failed bake used to vanish silently. Now it stays put long enough to
  // read the message and copy it, with an explicit close.
  onSingError((msg) => {
    send({ kind: 'error' })
    title.textContent = 'singing failed'
    label.textContent = msg
    fill.style.width = '100%'
    fill.classList.remove('indeterminate')
  })

  onSingProgress((p) => {
    if (!p) {
      send({ kind: 'idle' })
      return
    }
    send({ kind: 'progress' })
    title.textContent = 'baking vocals…'
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
    const isDownload = p.phase === 'download'
    const mb = (n: number): string => (n / 1e6).toFixed(0)
    label.textContent = isDownload
      ? `${p.label} — ${mb(p.done)} / ${mb(p.total)} MB`
      : (HUMAN[p.phase] ?? p.label)
    fill.style.width = isDownload ? `${pct}%` : '100%'
    fill.classList.toggle('indeterminate', !isDownload)
  })
}
