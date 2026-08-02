# @rondocode/desktop

The same app, in a native window, with the two things a browser will not give it.

## Why it exists

**Local files.** A WORKSPACE folder is the project list: every `.rondo` / `.js`
file in it is a project. Git works on it, other editors work on it, and there is
nothing to import or export. The browser keeps projects in IndexedDB because it
has nowhere else to put them; carrying that model onto the desktop would mean a
second source of truth sitting beside the real one.

The listing is flat and skips dotfiles on purpose: a workspace is a folder of
tunes, and walking into `node_modules` or `.git` would turn the library into
noise. Delete moves a file to the Trash rather than unlinking it, so a mis-click
is recoverable in Finder.

The **extension is the language**, and it is the only place that fact is
recorded — a workspace file has no database row behind it. So the editor's
language toggle *moves the file*: flip a `.js` project to rondo and it becomes
`tune.rondo` on disk (`set_workspace_ext`). Without that, the next open would
hand rondo source to the JavaScript evaluator. A toggle that would collide with
an existing file of the other extension is refused rather than clobbering it.

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
- Running inside a DAW as a plugin. The port makes rondocode a MIDI *device*;
  a VST3/CLAP would make it an instrument the host renders. That needs the DSP
  in native code — see "Why not a plugin" below.
- Audio to the DAW still needs a loopback device (BlackHole, Loopback). Sending
  audio as well as MIDI would mean a real audio host, which is a much larger job
  than this shell.

## Signed + notarized builds

`cargo tauri build` signs automatically: the identity, hardened runtime and
entitlements live in `tauri.conf.json`, so a plain build already produces a
`.app` and `.dmg` signed by **Developer ID Application (VBU344XYXP)** with a
full Apple chain.

The entitlements are not boilerplate — each one is load-bearing:

| entitlement | why the app dies without it |
| --- | --- |
| `cs.allow-jit` | WKWebView runs JavaScriptCore's JIT; the hardened runtime kills the web view rather than degrading |
| `cs.allow-unsigned-executable-memory` | the DSP engine and the voice models are WebAssembly, which maps executable pages |
| `device.audio-input` | `mic()` is a first-class signal |
| `network.client` | `sing()` downloads its models once |

`Info.plist` carries `NSMicrophoneUsageDescription` for the same reason: without
a purpose string macOS **terminates** the app when `mic()` asks, instead of
prompting.

### Notarizing

Signing is done; notarization needs App Store Connect credentials, which the
build reads from the environment:

```sh
export APPLE_API_KEY=28923WS4P9                                  # key id
export APPLE_API_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_28923WS4P9.p8
export APPLE_API_ISSUER=<issuer uuid from App Store Connect>     # the missing piece
cargo tauri build
```

The issuer UUID lives in App Store Connect under *Users and Access →
Integrations → App Store Connect API*; it is not derivable from the key file.
Without those three, `tauri build` prints "skipping app notarization" and still
emits a correctly signed bundle — which Gatekeeper reports as
`rejected / source=Unnotarized Developer ID` until stapled.

Verify a finished build with:

```sh
codesign --verify --deep --strict --verbose=2 rondocode.app
spctl -a -vvv -t install rondocode.app     # "accepted" once notarized
```
