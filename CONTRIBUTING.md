# Contributing to rondocode

Thanks for your interest in improving rondocode! This is a from-scratch
live-coding synth + pattern instrument, and contributions of all sizes are
welcome — bug fixes, new DSP nodes, examples, docs, and ideas.

## Getting started

```sh
pnpm install
pnpm dev        # dev server on http://localhost:6060
pnpm test       # the full vitest suite
```

Type-check a package with `pnpm --filter @rondocode/app exec tsc --noEmit`.
**Don't run `tsc -b`** — it emits `.js` into `src/` and vite then loads the
stale `.js` over the `.ts`. Always use `tsc --noEmit`.

## Ground rules

- **Tests pass.** Run `pnpm test` before opening a PR; add tests for new
  behavior. The pattern engine, DSP kernels, examples and docs all have
  coverage — new DSL names must be documented (`docs.test.ts` pins the docs
  reference bidirectionally against the live scope).
- **Match the surrounding style.** Small, focused commits; comments explain
  *why*, not *what*. Prefer the dedicated code over pulling in a dependency —
  the DSP engine, SMF parser, etc. are all hand-written on purpose.
- **No copyrighted content.** Example tunes must be original compositions (or
  clearly licensed) — do not add transcriptions of copyrighted songs.
- **Keep it self-contained.** The app runs with no backend; features should
  degrade gracefully offline.

## Pull requests

1. Fork and branch from `main`.
2. Make your change with tests and a clear description of the musical/behavioral
   effect.
3. Ensure `pnpm test` and type-checks are green (CI runs both).
4. Open the PR — describe what it changes and, for audio/visual changes, how to
   hear/see it.

## Reporting bugs

Open an issue with steps to reproduce, the rondocode snippet involved, your
browser/OS, and what you expected vs. heard.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
