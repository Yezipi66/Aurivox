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
    ├── INDEX.json              ← machine-readable index of bundled code/runtime
    ├── python_packages.json    ← frozen Python dependency closure (inventory)
    ├── node_packages.json      ← backend Node production closure (GENERATED after npm ci)
    ├── GPT-SoVITS.LICENSE.txt  (MIT)  — derived training/inference code
    ├── CPython.LICENSE.txt     (PSF)  — python-build-standalone runtime
    ├── Node.js.LICENSE.txt     (MIT + bundled) — backend runtime
    ├── jieba_fast.LICENSE.txt  (MIT)  — shipped prebuilt wheel
    └── pyopenjtalk.LICENSE.txt (MIT)  — shipped prebuilt wheel

THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json   ← fetched-on-demand tools (FFmpeg), NOT bundled
```

## models/ — model source & license manifest

`models/MODEL_SOURCES.json` (schema 3) records, for each third-party model, its
**download group**, **source repository**, and best-effort license metadata.
Models are **not bundled** — the deploy wizard fetches each one from the source
repo identified here at deploy time, so a model's license *text* travels with the
download, not with this folder.

Because we do **not** redistribute these weights (GPT-SoVITS *code* aside), the
deploy wizard does not assert or "verify" any model license. Its third-layer view
simply **lists the models to be downloaded and their source repositories** and
asks the operator to read each repo's own license and confirm with `READ` (or
`NO` to skip that group; the platform still deploys). The manifest therefore no
longer carries a `verification_status` field — the authoritative license is
always whatever the upstream repo states.

Current state: **26 components across 11 download groups**, default base `v2Pro`
(default-selected groups: `core`, `asr`, `g2pw`, `langdetect`).

| download group | components | role |
|----------------|-----------|------|
| `core` (6) | gsv s1/s2G/s2D v2Pro, sv_eres2netv2, cn-hubert, roberta-wwm | required base for every version (default) |
| `asr` (1) | faster-whisper large-v3-turbo | training-time ASR (default) |
| `funasr` (4) | Paraformer-zh, FSMN-VAD, CT-punc, UniASR-yue | optional zh/yue ASR engine (ModelScope) |
| `g2pw` (1) | g2pW.onnx | Chinese polyphone disambiguation (default) |
| `langdetect` (1) | fastText lid.176 | language identification (default) |
| `alt_v2` (2) | v2 G+D | alternative base version |
| `alt_v2proplus` (2) | v2ProPlus G+D | alternative base version |
| `uvr5_hp` (3) | HP2 / HP3 / HP5 | UVR5 vocal/instrument separation (VR) |
| `uvr5_deecho` (3) | DeEcho Normal / Aggressive / DeReverb | UVR5 reverb/echo removal (VR) |
| `uvr5_mdx` (1) | onnx_dereverb (FoxJoy) | UVR5 MDX-Net de-reverb |
| `uvr5_roformer` (2) | BS-Roformer + Mel-Band Roformer | UVR5 high-quality separation |

> `lid.176.bin`: the fastText **code** is MIT, but the **model weights** carry
> **CC-BY-SA-3.0** (Wikipedia/Tatoeba/SETimes training data) per its source repo.
> `funasr_*`: the FunASR *framework* on GitHub is MIT, but the individual weight
> pages on ModelScope state **Apache-2.0** — read each model page for the
> authoritative terms. We only download these; we do not redistribute them.

## runtime/ — bundled code & runtime license texts (verbatim)

Verbatim license texts of third-party code and runtimes that ship **inside** a
distribution and whose licenses require the text to travel with the software.

`runtime/INDEX.json` is the machine-readable index of these bundled code/runtime
components; the deploy wizard reads it to group and display the second license
layer.

Only two Python packages are actually shipped (prebuilt `cp311/win_amd64`
wheels, both MIT): `jieba_fast` and `pyopenjtalk`. All other Python deps are
installed at deploy time from a package index (`bundled: false`), inventoried in
`runtime/python_packages.json`; `torch`/`torchaudio` come from a CUDA-specific
index.

The backend **Node** production dependency closure is likewise **not bundled** —
`node_modules` is restored on the target by `npm ci` (bootstrap.ps1) from the
shipped `package-lock.json`. Its per-package licenses are inventoried in
`runtime/node_packages.json`, which is **generated** (not hand-maintained) by
`tools/build/gen_node_licenses.py` reading each installed
`node_modules/<pkg>/package.json` — so no Node license is ever hand-asserted.
bootstrap.ps1 regenerates it right after `npm ci`; the file may be absent on a
first, pre-`npm ci` wizard run, in which case the wizard points to `package.json`
and the installed `node_modules` instead.

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

- **All model weights** — including the full UVR5 vocal-separation pipeline
  (`uvr5_hp` / `uvr5_deecho` / `uvr5_mdx` / `uvr5_roformer`), the FunASR ASR
  models, faster-whisper, g2pW and lid.176 — are *models*, tracked in
  `models/MODEL_SOURCES.json` (all `bundled: false`). They are downloaded at
  deploy time from their source repos, so their license texts do not live under
  `runtime/`; read them at the upstream repositories listed in the manifest.
