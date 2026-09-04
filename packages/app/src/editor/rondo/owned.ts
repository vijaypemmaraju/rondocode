/* ------------------------------------------------------------------------- *
 * The note-event feed a live widget subscribes to, scoped to its OWNER.
 *
 * Widgets used to pick their events out of the whole stream by text (`ev.src`
 * equals my notation) or by synth name (`ev.sound` equals my synth). Both are
 * fine until a song has two sections with the same line in them, and songs
 * do: a `build` and a `main` that both `play lead` over the same notes. Then
 * every widget in the silent section animates along with the sounding one,
 * because nothing they could see told them apart.
 *
 * What tells them apart is WHERE they are. The feed built here asks, per
 * event, whether the section that owns the subscriber's document position is
 * sounding at the event's cycle (the rule lives in @rondocode/rondo's
 * sections.ts, the same one note flash uses) and drops the events that are
 * not. A widget then filters by text or synth as before, but only among the
 * events that could be its own.
 * ------------------------------------------------------------------------- */

import type { SchedulerEvent } from '@rondocode/pattern'
import { toNoteEvs } from './widgets'
import type { NoteEv } from './widgets'

export interface OwnedFeedDeps {
  /** the raw scheduler stream */
  subscribe: (fn: (evs: SchedulerEvent[]) => void) => () => void
  /** the document position an owner sits at; undefined when it is not in the
   *  document (a detached widget, a docs snippet), which means "not scoped" */
  posOf: (owner: object) => number | undefined
  /** does a line at `pos` sound during `cycle`? */
  sounds: (pos: number, cycle: number) => boolean
}

/** The `Hooks.onNoteEvents` implementation: the stream, reduced to NoteEvs,
 *  scoped to the owner's section when an owner is given. The owner's
 *  position is looked up per batch rather than once, because widgets move as
 *  the document is edited above them. */
export function ownedNoteFeed(deps: OwnedFeedDeps): (fn: (evs: NoteEv[]) => void, owner?: object) => () => void {
  return (fn, owner) =>
    deps.subscribe((evs) => {
      let mine = evs
      if (owner !== undefined) {
        const pos = deps.posOf(owner)
        if (pos !== undefined) {
          mine = evs.filter((ev) => typeof ev.cycle !== 'number' || deps.sounds(pos, ev.cycle))
        }
      }
      const notes = toNoteEvs(mine)
      if (notes.length > 0) fn(notes)
    })
}
