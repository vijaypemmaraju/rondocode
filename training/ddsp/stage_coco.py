"""Stage CocoChorales stems into per-instrument corpora.

Walks extracted shard directories, reads each track's metadata.yaml for the
voice -> instrument mapping, and copies wanted stems (with their stem MIDI —
the future stage-1 note-context labels) into
data/_downloads/coco_staged/<instrument>/, capped per instrument.

CocoChorales is MIDI-DDSP-rendered (CC BY 4.0): real phrase structure and
transitions, synthetic timbre at 16 kHz. Use it to teach TRANSITIONS to the
single-note-trained low strings, mixed with (not replacing) real recordings.

Usage: uv run python stage_coco.py [cap_per_instrument]
"""

import pathlib
import shutil
import sys

import soundfile as sf
import yaml

WANTED = {"violin", "viola", "cello", "double bass", "doublebass", "bass"}
CANON = {"double bass": "bass", "doublebass": "bass"}


def main(cap: int = 600) -> None:
    root = pathlib.Path(__file__).parent / "data" / "_downloads"
    src = root / "cocochorales_extracted"
    out_root = root / "coco_staged"
    counts: dict[str, int] = {}
    secs: dict[str, float] = {}
    checked_sr = False
    for track in sorted(src.rglob("metadata.yaml")):
        tdir = track.parent
        meta = yaml.safe_load(track.read_text())
        names = meta.get("instrument_name", {})
        for voice, inst in names.items():
            inst_l = str(inst).lower()
            if inst_l not in WANTED:
                continue
            name = CANON.get(inst_l, inst_l)
            if counts.get(name, 0) >= cap:
                continue
            # metadata voices are 0-indexed but stem FILES are 1-indexed
            fidx = int(voice) + 1
            wav = tdir / "stems_audio" / f"{fidx}_{inst}.wav"
            mid = tdir / "stems_midi" / f"{fidx}_{inst}.mid"
            if not mid.exists():
                mid = tdir / "stems_MIDI" / f"{fidx}_{inst}.mid"
            if not wav.exists():
                continue
            if not checked_sr:
                info = sf.info(str(wav))
                print(f"audio spec: {info.samplerate} Hz, {info.channels} ch, {info.subtype}")
                checked_sr = True
            dest = out_root / name
            dest.mkdir(parents=True, exist_ok=True)
            stem_name = f"{tdir.name}_{voice}_{name}"
            shutil.copy2(wav, dest / f"{stem_name}.wav")
            if mid.exists():
                shutil.copy2(mid, dest / f"{stem_name}.mid")
            counts[name] = counts.get(name, 0) + 1
            secs[name] = secs.get(name, 0.0) + sf.info(str(wav)).duration
    for name in sorted(counts):
        print(f"{name}: {counts[name]} stems, {secs[name] / 60:.1f} min")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 600)
