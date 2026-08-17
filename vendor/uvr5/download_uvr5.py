#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_uvr5.py — fetch UVR5 vocal-separation weights into models/separation/uvr5/.

Why
---
The release ships only `onnx_dereverb_By_FoxJoy/` (and even that may be absent in
source checkouts). The HP2/HP3/HP5 / DeEcho / BS-Roformer weights are NOT bundled
(large, license-separate). This script provisions them on demand so the Vocal
Extraction panel's presets become usable.

Source strategy (per user decision)
------------------------------------
* PRIMARY : Hugging Face  — lj1995/GPT-SoVITS  (canonical upstream).
* FALLBACK: ModelScope    — same files mirrored (better in CN networks).
Each file is tried on HF first; on any failure it retries on ModelScope. Use
`--source modelscope` to flip the primary, or `--source hf` to force HF only.

Stdlib only (urllib) — no huggingface_hub / modelscope package required, so it
runs inside the project venv without extra installs. Mirrors 03_fetch_runtimes.py.

Usage
-----
    python download_uvr5.py --model HP2                 # one model
    python download_uvr5.py --model HP2 --model HP5     # several
    python download_uvr5.py --all                       # every non-heavy model
    python download_uvr5.py --all --include-heavy       # + BS-Roformer (~1GB)
    python download_uvr5.py --model MDX-Net --source modelscope
    python download_uvr5.py --model HP2 --dest /path/to/models/separation/uvr5 --force

Progress lines are printed as `PROGRESS <model> <file> <pct>` so a Node parent can
surface a live bar; final status per model is `DONE <model>` or `FAIL <model> ...`.
"""

import argparse
import os
import sys
import tempfile
import urllib.request
import urllib.error

def _project_root():
    """Walk up to the directory holding package.json.

    Never count directory levels with dirname(dirname(...)): that silently
    produces a wrong-but-plausible path the moment a file is moved, which is
    exactly how this project ended up downloading several GB into directories
    nobody reads. Walking to a landmark either finds the real root or fails
    loudly.
    """
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        if os.path.isfile(os.path.join(d, "package.json")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError(
                "cannot locate the project root (no package.json above %s); "
                "pass --dest explicitly" % os.path.abspath(__file__))
        d = parent


# The weights root. This MUST be the same directory the separator reads from
# (uvr5_models.js: defaultWeightsDir), otherwise a download appears to succeed
# and the panel still reports the model as missing.
_DEFAULT_DEST = os.path.join(
    _project_root(), "models", "separation", "uvr5")

# DEFAULT source = the canonical UVR5 weights repo. The classic VR / HP / DeEcho
# / MDX weights live in lj1995/VoiceConversionWebUI (the original RVC repo) under
# uvr5_weights/ — NOT in lj1995/GPT-SoVITS. GPT-SoVITS' own README points here,
# and the official download_models.py agrees. Using the GPT-SoVITS repo 404s.
HF_BASE = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/uvr5_weights"
MS_BASE = ("https://www.modelscope.cn/models/AI-ModelScope/VoiceConversionWebUI/"
           "resolve/master/uvr5_weights")

# The two Roformer checkpoints are NOT in the VR weights repo; each has its own
# canonical HF home. A file spec may be a plain rel-path string (uses the default
# base above, in-repo path == local rel path) OR a dict for a full override:
#   {"local": <rel path on disk>, "hf": <full HF url>, "ms": <full ModelScope url>}
# `ms` is optional (falls back to trying `hf` twice / whatever `--source` allows).

# Mel-Band Roformer — user-confirmed source (HF-labelled MIT). The repo ships the
# checkpoint as `MelBandRoformer.ckpt`; bsroformer.py detects the arch from that
# name ("melbandroformer") and falls back to a built-in default config, so NO yaml
# is needed. We save it under the same filename the loader / registry expect.
_MELBAND = {
    "local": "MelBandRoformer.ckpt",
    "hf": "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt",
    "ms": ("https://www.modelscope.cn/models/KimberleyJSN/melbandroformer/"
           "resolve/master/MelBandRoformer.ckpt"),
}

# BS-Roformer — the ep_317 checkpoint is NOT in the VR weights repo; it lives in
# the MSST (Music-Source-Separation-Training) model zoo mirror on HF (HF-labelled
# MIT, user-confirmed). No yaml needed: bsroformer.py ships a built-in default
# config for exactly this ep_317 checkpoint.
_BS = {
    "local": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "hf": ("https://huggingface.co/Eddycrack864/Music-Source-Separation-Training/"
           "resolve/main/model_bs_roformer_ep_317_sdr_12.9755.ckpt"),
    # No confirmed ModelScope mirror for this checkpoint; HF only.
    "ms": None,
}

# id -> list of file specs. Mirrors uvr5_models.js.
MODELS = {
    "HP2": ["HP2_all_vocals.pth"],
    "HP3": ["HP3_all_vocals.pth"],
    "HP5": ["HP5_only_main_vocal.pth"],
    "MDX-Net": ["onnx_dereverb_By_FoxJoy/vocals.onnx",
                "onnx_dereverb_By_FoxJoy/other.onnx"],
    "DeEcho-Normal": ["VR-DeEchoNormal.pth"],
    "DeEcho-Aggressive": ["VR-DeEchoAggressive.pth"],
    "DeEcho-DeReverb": ["VR-DeEchoDeReverb.pth"],
    "BS-Roformer": [_BS],
    "Mel-Band-Roformer": [_MELBAND],
}
HEAVY = {"BS-Roformer", "Mel-Band-Roformer"}

# Architecture subdirectory per model id. This MUST agree with uvr5_models.js,
# which is the single source of truth; a test compares the two tables.
#
# The weights are NOT stored flat: the separator picks its architecture by
# substring-matching the full checkpoint path, so a checkpoint sitting in the
# wrong folder gets loaded by the wrong architecture. That failure is silent —
# the run finishes and produces audible but garbled audio.
ARCH = {
    "HP2": "vr",
    "HP3": "vr",
    "HP5": "vr",
    "DeEcho-Normal": "vr",
    "DeEcho-Aggressive": "vr",
    "DeEcho-DeReverb": "vr",
    "BS-Roformer": "roformer",
    "Mel-Band-Roformer": "roformer",
    "MDX-Net": "mdx",
}
_missing_arch = sorted(set(MODELS) - set(ARCH))
if _missing_arch:
    raise RuntimeError("no architecture declared for: %s" % ", ".join(_missing_arch))
# Files whose download failure is tolerated (best-effort companions), keyed by
# model id -> set of LOCAL rel paths. Missing ones fall back to code defaults.
OPTIONAL_FILES = {}


def _spec_local(spec):
    """Local rel-path for a file spec (string or override dict)."""
    return spec["local"] if isinstance(spec, dict) else spec


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return "%.1f%s" % (f, u)
        f /= 1024.0


def _download_one(url, out_path, model, rel):
    """Stream one URL to out_path, printing PROGRESS lines. Raises on failure."""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=os.path.dirname(out_path), suffix=".part")
    os.close(tmp_fd)
    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker/uvr5-dl"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp_path, "wb") as fh:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            last_pct = -1
            chunk = 1024 * 256
            while True:
                buf = r.read(chunk)
                if not buf:
                    break
                fh.write(buf)
                done += len(buf)
                if total:
                    pct = int(done * 100 / total)
                    if pct != last_pct:
                        last_pct = pct
                        print("PROGRESS %s %s %d" % (model, rel, pct), flush=True)
        # Reject tiny HTML error pages masquerading as weights (HF/MS 404s).
        if total and os.path.getsize(tmp_path) < total * 0.5:
            raise IOError("incomplete download (%s of %s)"
                          % (human(os.path.getsize(tmp_path)), human(total)))
        os.replace(tmp_path, out_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _spec_urls(spec, source):
    """(label, url) pairs to try for a file spec, honoring --source.
    Default-base specs derive their URLs from HF_BASE / MS_BASE; override dicts
    carry their own explicit hf / ms URLs."""
    if isinstance(spec, dict):
        rel = spec["local"]
        hf = ("HF", spec["hf"]) if spec.get("hf") else None
        ms = ("ModelScope", spec["ms"]) if spec.get("ms") else None
    else:
        rel = spec
        p = rel.replace(os.sep, "/")
        hf = ("HF", "%s/%s" % (HF_BASE, p))
        ms = ("ModelScope", "%s/%s" % (MS_BASE, p))
    if source == "hf":
        pairs = [hf]
    elif source == "modelscope":
        pairs = [ms]
    else:
        pairs = [hf, ms]
    return rel, [p for p in pairs if p]


def _fetch_file(spec, dest, source, force):
    rel, order = _spec_urls(spec, source)
    out_path = os.path.join(dest, rel)
    if os.path.exists(out_path) and not force:
        print("[uvr5-dl] exists, skip: %s" % rel, flush=True)
        return
    if not order:
        raise RuntimeError("no source available for %s under --source=%s" % (rel, source))
    errors = []
    for label, url in order:
        try:
            print("[uvr5-dl] %s <- %s" % (rel, label), flush=True)
            _download_one(url, out_path, _fetch_file.model, rel)
            return
        except Exception as e:  # noqa: BLE001 — try the next mirror
            errors.append("%s: %s" % (label, e))
            print("[uvr5-dl] %s failed on %s: %s" % (rel, label, e), flush=True)
    raise RuntimeError("all sources failed for %s -> %s" % (rel, "; ".join(errors)))


_fetch_file.model = "?"


def download_model(model, dest, source, force):
    if model not in MODELS:
        print("FAIL %s unknown model id" % model, flush=True)
        return False
    _fetch_file.model = model
    optional = OPTIONAL_FILES.get(model, set())
    # Every model lands under its architecture subdirectory, never in the root.
    model_dest = os.path.join(dest, ARCH[model])
    os.makedirs(model_dest, exist_ok=True)
    print("[uvr5-dl] %s -> %s" % (model, model_dest), flush=True)
    try:
        for spec in MODELS[model]:
            rel = _spec_local(spec)
            try:
                _fetch_file(spec, model_dest, source, force)
            except Exception as e:  # noqa: BLE001
                if rel in optional:
                    print("[uvr5-dl] optional file skipped (using code default): "
                          "%s (%s)" % (rel, e), flush=True)
                    continue
                raise
        print("DONE %s" % model, flush=True)
        return True
    except Exception as e:  # noqa: BLE001
        print("FAIL %s %s" % (model, e), flush=True)
        return False


def main():
    ap = argparse.ArgumentParser(description="Download UVR5 vocal-separation weights.")
    ap.add_argument("--model", action="append", default=[],
                    help="Model id to download (repeatable). See uvr5_models.js.")
    ap.add_argument("--all", action="store_true", help="Download every model.")
    ap.add_argument("--include-heavy", action="store_true",
                    help="Include heavy models (BS-Roformer ~1GB, Mel-Band Roformer "
                         "~700MB) when using --all.")
    ap.add_argument("--dest", default=_DEFAULT_DEST,
                    help="Weights root; each model is written to "
                         "<dest>/<architecture>/. Must match the directory the "
                         "separator reads (default: %(default)s).")
    ap.add_argument("--source", default="auto", choices=["auto", "hf", "modelscope"],
                    help="auto = HF then ModelScope (default); or force one.")
    ap.add_argument("--force", action="store_true", help="Re-download existing files.")
    args = ap.parse_args()

    if args.all:
        models = [m for m in MODELS if args.include_heavy or m not in HEAVY]
    else:
        models = args.model
    if not models:
        ap.error("nothing to do: pass --model <id> (repeatable) or --all")

    os.makedirs(args.dest, exist_ok=True)
    ok = 0
    for m in models:
        if download_model(m, args.dest, args.source, args.force):
            ok += 1
    print("[uvr5-dl] finished: %d/%d ok" % (ok, len(models)), flush=True)
    return 0 if ok == len(models) else 1


if __name__ == "__main__":
    sys.exit(main())
