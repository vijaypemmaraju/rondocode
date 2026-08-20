"""Stage downloaded datasets into per-instrument raw/ directories.

Expects in data/_downloads/ (see DATA_LICENSES.md for sources):
  Medley-solos-DB.tar.gz + Medley-solos-DB_metadata.csv   (Zenodo 3464194)
  TinySOL.tar.gz + TinySOL_metadata.csv                   (Zenodo 3685367)

Usage: uv run python stage_data.py
"""

import csv
import pathlib
import shutil
import tarfile

ROOT = pathlib.Path(__file__).parent / "data"
DL = ROOT / "_downloads"

# Medley-solos-DB instrument_id -> our model name
MEDLEY_CLASSES = {3: "flute", 5: "tenorsax", 6: "trumpet", 7: "violin"}
# TinySOL instrument folder -> our model name (ordinario only; alto sax skipped
# so the tenorsax model stays a tenor)
TINYSOL_INSTRUMENTS = {"Vn": "violin", "Fl": "flute", "TpC": "trumpet"}


def extract(archive: pathlib.Path, dest: pathlib.Path) -> None:
    if dest.exists():
        return
    print(f"extracting {archive.name} ...")
    dest.mkdir(parents=True)
    with tarfile.open(archive) as tf:
        tf.extractall(dest, filter="data")


def stage_medley() -> None:
    extracted = DL / "medley"
    extract(DL / "Medley-solos-DB.tar.gz", extracted)
    # metadata: subset,instrument,instrument_id,song_id,uuid4 (columns by name)
    by_uuid: dict[str, str] = {}
    with open(DL / "Medley-solos-DB_metadata.csv", newline="") as f:
        for row in csv.DictReader(f):
            name = MEDLEY_CLASSES.get(int(row["instrument_id"]))
            if name is not None:
                by_uuid[row["uuid4"]] = name
    count: dict[str, int] = {}
    for wav in extracted.rglob("*.wav"):
        # Medley-solos-DB_<subset>-<class>_<uuid>.wav
        uuid = wav.stem.split("_")[-1]
        name = by_uuid.get(uuid)
        if name is None:
            continue
        dest = ROOT / name / "raw" / f"medley_{wav.name}"
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(wav, dest)
        count[name] = count.get(name, 0) + 1
    print("medley staged:", count)


def stage_tinysol() -> None:
    extracted = DL / "tinysol"
    extract(DL / "TinySOL.tar.gz", extracted)
    count: dict[str, int] = {}
    for wav in extracted.rglob("*.wav"):
        # TinySOL paths look like .../Strings/Vn/ordinario/Vn-ord-C4-ff-...wav
        parts = wav.parts
        name = None
        for code, model in TINYSOL_INSTRUMENTS.items():
            if code in parts or wav.name.startswith(f"{code}-"):
                name = model
                break
        if name is None or "ord" not in wav.name.split("-")[1]:
            continue
        dest = ROOT / name / "raw" / f"tinysol_{wav.name}"
        if not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(wav, dest)
        count[name] = count.get(name, 0) + 1
    print("tinysol staged:", count)


if __name__ == "__main__":
    stage_medley()
    stage_tinysol()
    for d in sorted(ROOT.glob("*/raw")):
        n = sum(1 for _ in d.glob("*.wav"))
        print(f"{d.parent.name}: {n} files")
