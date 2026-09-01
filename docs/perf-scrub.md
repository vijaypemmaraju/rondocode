# Scrub latency: what a dragged number costs, measured

"Dragging a number left/right lags the audio, turning a knob doesn't." The
first answer came from reading source: per-rewrite widget rebuilds were
starving the pattern scheduler. A branch fixed that. Then the measurement
below ran on both sides of the branch and printed the same numbers. The
rebuilds cost nothing. The lag was a fixed 70 ms throttle in front of a
2 ms pipeline.

This is that measurement, kept as a tool:

```
pnpm tsx scripts/measure-scrub.ts
```

It starts its own dev server, launches a real Chrome, loads the `club`
example, presses Run, and performs a synthetic Alt+drag on `onepole 380`,
sweeping back and forth for three seconds. It taps both ends of the pipeline
(`view.dispatch` for rewrites, `AudioSession.send` for engine messages) and
reports rewrite-to-engine latency, frame pacing during the drag, long tasks
and editor DOM churn, and whether the widget count came back to where it
started.

## The numbers

On the fixed 70 ms throttle (`main` before #421): median 39 ms, p90 70 ms,
max 76 ms from each rewrite to its `patchConstants`; 95 rewrites became 40
evals, and every eval also resent an empty `setMicMap` to the worklet.

Paced by the last eval's cost (`evalpace.ts`): median 5 ms, p90 5 to 6 ms,
max 12 ms; 95 rewrites, 95 `patchConstants`, no `setMicMap`, no long tasks,
widget DOM 15 before and 15 after. Finger to sound is now the scrubber's own
30 ms rewrite cadence plus about 5 ms plus one audio block.

## Why it is a script and not a test

Latency here is a property of a real main thread with a real AudioWorklet
behind it, and the drag has to go through Chrome's input pipeline
(`Input.dispatchMouseEvent` with the Alt modifier) to exercise the scrubber's
pointer handling. jsdom has neither.

## Believe the green only after you have seen the red

Before trusting a run, break it. Drop the Alt modifier from the `mousePressed`
event and the scrubber never engages: the harness prints zero rewrites, the
literal is unchanged, and it says so. A run that cannot fail is not measuring
anything.

## Knobs

```
--example=poly --needle="adsr .008" --offset=5   # another literal
--secs=5 --step=4 --sweep=200                    # a longer, gentler drag
--label=before                                   # for side by side A/B output
```

The literal is found by `--needle` (text in the document) plus `--offset`
(characters into it). Pick an offset that lands on the number itself.
