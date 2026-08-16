# -*- coding: utf-8 -*-
"""
Aurivox 源码打包 —— 独立脚本，不依赖项目里的任何东西。

和 tools/build/pack-src.ps1 的区别：
    pack-src.ps1 是白名单式的（只收 tools\\build、checks、scripts、tests），
    已知漏掉了 tools\\deploy、tools\\runtime、tools\\wheels 等第一方源码，
    打出来的包不能反映你的真实状态。
    本脚本是黑名单式的：默认全收，只排掉体积大且可再生的东西，
    并且把排掉的部分以「文件清单」的形式一并带上，做到不失真。

用法（在项目根目录执行，也就是有 server.js 的那一层）：

    python pack-src.py

    可选：
      --root  D:\\Project\\tts_broker_openai_compat   指定项目根（默认当前目录）
      --out   D:\\Project\\aurivox-src.zip            指定输出文件
      --max-mb 5                                     单文件超过多少 MB 就只记清单不装进包

产出：
    aurivox-src-<日期时间>.zip
    包内除源码外，还有一个 MANIFEST.txt，里面有：
      · 每个被收进包的文件的 md5 和字节数
      · 每个被排除的目录里都有什么（只有文件名和大小，没有内容）
      · 环境信息（Node/Python 版本、平台）
"""
import argparse
import datetime
import hashlib
import io
import os
import platform
import subprocess
import sys
import zipfile

# ---------------------------------------------------------------- 排除规则

# 这些目录整个不收内容，但会在清单里列出里面有什么
EXCLUDE_DIRS = {
    "node_modules",       # npm 装的，可再生
    ".git",               # 版本库
    "outputs",            # 运行产物
    "logs",               # 日志
    "backups",            # 注册表轮转备份
    "models",             # 权重，GB 级
    "vendor",             # 内置 ffmpeg 等二进制
    "venv", ".venv", "env",
    "__pycache__",
    ".pytest_cache",
    ".idea", ".vscode",
    "uvr5_weights",       # 权重
    "gsv_pretrained",     # 权重
    "dist-cache",
}

# 目录名以这些开头的也整个排除
EXCLUDE_DIR_PREFIXES = ("_migration_backup_", "_r4_backup", "_r4a_backup",
                        "_r5_backup", ".egg-info")

# 这些后缀的文件不收（体积大或纯二进制产物）
EXCLUDE_EXTS = {
    ".pyc", ".pyo", ".pyd",
    ".wav", ".mp3", ".flac", ".ogg", ".m4a",   # 音频素材
    ".ckpt", ".pth", ".onnx", ".safetensors", ".bin", ".pt",  # 权重
    ".exe", ".dll", ".so", ".dylib",
    ".zip", ".7z", ".tar", ".gz", ".whl",
}

# 这些文件名不收
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}


def md5_of(path):
    h = hashlib.md5()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
    except OSError:
        return "(读不到)"
    return h.hexdigest()


def is_excluded_dir(name):
    if name in EXCLUDE_DIRS:
        return True
    for p in EXCLUDE_DIR_PREFIXES:
        if name.startswith(p):
            return True
    return False


def run_version(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                             shell=(os.name == "nt"))
        return (out.stdout or out.stderr).strip().splitlines()[0]
    except Exception as e:
        return "(取不到: %s)" % e


def main():
    ap = argparse.ArgumentParser(description="打包 Aurivox 源码")
    ap.add_argument("--root", default=".", help="项目根目录，默认当前目录")
    ap.add_argument("--out", default=None, help="输出的 zip 路径")
    ap.add_argument("--max-mb", type=float, default=5.0,
                    help="单文件超过这个大小就只记清单，不装进包（默认 5 MB）")
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isfile(os.path.join(root, "server.js")):
        print("[警告] %s 下没有 server.js —— 确定这是项目根目录吗？" % root)
        print("       如果 server.js 正好是被误删的，请先补回来再打包。")
        print("")

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = args.out or os.path.join(root, "aurivox-src-%s.zip" % stamp)
    out = os.path.abspath(out)
    max_bytes = int(args.max_mb * 1024 * 1024)

    print("=" * 70)
    print("  Aurivox 源码打包")
    print("=" * 70)
    print("  项目根 = " + root)
    print("  输出   = " + out)
    print("")

    included = []      # (rel, size, md5)
    skipped_big = []   # (rel, size)
    excluded_tree = [] # (rel, size)  —— 被排除目录里的东西，只记名字和大小

    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

        # 判断这一层是不是在被排除的目录里
        parts = [p for p in rel_dir.split("/") if p]
        inside_excluded = any(is_excluded_dir(p) for p in parts)

        if inside_excluded:
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                try:
                    sz = os.path.getsize(fp)
                except OSError:
                    sz = -1
                excluded_tree.append((rel_dir + "/" + fn, sz))
            continue

        # 剪枝：不下到被排除的子目录里去（但先记一笔它的内容）
        keep = []
        for d in dirnames:
            if is_excluded_dir(d):
                sub = os.path.join(dirpath, d)
                n = 0
                total = 0
                for dp, _dn, fns in os.walk(sub):
                    for fn in fns:
                        try:
                            total += os.path.getsize(os.path.join(dp, fn))
                        except OSError:
                            pass
                        n += 1
                rd = (rel_dir + "/" + d) if rel_dir else d
                excluded_tree.append(("%s/   [整个目录已排除：%d 个文件，共 %.1f MB]"
                                      % (rd, n, total / 1048576.0), -1))
            else:
                keep.append(d)
        dirnames[:] = keep

        for fn in filenames:
            if fn in EXCLUDE_NAMES:
                continue
            ext = os.path.splitext(fn)[1].lower()
            rel = (rel_dir + "/" + fn) if rel_dir else fn

            # 不要把自己和上一次的产物打进去
            if os.path.abspath(os.path.join(dirpath, fn)) == out:
                continue
            if fn.startswith("aurivox-src-") and ext == ".zip":
                continue

            fp = os.path.join(dirpath, fn)
            try:
                sz = os.path.getsize(fp)
            except OSError:
                continue

            if ext in EXCLUDE_EXTS:
                excluded_tree.append((rel + "   [按后缀排除]", sz))
                continue
            if sz > max_bytes:
                skipped_big.append((rel, sz))
                continue

            included.append((rel, sz, md5_of(fp)))

    included.sort()
    skipped_big.sort()
    excluded_tree.sort()

    # ---------------------------------------------------------------- 清单
    buf = io.StringIO()
    w = buf.write
    w("Aurivox 源码包清单\n")
    w("打包时间 : %s\n" % datetime.datetime.now().isoformat(timespec="seconds"))
    w("项目根   : %s\n" % root)
    w("平台     : %s %s\n" % (platform.system(), platform.release()))
    w("Python   : %s\n" % sys.version.split()[0])
    w("Node     : %s\n" % run_version(["node", "-v"]))
    w("npm      : %s\n" % run_version(["npm", "-v"]))
    w("\n")
    w("=" * 70 + "\n")
    w("  一、包内文件 %d 个（路径 / 字节 / md5）\n" % len(included))
    w("=" * 70 + "\n")
    for rel, sz, m in included:
        w("%-70s %10d  %s\n" % (rel, sz, m))

    w("\n")
    w("=" * 70 + "\n")
    w("  二、太大而未装入的文件 %d 个（超过 %.1f MB）\n"
      % (len(skipped_big), args.max_mb))
    w("=" * 70 + "\n")
    for rel, sz in skipped_big:
        w("%-70s %10.1f MB\n" % (rel, sz / 1048576.0))

    w("\n")
    w("=" * 70 + "\n")
    w("  三、被排除的内容 %d 项（只列名字和大小，不含内容）\n" % len(excluded_tree))
    w("=" * 70 + "\n")
    for rel, sz in excluded_tree:
        if sz < 0:
            w("%s\n" % rel)
        else:
            w("%-70s %10d\n" % (rel, sz))

    listing = buf.getvalue()

    # ---------------------------------------------------------------- 写包
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, _sz, _m in included:
            z.write(os.path.join(root, rel.replace("/", os.sep)), rel)
        z.writestr("MANIFEST.txt", listing)

    size = os.path.getsize(out)
    print("  包内文件           = %d 个" % len(included))
    print("  太大未装入         = %d 个" % len(skipped_big))
    print("  被排除的内容       = %d 项（清单里有名字）" % len(excluded_tree))
    print("")
    print("  产出 = %s" % out)
    print("  大小 = %.1f MB" % (size / 1048576.0))
    print("")
    if size > 40 * 1048576:
        print("  ⚠ 包超过 40 MB，可能不好上传。可以调小 --max-mb 再打一次。")
    print("=" * 70)
    print("  包里的 MANIFEST.txt 有每个文件的 md5，我拿到后会逐一核对。")
    print("=" * 70)


if __name__ == "__main__":
    main()
