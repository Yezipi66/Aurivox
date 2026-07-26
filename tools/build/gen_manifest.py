#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_manifest.py — generate manifest-<ver>.json for a release tree.

Two modes:
  * default : walk a SOURCE ROOT with the very same release blacklist the packer
              uses (04_pack_release.collect_included), so the manifest matches
              what 04_pack_release would ship.
  * --tree  : walk an already-EXTRACTED release folder as-is (every file under
              it, minus dev/VCS junk). Use this to fingerprint a downloaded /
              installed release when diffing for a patch (P1).

Usage:
    python tools\\build\\gen_manifest.py                         # source root -> dist\\manifest-<ver>.json
    python tools\\build\\gen_manifest.py --root . --version 1.0.1 --out dist\\manifest-1.0.1.json
    python tools\\build\\gen_manifest.py --tree "C:\\Aurivox-1.0.0" --out m0.json

Stdlib only.
"""

import argparse
import importlib.util
import os
import sys

import pack_common

PRODUCT = "Aurivox"


def _load_packer():
    """04_pack_release.py can't be imported normally (module name starts with a
    digit), so load it by path to reuse collect_included() + the blacklist."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "04_pack_release.py")
    spec = importlib.util.spec_from_file_location("_pack_release", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _walk_tree(root):
    """Every file under an extracted release, dropping only VCS/cache junk."""
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in pack_common_junk_dirs()]
        for fn in fns:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, root)
            try:
                sz = os.path.getsize(full)
            except OSError:
                continue
            files.append((rel, full, sz))
    files.sort()
    return files


def pack_common_junk_dirs():
    return {".git", ".hg", ".svn", "__pycache__", ".pytest_cache",
            ".mypy_cache", ".ruff_cache", ".cache"}


def main():
    ap = argparse.ArgumentParser(description="Generate a release manifest.")
    ap.add_argument("--root", default=None, help="source root (default: repo root)")
    ap.add_argument("--tree", default=None, help="scan an extracted release folder as-is")
    ap.add_argument("--version", default=None, help="app version (default: from package.json)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.tree:
        base = os.path.abspath(args.tree)
        included = _walk_tree(base)
        root_for_meta = base
    else:
        packer = _load_packer()
        base = os.path.abspath(args.root) if args.root else packer.root_dir()
        included = packer.collect_included(base)
        root_for_meta = base

    version = args.version or pack_common.read_app_version(root_for_meta) if not args.tree else (args.version or "unknown")
    manifest = pack_common.build_manifest(PRODUCT, version, included)

    out = os.path.abspath(args.out) if args.out else os.path.join(base if args.tree else os.path.join(root_for_meta, "dist"), f"manifest-{version}.json")
    pack_common.write_json(out, manifest)

    counts = {}
    for e in manifest["files"]:
        counts[e["layer"]] = counts.get(e["layer"], 0) + 1
    print("manifest ->", out)
    print("files    :", len(manifest["files"]))
    print("layers   :", "  ".join(f"{k}:{counts.get(k, 0)}" for k in ("A", "R", "W", "N", "M")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
