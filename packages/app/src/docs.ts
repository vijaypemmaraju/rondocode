import './docs/docs.css'
import { applyPalette } from './ui/palette'
import { HERO, SECTIONS } from './docs/content'
import type { Block, Section } from './docs/content'
import { docsOfKind } from './docs/dsl-docs'
import type { DocEntry } from './docs/dsl-docs'
import { PreviewPlayer } from './docs/player'
import { createDocEditor } from './docs/doceditor'
import { escapeHtml as esc } from './docs/highlight'
import { iconEl } from './ui/icons'
import { docsMarkdown } from './docs/markdown'
import { FLASH_MS } from './editor/flash'
import { encodeShare, shareUrl } from './session/share'

/* A compact, pleasant loop for the hero: the first thing a visitor can play. */
const HERO_DEMO = `const keys = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.006))), 2200, { res: 0.3 })
    .mul(adsr(gate, { a: 0.01, d: 0.4, s: 0.5, r: 0.5 })).mul(0.35))

p('chords', chord('<Cmaj7 Am7 Fmaj7 G>').sound('keys').dur(0.95))
p('arp', n('0 2 4 7 4 2').scale('c major').sound('keys').fast(2).gain(0.28))
setCps(0.5)`

/* ------------------------------------------------------------------------- *
 * The standalone /docs page. A hand-written guide (each snippet a complete,
 * playable program) followed by the auto-generated API reference. Snippets
 * play through a shared PreviewPlayer — one at a time — and each links back
 * into the editor via a share URL. No editor, no audio until the first ▶.
 * ------------------------------------------------------------------------- */

applyPalette()

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const player = new PreviewPlayer()
// The single currently-playing block, so a new ▶ resets the previous one.
let current: { btn: HTMLButtonElement; reset: () => void } | null = null
player.onStop = () => {
  current?.reset()
  current = null
  player.onPatternEvents = undefined
}

/** A playable code block: a full editor (syntax highlight + flash-on-play,
 *  editable), a ▶/⏹ toggle, and an "open in editor" link that tracks edits. */
async function codeBlock(caption: string, src: string): Promise<HTMLElement> {
  const card = el('div', 'doc-code')
  card.append(el('div', 'doc-code-cap', caption))

  const body = el('div', 'doc-code-body')
  card.append(body)

  const actions = el('div', 'doc-code-actions')
  const play = el('button', 'play-btn')
  play.type = 'button'
  const setIdle = (): void => {
    play.classList.remove('playing')
    play.textContent = '▶ play'
  }
  setIdle()
  const err = el('div', 'doc-code-err')

  // "open in editor" reflects the current (possibly edited) source.
  const edit = el('a', 'edit-link', 'open in editor ↗')
  edit.target = '_blank'
  edit.rel = 'noopener'
  const refreshEditLink = async (code: string): Promise<void> => {
    const payload = await encodeShare({ name: caption, code })
    edit.href = shareUrl(location.origin, '/', payload)
  }

  const docEd = createDocEditor(body, src, () => player.now(), () => {
    void refreshEditLink(docEd.getDoc())
  })
  await refreshEditLink(src)

  play.addEventListener('click', () => {
    void (async () => {
      if (current?.btn === play) {
        player.stop()
        return
      }
      current?.reset()
      current = null
      err.textContent = ''
      play.textContent = '…'
      const source = docEd.getDoc()
      player.onPatternEvents = (evs) => docEd.flash(evs) // flash THIS editor
      const res = await player.play(source)
      if (res.ok) {
        docEd.markPlaying(source)
        play.classList.add('playing')
        play.textContent = '⏹ stop'
        current = {
          btn: play,
          reset: () => {
            setIdle()
            docEd.stopFlashes()
          },
        }
      } else {
        setIdle()
        docEd.stopFlashes()
        player.onPatternEvents = undefined
        err.textContent = res.error ?? 'failed'
      }
    })()
  })

  actions.append(play, edit, err)
  card.append(actions)
  return card
}

async function renderBlock(b: Block): Promise<HTMLElement> {
  if (b.kind === 'p') {
    const para = el('p')
    // inline `code` spans in prose
    para.innerHTML = esc(b.text).replace(/`([^`]+)`/g, '<code>$1</code>')
    return para
  }
  return codeBlock(b.caption ?? '', b.text)
}

interface RenderedSection {
  el: HTMLElement
  /** lowercased title + prose + code, for the global search */ text: string
  /** the section's first code block, for the nav "open in editor" deep link */ firstCode?: string
}

async function renderSection(s: Section): Promise<RenderedSection> {
  const sec = el('section', 'doc-section')
  sec.id = s.id
  sec.append(el('h2', undefined, s.title))
  const parts: string[] = [s.title]
  let firstCode: string | undefined
  for (const b of s.blocks) {
    sec.append(await renderBlock(b))
    parts.push(b.kind === 'code' ? `${b.caption ?? ''} ${b.text}` : b.text)
    if (b.kind === 'code' && firstCode === undefined) firstCode = b.text
  }
  return { el: sec, text: parts.join(' ').toLowerCase(), firstCode }
}

const REF_GROUPS: { title: string; kinds: DocEntry['kind'][] }[] = [
  { title: 'globals', kinds: ['global'] },
  { title: 'pattern methods', kinds: ['pattern-method'] },
  { title: 'synth builder', kinds: ['synth-ctx', 'sig-method'] },
  { title: 'mini-notation', kinds: ['mini-syntax'] },
]

/** The reference section. Its `filter(q)` re-renders matching entries and
 *  returns how many matched (0 lets the caller hide the section). The search
 *  box lives at the page top now and drives this + the guide together. */
function renderReference(): { section: HTMLElement; filter: (q: string) => number } {
  const wrap = el('section', 'doc-ref')
  wrap.id = 'reference'
  wrap.append(el('h2', undefined, 'Reference'))
  const p = el('p')
  p.textContent = 'Every function and symbol in the language.'
  wrap.append(p)
  const list = el('div')
  wrap.append(list)

  const filter = (query = ''): number => {
    list.replaceChildren()
    const q = query.trim().toLowerCase()
    let count = 0
    for (const grp of REF_GROUPS) {
      const entries = grp.kinds
        .flatMap((k) => docsOfKind(k))
        .filter((e) => q === '' || `${e.name} ${e.signature} ${e.summary}`.toLowerCase().includes(q))
      if (entries.length === 0) continue
      list.append(el('h3', 'ref-group', grp.title))
      for (const e of entries) {
        const row = el('div', 'ref-entry')
        row.append(el('div', 'ref-sig', e.signature))
        row.append(el('div', 'ref-sum', e.summary))
        if (e.example !== undefined) row.append(el('code', 'ref-ex', e.example))
        list.append(row)
        count++
      }
    }
    return count
  }
  filter()
  return { section: wrap, filter }
}

function renderShortcuts(): HTMLElement {
  const sec = el('section', 'doc-section')
  sec.id = 'shortcuts'
  sec.append(el('h2', undefined, 'Keyboard shortcuts'))
  const rows: [string, string][] = [
    ['Cmd/Ctrl + Enter', 'run, or update the running program'],
    ['Cmd/Ctrl + .', 'stop'],
    ['Cmd/Ctrl + P', 'open the projects menu'],
    ['Cmd/Ctrl + D', 'add the next occurrence to the selection (multi-cursor)'],
    ['Alt + drag a number', 'scrub it like a slider'],
    ['double-click a widget', 'edit its underlying value as text'],
  ]
  const list = el('dl', 'kbd-list')
  for (const [k, d] of rows) {
    const row = el('div', 'kbd-row')
    row.append(el('kbd', undefined, k), el('span', undefined, d))
    list.append(row)
  }
  sec.append(list)
  return sec
}

function renderFooter(): HTMLElement {
  const foot = el('footer', 'doc-footer')
  foot.append(el('span', undefined, 'rondocode'))
  const link = (text: string, href: string, blank = false): HTMLAnchorElement => {
    const a = el('a', undefined, text)
    a.href = href
    if (blank) {
      a.target = '_blank'
      a.rel = 'noopener'
    }
    return a
  }
  foot.append(
    link('open the editor', '/'),
    link('GitHub', 'https://github.com/vijaypemmaraju/rondocode', true),
    link('MIT license', 'https://github.com/vijaypemmaraju/rondocode/blob/main/LICENSE', true),
  )
  return foot
}

async function build(): Promise<void> {
  // flash pulse duration for the .cm-flash animation (see docs.css)
  document.documentElement.style.setProperty('--flash-ms', `${FLASH_MS}ms`)

  // header
  const top = el('header', 'doc-top')
  const brand = el('a', 'brand', 'rondocode')
  brand.href = '/'
  const label = el('span')
  label.style.color = 'var(--c-dim)'
  label.style.fontFamily = 'var(--mono)'
  label.style.fontSize = 'var(--fs-ctrl)'
  label.textContent = 'docs'
  top.append(brand, label, el('div', 'spacer'))
  // copy the whole docs as Markdown, for pasting into an LLM
  const copyBtn = el('button', 'doc-copy', 'copy for LLMs')
  copyBtn.type = 'button'
  copyBtn.title = 'copy the guide + reference as Markdown (also at /llms.txt)'
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard
      .writeText(docsMarkdown())
      .then(() => {
        copyBtn.textContent = 'copied'
        setTimeout(() => (copyBtn.textContent = 'copy for LLMs'), 1500)
      })
      .catch(() => {
        copyBtn.textContent = 'copy failed'
        setTimeout(() => (copyBtn.textContent = 'copy for LLMs'), 1500)
      })
  })
  const cta = el('a', 'cta', 'open the editor →')
  cta.href = '/'
  top.append(copyBtn, cta)
  document.body.append(top)

  const wrap = el('div', 'doc-wrap')
  const nav = el('nav', 'doc-nav')
  const main = el('main', 'doc-main')
  wrap.append(nav, main)
  document.body.append(wrap)

  // hero
  const hero = el('div', 'doc-hero')
  hero.append(el('h1', undefined, HERO.title))
  hero.append(el('p', 'tagline', HERO.tagline))
  hero.append(el('p', 'blurb', HERO.blurb))
  const search = el('input', 'doc-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'search the docs…'
  search.setAttribute('aria-label', 'search the docs')
  hero.append(search)
  main.append(hero)

  // hero mini-demo: a compact, playable tune right at the top
  const demo = await codeBlock('a tiny loop, press play', HERO_DEMO)
  demo.classList.add('doc-hero-demo')
  main.append(demo)

  // nav + guide sections (capture text for search + first code for a deep link)
  const navLinks: { id: string; a: HTMLAnchorElement }[] = []
  const guide: { text: string; el: HTMLElement; row: HTMLElement }[] = []
  const addNav = (id: string, title: string, firstCode?: string): HTMLElement => {
    const row = el('div', 'nav-item')
    const a = el('a', undefined, title)
    a.href = `#${id}`
    row.append(a)
    if (firstCode !== undefined) {
      const open = el('a', 'nav-open')
      open.append(iconEl('external'))
      open.title = 'open in editor'
      open.setAttribute('aria-label', `open ${title} in the editor`)
      open.target = '_blank'
      open.rel = 'noopener'
      void encodeShare({ name: title, code: firstCode }).then((pl) => {
        open.href = shareUrl(location.origin, '/', pl)
      })
      row.append(open)
    }
    nav.append(row)
    navLinks.push({ id, a })
    return row
  }
  nav.append(el('div', 'nav-group', 'guide'))
  for (const s of SECTIONS) {
    const r = await renderSection(s)
    main.append(r.el)
    const row = addNav(s.id, s.title, r.firstCode)
    guide.push({ text: r.text, el: r.el, row })
  }

  // reference + shortcuts
  nav.append(el('div', 'nav-group', 'reference'))
  const ref = renderReference()
  main.append(ref.section)
  const refRow = addNav('reference', 'Reference')
  const shortcuts = renderShortcuts()
  main.append(shortcuts)
  const shortcutsRow = addNav('shortcuts', 'Shortcuts')
  main.append(renderFooter())

  // one search over guide + reference: hide non-matching sections/nav rows
  const noHits = el('p', 'doc-nohits', 'no matches')
  noHits.style.display = 'none'
  main.insertBefore(noHits, ref.section)
  const applySearch = (): void => {
    const q = search.value.trim().toLowerCase()
    const searching = q !== ''
    let shown = 0
    for (const g of guide) {
      const match = !searching || g.text.includes(q)
      g.el.style.display = match ? '' : 'none'
      g.row.style.display = match ? '' : 'none'
      if (match) shown++
    }
    const refCount = ref.filter(q)
    const refShow = !searching || refCount > 0
    ref.section.style.display = refShow ? '' : 'none'
    refRow.style.display = refShow ? '' : 'none'
    if (refShow) shown += refCount
    // the demo + shortcuts are noise while searching
    demo.style.display = searching ? 'none' : ''
    shortcuts.style.display = searching ? 'none' : ''
    shortcutsRow.style.display = searching ? 'none' : ''
    noHits.style.display = shown === 0 ? '' : 'none'
  }
  search.addEventListener('input', applySearch)

  // scroll-spy: highlight the nav link for the section in view
  const byId = new Map(navLinks.map((l) => [l.id, l.a]))
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          navLinks.forEach((l) => l.a.classList.remove('on'))
          byId.get((e.target as HTMLElement).id)?.classList.add('on')
        }
      }
    },
    { rootMargin: '-72px 0px -70% 0px' },
  )
  for (const { id } of navLinks) {
    const node = document.getElementById(id)
    if (node) spy.observe(node)
  }
}

void build()
