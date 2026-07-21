# rondocode

Live-codeable synths and mini-notation patterns, in the browser. You write two
kinds of code. **Synths** are functions that wire oscillators, filters and
envelopes into a sound. **Patterns** are mini-notation sequences that trigger
those synths in time. A custom AudioWorklet DSP engine runs it all; nothing is
sampled unless you load a sample.

## Monorepo layout

pnpm workspace, TypeScript throughout. Packages import each other by name
(`@rondocode/pattern`, resolved to `src/` via workspace symlinks).

| Package | What it is |
| --- | --- |
| `@rondocode/pattern` | Pure pattern engine: `Pattern`/`Hap`/`TimeSpan`/`Fraction`, mini-notation parser, combinators, scales, chords, the scheduler, and the **MIDI importer** (`src/midi.ts`). No audio, no DOM. |
| `@rondocode/engine` | The DSP: oscillators, filters, envelopes, effects, the `synth()` builder, offline render, WAV encode. |
| `@rondocode/app` | The browser app: CodeMirror editor, the live audio session, the docs panel, the built-in examples (`src/examples/index.ts`). |
| `@rondocode/server` | Headless/bridge tooling and dev scripts. |

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

## The DSL

Everything you can write in an example is documented in-app (the docs panel) and
in `packages/app/src/docs/`:

- `dsl-docs.ts`, the reference: every scope global, `Pattern` method, synth-ctx
  member, `Sig` method and mini-notation operator. It is **coverage-pinned**:
  `test/docs.test.ts` checks it bidirectionally against the live objects
  (`baseScope`, `Pattern.prototype`, a probed `SynthCtx`/`Sig`), so adding a DSL
  name without documenting it (or documenting one that does not exist) fails
  the suite.
- `content.ts`, the hand-written guide: short sections that each end in a
  complete, playable program.

## Rendering examples headless

Render any built-in example to a WAV without a browser:

```sh
pnpm tsx packages/server/scripts/render-example.ts "veldt (full)" 52 out.wav
#                                                   <name>       <cycles> <out>
```

## Importing MIDI

`packages/pattern/src/midi.ts` is a from-scratch Standard-MIDI-File importer.
Tempo, time signature, note timing and the track split all come **from the
file**; none of it is guessed. There are three entry points:

- `parseMidi(bytes)` returns `{ ppq, tempoBpm, timeSig, tracks }` with exact-tick
  notes (handles running status, VLQs, tempo/time-sig meta, velocity-0
  note-offs, channel-10 drums).
- `midiNotesToPattern(notes, ppq, timeSig)` returns a **lossless** runtime
  `Pattern<ControlMap>`: exact fractional cycle timing, and a note can sustain
  across bar lines.
- `midiNotesToVoices(notes, ppq, timeSig, opts)` returns **editable**
  mini-notation: grid-quantized, held notes via `@` weights, polyphony split
  into stacked monophonic voice-lines.

Turn a `.mid` into a complete, editable example with the CLI:

```sh
pnpm tsx packages/server/scripts/midi-to-rondocode.ts song.mid "my song" out.txt
#   options:
#   --by-register   ignore (flaky) track labels; group notes by pitch into
#                   bass / keys / lead so parts play continuously. Use this
#                   for noisy transcriptions where instrument labels flicker.
#   --steps=N       grid resolution in steps per beat (default 4 = 1/16)
```

It picks a synth per track (from the track name, then the GM program), splits
drums by GM percussion pitch, derives `setCps` from the tempo, adds a sidechain
pump + master glue, and prints an example you can paste into the editor. 1 cycle
= 1 bar throughout. For a clean DAW MIDI the default one-synth-per-track is
faithful; `--by-register` is the robust fallback for messy transcriptions.

`midiToRondocode(bytes, opts)` in `packages/app/src/midi/import.ts` is the same
converter as a library function, ready to back an in-app "import MIDI" action.

## Inspiration

rondocode's pattern model (cycle-based patterns and the terse mini-notation)
follows in the lineage of [TidalCycles](https://tidalcycles.org) and
[Strudel](https://strudel.cc). The pattern engine, DSP, editor, and everything
else here are written from scratch, with no Tidal or `@strudel/*` dependency;
where a behavior matches theirs it's for parity, noted in the code.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
workflow and ground rules, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Example tunes must be original compositions (no transcriptions of copyrighted
songs).

## License

[MIT](LICENSE) © Vijay Pemmaraju.
