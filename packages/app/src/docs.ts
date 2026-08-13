import './docs/docs.css'
import { applyPalette } from './ui/palette'
import { HERO, blockProse, blockText, orderedSections } from './docs/content'
import { ROUTES, crossRouteHits, routeFor, sectionsFor, viewForPath } from './docs/routes'
import { highlight, rank, snippet, terms } from './docs/search'
import { filterGroups, referenceGroups } from './editor/reference'
import { OPTIONS } from './editor/rondo'
import type { EditorLang } from './editor/editor'
import type { Block, Section } from './docs/content'
import { blockHtml } from './docs/blocks'
import { DSL_DOCS } from './docs/dsl-docs'
import type { DocEntry } from './docs/dsl-docs'
import type { PreviewPlayer } from './docs/player'
import type { createShaderRenderer } from './shaderviz/renderer'
import { createDocEditor } from './docs/doceditor'
import { compile as compileRondo, decompile as decompileRondo } from '@rondocode/rondo'
import { iconEl } from './ui/icons'
import { docsMarkdown } from './docs/markdown'
import { FLASH_MS } from './editor/flash'
import { encodeShare, sharePayloadFor, shareUrl } from './session/share'
import { applyEntries, bandTop, topmostVisible } from './docs/spy'

/* A compact, pleasant loop for the hero: the first thing a visitor can play. */
/* The arp and the chords share one synth, so the four sustained chord voices
 * mask a single arp note easily. Measured: chords alone render at rms 0.127,
 * and the arp at its old 0.28 gain only reached 0.066, half the chords, which
 * is why it was inaudible. 0.7 puts it at about 1.3x, leading without
 * swamping them. */
const HERO_DEMO = `const keys = synth(({ note, gate, adsr, saw, svf }) =>
  svf(saw(note.freq).add(saw(note.freq.mul(1.006))), 2200, { res: 0.3 })
    .mul(adsr(gate, { a: 0.01, d: 0.4, s: 0.5, r: 0.5 })).mul(0.35))

p('chords', chord('<Cmaj7 Am7 Fmaj7 G>').sound('keys').dur(0.95))
p('arp', n('0 2 4 7 4 2').scale('c major').sound('keys').fast(2).gain(0.7))
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
  vizRenderer?.setPlaying(false)
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
  // the docs previews have no engine behind them, so `playing` and `cycle`
  // would sit at 0 forever and any arrangement-aware shader would look frozen
  renderer.setPlaying(true)
  renderer.setActive(true)
}

/** A playable code block: a full editor (syntax highlight + flash-on-play,
 *  editable), a ▶/⏹ toggle, and an "open in editor" link that tracks edits. */
/** The language the reader has asked every snippet to be shown in, or null for
 *  "as authored". Same storage shape as the reference toggle. */
const DOC_LANG_KEY = 'rondocode-doc-lang'
function docLang(): 'rondocode' | 'rondo' | null {
  const q = new URLSearchParams(location.search).get('lang')
  if (q === 'rondo' || q === 'rondocode') return q
  const v = localStorage.getItem(DOC_LANG_KEY)
  return v === 'rondo' || v === 'rondocode' ? v : null
}

/** A snippet in the language the reader picked.
 *
 *  GENERATED, not a second copy. Every docs program round-trips (#210-#212
 *  closed the last gaps), so the other language is derived from the one
 *  authored source and the two cannot drift. If a conversion ever does fail it
 *  falls back to the original rather than showing a `js{ }` blob, so a future
 *  gap degrades to "this one stayed in its own language". */
function inLang(src: string, lang: 'rondo' | undefined): { text: string; lang?: 'rondo' } {
  const want = docLang()
  try {
    if (want === 'rondo' && lang !== 'rondo') {
      const d = decompileRondo(src)
      if (!d.includes('js{') && !/^js$/m.test(d)) return { text: d, lang: 'rondo' }
    } else if (want === 'rondocode' && lang === 'rondo') {
      const c = compileRondo(src)
      if (c.ok) return { text: c.code }
    }
  } catch { /* fall through to as-authored */ }
  return lang === 'rondo' ? { text: src, lang } : { text: src }
}

async function codeBlock(captionIn: string, srcIn: string, langIn?: 'rondo'): Promise<HTMLElement> {
  const conv = inLang(srcIn, langIn)
  const src = conv.text
  const lang = conv.lang
  const caption = captionIn
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
  /** the same without code bodies: what the section is ABOUT, for ranking */ prose: string
  /** the section's first code block, for the nav "open in editor" deep link */ firstCode?: string
  /** and the language it is written in — a rondo snippet must not open as JS */ firstLang?: 'rondo'
}

async function renderSection(s: Section): Promise<RenderedSection> {
  const sec = el('section', 'doc-section')
  sec.id = s.id
  sec.append(el('h2', undefined, s.title))
  const parts: string[] = [s.title]
  /* PROSE, kept apart from the code. A section is about what it SAYS; the
   * examples are illustration. Ranking on the combined text put "Patterns &
   * mini-notation" first for `gate` (every example calls `adsr(gate, …)`) and
   * "Singing" first for `reverb mix` (its post chain contains both words). */
  const prose: string[] = [s.title]
  let firstCode: string | undefined
  let firstLang: 'rondo' | undefined
  for (const b of s.blocks) {
    sec.append(await renderBlock(b))
    // blockText knows every kind, so a table/list/note stays findable by search
    parts.push(blockText(b))
    prose.push(blockProse(b))
    if (b.kind === 'code' && firstCode === undefined) {
      firstCode = b.text
      firstLang = b.lang
    }
  }
  return {
    el: sec,
    text: parts.join(' ').toLowerCase(),
    prose: prose.join(' ').toLowerCase(),
    firstCode,
    firstLang,
  }
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
/** The reference, in BOTH languages.
 *
 *  rondo is not a subset of the JavaScript API with different punctuation: a
 *  synth builtin is spelled `svf cutoff res:…` there and `svf(inp, cutoff,
 *  opts?)` here, and a reference that only showed one was accurate about
 *  JavaScript and about nothing a rondo user can type. That is the same
 *  complaint that produced rondoHover and then the in-editor panel.
 *
 *  It reuses referenceGroups(), the one the `?` panel uses, rather than
 *  growing a second grouping — the two would disagree about what a group
 *  contains the first time either changed.
 *
 *  The choice rides in the URL (`?lang=rondo`) so a link lands on the language
 *  it was written for, and is remembered so a rondo user is not re-toggling on
 *  every visit. */
function renderReference(): { section: HTMLElement; filter: (q: string) => number } {
  const wrap = el('section', 'doc-ref')
  wrap.id = 'reference'
  wrap.append(el('h2', undefined, 'Reference'))
  const p = el('p')
  p.textContent = 'Every function and symbol in the language.'
  wrap.append(p)

  const LANG_KEY = 'rondocode-ref-lang'
  const fromUrl = new URLSearchParams(location.search).get('lang')
  let lang: EditorLang =
    fromUrl === 'rondo' || fromUrl === 'rondocode'
      ? fromUrl
      : localStorage.getItem(LANG_KEY) === 'rondo'
        ? 'rondo'
        : 'rondocode'

  const pick = el('div', 'ref-langs')
  pick.setAttribute('role', 'tablist')
  pick.setAttribute('aria-label', 'reference language')
  const buttons: { lang: EditorLang; btn: HTMLButtonElement }[] = []
  let lastQuery = ''
  const list = el('div')

  const draw = (query = ''): number => {
    lastQuery = query
    list.replaceChildren()
    let count = 0
    for (const grp of filterGroups(referenceGroups(lang, OPTIONS, DSL_DOCS), query)) {
      list.append(el('h3', 'ref-group', grp.title))
      for (const e of grp.entries) {
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

  const sync = (): void => {
    for (const b of buttons) {
      const on = b.lang === lang
      b.btn.classList.toggle('on', on)
      b.btn.setAttribute('aria-selected', String(on))
    }
  }
  for (const [value, label] of [['rondocode', 'JavaScript'], ['rondo', 'rondo']] as const) {
    const btn = el('button', 'ref-lang', label) as HTMLButtonElement
    btn.type = 'button'
    btn.setAttribute('role', 'tab')
    btn.addEventListener('click', () => {
      if (lang === value) return
      lang = value
      try { localStorage.setItem(LANG_KEY, value) } catch { /* private mode */ }
      const url = new URL(location.href)
      url.searchParams.set('lang', value)
      history.replaceState(null, '', url)
      sync()
      draw(lastQuery)
    })
    buttons.push({ lang: value, btn })
    pick.append(btn)
  }
  sync()
  wrap.append(pick, list)
  draw()
  return { section: wrap, filter: draw }
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

  // WHICH ROUTE. One bundle serves all four; the path picks the view, so only
  // this route's editors are ever mounted (the whole point of the split).
  const view = viewForPath(location.pathname)
  const route = routeFor(view)
  label.textContent = route.label
  // Tabs. A horizontally scrolling strip rather than a wrapping row, so on a
  // phone they stay one line and stay reachable with a thumb.
  const tabs = el('nav', 'doc-tabs')
  tabs.setAttribute('aria-label', 'documentation sections')
  for (const r of ROUTES) {
    const a = el('a', 'doc-tab', r.label) as HTMLAnchorElement
    a.href = r.path
    if (r.view === view) {
      a.classList.add('on')
      a.setAttribute('aria-current', 'page')
    }
    tabs.append(a)
  }
  // LANGUAGE. Every snippet is generated from one source, so this shows the
  // same docs in whichever language you write in. A reload rather than a live
  // re-mount: each block is a CodeMirror instance, and rebuilding them all in
  // place would be a lot of machinery for a control you touch once.
  const langPick = el('div', 'doc-langpick')
  langPick.setAttribute('role', 'group')
  langPick.setAttribute('aria-label', 'snippet language')
  const wantLang = docLang()
  for (const [value, text] of [['rondocode', 'JS'], ['rondo', 'rondo']] as const) {
    const b = el('button', 'doc-langbtn', text) as HTMLButtonElement
    b.type = 'button'
    if (wantLang === value) b.classList.add('on')
    b.setAttribute('aria-pressed', String(wantLang === value))
    b.title = wantLang === value ? 'showing every snippet in this language (tap to go back to as-written)' : `show every snippet in ${text}`
    b.addEventListener('click', () => {
      const next = wantLang === value ? null : value
      try {
        if (next === null) localStorage.removeItem(DOC_LANG_KEY)
        else localStorage.setItem(DOC_LANG_KEY, next)
      } catch { /* private mode */ }
      const url = new URL(location.href)
      if (next === null) url.searchParams.delete('lang')
      else url.searchParams.set('lang', next)
      location.href = url.toString()
    })
    langPick.append(b)
  }
  // The bar does NOT scroll; the tabs inside it do. Putting the language
  // buttons in the scroller pushed them off-screen in portrait, where four
  // tabs already fill the width: you had to scroll the strip to find a control
  // that should never move.
  const tabbar = el('div', 'doc-tabbar')
  tabbar.append(tabs, langPick)
  document.body.append(tabbar)
  // MEASURE, do not assume. The header has no fixed height: it wraps
  // differently at small widths and with a larger system font, so a hard-coded
  // offset would either overlap the tabs or leave a gap on exactly the devices
  // hardest to check. The nav sits below both.
  // set once the nav exists; the spy band is derived from these offsets
  let reobserve: (() => void) | undefined
  const syncStickyOffsets = (): void => {
    const r = document.documentElement.style
    r.setProperty('--doc-top-h', `${Math.round(top.getBoundingClientRect().height)}px`)
    r.setProperty('--doc-tabs-h', `${Math.round(tabbar.getBoundingClientRect().height)}px`)
    // these ARE the scroll offset, so the spy band has to follow them
    reobserve?.()
  }
  syncStickyOffsets()
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(syncStickyOffsets)
    ro.observe(top)
    ro.observe(tabbar)
  }
  window.addEventListener('orientationchange', syncStickyOffsets)

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
  if (view === 'guide') {
    hero.append(el('h1', undefined, HERO.title))
    hero.append(el('p', 'tagline', HERO.tagline))
    hero.append(el('p', 'blurb', HERO.blurb))
  } else {
    // the landing pitch belongs on the landing route; the others say what
    // they are and get out of the way
    hero.classList.add('compact')
    hero.append(el('h1', undefined, route.label))
    hero.append(el('p', 'blurb', route.blurb))
  }
  const search = el('input', 'doc-search') as HTMLInputElement
  search.type = 'search'
  search.placeholder = 'search the docs…'
  search.setAttribute('aria-label', 'search the docs')
  hero.append(search)
  main.append(hero)

  // hero mini-demo: a compact, playable tune right at the top
  const demo = await codeBlock('a tiny loop, press play', HERO_DEMO)
  demo.classList.add('doc-hero-demo')
  if (view === 'guide') main.append(demo)
  else demo.style.display = 'none' // built but unused: keeps applySearch simple

  // nav + guide sections (capture text for search + first code for a deep link)
  const navLinks: { id: string; a: HTMLAnchorElement }[] = []
  const guide: { id: string; title: string; text: string; prose: string; el: HTMLElement; row: HTMLElement }[] = []
  /* A CLICK HAS TO WIN OVER THE SPY FOR A MOMENT.
   *
   * The reported bug — click a cookbook recipe, the link above it lights up —
   * is not the spy misreading the page. Measured over CDP, a jump to
   * `recipe-one-knob` came to rest about 220px SHORT, with the previous
   * section genuinely filling the band: the code blocks below are rendered
   * asynchronously, so the document grows while the smooth scroll is
   * travelling and the position the browser committed to is stale by the time
   * it arrives. The spy was reporting that honestly. The scroll was wrong.
   *
   * So: light the clicked link immediately, hold it while things settle, and
   * re-aim once layout has stopped moving. The hold is released as soon as the
   * reader scrolls for themselves, because from then on the spy is right. */
  let lockedId: string | undefined
  const setActive = (id: string): void => {
    for (const l of navLinks) l.a.classList.toggle('on', l.id === id)
  }
  const release = (): void => {
    lockedId = undefined
  }
  for (const evName of ['wheel', 'touchmove', 'keydown']) {
    window.addEventListener(evName, release, { passive: true })
  }
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
    a.addEventListener('click', () => {
      lockedId = id
      setActive(id)
      /* Re-aim REPEATEDLY, not once: the document keeps growing for a while
       * (measured, a single correction at 450ms still landed ~116px short, and
       * the previous section still reached into the band). Each pass snaps
       * with `auto` rather than fighting the smooth scroll in flight, and the
       * hold is released only after the last one. */
      for (const at of [450, 900, 1400]) {
        window.setTimeout(() => {
          if (lockedId !== id) return // the reader took over; leave them alone
          document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'auto' })
        }, at)
      }
      window.setTimeout(() => {
        if (lockedId === id) release()
      }, 1600)
    })
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
  for (const s of sectionsFor(view)) {
    if (s.group !== lastGroup) {
      startGroup(s.group)
      lastGroup = s.group
    }
    const r = await renderSection(s)
    main.append(r.el)
    const row = addNav(s.id, s.title, r.firstCode, r.firstLang)
    guide.push({ id: s.id, title: s.title, text: r.text, prose: r.prose, el: r.el, row })
  }

  // reference + shortcuts live on their own route now: they are looked up,
  // not read, and together they were most of the page's weight
  const onRef = view === 'reference'
  const ref = renderReference()
  let refRow: HTMLElement | undefined
  const shortcuts = renderShortcuts()
  let shortcutsRow: HTMLElement | undefined
  if (onRef) {
    startGroup('reference')
    main.append(ref.section)
    refRow = addNav('reference', 'Reference')
    main.append(shortcuts)
    shortcutsRow = addNav('shortcuts', 'Shortcuts')
  }
  main.append(renderFooter())

  // one search over guide + reference: hide non-matching sections/nav rows
  const noHits = el('p', 'doc-nohits', 'no matches on this page')
  noHits.style.display = 'none'
  main.append(noHits)
  // Hits on the OTHER routes. Splitting the page must not shrink the search:
  // the index is plain strings for every route, so this costs no editors.
  const elsewhere = el('div', 'doc-elsewhere')
  elsewhere.style.display = 'none'
  main.append(elsewhere)

  /* THE RESULT LIST. Filtering the page in place answers "which sections
   * mention this" — with `gate` that was 32 of 44, in document order, with
   * nothing to say where in each the word appeared. The question is always
   * "which one is ABOUT it", so: ranked hits, each with a line of context and
   * the terms marked, above the filtered page rather than instead of it. */
  const results = el('div', 'doc-results')
  results.style.display = 'none'
  hero.append(results)
  let hits: { id: string; title: string; text: string }[] = []
  let cursor = -1

  const marked = (text: string, ts: readonly string[], cls: string): HTMLElement => {
    const wrap = el('span', cls)
    for (const part of highlight(text, ts)) {
      if (part.hit) wrap.append(el('mark', undefined, part.text))
      else wrap.append(document.createTextNode(part.text))
    }
    return wrap
  }

  const paintCursor = (): void => {
    const rows = Array.from(results.querySelectorAll('.doc-result'))
    rows.forEach((r, i) => r.classList.toggle('on', i === cursor))
    if (cursor >= 0) rows[cursor]?.scrollIntoView({ block: 'nearest' })
  }

  const goTo = (id: string): void => {
    search.value = ''
    applySearch()
    const target = document.getElementById(id)
    lockedId = id
    setActive(id)
    target?.scrollIntoView({ block: 'start', behavior: 'auto' })
    for (const at of [450, 900]) {
      window.setTimeout(() => {
        if (lockedId !== id) return
        document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'auto' })
      }, at)
    }
    window.setTimeout(() => { if (lockedId === id) release() }, 1100)
  }

  const renderResults = (ts: readonly string[]): void => {
    results.replaceChildren()
    cursor = -1
    if (hits.length === 0) {
      results.style.display = 'none'
      return
    }
    const head = el('div', 'doc-results-head')
    head.textContent = `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} on this page`
    results.append(head)
    for (const h of hits) {
      const row = el('button', 'doc-result') as HTMLButtonElement
      row.type = 'button'
      row.append(marked(h.title, ts, 'doc-result-title'))
      row.append(marked(snippet(h.text, ts), ts, 'doc-result-snip'))
      row.addEventListener('click', () => goTo(h.id))
      results.append(row)
    }
    results.style.display = ''
  }
  const applySearch = (): void => {
    const q = search.value.trim().toLowerCase()
    const ts = terms(q)
    const searching = ts.length > 0
    let shown = 0
    /* EVERY TERM, not the query as one substring. `wavetable warp` reported
     * "no matches on this page" with both words on it, and so did every other
     * two-word query — the shape a reader reaches for first. */
    const ranked = searching
      ? rank(guide, ts, (g) => ({
          /* The section ID counts as a title. It is an authored slug for the
           * topic, and the titles here are editorial: the section about
           * sidechain is called "The pump", so on titles alone every match
           * tied and fell back to document order. */
          title: `${g.title} ${g.id}`.toLowerCase(),
          body: g.prose,
          weak: g.text,
        }))
      : []
    const matched = new Set(ranked.map((r) => r.item.id))
    for (const g of guide) {
      const match = !searching || matched.has(g.id)
      g.el.style.display = match ? '' : 'none'
      g.row.style.display = match ? '' : 'none'
      if (match) shown++
    }
    hits = ranked.map((r) => ({ id: r.item.id, title: r.item.title, text: r.item.text }))
    renderResults(ts)
    if (onRef) {
      const refCount = ref.filter(q)
      const refShow = !searching || refCount > 0
      ref.section.style.display = refShow ? '' : 'none'
      if (refRow) refRow.style.display = refShow ? '' : 'none'
      if (refShow) shown += refCount
      shortcuts.style.display = searching ? 'none' : ''
      if (shortcutsRow) shortcutsRow.style.display = searching ? 'none' : ''
    }
    // the demo is noise while searching
    if (view === 'guide') demo.style.display = searching ? 'none' : ''

    const others = searching ? crossRouteHits(q, view) : []
    // the demo and the result list are both noise when nothing is typed
    elsewhere.replaceChildren()
    if (others.length > 0) {
      elsewhere.append(el('div', 'doc-elsewhere-head', 'elsewhere in the docs'))
      for (const h of others) {
        const a = el('a', 'doc-elsewhere-hit') as HTMLAnchorElement
        a.href = h.href
        a.append(el('span', 'doc-elsewhere-where', routeFor(h.view).label), document.createTextNode(h.title))
        elsewhere.append(a)
      }
    }
    elsewhere.style.display = others.length > 0 ? '' : 'none'
    noHits.style.display = shown === 0 && others.length === 0 ? '' : 'none'
  }
  search.addEventListener('input', applySearch)

  /* KEYBOARD. The box was a filter you could only reach with the mouse: nothing
   * focused it, arrows did nothing, Enter did nothing, and Escape did not even
   * clear it. A finder has to be usable without leaving the keys. */
  search.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent
    if (ev.key === 'Escape') {
      // first Escape clears; a second one hands the page back
      if (search.value !== '') {
        search.value = ''
        applySearch()
      } else search.blur()
      ev.preventDefault()
      return
    }
    if (hits.length === 0) return
    if (ev.key === 'ArrowDown') {
      cursor = Math.min(cursor + 1, hits.length - 1)
      paintCursor()
      ev.preventDefault()
    } else if (ev.key === 'ArrowUp') {
      cursor = Math.max(cursor - 1, -1)
      paintCursor()
      ev.preventDefault()
    } else if (ev.key === 'Enter') {
      // Enter with nothing selected takes the top hit, which is the whole
      // point of ranking it
      const pick = hits[cursor === -1 ? 0 : cursor]
      if (pick !== undefined) goTo(pick.id)
      ev.preventDefault()
    }
  })

  /* `/` is the convention every docs site shares, and cmd/ctrl-K is the one
   * every app does. Both, because a reader arrives with one of them already in
   * their fingers. Ignored while typing somewhere else, so `/` stays a
   * character in a code block. */
  window.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent
    const inField = ev.target instanceof HTMLElement
      && (ev.target.isContentEditable || /^(input|textarea)$/i.test(ev.target.tagName))
    const slash = ev.key === '/' && !inField
    const cmdK = ev.key.toLowerCase() === 'k' && (ev.metaKey || ev.ctrlKey)
    if (!slash && !cmdK) return
    ev.preventDefault()
    search.focus()
    search.select()
  })

  // scroll-spy: highlight the nav link for the section in view. See spy.ts —
  // the band must start where a CLICK lands, and the topmost section in it
  // wins, or the link above the one you clicked lights up instead.
  const order = navLinks.map((l) => l.id)
  const visible = new Set<string>()
  let spy: IntersectionObserver | undefined
  const paint = (): void => {
    if (lockedId !== undefined) return // a click owns the highlight until it settles
    const active = topmostVisible(order, visible)
    if (active === undefined) return // band empty: keep what is lit
    for (const l of navLinks) l.a.classList.toggle('on', l.id === active)
  }
  const observe = (): void => {
    spy?.disconnect()
    visible.clear()
    const nodes = order.map((id) => document.getElementById(id))
    spy = new IntersectionObserver(
      (entries) => {
        applyEntries(visible, entries)
        paint()
      },
      { rootMargin: `-${bandTop(document.documentElement)}px 0px -70% 0px` },
    )
    for (const node of nodes) if (node) spy.observe(node)
  }
  observe()
  // the sticky bars decide where a click lands, so the band moves with them
  reobserve = observe
}

void build()
