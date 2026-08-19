# Notices and attributions

rondocode is MIT licensed (see [LICENSE](LICENSE)) and the DSP, the pattern
engine, the MIDI parser and the language are written from scratch rather than
wrapped around a library. "From scratch" is not the same as "from nothing",
though: several kernels implement algorithms that other people published, and
the pattern side follows a model another project invented. This file says
which, because an open-source project that borrows ideas should name them.

No third-party source is vendored in this repository. Everything below is an
independent implementation of a published algorithm or a documented design.

## Signal processing

| what | whose | where it lives |
| --- | --- | --- |
| **Freeverb** -- the Schroeder-Moorer reverb topology (eight parallel combs into four allpasses) and its tuning constants | Jezar at Dreampoint, released to the public domain | `packages/engine/src/dsp/reverb.ts` |
| **Audio EQ Cookbook** biquad coefficient formulas | Robert Bristow-Johnson, published freely for any use | `packages/engine/src/dsp/eq.ts`, and a pinned replica in `packages/app/src/editor/rondo/filtercurve.ts` |
| **TPT state-variable filter** -- the topology-preserving transform SVF with prewarped cutoff | Andrew Simper (Cytomic), published freely | `packages/engine/src/dsp/filters.ts` |
| **Moog ladder** -- the four-one-pole-with-feedback simplification | after the classic Moog design; the linearized transfer function is derived in `packages/app/src/editor/rondo/filtercurve.ts` | `packages/engine/src/dsp/filters.ts` |
| **Karplus-Strong** plucked string | Kevin Karplus and Alex Strong | `packages/engine/src/dsp/physical.ts` |
| **Goertzel** single-bin DFT, used only in tests to measure one frequency | Gerald Goertzel | `packages/engine/test/util/goertzel.ts` |

## Patterns

The pattern engine follows the model **TidalCycles** invented -- a pattern as a
pure function from a time span to events, with the combinator vocabulary that
grows from it -- and the mini-notation dialect that **Strudel** carried to the
browser. Neither project's code is used; the ideas and much of the naming are
theirs, and rondocode would not exist in this shape without them.

- TidalCycles -- Alex McLean and contributors, <https://tidalcycles.org>
- Strudel -- <https://strudel.cc>

The **Bjorklund** algorithm for euclidean rhythms (`packages/pattern/src/euclid.ts`)
implements the construction described by Godfried Toussaint in "The Euclidean
Algorithm Generates Traditional Musical Rhythms", after E. Bjorklund's work on
neutron accelerator timing.

## Singing

The neural singing path DOWNLOADS models at runtime and vendors none of them.
It is off by default and asks before fetching anything.

- **Supertonic** text-to-speech models, fetched from their published
  repository at first use. See `docs/sing-models.md` for what is fetched, from
  where, and how to point it somewhere else.

## Fonts, icons, samples

All icons are hand-drawn SVG paths in `packages/app/src/ui/icons.ts`. The
built-in demo samples are synthesized, not recorded. No third-party font is
bundled; the app uses the system UI font stack.
