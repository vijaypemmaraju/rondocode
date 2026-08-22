"""Write/read the RDSP .bin format (SPEC.md). The reader exists so golden
vectors and quality evals run on the exact fp16 weights the runtime will see,
not the fp32 checkpoint.

Format v2 (still magic 'RDSP', container version 1 — the header grew
optional fields): `inputs` names the conditioning features in order and
`inharmonicity` carries the per-MIDI-key B table. Tensor names follow the
v2 module layout (`in_mlps.<feature>.*`); v1 files keep `in_mlp_f0` /
`in_mlp_ld` and load_bin maps them."""

import json
import struct

import numpy as np
import torch

from .model import Decoder

MAGIC = b"RDSP"
VERSION = 1


FORTE_REF_SUM = 0.18  # model-scale harmonic sum the runtime's default gain expects


def _reference_features(model: Decoder, f0: float, loudness: float, frames: int = 30) -> dict[str, torch.Tensor]:
    """A steady mid-strength reference frame set for every input the model
    takes (forte for loudness models; a firm strike at ~0.25 s for struck)."""
    feats: dict[str, torch.Tensor] = {}
    for name in model.inputs:
        if name == "f0":
            v = f0
        elif name == "loudness":
            v = loudness
        elif name == "velocity":
            v = 0.8
        elif name == "onset_age":
            v = 0.25
        elif name == "release_age":
            v = 0.0
        elif name == "held":
            v = 1.0
        else:
            v = 0.0
        feats[name] = torch.full((1, frames), float(v))
    return feats


def _out_norm(model: Decoder) -> float:
    """Per-model output calibration: models reproduce their RECORDING's
    absolute level, which varies wildly with the source material. The header
    carries a normalizer that maps a reference frame (f0 440, forte / firm
    strike) onto a fixed level, so the kernel's default gain lands every
    instrument at the same mixable level."""
    was_training = model.training
    model.eval()
    with torch.no_grad():
        h = float(model(_reference_features(model, 440.0, -15.0))["harm_amps"][0, -1].sum())
    if was_training:
        model.train()
    if h < 1e-6:
        return 1.0
    return max(0.05, min(20.0, FORTE_REF_SUM / h))


def export_bin(
    model: Decoder, path: str, name: str, license_id: str, provenance: str
) -> None:
    tensors = []
    blobs = []
    offset = 0
    for tname, t in model.state_dict().items():
        if tname == "log_b":
            continue  # exported as the header's inharmonicity table, not a tensor
        arr = t.detach().cpu().numpy().astype(np.float16)
        tensors.append({"name": tname, "shape": list(arr.shape), "offset": offset})
        blobs.append(arr.tobytes())
        offset += arr.nbytes
    header: dict = {
        "name": name,
        "license": license_id,
        "provenance": provenance,
        "sample_rate": model.sample_rate,
        "hop": model.hop,
        "n_harmonics": model.n_harmonics,
        "n_noise": model.n_noise,
        "hidden": model.hidden,
        "layers": model.layers,
        "gru": model.gru_size,
        "inputs": list(model.inputs),
        "out_norm": round(_out_norm(model), 5),
        "tensors": tensors,
    }
    if model.log_b is not None:
        header["inharmonicity"] = [round(float(v), 8) for v in torch.exp(model.log_b.detach()).cpu()]
    hjson = json.dumps(header).encode("utf-8")
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", VERSION, len(hjson)))
        f.write(hjson)
        pos = 12 + len(hjson)
        f.write(b"\x00" * ((-pos) % 4))
        for blob in blobs:
            f.write(blob)


V1_NAME_MAP = {"in_mlp_f0": "in_mlps.f0", "in_mlp_ld": "in_mlps.loudness"}


def load_bin(path: str) -> Decoder:
    with open(path, "rb") as f:
        raw = f.read()
    assert raw[:4] == MAGIC, "not an RDSP file"
    version, hlen = struct.unpack("<II", raw[4:12])
    assert version == VERSION, f"unsupported RDSP version {version}"
    header = json.loads(raw[12 : 12 + hlen].decode("utf-8"))
    data_start = 12 + hlen + ((-(12 + hlen)) % 4)
    inputs = header.get("inputs", ["f0", "loudness"])
    inharm = header.get("inharmonicity")
    model = Decoder(
        hidden=header["hidden"],
        layers=header["layers"],
        gru=header["gru"],
        n_harmonics=header["n_harmonics"],
        n_noise=header["n_noise"],
        sample_rate=header["sample_rate"],
        hop=header["hop"],
        inputs=inputs,
        inharmonic=inharm is not None,
    )
    state = {}
    for spec in header["tensors"]:
        shape = spec["shape"]
        count = int(np.prod(shape)) if shape else 1
        start = data_start + spec["offset"]
        arr = np.frombuffer(raw, dtype="<f2", count=count, offset=start)
        tname = spec["name"]
        for old, new in V1_NAME_MAP.items():
            if tname.startswith(old + "."):
                tname = new + tname[len(old):]
        state[tname] = torch.from_numpy(arr.astype(np.float32).reshape(shape).copy())
    if inharm is not None:
        state["log_b"] = torch.log(torch.tensor(inharm, dtype=torch.float32))
    model.load_state_dict(state)
    model.eval()
    return model
