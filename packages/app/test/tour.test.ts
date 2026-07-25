import { describe, expect, it } from 'vitest'
import {
  EDIT_GAP_MS,
  TOUR_DONE_KEY,
  createTourMachine,
  shouldShowTour,
  tourSteps,
} from '../src/ui/tour-machine'
import type { TourStorage } from '../src/ui/tour-machine'

/* The first-run tour's brain. Pinned: the step order, that steps advance on
 * REAL action events only, the drag-stream quiet gap on the chips step, the
 * done-flag semantics (finish or skip, never show again), and the predicate
 * that keeps the tour away from share links and non-pristine buffers. */

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
  const starter = 'const kick = synth(...)'
  const starterRondo = 'synth kick\n  sine'
  const base = {
    storage: memStorage(),
    shareHash: null,
    doc: starter,
    starterDocs: [starter, starterRondo] as const,
  }

  it('shows on a pristine first visit', () => {
    expect(shouldShowTour(base)).toBe(true)
    expect(shouldShowTour({ ...base, doc: starterRondo })).toBe(true)
  })

  it('never shows once the done flag is set', () => {
    const storage = memStorage({ [TOUR_DONE_KEY]: '1' })
    expect(shouldShowTour({ ...base, storage })).toBe(false)
  })

  it('never interrupts a share link being opened', () => {
    expect(shouldShowTour({ ...base, shareHash: 'pAbCd123' })).toBe(false)
  })

  it('never shows over a buffer that is not a starter example', () => {
    expect(shouldShowTour({ ...base, doc: 'my own tune' })).toBe(false)
    expect(shouldShowTour({ ...base, doc: '' })).toBe(false)
  })

  it('tolerates undefined starter variants (an example without rondo source)', () => {
    expect(shouldShowTour({ ...base, starterDocs: [starter, undefined] })).toBe(true)
    expect(shouldShowTour({ ...base, doc: 'x', starterDocs: [undefined] })).toBe(false)
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
