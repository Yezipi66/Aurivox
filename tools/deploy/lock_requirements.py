#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
lock_requirements.py —— 依赖锁生成器（把当前 venv 冻结成完全可复现的 requirements.txt）

背景
----
部署侧（bootstrap.ps1）用  `uv pip install --no-deps -r requirements.txt`  安装，
即「不跑依赖求解器、逐包按 pin 精确安装」。这是复现一个冻结环境的正确姿势，但前提是
requirements.txt 必须是一份 **完整的 pip freeze 快照**（每个传递依赖都被 pin）。

本脚本就负责生成那份快照：
  1) 读一个 **已经装好、验证可用** 的 venv；
  2) `pip freeze` 拿到全部精确版本；
  3) 排除单独安装的 torch/torchaudio/torchvision 与构建工具（pip/setuptools/wheel/uv）；
  4) 保留 requirements.in 里带 **平台 marker / pip 选项** 的行（onnxruntime 的 cuDNN 锁、
     arm 上的 CPU 回退、opencc 源码编译等），这些是 raw freeze 会丢掉的跨平台信息；
  5) 覆盖写出 requirements.txt。

用法
----
    venv\\Scripts\\python.exe tools\\deploy\\lock_requirements.py
    # 或显式指定：
    python tools\\deploy\\lock_requirements.py --python D:\\proj\\venv\\Scripts\\python.exe
    python tools\\deploy\\lock_requirements.py --check   # 只校验，不写文件

生成后请提交 requirements.txt。之后所有机器一律 `--no-deps` 精确复现，环境完全一致。
"""
import argparse
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))  # tools/deploy -> project root

# 单独安装（install_torch.ps1，CUDA 专属 index），绝不能进冻结锁。
TORCH_TRIO = {"torch", "torchaudio", "torchvision"}
# 构建 / 环境自举工具，由 bootstrap 自己管理，不纳入项目依赖锁。
BUILD_TOOLS = {"pip", "setuptools", "wheel", "uv"}

# 注：曾一度以为 google-auth / OAuth 一族是 tensorboard 的孤儿依赖而想剔除，但排查发现
# 它们其实是 f5-tts → cached_path → google-cloud-storage 的**真实**依赖链（tensorboardX 则
# 由 funasr / modelscope 引入）。因此**不**做闭包剔除——freeze 就是当前 venv 的忠实快照，
# 该有的传递依赖一个都不能少（否则 --no-deps 安装会缺包）。待日后确定是否保留 f5-tts 再议。
EXCLUDE = TORCH_TRIO | BUILD_TOOLS


def canon(name):
    """PEP 503 归一化：小写 + 把 _ . 统一成 -。"""
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def default_python():
    """优先用项目自带 venv 的 python；否则回退到当前解释器。"""
    cand = os.path.join(ROOT, "venv", "Scripts", "python.exe")  # Windows
    if os.path.isfile(cand):
        return cand
    cand = os.path.join(ROOT, "venv", "bin", "python")          # POSIX
    if os.path.isfile(cand):
        return cand
    return sys.executable


def pip_freeze(py):
    out = subprocess.check_output(
        [py, "-m", "pip", "freeze", "--exclude-editable"],
        stderr=subprocess.STDOUT,
    )
    return out.decode("utf-8", "replace").splitlines()


def parse_freeze(lines):
    """freeze 行 -> {canon_name: raw_line}。跳过 editable / VCS / 本地路径安装。"""
    pins = {}
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-e ") or " @ " in line or line.startswith("-"):
            # editable / URL / 本地 file:// —— 不可移植，跳过（并告警）。
            print("  [skip non-portable] %s" % line, file=sys.stderr)
            continue
        m = re.match(r"^([A-Za-z0-9_.\-]+)\s*==", line)
        if not m:
            print("  [skip unpinned]     %s" % line, file=sys.stderr)
            continue
        pins[canon(m.group(1))] = line
    return pins


def parse_in_overrides(path):
    """
    从 requirements.in 提取需要「原样保留」的行：
      * pip 选项行（以 - 开头，如 --no-binary=opencc）；
      * 带环境 marker（含 ';'）的 requirement 行；
    连带其正上方紧邻的注释行一起搬运，并返回这些行覆盖掉的包名集合。
    """
    if not os.path.isfile(path):
        return [], [], set()
    opt_lines, marker_blocks, covered = [], [], set()
    pending_comments = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f.readlines():
            line = raw.rstrip("\n")
            s = line.strip()
            if not s:
                pending_comments = []
                continue
            if s.startswith("#"):
                pending_comments.append(line)
                continue
            if s.startswith("-"):
                opt_lines.append(line)
                pending_comments = []
                continue
            if ";" in s:
                name = re.split(r"[<>=!;\s\[]", s, 1)[0]
                if name:
                    covered.add(canon(name))
                marker_blocks.extend(pending_comments)
                marker_blocks.append(line)
            pending_comments = []
    return opt_lines, marker_blocks, covered


def build(py, req_in, req_out):
    print("[lock] freezing venv: %s" % py)
    pins = parse_freeze(pip_freeze(py))
    print("[lock] pip freeze -> %d pinned package(s)" % len(pins))

    opt_lines, marker_blocks, covered = parse_in_overrides(req_in)

    # 从冻结集合里剔除：单独装的 torch 三件套 + 构建工具 + 被 marker 行覆盖的包。
    drop = EXCLUDE | covered
    frozen = {n: l for n, l in pins.items() if n not in drop}
    dropped = sorted(pins.keys() & drop)
    if dropped:
        print("[lock] excluded from lock (installed separately / marker-overridden): %s"
              % ", ".join(dropped))

    body = []
    body.append("# ============================================================================")
    body.append("# requirements.txt —— AUTO-GENERATED dependency LOCK. DO NOT EDIT BY HAND.")
    body.append("# 由 tools/deploy/lock_requirements.py 从可用 venv 冻结生成（pip freeze）。")
    body.append("# 改依赖请编辑 requirements.in 后重跑 lock_requirements.py 重新生成本文件。")
    body.append("#")
    body.append("# deploy.bat / bootstrap.ps1 用  `uv pip install --no-deps -r requirements.txt`")
    body.append("# 精确复现本锁；torch/torchaudio/torchvision 由 install_torch.ps1 单独安装。")
    body.append("# ============================================================================")
    body.append("")
    if opt_lines:
        body.append("# ---- pip options (from requirements.in) ----")
        body.extend(opt_lines)
        body.append("")
    if marker_blocks:
        body.append("# ---- platform / marker overrides (from requirements.in) ----")
        body.extend(marker_blocks)
        body.append("")
    body.append("# ---- fully pinned snapshot (pip freeze) ----")
    body.extend(frozen[n] for n in sorted(frozen))
    body.append("")

    text = "\n".join(body)
    with open(req_out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("[lock] wrote %s (%d pinned + %d marker/option line(s))"
          % (req_out, len(frozen), len(opt_lines) + len(marker_blocks)))
    return frozen


def looks_frozen(path):
    """启发式：判断一个 requirements 文件是否已经是完全冻结（无范围、含 ==）。"""
    if not os.path.isfile(path):
        return False
    pinned = ranged = 0
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            s = raw.strip()
            # 注释 / pip 选项 / 平台 marker 行不参与判定：marker 行(如 arm 的
            # onnxruntime、python_mecab_ko)在冻结平台上不安装,可以合法地不带 pin。
            if not s or s.startswith("#") or s.startswith("-") or ";" in s:
                continue
            if re.search(r"[<>](?!=)|>=|<=|~=|,", s):
                ranged += 1
            elif "==" in s:
                pinned += 1
            else:
                ranged += 1  # 无任何版本 = 未冻结
    return pinned > 0 and ranged == 0


def main():
    ap = argparse.ArgumentParser(description="Freeze the current venv into a fully-pinned requirements.txt lock.")
    ap.add_argument("--python", default=default_python(),
                    help="venv python to freeze (default: <root>/venv, else current interpreter)")
    ap.add_argument("--in", dest="req_in", default=os.path.join(ROOT, "requirements.in"),
                    help="declarative source (for marker/option carry-over)")
    ap.add_argument("--out", dest="req_out", default=os.path.join(ROOT, "requirements.txt"),
                    help="lock file to (over)write")
    ap.add_argument("--check", action="store_true",
                    help="only report whether requirements.txt is a full freeze; do not write")
    args = ap.parse_args()

    if args.check:
        ok = looks_frozen(args.req_out)
        print("[lock] %s is %s a fully-pinned freeze."
              % (args.req_out, "" if ok else "NOT"))
        return 0 if ok else 1

    if not os.path.isfile(args.python):
        print("[lock][ERROR] python not found: %s" % args.python, file=sys.stderr)
        print("              build a working venv from requirements.in first.", file=sys.stderr)
        return 2
    build(args.python, args.req_in, args.req_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
