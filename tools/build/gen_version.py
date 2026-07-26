#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_version.py — generate version.json (the update single-source-of-truth).

`app` is read from package.json; the layer lock fingerprints
(wheels_lock / node_modules_lock / manifest_sha256) are computed from a
manifest so they always match a concrete build. If no --manifest is given, one
is generated on the fly from the source root (same rules as the packer).

Usage:
    python tools\\build\\gen_version.py                                  # -> dist\\version.json
    python tools\\build\\gen_version.py --manifest dist\\manifest-1.0.1.json --out dist\\version.json

Stdlib only.
"""

import argparse
import importlib.util
import json
import os
import sys

import pack_common

PRODUCT = "Aurivox"


def _load_packer():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "04_pack_release.py")
    spec = importlib.util.spec_from_file_location("_pack_release", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser(description="Generate version.json.")
    ap.add_argument("--root", default=None, help="source root (default: repo root)")
    ap.add_argument("--manifest", default=None, help="reuse an existing manifest json")
    ap.add_argument("--version", default=None)
    ap.add_argument("--channel", default="stable")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    build_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(args.root) if args.root else os.path.dirname(os.path.dirname(build_dir))

    if args.manifest:
        with open(args.manifest, encoding="utf-8") as fh:
            manifest = json.load(fh)
        version = args.version or manifest.get("app") or pack_common.read_app_version(root)
    else:
        packer = _load_packer()
        version = args.version or pack_common.read_app_version(root)
        included = packer.collect_included(root)
        manifest = pack_common.build_manifest(PRODUCT, version, included)

    ver = pack_common.build_version(
        PRODUCT, version, manifest,
        runtime=pack_common.read_runtime_versions(build_dir),
        git_commit=pack_common.git_short_commit(root),
        channel=args.channel,
    )

    out = os.path.abspath(args.out) if args.out else os.path.join(root, "dist", "version.json")
    pack_common.write_json(out, ver)

    print("version.json ->", out)
    print("  app              :", ver["app"])
    print("  runtime          : python", ver["runtime"]["python"], "/ node", ver["runtime"]["node"])
    print("  wheels_lock      :", ver["wheels_lock"])
    print("  node_modules_lock:", ver["node_modules_lock"])
    print("  manifest_sha256  :", ver["manifest_sha256"])
    print("  git_commit       :", ver["git_commit"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
