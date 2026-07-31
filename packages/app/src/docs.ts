import './docs/docs.css'
import { applyPalette } from './ui/palette'
import { HERO, blockText, orderedSections } from './docs/content'
import type { Block, Section } from './docs/content'
import { blockHtml } from './docs/blocks'
import { docsOfKind } from './docs/dsl-docs'
import type { DocEntry } from './docs/dsl-docs'
import type { PreviewPlayer } from './docs/player'
import type { createShaderRenderer } from './shaderviz/renderer'
import { createDocEditor } from './docs/doceditor'
import { compile as compileRondo } from '@rondocode/rondo'
import { iconEl } from './ui/icons'
import { docsMarkdown } from './docs/markdown'
import { FLASH_MS } from './editor/flash'
import { encodeShare, sharePayloadFor, shareUrl } from './session/share'

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

/* ---- the heavy half loads on demand: the preview player (audio engine +
 *  session + sing manager) and the WebGPU renderer are only needed once a
 *  visitor presses ▶. Reading, live widgets and edit links all work without
 *  them, so the docs page's eager graph stays light. `player` is null until
 *  the first play; every pre-play touch point below no-ops through `?.`
 *  exactly like the player's own pre-boot no-ops. */
let player: PreviewPlayer | null = null
let mkShaderRenderer: typeof createShaderRenderer | null = null
let playerLoading: Promise<PreviewPlayer> | null = null
const loadPlayer = (): Promise<PreviewPlayer> => {
  playerLoading ??= Promise.all([import('./docs/player'), import('./shaderviz/renderer')]).then(([pl, sv]) => {
    mkShaderRenderer = sv.createShaderRenderer
    const p = new pl.PreviewPlayer()
    p.onStop = () => {
      current?.reset()
      current = null
      p.onPatternEvents = undefined
      hideViz()
    }
    p.onVisual = (wgsl, synths) => {
      latestVisual = { wgsl, synths }
    }
    player = p
    return p
  })
  return playerLoading
}

// The single currently-playing block, so a new ▶ resets the previous one.
let current: { btn: HTMLButtonElement; reset: () => void } | null = null

/* ---- inline visuals: one shared WebGPU canvas, moved into the playing block
 *  when its snippet registered a visual() and rendered live from the preview
 *  audio (see shaderviz/renderer.ts). Lazily created on first use. */
let vizCanvas: HTMLCanvasElement | null = null
let vizRenderer: ReturnType<typeof createShaderRenderer> | null = null
let latestVisual: { wgsl: string | null; synths: string[] } = { wgsl: null, synths: [] }

const ensureViz = (): { canvas: HTMLCanvasElement; renderer: ReturnType<typeof createShaderRenderer> } => {
  if (!vizCanvas) {
    vizCanvas = el('canvas', 'doc-viz-canvas hidden')
    // only reachable after a successful play, so the lazy module is loaded
    vizRenderer = mkShaderRenderer!(vizCanvas, {
      now: () => player?.now() ?? 0,
      analyser: () => player?.analyser ?? null,
      sampleRate: () => player?.sampleRate ?? 48000,
      onError: (msg) => {
        if (msg) console.warn('[docs-viz]', msg)
      },
    })
  }
  return { canvas: vizCanvas, renderer: vizRenderer! }
}

const hideViz = (): void => {
  vizRenderer?.setActive(false)
  vizCanvas?.classList.add('hidden')
}

/** Show the shared visual canvas inside `host`, rendering `latestVisual`. */
const showViz = (host: HTMLElement): void => {
  if (latestVisual.wgsl === null) {
    hideViz()
    return
  }
  const { canvas, renderer } = ensureViz()
  host.append(canvas)
  canvas.classList.remove('hidden')
  renderer.setVisual(latestVisual.wgsl, latestVisual.synths)
  renderer.setCps(player?.cps ?? 0.5)
  renderer.setActive(true)
}

/** A playable code block: a full editor (syntax highlight + flash-on-play,
 *  editable), a ▶/⏹ toggle, and an "open in editor" link that tracks edits. */
async function codeBlock(caption: string, src: string, lang?: 'rondo'): Promise<HTMLElement> {
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
    const payload = await encodeShare(sharePayloadFor(caption, code, lang))
    edit.href = shareUrl(location.origin, '/', payload)
  }

  // rondo snippets transpile before the player sees them; a compile failure
  // surfaces in the block's error line with its rondo position.
  const toEval = (source: string): { code: string; notes?: import('@rondocode/rondo').NoteSpan[]; jsRegions?: import('@rondocode/rondo').JsRegion[]; pulses?: import('@rondocode/rondo').PulseSpan[] } | { error: string } => {
    if (lang !== 'rondo') return { code: source }
    const r = compileRondo(source)
    if (!r.ok) {
      const e = r.errors[0]
      return { error: e !== undefined ? `line ${e.line}: ${e.message}` : 'rondo compile failed' }
    }
    return { code: r.code, notes: r.notes, jsRegions: r.jsRegions, pulses: r.pulses }
  }

  const docEd = createDocEditor(
    body,
    src,
    () => player?.now() ?? 0,
    () => {
      void refreshEditLink(docEd.getDoc())
    },
    () => {
      // a widget/scrub rewrote the code — hot-patch the sound if THIS block is
      // the one currently playing (otherwise the edit just updates the text).
      if (current?.btn === play) {
        const r = toEval(docEd.getDoc())
        if (!('error' in r)) player?.update(r.code)
      }
    },
    // karaoke: the playing snippet's vocals live on player.singSounds, so this
    // resolves correctly for THIS block whenever it's the one sounding.
    (snd) => player?.singSounds.has(snd) ?? false,
    lang,
    // docs knobs are LIVE: hold plays the hand's value immediately through the
    // preview session (a DEF rewrite alone is rebuild-class — audible only
    // after the drag settles, which reads as "updates on release")
    {
      now: () => player?.now() ?? 0,
      holdParam: (sy, nm, v) => player?.holdParam(sy, nm, v),
      releaseParam: (sy, nm) => player?.releaseParam(sy, nm),
      holdMacro: (nm, v) => player?.holdMacro(nm, v),
      releaseMacro: (nm) => player?.releaseMacro(nm),
    },
  )
  await refreshEditLink(src)

  play.addEventListener('click', () => {
    void (async () => {
      if (current?.btn === play) {
        player?.stop()
        return
      }
      current?.reset()
      current = null
      err.textContent = ''
      play.textContent = '…'
      const source = docEd.getDoc()
      const evalSrc = toEval(source)
      if ('error' in evalSrc) {
        setIdle()
        err.textContent = evalSrc.error
        return
      }
      // first play fetches the on-demand player chunk (instant once cached)
      let p: PreviewPlayer
      try {
        p = await loadPlayer()
      } catch {
        setIdle()
        err.textContent = 'could not load the player. Check your connection and try again.'
        return
      }
      // flash THIS editor and (when it has a visual) feed the shared renderer
      p.onPatternEvents = (evs) => {
        docEd.flash(evs)
        if (latestVisual.wgsl !== null) vizRenderer?.pushEvents(evs)
      }
      const res = await p.play(evalSrc.code)
      if (res.ok) {
        docEd.markPlaying(source, evalSrc.notes, evalSrc.jsRegions, evalSrc.pulses)
        play.classList.add('playing')
        play.textContent = '⏹ stop'
        showViz(card) // no-op unless the snippet registered a visual()
        current = {
          btn: play,
          reset: () => {
            setIdle()
            docEd.stopFlashes()
            hideViz()
          },
        }
      } else {
        setIdle()
        docEd.stopFlashes()
        p.onPatternEvents = undefined
        err.textContent = res.error ?? 'failed'
      }
    })()
  })

  actions.append(play, edit, err)
  card.append(actions)
  return card
}

/** Parse one element out of a trusted HTML string (docs/blocks.ts escapes
 *  every author-supplied value before it gets here). */
const fromHtml = (html: string): HTMLElement => {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content.firstElementChild as HTMLElement
}

async function renderBlock(b: Block): Promise<HTMLElement> {
  // code blocks are live editors; every other kind is pure markup shared with
  // the tests (docs/blocks.ts), so a new kind renders here for free.
  if (b.kind === 'code') return codeBlock(b.caption ?? '', b.text, b.lang)
  return fromHtml(blockHtml(b))
}

interface RenderedSection {
  el: HTMLElement
  /** lowercased title + prose + code, for the global search */ text: string
  /** the section's first code block, for the nav "open in editor" deep link */ firstCode?: string
  /** and the language it is written in — a rondo snippet must not open as JS */ firstLang?: 'rondo'
}

async function renderSection(s: Section): Promise<RenderedSection> {
  const sec = el('section', 'doc-section')
  sec.id = s.id
  sec.append(el('h2', undefined, s.title))
  const parts: string[] = [s.title]
  let firstCode: string | undefined
  let firstLang: 'rondo' | undefined
  for (const b of s.blocks) {
    sec.append(await renderBlock(b))
    // blockText knows every kind, so a table/list/note stays findable by search
    parts.push(blockText(b))
    if (b.kind === 'code' && firstCode === undefined) {
      firstCode = b.text
      firstLang = b.lang
    }
  }
  return { el: sec, text: parts.join(' ').toLowerCase(), firstCode, firstLang }
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
    ['Cmd/Ctrl + Shift + F', 'format the whole document (either language)'],
    ['Cmd/Ctrl + /', 'comment or uncomment the line or selection'],
    ['Cmd/Ctrl + click a name', 'jump to its definition (a binding, synth, section, wavedef or scale)'],
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
  // Mobile contents toggle: hidden on desktop by CSS, where the nav is a
  // sticky sidebar and always visible.
  const navToggle = el('button', 'nav-toggle')
  navToggle.type = 'button'
  navToggle.textContent = 'contents'
  navToggle.setAttribute('aria-expanded', 'false')
  navToggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open')
    navToggle.setAttribute('aria-expanded', String(open))
  })
  // tapping a link closes the panel: it navigated, the list is in the way
  nav.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a') && nav.classList.contains('open')) {
      nav.classList.remove('open')
      navToggle.setAttribute('aria-expanded', 'false')
    }
  })
  const main = el('main', 'doc-main')
  wrap.append(navToggle, nav, main)
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
  // Groups are CONTAINERS, not sibling headings: on a phone the nav collapses
  // to one "contents" button and opens as grouped chips, so the guide starts
  // with the guide instead of a wall of links.
  let navBody: HTMLElement = nav
  const startGroup = (name: string): void => {
    const sect = el('div', 'nav-sect')
    sect.append(el('div', 'nav-group', name))
    nav.append(sect)
    navBody = sect
  }
  const addNav = (id: string, title: string, firstCode?: string, firstLang?: 'rondo'): HTMLElement => {
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
      void encodeShare(sharePayloadFor(title, firstCode, firstLang)).then((pl) => {
        open.href = shareUrl(location.origin, '/', pl)
      })
      row.append(open)
    }
    navBody.append(row)
    navLinks.push({ id, a })
    return row
  }
  let lastGroup = ''
  for (const s of orderedSections()) {
    if (s.group !== lastGroup) {
      startGroup(s.group)
      lastGroup = s.group
    }
    const r = await renderSection(s)
    main.append(r.el)
    const row = addNav(s.id, s.title, r.firstCode, r.firstLang)
    guide.push({ text: r.text, el: r.el, row })
  }

  // reference + shortcuts
  startGroup('reference')
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
