"""Run the same train.py on a Modal GPU.

One-time: uv run --extra modal modal volume create rondo-ddsp-data
Upload features: uv run --extra modal modal volume put rondo-ddsp-data data/violin/features /violin/features
Train:           uv run --extra modal modal run modal_app.py --config configs/violin.yaml
Fetch result:    uv run --extra modal modal volume get rondo-ddsp-data /runs/violin/ddsp-violin.bin runs/violin/
"""

import pathlib

import modal

app = modal.App("rondo-ddsp")
image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "torch>=2.4", "torchaudio>=2.4", "torchcrepe>=0.0.23",
        "numpy>=1.26", "soundfile>=0.12", "pyyaml>=6.0", "tqdm>=4.66",
    )
    .add_local_dir(str(pathlib.Path(__file__).parent / "ddsp"), "/root/ddsp")
    .add_local_file(str(pathlib.Path(__file__).parent / "train.py"), "/root/train.py")
    .add_local_file(str(pathlib.Path(__file__).parent / "prepare.py"), "/root/prepare.py")
)
volume = modal.Volume.from_name("rondo-ddsp-data", create_if_missing=True)


@app.function(image=image, gpu="A10G", timeout=6 * 3600, volumes={"/vol": volume})
def train_remote(config_text: str, steps: int | None) -> bytes:
    import subprocess
    import sys

    import yaml

    cfg = yaml.safe_load(config_text)
    name = cfg["name"]
    # train.py resolves data/ and runs/ relative to the config's parent's parent.
    cfg_dir = pathlib.Path("/vol/configs")
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = cfg_dir / f"{name}.yaml"
    cfg_path.write_text(config_text)
    # features first (skips files already prepared on the volume), then train
    if pathlib.Path(f"/vol/data/{name}/raw").exists():
        subprocess.run([sys.executable, "/root/prepare.py", str(cfg_path)], check=True, cwd="/root")
        volume.commit()
    cmd = [sys.executable, "/root/train.py", str(cfg_path), "--device", "cuda"]
    if steps:
        cmd += ["--steps", str(steps)]
    subprocess.run(cmd, check=True, cwd="/root")
    volume.commit()
    out = pathlib.Path(f"/vol/runs/{name}/ddsp-{name}.bin")
    return out.read_bytes()


@app.local_entrypoint()
def main(config: str, steps: int = 0) -> None:
    text = pathlib.Path(config).read_text()
    import yaml

    name = yaml.safe_load(text)["name"]
    blob = train_remote.remote(text, steps or None)
    out = pathlib.Path(__file__).parent / "runs" / name / f"ddsp-{name}.bin"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    print(f"wrote {out} ({len(blob)} bytes)")
