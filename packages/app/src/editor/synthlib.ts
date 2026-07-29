import type { EditorHandle } from './editor'
import { PreviewPlayer } from '../docs/player'
import { highlightDsl } from '../docs/highlight'
import { icon, iconEl } from '../ui/icons'
import { overlayClosed, overlayOpened } from '../ui/overlays'
import { tooltip } from '../ui/tooltip'

/* ------------------------------------------------------------------------- *
 * Synth library: a shelf of ready-made instruments. Each entry auditions a
 * short phrase (through its OWN preview engine, so it never disturbs the live
 * track) and inserts just the `const name = synth(...)` definition into the
 * editor at the cursor. `demo` is a complete program (the def + a phrase) used
 * only for the preview; `code` is what gets inserted.
 * ------------------------------------------------------------------------- */

interface LibrarySynth {
  name: string
  title: string
  tags: string
  code: string
  demoTail: string // appended to code to make an audible program for preview
}

const SYNTHS: LibrarySynth[] = [
  {
    name: 'acid',
    title: 'Acid bass',
    tags: 'bass · 303',
    code: `const acid = synth(({ note, gate, param, adsr, saw, square, ladder }) => {
  const cutoff = param('cutoff', 800, { min: 80, max: 8000, curve: 'log' })
  const env = adsr(gate, { a: 0.003, d: 0.2, s: 0.3, r: 0.1 })
  const osc = saw(note.freq).mix(square(note.freq.mul(0.5)), 0.3)
  return ladder(osc, cutoff.mul(env.pow(2)), { res: 0.85 }).mul(env)
})`,
    demoTail: `p('demo', note('c2 c2 g2 c2 eb2 c2 g1 c2').sound('acid'))`,
  },
  {
    name: 'sub',
    title: 'Sub bass',
    tags: 'bass · sine',
    code: `const sub = synth(({ note, gate, adsr, sine }) =>
  sine(note.freq).mul(adsr(gate, { a: 0.01, d: 0.1, s: 0.9, r: 0.1 })))`,
    demoTail: `p('demo', note('c1 c1 g1 c1').sound('sub'))`,
  },
  {
    name: 'wobble',
    title: 'Wobble bass',
    tags: 'bass · lfo',
    code: `const wobble = synth(({ note, gate, adsr, saw, ladder, lfo }) => {
  const env = adsr(gate, { a: 0.01, d: 0.2, s: 0.8, r: 0.2 })
  return ladder(saw(note.freq), lfo(2).range(200, 3000), { res: 0.7 }).mul(env)
})`,
    demoTail: `setCps(0.5)\np('demo', note('c2 c2 c2 c2').sound('wobble'))`,
  },
  {
    name: 'lead',
    title: 'Supersaw lead',
    tags: 'lead · unison',
    code: `const lead = synth(
  ({ note, gate, adsr, saw }) =>
    saw(note.freq).mul(adsr(gate, { a: 0.02, d: 0.2, s: 0.6, r: 0.2 })),
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.7 }), 0.25),
  { unison: 7, detune: 18, spread: 0.8 },
)`,
    demoTail: `p('demo', n('0 2 4 7 4 2').scale('a minor').sound('lead'))`,
  },
  {
    name: 'sync',
    title: 'Hard-sync lead',
    tags: 'lead · aggressive',
    code: `const sync = synth(({ note, gate, adsr, syncsaw, lfo }) =>
  syncsaw(note.freq, lfo(0.25).range(1, 5))
    .mul(adsr(gate, { a: 0.01, d: 0.3, s: 0.5, r: 0.2 })))`,
    demoTail: `p('demo', note('c3 c3 g3 c3').sound('sync'))`,
  },
  {
    name: 'pad',
    title: 'Warm pad',
    tags: 'pad · chorus',
    code: `const pad = synth(
  ({ note, gate, adsr, saw }) =>
    saw(note.freq).mul(adsr(gate, { a: 0.4, d: 0.3, s: 0.7, r: 0.8 })),
  ({ input, chorus, reverb }) => {
    const wide = chorus(input, { rate: 0.5, depth: 0.004 })
    return wide.mix(reverb(wide, { roomSize: 0.9, damp: 0.5 }), 0.4)
  },
)`,
    demoTail: `setCps(0.4)\np('demo', chord('<Cmaj7 Fmaj7>').sound('pad'))`,
  },
  {
    name: 'keys',
    title: 'Electric keys',
    tags: 'keys · fm',
    code: `const keys = synth(({ note, gate, adsr, sine }) => {
  const env = adsr(gate, { a: 0.002, d: 0.5, s: 0.3, r: 0.4 })
  const mod = sine(note.freq.mul(2)).mul(env.pow(3)).mul(note.freq.mul(1.4))
  return sine(note.freq.add(mod)).mul(env)
})`,
    demoTail: `p('demo', chord('<Am7 Dm7>').sound('keys'))`,
  },
  {
    name: 'pluck',
    title: 'Pluck',
    tags: 'melodic · short',
    code: `const pluck = synth(({ note, gate, adsr, tri }) =>
  tri(note.freq).mul(adsr(gate, { a: 0.005, d: 0.15, s: 0, r: 0.1 })))`,
    demoTail: `p('demo', note('c4 e4 g4 e4').sound('pluck'))`,
  },
  {
    name: 'string',
    title: 'Plucked string',
    tags: 'melodic · karplus',
    code: `const string = synth(({ note, gate, adsr, noise, comb }) => {
  const strike = noise().mul(adsr(gate, { a: 0.001, d: 0.02, s: 0, r: 0.02 }))
  return comb(strike, note.freq, 0.96).mul(adsr(gate, { a: 0.001, d: 1.2, s: 0, r: 0.4 }))
})`,
    demoTail: `p('demo', note('c4 e4 g4 c5').sound('string'))`,
  },
  {
    name: 'kick',
    title: 'Kick',
    tags: 'drum · 909',
    code: `const kick = synth(({ gate, adsr, sine }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.09, s: 0, r: 0.05 })
  const amp = adsr(gate, { a: 0.001, d: 0.22, s: 0, r: 0.08 })
  return sine(pitch.pow(2).range(45, 160)).mul(amp).tanh()
})`,
    demoTail: `setCps(0.5)\np('demo', note('c1*4').sound('kick'))`,
  },
  {
    name: 'snare',
    title: 'Snare',
    tags: 'drum · noise',
    code: `const snare = synth(({ gate, adsr, noise, sine, svf }) => {
  const body = sine(190).mul(adsr(gate, { a: 0.001, d: 0.12, s: 0, r: 0.05 }))
  const rattle = svf(noise(), 3000, { mode: 'hp' }).mul(adsr(gate, { a: 0.001, d: 0.18, s: 0, r: 0.08 }))
  return body.add(rattle).mul(0.7).tanh()
})`,
    demoTail: `setCps(0.5)\np('demo', note('~ c3 ~ c3').sound('snare'))`,
  },
  {
    name: 'hat',
    title: 'Hi-hat',
    tags: 'drum · noise',
    code: `const hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 8000, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.04, s: 0, r: 0.03 }))
    .mul(0.5))`,
    demoTail: `setCps(0.5)\np('demo', note('c5*8').sound('hat'))`,
  },

  /* ---- the newer engine, which the library had nothing for ------------- *
   * Wavetables, unison supersaws, formant and physical modelling all shipped
   * without a preset to start from, so the only way to find them was reading
   * the reference. These are the shapes the hand-tuned examples converged on. */

  {
    name: 'stab',
    title: 'Supersaw stab',
    tags: 'lead · unison · edm',
    code: `// the EDM chord stab: unison detune for width, the envelope opening
// the ladder so each hit blooms, squared for a snappier curve.
const stab = synth(({ note, gate, param, adsr, supersaw, ladder }) => {
  const env = adsr(gate, { a: 0.003, d: 0.16, s: 0.28, r: 0.12 })
  const cut = param('cut', 2600, { min: 300, max: 9000, curve: 'log' })
  return ladder(supersaw(note.freq, { detune: 0.18, mix: 0.75 }), cut.mul(env.pow(1.6)), { res: 0.3 })
    .mul(env)
    .mul(0.5)
}, { unison: 5, detune: 16, spread: 0.85 })`,
    demoTail: `setCps(0.45)\np('demo', chord('<Am7 Fmaj7 Cmaj7 G>').sound('stab').dur(0.5))`,
  },
  {
    name: 'wtlead',
    title: 'Wavetable lead',
    tags: 'lead · wavetable · warp',
    code: `// wavetable + WARP: the envelope scans the table while 'sync' re-runs each
// cycle early and wraps, which is the hard-sync tear. Two detuned layers.
const wtlead = synth(({ note, gate, param, adsr, wavetable, svf, shape }) => {
  const env = adsr(gate, { a: 0.004, d: 0.3, s: 0.4, r: 0.2 })
  const scan = env.range(0.1, 0.85)
  const amt = param('warp', 0.35, { min: 0, max: 1 })
  const a = wavetable(note.freq, scan, { table: 'harmonic', warp: 'sync', warpAmt: amt })
  const b = wavetable(note.freq.mul(1.004), scan, { table: 'basic' })
  return shape(svf(a.mix(b, 0.35), 4200, { res: 0.22 }).mul(env), 1.3, { type: 'sine' }).mul(0.45)
})`,
    demoTail: `setCps(0.5)\np('demo', n('0 3 5 7 5 3').scale('a minor').sound('wtlead').dur(0.5))`,
  },
  {
    name: 'wtpad',
    title: 'Wavetable pad',
    tags: 'pad · wavetable · wide',
    code: `// a slow LFO walks the table instead of an envelope, so the timbre keeps
// moving under a held chord. width() spreads it without detuning.
const wtpad = synth(({ note, gate, adsr, lfo, wavetable, svf }) => {
  const env = adsr(gate, { a: 0.6, d: 1.2, s: 0.8, r: 1.4 })
  const scan = lfo(0.08).range(0.05, 0.7)
  const osc = wavetable(note.freq, scan, { table: 'basic' })
    .mix(wavetable(note.freq.mul(0.5), scan, { table: 'harmonic' }), 0.3)
  return svf(osc, 2100, { res: 0.12 }).mul(env).mul(0.22)
}, ({ input, width, reverb }) => width(input, 0.7).mix(reverb(input, { roomSize: 0.8 }), 0.3),
   { unison: 3, detune: 8, spread: 0.9 })`,
    demoTail: `setCps(0.25)\np('demo', chord('<Fmaj9 Cmaj9>').sound('wtpad').dur(0.95))`,
  },
  {
    name: 'vox',
    title: 'Formant vox',
    tags: 'lead · formant · vowel',
    code: `// formant() imposes vowel resonances on any source: morph sweeps between
// them, so a held note talks. Saw in, because it has harmonics to filter.
const vox = synth(({ note, gate, adsr, lfo, saw, formant }) => {
  const env = adsr(gate, { a: 0.05, d: 0.3, s: 0.7, r: 0.3 })
  const morph = lfo(0.25).range(0, 1)
  return formant(saw(note.freq), morph).mul(env).mul(0.5)
})`,
    demoTail: `setCps(0.35)\np('demo', note('a3 c4 e4 c4').sound('vox').dur(0.9))`,
  },
  {
    name: 'bell',
    title: 'Modal bell',
    tags: 'perc · physical',
    code: `// modal() is a physical model: struck resonators rather than an oscillator
// through an envelope. 'glass' is bright and long, 'bar' is woodier.
const bell = synth(({ note, gate, modal, reverb }) => {
  const hit = modal(gate, note.freq, { model: 'glass', decay: 0.85, damp: 0.25 })
  return hit.mix(reverb(hit, { roomSize: 0.7, damp: 0.4 }), 0.3).mul(0.6)
})`,
    demoTail: `setCps(0.35)\np('demo', n('0 4 7 11').scale('c major').sound('bell').dur(0.9))`,
  },
  {
    name: 'cloud',
    title: 'Granular cloud',
    tags: 'texture · granular',
    code: `// granular() sprays grains from a loaded sample: 'pos' scans the buffer and
// 'rate' is the pitch, so a slow pos with a fixed rate is a frozen texture.
const cloud = synth(({ note, gate, adsr, lfo, granular, svf }) => {
  const env = adsr(gate, { a: 0.4, d: 0.6, s: 0.85, r: 0.9 })
  const pos = lfo(0.05).range(0.05, 0.9)
  const g = granular(gate, 'pad', { pos, rate: note.freq.div(220), size: 0.12, spray: 0.4 })
  return svf(g, 3200, { res: 0.1 }).mul(env).mul(0.5)
})`,
    demoTail: `setCps(0.2)\np('demo', note('a3 c4').sound('cloud').dur(0.95))`,
  },
]

export interface SynthLibHandle {
  dispose(): void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (cls !== undefined) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** Insert a synth definition into the editor at the cursor, landing it on its
 *  own line(s), then move the cursor past it and refocus the editor. */
function insertSynth(editor: EditorHandle, code: string): void {
  const view = editor.view
  const { from } = view.state.selection.main
  const line = view.state.doc.lineAt(from)
  const prefix = from === line.from ? '' : '\n'
  const text = `${prefix}${code}\n`
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  })
  view.focus()
}

export function mountSynthLib(editor: EditorHandle): SynthLibHandle {
  const player = new PreviewPlayer()
  let current: { btn: HTMLButtonElement; reset: () => void } | null = null
  player.onStop = () => {
    current?.reset()
    current = null
  }

  const btn = el('button', 'btn synthlib-btn')
  btn.type = 'button'
  tooltip(btn, 'synth library')
  btn.setAttribute('aria-expanded', 'false')
  btn.innerHTML = `${icon('waveform')}<span class="btn-label">synths</span>`
  const controls = editor.topbar.querySelector('.hdr-controls') ?? editor.topbar
  controls.insertBefore(btn, controls.firstChild)

  const backdrop = el('div', 'sheet-backdrop hidden')
  const sheet = el('aside', 'sheet')
  sheet.setAttribute('role', 'dialog')
  sheet.setAttribute('aria-modal', 'true')
  sheet.setAttribute('aria-label', 'synth library')
  backdrop.append(sheet)
  document.body.append(backdrop)

  const close = (): void => {
    backdrop.classList.add('hidden')
    player.stop()
    btn.setAttribute('aria-expanded', 'false')
    overlayClosed(close)
    btn.focus() // restore focus to the trigger
  }
  const open = (): void => {
    overlayOpened(close) // close any other open sheet
    backdrop.classList.remove('hidden')
    btn.setAttribute('aria-expanded', 'true')
    search.focus()
  }

  const head = el('div', 'sheet-head')
  head.append(el('h2', 'sheet-title', 'synths'))
  const closeBtn = el('button', 'sheet-close')
  closeBtn.type = 'button'
  closeBtn.innerHTML = icon('x')
  closeBtn.setAttribute('aria-label', 'close')
  closeBtn.addEventListener('click', close)
  head.append(closeBtn)

  const search = el('input', 'lib-snap-name docs-search') as HTMLInputElement
  search.placeholder = 'search synths…'
  search.setAttribute('aria-label', 'search synths')

  const list = el('div', 'synthlib-list')
  sheet.append(head, el('p', 'sheet-hint', 'audition a synth, then insert its code at your cursor'), search, list)

  const render = (query = ''): void => {
    list.replaceChildren()
    const q = query.trim().toLowerCase()
    const matches = SYNTHS.filter(
      (sy) => q === '' || `${sy.name} ${sy.title} ${sy.tags}`.toLowerCase().includes(q),
    )
    if (matches.length === 0) {
      list.append(el('div', 'lib-empty', 'no matches'))
      return
    }
    for (const sy of matches) {
      const row = el('div', 'synthlib-row')

      const top = el('div', 'synthlib-top')
      const meta = el('div', 'synthlib-meta')
      meta.append(el('span', 'synthlib-name', sy.title))
      meta.append(el('span', 'synthlib-tags', sy.tags))
      top.append(meta)

      const play = el('button', 'play-btn')
      play.type = 'button'
      const setIdle = (): void => {
        play.classList.remove('playing')
        play.replaceChildren(iconEl('play'))
        tooltip(play, 'audition')
      }
      setIdle()
      play.addEventListener('click', () => {
        void (async () => {
          if (current?.btn === play) {
            player.stop()
            return
          }
          current?.reset()
          current = null
          tooltip(play, 'loading…')
          const res = await player.play(`${sy.code}\n\n${sy.demoTail}`)
          if (res.ok) {
            play.classList.add('playing')
            play.replaceChildren(iconEl('stop'))
            tooltip(play, 'stop')
            current = { btn: play, reset: setIdle }
          } else {
            setIdle()
          }
        })()
      })

      const insert = el('button', 'btn synthlib-insert', 'insert')
      insert.type = 'button'
      insert.addEventListener('click', () => {
        insertSynth(editor, sy.code)
        close()
      })

      const actions = el('div', 'synthlib-actions')
      actions.append(play, insert)
      top.append(actions)
      row.append(top)

      const pre = el('pre', 'synthlib-code')
      const codeEl = el('code')
      codeEl.innerHTML = highlightDsl(sy.code)
      pre.append(codeEl)
      row.append(pre)

      list.append(row)
    }
  }
  render()
  search.addEventListener('input', () => render(search.value))

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  btn.addEventListener('click', () => {
    if (backdrop.classList.contains('hidden')) open()
    else close()
  })
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !backdrop.classList.contains('hidden')) close()
  }
  document.addEventListener('keydown', onKey)

  return {
    dispose(): void {
      document.removeEventListener('keydown', onKey)
      player.dispose()
      backdrop.remove()
      btn.remove()
    },
  }
}
