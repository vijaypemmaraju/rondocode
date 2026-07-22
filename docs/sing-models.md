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
| `gen_raiden.onnx` | ~112 MB | RVC generator — voice "raiden" |

These are the exact files the local dev model server (`127.0.0.1:8790`) serves.

## One-time upload to HuggingFace

```sh
pip install -U huggingface_hub
huggingface-cli login                       # once, with a write token
huggingface-cli repo create sing-models --type model   # -> <you>/sing-models

# from the directory that holds the .onnx files:
huggingface-cli upload <you>/sing-models phoneme.onnx    phoneme.onnx
huggingface-cli upload <you>/sing-models vec-768.onnx    vec-768.onnx
huggingface-cli upload <you>/sing-models gen_kizuna.onnx gen_kizuna.onnx
huggingface-cli upload <you>/sing-models gen_barbara.onnx gen_barbara.onnx
huggingface-cli upload <you>/sing-models gen_rise.onnx   gen_rise.onnx
huggingface-cli upload <you>/sing-models gen_raiden.onnx gen_raiden.onnx
```

HuggingFace's `resolve` CDN serves these with permissive CORS, which is all the
browser needs. Files > 5 GB or private repos need extra setup — not the case here.

## Point the app at your repo

The model base URL is read from a build-time env var (see `src/sing/config.ts`).
Set it for your deploy:

```sh
# .env.production (or your host's env config)
VITE_SING_MODELS_BASE=https://huggingface.co/<you>/sing-models/resolve/main
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
