# THIRD_PARTY_LICENSES/

This is the **single hub** for all third-party legal materials of an Aurivox
distribution — both the **models** it uses and the **runtime / code components**
it bundles. Nothing third-party-legal lives at the repo root anymore; keeping it
all here avoids polluting the root.

```
THIRD_PARTY_LICENSES/
├── README.md                 ← you are here (index)
├── models/
│   └── MODEL_SOURCES.json     ← machine-readable model source/license manifest
└── runtime/
    ├── python_packages.json   ← frozen Python dependency closure (inventory)
    ├── GPT-SoVITS.LICENSE.txt  (MIT)  — derived training/inference code
    ├── CPython.LICENSE.txt     (PSF)  — python-build-standalone runtime
    ├── Node.js.LICENSE.txt     (MIT + bundled) — backend runtime
    ├── jieba_fast.LICENSE.txt  (MIT)  — shipped prebuilt wheel
    └── pyopenjtalk.LICENSE.txt (MIT)  — shipped prebuilt wheel

THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json   ← fetched-on-demand tools (FFmpeg), NOT bundled
```

## models/ — model source & license manifest

`models/MODEL_SOURCES.json` (schema 2) records where each third-party model
comes from and under which license, with an honest `verification_status`.
Models are **not bundled** — the deploy wizard fetches each one (and, where
provided, its license) from the source identified here at deploy time, so their
license *texts* are obtained together with the model, not stored in this folder.

Current state: **14 / 14 components verified**, default base `v2Pro`.

| tier | components | licenses |
|------|-----------|----------|
| core (9) | GPT-SoVITS s1/s2G/s2D v2Pro, eres2netv2, cn-hubert, roberta-wwm, whisper-v3-turbo, g2pw, lid.176 | MIT / Apache-2.0 / CC-BY-SA-3.0 |
| alt_base (4) | v2 (G+D), v2ProPlus (G+D) | MIT |
| optional (1) | uvr5_hp2 (vocal separation; UI labels "MDX-Net", actually HP2/VR) | MIT |
| excluded | BigVGAN, FunASR | not downloaded → no license obligation |

> `lid.176.bin`: the fastText **code** is MIT, but the **model weights** are
> **CC-BY-SA-3.0** (Wikipedia/Tatoeba/SETimes training data); recorded with a
> `license_note` in the manifest.

## runtime/ — bundled code & runtime license texts (verbatim)

Verbatim license texts of third-party code and runtimes that ship **inside** a
distribution and whose licenses require the text to travel with the software.

Only two Python packages are actually shipped (prebuilt `cp311/win_amd64`
wheels, both MIT): `jieba_fast` and `pyopenjtalk`. All other Python deps are
installed at deploy time from a package index (`bundled: false`), inventoried in
`runtime/python_packages.json`; `torch`/`torchaudio` come from a CUDA-specific
index.

For `Node.js.LICENSE.txt` and `CPython.LICENSE.txt`, the core MIT/PSF text here
does **not** replace the bundled-component notices (V8/OpenSSL/SQLite/… ) that
travel with each runtime's own upstream `LICENSE` file.

## Maintenance rule

Keep this hub in sync with what is actually shipped. When a bundled component is
added/removed/upgraded, update its text under `runtime/`; when a **model**
changes, update `models/MODEL_SOURCES.json` instead. The installer/UI reads from
these same files so NOTICE, download scripts, and displayed licenses never
disagree.

> Each `runtime/*.LICENSE.txt` carries the canonical license text plus a NOTE to
> re-copy the upstream `LICENSE` verbatim from the exact shipped build/revision
> at release-assembly time, so the distribution always carries authentic,
> unmodified texts.

## EXTERNAL_TOOLS.json — fetched-on-demand tools (NOT bundled)

`EXTERNAL_TOOLS.json` inventories third-party command-line tools that Aurivox
uses but does **not** redistribute — currently **FFmpeg** (`ffmpeg`/`ffprobe`).
They are downloaded at deploy time by `tools/deploy/download_ffmpeg.py` from the
upstream distributor (BtbN `win64-gpl` build; Aurivox is Windows-only). Because
Aurivox does not redistribute these binaries:

- the GPL license text and corresponding-source obligations travel with the
  upstream download and rest with those distributors, **not** with Aurivox — so
  no verbatim FFmpeg license text is bundled under `runtime/`;
- Aurivox invokes them as **separate processes** (subprocess, not linked), so
  their GPL license does not affect Aurivox's own MIT-licensed code.

This mirrors how models are handled in `models/MODEL_SOURCES.json`
(`bundled: false`): recorded for transparency, license travels with the fetch.

## Not here (by design)

- **MDX-Net / HP2 weights** — a *model*, tracked in `models/MODEL_SOURCES.json`
  (`uvr5_hp2`, not bundled), so its license does not live under `runtime/`.
