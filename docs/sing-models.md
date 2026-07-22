# Hosting the singing models

`sing()` runs a neural voice pipeline entirely in the browser (on-device, WebGPU
with a WASM fallback). It needs several large ONNX models. In production they're
fetched from HuggingFace and cached in the browser's Cache API — a one-time
download per visitor, then offline.

## What needs hosting

The **Supertonic TTS** models are already public (`Supertone/supertonic-3`) and
load automatically. You only need to host the phoneme + voice-conversion models:

| file | ~size | what it is |
|------|-------|------------|
| `phoneme.onnx` | ~1.2 GB (fp32) | wav2vec2 CTC — forced-aligns lyrics to the TTS audio |
| `vec-768.onnx` | ~378 MB | ContentVec encoder (shared by all voices) |
| `gen_kizuna.onnx` | ~112 MB | RVC generator — voice "kizuna" |
| `gen_barbara.onnx` | ~112 MB | RVC generator — voice "barbara" |
| `gen_rise.onnx` | ~112 MB | RVC generator — voice "rise" |

These are hosted at **`hi-im-vijay/rondocode-sing`** (public), which is the
default in `config.ts` — the app fetches straight from HuggingFace, no local
server, so it works in prod, dev, and over Tailnet alike.

## Re-uploading / hosting your own copy

```sh
pip install -U huggingface_hub
hf auth login                                       # once, with a write token
hf repo create rondocode-sing --repo-type model     # -> <you>/rondocode-sing

# from the directory holding the .onnx files:
hf upload <you>/rondocode-sing ./ . --repo-type model
```

HuggingFace's `resolve` CDN serves these with open CORS (`access-control-allow-
origin: *`) and range requests, which is all the browser needs.

Then point `DEFAULT_BASE` in `config.ts` (or `VITE_SING_MODELS_BASE`) at your repo.

## Point the app at your repo

The model base URL is read from a build-time env var (see `src/sing/config.ts`).
Set it for your deploy:

```sh
# .env.production (or your host's env config)
VITE_SING_MODELS_BASE=https://huggingface.co/hi-im-vijay/rondocode-sing/resolve/main
```

For **local development** against the static model server instead:

```sh
# .env.local
VITE_SING_MODELS_BASE=http://127.0.0.1:8790
```

If unset, dev builds default to `127.0.0.1:8790` and production builds to the
placeholder in `config.ts` (`DEFAULT_BASE`) — change that constant or set the env
var. `VITE_SUPERTONIC_BASE` overrides the Supertonic host the same way.

## Follow-up: shrink the download

The ~2 GB first load (dominated by the fp32 phoneme model) is cached after the
first visit but is still heavy. Quantizing to int8/fp16 (~4–6× smaller) is the
main lever; re-test alignment quality after — an earlier int8 export collapsed the
CTC output (may have been an unrelated feeding bug; worth retrying). Tracked
separately from this hosting pass.
