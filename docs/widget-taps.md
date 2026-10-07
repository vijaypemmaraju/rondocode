# Widget taps: the piano roll stopped responding after one click

Reported from the field:

> whenever I tried to use it on my phone (also on desktop), the UI elements
> like the note buttons and such would work the first time I clicked, but
> then the UI elements (pianoroll) would stop responding to clicks and at
> some point stop showing their feedback completely. The music was still
> playing, and I could edit the note values in code and with ctrl-enter it
> would update.

Everything in that sentence is one bug, and the shape of the report is the
clue: the audio thread was fine, the editor was fine, and exactly one
subsystem was dead. That subsystem is the widget gesture protocol
(`packages/app/src/editor/rondo/gesture.ts`), and it has a single global
latch.

## What was happening

`attachGesture` is single flight: one widget gesture at a time, across every
widget in the editor, guarded by `drag.active`. Two widgets rewriting
overlapping source ranges at once splices garbage into the code, so the
latch is right.

The latch was claimed one step too late:

```ts
if (drag.active) return
const h = begin(e)     // <- the piano roll writes its first note in here
...
drag.active = true     // <- claimed only now
```

The piano roll is the one widget whose `begin()` writes: a tap on a cell IS
an edit, placed before any movement. With `drag.active` still false, that
write reached the decoration plugin as an ordinary document change, and the
plugin did what it does for ordinary changes: it rebuilt every widget. The
grid under the finger was destroyed and replaced mid pointerdown. Pointer
capture was then requested on a detached element (it throws, and the throw
is swallowed as best effort), and the move/end listeners were attached to
that detached element too, because grids listen on themselves rather than on
`window`.

So the pointerup had nowhere to land, `end()` never ran, and `drag.active`
stayed true for the rest of the session. From then on:

* every widget gesture was rejected by the single flight check, so knobs,
  envelopes, filter curves and step grids went dead along with the roll,
* the enum tap cycler, which also reads `drag.active`, stopped cycling,
* the decoration plugin kept mapping instead of rebuilding, which is why the
  feedback faded out rather than snapping back.

Nothing touched the scheduler or the worklet, so the music played on, and
`loadCode` + ctrl-enter never go through the plugin, so the code path the
reporter fell back on kept working. The knobs hid the bug during
development: they listen on `window`, so their pointerup arrives even after
their own DOM has been swapped out underneath them.

## The fix

Claim the gesture before `begin()` runs, and release the claim if `begin()`
rejects or throws. A write from `begin()` then takes the same path every mid
drag write already takes: the plugin maps its decorations through the change
and the element stays alive under the finger.

## The probe

```
pnpm tsx scripts/probe-taps.ts                        # piano roll, playing
pnpm tsx scripts/probe-taps.ts --stopped              # piano roll, stopped
pnpm tsx scripts/probe-taps.ts --example=drums --sel=.rondo-beatgrid
```

It starts its own dev server, launches a real Chrome over CDP, loads a rondo
example, presses Run, and taps three different cells with trusted mouse
input. Per tap it prints whether the document actually changed, whether the
tapped surface was still in the document while the pointer was down, and how
many playhead flashes landed in the window. It exits non zero if any tap
after the first writes nothing, or if a surface was torn out from under the
finger.

On `main` before this fix, against `acid`:

```
tap 1  wrote=YES  alive-under-the-finger=false  "0 7 3 5 0 0 7 5"
tap 2  wrote=no   ...
tap 3  wrote=no   ...
WEDGED: tap 1 wrote, then 2/2 later taps did nothing
```

After:

```
tap 1  wrote=YES  alive-under-the-finger=true  "0 7 3 5 0 0 7 5"
tap 2  wrote=YES  alive-under-the-finger=true  "0 7 3 5 0 0 ~ 5"
tap 3  wrote=YES  alive-under-the-finger=true  "0 7 3 6 0 0 ~ 5"
every tap wrote
```

## Why a browser and not a test

`widgets.test.ts` says it outright: the decoration scan is tested headless,
but "the full plugin (widget toDOM, pointer handling) needs a real
EditorView + DOM and is exercised manually in the browser instead". This bug
lived entirely in that gap. It needs a real pointerdown through Chrome's
input pipeline, real pointer capture, and CodeMirror's real synchronous DOM
update inside `dispatch`. jsdom has none of those.

The cheap half of the invariant is a unit test, though, and that one runs in
CI: `gesture.test.ts` now asserts that `drag.active` is already set while
`begin()` runs, and that a throwing `begin()` releases the claim instead of
wedging every widget in the editor.

## Believe the green only after you have seen the red

Both guards were watched failing before they were trusted. Stash
`gesture.ts` and the probe prints `WEDGED` and the unit test goes red; the
same run against the beat grid stays green on both sides of the fix, which
is how the blast radius was pinned to the one `begin()` that writes.
