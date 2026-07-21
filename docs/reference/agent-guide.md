# rondocode agent guide

You are connected to **rondocode**: a live-coding music system running in a
browser. A human may be listening (and playing) right now. This guide explains
how the system fits together and how to work it through the MCP tools.

Read `rondocode://docs/dsl-reference` for the full language surface and
`rondocode://docs/examples` for five complete, known-working programs.

## How the system fits together

```
you (MCP client) ── stdio ──> mcp server ── ws :6070 ──> browser app
                                                          ├─ Session (the live program)
                                                          ├─ editor (the human's text)
                                                          └─ audio engine (WebAudio worklet)
```

- The **browser app** hosts the **live** session — the sound the human hears
  right now. The *live* tools (`get_code`, `eval_code`, `set_param`,
  `set_channel`, `transport`, `get_state`) need a browser tab open; without one
  they return `no browser session connected — open the rondocode app`, which a
  human must fix by opening (or refreshing) the app page.
- The **render tools** (`render_code`, `render_synth`, `compare_renders`) need
  **no browser** — they evaluate and render your code offline in the MCP server
  itself and hand back analysis + a WAV file. Use them to *hear* your work
  before (or without) going live. See "Hearing without a browser" below.
- The **Session** is the live program state: registered synths, registered
  patterns, tempo, transport. Your tools talk to it.
- A program is a single JavaScript-like source text. Evaluating it registers:
  - **Synths** — instruments. `synth(ctx => ...)` builds a per-voice DSP graph
    (oscillators, filters, envelopes) from the context members; assigning it to
    a top-level `const acid = synth(...)` registers it under that name.
  - **Patterns** — what plays. `p('bass', n('0 3 5 7').scale('a minor').sound('acid'))`
    registers a pattern named `bass`. Pattern strings use **mini-notation**
    (`'0 3 [5 7] ~'`) and chainable combinators (`.fast`, `.every`, `.euclid`,
    `.gain`, `.ctrl`, ...).
  - **Tempo** — `setCps(0.5)` sets cycles per second (with 4 beats per cycle,
    0.5 cps = 120 bpm).

## Eval semantics — the rules that matter

`eval_code` evaluates a **whole program**, not a diff:

1. **Each eval replaces everything.** The set of synths and patterns after an
   eval is exactly the set the source registers. A pattern you omit stops
   playing; a synth you omit is removed. So: `get_code` first, then send the
   full modified program.
2. **Last-good-version contract.** If the eval fails (`ok: false`), *nothing
   changes* — the previous program keeps playing untouched, and the result's
   `diagnostics` tell you why (1-based `line`/`col`, `message`, `severity`).
   Failure is always safe; sound never stops because you sent broken code.
3. **All-or-nothing staging.** Even if a failing eval got halfway through
   (registered two patterns, then threw), none of it applies.
4. **Unchanged synths keep their voices.** Re-evaluating an identical synth
   definition does not cut its sound — diffing is by graph content, so you can
   re-send the whole program freely while tweaking one part.
5. Registration is synchronous only: `p()`/`defineSynth()`/`setCps()` called
   from a timer or promise throws.

### Known v1 limitation: your code does not appear in the human's editor

`eval_code` evaluates into the live **Session**, but the text in the human's
editor is a separate document and is *not* rewritten. Consequences:

- The human hears your changes but does not see them in their editor.
- If the human presses run, **their** text evaluates and replaces your program
  entirely (whole-program semantics, rule 1 above).
- `get_code` returns the Session's truth: `code` is the last successfully
  applied source (possibly yours), `lastAttempted` the last one tried (theirs
  or yours, even if it failed). Use it to detect that the human has taken over.

Treat the session as shared and last-writer-wins. When collaborating with an
active human, prefer the non-destructive tools (`set_param`, `set_channel`,
`transport`) or tell the human what code to paste.

## Typical workflow

1. `get_state` — is a browser connected? what's already registered? playing?
2. Read `rondocode://docs/dsl-reference` (and examples) if you haven't.
3. `get_code` — see the current program.
4. `eval_code` with a complete program: synth definitions + `p(...)` patterns
   + `setCps(...)`. Check `ok` and `diagnostics` in the result.
5. `transport {action: 'play'}` — nothing sounds until the transport plays.
   (`play` restarts from cycle 0; `stop` halts and silences all notes.)
6. Iterate: tweak and re-`eval_code` (hot-swaps on the next scheduler tick),
   or for continuous parameter moves use `set_param` — instant valued changes
   to any `param(...)` a synth declared, no re-eval, optional `rampMs` glide.
   `set_channel` sets a synth's mixer gain (0..1) / pan (0..1).
7. `get_diagnostics` after things have been playing — runtime errors
   (`source: 'scheduler'` or `'engine'`) happen after eval, e.g. a pattern
   callback that throws mid-playback. They arrive as pushed notifications and
   are cached with `ageMs`; eval-time errors you already saw in `eval_code`'s
   own result.

## Hearing without a browser

The render tools evaluate your program offline (a virtual clock drives the real
scheduler and DSP engine) and return **analysis** so you can judge the sound
without ears — plus a WAV a human can play. They work whether or not a browser
is connected, and are **deterministic**: the same code always yields the same
analysis.

- `render_code {code, cycles?, cps?}` — render a whole program a few cycles and
  get back `analysis` (rms, peak, `spectralCentroidHz` = brightness,
  `spectralRolloffHz`, `spectralFlatness` = noisiness, `lowMidHigh` energy
  split, `stereoWidth`, `clipped`, `attackTimeMs`), `perSynth` event counts and
  levels, and a `wavPath`.
- `render_synth {code, synthName?, note?, durationSec?}` — audition one synth on
  a single note. Fast way to dial in a patch.
- `compare_renders {codeA, codeB, cycles?}` — render two versions and return the
  **delta** of each analysis field (b − a). This is the "did my change do what I
  intended?" tool: raise a cutoff and confirm `spectralCentroidHz` went up.

**Recommended workflow**: `render_code` (or `render_synth`) to confirm your
program actually sounds — non-silent rms, sane centroid, not `clipped` — *then*
`eval_code` to put it live. Reading the analysis is how you iterate on sound
design when you can't hear the audio yourself.

Note: `wavPath` is a path on the **server's** filesystem (also mirrored to the
human's listening folder). You cannot fetch its bytes over MCP — it exists so
the human can play the file. Judge the sound from the `analysis`, not the WAV.

### Trust model

The render tools execute the code you supply inside the local Node process
(`new Function`) — exactly the same trust boundary as the browser's eval: it is
the user's own machine running the user's own agent. This is a **namespace, not
a security sandbox**. Do not treat it as isolation.

## Reading diagnostics

Each diagnostic: `{ line, col, message, severity: 'error' | 'warning',
source: 'eval' | 'scheduler' | 'engine' }` (line/col are 1-based positions in
the evaluated source).

- `eval` — parse or execution failure of the source you sent. Fix and re-send.
- `scheduler` — a pattern threw while being queried during playback (often a
  bad value fed to a combinator). The program is live but that pattern is
  misbehaving; runtime diagnostics clear on your next successful eval.
- `engine` — the audio thread reported an error.
- Warnings don't block: `ok: true` with warnings means the program applied.
  A common one is a bare `synth(...)` expression that was never assigned or
  registered (it makes no sound — assign it to a top-level `const`).

## Small but load-bearing details

- Every audible event needs a **note and a sound**: drums still need
  `note('c2')` (any pitch) as the trigger, and `.sound('kick')` to route it.
- `n('0 3 5')` is *scale degrees* — pair with `.scale('a minor')`.
  `note('c2 e2')` is absolute pitches. `sound('kick hat')` patterns synth
  names directly.
- `set_param` targets params a synth declared via `param('cutoff', 800, ...)`;
  patterns drive the same params per-event via `.ctrl('cutoff', ...)`. A
  pattern that ctrl-patterns a param will keep overwriting your `set_param`
  value on every event.
- Tempo is clamped to 0.05..4 cps. Randomness (`rand`, `perlin`, `irand`,
  `.degradeBy`, `?`) is deterministic per time position — loops repeat exactly.
- A live tool that returns `call '<method>' timed out after 5000ms` means the
  browser session did not answer within 5s (a stalled or slow tab). It is not a
  code error; retry, or ask the human to check the app. Render tools have no
  such dependency.
- `get_diagnostics` serves a server-side cache of pushed `state`/`diagnostics`
  notifications; each entry carries `ageMs`. State pushes arrive after every
  handled call plus a ~2s heartbeat, so a value may be up to a couple seconds
  stale. If no browser has ever connected, the cache is empty.
