#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pack_sources.py — 把项目源码打成 zip，自动排除模型权重 / 音频 / 大文件

用途：把 tts_broker_openai_compat 的源码打包上传排查，只带源码，不带
      几百 MB 的底模 / 训练权重 / 音频等大文件。

排除策略（三层，命中任一即排除）：
  1) 目录黑名单：node_modules / venv / .git / .staging / outputs / 各类缓存等；
  2) 扩展名黑名单：.pth/.ckpt/.pt/.onnx/.bin/.safetensors（模型）、
     .wav/.mp3/.flac/...（音频）、.mp4/...（视频）、.zip/.7z/...（压缩包）、
     大图片等；
  3) 体积阈值：超过 --max-mb（默认 5MB）的文件一律排除
     —— 但源码类扩展名（.py/.js/.json/...）不受体积限制，保证源码不被误删。

用法：
    python pack_sources.py                     # 在项目根运行，生成 sources_<时间>.zip
    python pack_sources.py --root D:\\Project\\tts_broker_openai_compat
    python pack_sources.py --max-mb 3          # 更严格的大文件阈值
    python pack_sources.py --out mysrc.zip
    python pack_sources.py --dry-run           # 只预览会打包什么，不真正生成 zip
"""

import argparse
import os
import sys
import time
import zipfile

# 目录名黑名单（任何层级同名目录都跳过）
EXCLUDE_DIRS = {
    "node_modules", ".git", ".hg", ".svn", ".staging", ".cache",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "venv", ".venv", "env", ".env", "dist", "build", ".idea", ".vscode",
    "outputs", "output", "logs", "log", "tmp", "temp",
    ".gradio", ".ipynb_checkpoints",
}

# 目录路径片段黑名单（相对路径里出现即跳过整棵子树）——模型/权重集中区
EXCLUDE_PATH_PARTS = [
    os.path.join("pretrained"),          # 底模
    os.path.join("pretrained_models"),
    os.path.join("uvr5_weights"),
    os.path.join("uvr5", "uvr5_weights"),
    os.path.join("SoVITS_weights"),
    os.path.join("GPT_weights"),
    os.path.join("sovits_models"),
    os.path.join("gpt_checkpoints"),
    os.path.join("faster-whisper-large-v3-turbo"),
    os.path.join("chinese-hubert-base"),
    os.path.join("chinese-roberta-wwm-ext-large"),
]

# 扩展名黑名单（大文件/二进制/模型/媒体）
EXCLUDE_EXT = {
    # 模型 / 权重
    ".pth", ".ckpt", ".pt", ".onnx", ".bin", ".safetensors", ".h5",
    ".pb", ".tflite", ".engine", ".plan", ".index", ".npz", ".npy",
    ".pkl", ".pickle", ".model", ".msgpack", ".gguf", ".ggml",
    # 音频 / 视频
    ".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma",
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
    # 压缩包
    ".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst",
    # 大图片 / 其它二进制
    ".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".psd", ".pdf",
    ".exe", ".dll", ".so", ".dylib", ".lib", ".a", ".o", ".class",
    ".wts",
}

# 源码类扩展名：不受体积阈值限制，始终保留（除非被目录/扩展名黑名单命中）
SOURCE_EXT = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".md", ".txt", ".html", ".htm", ".css", ".scss", ".less",
    ".bat", ".cmd", ".ps1", ".sh", ".env", ".gitignore", ".dockerignore",
    ".vue", ".svelte", ".xml", ".csv", ".proto", ".sql", ".lock",
    "",  # 无扩展名文件（如 Dockerfile、LICENSE）通常是源码/配置
}


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return "%.1f%s" % (f, u)
        f /= 1024.0


def find_root(explicit):
    if explicit:
        return os.path.abspath(explicit)
    here = os.path.dirname(os.path.abspath(__file__))
    # 若脚本就放在项目根，直接用；否则用当前工作目录
    if os.path.isfile(os.path.join(here, "server.js")) or \
       os.path.isfile(os.path.join(here, "package.json")):
        return here
    return os.path.abspath(os.getcwd())


def should_skip_dir(rel_dir):
    parts = rel_dir.replace("\\", "/").split("/")
    if any(p in EXCLUDE_DIRS for p in parts if p):
        return True
    norm = rel_dir.replace("\\", "/")
    for frag in EXCLUDE_PATH_PARTS:
        f = frag.replace("\\", "/")
        if norm == f or norm.startswith(f + "/") or ("/" + f + "/") in ("/" + norm + "/"):
            return True
    return False


def decide_file(rel_path, size, max_bytes):
    ext = os.path.splitext(rel_path)[1].lower()
    if ext in EXCLUDE_EXT:
        return False, "二进制/模型/媒体扩展名"
    if ext in SOURCE_EXT:
        # 源码：即使较大也保留，但给个上限防止意外的超大数据文件（如 50MB 词表）
        if size > max(max_bytes, 20 * 1024 * 1024):
            return False, "源码但超 20MB（疑似数据文件）"
        return True, None
    # 未知扩展名：按体积阈值决定
    if size > max_bytes:
        return False, "未知类型且超过 %s 阈值" % human(max_bytes)
    return True, None


def main():
    ap = argparse.ArgumentParser(description="打包源码 zip（排除模型/音频/大文件）")
    ap.add_argument("--root", default=None, help="项目根目录（默认脚本所在目录或当前目录）")
    ap.add_argument("--out", default=None, help="输出 zip 路径（默认 sources_<时间>.zip）")
    ap.add_argument("--max-mb", type=float, default=5.0, help="非源码文件的体积上限 MB（默认 5）")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不生成 zip")
    args = ap.parse_args()

    root = find_root(args.root)
    max_bytes = int(args.max_mb * 1024 * 1024)
    ts = time.strftime("%Y%m%d_%H%M%S")
    out = os.path.abspath(args.out) if args.out else os.path.join(root, "sources_%s.zip" % ts)

    print("=" * 64)
    print("源码打包（排除模型/音频/大文件）")
    print("  项目根 : %s" % root)
    print("  输出   : %s" % out)
    print("  阈值   : 非源码 > %s 排除" % human(max_bytes))
    if args.dry_run:
        print("  模式   : DRY-RUN（只预览）")
    print("=" * 64)

    included = []
    skipped_big = []
    total_in = 0

    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            rel_dir = ""
        # 原地裁剪要进入的子目录（提高效率并彻底跳过黑名单子树）
        pruned = []
        for d in list(dirnames):
            child = os.path.join(rel_dir, d) if rel_dir else d
            if d in EXCLUDE_DIRS or should_skip_dir(child):
                pruned.append(d)
        for d in pruned:
            dirnames.remove(d)

        if rel_dir and should_skip_dir(rel_dir):
            continue

        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.join(rel_dir, fn) if rel_dir else fn
            # 不要把即将生成的 zip 自己打进去
            if os.path.abspath(full) == out:
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            keep, reason = decide_file(rel, size, max_bytes)
            if keep:
                included.append((rel, size))
                total_in += size
            elif reason and "扩展名" not in reason:
                # 只记录"因大小被排除"的，方便你确认没漏源码
                skipped_big.append((rel, size, reason))

    included.sort()
    print("将打包 %d 个文件，原始合计 %s" % (len(included), human(total_in)))
    if skipped_big:
        print("\n因体积被排除的非模型文件（确认下有没有你要的源码）：")
        for rel, size, reason in sorted(skipped_big, key=lambda x: -x[1])[:20]:
            print("  - %-60s %8s  (%s)" % (rel[:60], human(size), reason))
        if len(skipped_big) > 20:
            print("  ... 其余 %d 个" % (len(skipped_big) - 20))

    if args.dry_run:
        print("\n(DRY-RUN) 未生成 zip。去掉 --dry-run 即可真正打包。")
        return 0

    manifest = "pack_sources 打包清单  %s\n项目根: %s\n文件数: %d\n\n" % (ts, root, len(included))
    manifest += "\n".join("%s\t%d" % (rel.replace("\\", "/"), size) for rel, size in included)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, _ in included:
            z.write(os.path.join(root, rel), arcname=rel.replace("\\", "/"))
        z.writestr("_PACK_MANIFEST.txt", manifest)

    zsize = os.path.getsize(out)
    print("\n" + "=" * 64)
    print("✓ 完成：%s" % out)
    print("  压缩后大小：%s（含 _PACK_MANIFEST.txt 清单）" % human(zsize))
    if zsize > 25 * 1024 * 1024:
        print("  ⚠ 超过 25MB，上传可能受限。可加 --max-mb 2 收紧，或告诉我按目录分包。")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
