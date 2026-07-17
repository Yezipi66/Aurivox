#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_ffmpeg.py — project-local ffmpeg provisioning (Windows-only, no global footprint).

Purpose (PH): the broker transcodes the engine's WAV output to mp3/opus/aac/flac
via ffmpeg. In addition, the training pipeline's UVR5 step (gsv-tools/uvr5/webui.py)
probes/reformats inputs with ffprobe + ffmpeg. Rather than requiring the user to
install ffmpeg system-wide (which touches PATH / package managers / admin rights),
this script downloads a static ffmpeg build and unpacks BOTH executables INTO the
project at:

    vendor/ffmpeg/windows-x86_64/ffmpeg.exe
    vendor/ffmpeg/windows-x86_64/ffprobe.exe

The Node server (server.js -> vendoredFfmpegPath()) prefers this project-local
binary, falls back to a system ffmpeg on PATH, and finally degrades to WAV.
Nothing here modifies the global PATH, environment variables, or the registry.

Aurivox is a Windows-only distribution, so ONLY the Windows x86_64 build is
provisioned. The download URL and license classification are the single source
of truth in THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json (falls back to a built-in
default if that file is unavailable). FFmpeg is NOT bundled/redistributed by
Aurivox — the GPL license text and corresponding-source obligations travel with
this upstream download and rest with the distributor (BtbN), not with Aurivox.

Design principles (mirrors download_models.py):
  * No hardcoded absolute paths; project root is auto-detected, override with --dest.
  * Idempotent: already-present, runnable binaries are skipped unless --force.
  * Stdlib-only download (urllib) with a streamed write; no third-party deps.
  * Verifies each extracted binary actually runs (`<bin> -version`).

Usage:
    python download_ffmpeg.py            # provision ffmpeg + ffprobe
    python download_ffmpeg.py --check    # report status only, download nothing
    python download_ffmpeg.py --force    # re-download even if present
    python download_ffmpeg.py --dest /path/to/project
"""

import argparse
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

# Windows-only distribution: a single platform key (matches server.js
# vendoredFfmpegPath(), which pushes "windows-x86_64" on win32).
PLATFORM_KEY = "windows-x86_64"
MEMBERS = ["ffmpeg.exe", "ffprobe.exe"]

# Built-in default source (BtbN win64-gpl static build). Overridden at runtime by
# THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json when present (single source of truth).
DEFAULT_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip"
)


def project_root(dest):
    if dest:
        return os.path.abspath(dest)
    # This script lives under tools/deploy/. Resolve the PROJECT ROOT by walking
    # up to the folder that contains server.js; fall back to two levels up.
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(5):
        if os.path.exists(os.path.join(cur, "server.js")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.path.dirname(os.path.dirname(here))


def source_url(root):
    """Read the Windows download URL from EXTERNAL_TOOLS.json; fall back to DEFAULT_URL."""
    candidates = [
        os.path.join(root, "THIRD_PARTY_LICENSES", "EXTERNAL_TOOLS.json"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "THIRD_PARTY_LICENSES", "EXTERNAL_TOOLS.json"),
    ]
    for p in candidates:
        try:
            with open(p, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            for tool in data.get("tools", []):
                if tool.get("tool_id") == "ffmpeg":
                    url = (tool.get("distribution_sources") or {}).get(PLATFORM_KEY)
                    if url:
                        return url
        except Exception:
            continue
    return DEFAULT_URL


def platform_dir(root):
    return os.path.join(root, "vendor", "ffmpeg", PLATFORM_KEY)


def target_path(root, member_basename):
    return os.path.join(platform_dir(root), member_basename)


def is_runnable(binary):
    """True if `binary` exists and `<binary> -version` succeeds."""
    if not (binary and os.path.isfile(binary)):
        return False
    try:
        subprocess.run([binary, "-version"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=True)
        return True
    except Exception:
        return False


def _human(n):
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024


def _progress(done, total, width=36):
    if total > 0:
        frac = min(done / total, 1.0)
        filled = int(width * frac)
        bar = "#" * filled + "-" * (width - filled)
        msg = f"\r[ffmpeg] [{bar}] {frac*100:5.1f}%  {_human(done)}/{_human(total)}"
    else:
        msg = f"\r[ffmpeg] {_human(done)} downloaded"
    end = "\n" if (total > 0 and done >= total) else ""
    print(msg, end=end, file=sys.stderr, flush=True)


def _download(url, out_path):
    print(f"[ffmpeg] downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker/ffmpeg-setup"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(out_path, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        chunk = 1024 * 256
        done = 0
        show = sys.stderr.isatty()
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            fh.write(buf)
            done += len(buf)
            if show:
                _progress(done, total)
        if show and total <= 0:
            print(file=sys.stderr)

    size = os.path.getsize(out_path)
    if size < 1024 * 1024:
        raise RuntimeError(f"downloaded archive is implausibly small ({size} bytes)")
    print(f"[ffmpeg] downloaded {size / (1024 * 1024):.1f} MiB")


def _make_executable(dest_binary):
    mode = os.stat(dest_binary).st_mode
    os.chmod(dest_binary, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _extract_members(archive, member_basenames, dest_dir):
    """Extract the requested executables out of the (zip) archive into dest_dir."""
    os.makedirs(dest_dir, exist_ok=True)
    wanted = set(member_basenames)
    found = []
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            base = os.path.basename(name)
            if base in wanted:
                dest_binary = os.path.join(dest_dir, base)
                with zf.open(name) as sfh, open(dest_binary, "wb") as dfh:
                    shutil.copyfileobj(sfh, dfh)
                _make_executable(dest_binary)
                found.append(base)
                wanted.discard(base)
    if wanted:
        print(f"[ffmpeg] WARNING: not found inside archive: {', '.join(sorted(wanted))}",
              file=sys.stderr)
    return found


def provision(root, force):
    dest_dir = platform_dir(root)
    missing = [m for m in MEMBERS if force or not is_runnable(target_path(root, m))]
    if not missing:
        print(f"[ffmpeg] already present and runnable: {', '.join(MEMBERS)} in {dest_dir}")
        return dest_dir

    url = source_url(root)
    tmpdir = tempfile.mkdtemp(prefix="ffmpeg-dl-")
    try:
        archive = os.path.join(tmpdir, "ffmpeg-archive.zip")
        _download(url, archive)
        print(f"[ffmpeg] extracting {', '.join(missing)} -> {dest_dir}")
        _extract_members(archive, missing, dest_dir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    not_runnable = [m for m in MEMBERS if not is_runnable(target_path(root, m))]
    if not_runnable:
        raise RuntimeError(f"extracted binaries are not runnable: {', '.join(not_runnable)}")
    print(f"[ffmpeg] OK: {', '.join(MEMBERS)} in {dest_dir}")
    return dest_dir


def main():
    ap = argparse.ArgumentParser(
        description="Provision a project-local ffmpeg + ffprobe on Windows (no global changes).")
    ap.add_argument("--dest", default=None, help="Project root (default: auto-detected).")
    ap.add_argument("--force", action="store_true", help="Re-download even if already present.")
    ap.add_argument("--check", action="store_true", help="Report status only; download nothing.")
    args = ap.parse_args()

    if platform.system().lower() != "windows":
        print(f"[ffmpeg] unsupported platform: {platform.system()} (Aurivox is Windows-only).",
              file=sys.stderr)
        print("[ffmpeg] install ffmpeg + ffprobe manually and ensure they are on PATH.",
              file=sys.stderr)
        return 2

    root = project_root(args.dest)

    if args.check:
        print(f"[ffmpeg] platform     : {PLATFORM_KEY}")
        overall = True
        for m in MEMBERS:
            dest = target_path(root, m)
            local_ok = is_runnable(dest)
            print(f"[ffmpeg] project-local: {m:<12} {'present' if local_ok else 'absent'} ({dest})")
            sys_ok = is_runnable(shutil.which(os.path.splitext(m)[0]))
            print(f"[ffmpeg] system PATH  : {m:<12} {'present' if sys_ok else 'absent'}")
            overall = overall and (local_ok or sys_ok)
        return 0 if overall else 1

    try:
        provision(root, args.force)
        return 0
    except Exception as e:
        print(f"[ffmpeg] provisioning failed: {e}", file=sys.stderr)
        print("[ffmpeg] the broker will fall back to a system ffmpeg or WAV-only.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
