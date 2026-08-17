#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pack_common.py — shared helpers for the Aurivox release / versioning toolchain.

Single source of truth for:
  * layer classification (R / W / N / A / M)  ->  classify_layer()
  * file hashing                              ->  sha256_file()
  * manifest assembly + per-layer lock finger ->  build_manifest() / layer_lock()
  * version.json assembly                     ->  build_version()
  * pinned runtime version lookup             ->  read_runtime_versions()

Layer model (see 分发方案与实施计划 §1):
  R  runtime      tools/runtime/**            (embedded python + node)  -> full pkg only
  W  wheels       tools/wheels/**  (*.whl)                              -> full pkg only
  N  node_modules node_modules/**             (backend prod deps)       -> full pkg only
  A  app          everything else that ships  (server.js, lib/, web/dist,
                  business *.json, tools/scripts, tools/build, launchers,
                  LICENSE/NOTICE/README, requirements.txt ...)          -> HOT-PATCHABLE
  M  models       pretrained/asr/uvr5 weights & stray media            -> never shipped

Only layer "A" is diffed by the patch generator. Any change touching R/W/N/M
forces requires_full_reinstall.

Stdlib only.
"""

import hashlib
import json
import os
import re
import subprocess
import time

# ---- layer classification -------------------------------------------------

# top-level anchored prefixes (forward-slash, no leading slash)
_LAYER_PREFIX = (
    ("tools/runtime/", "R"),
    ("tools/wheels/", "W"),
    ("node_modules/", "N"),
)

# model subtrees (should never ship, but classify defensively for standalone scans)
_MODEL_PREFIX = (
    "vendor/gsv-tools/pretrained/",
    "vendor/gsv-tools/asr/",
    "vendor/gsv-tools/uvr5/uvr5_weights/",
    "vendor/gsv_code/pretrained_models/",
    "vendor/gsv-infer/sr/AP_BWE_main/24kto48k/",
)
_MODEL_EXT = {
    ".pth", ".ckpt", ".pt", ".onnx", ".bin", ".safetensors", ".h5", ".pb",
    ".npy", ".npz", ".pkl", ".gguf", ".ggml",
}


def norm(p):
    return p.replace("\\", "/")


def classify_layer(relpath):
    """Map a package-relative path to its distribution layer letter."""
    r = norm(relpath)
    for prefix, layer in _LAYER_PREFIX:
        if r.startswith(prefix):
            return layer
    for prefix in _MODEL_PREFIX:
        if r.startswith(prefix):
            return "M"
    if os.path.splitext(r)[1].lower() in _MODEL_EXT:
        return "M"
    return "A"


# ---- hashing --------------------------------------------------------------

def sha256_file(path, _buf=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_buf), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


# ---- manifest -------------------------------------------------------------

def build_manifest(product, app, files, generated_at=None, max_workers=None):
    """files = iterable of (relpath, fullpath, size). Returns the manifest dict.

    Every shipped file is hashed and tagged with its layer. Sorted by path so
    the output is deterministic (stable diffs across builds).

    Hashing dominates pack time (sha256 over the whole payload), so it is fanned
    out across a thread pool: sha256_file spends its time in file IO and in
    hashlib.update(), both of which release the GIL for large reads, so threads
    give real wall-clock speedup on multi-core machines. Output is sorted after
    the fact, so it stays byte-for-byte deterministic regardless of worker count.
    Pass max_workers=1 to force the old sequential behaviour."""
    files = list(files)
    if max_workers is None:
        max_workers = min(16, (os.cpu_count() or 4) * 2)

    def _entry(item):
        rel, full, size = item
        return {
            "path": norm(rel),
            "sha256": sha256_file(full),
            "size": int(size),
            "layer": classify_layer(rel),
        }

    if max_workers > 1 and len(files) > 4:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            entries = list(ex.map(_entry, files))
    else:
        entries = [_entry(f) for f in files]
    entries.sort(key=lambda e: e["path"])
    return {
        "product": product,
        "app": app,
        "generated_at": generated_at or _utc_now(),
        "files": entries,
    }


def layer_lock(manifest, layer):
    """Deterministic sha256 fingerprint over one layer's files.

    Hash of the sorted "path\\0sha256" lines for every file in that layer.
    An empty layer yields a stable fingerprint of the empty string, so a build
    that ships no wheels still produces a comparable (constant) wheels_lock."""
    lines = [
        "{}\0{}".format(e["path"], e["sha256"])
        for e in manifest["files"] if e["layer"] == layer
    ]
    lines.sort()
    return "sha256:" + sha256_bytes("\n".join(lines).encode("utf-8"))


# ---- version.json ---------------------------------------------------------

def build_version(product, app, manifest, runtime, git_commit=None, channel="stable", built_at=None):
    return {
        "product": product,
        "app": app,
        "channel": channel,
        "runtime": runtime,
        "wheels_lock": layer_lock(manifest, "W"),
        "node_modules_lock": layer_lock(manifest, "N"),
        "manifest_sha256": layer_lock(manifest, "A"),
        "built_at": built_at or _utc_now(),
        "git_commit": git_commit or "unknown",
    }


# ---- build-time lookups ---------------------------------------------------

def read_runtime_versions(build_dir):
    """Read the pinned python/node versions straight from 03_fetch_runtimes.py
    so version.json can never drift from what the runtime fetcher installs."""
    py = nd = "unknown"
    try:
        with open(os.path.join(build_dir, "03_fetch_runtimes.py"), encoding="utf-8") as fh:
            txt = fh.read()
        m = re.search(r'PY_VER\s*=\s*"([^"]+)"', txt)
        if m:
            py = m.group(1)
        m = re.search(r'NODE_VER\s*=\s*"([^"]+)"', txt)
        if m:
            nd = m.group(1)
    except OSError:
        pass
    return {"python": py, "node": nd}


def read_app_version(root):
    """app version = single source of truth from root package.json."""
    try:
        with open(os.path.join(root, "package.json"), encoding="utf-8") as fh:
            return json.load(fh).get("version", "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


def git_short_commit(root):
    try:
        out = subprocess.check_output(
            ["git", "-C", root, "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
        )
        return out.decode("utf-8", "replace").strip() or "unknown"
    except Exception:
        return "unknown"


def write_json(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
