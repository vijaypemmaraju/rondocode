/* ------------------------------------------------------------------------- *
 * "Take it from bar 9."
 *
 * Two ways to say it, one thing being said. The header field is for when you
 * know the number; putting the cursor in a section and pressing
 * Cmd/Ctrl+Shift+Enter is for when you know the music instead — the section
 * that owns the cursor names its own first bar, so nobody has to count.
 *
 * Both write the same value, and the field always shows it: a start point
 * that is remembered but invisible is a trap the next Run springs. Typing in
 * the field is therefore not a separate mode from clicking in the code, it is
 * the same setting seen from the other end.
 *
 * UNITS. Everything here is in MEASURES, counted from 1 the way a score is.
 * The single conversion to the scheduler's 0-based cycles happens in cycle()
 * (via measureToCycle), and nothing above it may do that subtraction again.
 * ------------------------------------------------------------------------- */

import { cycleToMeasure, measureToCycle } from '@rondocode/pattern'
import { sectionAt, startCycleAt } from '@rondocode/rondo'
import type { Arrangement, SectionRange } from '@rondocode/rondo'
import { tooltip } from '../ui/tooltip'

export interface StartFromOpts {
  /**
   * The cycle the cursor's section starts at, for "run from here". Undefined
   * when the document cannot answer: JavaScript rather than rondo, no `song`
   * to place the sections in time, or a section the song never plays. The
   * caller owns that rule (it holds the live arrangement); this module only
   * asks.
   */
  cursorCycle: () => number | undefined
  /** Start playing with the current value. The keybinding runs this itself
   *  rather than returning, so "from here" is one gesture, not two. */
  run: () => void
  /** Told when the value changes, so a caller can flash or log it. */
  onChange?: (measure: number) => void
}

export interface StartFromHandle {
  /** The header pill. */
  el: HTMLElement
  /** What to hand `transport('play', { from })`: a 0-based CYCLE. */
  cycle: () => number
  /** The measure shown, counted from 1. */
  measure: () => number
  /** Put the cursor's section in the field and start there. Returns false
   *  when the document cannot say where the cursor's section begins, so a
   *  keymap can fall through rather than starting the wrong take. */
  fromCursor: () => boolean
  /** Back to the top. */
  reset: () => void
}

/**
 * The cycle "run from here" should start at, or undefined when the document
 * cannot say and the caller should just Run normally.
 *
 * Three ways it cannot say, and all three mean the same thing — nothing here
 * names a bar to jump to:
 *  - the buffer is JavaScript, where a `section` is not a block the editor
 *    can see (the arrangement is whatever arrange() was handed at runtime);
 *  - the piece has no sections at all, so there is only one place to start;
 *  - the cursor is on a top-level line, which belongs to the whole piece
 *    rather than to any one part of it.
 * A missing `song` line is NOT one of them: sections without a song play in
 * the order they are written (rondo's sectionOrder), which is an order with
 * start times like any other.
 *
 * The last case is the interesting one: startCycleAt answers 0 for a top-level
 * position, which is right for "where does this line start sounding" and
 * wrong as an answer to "which section did you point at". Asking sectionAt
 * first keeps the field from being silently reset to 1 by a stray cursor.
 */
export function cursorStartCycle(
  lang: string,
  ranges: readonly SectionRange[],
  arrangement: Arrangement | undefined,
  pos: number,
): number | undefined {
  if (lang !== 'rondo' || arrangement === undefined) return undefined
  if (sectionAt(ranges, pos) === undefined) return undefined
  return startCycleAt(ranges, arrangement, pos)
}

/** The measure a typed string means, or null when it means nothing. Blank is
 *  1 (the top) rather than an error: clearing the field is how you undo it. */
export function parseMeasure(text: string): number | null {
  const t = text.trim()
  if (t === '') return 1
  if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  // Measure 0 does not exist in music, and neither does measure 1e9 in any
  // song someone is editing. Both mean the person is still typing or has
  // mistyped, and the last good value is the better answer.
  return n >= 1 && n <= 9999 ? n : null
}

export function mountStartFrom(opts: StartFromOpts): StartFromHandle {
  const root = document.createElement('div')
  root.className = 'startfrom'
  const label = document.createElement('span')
  label.className = 'startfrom-label'
  label.textContent = 'from'
  const field = document.createElement('input')
  field.className = 'startfrom-input'
  field.type = 'text'
  field.inputMode = 'numeric'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.setAttribute('aria-label', 'start at measure')
  root.append(label, field)

  let measure = 1
  const refresh = (): void => {
    if (document.activeElement !== field) field.value = String(measure)
    // The pill only looks "set" when it actually changes where Run starts, so
    // the default state is quiet and a non-default one is impossible to miss.
    root.classList.toggle('set', measure !== 1)
    tooltip(
      root,
      measure === 1
        ? 'start at measure 1 (the top). Type a measure to start there instead, or put the cursor in a section and press Cmd/Ctrl+Shift+Enter.'
        : `Run starts at measure ${measure}. Clear the field to go back to the top.`,
    )
  }

  const set = (m: number): void => {
    if (m === measure) return
    measure = m
    refresh()
    opts.onChange?.(m)
  }

  const commit = (): void => {
    const typed = parseMeasure(field.value)
    if (typed === null) {
      refresh() // unreadable: snap back to what Run will actually do
      return
    }
    set(typed)
    refresh()
  }

  field.addEventListener('blur', commit)
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
      field.blur()
      opts.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      refresh() // abandon the edit
      field.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Nudging a bar at a time is what this field is for; the keyboard is
      // faster than retyping when you are hunting for the right entry point.
      e.preventDefault()
      const now = parseMeasure(field.value) ?? measure
      set(Math.max(1, now + (e.key === 'ArrowUp' ? 1 : -1)))
      refresh()
    }
  })

  refresh()

  return {
    el: root,
    cycle: () => measureToCycle(measure),
    measure: () => measure,
    fromCursor: () => {
      const cyc = opts.cursorCycle()
      if (cyc === undefined) return false
      set(cycleToMeasure(cyc))
      refresh()
      opts.run()
      return true
    },
    reset: () => {
      set(1)
      refresh()
    },
  }
}
