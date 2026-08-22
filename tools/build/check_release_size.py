#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""check_release_size.py — 按**体量**兜底的发行包守卫  [r12c batch16 / 2026-08-21]

=== 为什么需要它 ===

04_pack_release.py 的排除清单是**按名字**写的。名字会腐烂，而腐烂的表现
不是报错，是**包大了没人发现**。这不是假设，是本仓库反复发生过的事：

  * `vendor/gsv-tools/asr/faster-whisper-large-v3-turbo` —— 名字打错一个词，
    规则从来没匹配上，3.4MB sidecar json 一路发了出去。它的 model.bin 是被
    EXCLUDE_EXT（兜底）挡住的，**不是被那条规则挡住的**。
  * `vendor/tts/gpt-sovits` → `engines/gpt-sovits` 那次迁移，两条用
    os.path.join 分段拼的排除路径**没被文本替换扫到**，留下就会静默失效，
    600MB 权重进包。
  * `venv_idx241` —— 目录早被移到项目外，条目还留在清单里。
  * ⭐ 本批的直接触发点：`.venv` 只被 TOP_EXCLUDE 挡在**顶层**，
    `engines/<id>/.venv/`（8.1GB）规则**够不着**。

共同点：**每一次都是"按名字排除"漏了，而每一次都没有报错。**

⇒ 结论不是"下次写仔细点"，是**换一种判据**：名字会变，体量不会说谎。
   一个"extract-and-run"的发行包不该有 300MB 的单文件，也不该有某个
   目录独占半个包。这两条不依赖任何清单是否最新。

⚠ 它是**兜底**不是**替代**：排除清单仍然是第一道，这里只负责在清单漏了
   的时候把构建**拦下来**，而不是让它悄悄发出去。

=== 判据 ===

  1. 单文件 > --max-file MB          （默认 50）
  2. 单个二级目录 > --max-dir MB     （默认 120，如 engines/indextts2）
  3. 总量 > --max-total MB           （默认 500，与 04_pack_release 的
                                       MAX_UNCOMPRESSED_MB 一致）

  ⭐ 判据 2 用**二级**目录（engines/indextts2 而不是 engines）：一级太粗，
     engines/ 底下多一个引擎就会超，那样守卫会因为**正常增长**而误报，
     误报几次之后就没人看它了 —— 那才是守卫真正的死法。

用法：
    python tools\build\check_release_size.py                 # 扫工作树
    python tools\build\check_release_size.py --zip dist\x.zip  # 扫已打好的包
    python tools\build\check_release_size.py --selftest
"""

import argparse
import os
import sys
import zipfile

BANNER = "[check_release_size / r12c batch16 / 2026-08-21]"

DEFAULT_MAX_FILE_MB = 50
DEFAULT_MAX_DIR_MB = 120
DEFAULT_MAX_TOTAL_MB = 500

MB = 1024.0 * 1024.0


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024.0 or unit == "GB":
            return "%.1f%s" % (n, unit)
        n /= 1024.0


def second_level(rel):
    r"""'engines/indextts2/.venv/x.py' -> 'engines/indextts2'
    'server.js' -> '<root>'  （顶层散文件聚成一桶，不然每个文件一个桶）"""
    parts = rel.replace("\\", "/").split("/")
    if len(parts) <= 1:
        return "<root>"
    if len(parts) == 2:
        return parts[0]
    return parts[0] + "/" + parts[1]


def collect_from_zip(path):
    out = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            # 发行包里每条路径都带产品名前缀，剥掉再分桶
            rel = info.filename
            parts = rel.split("/", 1)
            out.append((parts[1] if len(parts) == 2 else rel, info.file_size))
    return out


def collect_from_tree(root, skip):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            try:
                sz = os.path.getsize(full)
            except OSError:
                continue
            out.append((os.path.relpath(full, root), sz))
    return out


def judge(entries, max_file, max_dir, max_total):
    """返回 (violations, buckets, total)。violations 是 (kind, name, size) 列表。"""
    v = []
    buckets = {}
    total = 0
    for rel, sz in entries:
        total += sz
        b = second_level(rel)
        buckets[b] = buckets.get(b, 0) + sz
        if sz > max_file * MB:
            v.append(("file", rel, sz))
    for name, sz in buckets.items():
        if sz > max_dir * MB:
            v.append(("dir", name, sz))
    if total > max_total * MB:
        v.append(("total", "<all>", total))
    v.sort(key=lambda t: -t[2])
    return v, buckets, total


# ─────────────────────────────────────────────────────────────────────────
def selftest():
    print(BANNER)
    print()
    print("[自检]")
    ok = fail = 0

    def chk(cond, msg):
        if cond:
            print("   ok   %s" % msg)
        else:
            print("   FAIL %s" % msg)
        return 1 if cond else 0

    r = chk(second_level("engines/indextts2/.venv/a.py") == "engines/indextts2",
            "二级目录分桶：engines/indextts2")
    ok += r; fail += 1 - r
    r = chk(second_level("server.js") == "<root>",
            "顶层散文件聚成 <root> 一桶")
    ok += r; fail += 1 - r
    r = chk(second_level("lib/paths.js") == "lib",
            "两段路径按一级分桶")
    ok += r; fail += 1 - r
    r = chk(second_level("engines\\indextts2\\x.py") == "engines/indextts2",
            "反斜杠路径也认（Windows）")
    ok += r; fail += 1 - r

    # 单文件超限
    v, _, _ = judge([("big.bin", 60 * MB)], 50, 999999, 999999)
    r = chk(len(v) == 1 and v[0][0] == "file", "单文件超限被抓")
    ok += r; fail += 1 - r

    # 反例守卫：刚好不超不许报
    v, _, _ = judge([("ok.bin", 49 * MB)], 50, 999999, 999999)
    r = chk(len(v) == 0, "反例守卫：未超限不误报")
    ok += r; fail += 1 - r

    # ⭐ 本批的真实场景：8.1GB 的 engines/indextts2/.venv 必须被抓
    v, _, _ = judge([("engines/indextts2/.venv/lib/torch_cuda.dll", 1000 * MB)],
                    99999, 120, 99999)
    kinds = set(x[0] for x in v)
    r = chk("dir" in kinds, "⭐ engines/<id>/.venv 体量超限被抓（本批的触发点）")
    ok += r; fail += 1 - r

    # ⭐ 反例守卫：许多小文件累加超过目录阈值也要抓（不是只看单文件）
    many = [("engines/x/f%d.txt" % i, 2 * MB) for i in range(100)]
    v, _, _ = judge(many, 50, 120, 99999)
    r = chk(any(x[0] == "dir" for x in v) and not any(x[0] == "file" for x in v),
            "⭐ 反例守卫：小文件累加超目录阈值要抓，且不误报成单文件超限")
    ok += r; fail += 1 - r

    # 总量
    v, _, _ = judge([("a", 300 * MB), ("b", 300 * MB)], 99999, 99999, 500)
    r = chk(any(x[0] == "total" for x in v), "总量超限被抓")
    ok += r; fail += 1 - r

    # 分桶正确性
    _, buckets, total = judge(
        [("engines/a/x", 10), ("engines/a/y", 20), ("lib/z", 5)],
        99999, 99999, 99999)
    r = chk(buckets.get("engines/a") == 30 and buckets.get("lib") == 5
            and total == 35, "分桶与总量算对")
    ok += r; fail += 1 - r

    print()
    print("   自检：%d ok / %d FAIL" % (ok, fail))
    return 0 if fail == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="扫已打好的发行包（默认扫工作树）")
    ap.add_argument("--root", default=None)
    ap.add_argument("--max-file", type=float, default=DEFAULT_MAX_FILE_MB)
    ap.add_argument("--max-dir", type=float, default=DEFAULT_MAX_DIR_MB)
    ap.add_argument("--max-total", type=float, default=DEFAULT_MAX_TOTAL_MB)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    print(BANNER)
    if a.zip:
        entries = collect_from_zip(a.zip)
        what = a.zip
    else:
        root = a.root or os.getcwd()
        skip = {".git", "node_modules", "__pycache__", ".venv", "venv",
                "dist", "logs", "outputs", "cache", ".hermes", ".staging"}
        entries = collect_from_tree(root, skip)
        what = root + "   ⚠ 工作树模式跳过了 %s" % "/".join(sorted(skip))
    print("   目标：%s" % what)
    print("   阈值：单文件 %sMB / 二级目录 %sMB / 总量 %sMB"
          % (a.max_file, a.max_dir, a.max_total))
    print()

    v, buckets, total = judge(entries, a.max_file, a.max_dir, a.max_total)

    print("   体量前 10 的二级目录：")
    for name, sz in sorted(buckets.items(), key=lambda t: -t[1])[:10]:
        print("      %10s  %s" % (human(sz), name))
    print()
    print("   合计 %s / %d 个文件" % (human(total), len(entries)))
    print()

    if not v:
        print("   PASS  没有超限项。")
        return 0

    print("   FAIL  %d 项超限：" % len(v))
    for kind, name, sz in v:
        label = {"file": "单文件", "dir": "二级目录", "total": "总量"}[kind]
        print("      %-8s %10s  %s" % (label, human(sz), name))
    print()
    print("   ⇒ 要么补 04_pack_release.py 的排除清单，要么用 --max-* 显式放宽。")
    print("     ⛔ 别默默调高阈值 —— 这个守卫存在的意义就是**逼你看一眼**。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
