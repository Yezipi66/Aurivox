#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
04_pack_release.py — assemble the distributable "extract-and-run" release zip.

What goes IN:
  * source (server.js, lib/, web/ minus node_modules), pre-built web/dist
  * root node_modules (production backend deps) + package*.json
  * tools/ (build + deploy + scripts + wheels + runtime[python+node])
  * root entries: 首次部署.bat 启动.bat 停止.bat, README_用户版.txt,
    requirements.txt, package*.json, business configs (server.js, *.json)
  * tools\deploy\: bootstrap.ps1, install_torch.ps1, download_models.py,
    download_ffmpeg.py (deploy/ops scripts live here, not at the root)
What stays OUT (BLACKLIST — users download / generate):
  * ALL models (~9GB): pretrained / asr / uvr5 weights / *.onnx / *.bin ...
  * vendor/ffmpeg (~275MB, OPTIONAL — only vocal separation; via download_ffmpeg.py)
  * venv/ (built at deploy time), assets/ (your trained chars), voices/ data/
  * .git .staging logs outputs backups caches, web/node_modules, dev junk
  * old temp/dev scripts + leftover patch folders (see EXCLUDE_FILES/TOP_EXCLUDE)
  * *.pdb debug symbols shipped by the embedded python

Run AFTER 01_build_frontend + 02_make_wheelhouse + 03_fetch_runtimes:
    python tools\\build\\04_pack_release.py
    python tools\\build\\04_pack_release.py --version 1.0.0 --out dist\\release.zip
"""

import argparse
import os
import sys
import time
import zipfile

# Directory names dropped ONLY when they sit at the repo TOP level. These are
# generic words ("data", "assets", "output", "dist" ...) that also legitimately
# occur DEEP inside dependencies (e.g. web/dist is our built frontend, and many
# node/python packages ship a "data"/"assets" folder). Matching them by bare
# name at any depth would wrongly delete needed files — that is exactly why an
# earlier build shipped without web/dist. So these are anchored to the top level.
TOP_EXCLUDE = {
    "venv", ".venv", "assets", ".staging",
    "logs", "log", "outputs", "output", "backups", "tmp", "temp",
    "cr-sandbox", "voices", "data", "dist",  # top-level dist = our own output
    # leftover folders from extracting an older distribution-kit patch in place
    "distribution-kit-patch", "root",
}

# Dev/VCS/cache junk safe to drop at ANY depth.
NAME_EXCLUDE = {
    ".git", ".hg", ".svn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".numba_cache", ".cache", ".gradio", ".ipynb_checkpoints",
}

# Specific subtrees (relative paths) to drop wherever they are anchored.
PATH_EXCLUDE = {
    os.path.join("web", "node_modules"),
    # ffmpeg is OPTIONAL (only vocal separation / UVR5 needs it) and ~275MB.
    # Users fetch it on demand via download_ffmpeg.py, so keep it out of source.
    os.path.join("vendor", "ffmpeg"),
    # pure model dirs (no needed code lives here):
    os.path.join("lib", "training", "gsv-tools", "pretrained"),
    os.path.join("lib", "training", "gsv-tools", "asr"),
    os.path.join("lib", "training", "gsv-tools", "uvr5", "uvr5_weights"),
    os.path.join("lib", "training", "gsv_code", "pretrained_models"),
    # SR (24k->48k bandwidth-extension) weights: user-downloaded, not source
    os.path.join("lib", "inference", "sr", "AP_BWE_main", "24kto48k"),
}

# stray model/media files anywhere (keeps sibling json/py/txt that code needs,
# e.g. G2PWModel keeps its dicts but drops the 635MB g2pW.onnx)
EXCLUDE_EXT = {
    ".pth", ".ckpt", ".pt", ".onnx", ".bin", ".safetensors", ".h5", ".pb",
    ".npy", ".npz", ".pkl", ".gguf", ".ggml",
    ".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma",
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
    ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst",
    ".pdb",  # debug symbols (embedded python ships ~50MB of these; unused at runtime)
    ".bak", ".bak2", ".bak3",  # patch backup files
}
# never drop these even if large (runtime + wheels + ffmpeg live here)
KEEP_EXT = {".exe", ".dll", ".whl", ".node", ".pyd", ".so", ".lib"}

# Specific files to drop (BLACKLIST). These are old temp/dev scripts, build
# by-products and stray reports that used to litter the project root. Excluding
# them by exact name keeps the release clean without an allowlist, so newly
# added source files ship automatically (developer-friendly).
EXCLUDE_FILES = {
    # stray reports / caches
    "tree_report.txt", "dump_tree.ps1", "pack_sources.cpython-312.pyc",
    "requirements.lock.current.txt",
    # superseded packer / one-off surgery & patch scripts
    "pack_sources.py", "apply_gsv_patch3.py", "surgery.py", "test_phase4.js",
    # old launchers, replaced by 启动.bat / 停止.bat + tools\scripts\*.ps1
    "start.ps1", "start.vbs", "stop.ps1", "stop.bat",
    "restart.bat", "run_start.bat",
    # superseded by download_models.py wizard
    "configure_models.bat",
}
EXCLUDE_PREFIX = ("sources_",)  # sources_YYYYMMDD.zip snapshots


def root_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))  # tools/build -> root


def norm(p):
    return p.replace("\\", "/")


def in_excluded_tree(rel):
    r = norm(rel)
    # top-level anchored names (e.g. "dist", but NOT "web/dist")
    for t in TOP_EXCLUDE:
        if r == t or r.startswith(t + "/"):
            return True
    # specific subtree paths, wherever anchored
    for t in PATH_EXCLUDE:
        t = norm(t)
        if r == t or r.startswith(t + "/"):
            return True
    return False


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return f"{f:.1f}{u}"
        f /= 1024.0


def main():
    ap = argparse.ArgumentParser(description="Pack the extract-and-run release zip.")
    ap.add_argument("--root", default=None)
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(args.root) if args.root else root_dir()
    top = f"TTS-Broker-{args.version}"
    ts = time.strftime("%Y%m%d_%H%M%S")
    out = os.path.abspath(args.out) if args.out else os.path.join(root, "dist", f"{top}-win-x64-{ts}.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    print("=" * 64)
    print("Pack release  ->", out)
    print("root :", root)
    print("=" * 64)

    included = []
    big = []
    total = 0
    for dp, dns, fns in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        rel_dir = "" if rel_dir == "." else rel_dir
        # prune subtrees
        keep_dns = []
        for d in dns:
            child = os.path.join(rel_dir, d) if rel_dir else d
            if d in NAME_EXCLUDE or in_excluded_tree(child):
                continue
            keep_dns.append(d)
        dns[:] = keep_dns
        if rel_dir and in_excluded_tree(rel_dir):
            continue
        for fn in fns:
            rel = os.path.join(rel_dir, fn) if rel_dir else fn
            full = os.path.join(dp, fn)
            if os.path.abspath(full) == out:
                continue
            if fn in EXCLUDE_FILES or fn.startswith(EXCLUDE_PREFIX):
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext in EXCLUDE_EXT and ext not in KEEP_EXT:
                continue
            try:
                sz = os.path.getsize(full)
            except OSError:
                continue
            included.append((rel, full, sz))
            total += sz
            if sz > 100 * 1024 * 1024:
                big.append((rel, sz))

    included.sort()
    print(f"files: {len(included)}   uncompressed: {human(total)}")

    # show which top-level files ship (quick sanity check that nothing odd slips in)
    root_kept = sorted(r for r, _, _ in included if "/" not in norm(r))
    print("\n[root] top-level files shipped (%d):" % len(root_kept))
    for r in root_kept:
        print("   +", r)

    if big:
        print("\nlarge files kept (sanity-check these are wanted, e.g. ffmpeg/runtime):")
        for rel, sz in sorted(big, key=lambda x: -x[1]):
            print(f"  {human(sz):>9}  {norm(rel)}")

    # runtime/wheels presence warnings
    def has(relpath):
        return any(norm(r).startswith(norm(relpath)) for r, _, _ in included)
    for need, hint in [
        ("web/dist/index.html", "run 01_build_frontend.bat"),
        ("tools/runtime/python/python.exe", "run 03_fetch_runtimes.py"),
        ("tools/runtime/node/node.exe", "run 03_fetch_runtimes.py"),
        ("node_modules", "run 01_build_frontend.bat (root npm install)"),
    ]:
        if not any(norm(r) == norm(need) or norm(r).startswith(norm(need)) for r, _, _ in included):
            print(f"  [WARN] missing {need}  -> {hint}")
    whl = [r for r, _, _ in included if norm(r).startswith("tools/wheels/") and r.endswith(".whl")]
    if not whl:
        print("  [WARN] no wheels in tools/wheels -> run 02_make_wheelhouse.bat (jieba_fast/pyopenjtalk)")

    if args.dry_run:
        print("\n(DRY-RUN) no zip written.")
        return 0

    print("\nwriting zip ...")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, full, _ in included:
            z.write(full, arcname=norm(os.path.join(top, rel)))
    zsize = os.path.getsize(out)
    print("=" * 64)
    print(f"OK  {out}")
    print(f"    compressed: {human(zsize)}   (top folder: {top}/)")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
