# rondocode

Live-codeable synths and mini-notation patterns, in the browser, built to be
played on a phone. You write two kinds of code, **synths** (functions that
wire oscillators, filters and envelopes into a sound) and **patterns**
(mini-notation sequences that trigger those synths in time), in either of two
languages:

- **JavaScript**, the full DSL, and
- **rondo**, a terse phone-first language that transpiles to it. One stage per
  line, signal flowing downward, bindings for modulation. The two are
  round-trip convertible: the editor's language toggle decompiles JavaScript
  back into rondo, and `compile → decompile → compile` returns byte-identical
  JavaScript. Whatever the terse syntax cannot express survives inside a `js`
  block, and the fixed point is fuzz-tested over tens of thousands of
  generated programs.

A custom AudioWorklet DSP engine runs it all; nothing is sampled unless you
load (or record, or resample) a sample.

**Try it: [rondocode.com](https://rondocode.com)** · the full guide lives at
[/docs](https://rondocode.com/docs) · iOS/Safari audio diagnostics at
[/diag](https://rondocode.com/diag).

## What's in the box

- **The code is the instrument.** Knobs, draggable envelopes, piano rolls,
  step sequencers and euclid rolls render inline in the code; a gesture that
  changes a value rewrites the source, so anything you can touch you can also
  type, undo and share. Numbers scrub by touch, with a hold-to-enlarge lens
  and directional speed tiers (drag up for x10/x100, down for x.1/x.01).
- **Performance lock**: freeze the text mid-jam while every widget stays live.
- **Live mic**: `mic()` / `mic` is the microphone as a signal: vocode your
  voice through a supersaw, live.
- **Singing**: `sing()` bakes neural vocals from lyrics + melody, offline in
  the browser.
- **Visuals**: `visual()` attaches an audio-driven WGSL fragment shader.
- **Custom tunings**: `defineScale()` with floats, cents or ratios; any
  `<n>edo` by name; every mode plus chromatic built in. Fractional midi renders
  true microtones through the engine.
- **Resample to loop**: bounce N cycles of the track into the sample bank as a
  sample-accurate loop (`take1`), then chop it back in.
- **MIDI both ways**: a from-scratch importer (file → editable example) and
  exporter (staged track → format-1 `.mid`, pitch-bends for microtonal notes),
  the road to any DAW or MuseScore.
- **Offline render**: bounce to WAV or to per-synth stems, headless or in-app.
  The bounce runs the same DSP kernels as the live engine and mirrors its mix
  stage (sidechain duck, master glue) using the same coefficients, rather than
  driving the realtime engine itself. A mix peaking above 0.89 is scaled down
  to it, so a bounce is not always sample-identical to what you just heard.
  Pure synthesis reproduces run to run; a render containing `sing()` depends on
  neural inference and is not bit-reproducible across machines.

## Why another live-coding system?

[TidalCycles](https://tidalcycles.org), [Strudel](https://strudel.cc) and
[Gibber](https://gibber.cc) already exist and are excellent. If you live-code
on a laptop and love them, keep them. rondocode exists because of three bets
they are not making:

1. **Phone-first is a design center, not a breakpoint.** Not "the editor
   also renders on mobile", but: a language with no brackets, backticks or
   arrows to hunt for on a software keyboard; a tap palette that only offers
   grammatically legal next tokens; degree chips that sound as they write;
   inline knobs, envelopes, step sequencers and piano rolls sized for thumbs;
   press-hold value lenses with precision tiers; a performance lock so a
   stray finger cannot wreck a live set. The bet: the instrument most people
   actually carry is a phone.
2. **Synthesis-first, not sample-first.** The pattern side follows the Tidal
   lineage, but the sound side is a from-scratch signal-graph DSP engine you
   program in the same breath: subtractive, FM, physical modeling, supersaw
   stacks, vocoder, per-voice envelopes, shared post-chains, sidechain and
   master glue, all as code. Samples are one source among many (load one,
   record one on the mic, or resample your own track), not the foundation.
3. **The text and the controls are the same thing.** A widget gesture that
   changes a value rewrites the source (a few views, like the multi-bar clip
   overview and the unison fan, are there to be read rather than dragged); the
   source is always the whole truth, so anything you can touch you can also
   type, undo, diff and share. Most controls read the source rather than the
   language, so they work in **both**: a dial, an envelope, a breakpoint shape,
   a step grid, a filter response curve and a tap-to-cycle enum all appear over
   JavaScript as readily as over rondo, writing back inside the string or array
   literal they came from.
   A differential test compiles a rondo program and requires both scanners to
   find the same widgets, so those cannot quietly drift. The newest two — the
   compressor transfer curve and the sidechain duck envelope — are rondo-only
   so far, and the same test names them rather than leaving the gap unstated.
   The two languages convert both ways: the editor
   decompiles JavaScript into rondo, and whatever the terse syntax cannot
   express is preserved verbatim inside a `js` block, so nothing is lost on the
   way in and choosing rondo never locks you out of the full API. The
   round-trip is a tested fixed point: compile rondo to JavaScript, decompile
   that back to rondo, compile again, and the JavaScript matches byte for byte.

A few things here are unusual for a live-coding environment: on-device neural
singing from lyrics plus a melody, the live microphone as a signal you can
vocode or granulate, and custom temperaments written in cents or frequency
ratios. Plenty of what is here exists elsewhere too, MIDI in and out included,
so treat this as a description of the toolkit rather than a claim about the
field.

So yes: if you want a one-line answer, "compose real tracks on your phone,
with synths you designed" is the value proposition. The rest of this README
is the evidence.

## Monorepo layout

pnpm workspace, TypeScript throughout. Packages import each other by name
(`@rondocode/pattern`, resolved to `src/` via workspace symlinks).

| Package | What it is |
| --- | --- |
| `@rondocode/pattern` | Pure pattern engine: `Pattern`/`Hap`/`TimeSpan`/`Fraction`, mini-notation parser, combinators, scales + custom tunings, chords, the scheduler, and the **MIDI importer + exporter** (`src/midi.ts`, `src/midiExport.ts`). No audio, no DOM. |
| `@rondocode/engine` | The DSP: oscillators, filters, envelopes, effects, the `synth()` builder, live mic input, offline render, WAV encode. |
| `@rondocode/rondo` | The rondo language: lexer, parser, codegen (rondo → JavaScript), the **decompiler** (JavaScript → rondo), and a property fuzzer that pins the round trip. |
| `@rondocode/app` | The browser app: CodeMirror editor with live widgets, the audio session, the tap palette, onboarding, the docs page, the built-in examples (`src/examples/index.ts`). |
| `@rondocode/server` | Headless/bridge tooling: the MCP server, offline render runner, dev scripts. |

## Develop

```sh
pnpm install
pnpm dev        # vite dev server on http://localhost:6060
pnpm test       # the whole vitest suite
pnpm test:watch # watch mode
```

Type-check with `pnpm --filter @rondocode/app exec tsc --noEmit` (or per package).
**Do not run `tsc -b`** in this repo: it emits `.js` into `src/` and vite then
loads the stale `.js` over the `.ts`. Always use `tsc --noEmit`.

Fuzz the rondo compiler/decompiler round trip beyond the CI seeds:

```sh
pnpm tsx packages/rondo/scripts/fuzz.ts 100000
```

## The DSL

Everything you can write is documented in-app (the docs panel and the full
docs page) and in `packages/app/src/docs/`:

- `dsl-docs.ts`, the reference: every scope global, `Pattern` method, synth-ctx
  member, `Sig` method and mini-notation operator. It is **coverage-pinned**:
  `test/docs.test.ts` checks it bidirectionally against the live objects
  (`baseScope`, `Pattern.prototype`, a probed `SynthCtx`/`Sig`), so adding a DSL
  name without documenting it (or documenting one that does not exist) fails
  the suite.
- `content.ts`, the hand-written guide: short sections that each end in a
  complete, playable program, including the rondo language guide.

The rondo language keeps **full parity** with the JavaScript API: everything
the DSL can say, rondo can say (a scoreboard test enforces it), with `js { }`
escape hatches as the guarantee of last resort.

## Rendering examples headless

Render any built-in example to a WAV without a browser (run it with no
arguments to list the names):

```sh
pnpm tsx packages/server/scripts/render-example.ts "club" 32 out.wav
#                                                   <name>  <cycles> <out>
```

## MIDI

**Import** (`packages/pattern/src/midi.ts`): a from-scratch Standard-MIDI-File
parser. Tempo, time signature, note timing and the track split all come **from
the file**; none of it is guessed.

- `parseMidi(bytes)` returns exact-tick notes (running status, VLQs,
  tempo/time-sig meta, velocity-0 note-offs, channel-10 drums).
- `midiNotesToPattern(...)` returns a **lossless** runtime pattern;
  `midiNotesToVoices(...)` returns **editable** mini-notation (grid-quantized,
  held notes via `@` weights, polyphony split into voice lines).

Turn a `.mid` into a complete, editable example with the CLI:

```sh
pnpm tsx packages/server/scripts/midi-to-rondocode.ts song.mid "my song" out.txt
#   --by-register   group notes by pitch (bass/keys/lead) for noisy transcriptions
#   --steps=N       grid resolution in steps per beat (default 4 = 1/16)
```

**Export** (`packages/pattern/src/midiExport.ts`): the staged track as a
format-1 `.mid` (export popover in the app): one cycle = one bar, a named
track per channel, `.gain` as velocity, pitch-bends for microtonal notes.
Round-trip through the repo's own parser is the correctness anchor.

## Inspiration

rondocode's pattern model (cycle-based patterns and the terse mini-notation)
follows in the lineage of [TidalCycles](https://tidalcycles.org) and
[Strudel](https://strudel.cc). The pattern engine, DSP, editor, rondo language
and everything else here are written from scratch, with no Tidal or
`@strudel/*` dependency; where a behavior matches theirs it's for parity,
noted in the code.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
workflow and ground rules, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Example tunes must be original compositions (no transcriptions of copyrighted
songs).

## License

[MIT](LICENSE) © Vijay Pemmaraju.
