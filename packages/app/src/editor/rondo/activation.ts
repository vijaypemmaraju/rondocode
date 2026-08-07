/* ------------------------------------------------------------------------- *
 * ACTIVATION: every widget animates to the playhead when its owner sounds.
 *
 * Six widgets went live and seven did not, and the seven were not a decision —
 * each live one hand-rolled the same three-part shape (subscribe to note
 * events, schedule against the audio clock, tear down on destroy) and the rest
 * simply never got it written. So a filter curve, a switch and a unison fan sat
 * dead while the roll above them lit up, and the eq under a screaming synth
 * looked exactly the same whether the transport was running or stopped.
 *
 * The value is NOT the signal here. A knob can follow its drive because a
 * pattern-driven param arrives in `NoteEv.controls`; a synth-internal binding
 * (`cut = amp -> 1300..3000`) is computed in the audio graph and appears in no
 * event at all. Chasing per-widget live VALUES would mean an engine change per
 * widget. But "my synth just sounded" is already on every event, and that is
 * enough to answer the question a dead widget leaves open: is this thing doing
 * anything right now?
 *
 * So this module owns the one rule, and the widgets own their own look. It
 * splits in two on purpose:
 *
 *   scheduleFires()  pure — events + clock in, delays + hold times out.
 *   activate()       the DOM half: a class on, a class off, a teardown.
 *
 * The pure half is where the errors live (events arrive AHEAD of the audio
 * clock, so a naive `setTimeout(0)` fires every widget early and in a clump),
 * and it is the half a test can pin without a browser.
 * ------------------------------------------------------------------------- */

/** Structural stand-in for widgets.ts's NoteEv — declared rather than imported
 *  so this module stays out of the widgets/filtercurve import cycle. */
export interface FireEv {
  timeSec: number
  durSec: number
  sound?: string
}

/** Clock + event feed. A subset of Hooks, so any caller already holding Hooks
 *  satisfies it structurally. */
export interface ActivationHooks {
  now?: () => number
  onNoteEvents?: (fn: (evs: FireEv[]) => void) => () => void
}

/** How long a note keeps a widget lit, in ms. Mirrors widgets.ts's LIT_MIN_MS
 *  / LIT_MAX_MS: below the floor a fast hat is a flicker nobody can see, above
 *  the ceiling a two-bar pad would leave the widget lit so long it reads as
 *  stuck on rather than as playing. */
export const LIT_MIN_MS = 120
export const LIT_MAX_MS = 1200

/** Never queue more than this many pending fires — a dense pattern can deliver
 *  hundreds of events in one batch, and a widget only needs the next few. */
export const MAX_FIRES = 32

export interface Fire {
  /** ms from now until this note sounds (never negative — a late event fires
   *  immediately rather than being dropped). */
  delayMs: number
  /** ms to stay lit once it does. */
  holdMs: number
}

/**
 * The fires a batch of events should produce for `synth`, relative to `now`.
 *
 * Pure, and the whole reason this module exists as its own file: note events
 * arrive AHEAD of the audio clock (the scheduler runs a lookahead), so the
 * delay is `timeSec - now` and not zero. Getting that wrong does not error, it
 * just lights every widget early and all at once, which looks like a glitch
 * rather than like a bug.
 */
export function scheduleFires(
  evs: readonly FireEv[],
  now: number,
  synth: string | undefined,
): Fire[] {
  const out: Fire[] = []
  for (const ev of evs) {
    // undefined `synth` means "anything on this document lights me" — a bus or
    // master widget has no one owning synth. A widget that HAS one ignores
    // every other voice, or a busy drum pattern would light the whole file.
    if (synth !== undefined && ev.sound !== synth) continue
    if (!Number.isFinite(ev.timeSec)) continue
    const delayMs = Math.max(0, (ev.timeSec - now) * 1000)
    const durMs = Number.isFinite(ev.durSec) ? ev.durSec * 1000 : 0
    out.push({ delayMs, holdMs: Math.min(Math.max(durMs, LIT_MIN_MS), LIT_MAX_MS) })
    if (out.length >= MAX_FIRES) break
  }
  return out
}

/** The timer surface, injected so a test can drive time by hand. */
export interface Sched {
  at: (delayMs: number, fn: () => void) => void
  clear: () => void
}

/** A `Sched` over setTimeout that drops everything still pending on clear —
 *  widgets die on every rebuild, so a leak here piles up fast. */
export function timerSched(): Sched {
  const pending = new Set<ReturnType<typeof setTimeout>>()
  return {
    at(delayMs, fn) {
      if (pending.size >= MAX_FIRES) return
      const h = setTimeout(() => { pending.delete(h); fn() }, Math.max(0, delayMs))
      pending.add(h)
    },
    clear() {
      for (const h of pending) clearTimeout(h)
      pending.clear()
    },
  }
}

export interface ActivateOpts {
  /** the synth whose notes light this widget; undefined = every note does. */
  synth?: string
  /** class toggled for the duration of each note. */
  className?: string
  /** called when a note starts, with how long it will stay lit. Widgets that
   *  draw rather than restyle (a canvas curve) hook here. */
  onFire?: (holdMs: number) => void
  /** called when it goes dark again. */
  onIdle?: () => void
  /** injected timer surface; defaults to real setTimeout. */
  sched?: Sched
}

/**
 * Light `el` whenever `synth` sounds. Returns a teardown that unsubscribes and
 * drops every pending timer — call it from the widget's `destroy()`.
 *
 * A no-op (returning a teardown that does nothing) when the hooks carry no
 * event feed or no clock, which is the docs page and any test that renders a
 * widget without a transport. Widgets therefore call this unconditionally
 * rather than each repeating the same `if (hooks.onNoteEvents && hooks.now)`.
 */
export function activate(
  el: { classList: { add: (c: string) => void; remove: (c: string) => void } },
  hooks: ActivationHooks,
  opts: ActivateOpts = {},
): () => void {
  const { onNoteEvents, now } = hooks
  if (onNoteEvents === undefined || now === undefined) return () => {}
  const cls = opts.className ?? 'firing'
  const sched = opts.sched ?? timerSched()
  // ARMED marks a widget that is wired to a transport and can therefore light.
  // It exists so the resting style can be dimmer than the lit one WITHOUT
  // dimming the docs page, where there is no transport and nothing will ever
  // fire — a permanently half-lit widget reads as broken, not as idle.
  el.classList.add('armed')
  // Nested notes overlap: a pad's tail is still lit when the next one starts,
  // so darkness is owned by a COUNT, not by whichever timer fires last. With a
  // bare on/off the second note's end would black out a widget the third note
  // is still sounding through.
  let lit = 0
  const unsub = onNoteEvents((evs) => {
    for (const f of scheduleFires(evs, now(), opts.synth)) {
      sched.at(f.delayMs, () => {
        lit++
        el.classList.add(cls)
        opts.onFire?.(f.holdMs)
        sched.at(f.holdMs, () => {
          lit--
          if (lit > 0) return
          el.classList.remove(cls)
          opts.onIdle?.()
        })
      })
    }
  })
  return () => {
    unsub()
    sched.clear()
    lit = 0
    el.classList.remove(cls)
    el.classList.remove('armed')
  }
}
