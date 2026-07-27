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
| `phoneme-int8.onnx` | ~357 MB | dynamic-int8 build of the same CTC model (lm_head kept fp32); preferred on iOS or via `localStorage['rc.singSmallAligner']='1'`, falls back to fp32 when absent |
| `tts_vector_estimator-int8.onnx` | ~66 MB | dynamic-int8 build of Supertonic's 256 MB flow-matching estimator (output head kept fp32); preferred on the sequential (phone) path, falls back to the fp32 HuggingFace build when absent |
| `tts_vocoder-int8.onnx` | ~39 MB | dynamic-int8 build of Supertonic's 101 MB vocoder (only the fat 1x1 pwconvs quantized; depthwise/embed/head convs kept fp32); same selection + fallback |
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

## The int8 aligner build

`phoneme-int8.onnx` is produced from `phoneme.onnx` with onnxruntime dynamic
quantization, int8 weights on every MatMul EXCEPT the final `/lm_head/MatMul`
CTC projection (quantizing the head, or the whole graph, is what collapses the
CTC output to all-blank; the conv feature extractor stays fp32 by construction
because only MatMul ops are quantized):

```py
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(
    'phoneme.onnx', 'phoneme-int8.onnx',
    op_types_to_quantize=['MatMul'],
    weight_type=QuantType.QInt8,
    nodes_to_exclude=['/lm_head/MatMul'],
    extra_options={'MatMulConstBOnly': True},
)
```

Measured against fp32 under onnxruntime-web wasm on a fixed Supertonic TTS
utterance set: 99.4% greedy symbol agreement (the one diff is a spurious
duplicate the fp32 build emits) and forced-alignment timing p95 delta of 0 ms
(max 20 ms, exactly one CTC frame). fp16 conversion is NOT usable: ort-web
1.27 wasm fails to create the session (layer-norm fusion bug).

## The int8 TTS builds

The Supertonic TTS graphs keep nearly all their weight in Conv ops (the
aligner's MatMul-only recipe would save almost nothing there), so the int8
builds quantize Convs with the sensitive layers excluded:

```py
from onnxruntime.quantization import quantize_dynamic, QuantType
# vector_estimator: everything except the output head
quantize_dynamic(
    'vector_estimator.onnx', 'tts_vector_estimator-int8.onnx',
    op_types_to_quantize=['Conv', 'MatMul'],
    weight_type=QuantType.QInt8,
    nodes_to_exclude=['/vector_estimator/vector_field/proj_out/net/Conv'],
    extra_options={'MatMulConstBOnly': True},
)
# vocoder: only the fat 1x1 pwconvs; depthwise + embed + head convs stay fp32
quantize_dynamic(
    'vocoder.onnx', 'tts_vocoder-int8.onnx',
    op_types_to_quantize=['Conv'],
    weight_type=QuantType.QInt8,
    nodes_to_exclude=[
        '/decoder/head/layer1/net/Conv', '/decoder/head/layer2/Conv',
        '/decoder/embed/net/Conv',
        *[f'/decoder/convnext.{i}/dwconv/net/Conv' for i in range(10)],
    ],
    extra_options={'MatMulConstBOnly': True},
)
```

Measured against fp32 under onnxruntime-web wasm on the same fixed utterance
set (same flow-matching latent, so quantization is the only variable): the
vector_estimator build's log-mel delta is a third of the fp32 seed-to-seed
self-noise, the combined set sits inside the self-noise band, forced-aligned
token sequences are identical, and 5/6 utterances align within two 20 ms CTC
frames of the fp32 render. duration_predictor is too small to bother with and
text_encoder int8 drifted phrase prosody, so both ship fp32 everywhere.

The models live in the `rondocode-models` R2 bucket behind
`models.rondocode.com`. For files under 300 MiB, upload with wrangler:

```sh
npx wrangler r2 object put rondocode-models/<file> \
  --file <file> --content-type application/octet-stream --remote
```

Wrangler refuses bigger files (the 340 MiB `phoneme-int8.onnx` included), and
there are no S3 keys on this machine, so large objects go up via R2's
multipart API: deploy a throwaway token-gated worker with a `BUCKET` binding
to `rondocode-models` that exposes createMultipartUpload / uploadPart /
complete, POST the file in ~90 MiB parts, then delete the worker. After any
upload, verify `curl -sI https://models.rondocode.com/<file>` reports the
exact local byte size. Until `phoneme-int8.onnx` exists, clients that prefer
it fall back to `phoneme.onnx` automatically.
