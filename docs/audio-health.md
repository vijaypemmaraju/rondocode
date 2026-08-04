# Audio health: does every example still make sound?

`test/examples.test.ts` proves each shipped example evaluates and schedules
notes. Nothing rendered them, so an example could clip, collapse to near
silence, or lose a voice and the suite would stay green. This is the check that
listens:

```
pnpm tsx scripts/measure-audio.ts
pnpm tsx scripts/measure-audio.ts --examples=club --cycles=16
pnpm tsx scripts/measure-audio.ts --strict     # exit non-zero on a flag
```

It renders every shipped example through the same offline path the WAV bounce
uses and reports peak, integrated loudness, crest and spectral centroid, with a
flag on anything outside the house style.

## Why it is a script, not a test

Rendering 29 examples is minutes of DSP, which does not belong in a suite
people run on every save. It is the audio twin of `scripts/measure-frames.ts`:
run it after touching the engine, the mix stage or the examples, and update the
baseline below.

## The built-in bank, offline

The four built-in samples (`vox`, `riser`, `pad`, `break`) are procedurally
generated pure functions, not files — so the headless path loads exactly what
the browser builds at startup, via `builtInSamples()` in
`packages/app/src/audio/demo-samples.ts`. Before that, every `sample()` and
`granular()` voice rendered as digital zero and the scripts reported success
over it: `render-example.ts granular` wrote a silent file.

What remains unavailable offline is a sample a USER loads in the app, a
`sing()` vocal (baked in the browser) and the live microphone. Those are
reported as `needs …` rather than flagged, because calling a working example
broken trains you to ignore the output, which is how a real failure gets
missed. The scripts also say plainly when a render came out silent instead of
reporting success over zeros.

## What "healthy" means

| measure | want | why |
| --- | --- | --- |
| peak | -20 to -0.5 dBFS | quieter is inaudible beside the others |
| norm | 0 dB | how far the mix stage had to pull the whole bounce down to reach its 0.89 peak ceiling. Reported, never flagged: the file sounds fine, but past the ceiling the gains inside it have stopped being live |
| crest | 4 to 18 dB | under 4 reads as over-compressed, over 18 as unmixed or very sparse |
| NaN / clipped | never | the graph's math blew up, or the bounce will distort |
| silent | only when it needs an input the renderer lacks | otherwise a voice is dead |

## The baseline

30 examples, 8 cycles each, 48 kHz, through the offline mix (sidechain, send
buses and master glue included). Every one healthy or explained:

```
example             peak    LUFS  crest   norm  centroid  notes
acid                -1.7   -13.4   13.9      -     366Hz
visuals               -1   -13.2   13.9   -7.3     348Hz  mixed into the ceiling, normalized -7.3dB
techno              -1.3    -9.5    7.6      -     202Hz
dubstep               -1   -12.8   11.5   -4.4     533Hz  mixed into the ceiling, normalized -4.4dB
trance                -1     -10    8.5   -0.7     150Hz  mixed into the ceiling, normalized -0.7dB
future bass           -1    -9.3    9.1   -0.2    1141Hz
ambient bells       -1.8   -13.6   17.9      -     706Hz
drum groove         -1.2   -13.3   12.3      -     332Hz
fm keys             -1.4   -11.4   12.4      -     437Hz
fm presets            -1   -12.1   15.1   -7.9    1696Hz  mixed into the ceiling, normalized -7.9dB
chiptune              -1   -15.2   14.7   -4.3     381Hz  mixed into the ceiling, normalized -4.3dB
chords & arps         -1   -13.2   14.7   -0.9     537Hz  mixed into the ceiling, normalized -0.9dB
over a chord          -1   -13.3   14.3   -2.2     354Hz  mixed into the ceiling, normalized -2.2dB
generative            -1   -12.7   13.4   -1.4     379Hz  mixed into the ceiling, normalized -1.4dB
edm                   -1     -13   13.2   -0.6     551Hz  mixed into the ceiling, normalized -0.6dB
synthscape          -1.3   -13.2   12.5      -     153Hz
arrangement         -3.1   -13.6   12.6      -    2144Hz
sampler               -3   -14.5   12.1      -     253Hz
granular            -4.3   -16.2   14.1      -     305Hz
singing               -1   -13.9   13.2   -1.7     264Hz  needs samples: singclipnl0399
wobble              -8.4   -14.8    8.6      -     333Hz
club                -3.4   -12.2   11.3      -     315Hz
drum machine          -1   -14.4   15.3   -5.2    1771Hz  mixed into the ceiling, normalized -5.2dB
polyrhythm            -1   -10.9   11.1     -1     378Hz  mixed into the ceiling, normalized -1dB
live mic         -Infinity -Infinity      0      -       0Hz  needs the live mic
wavetable lead      -2.8   -15.7   17.5      -    2699Hz
chop                -1.2   -15.8   13.6      -     682Hz
macros                -1   -11.4   11.2   -1.4     182Hz  mixed into the ceiling, normalized -1.4dB
waltz                 -1   -16.4   16.3   -3.3     317Hz  mixed into the ceiling, normalized -3.3dB
reverse cymbal      -1.5   -14.8   15.6      -    2891Hz
```

**The peak column cannot flag a hot example, and never could.** Anything over
0.89 has already been scaled back down to it, so a project mixed 8 dB into the
ceiling and a carefully levelled one both read -1.0 dBFS. That is why 13 of
these rows sit at exactly -1: it is the ceiling, not their level. The `norm`
column is the missing evidence, and it is the number to watch when a gain edit
seems to do nothing. `fm presets` gives up 7.9 dB, `visuals` 7.3, `drum
machine` 5.2.

Rows worth knowing about rather than fixing: `sampler` and `chop` measure quiet
because the parts you actually hear are the samples, and what is left is the
accompaniment. `wavetable lead` and `ambient bells` sit near the sparse end of
the crest range because they are single sustained voices, which is what they
are for.

## Loudness matching

The examples once spanned **15.5 LUFS** — flipping from `future bass` (-9.3) to
`wavetable lead` (-24.8) dropped the volume by more than 15 dB, and the
quietest were the teaching examples a newcomer opens first. Five were raised by
output gain, where the house standard says level belongs:

| example | before | after |
| --- | --- | --- |
| `wavetable lead` | -24.8 | -15.7 |
| `chords & arps` | -21.2 | -15.2 |
| `acid` | -20.2 | -13.4 |
| `synthscape` | -17.8 | -13.2 |
| `ambient bells` | -17.8 | -13.6 |

Spread is now 6.9 LUFS across the 27 measurable examples, median -13.3, and every edited example's
crest moved by at most 0.1 dB: this raised the level without touching the
dynamics. `synthscape` has four voices and all four were scaled by the same
factor, because raising one would have remixed the piece.

Three rules learned doing it, all measured:

- **Gain is INERT above the normalizer.** The mix stage scales any peak over
  0.89 back down, so for an example already at -1 dBFS peak (13 of them, now
  named in the `norm` column) raising output gain changes the render by 0.1 dB.
  Worse than inert: raising ONE part past the ceiling pulls every other part
  down instead, so the edit reads as backwards. The app now says so on a
  bounce, on stems, on a resampled take and in the loudness readout. `waltz` sits at -16.1 LUFS
  because it is sparse and dynamic, not because it is quiet, and no gain edit
  will move it. Compression would, at the cost of what it is.
- **A sample-dependent example cannot be judged until it renders.** `chop`,
  `sampler` and `granular` were excluded from the first pass because their
  loudest voice was missing; with the bank loaded, `granular` turned out to be
  the quietest example of all at -24.1 LUFS, invisible behind the silence. It
  is now -16.2, `chop` -15.8 and `sampler` -14.5. An example you cannot
  measure is not an example that is fine.
- **Headroom caps the trim.** `wavetable lead` needed +11.8 dB to reach the
  median and had 10.8 before the normalizer, so it landed at -15.7 rather than
  -13. Sparse material simply does not reach the same loudness without
  squashing it.

## A trap this sweep found

`render-example.ts` was not forwarding send buses, so a program's shared
reverb or delay simply did not exist in the file it wrote. On `club` that moved
the spectral centroid from 265 Hz to 315 Hz — the missing tail, measurable
rather than a matter of opinion. `render-local.ts` had always passed them. Both
scripts now do.
