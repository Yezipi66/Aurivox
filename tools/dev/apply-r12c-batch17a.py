#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""apply-r12c-batch17a.py -- 把 IndexTTS2 的源码包复制进 engines/indextts2/

[r12c batch17a / 2026-08-22]

=== 本批做什么 ===

  B1  复制 <src>\indextts\  ->  engines\indextts2\indextts\
      （剔除 __pycache__ / *.pyc / *.pyo / *.bak）
  B2  复制 LICENSE / LICENSE_ZH.txt / DISCLAIMER
      （pyproject.toml 的 license-files 指着它们；而且 vendor\{uvr5,asr,slicer}
        和 gsv_code\ 四棵树一个 LICENSE 都没有，这次别再复制那个缺口）
  B3  新建 NOTICE（我方撰写的归属声明，写死上游 commit sha）
  B4  新建 SOURCE_MANIFEST.json（逐文件 sha256）

=== 本批不做什么 ===

  ⛔ 不动 <src> 一个字节 —— 是**复制**不是移动，所以这一批可逆。
  ⛔ 不搬 checkpoints\（11GB，batch17b）。
  ⛔ 不写 shim / manifest.json（batch18）。
  ⛔ 不改任何**已存在**的文件 —— 因此不需要任何内容锚点。
     （batch16 的 A5 就是栽在「拿假树反推真机锚点」上。本批从设计上回避。）

=== 三条纪律 ===

  1. 默认 DRY-RUN。--write 才落盘，落盘前先备份到
     cache\patch-backup\r12c-batch17a\。
  2. 前提不成立就**一个字节都不写**：先核验 batch16 的后态和源树形状，
     任何一条不成立立即 return 1。
  3. 目标已存在且**内容不同**时**拒绝**，不静默覆盖 —— 静默覆盖会把
     「我改过的东西」无声抹掉。内容相同则跳过（幂等）。
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile

BANNER = "[r12c batch17a / 2026-08-22]"

DEFAULT_SRC = r"D:\AI\index-tts"

ENGINE_REL = os.path.join("engines", "indextts2")
PKG_NAME = "indextts"
MANIFEST_NAME = "SOURCE_MANIFEST.json"
BACKUP_REL = os.path.join("cache", "patch-backup", "r12c-batch17a")

# 上游身份。删掉 .git 之后就拿不回来了，所以写死在这里。
UPSTREAM_COMMIT = "13495845e3028f0bb6ca1462ad22aa0e76349e40"
UPSTREAM_DATE = "2026-07-14 19:43:37 +0800"
UPSTREAM_URL = "https://github.com/index-tts/index-tts"

# batch16 的后态。看的是「新样子在不在」，不是「老样子还在不在」——
# 后者分不清「已经改过」和「文件本来就不一样」。
REQUIRE_EXISTS = [
    (os.path.join(ENGINE_REL, "pyproject.toml"), "batch16 A1 配方"),
    (os.path.join(ENGINE_REL, "uv.lock"), "batch16 A1 配方"),
    (os.path.join(ENGINE_REL, ".python-version"), "batch16 A1 配方"),
    (os.path.join(ENGINE_REL, "MANIFEST.in"), "batch16 A1 配方"),
    (os.path.join(ENGINE_REL, "UPSTREAM.md"), "batch16 A7"),
    (os.path.join(ENGINE_REL, "LOCAL-CHANGES.md"), "batch16 A7"),
]

LICENSE_FILES = ["LICENSE", "LICENSE_ZH.txt", "DISCLAIMER"]

EXCLUDE_DIRS = {"__pycache__", ".git", ".venv", ".pytest_cache",
                ".mypy_cache", ".ruff_cache", ".idea", ".vscode"}
EXCLUDE_EXT = {".pyc", ".pyo"}


# --------------------------------------------------------------------------
#  小工具
# --------------------------------------------------------------------------

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def is_excluded_name(name):
    """单个文件名是否该被剔除。目录另由 EXCLUDE_DIRS 处理。"""
    lower = name.lower()
    ext = os.path.splitext(lower)[1]
    if ext in EXCLUDE_EXT:
        return True
    # v4.1 采集器的教训：只认 `.bak$` 会漏掉 `xxx.yaml.bak-20260817-160832`
    if ".bak" in lower:
        return True
    return False


def walk_package(pkg_dir):
    """产出 (相对路径, 绝对路径)，已剔除排除项。顺序稳定，便于逐字节复现。"""
    out = []
    for cur, dirs, files in os.walk(pkg_dir):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for name in sorted(files):
            if is_excluded_name(name):
                continue
            full = os.path.join(cur, name)
            rel = os.path.relpath(full, pkg_dir)
            out.append((rel.replace("\\", "/"), full))
    return out


def find_root(anchor_file=None):
    """靠锚点上溯定位项目根。⛔ 找不到就显式抛错，不用 cwd 兜底。

    cwd 兜底是**静默**的失败：脚本会在错误的目录下正确地干活。
    """
    start = os.path.dirname(os.path.abspath(anchor_file or __file__))
    cur = start
    while True:
        if (os.path.isfile(os.path.join(cur, "server.js"))
                and os.path.isdir(os.path.join(cur, "lib"))
                and os.path.isdir(os.path.join(cur, "engines"))):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            raise RuntimeError(
                "找不到项目根（向上找不到同时含 server.js + lib\\ + engines\\ 的目录）。\n"
                "起点：%s\n"
                "请把本脚本放在 tools\\dev\\ 下运行，或用 --root 显式指定。" % start)
        cur = parent


# --------------------------------------------------------------------------
#  NOTICE
# --------------------------------------------------------------------------

def notice_text():
    return """\
NOTICE -- engines/indextts2
===========================================================================

本目录包含 IndexTTS2 的上游源码，版权归原作者所有。

  上游项目 : IndexTTS2
  作者     : Bilibili IndexTTS Team
  仓库     : %s
  commit   : %s
  提交时间 : %s

许可证
---------------------------------------------------------------------------
上游随源码分发以下文件，已一并复制进本目录，内容未作任何改动：

  LICENSE          上游许可证（LicenseRef-Bilibili-IndexTTS）
  LICENSE_ZH.txt   上述许可证的中文本
  DISCLAIMER       上游免责声明

模型权重另有许可条款，不随本仓库分发，也不进发行包。权重位置见
engines/indextts2/UPSTREAM.md。

我方改动
---------------------------------------------------------------------------
截至本文件写入之时，indextts/ 下的上游代码**逐字节未改**（SOURCE_MANIFEST.json
记录了每个文件的 sha256，可随时复核）。

日后若确有改动，必须同时做两件事，缺一不可：

  1. 在 engines/indextts2/LOCAL-CHANGES.md 里写清改了什么、为什么改；
  2. 更新 SOURCE_MANIFEST.json，使「上游原样」与「我方改动」始终可区分。

留下 LOCAL-CHANGES.md 这个物证，正是本项目区分 vendor/（成品，没改过）与
engines/（改过，要自己维护）的判据 —— 见 lib/paths.js 顶层目录角色一节。

为什么补这个 NOTICE
---------------------------------------------------------------------------
vendor/{uvr5,asr,slicer} 和 engines/gpt-sovits/gsv_code/ 四棵树至今一个
LICENSE 都没有。那是历史欠账，不是可以照抄的先例。这次接入 IndexTTS2 是
把这件事做对的机会，所以从第一天就把归属声明补齐。
""" % (UPSTREAM_URL, UPSTREAM_COMMIT, UPSTREAM_DATE)


# --------------------------------------------------------------------------
#  核验
# --------------------------------------------------------------------------

def verify_preconditions(root, src, report):
    """返回 (ok, 源包目录)。任何一条不成立都不许写。"""
    ok = True

    report("[1] 核验前提（不成立就一个字节都不写）")
    report("")

    # --- batch16 的后态 ---
    for rel, why in REQUIRE_EXISTS:
        p = os.path.join(root, rel)
        if os.path.isfile(p):
            report("   ok   在   %s   [%s]" % (rel, why))
        else:
            ok = False
            report("   FAIL 缺   %s   [%s]" % (rel, why))
            report("        ⇒ batch16 没跑过或没跑成。先把 batch16 收口。")

    # --- 源仓库形状 ---
    pkg_dir = os.path.join(src, PKG_NAME)
    init_py = os.path.join(pkg_dir, "__init__.py")
    if os.path.isdir(pkg_dir) and os.path.isfile(init_py):
        report("   ok   源包 %s\\%s\\__init__.py 在" % (src, PKG_NAME))
    else:
        ok = False
        report("   FAIL 源包不成立：%s" % init_py)
        report("        ⇒ 目录名 indextts 就是 Python 包名（全树 104 处 "
               "`from indextts…`），")
        report("          没有 __init__.py 说明拿错了目录。")

    for name in LICENSE_FILES:
        p = os.path.join(src, name)
        if os.path.isfile(p):
            report("   ok   源 %s 在" % name)
        else:
            ok = False
            report("   FAIL 源缺 %s" % name)
            report("        ⇒ pyproject.toml 的 license-files 指着它，"
                   "缺了不许往下走。")

    report("")
    return ok, pkg_dir


# --------------------------------------------------------------------------
#  计划
# --------------------------------------------------------------------------

def build_plan(root, src, pkg_dir):
    """算出要复制/新建什么。返回 (plan, conflicts)。

    plan 每项：dict(rel, src, kind, action)
      action: 'create' 新建 | 'same' 内容已相同（跳过） | 'conflict' 已存在且不同
    """
    engine_dir = os.path.join(root, ENGINE_REL)
    plan = []

    # B1 源码包
    for rel, full in walk_package(pkg_dir):
        dst_rel = os.path.join(ENGINE_REL, PKG_NAME, rel.replace("/", os.sep))
        plan.append({"rel": dst_rel, "src": full, "kind": "pkg"})

    # B2 许可证
    for name in LICENSE_FILES:
        plan.append({"rel": os.path.join(ENGINE_REL, name),
                     "src": os.path.join(src, name), "kind": "license"})

    # B3/B4 由我方生成，src 为 None
    plan.append({"rel": os.path.join(ENGINE_REL, "NOTICE"),
                 "src": None, "kind": "notice"})

    for item in plan:
        dst = os.path.join(root, item["rel"])
        if not os.path.exists(dst):
            item["action"] = "create"
            continue
        if item["src"] is None:
            body = notice_text().encode("utf-8")
            same = (open(dst, "rb").read() == body)
        else:
            same = (sha256_of(dst) == sha256_of(item["src"]))
        item["action"] = "same" if same else "conflict"

    conflicts = [i for i in plan if i["action"] == "conflict"]
    return engine_dir, plan, conflicts


# --------------------------------------------------------------------------
#  执行
# --------------------------------------------------------------------------

def do_apply(root, src, write, report, force=False):
    ok, pkg_dir = verify_preconditions(root, src, report)
    if not ok:
        report("=" * 74)
        report("⛔ 前提不成立，**没有写任何文件**。")
        return 1

    engine_dir, plan, conflicts = build_plan(root, src, pkg_dir)

    if conflicts and not force:
        report("[2] ⛔ 目标已存在且内容不同 —— 拒绝执行")
        report("")
        for item in conflicts[:20]:
            report("   冲突 %s" % item["rel"])
        if len(conflicts) > 20:
            report("   …… 另有 %d 处" % (len(conflicts) - 20))
        report("")
        report("   静默覆盖会把「我改过的东西」无声抹掉，所以这里停。")
        report("   如果确认要覆盖：先 --restore，或加 --force（会先备份）。")
        report("=" * 74)
        report("⛔ **没有写任何文件**。")
        return 1

    n_create = sum(1 for i in plan if i["action"] == "create")
    n_same = sum(1 for i in plan if i["action"] == "same")
    n_pkg = sum(1 for i in plan if i["kind"] == "pkg")
    bytes_pkg = sum(os.path.getsize(i["src"]) for i in plan
                    if i["kind"] == "pkg")

    report("[2] 复制计划")
    report("")
    report("   源  ：%s   （只读，本批不动它一个字节）" % src)
    report("   目标：%s" % engine_dir)
    report("")
    report("   B1 源码包 indextts\\ : %d 个文件 / %.1f MB"
           % (n_pkg, bytes_pkg / 1048576.0))
    for name in LICENSE_FILES:
        report("   B2 %s" % name)
    report("   B3 NOTICE            （我方撰写）")
    report("   B4 %s  （逐文件 sha256）" % MANIFEST_NAME)
    report("")
    report("   新建 %d 项；已存在且内容相同、跳过 %d 项" % (n_create, n_same))
    report("")

    if not write:
        report("=" * 74)
        report("这是 DRY-RUN，没有写过任何文件。确认后：")
        report("   python tools\\dev\\apply-r12c-batch17a.py --write")
        return 0

    # ---- 落盘 ----
    backup_dir = os.path.join(root, BACKUP_REL)

    # ⭐⭐ 继承上一份清单的归属记录。
    #
    # 不继承会出一个很隐蔽的事故：第二次 --write 时所有文件都判「内容相同、
    # 跳过」，于是 created 列表算出来是**空的**，清单被覆盖之后 --restore
    # 就什么都删不掉了 —— 也就是「重跑一次，回滚能力就没了」。
    # 清单记的是**归属**（这些文件是本批建的），不是「这一次动了谁」。
    prev = {"created": [], "overwritten": []}
    _mp = os.path.join(root, ENGINE_REL, MANIFEST_NAME)
    if os.path.isfile(_mp):
        try:
            with open(_mp, "r", encoding="utf-8") as f:
                _old = json.load(f)
            if _old.get("batch") == "r12c-batch17a":
                prev["created"] = list(_old.get("created", []))
                prev["overwritten"] = list(_old.get("overwritten", []))
        except (ValueError, OSError):
            pass  # 清单坏了就当没有，下面照样会重建一份完整的

    created = list(prev["created"])
    overwritten = dict((k, True) for k in prev["overwritten"])

    for item in plan:
        if item["action"] == "same":
            continue
        dst = os.path.join(root, item["rel"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if item["action"] == "conflict":
            bak = os.path.join(backup_dir, item["rel"])
            os.makedirs(os.path.dirname(bak), exist_ok=True)
            shutil.copy2(dst, bak)
            overwritten[item["rel"].replace("\\", "/")] = True
        else:
            created.append(item["rel"].replace("\\", "/"))
        if item["src"] is None:
            with open(dst, "w", encoding="utf-8", newline="\n") as f:
                f.write(notice_text())
        else:
            shutil.copy2(item["src"], dst)

    # B4 清单。记录的是**目标侧**的 sha256 —— 日后要复核的是我们盘上这份。
    files = {}
    for item in plan:
        dst = os.path.join(root, item["rel"])
        files[item["rel"].replace("\\", "/")] = {
            "sha256": sha256_of(dst),
            "size": os.path.getsize(dst),
            "kind": item["kind"],
        }
    manifest = {
        "_": "由 apply-r12c-batch17a.py 生成。--restore 依赖本文件，别手改。",
        "batch": "r12c-batch17a",
        "upstream": {"url": UPSTREAM_URL, "commit": UPSTREAM_COMMIT,
                     "date": UPSTREAM_DATE},
        "source_dir": src,
        "file_count": len(files),
        "created": sorted(set(created)),
        "overwritten": sorted(set(overwritten)),
        "files": files,
    }
    mpath = os.path.join(engine_dir, MANIFEST_NAME)
    with open(mpath, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    report("[3] 已落盘")
    report("")
    report("   %d 个文件 / %.1f MB" % (len(files), bytes_pkg / 1048576.0))
    report("   清单：%s" % os.path.join(ENGINE_REL, MANIFEST_NAME))
    if overwritten:
        report("   备份：%s   （%d 项被覆盖）" % (BACKUP_REL, len(overwritten)))
    report("")
    report("=" * 74)
    report("✅ batch17a 完成。")
    report("")
    report("   接下来（顺序别换）：")
    report("      1) cd engines\\indextts2   然后   uv sync")
    report("         ⭐ 这次可以**不带** --no-install-project 了 —— 崩掉的那步")
    report("            是找不到名为 indextts 的目录，现在它在了。")
    report("      2) python tools\\build\\check_release_size.py --selftest")
    report("      3) node tools\\dev\\run_tests.cjs")
    report("")
    report("   ⛔ %s 原封不动，它仍是退路。" % src)
    report("   ⛔ checkpoints\\（11GB）本批没碰，那是 17b。")
    return 0


# --------------------------------------------------------------------------
#  --restore
# --------------------------------------------------------------------------

def do_restore(root, report):
    engine_dir = os.path.join(root, ENGINE_REL)
    mpath = os.path.join(engine_dir, MANIFEST_NAME)
    if not os.path.isfile(mpath):
        report("⛔ 找不到 %s —— 本批没跑过，或清单被删了。"
               % os.path.join(ENGINE_REL, MANIFEST_NAME))
        report("   ⛔ 不做任何猜测式删除：清单是唯一的授权凭据。")
        return 1

    with open(mpath, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    backup_dir = os.path.join(root, BACKUP_REL)
    n_del = 0
    n_back = 0
    for rel in manifest.get("created", []):
        p = os.path.join(root, rel.replace("/", os.sep))
        if os.path.isfile(p):
            os.remove(p)
            n_del += 1
    for rel in manifest.get("overwritten", []):
        bak = os.path.join(backup_dir, rel.replace("/", os.sep))
        p = os.path.join(root, rel.replace("/", os.sep))
        if os.path.isfile(bak):
            os.makedirs(os.path.dirname(p), exist_ok=True)
            shutil.copy2(bak, p)
            n_back += 1

    os.remove(mpath)

    # 清空目录。只删空目录 —— 不属于本批的东西一律不碰。
    pkg_root = os.path.join(engine_dir, PKG_NAME)
    for cur, dirs, files in os.walk(pkg_root, topdown=False):
        try:
            if not os.listdir(cur):
                os.rmdir(cur)
        except OSError:
            pass

    report("已回滚：删除 %d 项，恢复 %d 项，清单已移除。" % (n_del, n_back))
    report("⛔ 源仓库自始至终没被碰过，无需恢复。")
    return 0


# --------------------------------------------------------------------------
#  --selftest
# --------------------------------------------------------------------------

def _mk(path, body=b""):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(body, bytes) else "w"
    with open(path, mode) as f:
        f.write(body)


def _fake_world(tmp, with_batch16=True, with_init=True, with_licenses=True):
    """搭一棵假树。⭐ 假树只能证明「我编的两处一致」，
    对真机长什么样一个字都没说 —— 真机内容只能问，不能推。
    本批之所以敢只靠自检，是因为它**不改任何已存在文件**、不需要锚点。"""
    root = os.path.join(tmp, "proj")
    src = os.path.join(tmp, "index-tts")

    _mk(os.path.join(root, "server.js"), b"// broker\n")
    os.makedirs(os.path.join(root, "lib"), exist_ok=True)
    os.makedirs(os.path.join(root, "engines", "indextts2"), exist_ok=True)

    if with_batch16:
        for rel, _why in REQUIRE_EXISTS:
            _mk(os.path.join(root, rel), b"x\n")

    # 源树
    if with_init:
        _mk(os.path.join(src, "indextts", "__init__.py"), b"")
    _mk(os.path.join(src, "indextts", "infer_v2.py"), b"class IndexTTS2: pass\n")
    _mk(os.path.join(src, "indextts", "utils", "front.py"), b"# front\n")
    # 这些必须被剔除
    _mk(os.path.join(src, "indextts", "__pycache__", "infer_v2.cpython-311.pyc"),
        b"\x00garbage")
    _mk(os.path.join(src, "indextts", "utils", "front.pyc"), b"\x00garbage")
    _mk(os.path.join(src, "indextts", "cfg.yaml.bak-20260817-160832"), b"old\n")
    if with_licenses:
        for name in LICENSE_FILES:
            _mk(os.path.join(src, name), ("%s body\n" % name).encode())
    return root, src


def _snap(d):
    """整棵树的 {相对路径: sha256}，用于证明「逐字节没变」。"""
    out = {}
    for cur, dirs, files in os.walk(d):
        for name in sorted(files):
            full = os.path.join(cur, name)
            out[os.path.relpath(full, d).replace("\\", "/")] = sha256_of(full)
    return out


def selftest():
    fails = []
    oks = []

    def chk(cond, label):
        (oks if cond else fails).append(label)
        print("   %s   %s" % ("ok  " if cond else "FAIL", label))

    print(BANNER)
    print("")
    print("[自检]")

    quiet = lambda *a: None

    # --- 场景 1：正常路径 ---
    with tempfile.TemporaryDirectory() as tmp:
        root, src = _fake_world(tmp)
        before = _snap(src)

        rc = do_apply(root, src, write=False, report=quiet)
        chk(rc == 0, "场景1 dry-run 返回 0")
        chk(not os.path.exists(os.path.join(root, ENGINE_REL, PKG_NAME)),
            "⭐ dry-run **一个字节都没写**")

        rc = do_apply(root, src, write=True, report=quiet)
        chk(rc == 0, "场景1 --write 返回 0")

        eng = os.path.join(root, ENGINE_REL)
        chk(os.path.isfile(os.path.join(eng, PKG_NAME, "__init__.py")),
            "B1 包 __init__.py 到位")
        chk(os.path.isfile(os.path.join(eng, PKG_NAME, "infer_v2.py")),
            "B1 infer_v2.py 到位")
        chk(os.path.isfile(os.path.join(eng, PKG_NAME, "utils", "front.py")),
            "B1 子目录 utils\\front.py 到位")
        chk(all(os.path.isfile(os.path.join(eng, n)) for n in LICENSE_FILES),
            "B2 三个许可证到位")
        chk(os.path.isfile(os.path.join(eng, "NOTICE")), "B3 NOTICE 到位")
        chk(os.path.isfile(os.path.join(eng, MANIFEST_NAME)),
            "B4 SOURCE_MANIFEST.json 到位")

        # 排除项
        chk(not os.path.exists(os.path.join(eng, PKG_NAME, "__pycache__")),
            "⭐ __pycache__ 被剔除")
        chk(not os.path.isfile(os.path.join(eng, PKG_NAME, "utils",
                                            "front.pyc")),
            "⭐ .pyc 被剔除")
        chk(not os.path.isfile(os.path.join(eng, PKG_NAME,
                                            "cfg.yaml.bak-20260817-160832")),
            "⭐ 带后缀的 .bak 也被剔除（v4.1 采集器踩过的坑）")

        # ⭐ 源仓库原封不动
        chk(_snap(src) == before, "⭐⭐ 源仓库逐字节未变（复制不是移动）")

        # 清单可复核
        with open(os.path.join(eng, MANIFEST_NAME), encoding="utf-8") as f:
            man = json.load(f)
        real = {}
        for rel, info in man["files"].items():
            p = os.path.join(root, rel.replace("/", os.sep))
            real[rel] = sha256_of(p)
        chk(all(man["files"][k]["sha256"] == real[k] for k in real),
            "⭐ 清单里每个 sha256 与盘上实际一致")
        chk(man["upstream"]["commit"] == UPSTREAM_COMMIT,
            "⭐ 清单写死了 commit sha")
        chk(UPSTREAM_COMMIT in open(os.path.join(eng, "NOTICE"),
                                    encoding="utf-8").read(),
            "⭐ NOTICE 写死了 commit sha（删 .git 后就拿不回来了）")
        nt = open(os.path.join(eng, "NOTICE"), encoding="utf-8").read()
        chk("LOCAL-CHANGES.md" in nt,
            "⭐ NOTICE 说清了「日后改了要登记在哪」")

        # --- 场景 2：幂等 ---
        snap1 = _snap(eng)
        rc = do_apply(root, src, write=True, report=quiet)
        snap2 = _snap(eng)
        chk(rc == 0, "场景2 重复 --write 返回 0")
        chk(snap1 == snap2, "⭐⭐ 场景2 重复 --write **逐字节不变**")

        # --- 场景 6：内容不同 -> 拒绝 ---
        victim = os.path.join(eng, PKG_NAME, "infer_v2.py")
        with open(victim, "ab") as f:
            f.write(b"# my local fix\n")
        before6 = _snap(eng)
        rc = do_apply(root, src, write=True, report=quiet)
        chk(rc == 1, "⭐⭐ 场景6 目标已存在且内容不同 ⇒ 拒绝（返回 1）")
        chk(_snap(eng) == before6,
            "⭐⭐ 场景6 拒绝时**一个字节都没写**（不静默抹掉我的改动）")
        # 还原现场
        with open(victim, "wb") as f:
            f.write(b"class IndexTTS2: pass\n")

        # --- 场景 7：--restore ---
        rc = do_restore(root, report=quiet)
        chk(rc == 0, "场景7 --restore 返回 0")
        chk(not os.path.exists(os.path.join(eng, PKG_NAME)),
            "⭐ --restore 删掉了整个 indextts\\（含空目录）")
        chk(not any(os.path.exists(os.path.join(eng, n))
                    for n in LICENSE_FILES),
            "⭐ --restore 删掉了复制进来的许可证")
        chk(not os.path.exists(os.path.join(eng, "NOTICE")),
            "⭐ --restore 删掉了 NOTICE")
        chk(not os.path.exists(os.path.join(eng, MANIFEST_NAME)),
            "⭐ --restore 移除了清单自己")
        chk(os.path.isfile(os.path.join(eng, "uv.lock")),
            "⭐⭐ --restore **没有误删** batch16 的配方（只删本批建的）")
        chk(_snap(src) == before, "⭐ --restore 后源仓库依然逐字节未变")

        rc = do_restore(root, report=quiet)
        chk(rc == 1, "⭐ 没有清单时 --restore 拒绝（不做猜测式删除）")

    # --- 场景 3：batch16 未生效 ---
    with tempfile.TemporaryDirectory() as tmp:
        root, src = _fake_world(tmp, with_batch16=False)
        eng = os.path.join(root, ENGINE_REL)
        rc = do_apply(root, src, write=True, report=quiet)
        chk(rc == 1, "⭐⭐ 场景3 batch16 未生效 ⇒ 拒绝执行")
        chk(not os.path.exists(os.path.join(eng, PKG_NAME)),
            "⭐⭐ 场景3 **一个字节都没写**")

    # --- 场景 4：源包没有 __init__.py ---
    with tempfile.TemporaryDirectory() as tmp:
        root, src = _fake_world(tmp, with_init=False)
        rc = do_apply(root, src, write=True, report=quiet)
        chk(rc == 1, "⭐ 场景4 源包缺 __init__.py ⇒ 拒绝（拿错目录了）")
        chk(not os.path.exists(os.path.join(root, ENGINE_REL, PKG_NAME)),
            "场景4 零写入")

    # --- 场景 5：源缺许可证 ---
    with tempfile.TemporaryDirectory() as tmp:
        root, src = _fake_world(tmp, with_licenses=False)
        rc = do_apply(root, src, write=True, report=quiet)
        chk(rc == 1, "⭐ 场景5 源缺 LICENSE ⇒ 拒绝"
                     "（pyproject 的 license-files 指着它）")
        chk(not os.path.exists(os.path.join(root, ENGINE_REL, PKG_NAME)),
            "场景5 零写入")

    # --- 找根 ---
    with tempfile.TemporaryDirectory() as tmp:
        root, _src = _fake_world(tmp)
        deep = os.path.join(root, "tools", "dev")
        os.makedirs(deep, exist_ok=True)
        probe = os.path.join(deep, "x.py")
        _mk(probe, b"")
        chk(os.path.realpath(find_root(probe)) == os.path.realpath(root),
            "项目根定位（锚点上溯）")
        try:
            find_root(os.path.join(tmp, "nowhere", "y.py"))
            chk(False, "反例守卫：找不到锚点时应显式抛错")
        except RuntimeError:
            chk(True, "⭐ 反例守卫：找不到锚点时显式抛错，不用 cwd 兜底")

    # --- 排除规则的语义 ---
    chk(is_excluded_name("a.pyc") and is_excluded_name("a.pyo"),
        "排除规则：.pyc/.pyo")
    chk(is_excluded_name("tts_infer.yaml.bak-20260817-160832"),
        "⭐ 排除规则：带时间戳后缀的 .bak")
    chk(not is_excluded_name("infer_v2.py"),
        "⭐ 反例守卫：正常 .py 不被误伤")
    chk(not is_excluded_name("backup_utils.py"),
        "⭐ 反例守卫：名字里含 bak 的正常文件不被误伤")

    print("")
    print("   自检：%d ok / %d FAIL" % (len(oks), len(fails)))
    return 1 if fails else 0


# --------------------------------------------------------------------------
#  main
# --------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="r12c batch17a —— 把 IndexTTS2 源码包复制进 engines/indextts2/")
    ap.add_argument("--write", action="store_true", help="真的落盘（默认 dry-run）")
    ap.add_argument("--restore", action="store_true", help="回滚本批")
    ap.add_argument("--selftest", action="store_true", help="只跑自检")
    ap.add_argument("--force", action="store_true",
                    help="目标内容不同时也覆盖（先备份）。⛔ 想清楚再用")
    ap.add_argument("--root", default=None, help="项目根（默认靠锚点上溯）")
    ap.add_argument("--src", default=DEFAULT_SRC, help="IndexTTS2 仓库（只读）")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    print(BANNER)
    root = args.root or find_root()
    src = args.src
    print("项目根        ：%s" % root)
    print("IndexTTS2 仓库：%s   （只读，本批不动它一个字节）" % src)
    if args.restore:
        print("模式          ：RESTORE")
        print("=" * 74)
        return do_restore(root, report=print)
    print("模式          ：%s" % ("WRITE（会落盘）" if args.write
                                  else "DRY-RUN（不写任何文件）"))
    print("=" * 74)
    return do_apply(root, src, write=args.write, report=print, force=args.force)


if __name__ == "__main__":
    sys.exit(main())
