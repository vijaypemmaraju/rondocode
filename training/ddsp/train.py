"""Train one DDSP instrument model.

Usage: uv run python train.py configs/violin.yaml [--steps N] [--device mps]
Resumes automatically from runs/<name>/latest.pt if present.
"""

import argparse
import json
import pathlib
import time

import torch
import yaml
from torch.utils.data import DataLoader

from ddsp.data import ExcerptDataset
from ddsp.export import export_bin, load_bin
from ddsp.losses import multiscale_stft_loss
from ddsp.model import Decoder
from ddsp.synth import TrainableReverb, render


def pick_device(arg: str | None) -> str:
    if arg:
        return arg
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()
    cfg = yaml.safe_load(pathlib.Path(args.config).read_text())
    steps = args.steps or cfg.get("steps", 100000)
    device = pick_device(args.device)
    root = pathlib.Path(args.config).resolve().parent.parent
    run_dir = root / "runs" / cfg["name"]
    run_dir.mkdir(parents=True, exist_ok=True)

    model = Decoder(
        hidden=cfg.get("hidden", 128),
        layers=cfg.get("layers", 3),
        gru=cfg.get("gru", 192),
        n_harmonics=cfg.get("n_harmonics", 64),
        n_noise=cfg.get("n_noise", 65),
        sample_rate=cfg["sample_rate"],
        hop=cfg["hop"],
    ).to(device)
    reverb = TrainableReverb(cfg.get("reverb_length", cfg["sample_rate"])).to(device)
    params = list(model.parameters()) + list(reverb.parameters())
    opt = torch.optim.Adam(params, lr=cfg.get("lr", 3e-4))
    sched = torch.optim.lr_scheduler.ExponentialLR(
        opt, gamma=cfg.get("lr_decay", 0.98) ** (1.0 / 10000)
    )

    step = 0
    latest = run_dir / "latest.pt"
    if latest.exists():
        ck = torch.load(latest, map_location=device, weights_only=True)
        model.load_state_dict(ck["model"])
        reverb.load_state_dict(ck["reverb"])
        opt.load_state_dict(ck["opt"])
        sched.load_state_dict(ck["sched"])
        step = ck["step"]
        print(f"resumed from step {step}")

    features_dir = root / "data" / cfg["name"] / "features"
    all_files = sorted(features_dir.glob("*.npz"))
    n_holdout = max(1, len(all_files) // 10) if len(all_files) > 1 else 0
    holdout = [str(f) for f in all_files[:n_holdout]]
    train_files = [str(f) for f in all_files[n_holdout:]] or [str(f) for f in all_files]
    excerpt_frames = int(cfg.get("excerpt_seconds", 4.0) * cfg["sample_rate"] / cfg["hop"])
    ds = ExcerptDataset(str(features_dir), cfg["hop"], excerpt_frames, files=train_files)
    dl = DataLoader(ds, batch_size=cfg.get("batch", 16), num_workers=0)
    eval_ds = (
        ExcerptDataset(
            str(features_dir), cfg["hop"], excerpt_frames, files=holdout,
            excerpts_per_epoch=32, seed=7,
        )
        if holdout
        else None
    )

    log = open(run_dir / "log.jsonl", "a")
    t0 = time.time()
    while step < steps:
        for batch in dl:
            if step >= steps:
                break
            f0 = batch["f0"].to(device)
            ld = batch["loudness"].to(device)
            target = batch["audio"].to(device)
            out = model(f0, ld)
            dry = render(
                f0, out["harm_amps"], out["noise_mags"], cfg["sample_rate"], cfg["hop"]
            )
            wet = reverb(dry)
            loss = multiscale_stft_loss(wet, target)
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 3.0)
            opt.step()
            sched.step()
            step += 1
            if step % 100 == 0:
                rec = {
                    "step": step,
                    "loss": round(float(loss), 4),
                    "lr": sched.get_last_lr()[0],
                    "sec": round(time.time() - t0, 1),
                }
                print(rec)
                log.write(json.dumps(rec) + "\n")
                log.flush()
            if step % cfg.get("ckpt_every", 2000) == 0 or step == steps:
                torch.save(
                    {
                        "model": model.state_dict(),
                        "reverb": reverb.state_dict(),
                        "opt": opt.state_dict(),
                        "sched": sched.state_dict(),
                        "step": step,
                    },
                    latest,
                )
                if eval_ds is not None:
                    ev = evaluate(model, eval_ds, cfg, device)
                    rec = {"step": step, "eval_loss": round(ev, 4)}
                    print(rec)
                    log.write(json.dumps(rec) + "\n")
                    log.flush()

    out_path = run_dir / f"ddsp-{cfg['name']}.bin"
    export_bin(
        model.cpu(), str(out_path), cfg["name"], cfg["license"], cfg["provenance"]
    )
    check = load_bin(str(out_path))
    n_params = sum(p.numel() for p in check.parameters())
    print(f"exported {out_path} ({out_path.stat().st_size} bytes, {n_params} params)")


@torch.no_grad()
def evaluate(model: Decoder, eval_ds, cfg: dict, device: str) -> float:
    model.eval()
    total = 0.0
    for i in range(len(eval_ds)):
        b = eval_ds[i]
        f0 = b["f0"].unsqueeze(0).to(device)
        ld = b["loudness"].unsqueeze(0).to(device)
        target = b["audio"].unsqueeze(0).to(device)
        out = model(f0, ld)
        dry = render(
            f0, out["harm_amps"], out["noise_mags"], cfg["sample_rate"], cfg["hop"]
        )
        total += float(multiscale_stft_loss(dry, target))
    model.train()
    return total / len(eval_ds)


if __name__ == "__main__":
    main()
