# Training data provenance and licenses

The shipped ddsp models (violin, flute, trumpet, tenorsax) are trained
exclusively on the two CC-BY 4.0 datasets below. The models are therefore
distributed under **CC BY 4.0** with the attributions in this file; the
model file headers carry `"license": "CC-BY-4.0"` and a short provenance
string pointing here.

## Medley-solos-DB v1.2 (CC BY 4.0)

- Source: https://zenodo.org/records/3464194 (DOI 10.5281/zenodo.1344103)
- Authors: Vincent Lostanlen (New York University), Carmine-Emanuele Cella
  (Ircam), Rachel Bittner (Spotify Inc.), Slim Essid (Telecom ParisTech)
- License: Creative Commons Attribution 4.0 International
- Content used: the solo performance clips (2.972 s, 44.1 kHz mono) for
  class 3 (flute), class 5 (tenor saxophone), class 6 (trumpet) and
  class 7 (violin).

## TinySOL v6.0 (CC BY 4.0)

- Source: https://zenodo.org/records/3685367 (DOI 10.5281/zenodo.3685367)
- Authors: Carmine-Emanuele Cella, Daniele Ghisi, Vincent Lostanlen,
  Fabien Levy, Joshua Fineberg, Yan Maresz; recorded at Ircam, Paris
- License: Creative Commons Attribution 4.0 International
- Content used: single ordinario notes (44.1 kHz mono) for Violin, Flute
  and Trumpet in C, to widen pitch and dynamic coverage beyond the
  Medley-solos-DB phrases. (TinySOL's saxophone is alto; the tenorsax
  model trains on Medley-solos-DB only.)

## What "trained on" means here

The distributed artifact is a ~1 MB set of decoder weights (RDSP .bin,
see SPEC.md), not the recordings. No audio from either dataset is
redistributed. Attribution above satisfies CC BY 4.0 for the derived
weights; anyone redistributing the models should keep this file's
attributions (or the .bin headers) intact.

## Bach Violin Dataset v1.0 (per-file licenses)

- Source: https://zenodo.org/records/6050245 (Dong et al., "Deep Performer";
  dataset repo https://github.com/salu133445/bach-violin-dataset)
- Content used for the violin model (v2 retrain): the John Garner recordings
  of Bach's Sonatas and Partitas (BWV 1001-1006), ~21 minutes, one performer,
  one recording setup.
- License of those files: Creative Commons Attribution 3.0 (attributed to
  John Garner; originally commissioned by Musopen).

## Bach Cello Suite No. 1 — Darrell Jacobi (CC BY 3.0)

- Source: Wikimedia Commons (files IMSLP173147-173152, originally uploaded
  to IMSLP), complete BWV 1007, ~20 minutes, one performer.
- License: Creative Commons Attribution 3.0 (attributed to Darrell Jacobi).
- Used for the cello model (v2 retrain), replacing the TinySOL-only corpus.
