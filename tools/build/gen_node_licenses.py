#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gen_node_licenses.py — inventory the BACKEND (root) production npm dependency
closure and its per-package licenses into
    THIRD_PARTY_LICENSES/runtime/node_packages.json

Why this exists
---------------
`node_modules` is NOT bundled in the release (04_pack_release.py keeps it out to
shrink the zip AND avoid physically redistributing third-party npm packages); it
is restored on the target by `npm ci` (bootstrap.ps1). The deploy wizard's
"第二层" (bundled code / runtime / deps) license view wants to enumerate those
backend deps, but the release had no machine-readable inventory for them —
parallel to runtime/python_packages.json for the PyPI closure.

This script produces that inventory from AUTHORITATIVE on-disk metadata
(each installed node_modules/<pkg>/package.json), so we never hand-assert a
license: whatever the package itself declares is what we record.

When to run
-----------
AFTER `npm ci`, on a machine that has node_modules restored (build machine or,
via the bootstrap hook, the deploy target). It is idempotent — safe to re-run.

    python tools/build/gen_node_licenses.py --root <appRoot>
    python tools/build/gen_node_licenses.py --root . --out some/where.json

Dependency SET resolution (priority order)
------------------------------------------
  1. <root>/package-lock.json (lockfileVersion 2/3 `packages`) — production
     closure only (entries flagged "dev": true are dropped). Most accurate.
  2. else <root>/package.json "dependencies" (direct production deps only).

For each package, version + license are read from the INSTALLED
node_modules/<pkg>/package.json (falling back to the lockfile's own "license"
field, else "UNKNOWN"). Stdlib only; Windows/Unix agnostic.
"""

import argparse
import json
import os
import sys
import time


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _norm_license(pkg):
    """Normalize a package.json license declaration to an SPDX-ish string.
    Handles: "license":"MIT"; "license":{"type":"MIT"}; legacy
    "licenses":[{"type":"MIT"}, ...]. Returns "UNKNOWN" when nothing usable."""
    if not isinstance(pkg, dict):
        return "UNKNOWN"
    lic = pkg.get("license")
    if isinstance(lic, str) and lic.strip():
        return lic.strip()
    if isinstance(lic, dict):
        t = lic.get("type")
        if isinstance(t, str) and t.strip():
            return t.strip()
    lics = pkg.get("licenses")
    if isinstance(lics, list):
        parts = []
        for entry in lics:
            if isinstance(entry, dict) and entry.get("type"):
                parts.append(str(entry["type"]).strip())
            elif isinstance(entry, str) and entry.strip():
                parts.append(entry.strip())
        if parts:
            return " OR ".join(dict.fromkeys(parts))
    return "UNKNOWN"


def _installed_meta(root, rel_dir, name):
    """Read version+license from an installed package's package.json.
    rel_dir is the on-disk path (relative to root) of the package (e.g.
    'node_modules/express'). Falls back to node_modules/<name> if rel_dir is
    absent. Returns (version|None, license|None)."""
    candidates = []
    if rel_dir:
        candidates.append(os.path.join(root, rel_dir, "package.json"))
    if name:
        candidates.append(os.path.join(root, "node_modules", *name.split("/"), "package.json"))
    for p in candidates:
        pj = _read_json(p)
        if pj:
            return pj.get("version"), _norm_license(pj)
    return None, None


def _from_lockfile(root, lock):
    """Yield dependency records from a lockfileVersion 2/3 `packages` map,
    production-only (drop dev). Each record: (name, path, version, lock_license)."""
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        return []
    out = []
    for path, entry in packages.items():
        if path == "" or not isinstance(entry, dict):
            continue  # skip the project root itself
        if entry.get("dev") or entry.get("devOptional"):
            continue  # production closure only
        # logical name = segment after the LAST 'node_modules/'
        marker = "node_modules/"
        name = path[path.rfind(marker) + len(marker):] if marker in path else path
        out.append((name, path, entry.get("version"), _norm_license(entry)
                    if entry.get("license") else None))
    return out


def _from_package_json(root, pkg):
    """Fallback: direct production dependencies only (no transitive closure)."""
    deps = pkg.get("dependencies") if isinstance(pkg, dict) else None
    if not isinstance(deps, dict):
        return []
    out = []
    for name in sorted(deps):
        out.append((name, os.path.join("node_modules", *name.split("/")), None, None))
    return out


def build_inventory(root):
    root = os.path.abspath(root)
    lock = _read_json(os.path.join(root, "package-lock.json"))
    pkg = _read_json(os.path.join(root, "package.json"))
    if pkg is None:
        raise SystemExit("[gen_node_licenses] no package.json at %s" % root)

    if lock:
        raw = _from_lockfile(root, lock)
        source = "package-lock.json (production closure)"
    else:
        raw = _from_package_json(root, pkg)
        source = "package.json (direct production deps only — package-lock.json absent)"

    seen, packages = set(), []
    for name, path, ver, lock_lic in raw:
        key = (name, ver)
        if key in seen:
            continue
        seen.add(key)
        inst_ver, inst_lic = _installed_meta(root, path, name)
        version = inst_ver or ver or "unknown"
        license_ = inst_lic or lock_lic or "UNKNOWN"
        packages.append({"name": name, "version": version, "license": license_,
                         "path": path.replace("\\", "/")})

    packages.sort(key=lambda p: (p["name"].lower(), p["version"]))

    by_license = {}
    for p in packages:
        by_license.setdefault(p["license"], 0)
        by_license[p["license"]] += 1

    return {
        "schema": 1,
        "kind": "backend_node_production_dependencies",
        "note": ("Machine-readable inventory of the BACKEND (root) production npm "
                 "dependency closure and each package's SELF-DECLARED license. "
                 "node_modules is NOT bundled in the release; it is restored on the "
                 "target by `npm ci` (bootstrap.ps1). This file is GENERATED (not "
                 "hand-maintained) by tools/build/gen_node_licenses.py from the "
                 "installed node_modules/<pkg>/package.json, so we never hand-assert "
                 "a license. The deploy wizard reads it to display backend deps under "
                 "the second license layer. Parallel to python_packages.json."),
        "generated_by": "tools/build/gen_node_licenses.py",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "count": len(packages),
        "by_license": dict(sorted(by_license.items())),
        "packages": packages,
    }


def main():
    ap = argparse.ArgumentParser(description="Inventory backend node production deps -> node_packages.json")
    ap.add_argument("--root", default=".", help="app root holding package.json / node_modules (default: .)")
    ap.add_argument("--out", default=None,
                    help="output path (default: <root>/THIRD_PARTY_LICENSES/runtime/node_packages.json)")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    inv = build_inventory(root)
    out = os.path.abspath(args.out) if args.out else os.path.join(
        root, "THIRD_PARTY_LICENSES", "runtime", "node_packages.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(inv, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print("node_packages.json ->", out)
    print("source   :", inv["source"])
    print("packages :", inv["count"])
    print("licenses :", "  ".join("%s:%d" % (k, v) for k, v in inv["by_license"].items()))
    unknown = [p["name"] for p in inv["packages"] if p["license"] == "UNKNOWN"]
    if unknown:
        print("  [note] %d package(s) declared no license (install node_modules and "
              "re-run for authoritative data): %s" % (len(unknown), ", ".join(unknown[:12])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
