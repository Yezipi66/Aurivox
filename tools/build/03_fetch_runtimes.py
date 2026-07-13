#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
03_fetch_runtimes.py — download the EMBEDDED runtimes into tools/runtime/.

Populates (Windows x64):
  tools/runtime/python/python.exe   <- python-build-standalone 3.11 (relocatable,
                                        full CPython: supports venv/pip/C-extensions)
  tools/runtime/node/node.exe       <- portable Node LTS (runs server.js)

Run this on your DEV machine (system Python 3.x) BEFORE packing the release:
    python tools\\build\\03_fetch_runtimes.py
    python tools\\build\\03_fetch_runtimes.py --force     # re-download

Stdlib only. Pinned versions below — bump them here when you want newer runtimes.
"""

import argparse
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

# --- pinned versions (edit here to upgrade) -------------------------------
PY_TAG   = "20240814"
PY_VER   = "3.11.9"
PY_URL   = (f"https://github.com/astral-sh/python-build-standalone/releases/download/"
            f"{PY_TAG}/cpython-{PY_VER}+{PY_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz")

NODE_VER = "20.17.0"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VER}/node-v{NODE_VER}-win-x64.zip"


def root():
    # tools/build/03_fetch_runtimes.py -> tools -> <root>
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return f"{f:.1f}{u}"
        f /= 1024.0


def download(url, out):
    print(f"[fetch] {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker/build"})
    with urllib.request.urlopen(req, timeout=180) as r, open(out, "wb") as fh:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        chunk = 1024 * 256
        while True:
            buf = r.read(chunk)
            if not buf:
                break
            fh.write(buf)
            done += len(buf)
            if total:
                pct = done * 100.0 / total
                print(f"\r[fetch]   {human(done)}/{human(total)}  {pct:5.1f}%", end="", file=sys.stderr)
    print("", file=sys.stderr)
    size = os.path.getsize(out)
    if size < 1024 * 1024:
        raise RuntimeError(f"downloaded file too small ({size} bytes) — bad URL?")
    print(f"[fetch] saved {human(size)}")


def fetch_python(dest_dir, force):
    target = os.path.join(dest_dir, "python", "python.exe")
    if os.path.isfile(target) and not force:
        print(f"[python] already present: {target}")
        return
    if force:
        shutil.rmtree(os.path.join(dest_dir, "python"), ignore_errors=True)
    tmp = tempfile.mkdtemp(prefix="py-dl-")
    try:
        arc = os.path.join(tmp, "python.tar.gz")
        download(PY_URL, arc)
        print("[python] extracting ...")
        with tarfile.open(arc, "r:gz") as tf:
            tf.extractall(dest_dir)   # yields dest_dir/python/...
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not os.path.isfile(target):
        raise RuntimeError(f"python.exe not found after extract: {target}")
    print(f"[python] OK -> {target}")


def fetch_node(dest_dir, force):
    target = os.path.join(dest_dir, "node", "node.exe")
    if os.path.isfile(target) and not force:
        print(f"[node] already present: {target}")
        return
    if force:
        shutil.rmtree(os.path.join(dest_dir, "node"), ignore_errors=True)
    tmp = tempfile.mkdtemp(prefix="node-dl-")
    try:
        arc = os.path.join(tmp, "node.zip")
        download(NODE_URL, arc)
        print("[node] extracting ...")
        with zipfile.ZipFile(arc) as zf:
            zf.extractall(tmp)
        extracted = os.path.join(tmp, f"node-v{NODE_VER}-win-x64")
        if not os.path.isdir(extracted):
            # find the single top dir
            subs = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d)) and d.startswith("node-")]
            if not subs:
                raise RuntimeError("node archive layout unexpected")
            extracted = os.path.join(tmp, subs[0])
        node_dst = os.path.join(dest_dir, "node")
        if os.path.isdir(node_dst):
            shutil.rmtree(node_dst, ignore_errors=True)
        shutil.move(extracted, node_dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not os.path.isfile(target):
        raise RuntimeError(f"node.exe not found after extract: {target}")
    print(f"[node] OK -> {target}")


def main():
    ap = argparse.ArgumentParser(description="Fetch embedded Python + Node runtimes.")
    ap.add_argument("--force", action="store_true", help="re-download even if present")
    ap.add_argument("--only", choices=["python", "node"], help="fetch only one runtime")
    args = ap.parse_args()

    dest = os.path.join(root(), "tools", "runtime")
    os.makedirs(dest, exist_ok=True)
    print("=" * 60)
    print("Fetch embedded runtimes -> tools/runtime")
    print(f"  python : {PY_VER} (python-build-standalone {PY_TAG})")
    print(f"  node   : {NODE_VER}")
    print("=" * 60)

    try:
        if args.only in (None, "python"):
            fetch_python(dest, args.force)
        if args.only in (None, "node"):
            fetch_node(dest, args.force)
    except Exception as e:
        print(f"[fetch][ERROR] {e}", file=sys.stderr)
        return 1
    print("\n[done] runtimes ready under tools/runtime/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
