import './docs/docs.css'
import { applyPalette } from './ui/palette'
import { HERO, SECTIONS } from './docs/content'
import type { Block, Section } from './docs/content'
import { docsOfKind } from './docs/dsl-docs'
import type { DocEntry } from './docs/dsl-docs'
import { PreviewPlayer } from './docs/player'
import { createDocEditor } from './docs/doceditor'
import { escapeHtml as esc } from './docs/highlight'
import { FLASH_MS } from './editor/flash'
import { encodeShare, shareUrl } from './session/share'

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

async function renderSection(s: Section): Promise<HTMLElement> {
  const sec = el('section', 'doc-section')
  sec.id = s.id
  sec.append(el('h2', undefined, s.title))
  for (const b of s.blocks) sec.append(await renderBlock(b))
  return sec
}

const REF_GROUPS: { title: string; kinds: DocEntry['kind'][] }[] = [
  { title: 'globals', kinds: ['global'] },
  { title: 'pattern methods', kinds: ['pattern-method'] },
  { title: 'synth builder', kinds: ['synth-ctx', 'sig-method'] },
  { title: 'mini-notation', kinds: ['mini-syntax'] },
]

function renderReference(): { section: HTMLElement; search: HTMLInputElement } {
  const wrap = el('section', 'doc-ref')
  wrap.id = 'reference'
  wrap.append(el('h2', undefined, 'Reference'))
  const p = el('p')
  p.textContent = 'Every function and symbol in the language. Type to filter.'
  wrap.append(p)
  const search = el('input', 'doc-ref-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'search the reference…'
  wrap.append(search)
  const list = el('div')
  wrap.append(list)

  const render = (query = ''): void => {
    list.replaceChildren()
    const q = query.trim().toLowerCase()
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
      }
    }
    if (list.children.length === 0) list.append(el('p', undefined, 'no matches'))
  }
  render()
  search.addEventListener('input', () => render(search.value))
  return { section: wrap, search }
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
  const cta = el('a', 'cta', 'open the editor →')
  cta.href = '/'
  top.append(cta)
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
  main.append(hero)

  // guide sections
  const navLinks: { id: string; a: HTMLAnchorElement }[] = []
  const addNav = (id: string, title: string): void => {
    const a = el('a', undefined, title)
    a.href = `#${id}`
    nav.append(a)
    navLinks.push({ id, a })
  }
  nav.append(el('div', 'nav-group', 'guide'))
  for (const s of SECTIONS) {
    main.append(await renderSection(s))
    addNav(s.id, s.title)
  }

  // reference
  nav.append(el('div', 'nav-group', 'reference'))
  const ref = renderReference()
  main.append(ref.section)
  addNav('reference', 'Reference')

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
