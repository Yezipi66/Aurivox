#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_ffmpeg.py — project-local ffmpeg provisioning (no global footprint).

Purpose (PH): the broker transcodes the engine's WAV output to mp3/opus/aac/flac
via ffmpeg. Rather than requiring the user to install ffmpeg system-wide (which
touches PATH / package managers / admin rights), this script downloads a static
ffmpeg build and unpacks it INTO the project at:

    vendor/ffmpeg/<platform>/ffmpeg[.exe]

The Node server (server.js -> resolveFfmpeg()) prefers this project-local binary,
falls back to a system ffmpeg on PATH, and finally degrades to WAV. Nothing here
modifies PATH, environment variables, the registry, or any global location.

Design principles (mirrors download_models.py):
  * No hardcoded absolute paths; project root is auto-detected, override with --dest.
  * Idempotent: an already-present, runnable binary is skipped unless --force.
  * Stdlib-only download (urllib) with a streamed write; no third-party deps.
  * Cross-platform: picks the right static build for Windows / Linux / macOS.
  * Verifies the extracted binary actually runs (`ffmpeg -version`).

Usage:
    python download_ffmpeg.py            # provision for the current platform
    python download_ffmpeg.py --check    # report status only, download nothing
    python download_ffmpeg.py --force    # re-download even if present
    python download_ffmpeg.py --dest /path/to/project
"""

import argparse
import os
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

# ---------------------------------------------------------------------------
# Static-build sources per platform. These are widely used, redistributable
# static ffmpeg builds. Each entry: (url, archive_kind, member_glob).
#   - archive_kind: "zip" | "tar.xz"
#   - member_glob : basename of the ffmpeg executable inside the archive.
# Mirrors can be swapped by editing these URLs (kept minimal + explicit).
# ---------------------------------------------------------------------------
SOURCES = {
    "windows-x86_64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-win64-gpl.zip",
        "zip", "ffmpeg.exe",
    ),
    "linux-x86_64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-linux64-gpl.tar.xz",
        "tar.xz", "ffmpeg",
    ),
    "linux-aarch64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
        "tar.xz", "ffmpeg",
    ),
    # macOS: evermeet.cx publishes notarized static builds (Intel binaries run
    # on Apple Silicon via Rosetta).
    "darwin-x86_64": (
        "https://evermeet.cx/ffmpeg/getrelease/zip",
        "zip", "ffmpeg",
    ),
    "darwin-arm64": (
        "https://evermeet.cx/ffmpeg/getrelease/zip",
        "zip", "ffmpeg",
    ),
}


def detect_platform():
    """Return the SOURCES key for the running platform, or None if unsupported."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows":
        return "windows-x86_64"
    if system == "linux":
        if machine in ("aarch64", "arm64"):
            return "linux-aarch64"
        return "linux-x86_64"
    if system == "darwin":
        if machine in ("arm64", "aarch64"):
            return "darwin-arm64"
        return "darwin-x86_64"
    return None


def project_root(dest):
    if dest:
        return os.path.abspath(dest)
    # This file lives at the project root next to server.js.
    return os.path.dirname(os.path.abspath(__file__))


def platform_dir(root, plat_key):
    return os.path.join(root, "vendor", "ffmpeg", plat_key)


def exe_name(plat_key):
    return "ffmpeg.exe" if plat_key.startswith("windows") else "ffmpeg"


def target_path(root, plat_key):
    return os.path.join(platform_dir(root, plat_key), exe_name(plat_key))


def is_runnable(binary):
    """True if `binary` exists and `ffmpeg -version` succeeds."""
    if not (binary and os.path.isfile(binary)):
        return False
    try:
        subprocess.run([binary, "-version"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=True)
        return True
    except Exception:
        return False

def _human(n):
    """Bytes -> human-readable string."""
    for unit in ("B", "KiB", "MiB", "GiB"):
        if n < 1024 or unit == "GiB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024

def _progress(done, total, width=36):
    """Render a single-line progress bar to stderr (overwritten in place)."""
    if total > 0:
        frac = min(done / total, 1.0)
        filled = int(width * frac)
        bar = "#" * filled + "-" * (width - filled)
        msg = f"\r[ffmpeg] [{bar}] {frac*100:5.1f}%  {_human(done)}/{_human(total)}"
    else:
        # Server didn't send Content-Length; show bytes only.
        msg = f"\r[ffmpeg] {_human(done)} downloaded"
    # \r keeps it on one line; only add newline when finished.
    end = "\n" if (total > 0 and done >= total) else ""
    print(msg, end=end, file=sys.stderr, flush=True)


def _download(url, out_path):
    print(f"[ffmpeg] downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker/ffmpeg-setup"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(out_path, "wb") as fh:
        # Content-Length may be missing (e.g. some CDN redirects) -> total = 0.
        total = int(resp.headers.get("Content-Length") or 0)
        chunk = 1024 * 256
        done = 0
        show = sys.stderr.isatty()   # only animate when attached to a terminal
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            fh.write(buf)
            done += len(buf)
            if show:
                _progress(done, total)
        if show and total <= 0:
            print(file=sys.stderr)   # newline to close the indeterminate line

    size = os.path.getsize(out_path)
    if size < 1024 * 1024:
        raise RuntimeError(f"downloaded archive is implausibly small ({size} bytes)")
    print(f"[ffmpeg] downloaded {size / (1024 * 1024):.1f} MiB")

def _extract_member(archive, kind, member_basename, dest_binary):
    """Extract the ffmpeg executable out of the archive to dest_binary."""
    os.makedirs(os.path.dirname(dest_binary), exist_ok=True)
    if kind == "zip":
        with zipfile.ZipFile(archive) as zf:
            names = [n for n in zf.namelist()
                     if os.path.basename(n) == member_basename and not n.endswith("/")]
            if not names:
                raise RuntimeError(f"{member_basename} not found inside archive")
            src = names[0]
            with zf.open(src) as sfh, open(dest_binary, "wb") as dfh:
                shutil.copyfileobj(sfh, dfh)
    elif kind == "tar.xz":
        import tarfile
        with tarfile.open(archive, "r:xz") as tf:
            member = next((m for m in tf.getmembers()
                           if os.path.basename(m.name) == member_basename and m.isfile()), None)
            if member is None:
                raise RuntimeError(f"{member_basename} not found inside archive")
            with tf.extractfile(member) as sfh, open(dest_binary, "wb") as dfh:
                shutil.copyfileobj(sfh, dfh)
    else:
        raise RuntimeError(f"unknown archive kind: {kind}")

    # Make it executable (no-op semantics on Windows, required on POSIX).
    mode = os.stat(dest_binary).st_mode
    os.chmod(dest_binary, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def provision(root, plat_key, force):
    url, kind, member = SOURCES[plat_key]
    dest = target_path(root, plat_key)

    if not force and is_runnable(dest):
        print(f"[ffmpeg] already present and runnable: {dest}")
        return dest

    tmpdir = tempfile.mkdtemp(prefix="ffmpeg-dl-")
    try:
        archive = os.path.join(tmpdir, "ffmpeg-archive")
        _download(url, archive)
        print(f"[ffmpeg] extracting {member} -> {dest}")
        _extract_member(archive, kind, member, dest)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not is_runnable(dest):
        raise RuntimeError(f"extracted binary is not runnable: {dest}")
    print(f"[ffmpeg] OK: {dest}")
    return dest


def main():
    ap = argparse.ArgumentParser(description="Provision a project-local ffmpeg (no global changes).")
    ap.add_argument("--dest", default=None, help="Project root (default: this script's folder).")
    ap.add_argument("--force", action="store_true", help="Re-download even if already present.")
    ap.add_argument("--check", action="store_true", help="Report status only; download nothing.")
    args = ap.parse_args()

    plat_key = detect_platform()
    if not plat_key:
        print(f"[ffmpeg] unsupported platform: {platform.system()} / {platform.machine()}", file=sys.stderr)
        print("[ffmpeg] install ffmpeg manually and ensure it is on PATH.", file=sys.stderr)
        return 2

    root = project_root(args.dest)
    dest = target_path(root, plat_key)

    if args.check:
        local_ok = is_runnable(dest)
        system_ok = is_runnable(shutil.which("ffmpeg"))
        print(f"[ffmpeg] platform     : {plat_key}")
        print(f"[ffmpeg] project-local: {'present' if local_ok else 'absent'} ({dest})")
        print(f"[ffmpeg] system PATH  : {'present' if system_ok else 'absent'}")
        return 0 if (local_ok or system_ok) else 1

    try:
        provision(root, plat_key, args.force)
        return 0
    except Exception as e:
        print(f"[ffmpeg] provisioning failed: {e}", file=sys.stderr)
        print("[ffmpeg] the broker will fall back to a system ffmpeg or WAV-only.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
