# Frame pacing: how to measure it, and what it measured

Eight commits went into one stutter and the first five were guesses. Two of them
targeted costs later measured at under 0.1 ms per frame. The measurement that
actually ended it took ten minutes; it just needed a real browser and a number.

This is that measurement, kept as a tool:

```
pnpm tsx scripts/measure-frames.ts
```

It starts its own dev server, launches a real Chrome, drives it over the
DevTools protocol, and for every shipped example reports frames per second, p95
and worst frame gap, dropped frames, and the render loop's own CPU time, with
the visuals on and off.

## Why it is a script and not a test

Frame pacing is a property of a compositor with a GPU behind it. jsdom has no
frames at all, and headless Chrome's software WebGPU path produces numbers that
say nothing about a user's machine. So this exits non-zero under `--min-fps`
when you ask it to, and is run on demand rather than in CI.

It also cannot be measured from an automation tab. A tab in a collapsed tab
group reports `document.visibilityState === 'hidden'`, and Chrome throttles a
hidden tab's `requestAnimationFrame` to zero. You can measure *work* in such a
tab (layout, style, paint) but never *pacing*, which is the number that matters.

## Believe the green only after you have seen the red

A sweep that prints 60 fps everywhere is worth exactly as much as the
instrument's ability to print something else. `scripts/perf/pre-228-paint.css`
restores every per-frame blur that #226, #227 and #228 removed, so the harness
can be shown failing before its passing means anything:

```
pnpm tsx scripts/measure-frames.ts --examples=techno \
  --inject-css=scripts/perf/pre-228-paint.css
```

|                | shader on | shader off |
| -------------- | --------- | ---------- |
| `techno`       | 10.3 fps  | 60.1 fps   |
| `language saw` | 6.8 fps   | 60.1 fps   |

That is the shape to look for: the shader-on column collapses and the
shader-off column does not. The absolute numbers are not portable, since
refresh rate, scale factor and GPU all move them.

Getting there took three failed calibrations, each of which taught something
worth not relearning:

- **One rule at a time proves nothing.** Restoring only the blurred glyph
  shadow measured 53.9 fps, not 3. The four removed rules compound.
- **The scrim is half the fix.** #228 also gave `.cm-content` a flat background.
  A text layer with an opaque backdrop of its own can be cached no matter how
  expensive its glyphs are, so restoring the shadows while keeping the scrim
  measures almost green. The calibration file sets `background: transparent`
  for exactly this reason.
- **The display is part of the experiment.** The first runs sat on a 1x monitor,
  where the compositor pushes a quarter of the pixels a Retina user pays for.
  The harness now pins `--force-device-scale-factor` (`--dpr`, default 2) so a
  green sweep cannot mean "the window happened to open on the cheap monitor".

## The baseline

Every shipped example, visuals on and off, at the top of the document and at 65%
down it. `singing` and `live mic` are skipped: one waits on a large model
download and the other on a microphone prompt, so unattended they would measure
a dialog.

Taken on an M-series Mac, 60 Hz display, `--dpr=2`, 4 s per sample:

104 samples, 26 examples. Every one at the display rate, zero dropped frames,
worst single gap 21.9 ms, and the render loop never above 0.34 ms of CPU:

```
example               on     off      p95     worst  chars
visuals             60.1      60   18.5ms    19.5ms  2205
techno                60    60.1   18.4ms    19.7ms  3561
trance                60    60.1   18.5ms    21.9ms  2997
future bass           60    60.1   18.6ms      21ms  2998
drum groove           60    60.1   18.5ms    19.3ms  1280
fm keys               60    60.1   18.6ms    19.6ms  1187
fm presets            60    60.1   18.6ms    20.3ms  1934
chiptune              60    60.1   18.5ms    19.4ms  1466
chop                  60    60.1   18.3ms    19.4ms   759
acid                60.1    60.1   18.6ms    20.1ms  1716
dubstep             60.1    60.1   18.4ms    19.4ms  2908
ambient bells       60.1    60.1   18.5ms    19.9ms   839
chords & arps       60.1    60.1   18.5ms    20.5ms  1125
over a chord        60.1    60.1   18.9ms    20.7ms  1490
generative          60.1    60.1   18.6ms    19.8ms  1462
edm                 60.1    60.1   18.5ms    20.8ms  3084
synthscape          60.1    60.1   18.5ms    19.6ms  3001
arrangement         60.1    60.1   18.6ms    20.9ms  2920
sampler             60.1    60.1   18.5ms    20.6ms  1512
granular            60.1    60.1   18.6ms    20.2ms   914
wobble              60.1    60.1   18.6ms    20.3ms   623
club                60.1    60.1   18.5ms    21.3ms  1547
drum machine        60.1    60.1   18.6ms    20.6ms  1644
polyrhythm          60.1    60.1   18.6ms      20ms  1544
wavetable lead      60.1    60.1   18.6ms    19.4ms   867
macros              60.1    60.1   18.6ms    21.1ms  1787
```

The interesting row is `techno`: under the calibration stylesheet above it
measures 10.3 fps, so the paint fixes were not only about a local test file.
Whatever regresses next will show up here first, because it has the most
characters on screen.

`chars` is the number of document characters CodeMirror had rendered, the
quantity a per-glyph paint cost scales with, and the reason `techno` and the
section-heavy examples are the ones to watch.

## Reading a bad result

`cpuMs` is the diagnosis, not the fps. It is what the render loop itself spends
per frame. If fps is on the floor and `cpuMs` is 0.2, the time is not in script:
it is in paint or in the GPU, and no amount of reading the render loop will find
it. That was true of every one of the guessed fixes.

From there, take a trace (`Tracing.start` / `Tracing.end` over the same CDP
connection). The trace that ended this investigation put 2974 ms of a 4-second
window in `IOSurfaceImageBacking::WaitForCommandsToBeScheduled::Dawn`: the
compositor blocked on the WebGPU surface, which is nothing the JavaScript could
have shown.

## Options

| flag            | default | what it does                                              |
| --------------- | ------- | --------------------------------------------------------- |
| `--examples=`   | all     | comma-separated substrings; matches local examples too     |
| `--secs=`       | 4       | sample window per example, shader state and scroll stop    |
| `--scroll=`     | `0`     | fractions of the document to sample at, e.g. `0,0.65`      |
| `--shader=`     | `both`  | `on`, `off` or `both`                                      |
| `--dpr=`        | 2       | rasterization scale factor                                 |
| `--min-fps=`    | off     | exit non-zero if any sample falls under it                 |
| `--inject-css=` | none    | append a stylesheet before measuring, to A/B a change      |
| `--url=`        | none    | use an already-running dev server instead of starting one  |
| `--json=`       | none    | write every sample as JSON                                 |
| `--keep`        | off     | leave Chrome open at the end                               |
