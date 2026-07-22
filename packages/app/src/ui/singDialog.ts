/* ------------------------------------------------------------------------- *
 * sing() render dialog. A centered overlay that appears while a vocal clip is
 * baking (model download + neural render) and hides when idle. Driven purely by
 * singMgr.onSingProgress — no imperative show/hide from callers. Mounted once
 * from the editor. Non-blocking to the DOM: it never steals focus or captures
 * input; live edits keep flowing (background bakes are silent unless slow).
 * ------------------------------------------------------------------------- */
import { onSingProgress } from '../sing/singMgr'

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

  onSingProgress((p) => {
    if (!p) {
      el.classList.add('hidden')
      return
    }
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
