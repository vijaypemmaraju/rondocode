"""Write/read the RDSP .bin format (SPEC.md). The reader exists so golden
vectors and quality evals run on the exact fp16 weights the runtime will see,
not the fp32 checkpoint."""

import json
import struct

import numpy as np
import torch

from .model import Decoder

MAGIC = b"RDSP"
VERSION = 1


def export_bin(
    model: Decoder, path: str, name: str, license_id: str, provenance: str
) -> None:
    tensors = []
    blobs = []
    offset = 0
    for tname, t in model.state_dict().items():
        arr = t.detach().cpu().numpy().astype(np.float16)
        tensors.append({"name": tname, "shape": list(arr.shape), "offset": offset})
        blobs.append(arr.tobytes())
        offset += arr.nbytes
    header = {
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
        "tensors": tensors,
    }
    hjson = json.dumps(header).encode("utf-8")
    with open(path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<II", VERSION, len(hjson)))
        f.write(hjson)
        pos = 12 + len(hjson)
        f.write(b"\x00" * ((-pos) % 4))
        for blob in blobs:
            f.write(blob)


def load_bin(path: str) -> Decoder:
    with open(path, "rb") as f:
        raw = f.read()
    assert raw[:4] == MAGIC, "not an RDSP file"
    version, hlen = struct.unpack("<II", raw[4:12])
    assert version == VERSION, f"unsupported RDSP version {version}"
    header = json.loads(raw[12 : 12 + hlen].decode("utf-8"))
    data_start = 12 + hlen + ((-(12 + hlen)) % 4)
    model = Decoder(
        hidden=header["hidden"],
        layers=header["layers"],
        gru=header["gru"],
        n_harmonics=header["n_harmonics"],
        n_noise=header["n_noise"],
        sample_rate=header["sample_rate"],
        hop=header["hop"],
    )
    state = {}
    for spec in header["tensors"]:
        shape = spec["shape"]
        count = int(np.prod(shape)) if shape else 1
        start = data_start + spec["offset"]
        arr = np.frombuffer(raw, dtype="<f2", count=count, offset=start)
        state[spec["name"]] = torch.from_numpy(
            arr.astype(np.float32).reshape(shape).copy()
        )
    model.load_state_dict(state)
    model.eval()
    return model
