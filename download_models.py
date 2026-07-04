#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
download_models.py — 一键下载 / 校验 GPT-SoVITS 官方底模

用于 tts_broker_openai_compat 项目：把官方预训练底模下载到
    lib/training/gsv-tools/pretrained/
下对应的子目录（gsv-v2final / v2Pro / sv），使 v2 / v2Pro / v2ProPlus
的训练与推理都能正确加载底模，而不是从零训练（电流声根因）。

数据源：HuggingFace 仓库 lj1995/GPT-SoVITS
        （可切换 hf-mirror.com 镜像或 ModelScope 加速）。

设计原则（健壮性）：
  * 不做任何硬编码绝对路径；项目根目录自动探测，可用 --dest 覆盖。
  * 幂等：已存在且大小合理的文件默认跳过；--force 可强制重下。
  * 依赖可选：优先用 huggingface_hub；缺失时回退到纯标准库 HTTP 下载（带断点续传）。
  * 选择性下载：--set v2,v2pro,v2proplus,sv,s1,all（逗号分隔，可多选）。
  * 依赖自动补全：选 v2pro / v2proplus 会自动附带 sv（SV 模型是其必需项）。

用法示例：
    python download_models.py --set v2                  # 只补 v2 真底模（最常用）
    python download_models.py --set v2proplus           # v2ProPlus（自动含 sv）
    python download_models.py --set all                 # 全部
    python download_models.py --set v2pro --mirror      # 走 hf-mirror.com 加速
    python download_models.py --set all --source modelscope
    python download_models.py --check                   # 只体检，不下载
"""

import argparse
import os
import sys
import shutil
import tempfile

# ---------------------------------------------------------------------------
# 底模清单：HF 相对路径  ->  本地相对 pretrained/ 的路径
# 每个文件带一个粗略的最小字节数，用于校验"下载完整/未损坏"。
# ---------------------------------------------------------------------------
HF_REPO = "lj1995/GPT-SoVITS"

# (hf_path, local_relpath, min_bytes)
FILES = {
    "v2": [
        ("gsv-v2final-pretrained/s2G2333k.pth",
         "gsv-v2final/s2G2333k.pth", 80 * 1024 * 1024),
        ("gsv-v2final-pretrained/s2D2333k.pth",
         "gsv-v2final/s2D2333k.pth", 80 * 1024 * 1024),
        ("gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt",
         "gsv-v2final/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt", 120 * 1024 * 1024),
    ],
    "v2pro": [
        ("v2Pro/s2Gv2Pro.pth", "v2Pro/s2Gv2Pro.pth", 80 * 1024 * 1024),
        ("v2Pro/s2Dv2Pro.pth", "v2Pro/s2Dv2Pro.pth", 80 * 1024 * 1024),
    ],
    "v2proplus": [
        ("v2Pro/s2Gv2ProPlus.pth", "v2Pro/s2Gv2ProPlus.pth", 80 * 1024 * 1024),
        ("v2Pro/s2Dv2ProPlus.pth", "v2Pro/s2Dv2ProPlus.pth", 80 * 1024 * 1024),
    ],
    # SV 说话人向量模型：v2Pro / v2ProPlus 训练与推理的必需依赖。
    "sv": [
        ("sv/pretrained_eres2netv2w24s4ep4.ckpt",
         "sv/pretrained_eres2netv2w24s4ep4.ckpt", 20 * 1024 * 1024),
    ],
    # s1 (GPT/AR) 底模，v2 / v2Pro / v2ProPlus 共用。多数安装包已自带。
    "s1": [
        ("s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt",
         "gsv-v2final/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt", 120 * 1024 * 1024),
    ],
}

# 选 v2pro / v2proplus 时自动带上的依赖组。
IMPLIED = {
    "v2pro": ["sv"],
    "v2proplus": ["sv"],
}

ALL_GROUPS = list(FILES.keys())

MIRROR_ENDPOINT = "https://hf-mirror.com"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def log(msg):
    print(msg, flush=True)


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}"
        n /= 1024.0


def find_pretrained_dir(explicit_dest):
    """定位 lib/training/gsv-tools/pretrained/。

    优先级：--dest > 脚本同级推断 > 逐级向上搜索 > 当前工作目录推断。
    """
    rel = os.path.join("lib", "training", "gsv-tools", "pretrained")

    if explicit_dest:
        return os.path.abspath(explicit_dest)

    candidates = []
    here = os.path.dirname(os.path.abspath(__file__))
    cwd = os.path.abspath(os.getcwd())

    # 脚本所在目录（假定放在项目根）
    candidates.append(os.path.join(here, rel))
    candidates.append(os.path.join(cwd, rel))

    # 逐级向上查找含 lib/training/gsv-tools 的项目根
    for base in (here, cwd):
        cur = base
        for _ in range(6):
            probe = os.path.join(cur, rel)
            candidates.append(probe)
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent

    # 若已存在则直接采用；否则采用第一个候选（脚本同级），首次下载会自动创建。
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0]


def expand_groups(selected):
    groups = []
    for s in selected:
        s = s.strip().lower()
        if not s:
            continue
        if s == "all":
            return list(ALL_GROUPS)
        if s not in FILES:
            log(f"⚠ 未知的模型组: {s}（可选: {', '.join(ALL_GROUPS)}, all）")
            continue
        groups.append(s)
        for dep in IMPLIED.get(s, []):
            if dep not in groups:
                groups.append(dep)
    # 去重保序
    seen = set()
    out = []
    for g in groups:
        if g not in seen:
            seen.add(g)
            out.append(g)
    return out


def file_ok(path, min_bytes):
    return os.path.isfile(path) and os.path.getsize(path) >= max(1, min_bytes // 2)


# ---------------------------------------------------------------------------
# 下载后端
# ---------------------------------------------------------------------------
def download_via_hf(hf_path, dest_path, endpoint, source):
    """优先用 huggingface_hub / modelscope 下载。返回 True 表示成功。"""
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)

    if source == "modelscope":
        try:
            from modelscope.hub.file_download import model_file_download
        except Exception:
            return False
        try:
            # ModelScope 上常见的等价仓库；失败则由调用方回退到 HTTP。
            cached = model_file_download(
                model_id="AIDub/GPT-SoVITS", file_path=hf_path)
            shutil.copyfile(cached, dest_path)
            return True
        except Exception as e:
            log(f"    modelscope 下载失败，尝试其它方式: {e}")
            return False

    try:
        from huggingface_hub import hf_hub_download
    except Exception:
        return False

    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint
    try:
        with tempfile.TemporaryDirectory() as tmp:
            cached = hf_hub_download(
                repo_id=HF_REPO,
                filename=hf_path,
                local_dir=tmp,
                local_dir_use_symlinks=False,
            )
            shutil.copyfile(cached, dest_path)
        return True
    except TypeError:
        # 新版 huggingface_hub 去掉了 local_dir_use_symlinks 参数。
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cached = hf_hub_download(
                    repo_id=HF_REPO, filename=hf_path, local_dir=tmp)
                shutil.copyfile(cached, dest_path)
            return True
        except Exception as e:
            log(f"    huggingface_hub 下载失败，尝试直连: {e}")
            return False
    except Exception as e:
        log(f"    huggingface_hub 下载失败，尝试直连: {e}")
        return False


def download_via_http(hf_path, dest_path, endpoint):
    """纯标准库 HTTP 下载，带断点续传。返回 True 表示成功。"""
    import urllib.request
    import urllib.parse

    base = endpoint or "https://huggingface.co"
    # HF resolve URL：/<repo>/resolve/main/<path>
    quoted = urllib.parse.quote(hf_path)
    url = f"{base}/{HF_REPO}/resolve/main/{quoted}"

    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    tmp = dest_path + ".part"
    resume_from = os.path.getsize(tmp) if os.path.isfile(tmp) else 0

    req = urllib.request.Request(url, headers={"User-Agent": "tts-broker-downloader"})
    if resume_from:
        req.add_header("Range", f"bytes={resume_from}-")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = resp.length
            mode = "ab" if resume_from and resp.status == 206 else "wb"
            if mode == "wb":
                resume_from = 0
            done = resume_from
            with open(tmp, mode) as f:
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = done * 100 // (total + resume_from) if resp.status == 206 else done * 100 // total
                        sys.stdout.write(f"\r    下载中 {human(done)} ({pct}%)   ")
                    else:
                        sys.stdout.write(f"\r    下载中 {human(done)}   ")
                    sys.stdout.flush()
        sys.stdout.write("\n")
        shutil.move(tmp, dest_path)
        return True
    except Exception as e:
        sys.stdout.write("\n")
        log(f"    直连下载失败: {e}")
        return False


def fetch(hf_path, dest_path, min_bytes, endpoint, source, force):
    if file_ok(dest_path, min_bytes) and not force:
        log(f"  ✓ 已存在，跳过: {os.path.relpath(dest_path)}  ({human(os.path.getsize(dest_path))})")
        return True

    log(f"  ↓ 下载: {hf_path}")
    ok = download_via_hf(hf_path, dest_path, endpoint, source)
    if not ok:
        ok = download_via_http(hf_path, dest_path, endpoint)

    if ok and file_ok(dest_path, min_bytes):
        log(f"    完成: {os.path.relpath(dest_path)}  ({human(os.path.getsize(dest_path))})")
        return True

    if ok and os.path.isfile(dest_path):
        log(f"    ⚠ 文件偏小，可能不完整: {os.path.relpath(dest_path)} "
            f"({human(os.path.getsize(dest_path))})，请重试或换 --mirror / --source")
    else:
        log(f"    ✗ 失败: {hf_path}")
    return False


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="下载 GPT-SoVITS 官方底模到项目 pretrained 目录",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    ap.add_argument("--set", dest="sets", default="v2",
                    help="要下载的模型组，逗号分隔: "
                         + ", ".join(ALL_GROUPS) + ", all（默认 v2）")
    ap.add_argument("--dest", default=None,
                    help="pretrained 目录（默认自动探测 lib/training/gsv-tools/pretrained）")
    ap.add_argument("--mirror", action="store_true",
                    help="使用 hf-mirror.com 镜像加速（国内推荐）")
    ap.add_argument("--source", choices=["hf", "modelscope"], default="hf",
                    help="下载源，默认 hf")
    ap.add_argument("--force", action="store_true",
                    help="即使已存在也强制重新下载")
    ap.add_argument("--check", action="store_true",
                    help="只体检本地底模是否齐全，不下载")
    args = ap.parse_args()

    pretrained = find_pretrained_dir(args.dest)
    endpoint = MIRROR_ENDPOINT if args.mirror else None

    log("=" * 64)
    log("GPT-SoVITS 底模下载器")
    log(f"  目标目录 : {pretrained}")
    log(f"  下载源   : {args.source}"
        + ("（hf-mirror.com 镜像）" if args.mirror else ""))
    log("=" * 64)

    if args.check:
        run_check(pretrained)
        return 0

    groups = expand_groups(args.sets.split(","))
    if not groups:
        log("没有选中任何有效的模型组。用 --set all 下载全部。")
        return 2

    log(f"将处理模型组: {', '.join(groups)}")
    log("")

    ok_all = True
    for g in groups:
        log(f"[{g}]")
        for hf_path, local_rel, min_bytes in FILES[g]:
            dest = os.path.join(pretrained, local_rel)
            if not fetch(hf_path, dest, min_bytes, endpoint, args.source, args.force):
                ok_all = False
        log("")

    log("=" * 64)
    if ok_all:
        log("✓ 全部完成。现在可以正常训练 / 推理对应版本了。")
    else:
        log("⚠ 有文件未成功下载。可尝试：")
        log("    - 加 --mirror 走国内镜像")
        log("    - 或 --source modelscope")
        log("    - 或重跑本脚本（支持断点续传，会跳过已完成的文件）")
    log("=" * 64)
    run_check(pretrained)
    return 0 if ok_all else 1


def run_check(pretrained):
    log("")
    log("本地底模体检：")
    status = {}
    for g in ALL_GROUPS:
        present = 0
        for hf_path, local_rel, min_bytes in FILES[g]:
            dest = os.path.join(pretrained, local_rel)
            if file_ok(dest, min_bytes):
                present += 1
        total = len(FILES[g])
        status[g] = (present, total)
        mark = "✓" if present == total else ("◑" if present else "✗")
        log(f"  {mark} {g:<10} {present}/{total}")

    log("")
    can_v2 = status["v2"][0] == status["v2"][1]
    can_pro = (status["v2pro"][0] == status["v2pro"][1]
               and status["sv"][0] == status["sv"][1])
    can_plus = (status["v2proplus"][0] == status["v2proplus"][1]
                and status["sv"][0] == status["sv"][1])
    log("可训练 / 可推理版本：")
    log(f"  v2         : {'就绪' if can_v2 else '缺底模（--set v2）'}")
    log(f"  v2Pro      : {'就绪' if can_pro else '缺底模（--set v2pro）'}")
    log(f"  v2ProPlus  : {'就绪' if can_plus else '缺底模（--set v2proplus）'}")


if __name__ == "__main__":
    sys.exit(main())
