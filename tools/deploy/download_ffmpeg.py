#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_ffmpeg.py — project-local ffmpeg provisioning (no global footprint).

Purpose (PH): the broker transcodes the engine's WAV output to mp3/opus/aac/flac
via ffmpeg. In addition, the training pipeline's UVR5 step (gsv-tools/uvr5/webui.py)
probes/reformats inputs with ffprobe + ffmpeg. Rather than requiring the user to
install ffmpeg system-wide (which touches PATH / package managers / admin rights),
this script downloads a static ffmpeg build and unpacks BOTH executables INTO the
project at:

    vendor/ffmpeg/<platform>/ffmpeg[.exe]
    vendor/ffmpeg/<platform>/ffprobe[.exe]

The Node server (server.js -> resolveFfmpeg()) prefers this project-local binary,
falls back to a system ffmpeg on PATH, and finally degrades to WAV. The training
denoise step (lib/training/steps/denoise.js) prepends this vendor dir onto the
child PATH so `ffprobe` / `ffmpeg` resolve for webui.py. Nothing here modifies the
global PATH, environment variables, the registry, or any global location.

Design principles (mirrors download_models.py):
  * No hardcoded absolute paths; project root is auto-detected, override with --dest.
  * Idempotent: already-present, runnable binaries are skipped unless --force.
  * Stdlib-only download (urllib) with a streamed write; no third-party deps.
  * Cross-platform: picks the right static build for Windows / Linux / macOS.
  * Verifies each extracted binary actually runs (`<bin> -version`).

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
# static ffmpeg builds. Each entry: (url, archive_kind, [member_basenames]).
#   - archive_kind   : "zip" | "tar.xz"
#   - member_basenames: basenames of the executables to pull out of the archive.
#                       Both ffmpeg and ffprobe ship in the same build.
# Mirrors can be swapped by editing these URLs (kept minimal + explicit).
# ---------------------------------------------------------------------------
SOURCES = {
    "windows-x86_64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-win64-gpl.zip",
        "zip", ["ffmpeg.exe", "ffprobe.exe"],
    ),
    "linux-x86_64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-linux64-gpl.tar.xz",
        "tar.xz", ["ffmpeg", "ffprobe"],
    ),
    "linux-aarch64": (
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
        "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
        "tar.xz", ["ffmpeg", "ffprobe"],
    ),
    # macOS: evermeet.cx publishes notarized static builds (Intel binaries run
    # on Apple Silicon via Rosetta). ffmpeg and ffprobe are published as
    # SEPARATE zip archives, so each member carries its own download URL.
    "darwin-x86_64": (
        "https://evermeet.cx/ffmpeg/getrelease/zip",
        "zip", ["ffmpeg"],
        {"ffprobe": "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"},
    ),
    "darwin-arm64": (
        "https://evermeet.cx/ffmpeg/getrelease/zip",
        "zip", ["ffmpeg"],
        {"ffprobe": "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip"},
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
    # This script lives under tools/deploy/. Resolve the PROJECT ROOT by walking
    # up to the folder that contains server.js; fall back to two levels up
    # (tools/deploy -> tools -> root).
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


def platform_dir(root, plat_key):
    return os.path.join(root, "vendor", "ffmpeg", plat_key)


def is_windows(plat_key):
    return plat_key.startswith("windows")


def _members(plat_key):
    """Return the list of member basenames to provision for this platform."""
    return SOURCES[plat_key][2]


def _extra_urls(plat_key):
    """Optional {member_basename: url} for members shipped as separate archives."""
    entry = SOURCES[plat_key]
    return entry[3] if len(entry) > 3 else {}


def target_path(root, plat_key, member_basename):
    """Absolute path where a given executable should land inside the project."""
    return os.path.join(platform_dir(root, plat_key), member_basename)


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


def _make_executable(dest_binary):
    # Make it executable (no-op semantics on Windows, required on POSIX).
    mode = os.stat(dest_binary).st_mode
    os.chmod(dest_binary, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _extract_members(archive, kind, member_basenames, dest_dir):
    """Extract the requested executables out of the archive into dest_dir.

    Returns the list of member basenames that were successfully extracted.
    Missing members are reported (warning) rather than fatal, so that a build
    which ships only ffmpeg still provisions what it can.
    """
    os.makedirs(dest_dir, exist_ok=True)
    wanted = set(member_basenames)
    found = []

    if kind == "zip":
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
    elif kind == "tar.xz":
        import tarfile
        with tarfile.open(archive, "r:xz") as tf:
            for m in tf.getmembers():
                if not m.isfile():
                    continue
                base = os.path.basename(m.name)
                if base in wanted:
                    dest_binary = os.path.join(dest_dir, base)
                    with tf.extractfile(m) as sfh, open(dest_binary, "wb") as dfh:
                        shutil.copyfileobj(sfh, dfh)
                    _make_executable(dest_binary)
                    found.append(base)
                    wanted.discard(base)
    else:
        raise RuntimeError(f"unknown archive kind: {kind}")

    if wanted:
        print(f"[ffmpeg] WARNING: not found inside archive: {', '.join(sorted(wanted))}",
              file=sys.stderr)
    return found


def provision(root, plat_key, force):
    url, kind, members = SOURCES[plat_key][0], SOURCES[plat_key][1], _members(plat_key)
    extra_urls = _extra_urls(plat_key)
    dest_dir = platform_dir(root, plat_key)

    # Which members still need provisioning?
    missing = [m for m in members
               if force or not is_runnable(target_path(root, plat_key, m))]
    if not missing:
        print(f"[ffmpeg] already present and runnable: {', '.join(members)} in {dest_dir}")
        return dest_dir

    tmpdir = tempfile.mkdtemp(prefix="ffmpeg-dl-")
    try:
        # Members from the main archive.
        main_members = [m for m in missing if m not in extra_urls]
        if main_members:
            archive = os.path.join(tmpdir, "ffmpeg-archive")
            _download(url, archive)
            print(f"[ffmpeg] extracting {', '.join(main_members)} -> {dest_dir}")
            _extract_members(archive, kind, main_members, dest_dir)

        # Members shipped in their own archives (e.g. macOS ffprobe).
        for m in missing:
            if m in extra_urls:
                archive = os.path.join(tmpdir, f"{m}-archive")
                _download(extra_urls[m], archive)
                print(f"[ffmpeg] extracting {m} -> {dest_dir}")
                _extract_members(archive, "zip", [m], dest_dir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # Verify every requested member now runs.
    not_runnable = [m for m in members
                    if not is_runnable(target_path(root, plat_key, m))]
    if not_runnable:
        raise RuntimeError(
            f"extracted binaries are not runnable: {', '.join(not_runnable)}")
    print(f"[ffmpeg] OK: {', '.join(members)} in {dest_dir}")
    return dest_dir


def main():
    ap = argparse.ArgumentParser(description="Provision a project-local ffmpeg + ffprobe (no global changes).")
    ap.add_argument("--dest", default=None, help="Project root (default: this script's folder).")
    ap.add_argument("--force", action="store_true", help="Re-download even if already present.")
    ap.add_argument("--check", action="store_true", help="Report status only; download nothing.")
    args = ap.parse_args()

    plat_key = detect_platform()
    if not plat_key:
        print(f"[ffmpeg] unsupported platform: {platform.system()} / {platform.machine()}", file=sys.stderr)
        print("[ffmpeg] install ffmpeg + ffprobe manually and ensure they are on PATH.", file=sys.stderr)
        return 2

    root = project_root(args.dest)
    members = _members(plat_key)

    if args.check:
        print(f"[ffmpeg] platform     : {plat_key}")
        all_local_ok = True
        for m in members:
            dest = target_path(root, plat_key, m)
            local_ok = is_runnable(dest)
            all_local_ok = all_local_ok and local_ok
            print(f"[ffmpeg] project-local: {m:<12} {'present' if local_ok else 'absent'} ({dest})")
        for m in members:
            system_ok = is_runnable(shutil.which(os.path.splitext(m)[0]))
            print(f"[ffmpeg] system PATH  : {m:<12} {'present' if system_ok else 'absent'}")
        # OK if every member is available either locally or on PATH.
        overall = all(
            is_runnable(target_path(root, plat_key, m))
            or is_runnable(shutil.which(os.path.splitext(m)[0]))
            for m in members
        )
        return 0 if overall else 1

    try:
        provision(root, plat_key, args.force)
        return 0
    except Exception as e:
        print(f"[ffmpeg] provisioning failed: {e}", file=sys.stderr)
        print("[ffmpeg] the broker will fall back to a system ffmpeg or WAV-only.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
