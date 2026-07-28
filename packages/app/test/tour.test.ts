import { describe, expect, it } from 'vitest'
import { EDIT_GAP_MS, TOUR_DONE_KEY, bestScrubIndex, createTourMachine, shouldShowTour, tourSteps } from '../src/ui/tour-machine'
import type { DragTarget } from '../src/ui/tour-machine'
import type { TourStorage } from '../src/ui/tour-machine'

/* The first-run tour's brain. Pinned: the step order, that steps advance on
 * REAL action events only, the drag-stream quiet gap on the chips step, the
 * done-flag semantics (finish or skip, never show again), and the predicate
 * that keeps onboarding away from share links and repeat visitors. */

const memStorage = (init?: Record<string, string>): TourStorage & { data: Map<string, string> } => {
  const data = new Map(Object.entries(init ?? {}))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  }
}

/** A machine with a hand-cranked clock. */
const make = (opts?: { chips?: boolean; storage?: TourStorage }) => {
  let t = 1000
  const storage = opts?.storage ?? memStorage()
  const m = createTourMachine({ chips: opts?.chips ?? true, storage, now: () => t })
  return { m, storage, tick: (ms: number) => (t += ms) }
}

describe('tourSteps', () => {
  it('orders the full loop: play, widget, chips, docs', () => {
    expect(tourSteps({ chips: true }).map((s) => s.id)).toEqual(['play', 'widget', 'chips', 'docs'])
  })

  it('drops the chips step when the chip bar is not on screen', () => {
    expect(tourSteps({ chips: false }).map((s) => s.id)).toEqual(['play', 'widget', 'docs'])
  })

  it('advances on real actions only: played, edited, edited, dismissed', () => {
    expect(tourSteps({ chips: true }).map((s) => s.advance)).toEqual([
      'played',
      'edited',
      'edited',
      'dismissed',
    ])
  })

  it('has no em dashes in the coach copy', () => {
    for (const s of tourSteps({ chips: true })) expect(s.copy).not.toMatch(/—/)
  })
})

describe('createTourMachine', () => {
  it('is idle until started, then shows the play step', () => {
    const { m } = make()
    expect(m.step()).toBeNull()
    m.handle('played') // events before start are ignored
    expect(m.step()).toBeNull()
    m.start()
    expect(m.step()?.id).toBe('play')
    expect(m.stepIndex()).toBe(0)
    expect(m.count()).toBe(4)
  })

  it('ignores events the current step is not waiting for', () => {
    const { m } = make()
    m.start()
    m.handle('edited')
    m.handle('dismissed')
    expect(m.step()?.id).toBe('play')
  })

  it('walks the whole loop on the real action sequence', () => {
    const { m, storage, tick } = make()
    m.start()
    m.handle('played')
    expect(m.step()?.id).toBe('widget')
    m.handle('edited') // first widget drag event advances immediately
    expect(m.step()?.id).toBe('chips')
    tick(EDIT_GAP_MS + 1) // a fresh gesture after the drag settled
    m.handle('edited')
    expect(m.step()?.id).toBe('docs')
    expect(m.done()).toBe(false)
    m.handle('dismissed')
    expect(m.step()).toBeNull()
    expect(m.done()).toBe(true)
    expect((storage as ReturnType<typeof memStorage>).data.get(TOUR_DONE_KEY)).toBe('1')
  })

  it('does not let a continuous knob-drag stream blow through the chips step', () => {
    const { m, tick } = make()
    m.start()
    m.handle('played')
    m.handle('edited') // drag begins: enter chips mid-stream
    expect(m.step()?.id).toBe('chips')
    for (let i = 0; i < 100; i++) {
      tick(16) // pointermove cadence
      m.handle('edited')
    }
    expect(m.step()?.id).toBe('chips') // still waiting for a fresh gesture
    tick(EDIT_GAP_MS + 1)
    m.handle('edited') // the chip tap, after the drag settled
    expect(m.step()?.id).toBe('docs')
  })

  it('measures the quiet gap from the LAST edit, not from step entry', () => {
    const { m, tick } = make()
    m.start()
    m.handle('played')
    m.handle('edited')
    tick(EDIT_GAP_MS + 1)
    m.handle('edited') // would advance...
    expect(m.step()?.id).toBe('docs')
    // ...and a rapid follow-up edit right after entering chips must not count
    const n = make()
    n.m.start()
    n.m.handle('played')
    n.m.handle('edited')
    n.tick(EDIT_GAP_MS - 10)
    n.m.handle('edited') // too soon: resets the clock
    n.tick(EDIT_GAP_MS - 10)
    n.m.handle('edited') // still too soon relative to the previous edit
    expect(n.m.step()?.id).toBe('chips')
  })

  it('skips from EVERY step, setting the done flag each time', () => {
    const walk: ('played' | 'edited' | 'dismissed')[] = ['played', 'edited', 'edited']
    for (let stop = 0; stop < 4; stop++) {
      const { m, storage, tick } = make()
      m.start()
      for (let i = 0; i < stop; i++) {
        tick(EDIT_GAP_MS + 1)
        m.handle(walk[i]!)
      }
      m.skip()
      expect(m.step()).toBeNull()
      expect(m.done()).toBe(true)
      expect((storage as ReturnType<typeof memStorage>).data.get(TOUR_DONE_KEY)).toBe('1')
    }
  })

  it('notifies onChange with each step and null at the end', () => {
    const { m } = make({ chips: false })
    const seen: (string | null)[] = []
    m.onChange((s) => seen.push(s?.id ?? null))
    m.start()
    m.handle('played')
    m.handle('edited')
    m.handle('dismissed')
    expect(seen).toEqual(['play', 'widget', 'docs', null])
  })

  it('restarts from the top after finishing (options panel replay)', () => {
    const { m } = make({ chips: false })
    m.start()
    m.handle('played')
    m.handle('edited')
    m.handle('dismissed')
    expect(m.done()).toBe(true)
    m.start()
    expect(m.step()?.id).toBe('play')
    expect(m.done()).toBe(false)
  })

  it('survives a storage that throws on write', () => {
    const bad: TourStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    const m = createTourMachine({ chips: false, storage: bad, now: () => 0 })
    m.start()
    m.skip() // must not throw
    expect(m.step()).toBeNull()
    expect(m.done()).toBe(true)
  })
})

describe('shouldShowTour', () => {
  const base = { storage: memStorage(), shareHash: null }

  it('shows for any first-time visitor (the flag is absent)', () => {
    // No pristine-buffer condition anymore: onboarding creates its own
    // welcome project, so it may show even after the visitor edited first.
    expect(shouldShowTour(base)).toBe(true)
  })

  it('never shows once the done flag is set', () => {
    const storage = memStorage({ [TOUR_DONE_KEY]: '1' })
    expect(shouldShowTour({ ...base, storage })).toBe(false)
  })

  it('never interrupts a share link being opened', () => {
    expect(shouldShowTour({ ...base, shareHash: 'pAbCd123' })).toBe(false)
  })

  it('stays quiet when storage is unreadable (cannot remember a dismissal)', () => {
    const broken: TourStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
    }
    expect(shouldShowTour({ ...base, storage: broken })).toBe(false)
  })
})

describe('the drag step describes the control that is actually there', () => {
  /* Reported: choosing "I write JavaScript" gave a second card that read
   * "Drag this control while it plays" but pointed at something only rondo
   * has. Two things were wrong at once — JavaScript mode renders no widget for
   * the welcome track (widgets exist only for explicit slider/toggle/pick/xy
   * calls), and a mouse cannot scrub a number at all without ALT (scrub.ts),
   * so "drag" was not even true for the thing it landed on. */
  const copyFor = (drag: DragTarget): string =>
    tourSteps({ chips: false, drag }).find((s) => s.id === 'widget')!.copy

  it('says knob only when a knob widget is on screen', () => {
    expect(copyFor('knob')).toMatch(/knob/i)
    expect(copyFor('knob')).not.toMatch(/alt/i)
  })

  it('tells a mouse user to hold Alt, because plain dragging selects text', () => {
    const copy = copyFor('number-mouse')
    expect(copy).toMatch(/alt-drag/i)
    expect(copy).toMatch(/number/i)
    expect(copy).not.toMatch(/finger/i) // there is no finger on a desktop
  })

  it('tells a touch user to just drag, since touch scrubs immediately', () => {
    const copy = copyFor('number-touch')
    expect(copy).toMatch(/number/i)
    expect(copy).not.toMatch(/alt/i)
  })

  it('never calls a scrubbable number a "control"', () => {
    // the word that made the card ambiguous in the first place
    for (const t of ['number-mouse', 'number-touch'] as DragTarget[]) {
      expect(copyFor(t)).not.toMatch(/\bcontrol\b/i)
    }
  })

  it('defaults to the knob wording when no target is given', () => {
    expect(tourSteps({ chips: true }).find((s) => s.id === 'widget')!.copy).toBe(copyFor('knob'))
  })

  it('every drag target still advances on an edit', () => {
    for (const t of ['knob', 'number-mouse', 'number-touch'] as DragTarget[]) {
      expect(tourSteps({ chips: false, drag: t }).find((s) => s.id === 'widget')!.advance).toBe('edited')
    }
  })
})

describe('the drag step points at a number you can HEAR', () => {
  it('skips leading envelope times for the first big number', () => {
    // the JS welcome track's numbers, in document order: a=0.01, d=0.15,
    // s=0.5, r=0.2, then the cutoff 1200. Dragging 0.01 is inaudible.
    expect(bestScrubIndex(['0.01', '0.15', '0.5', '0.2', '1200'])).toBe(4)
  })

  it('takes a big number immediately when one leads', () => {
    expect(bestScrubIndex(['6000', '0.001'])).toBe(0)
  })

  it('falls back to the first number when everything is small', () => {
    expect(bestScrubIndex(['0.5', '0.2'])).toBe(0)
  })

  it('is -1 with nothing to point at', () => {
    expect(bestScrubIndex([])).toBe(-1)
  })

  it('ignores junk text rather than picking it', () => {
    expect(bestScrubIndex(['abc', '880'])).toBe(1)
  })

  it('treats a big negative the same (it is still audible to drag)', () => {
    expect(bestScrubIndex(['0.1', '-400'])).toBe(1)
  })
})
