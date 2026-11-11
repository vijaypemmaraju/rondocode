# rondocode agent guide

You are connected to **rondocode**: a live-coding music system running in a
browser. A human may be listening (and playing) right now. This guide explains
how the system fits together and how to work it through the MCP tools.

Read `rondocode://docs/dsl-reference` for the full language surface and
`rondocode://docs/examples` for every shipped program, each one known to eval
clean and play.

## How the system fits together

```
you (MCP client) ── stdio ──> mcp server ── ws :6070 ──> browser app
                                                          ├─ Session (the live program)
                                                          ├─ editor (the human's text)
                                                          └─ audio engine (WebAudio worklet)
```

- The **browser app** hosts the **live** session -- the sound the human hears
  right now. The *live* tools (`get_code`, `eval_code`, `set_param`,
  `set_channel`, `transport`, `get_state`) need a browser tab open; without one
  they return an error beginning `no browser session connected`, which a human
  must fix by opening (or refreshing) the app page.
- The **render tools** (`render_code`, `render_synth`, `compare_renders`) need
  **no browser** -- they evaluate and render your code offline in the MCP server
  itself and hand back analysis + a WAV file. Use them to *hear* your work
  before (or without) going live. See "Hearing without a browser" below.
- The **Session** is the live program state: registered synths, registered
  patterns, tempo, transport. Your tools talk to it.
- A program is a single JavaScript-like source text. Evaluating it registers:
  - **Synths** -- instruments. `synth(ctx => ...)` builds a per-voice DSP graph
    (oscillators, filters, envelopes) from the context members; assigning it to
    a top-level `const acid = synth(...)` registers it under that name.
  - **Patterns** -- what plays. `p('bass', n('0 3 5 7').scale('a minor').sound('acid'))`
    registers a pattern named `bass`. Pattern strings use **mini-notation**
    (`'0 3 [5 7] ~'`) and chainable combinators (`.fast`, `.every`, `.euclid`,
    `.gain`, `.ctrl`, ...).
  - **Tempo** -- `setCps(0.5)` sets cycles per second, and `setBpm(120)` is the
    same slot in the unit you count in. One cycle is one BAR, so the two are
    related by how many quarter notes a bar holds: four by default, hence
    0.5 cps = 120 bpm. `setTimeSig(3, 4)` changes that -- under it a bar is
    three quarters, so the same 120 bpm is 0.667 cps. The last tempo call in a
    program wins, and it resolves against the meter whichever order they
    appear in.

## Eval semantics -- the rules that matter

`eval_code` evaluates a **whole program**, not a diff:

1. **Each eval replaces everything.** The set of synths and patterns after an
   eval is exactly the set the source registers. A pattern you omit stops
   playing; a synth you omit is removed. So: `get_code` first, then send the
   full modified program.
2. **Last-good-version contract.** If the eval fails (`ok: false`), *nothing
   changes* -- the previous program keeps playing untouched, and the result's
   `diagnostics` tell you why (1-based `line`/`col`, `message`, `severity`).
   Failure is always safe; sound never stops because you sent broken code.
3. **All-or-nothing staging.** Even if a failing eval got halfway through
   (registered two patterns, then threw), none of it applies.
4. **Unchanged synths keep their voices.** Re-evaluating an identical synth
   definition does not cut its sound -- diffing is by graph content, so you can
   re-send the whole program freely while tweaking one part.
5. Registration is synchronous only: `p()`/`defineSynth()`/`setCps()` called
   from a timer or promise throws.

### Into the editor, or around it

`eval_code` with only `code` evaluates JavaScript into the live **Session**.
The text in the human's editor is a separate document and is *not* rewritten:

- The human hears your changes but does not see them in their editor.
- If the human presses run, **their** text evaluates and replaces your program
  entirely (whole-program semantics, rule 1 above).

Pass `lang` (`'rondo'` or `'rondocode'`) and the eval goes THROUGH the editor
instead: your source becomes the editor's text in that language and evaluates
on the same path as their Run button. They see the program, and every knob,
slider and macro in it is theirs to move. This is the path to prefer when a
human is watching, and the only way to send rondo.

Once a program is in the editor, iterate with `edit_code`: a list of
`{ old, new }` find-and-replace edits applied to the editor text and then
evaluated. Each `old` must match exactly once; if any edit misses, nothing is
written. Change one line, hear it, change the next.

`get_code` returns both truths: `code` is the last successfully applied
JavaScript, `lastAttempted` the last source tried, and `editor` the editor's
text and language, which includes any value the human has dragged since.

### Macros, eased

`set_macro {name, value, rampMs?}` moves a project-wide macro on every synth
that reads it, and `rampMs` glides there instead of jumping. One call with a
long ramp is a build. While it glides, the macro's number in the editor follows
it, so the human sees the dial move and the next eval starts from where the
sound already is. It answers `{ ok, sites }`: `sites` is how many synths it
reached, and `ok` is false when that is zero.

A design that never cuts: give every part its own macro as a level
(`* thump` at the end of the kick's chain), leave every pattern playing, and
perform the arrangement with ramps. Nothing is switched, so nothing can click.

### Landing on the bar

Your calls arrive whenever your tool call happens to, which is never on a bar
line. `eval_code`, `edit_code` and `set_macro` take `quantize: N`: the call is
held in the browser and lands on the next cycle that is a multiple of N (1 is
the next bar, 8 the next eight-bar phrase). The reply comes back when it has
landed and carries `measure`. A program swap is applied 150 ms early, because
the scheduler queues notes about 100 ms ahead and a swap made on the boundary
would miss its own downbeat. While the transport is stopped there is no
boundary, and the call applies at once.

`get_state` reports `position` while playing: the measure the transport is in
and `phase`, how far through that bar it is.

## Typical workflow

1. `get_state` -- is a browser connected? what's already registered? playing?
2. Read `rondocode://docs/dsl-reference` (and examples) if you haven't.
3. `get_code` -- see the current program.
4. `eval_code` with a complete program: synth definitions + `p(...)` patterns
   + `setCps(...)`. Check `ok` and `diagnostics` in the result.
5. `transport {action: 'play'}` -- nothing sounds until the transport plays.
   (`play` restarts from cycle 0; `stop` halts and silences all notes.)
6. Iterate: tweak and re-`eval_code` (hot-swaps on the next scheduler tick),
   or for continuous parameter moves use `set_param` -- instant valued changes
   to any `param(...)` a synth declared, no re-eval, optional `rampMs` glide.
   `set_channel` sets a synth's mixer gain (0..1) / pan (0..1).
7. `get_diagnostics` after things have been playing -- runtime errors
   (`source: 'scheduler'` or `'engine'`) happen after eval, e.g. a pattern
   callback that throws mid-playback. They arrive as pushed notifications and
   are cached with `ageMs`; eval-time errors you already saw in `eval_code`'s
   own result.

## Hearing without a browser

The render tools evaluate your program offline (a virtual clock drives the real
scheduler and DSP engine) and return **analysis** so you can judge the sound
without ears -- plus a WAV a human can play. They work whether or not a browser
is connected, and are **deterministic**: the same code always yields the same
analysis.

- `render_code {code, cycles?, cps?}` -- render a whole program a few cycles and
  get back `analysis` (rms, peak, `spectralCentroidHz` = brightness,
  `spectralRolloffHz`, `spectralFlatness` = noisiness, `lowMidHigh` energy
  split, `stereoWidth`, `clipped`, `attackTimeMs`), `perSynth` event counts and
  levels, and a `wavPath`.
- `render_synth {code, synthName?, note?, durationSec?}` -- audition one synth on
  a single note. Fast way to dial in a patch.
- `compare_renders {codeA, codeB, cycles?}` -- render two versions and return the
  **delta** of each analysis field (b − a). This is the "did my change do what I
  intended?" tool: raise a cutoff and confirm `spectralCentroidHz` went up.

**Recommended workflow**: `render_code` (or `render_synth`) to confirm your
program actually sounds -- non-silent rms, sane centroid, not `clipped` -- *then*
`eval_code` to put it live. Reading the analysis is how you iterate on sound
design when you can't hear the audio yourself.

Note: `wavPath` is a path on the **server's** filesystem (also mirrored to the
human's listening folder). You cannot fetch its bytes over MCP -- it exists so
the human can play the file. Judge the sound from the `analysis`, not the WAV.

### Trust model

The render tools execute the code you supply inside the local Node process
(`new Function`) -- exactly the same trust boundary as the browser's eval: it is
the user's own machine running the user's own agent. This is a **namespace, not
a security sandbox**. Do not treat it as isolation.

## Reading diagnostics

Each diagnostic: `{ line, col, message, severity: 'error' | 'warning',
source: 'eval' | 'scheduler' | 'engine' }` (line/col are 1-based positions in
the evaluated source).

- `eval` -- parse or execution failure of the source you sent. Fix and re-send.
- `scheduler` -- a pattern threw while being queried during playback (often a
  bad value fed to a combinator). The program is live but that pattern is
  misbehaving; runtime diagnostics clear on your next successful eval.
- `engine` -- the audio thread reported an error.
- Warnings don't block: `ok: true` with warnings means the program applied.
  A common one is a bare `synth(...)` expression that was never assigned or
  registered (it makes no sound -- assign it to a top-level `const`).

## Small but load-bearing details

- Every audible event needs a **note and a sound**: drums still need
  `note('c2')` (any pitch) as the trigger, and `.sound('kick')` to route it.
- `n('0 3 5')` is *scale degrees* -- pair with `.scale('a minor')`.
  `note('c2 e2')` is absolute pitches. `sound('kick hat')` patterns synth
  names directly.
- `set_param` targets params a synth declared via `param('cutoff', 800, ...)`;
  patterns drive the same params per-event via `.ctrl('cutoff', ...)`. A
  pattern that ctrl-patterns a param will keep overwriting your `set_param`
  value on every event.
- Tempo is clamped to 0.05..4 cps. Randomness (`rand`, `perlin`, `irand`,
  `.degradeBy`, `?`) is deterministic per time position -- loops repeat exactly.
- A live tool that returns `call '<method>' timed out after 5000ms` means the
  browser session did not answer within 5s (a stalled or slow tab). It is not a
  code error; retry, or ask the human to check the app. Render tools have no
  such dependency.
- `get_diagnostics` serves a server-side cache of pushed `state`/`diagnostics`
  notifications; each entry carries `ageMs`. State pushes arrive after every
  handled call plus a ~2s heartbeat, so a value may be up to a couple seconds
  stale. If no browser has ever connected, the cache is empty.
