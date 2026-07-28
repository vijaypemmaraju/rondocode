import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bpmToCps } from '@rondocode/pattern'
import { verifiedChanges } from '../src/editor/rondo/gesture'
import type { WriteHost } from '../src/editor/rondo/gesture'
import { MAX_BPM, MIN_BPM, docCps, findTempoSite, showBpm, tempoEdit, writeNum } from '../src/editor/tempo'

/* The header BPM field's pure half: locating the document's tempo line, and
 * turning a typed BPM into a verified rewrite of that one number. The DOM half
 * is thin wiring over these. */

/** A fake document the verified writer can edit for real (see gesture.test). */
function host(initial: string): WriteHost & { text: () => string } {
  let doc = initial
  return {
    state: {
      get doc() {
        return { sliceString: (a: number, b: number) => doc.slice(a, b) }
      },
    },
    dispatch: (spec) => {
      const list = Array.isArray(spec.changes) ? spec.changes : [spec.changes]
      for (const c of [...list].sort((x, y) => y.from - x.from)) {
        doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to)
      }
    },
    text: () => doc,
  }
}

describe('findTempoSite', () => {
  it('finds the JS tempo call and brackets the NUMBER, not the call', () => {
    const doc = "p('a', n('0'))\nsetCps(0.5333)\n"
    const site = findTempoSite(doc, 'rondocode')!
    expect(site).toMatchObject({ unit: 'cps', value: 0.5333, text: '0.5333' })
    expect(doc.slice(site.from, site.to)).toBe('0.5333')
  })

  it('finds setBpm, and a rondo `cps` / `bpm` line', () => {
    expect(findTempoSite('setBpm(128)\n', 'rondocode')).toMatchObject({ unit: 'bpm', value: 128 })
    const r = findTempoSite('play a\n  0 3\n\ncps .5333\n', 'rondo')!
    expect(r).toMatchObject({ unit: 'cps', value: 0.5333, text: '.5333' })
    expect(findTempoSite('bpm 128\n', 'rondo')).toMatchObject({ unit: 'bpm', value: 128, text: '128' })
  })

  it('takes the LAST tempo line, which is the one the program obeys', () => {
    expect(findTempoSite('setCps(0.4)\nsetBpm(174)\n', 'rondocode')).toMatchObject({ unit: 'bpm', value: 174 })
    expect(findTempoSite('cps .4\n\nbpm 174\n', 'rondo')).toMatchObject({ unit: 'bpm', value: 174 })
  })

  it('ignores commented-out tempo lines in both languages', () => {
    expect(findTempoSite('// setCps(0.9)\nsetCps(0.5)\n', 'rondocode')).toMatchObject({ value: 0.5 })
    expect(findTempoSite('cps .5\n# cps .9\n', 'rondo')).toMatchObject({ value: 0.5 })
    expect(findTempoSite('// setCps(0.9)\n', 'rondocode')).toBeNull()
  })

  it('is null when there is no tempo line, or the tempo is an expression', () => {
    expect(findTempoSite("p('a', n('0'))\n", 'rondocode')).toBeNull()
    expect(findTempoSite('setCps(slider(0.5, 0.2, 1))\n', 'rondocode')).toBeNull()
    // a rondo tempo line must be top-level: an indented one is not the program's
    expect(findTempoSite('play a\n  cps .5\n', 'rondo')).toBeNull()
  })
})

describe('docCps', () => {
  it('reads either unit back as cps, with one cycle = one 4/4 bar', () => {
    expect(docCps('setCps(0.5)\n', 'rondocode')).toBe(0.5)
    expect(docCps('setBpm(128)\n', 'rondocode')).toBeCloseTo(0.5333, 4)
    expect(docCps('bpm 120\n', 'rondo')).toBeCloseTo(0.5, 10)
    expect(docCps('const x = 1\n', 'rondocode')).toBeNull()
  })
})

describe('writeNum / showBpm', () => {
  it('shows one decimal only when it earns its place', () => {
    expect(showBpm(128)).toBe('128')
    expect(showBpm(127.992)).toBe('128') // the 0.5333 round trip reads back clean
    expect(showBpm(127.5)).toBe('127.5')
  })

  it('writes cps at the MIDI importer precision, and keeps the line style', () => {
    expect(writeNum(bpmToCps(128), 'cps', '0.5')).toBe('0.5333')
    expect(writeNum(bpmToCps(128), 'cps', '.5')).toBe('.5333') // leading-dot style survives
    expect(writeNum(bpmToCps(120), 'cps', '0.4')).toBe('0.5') // no trailing zeros
    expect(writeNum(128, 'bpm', '120')).toBe('128')
    expect(writeNum(127.5, 'bpm', '120')).toBe('127.5')
  })
})

describe('tempoEdit: typing a BPM rewrites the doc', () => {
  it('a cps line stays cps, converted; a bpm line stays bpm, verbatim', () => {
    const js = "p('a', n('0'))\nsetCps(0.5)\n"
    expect(tempoEdit(js, 'rondocode', 128)).toEqual({
      from: js.indexOf('0.5'), to: js.indexOf('0.5') + 3, expected: '0.5', insert: '0.5333',
    })
    expect(tempoEdit('setBpm(120)\n', 'rondocode', 174)).toMatchObject({ expected: '120', insert: '174' })
    expect(tempoEdit('cps .5\n', 'rondo', 128)).toMatchObject({ expected: '.5', insert: '.5333' })
    expect(tempoEdit('bpm 120\n', 'rondo', 128)).toMatchObject({ expected: '120', insert: '128' })
  })

  it('is null when the doc carries no tempo line (the caller applies it to the session)', () => {
    expect(tempoEdit("p('a', n('0'))\n", 'rondocode', 128)).toBeNull()
  })

  it('the write lands as an exact splice of that one number', () => {
    const doc = "setCps(0.5)\np('a', n('0'))\n"
    const h = host(doc)
    expect(verifiedChanges(h, [tempoEdit(doc, 'rondocode', 174)!])).toBe(true)
    expect(h.text()).toBe("setCps(0.725)\np('a', n('0'))\n")
  })

  it('a concurrent edit DROPS the write instead of splicing over it', () => {
    const doc = 'setCps(0.5)\n'
    const edit = tempoEdit(doc, 'rondocode', 174)!
    const h = host('setCps(0.9)\n') // the doc moved on since the field was read
    expect(verifiedChanges(h, [edit])).toBe(false)
    expect(h.text()).toBe('setCps(0.9)\n')
  })

  it('round-trips: writing a BPM and reading it back gives the same BPM', () => {
    for (const bpm of [90, 120, 128, 174]) {
      const doc = 'setCps(0.5)\n'
      const h = host(doc)
      verifiedChanges(h, [tempoEdit(doc, 'rondocode', bpm)!])
      expect(showBpm(docCps(h.text(), 'rondocode')! * 240)).toBe(String(bpm))
    }
  })
})

describe('the BPM window matches the engine cps clamp', () => {
  it('is [12, 960] bpm, the [0.05, 4] cps window at 4 beats to the bar', () => {
    expect(MIN_BPM).toBeCloseTo(12, 10)
    expect(MAX_BPM).toBeCloseTo(960, 10)
  })
})

describe('header chrome fits its content', () => {
  const css = readFileSync(join(__dirname, '../src/style.css'), 'utf8')
  const rule = (sel: string): string =>
    new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''

  it('the bpm field is wide enough for the widest value it can show', () => {
    // showBpm rounds to one decimal, so the widest string is 5 chars ('127.9',
    // '959.9'). At 4.5ch the tempo you were playing was clipped against 'bpm'.
    const widest = Math.max(
      ...[MIN_BPM, MAX_BPM, bpmToCps(127.9) * 240, 127.94, 959.94].map((b) => showBpm(b).length),
    )
    expect(widest).toBeLessThanOrEqual(5)
    const w = /width:\s*([\d.]+)ch/.exec(rule('.tempo-input'))?.[1]
    expect(w).toBeDefined()
    expect(Number(w)).toBeGreaterThanOrEqual(widest)
  })

  it('tooltips wrap instead of running off the screen', () => {
    // These tips are full sentences. white-space: nowrap made max-width
    // meaningless: the line could not break, so it overflowed the viewport.
    const t = rule('.tooltip')
    expect(t).not.toMatch(/white-space:\s*nowrap/)
    expect(t).toMatch(/max-width:/)
  })

  it('a tooltip can never be wider than the viewport', () => {
    expect(rule('.tooltip')).toMatch(/max-width:\s*min\(/)
  })
})
