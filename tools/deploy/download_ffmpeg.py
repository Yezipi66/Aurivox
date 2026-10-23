#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""为项目下载自带的 ffmpeg 与 ffprobe（仅 Windows，不动全局环境）。

平台用 ffmpeg 把引擎的 WAV 转成 mp3/opus/aac/flac，训练流水线的 UVR5 步骤
（pipeline/uvr5/webui.py）用 ffprobe 与 ffmpeg 探测、重整输入。脚本把静态构建
解压到项目内的 vendor/ffmpeg/windows-x86_64/，不修改系统 PATH、环境变量与
注册表。服务端优先用项目内这份，没有才退回 PATH 上的系统 ffmpeg；两者都没有时，
非 WAV 的响应格式直接报错，不按 WAV 交付。

下载地址与许可分类以 THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json 为准，读不到该
文件时用内置默认值。ffmpeg 不随发行包分发：GPL 文本与源码义务随这次下载走，
落在上游分发者（BtbN）身上，不落在这个项目身上。

用法：python download_ffmpeg.py [--check | --force] [--dest <项目根>]
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

# 分发只面向 Windows，因此只有一个平台键，与 lib/audio/ffmpeg.js 的
# vendoredFfmpegPath() 一致。
PLATFORM_KEY = "windows-x86_64"
MEMBERS = ["ffmpeg.exe", "ffprobe.exe"]

# 内置默认下载地址（BtbN 的 win64-gpl 静态构建）。EXTERNAL_TOOLS.json 里有条目时
# 以那份为唯一事实来源。
DEFAULT_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip"
)


def project_root(dest):
    if dest:
        return os.path.abspath(dest)
    # 本脚本在 tools/deploy/ 下。向上找带 server.js 的目录来定位项目根，
    # 找不到就退回上两级。
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
    """从 EXTERNAL_TOOLS.json 读 Windows 下载地址，读不到时用 DEFAULT_URL。"""
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
    """文件存在且 `<binary> -version` 能跑通时返回 True。"""
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
    """把压缩包里指定的可执行文件解压到 dest_dir。

    压缩包里没有的成员会告警，解压结果里就没有它。
    """
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
    """把 ffmpeg 与 ffprobe 装到 root 下，返回安装目录。

    已经装好且能跑的两个文件会被跳过，除非 force 为真。
    解压出来的二进制跑不起来时抛 RuntimeError。
    """
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
