# @rondocode/desktop

The same app, in a native window, with the two things a browser will not give it.

## Why it exists

**Local files.** Open and save real `.rondo` / `.js` files through the system's own
picker, and write renders straight into a folder you choose. In the browser a
project lives in IndexedDB and leaves through a download.

**A virtual MIDI port.** This is the DAW integration. WebMIDI can only open ports
that already exist, so in a browser rondocode can drive hardware but cannot *be*
an instrument. The desktop shell publishes a CoreMIDI source named `rondocode`,
so Ableton, Logic and Bitwig list it beside real hardware — arm a track and
record what you are live-coding, with no IAC bus to configure and no loopback
driver to install.

## Running it

```sh
pnpm --filter @rondocode/desktop dev     # cargo tauri dev (boots the vite server)
pnpm --filter @rondocode/desktop build   # a .app + .dmg
pnpm --filter @rondocode/desktop test    # exercises CoreMIDI for real
```

The frontend is `packages/app` unchanged — `tauri.conf.json` points at its dev
server in development and its `dist/` in a build, so there is one UI codebase.

## Shape

| file | what it holds |
| --- | --- |
| `src-tauri/src/main.rs` | command surface, and nothing else |
| `src-tauri/src/files.rs` | open/save/render-folder, dialogs via `osascript` |
| `src-tauri/src/midi.rs` | the CoreMIDI virtual source (direct FFI) |
| `packages/app/src/desktop/bridge.ts` | the app's side; returns null in a browser |

## Two deliberate choices

**Dialogs shell out to `osascript`** instead of pulling a dialog crate. It is the
system's own picker, so it honours sandbox grants and recent places like any
other app, and it keeps this package buildable from a cold offline registry.

**CoreMIDI is bound directly** rather than through `midir`. The surface is four
exported symbols, and `MIDIPacketListInit`/`Add` do the packet layout — that
struct's packing has differed across Apple architectures, and hand-laying it out
yields corrupt timestamps rather than a compile error.

Both keep the dependency list at tauri + serde + core-foundation.

## Not done yet

- Windows and Linux. The file layer is `std::fs` and portable; the dialogs
  (`osascript`) and the MIDI port (CoreMIDI) are macOS-only and need a
  per-platform implementation behind the same commands.
- Wiring the app's own UI to these commands (a File menu, a "record to DAW"
  toggle). The bridge is in place and typed; nothing calls it yet.
- Audio to the DAW still needs a loopback device (BlackHole, Loopback). Sending
  audio as well as MIDI would mean a real audio host, which is a much larger job
  than this shell.
