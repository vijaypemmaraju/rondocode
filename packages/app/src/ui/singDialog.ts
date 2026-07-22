/* ------------------------------------------------------------------------- *
 * sing() render dialog. A centered overlay that appears while a vocal clip is
 * baking (model download + neural render) and hides when idle. Driven purely by
 * singMgr.onSingProgress — no imperative show/hide from callers. Mounted once
 * from the editor. Non-blocking to the DOM: it never steals focus or captures
 * input; live edits keep flowing (background bakes are silent unless slow).
 * ------------------------------------------------------------------------- */
import { onSingProgress, onSingError } from '../sing/singMgr'

/** First-time consent: singing needs a large one-time model download, so ask
 *  before kicking it off (only called when the models aren't cached yet).
 *  Resolves true to proceed, false to skip. */
export function confirmSingDownload(): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.className = 'sing-consent'
    el.innerHTML = `
      <div class="sing-consent-card" role="dialog" aria-modal="true">
        <div class="sing-consent-title">Download voice models?</div>
        <div class="sing-consent-body">Singing runs a neural voice entirely on your device. The first play downloads the voice models (~2&nbsp;GB), then they're cached — later plays are instant. This can take a few minutes on your connection.</div>
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
  const el = document.createElement('div')
  el.id = 'sing-dialog'
  el.className = 'sing-dialog hidden'
  el.innerHTML = `
    <div class="sing-card">
      <div class="sing-title">baking vocals…</div>
      <div class="sing-label"></div>
      <div class="sing-bar"><div class="sing-fill"></div></div>
    </div>`
  document.body.appendChild(el)
  const label = el.querySelector<HTMLElement>('.sing-label')!
  const fill = el.querySelector<HTMLElement>('.sing-fill')!

  const HUMAN: Record<string, string> = {
    download: 'downloading models',
    synthesize: 'speaking the words',
    align: 'aligning phonemes',
    sing: 'singing',
  }

  const title = el.querySelector<HTMLElement>('.sing-title')!
  let errorTimer: ReturnType<typeof setTimeout> | undefined

  // A failed bake used to vanish silently; show it, then auto-dismiss.
  onSingError((msg) => {
    clearTimeout(errorTimer)
    el.classList.remove('hidden')
    el.classList.add('sing-error')
    title.textContent = 'singing failed'
    label.textContent = msg
    fill.style.width = '100%'
    fill.classList.remove('indeterminate')
    errorTimer = setTimeout(() => el.classList.add('hidden'), 8000)
  })

  onSingProgress((p) => {
    if (!p) {
      if (!el.classList.contains('sing-error')) el.classList.add('hidden')
      return
    }
    clearTimeout(errorTimer)
    el.classList.remove('sing-error')
    title.textContent = 'baking vocals…'
    el.classList.remove('hidden')
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
