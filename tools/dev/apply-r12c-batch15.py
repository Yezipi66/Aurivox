#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""apply-r12c-batch15.py  --  r12c Batch 5a: 发行包收口 + 死账清理

用法（在项目根跑；也可以从 tools\\dev\\ 跑，脚本会自己上溯找根）:

    python tools\\dev\\apply-r12c-batch15.py --selftest    # 只自检，不碰盘
    python tools\\dev\\apply-r12c-batch15.py               # dry-run，只打印计划
    python tools\\dev\\apply-r12c-batch15.py --write       # 真改，留备份
    python tools\\dev\\apply-r12c-batch15.py --restore     # 严格反序还原

=== 本批做什么 ===

[E1] 04_pack_release.py  TOP_EXCLUDE  +cache +.hermes
     根因：规则写的是顶层 ".patch-backup"（带点），盘上实际是 cache\\patch-backup\\
     （无点、第二层）⇒ 规则空转，73 个补丁备份进了发行包。

[E2] 04_pack_release.py  NAME_EXCLUDE +patch-backup
     E1 只堵住 cache/ 这一个落点。这条按“任意深度的目录名”堵，
     以后备份再挪到哪一层都拦得住。两条同时上，才不留“挪个位置又失效”的规则。

[E3] 04_pack_release.py  PATH_EXCLUDE +tools/dev
     根因：batch13 把助手产出物从根目录挪进 tools\\dev\\，而 tools/ 整棵进包
     ⇒ 等于把 apply-*.py / collect_*.py / probe_*.py 发给了终端用户。
     自证：--dry-run 5908 vs 探针 5909，差的正是刚放进 tools\\dev\\ 的探针自己。

[E4] 04_pack_release.py  preflight 增加 [FAIL] 必需项（r12c 搬家落点）
     根因：现有 11 条 preflight 全是 [WARN]（缺了照样出包），且没有一条提到
     engines/ 或 pipeline/ ⇒ “零 WARN”只证明 r12c 之前的东西还在，
     不能证明 r12c 搬过去的东西进包了。这条让打包链自己长出守卫。
     Owner 2026-08-20 决定：报 FAIL，不是 WARN。

[E5] bootstrap.ps1 两处提示词纠正
     两行 Info 打印给终端用户看的下载落点仍是 vendor\\gsv-tools\\...，
     而 download_models.py:117-124 早已改到 models\\ 下。这是 build/deploy 链
     死账里唯一有真危害的一条（误导用户去看不存在的目录）。

[A1] 归档 tools\\checks\\（8 个孤儿脚本）-> ..\\junk\\r12c-batch15\\tools-checks\\
     全仓零调用者，且 check_gsv.py:3 写死 D:\\Project\\...\\gsv-tools（已归档的树）。
     动手前脚本会自己再扫一遍引用，扫到任何一处就整条跳过并报告。

=== 本批不做什么（有意为之，留档） ===

  * 不删 PATH_EXCLUDE 里指向 vendor\\gsv-tools\\... 的“死条目”。
    它们是惰性的防御条目，注释明写“kept so that a build run on a machine that
    has not migrated yet still excludes the weights”。删掉 = 纯 churn + 非零风险。
  * 不动 web/src/（Owner 2026-08-20 确认：有意进包，前端源码）。
  * 不动 docs/（同上，保持现状）。
  * 不动 models/（打包器是对的：G2PWModel 词典下载器不会重拉，必须随包发。
    6/6 实测全在 G2PWModel/ 下，零权重文件）。
  * 不改 docs/SCOPE_r12c.md（SCOPE v4 另以散文件交付，避免整文件覆盖的锚点风险）。

⚠ 本机无 Rust 工具链（本项目也零 Rust），且本补丁未做编译验证。
⚠ 助手工作树是部分镜像（vendored 角色有 1MB 单文件上限），锚点均取自 <1MB 的文件。
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import time

BATCH = "r12c-batch15"
BACKUP_REL = os.path.join("cache", "patch-backup", BATCH)
JUNK_REL = os.path.join("..", "junk", BATCH)

# --------------------------------------------------------------------------
# 根定位：C7 上溯找 server.js（与 collect_repo_source_v4.1 / batch14 同一套）
# --------------------------------------------------------------------------


def find_root(start=None):
    d = os.path.abspath(start or os.path.dirname(os.path.abspath(__file__)))
    for _ in range(7):
        if os.path.isfile(os.path.join(d, "server.js")) and \
           os.path.isfile(os.path.join(d, "package.json")):
            return d
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    cwd = os.path.abspath(os.getcwd())
    if os.path.isfile(os.path.join(cwd, "server.js")):
        return cwd
    raise SystemExit("[FAIL] 找不到项目根（上溯 7 层没看到 server.js + package.json）")


# --------------------------------------------------------------------------
# 文本读写：保留 BOM 与行尾，匹配一律在 \n 归一化文本上做
# --------------------------------------------------------------------------

_BOM = b"\xef\xbb\xbf"


def read_text(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    bom = raw.startswith(_BOM)
    if bom:
        raw = raw[len(_BOM):]
    crlf = b"\r\n" in raw
    txt = raw.decode("utf-8").replace("\r\n", "\n")
    return txt, bom, crlf


def write_text(path, txt, bom, crlf):
    out = txt.replace("\n", "\r\n") if crlf else txt
    data = out.encode("utf-8")
    if bom:
        data = _BOM + data
    with open(path, "wb") as fh:
        fh.write(data)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ==========================================================================
# 编辑项定义：每项 = (相对路径, 标签, OLD, NEW)
# OLD 必须在原文里出现且仅出现 1 次；NEW 必须在原文里出现 0 次（幂等判据）
# ==========================================================================

PACK = os.path.join("tools", "build", "04_pack_release.py")
BOOT = os.path.join("tools", "deploy", "bootstrap.ps1")

# ---- E1 -------------------------------------------------------------------
E1_OLD = '''TOP_EXCLUDE = {
    "venv", ".venv", "venv_idx241", "assets", ".staging",
    # dev-time backups written by the apply-r12b-fix*.py patch scripts
    # (57 files, 1.8MB). Same category as .staging, which is already here.
    ".patch-backup",
'''

E1_NEW = '''TOP_EXCLUDE = {
    "venv", ".venv", "venv_idx241", "assets", ".staging",
    # dev-time backups written by the apply-r12b-fix*.py patch scripts
    # (57 files, 1.8MB). Same category as .staging, which is already here.
    #
    # r12c-batch15: this entry went STALE and silently stopped matching. It
    # names a TOP-LEVEL ".patch-backup" (leading dot); the patch scripts have
    # since written to "cache/patch-backup/" (no dot, one level deeper). The
    # rule kept evaluating, kept matching nothing, and 73 backup files -- five
    # r12b-era timestamped snapshots plus the r12c-batch12/13/14 backups,
    # including their applied.patch diffs -- shipped to end users. Kept here
    # for machines that still carry the old top-level folder; the live catch
    # is now the "patch-backup" entry in NAME_EXCLUDE, which is anchored to the
    # directory NAME at ANY depth and therefore survives the next move.
    ".patch-backup",
    # cache/ is scratch: patch backups (above), the HuggingFace hub cache
    # (cache/hf/...), and one-off build logs. Nothing here is read on a fresh
    # install -- every consumer recreates its own cache on first use.
    "cache",
    # .hermes/ is dev-only tooling state. Zero references from any shipped
    # code path (grepped across js/cjs/py/bat/ps1/json: the only two hits are
    # comments in dev scripts), yet it shipped one 14.3KB file.
    ".hermes",
'''

# ---- E2 -------------------------------------------------------------------
E2_OLD = '''NAME_EXCLUDE = {
    ".git", ".hg", ".svn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".numba_cache", ".cache", ".gradio", ".ipynb_checkpoints",
}
'''

E2_NEW = '''NAME_EXCLUDE = {
    ".git", ".hg", ".svn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".numba_cache", ".cache", ".gradio", ".ipynb_checkpoints",
    # r12c-batch15: apply-*.py patch backups, by DIRECTORY NAME at any depth.
    # TOP_EXCLUDE already drops "cache" and ".patch-backup", but both of those
    # are anchored to a specific location -- which is exactly how the original
    # ".patch-backup" rule died when the backups moved into cache/. This entry
    # is location-independent on purpose: it is the one that keeps working
    # after the next move.
    "patch-backup",
}
'''

# ---- E3 -------------------------------------------------------------------
E3_OLD = '''PATH_EXCLUDE = {
    os.path.join("web", "node_modules"),
'''

E3_NEW = '''PATH_EXCLUDE = {
    os.path.join("web", "node_modules"),
    # r12c-batch15: tools/dev holds ASSISTANT-GENERATED dev tooling -- the
    # apply-r12c-batch*.py patch scripts, collect_repo_source*.py, and the
    # read-only probes. r12c-batch13 moved them OUT of the repo root (the root
    # layout guard only inspects depth 1) and into tools/dev -- but tools/ is
    # shipped wholesale, so "tidying the root" quietly moved them INTO the
    # release. Caught by arithmetic: --dry-run reported 5908 files while the
    # probe reported 5909, and the one extra file was the probe itself, which
    # had just been dropped into tools/dev. Same failure mode as the stale
    # ".patch-backup" rule above: a depth-anchored guard vs. content that moved.
    os.path.join("tools", "dev"),
'''

# ---- E4 -------------------------------------------------------------------
E4_OLD = '''        if not any(norm(r) == norm(need) or norm(r).startswith(norm(need)) for r, _, _ in included):
            print(f"  [WARN] missing {need}  -> {hint}")
    # data/ is per-installation state apart from the DATA_KEEP allowlist. A leak
'''

E4_NEW = '''        if not any(norm(r) == norm(need) or norm(r).startswith(norm(need)) for r, _, _ in included):
            print(f"  [WARN] missing {need}  -> {hint}")

    # ---- HARD preflight: the r12c relocation targets ------------------------
    # Everything above is a [WARN]: it prints and packs anyway. That is fine for
    # "you forgot to build the frontend" but wrong for the trees r12c MOVED,
    # because the failure mode there is a zip that extracts and then cannot
    # synthesise anything -- with no error at pack time. Note that not one of
    # the WARN entries above mentions engines/ or pipeline/, so a clean
    # "0 warnings" run proved only that the PRE-r12c files were still there.
    #
    # Floors are set at roughly half the 2026-08-20 measured counts, so normal
    # churn cannot trip them but "the tree moved / emptied" always does:
    #   engines/gpt-sovits 183   pipeline/uvr5 58   pipeline/asr 6
    #   pipeline/slicer 2        lib 135
    required = [
        ("engines/gpt-sovits/", 100, "live TTS engine (r12c: was vendor/tts/gpt-sovits)"),
        ("pipeline/uvr5/",       30, "vocal separation (r12c: was vendor/uvr5)"),
        ("pipeline/asr/",         3, "speech recognition (r12c: was vendor/asr)"),
        ("pipeline/slicer/",      1, "audio slicing (r12c: was vendor/slicer)"),
        ("lib/",                 50, "our own server-side code"),
    ]
    hard_fail = []
    for prefix, floor, what in required:
        n = sum(1 for r, _, _ in included if norm(r).startswith(prefix))
        if n < floor:
            hard_fail.append((prefix, n, floor, what))
    if not any(norm(r) == "server.js" for r, _, _ in included):
        hard_fail.append(("server.js", 0, 1, "broker main program"))
    if hard_fail:
        print("\\n[PREFLIGHT-FAIL] the release is missing code it cannot run without:")
        for prefix, n, floor, what in hard_fail:
            print(f"    {prefix:<26} {n:>5} file(s), expected >= {floor}   ({what})")
        print("  This is a FAIL, not a warning: such a zip extracts cleanly and")
        print("  then fails at runtime, which is the kind that ships unnoticed.")
        print("  Check the exclusion tables above and the layout in docs/ROOT_LAYOUT.md.")
        return 4

    # data/ is per-installation state apart from the DATA_KEEP allowlist. A leak
'''

# ---- E5 -------------------------------------------------------------------
E5_OLD = """    Info '   -> vendor\\gsv-tools\\pretrained | asr | uvr5_weights'
"""

E5_NEW = """    Info '   -> models\\tts\\gpt-sovits | models\\asr | models\\separation\\uvr5'
"""

E6_OLD = """  Info '   vendor\\gsv-tools\\pretrained | asr | uvr5_weights'
"""

E6_NEW = """  Info '   models\\tts\\gpt-sovits | models\\asr | models\\separation\\uvr5'
"""

# 每项第 5 个字段是「已应用标记」：只在 NEW 里出现、绝不在 OLD 里出现。
# 为什么需要它：E3 的 OLD 是 NEW 的前缀（新条目插在 web/node_modules 之后），
# 所以“应用完 OLD 就消失”这个朴素判据对 E3 不成立 —— 第一版就是这么误报的。
# 幂等一律以标记为准，不再靠 OLD 是否还在。
EDITS = [
    (PACK, "E1 TOP_EXCLUDE +cache +.hermes", E1_OLD, E1_NEW,
     "r12c-batch15: this entry went STALE"),
    (PACK, "E2 NAME_EXCLUDE +patch-backup", E2_OLD, E2_NEW,
     "r12c-batch15: apply-*.py patch backups, by DIRECTORY NAME"),
    (PACK, "E3 PATH_EXCLUDE +tools/dev", E3_OLD, E3_NEW,
     "r12c-batch15: tools/dev holds ASSISTANT-GENERATED"),
    (PACK, "E4 preflight FAIL (r12c 落点)", E4_OLD, E4_NEW,
     "[PREFLIGHT-FAIL]"),
    (BOOT, "E5 bootstrap 提示词(非交互分支)", E5_OLD, E5_NEW, E5_NEW),
    (BOOT, "E6 bootstrap 提示词(交互分支)", E6_OLD, E6_NEW, E6_NEW),
]

# ==========================================================================
# 归档项
# ==========================================================================

ARCHIVE_DIR_REL = os.path.join("tools", "checks")
ARCHIVE_EXPECTED = {
    "check_all.py", "check_big.py", "check_gsv.py", "check_pack.py",
    "check_python.js", "check_python2.js", "check_tar.py", "check_tar2.py",
}

# 归档前自行复核“零引用”。命中任何一处就整条跳过。
REF_TOKENS = [
    "tools/checks", "tools\\checks",
    "check_all", "check_big", "check_gsv", "check_pack",
    "check_tar", "check_tar2", "check_python",
]
REF_SCAN_DIRS = ["lib", "docs", "pipeline", "engines",
                 os.path.join("web", "src"), "tools"]
REF_SKIP_DIRS = {"node_modules", "venv", ".venv", ".git", "runtime", "wheels",
                 "__pycache__", "dist", "checks", "patch-backup"}
REF_EXT = {".js", ".cjs", ".mjs", ".py", ".bat", ".ps1", ".json", ".md", ".txt"}

# 命中分三类，只有第三类阻断归档：
#
#   [文档] .md/.txt —— 提及 != 调用。一棵没人调用的树不该被“某篇计划文档写到过
#          它”挡住归档。但文档确实会因此过期，所以全部打印出来当待办。
#
#   [助手] tools/dev/ 下的任何文件 —— 这里放的是**已应用的补丁脚本**（它们是
#          --restore 的唯一凭据，属于历史记录，不该改）和只读探针。它们不是
#          产品代码，E3 本来就把整个 tools/dev 排除出发行包，因此从这里指向
#          tools/checks 的引用在物理上不可能影响用户拿到的东西。
#          实测这一类的三处全是「排除名单/注释/内嵌计划表」而非调用：
#            apply-r12c-batch14.py:22   注释「不修 tools/checks/check_*.py」
#            apply-r12c-batch14.py:371  内嵌 SCOPE_MD 里的 Batch 5 表格行
#            apply-r12c-batch14.py:681  它自己的扫描器 skip-list，跳过这三个目录
#
#   [代码] 其余任何位置的 .js/.cjs/.mjs/.py/.bat/.ps1/.json —— 一处命中即整条跳过。
#          lib/ pipeline/ engines/ web/src/ 和项目根都落在这一类里。
REF_DOC_EXT = {".md", ".txt"}
REF_SOFT_PREFIX = ("tools/dev/",)

# 已核实的“提及但非调用”。逐行精确匹配（文件 + 去空白后的整行），所以那一行
# 只要被改过，白名单就不再命中，守卫会重新把它当成真引用拦下来。
#   collect_repo_source_v4.1.py 的 DEV_SCRIPT_RE 是采集器的“开发脚本排除名单”
#   （注释原文：“我自己产的，不需要回传给我”），把 check_big.py 列在里面是为了
#   不回传，不是在调用它。tools/checks 归档后这条正则只是少匹配一个文件名。
BENIGN_REFS = {
    ("tools/dev/collect_repo_source_v4.1.py",
     r'r"|collect_repo_source\.py|check_big\.py"'),
}


def scan_references(root):
    """返回 [(相对路径, 行号, 命中 token, 行内容)]，不含 tools/checks 自身。"""
    hits = []      # 代码引用 —— 阻断
    docs = []      # 文档提及 —— 只报告
    benign = []    # 逐行白名单放行
    targets = []
    for fn in os.listdir(root):
        p = os.path.join(root, fn)
        if os.path.isfile(p) and os.path.splitext(fn)[1].lower() in REF_EXT:
            targets.append(p)
    for d in REF_SCAN_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in REF_SKIP_DIRS]
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in REF_EXT:
                    targets.append(os.path.join(dirpath, fn))
    for p in targets:
        rel = os.path.relpath(p, root).replace("\\", "/")
        if rel.startswith("tools/checks/"):
            continue
        # 本补丁自己也提到这些名字，别自我命中
        if os.path.basename(p) == os.path.basename(__file__):
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                if os.path.splitext(p)[1].lower() in REF_DOC_EXT:
                    kind = "文档"
                elif rel.startswith(REF_SOFT_PREFIX):
                    kind = "助手"
                else:
                    kind = "代码"
                for i, line in enumerate(fh, 1):
                    for tok in REF_TOKENS:
                        if tok in line:
                            if (rel, line.strip()) in BENIGN_REFS:
                                benign.append((rel, i, tok))
                            elif kind == "代码":
                                hits.append((kind, rel, i, tok, line.strip()[:100]))
                            else:
                                docs.append((kind, rel, i, tok, line.strip()[:100]))
                            break
        except OSError:
            continue
    return hits, docs, benign


# ==========================================================================
# 计划
# ==========================================================================


class Plan(object):
    def __init__(self):
        self.edits = []        # (path, label, old, new)
        self.skipped = []      # (label, reason)
        self.archive = None    # (src_abs, dst_abs, [files])
        self.refhits = []      # (类别, 相对路径, 行号, token, 行内容)
        self.notes = []


def build_plan(root):
    plan = Plan()

    # ---- 编辑项 ----
    cache = {}
    for rel, label, old, new, mark in EDITS:
        p = os.path.join(root, rel)
        if not os.path.isfile(p):
            plan.skipped.append((label, "文件不存在: %s" % rel))
            continue
        if rel not in cache:
            cache[rel] = read_text(p)[0]
        txt = cache[rel]
        if mark in txt:
            plan.skipped.append((label, "已应用（已应用标记在位）—— 幂等跳过"))
            continue
        n_old = txt.count(old)
        if n_old == 0:
            plan.skipped.append((label, "⛔ 锚点 OLD 没找到（文件可能已被改动）"))
            continue
        if n_old > 1:
            plan.skipped.append((label, "⛔ 锚点 OLD 命中 %d 次，不唯一，拒绝改" % n_old))
            continue
        plan.edits.append((rel, label, old, new))
        cache[rel] = txt.replace(old, new, 1)

    # ---- 归档项 ----
    src = os.path.join(root, ARCHIVE_DIR_REL)
    if not os.path.isdir(src):
        plan.skipped.append(("A1 归档 tools\\checks", "目录不存在（可能已归档）"))
    else:
        found = set()
        extra = []
        for dirpath, dirnames, filenames in os.walk(src):
            for fn in filenames:
                r = os.path.relpath(os.path.join(dirpath, fn), src).replace("\\", "/")
                found.add(r)
                if r not in ARCHIVE_EXPECTED:
                    extra.append(r)
        if extra:
            plan.skipped.append((
                "A1 归档 tools\\checks",
                "⛔ 出现预期外的文件 %s —— 有条件归档：不动，只报告" % ", ".join(sorted(extra)[:5])))
        else:
            hits, docs, benign = scan_references(root)
            # 无论拦不拦，命中明细一律全打出来 —— 只报“首处”等于让人没法判断
            plan.refhits.extend(hits)
            plan.refhits.extend(docs)
            if hits:
                plan.skipped.append((
                    "A1 归档 tools\\checks",
                    "⛔ 复扫到 %d 处代码引用 —— 不再是孤儿，不动（明细见下）" % len(hits)))
            else:
                dst = os.path.abspath(os.path.join(root, JUNK_REL, "tools-checks"))
                plan.archive = (src, dst, sorted(found))
                n_doc = sum(1 for h in docs if h[0] == "文档")
                n_dev = sum(1 for h in docs if h[0] == "助手")
                plan.notes.append(
                    "A1 引用复扫：**0 处产品代码引用**（扫描 %s + 根目录）。"
                    "另有 %d 处文档提及、%d 处 tools/dev 助手脚本提及、%d 处逐行"
                    "白名单放行 —— 均不阻断（明细见上），但文档那几处归档后会过期。"
                    % ("、".join(REF_SCAN_DIRS), n_doc, n_dev, len(benign)))
    return plan


# ==========================================================================
# 应用 / 还原
# ==========================================================================


def do_write(root, plan):
    backup = os.path.join(root, BACKUP_REL)
    os.makedirs(backup, exist_ok=True)
    record = {"batch": BATCH, "when": time.strftime("%Y-%m-%d %H:%M:%S"),
              "root": root, "edits": [], "archive": None}

    touched = {}
    for rel, label, old, new in plan.edits:
        touched.setdefault(rel, []).append((label, old, new))

    for rel, ops in touched.items():
        p = os.path.join(root, rel)
        flat = rel.replace("\\", "__").replace("/", "__")
        bak = os.path.join(backup, flat + ".bak")
        if not os.path.exists(bak):
            shutil.copy2(p, bak)
        before = sha256_file(p)
        txt, bom, crlf = read_text(p)
        for label, old, new in ops:
            if txt.count(old) != 1:
                raise SystemExit("[FAIL] 写入前复核失败：%s 的锚点变了" % label)
            txt = txt.replace(old, new, 1)
        write_text(p, txt, bom, crlf)
        after = sha256_file(p)
        record["edits"].append({"path": rel, "backup": os.path.basename(bak),
                                "labels": [o[0] for o in ops],
                                "sha256_before": before, "sha256_after": after})
        print("   [改] %-34s  %s -> %s" % (rel, before[:12], after[:12]))

    if plan.archive:
        src, dst, files = plan.archive
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            raise SystemExit("[FAIL] 归档落点已存在，拒绝覆盖：%s" % dst)
        sums = {f: sha256_file(os.path.join(src, f.replace("/", os.sep))) for f in files}
        shutil.move(src, dst)
        for f in files:
            got = sha256_file(os.path.join(dst, f.replace("/", os.sep)))
            if got != sums[f]:
                raise SystemExit("[FAIL] 归档后 sha256 不一致：%s" % f)
        record["archive"] = {"from": ARCHIVE_DIR_REL, "to": os.path.relpath(dst, root),
                             "files": files, "sha256": sums}
        print("   [归档] %s -> %s  (%d 个文件，逐一 sha256 复核通过)"
              % (ARCHIVE_DIR_REL, os.path.relpath(dst, root), len(files)))

    with open(os.path.join(backup, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    print("\n   备份与清单：%s" % os.path.join(BACKUP_REL, "manifest.json"))
    return record


def do_restore(root):
    backup = os.path.join(root, BACKUP_REL)
    mf = os.path.join(backup, "manifest.json")
    if not os.path.isfile(mf):
        raise SystemExit("[FAIL] 没有找到 %s，无从还原" % mf)
    with open(mf, "r", encoding="utf-8") as fh:
        record = json.load(fh)

    # 严格反序：先还原归档，再还原编辑
    arc = record.get("archive")
    if arc:
        dst = os.path.join(root, arc["to"])
        src = os.path.join(root, arc["from"])
        if not os.path.isdir(dst):
            print("   [跳过] 归档落点不在了：%s" % arc["to"])
        elif os.path.exists(src):
            print("   [跳过] 原位置已存在，不覆盖：%s" % arc["from"])
        else:
            shutil.move(dst, src)
            bad = [f for f in arc["files"]
                   if sha256_file(os.path.join(src, f.replace("/", os.sep))) != arc["sha256"][f]]
            if bad:
                raise SystemExit("[FAIL] 还原后 sha256 不一致：%s" % ", ".join(bad))
            print("   [还原归档] %s  (%d 个文件 sha256 全部一致)"
                  % (arc["from"], len(arc["files"])))

    for e in reversed(record["edits"]):
        p = os.path.join(root, e["path"])
        bak = os.path.join(backup, e["backup"])
        if not os.path.isfile(bak):
            print("   [跳过] 备份不在：%s" % e["backup"])
            continue
        cur = sha256_file(p) if os.path.isfile(p) else "(缺失)"
        if cur != e["sha256_after"]:
            print("   [警告] %s 当前 sha256 与本补丁写入后的值不同（%s vs %s），"
                  "说明之后又被改过；仍按备份还原。" % (e["path"], cur[:12], e["sha256_after"][:12]))
        shutil.copy2(bak, p)
        got = sha256_file(p)
        ok = "✅" if got == e["sha256_before"] else "⛔"
        print("   [还原] %s %-34s %s" % (ok, e["path"], got[:12]))
        if got != e["sha256_before"]:
            raise SystemExit("[FAIL] 还原后与补丁前 sha256 不一致：%s" % e["path"])
    print("\n   还原完成。备份目录保留在 %s（需要时自行删除）。" % BACKUP_REL)


# ==========================================================================
# 自检
# ==========================================================================


def selftest():
    ok = fail = 0

    def chk(cond, name):
        nonlocal ok, fail
        if cond:
            ok += 1
            print("   ok    %s" % name)
        else:
            fail += 1
            print("   FAIL  %s" % name)

    # OLD/NEW 方向守卫
    for rel, label, old, new, mark in EDITS:
        chk(old and new and old != new, "%s：OLD/NEW 非空且不同" % label.split()[0])
    # 已应用标记：必须只在 NEW 里、不在 OLD 里，否则幂等判据会自欺
    for rel, label, old, new, mark in EDITS:
        chk(mark in new and mark not in old,
            "%s：已应用标记只在 NEW 里、不在 OLD 里" % label.split()[0])
    chk(len({m for _, _, _, _, m in EDITS}) == len(EDITS),
        "六个已应用标记互不相同")
    # E3 是“OLD 为 NEW 前缀”的那一项：正因如此才不能用“OLD 消失”当幂等判据
    chk(E3_NEW.startswith(E3_OLD),
        "E3：OLD 确实是 NEW 的前缀（这正是不能用 OLD 判幂等的原因）")
    chk(E1_OLD.rstrip("\n").splitlines()[0] in E1_NEW, "E1：NEW 保留了 OLD 的首行")
    chk('"cache",' in E1_NEW and '".hermes",' in E1_NEW, "E1：确实加进了 cache 与 .hermes")
    chk('"patch-backup",' in E2_NEW and '"patch-backup",' not in E2_OLD,
        "E2：patch-backup 只在 NEW 里")
    chk('os.path.join("tools", "dev")' in E3_NEW and
        'os.path.join("tools", "dev")' not in E3_OLD, "E3：tools/dev 只在 NEW 里")
    chk("return 4" in E4_NEW and "PREFLIGHT-FAIL" in E4_NEW, "E4：是 FAIL 且真的 return")
    # E4 是“在中间插一段”，OLD 的首尾两块必须都还在 NEW 里，且顺序不变
    _e4_head = E4_OLD.split("\n")[0]
    _e4_warn = '            print(f"  [WARN] missing {need}  -> {hint}")'
    _e4_tail = "    # data/ is per-installation state apart from the DATA_KEEP allowlist. A leak"
    chk(_e4_head in E4_NEW and _e4_warn in E4_NEW and _e4_tail in E4_NEW,
        "E4：原 WARN 逻辑的首/中/尾三块都还在 NEW 里")
    chk(E4_NEW.index(_e4_warn) < E4_NEW.index("PREFLIGHT-FAIL") < E4_NEW.index(_e4_tail),
        "E4：新块插在 WARN 之后、data/ 检查之前（顺序正确）")
    chk("gsv-tools" in E5_OLD and "gsv-tools" not in E5_NEW, "E5：旧路径被换掉")
    chk("gsv-tools" in E6_OLD and "gsv-tools" not in E6_NEW, "E6：旧路径被换掉")
    chk(E5_OLD != E6_OLD, "E5/E6：两处锚点互不相同（不会重复替换同一行）")

    # 行尾/BOM 往返
    for bom in (True, False):
        for crlf in (True, False):
            tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "._b15_eol_probe.tmp")
            try:
                write_text(tmp, "a\nb\n", bom, crlf)
                t, b2, c2 = read_text(tmp)
                assert t == "a\nb\n" and b2 == bom and c2 == crlf
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
    chk(True, "read_text/write_text：BOM×行尾 4 种组合往返无损")

    # 反例守卫：不存在的锚点必须被判为找不到
    fakeplan_txt = "nothing here"
    chk(fakeplan_txt.count(E1_OLD) == 0, "反例守卫：无关文本里 OLD 命中 0 次")

    # 归档清单
    chk(len(ARCHIVE_EXPECTED) == 8, "A1：预期归档 8 个文件")
    chk("check_gsv.py" in ARCHIVE_EXPECTED, "A1：清单含写死 D:\\ 路径的 check_gsv.py")
    chk("checks" in REF_SKIP_DIRS, "A1：引用复扫会跳过 tools/checks 自身")
    # 良性白名单必须是逐行精确的：改一个字就不再命中
    _br = sorted(BENIGN_REFS)[0]
    chk(_br[1].strip() == _br[1] and "check_big" in _br[1],
        "A1：良性白名单按去空白整行匹配，且确实含被提及的脚本名")
    chk((_br[0], _br[1] + " ") not in BENIGN_REFS,
        "A1：白名单不做子串匹配（多一个空格就不命中）")
    chk(REF_DOC_EXT and REF_DOC_EXT < REF_EXT,
        "A1：文档扩展名是被扫描扩展名的真子集（否则文档根本没被扫到）")
    chk(".py" not in REF_DOC_EXT and ".js" not in REF_DOC_EXT and
        ".json" not in REF_DOC_EXT,
        "A1：代码扩展名没有被误划进「文档提及」（那样会让阻断失效）")
    # 软化类别最危险的失效方式：前缀写太宽，把产品代码也变成“不阻断”。
    _product = ["lib/services/x.js", "pipeline/uvr5/y.py", "engines/gpt-sovits/z.py",
                "web/src/a.jsx", "server.js", "tools/build/04_pack_release.py",
                "tools/deploy/bootstrap.ps1"]
    chk(not any(p.startswith(REF_SOFT_PREFIX) for p in _product),
        "A1：软化前缀不会把 lib/pipeline/engines/web/根/tools\\build/tools\\deploy 也软化掉")
    chk(all(p.startswith(REF_SOFT_PREFIX) for p in
            ["tools/dev/apply-r12c-batch14.py", "tools/dev/probe_x.py"]),
        "A1：软化前缀确实覆盖 tools/dev/ 下的文件")
    chk("tools/dev/" in REF_SOFT_PREFIX and "tools/" not in REF_SOFT_PREFIX,
        "A1：软化的是 tools/dev/ 而不是整个 tools/")

    print("\n   自检：%d ok / %d FAIL" % (ok, fail))
    return 0 if fail == 0 else 1


# ==========================================================================
# main
# ==========================================================================


def main():
    ap = argparse.ArgumentParser(description="r12c Batch 5a")
    ap.add_argument("--root", default=None)
    ap.add_argument("--write", action="store_true", help="真改（默认只 dry-run）")
    ap.add_argument("--restore", action="store_true", help="按备份严格反序还原")
    ap.add_argument("--selftest", action="store_true", help="只自检，不碰盘")
    args = ap.parse_args()

    print("apply-%s   r12c Batch 5a：发行包收口 + 死账清理" % BATCH)
    print("=" * 74)

    if args.selftest:
        print("\n[自检]")
        return selftest()

    root = os.path.abspath(args.root) if args.root else find_root()
    print("项目根：%s" % root)

    if args.restore:
        print("\n[还原]")
        do_restore(root)
        return 0

    plan = build_plan(root)

    print("\n[计划] 将要改的文件")
    if plan.edits:
        for rel, label, _, _ in plan.edits:
            print("   + %-34s %s" % (rel, label))
    else:
        print("   （无）")

    if plan.archive:
        src, dst, files = plan.archive
        print("\n[计划] 将要归档")
        print("   + %s  ->  %s" % (ARCHIVE_DIR_REL, os.path.relpath(dst, root)))
        for f in files:
            print("       %s" % f)

    if plan.skipped:
        print("\n[跳过]")
        for label, why in plan.skipped:
            print("   - %-34s %s" % (label, why))

    if plan.refhits:
        print("\n[A1 引用复扫明细] 代码 = 阻断归档；文档 = 不阻断，但归档后会过期")
        for kind, rel, i, tok, line in plan.refhits:
            print("   [%s] %s:%d  (%s)" % (kind, rel, i, tok))
            print("        %s" % line)

    for n in plan.notes:
        print("\n[note] %s" % n)

    if not args.write:
        print("\n(DRY-RUN) 没有写过任何文件。加 --write 才会真改。")
        print("应用后请复核：")
        print("   python tools\\build\\04_pack_release.py --dry-run")
        print("   python tools\\dev\\probe_release_contents.py")
        print("   node tools\\run_tests.cjs")
        return 0

    print("\n[写入]")
    do_write(root, plan)
    print("\n完成。回滚：python tools\\dev\\apply-%s.py --restore" % BATCH)
    print("⚠ 本补丁未做编译验证（本机无 Rust 工具链；本项目也零 Rust）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
