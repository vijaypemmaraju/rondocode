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


def frame_loudness_mae_db(dry: torch.Tensor, target: torch.Tensor, hop: int) -> torch.Tensor:
    """Frame-RMS loudness gap in dB between the DRY render and the target.
    The shipped model is the dry half, so the level must live there — the
    spectral loss alone lets the learned reverb carry it (see TrainableReverb).
    """
    b, n = dry.shape
    frames = n // hop
    d = dry[:, : frames * hop].reshape(b, frames, hop)
    t = target[:, : frames * hop].reshape(b, frames, hop)
    ld_d = 10.0 * torch.log10(d.pow(2).mean(dim=-1) + 1e-8)
    ld_t = 10.0 * torch.log10(t.pow(2).mean(dim=-1) + 1e-8)
    return (ld_d - ld_t).abs().mean()


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
        inputs=tuple(cfg.get("inputs", ["f0", "loudness"])),
        inharmonic=bool(cfg.get("inharmonic", False)),
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
        old_ir = ck["reverb"]["ir"]
        if old_ir.shape[0] != reverb.ir.shape[0]:
            # reverb_length changed between runs: keep the learned head, pad
            # (or truncate) into the new buffer, and let the optimizer state
            # start fresh (its shapes changed with the params)
            with torch.no_grad():
                n = min(old_ir.shape[0], reverb.ir.shape[0])
                reverb.ir.zero_()
                reverb.ir[:n] = old_ir[:n]
            opt2 = torch.optim.Adam(params, lr=cfg.get("lr", 3e-4))
            opt.load_state_dict(opt2.state_dict())
            print(f"reverb resized {old_ir.shape[0]} -> {reverb.ir.shape[0]}; optimizer reset")
        else:
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
            feats = {n: batch[n].to(device) for n in model.inputs}
            f0 = feats["f0"]
            target = batch["audio"].to(device)
            out = model(feats)
            dry = render(
                f0, out["harm_amps"], out["noise_mags"], cfg["sample_rate"], cfg["hop"],
                partial_mult=out["partial_mult"],
            )
            wet = reverb(dry)
            ld_gap = frame_loudness_mae_db(dry, target, cfg["hop"])
            loss = multiscale_stft_loss(wet, target) + cfg.get("ld_weight", 0.1) * ld_gap
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 3.0)
            opt.step()
            sched.step()
            step += 1
            if step % 100 == 0:
                rec = {
                    "step": step,
                    "loss": round(float(loss.detach()), 4),
                    "ld_mae_db": round(float(ld_gap.detach()), 2),
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
                    ev, ev_ld = evaluate(model, reverb, eval_ds, cfg, device)
                    rec = {"step": step, "eval_loss": round(ev, 4), "eval_ld_mae_db": round(ev_ld, 2)}
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
def evaluate(model: Decoder, reverb: TrainableReverb, eval_ds, cfg: dict, device: str) -> tuple[float, float]:
    """Held-out spectral loss THROUGH the learned reverb (comparing dry to a
    roomy recording penalizes the model for getting drier — the goal), plus
    the dry-render loudness gap (which is what the shipped half must hold)."""
    model.eval()
    total = 0.0
    total_ld = 0.0
    for i in range(len(eval_ds)):
        b = eval_ds[i]
        feats = {n: b[n].unsqueeze(0).to(device) for n in model.inputs}
        f0 = feats["f0"]
        target = b["audio"].unsqueeze(0).to(device)
        out = model(feats)
        dry = render(
            f0, out["harm_amps"], out["noise_mags"], cfg["sample_rate"], cfg["hop"],
            partial_mult=out["partial_mult"],
        )
        total += float(multiscale_stft_loss(reverb(dry), target))
        total_ld += float(frame_loudness_mae_db(dry, target, cfg["hop"]))
    model.train()
    return total / len(eval_ds), total_ld / len(eval_ds)


if __name__ == "__main__":
    main()
