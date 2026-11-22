#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""为项目下载自带的 ffmpeg 与 ffprobe（仅 Windows，不动全局环境）。

平台用 ffmpeg 把引擎的 WAV 转成 mp3/opus/aac/flac，训练流水线的 UVR5 步骤
（pipeline/uvr5/webui.py）用 ffprobe 与 ffmpeg 探测、重整输入。脚本把静态构建
解压到项目内的 vendor/ffmpeg/windows-x86_64/，不修改系统 PATH、环境变量与
注册表。服务端优先用项目内这份，没有才退回 PATH 上的系统 ffmpeg；两者都没有时，
非 WAV 的响应格式直接报错，不按 WAV 交付。

同一目录还要放一份 FFmpeg 共享库（avcodec-*.dll 等）。torchaudio 2.9 起
load()/save() 经 torchcodec，而 torchcodec 在 Windows 上是动态链接 FFmpeg 的：
只有静态 ffmpeg.exe 不够，缺这批 DLL 时引擎会在读参考音频那一步报
`Could not load libtorchcodec`。静态 exe 与共享库互不影响：exe 不动，DLL 只被
torchcodec 按需加载。

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

# torchcodec 的 libtorchcodec_coreN.dll 直接导入这几族 FFmpeg 共享库。
#   avdevice 不是必须的（coreN 不导入它），这里只列必需项。
SHARED_REQUIRED = ("avcodec-", "avfilter-", "avformat-", "avutil-",
                   "swresample-", "swscale-")

# 内置默认下载地址（BtbN 的 win64-gpl 静态构建）。EXTERNAL_TOOLS.json 里有条目时
# 以那份为唯一事实来源。共享库地址默认由它派生：同一个 release 的 -shared 包。
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


def distribution_sources(root):
    """读 EXTERNAL_TOOLS.json 里 ffmpeg 的下载地址表，读不到时返回空表。"""
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
                    return tool.get("distribution_sources") or {}
        except Exception:
            continue
    return {}


def source_url(root):
    """从 EXTERNAL_TOOLS.json 读 Windows 静态包地址，读不到时用 DEFAULT_URL。"""
    return distribution_sources(root).get(PLATFORM_KEY) or DEFAULT_URL


def shared_url(root):
    """共享库压缩包地址：优先读 windows-x86_64-shared，否则由静态地址派生。

    派生规则写在名字上：同一个 BtbN release 里 `-gpl.zip` 与 `-gpl-shared.zip`
    是同一份构建，静态 exe 与共享库的版本因此天然对齐。
    """
    explicit = distribution_sources(root).get(PLATFORM_KEY + "-shared")
    if explicit:
        return explicit
    return source_url(root)[:-4] + "-shared.zip"


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


def shared_libs_ok(dest_dir):
    """共享库齐不齐：coreN 直接导入的那几族各有一个 DLL 就算齐。"""
    try:
        names = [n.lower() for n in os.listdir(dest_dir) if n.lower().endswith(".dll")]
    except OSError:
        return False
    return all(any(n.startswith(pre) for n in names) for pre in SHARED_REQUIRED)


def _extract_shared_libs(archive, dest_dir):
    """只解压 FFmpeg 的共享库（av*/sw*.dll），exe 与其他文件一律不碰。

    不覆盖 ffmpeg.exe / ffprobe.exe：静态构建继续由平台调用，
    这批 DLL 只被 torchcodec 按需加载，两者互不影响。
    """
    os.makedirs(dest_dir, exist_ok=True)
    found = []
    prefixes = SHARED_REQUIRED + ("avdevice-",)
    with zipfile.ZipFile(archive) as zf:
        for name in zf.namelist():
            base = os.path.basename(name)
            low = base.lower()
            if not low.endswith(".dll"):
                continue
            if not any(low.startswith(pre) for pre in prefixes):
                continue
            with zf.open(name) as sfh, open(os.path.join(dest_dir, base), "wb") as dfh:
                shutil.copyfileobj(sfh, dfh)
            found.append(base)
    return found


def provision_shared(root, force=False):
    """把 torchcodec 需要的共享库补进 vendor 目录；已经齐了就跳过。"""
    dest_dir = platform_dir(root)
    if not force and shared_libs_ok(dest_dir):
        print(f"[ffmpeg] shared libraries already present in {dest_dir}")
        return dest_dir

    url = shared_url(root)
    tmpdir = tempfile.mkdtemp(prefix="ffmpeg-shared-")
    try:
        archive = os.path.join(tmpdir, "ffmpeg-shared.zip")
        _download(url, archive)
        print(f"[ffmpeg] extracting shared libraries -> {dest_dir}")
        found = _extract_shared_libs(archive, dest_dir)
        print(f"[ffmpeg] shared libraries: {len(found)} file(s)")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not shared_libs_ok(dest_dir):
        raise RuntimeError(
            "shared FFmpeg libraries are incomplete after extraction: "
            + ", ".join(SHARED_REQUIRED))
    return dest_dir


def provision(root, force):
    """把 ffmpeg 与 ffprobe 装到 root 下，返回安装目录。

    已经装好且能跑的两个文件会被跳过，除非 force 为真。
    解压出来的二进制跑不起来时抛 RuntimeError。
    """
    dest_dir = platform_dir(root)
    missing = [m for m in MEMBERS if force or not is_runnable(target_path(root, m))]
    if missing:
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
    else:
        print(f"[ffmpeg] already present and runnable: {', '.join(MEMBERS)} in {dest_dir}")

    # 共享库与静态 exe 是两件事：exe 已在也要补，否则 torchaudio 2.9+ 的
    #   torchcodec 起不来。下载失败只告警：平台的转码能力不依赖这批 DLL，
    #   不该因为它连 ffmpeg 都装不上。
    try:
        provision_shared(root, force)
    except Exception as e:
        print(f"[ffmpeg] WARNING: shared FFmpeg libraries were not installed: {e}",
              file=sys.stderr)
        print("[ffmpeg] torchaudio 2.9+ needs them for torchcodec; engine audio decoding may fail.",
              file=sys.stderr)
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
        shared_ok = shared_libs_ok(platform_dir(root))
        print(f"[ffmpeg] shared libs  : {'present' if shared_ok else 'absent'} ({platform_dir(root)})")
        if not shared_ok:
            print("[ffmpeg] note: torchaudio 2.9+ needs the shared libraries for torchcodec.",
                  file=sys.stderr)
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
