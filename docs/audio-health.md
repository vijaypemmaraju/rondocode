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

## Silence that is not a defect

A headless render has no sample bank and no input device, so `sample()`,
`granular()`, `mic()` and `sing()` voices are digital zero here. That is the
renderer's limit, not the example's, so those are reported as `needs samples` /
`needs the live mic` rather than flagged. Calling them broken would train you
to ignore the output, which is how a real failure gets missed.

The scripts say so out loud now. Rendering the `granular` example prints:

```
note: this program plays sample(s) pad — a headless render has no sample bank,
so those voices are silent here.
WARNING: the render is SILENT (digital zero). The .wav was still written.
```

Before this it reported `wrote out.wav` with every appearance of success.

## What "healthy" means

| measure | want | why |
| --- | --- | --- |
| peak | -20 to -0.5 dBFS | quieter is inaudible beside the others; hotter distorts (the mix stage clamps at 0.89) |
| crest | 4 to 18 dB | under 4 reads as over-compressed, over 18 as unmixed or very sparse |
| NaN / clipped | never | the graph's math blew up, or the bounce will distort |
| silent | only when it needs an input the renderer lacks | otherwise a voice is dead |

## The baseline

29 examples, 8 cycles each, 48 kHz, through the offline mix (sidechain, send
buses and master glue included). Every one healthy or explained:

```
example             peak    LUFS  crest  centroid  notes
acid                -1.7   -13.4   13.9     366Hz
visuals               -1   -13.2   13.9     348Hz
techno              -1.3    -9.5    7.6     202Hz
dubstep               -1   -12.8   11.5     533Hz
trance                -1     -10    8.5     150Hz
future bass           -1    -9.3    9.1    1141Hz
ambient bells       -1.8   -13.6   17.9     706Hz
drum groove         -1.2   -13.3   12.3     332Hz
fm keys             -1.4   -11.4   12.4     437Hz
fm presets            -1   -12.1   15.1    1696Hz
chiptune              -1   -15.2   14.7     381Hz
chords & arps       -1.2   -15.2   16.4     477Hz
over a chord          -1   -13.3   14.3     354Hz
generative            -1   -12.7   13.4     379Hz
edm                   -1     -13   13.2     551Hz
synthscape          -1.3   -13.2   12.5     153Hz
arrangement         -3.1   -13.6   12.6    2144Hz
sampler             -6.3   -15.7    9.5      55Hz  needs samples: vox, riser
granular         -Infinity -Infinity      0       0Hz  needs samples: pad
singing               -1   -13.9   13.2     264Hz  needs samples: singclipnl0399
wobble              -8.3   -14.9    8.7     333Hz
club                -3.4   -12.2   11.3     315Hz
drum machine          -1   -14.4   15.3    1771Hz
polyrhythm            -1   -10.9   11.1     378Hz
live mic         -Infinity -Infinity      0       0Hz  needs the live mic
wavetable lead      -2.8   -15.7   17.5    2699Hz
chop               -15.3   -23.2    7.3      52Hz  needs samples: break
macros                -1   -11.5   11.2     182Hz
waltz                 -1   -16.1   16.1     319Hz
```

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

Spread is now 6.8 LUFS, median unchanged at -13.2, and every edited example's
crest moved by at most 0.1 dB: this raised the level without touching the
dynamics. `synthscape` has four voices and all four were scaled by the same
factor, because raising one would have remixed the piece.

Three rules learned doing it, all measured:

- **Gain is INERT above the normalizer.** The mix stage scales any peak over
  0.89 back down, so for an example already at -1 dBFS peak (half of them)
  raising output gain changes the render by 0.1 dB. `waltz` sits at -16.1 LUFS
  because it is sparse and dynamic, not because it is quiet, and no gain edit
  will move it. Compression would, at the cost of what it is.
- **Sample-dependent examples must be left alone.** `chop` and `sampler` read
  quiet here only because their loudest voice is a sample that a headless
  render has no bank for. Trimming them to hit a number would make them too
  loud in the app, where the sample does play.
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
