#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""apply-r12c-batch16c.py — batch16 的收口：只补 A5/A5b，并**核验**其余已生效

[r12c batch16c / 2026-08-21]

=== 为什么会有这个脚本 ===

batch16 被 --write 过一次：A1/A2/A3/A4/A6/A7/A8 全部落盘，**只有 A5 因为
锚点写错而失败**。16b 修好了 A5，但直接拿 16b 再 --write 有两个真问题：

  ⛔ A2 的 NAME_EXCLUDE 那条是「在原行后面追加」，原锚点追加后依然存在
     ⇒ 再跑一次会**加第二遍**（重复的 ".venv" 在 set 里无害，但那段解释性
       注释会出现两份，而重复的注释是"这文件被人乱改过"的信号）
  ⛔ 16b 的备份目录和 16 同名。UPSTREAM.md / 配方四件在 batch16 眼里是
     「原本不存在、回滚要删掉」的，被 16b 备份一次之后就变成「有备份、
     回滚要恢复」⇒ --restore 从此不干净。

=== ⭐ 这个脚本和前两个的关键区别：它先**核验后态** ===

「锚点未命中」有两种成因，在输出里长得一模一样：
    (a) 已经改过了      (b) 文件本来就跟我以为的不一样
从「改之前的样子找不到了」**推不出**是哪一种。

⇒ 所以本脚本不看「旧样子还在不在」，只看「**新样子在不在**」。
   §1 逐条核验 batch16 应该留下的痕迹；对不上就 FAIL 并说清缺哪条，
   ⛔ 绝不"反正大概是改过了"就往下走。

用法（PowerShell）：
    python tools\dev\apply-r12c-batch16c.py --selftest
    python tools\dev\apply-r12c-batch16c.py
    python tools\dev\apply-r12c-batch16c.py --write
    python tools\dev\apply-r12c-batch16c.py --restore
"""

import argparse
import io
import os
import shutil
import sys
import tempfile

BANNER = "[r12c batch16c / 2026-08-21]"
BACKUP_REL = os.path.join("cache", "patch-backup", "r12c-batch16c")

PACK = os.path.join("tools", "build", "04_pack_release.py")
COLL = os.path.join("tools", "dev", "collect_repo_source_v4.1.py")

ROOT_ANCHORS = ("server.js", "lib", "engines")


def find_root(start):
    cur = os.path.abspath(start)
    while True:
        if all(os.path.exists(os.path.join(cur, a)) for a in ROOT_ANCHORS):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            raise RuntimeError("找不到项目根：向上找不到同时含 %s 的目录。"
                               % "/".join(ROOT_ANCHORS))
        cur = parent


def code_only(text):
    return "\n".join(ln for ln in text.split("\n")
                     if not ln.lstrip().startswith("#"))


# ─────────────────────────────────────────────────────────────────────────
# §1 后态核验：batch16 那次 --write 到底留下了什么
#    每条 = (标题, 相对路径, 判定函数, 对不上时该怎么办)
# ─────────────────────────────────────────────────────────────────────────
def v_top_exclude(txt):
    c = code_only(txt)
    return ('"venv", "assets", ".staging",' in c
            and '"venv_idx241"' not in c
            and '".venv"' not in c.split("NAME_EXCLUDE")[0])


def v_name_exclude(txt):
    c = code_only(txt)
    if "NAME_EXCLUDE" not in c:
        return False
    return '".venv",' in c.split("NAME_EXCLUDE", 1)[1]


def v_gsv_gone(txt):
    return "gsv-tools" not in code_only(txt)


def v_micromamba_kept(txt):
    return 'os.path.join("vendor", "micromamba")' in code_only(txt)


VERIFY = [
    ("A2 TOP_EXCLUDE 已去掉 .venv、已删死条目 venv_idx241", PACK,
     v_top_exclude,
     "batch16 的 A2+A3 没生效，或这一段后来又被人改过"),
    ("A2 NAME_EXCLUDE 已收下 .venv", PACK, v_name_exclude,
     "batch16 的 A2 下半没生效"),
    ("A4 四条陈旧 gsv-tools 排除已清空", PACK, v_gsv_gone,
     "batch16 的 A4 没生效"),
    ("⭐ 反例守卫：micromamba 条目仍在（那 8.2GB 还在盘上）", PACK,
     v_micromamba_kept,
     "micromamba 条目被误删了 —— 那 8.2GB 会进发行包"),
]

# 文件级后态（存在 / 不存在）
VERIFY_EXISTS = [
    (os.path.join("engines", "indextts2", "pyproject.toml"), True, "A1 配方"),
    (os.path.join("engines", "indextts2", "uv.lock"), True, "A1 配方（371797B 那份）"),
    (os.path.join("engines", "indextts2", ".python-version"), True, "A1 配方"),
    (os.path.join("engines", "indextts2", "MANIFEST.in"), True, "A1 配方"),
    (os.path.join("engines", "indextts2", "UPSTREAM.md"), True, "A7"),
    (os.path.join("engines", "indextts2", "LOCAL-CHANGES.md"), True, "A7"),
    (os.path.join("tools", "build", "check_release_size.py"), True, "A8 守卫"),
    (os.path.join("engines", "indextts2", "setup.bat"), False,
     "A6 已删（它是坏的：%~dp0 展开错）"),
]


# ─────────────────────────────────────────────────────────────────────────
# §2 只剩 A5 / A5b
#    每条带一个 done_marker：先看「新样子在不在」，在了就跳过（幂等），
#    ⛔ 而不是靠"老样子还在不在"来决定要不要改。
# ─────────────────────────────────────────────────────────────────────────
class Edit(object):
    def __init__(self, rel, old, new, why, done):
        self.rel, self.old, self.new = rel, old, new
        self.why, self.done = why, done

    def apply(self, text):
        if self.done in text:
            return text, "skip"
        n = text.count(self.old)
        if n == 0:
            return None, "锚点未命中"
        if n > 1:
            return None, "锚点命中 %d 次（必须唯一）" % n
        return text.replace(self.old, self.new), "ok"


EDITS = [
    Edit(COLL,
         '    r"|.*/_vendor/)")\n',
         '    r"|.*/_vendor/"\n'
         '    # r12c batch16: 每引擎自带的 Python 环境 engines/<id>/.venv/。\n'
         '    # ⚠ 上面的 `.*/site-packages/` 已挡住里面的大头，但挡不住\n'
         '    #   .venv/Scripts/ 和 .venv/Lib/ 下非 site-packages 的部分\n'
         '    #   （pyvenv.cfg、activate 脚本、一堆 .exe）。\n'
         '    # ⭐ 这**不违反**本节开头那条「engines/ 下的上游代码必须收」：\n'
         '    #    .venv 不是代码，是 `uv sync` 的产物。要收的是**配方**\n'
         '    #    （engines/<id>/pyproject.toml + uv.lock），那两个照收不误。\n'
         '    # ⭐ 写成 `(.*/)?` 而不是 `.*/`：后者要求 .venv 前面至少有一个\n'
         '    #    斜杠，顶层的 .venv/ 会漏掉。现在项目根上叫 venv/ 不叫\n'
         '    #    .venv/，那个洞碰巧没人踩到 —— 但"碰巧"不是理由。\n'
         '    r"|(.*/)?\\.venv/)")\n',
         "A5 采集器排除 engines/<id>/.venv/",
         r'r"|(.*/)?\.venv/)")'),

    Edit(COLL,
         '#    真正不收的只有 vendor/ 下我们一行没动过的成品（micromamba / ffmpeg）\n'
         '#    和 tools/runtime/ 里下载来的运行时。\n',
         '#    真正不收的只有三类：vendor/ 下我们一行没动过的成品（micromamba /\n'
         '#    ffmpeg）、tools/runtime/ 里下载来的运行时，以及 engines/<id>/.venv/\n'
         '#    —— 每个引擎自带的 Python 环境（r12c batch16 起）。\n'
         '#    前两类是「别人的成品」，第三类是「机器生成的产物」：它由同目录下的\n'
         '#    uv.lock 一条 `uv sync` 重建，收进快照没有信息量，只有 8GB 体积。\n'
         '#    ⭐ 判据始终是「这里面有没有我们要读/要改的东西」，不是「它是不是\n'
         '#       第三方」—— engines/ 下的上游代码要收，正是因为我们会改它。\n',
         "A5b 修正导语（加了第三类排除，注释不能还说只有两类）",
         "真正不收的只有三类"),
]


# ─────────────────────────────────────────────────────────────────────────
def backup_path(root, rel):
    return os.path.join(root, BACKUP_REL, rel)


def do_backup(root, rel, write):
    src, dst = os.path.join(root, rel), backup_path(root, rel)
    if not write or not os.path.exists(src) or os.path.exists(dst):
        return
    d = os.path.dirname(dst)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    shutil.copy2(src, dst)


def do_restore(root):
    base = os.path.join(root, BACKUP_REL)
    if not os.path.isdir(base):
        print("   ⛔ 没有备份目录：%s" % base)
        print("      ⇒ 这一批从没 --write 过。不猜，停。")
        print("      ⚠ 想回滚 batch16 那一次，用的是另一个备份目录：")
        print("         cache\\patch-backup\\r12c-batch16\\")
        return 1
    n = 0
    for dirpath, _d, filenames in os.walk(base):
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base)
            dst = os.path.join(root, rel)
            dd = os.path.dirname(dst)
            if dd and not os.path.isdir(dd):
                os.makedirs(dd)
            shutil.copy2(full, dst)
            print("   恢复  %s" % rel)
            n += 1
    print()
    print("   共恢复 %d 项。" % n)
    print("   ⚠ 本批只碰了 %s 一个文件 —— batch16 那次的改动**不受影响**，" % COLL)
    print("      要一并回滚请另外跑 batch16 的 --restore。")
    return 0


# ─────────────────────────────────────────────────────────────────────────
def run(root, write, strict=True):
    print(BANNER)
    print("项目根：%s" % root)
    print("模式  ：%s" % ("WRITE（会落盘，先备份）" if write
                         else "DRY-RUN（不写任何文件）"))
    print("=" * 74)
    print()

    bad = []

    # ── §1 核验 batch16 的后态 ──────────────────────────────────────────
    print("[1] 核验 batch16 那次 --write 的后态")
    print("    ⭐ 看的是『新样子在不在』，不是『老样子还在不在』——")
    print("       后者分不清「已经改过」和「文件本来就不一样」。")
    print()
    cache = {}
    for title, rel, fn, hint in VERIFY:
        full = os.path.join(root, rel)
        if rel not in cache:
            if not os.path.isfile(full):
                cache[rel] = None
            else:
                with open(full, "r", encoding="utf-8") as f:
                    cache[rel] = f.read()
        txt = cache[rel]
        if txt is None:
            print("   ⛔ 文件不存在：%s" % rel)
            bad.append(title)
            continue
        if fn(txt):
            print("   ok   %s" % title)
        else:
            print("   ⛔ FAIL %s" % title)
            print("        可能原因：%s" % hint)
            bad.append(title)

    for rel, want, tag in VERIFY_EXISTS:
        got = os.path.exists(os.path.join(root, rel))
        if got == want:
            print("   ok   %s %s   [%s]" % ("在  " if want else "已删", rel, tag))
        else:
            print("   ⛔ FAIL %s 应该%s，实际%s   [%s]"
                  % (rel, "存在" if want else "不存在",
                     "存在" if got else "不存在", tag))
            bad.append(rel)
    print()

    if bad and strict:
        print("=" * 74)
        print("⛔ %d 项后态核验没过 ⇒ **不往下做**。" % len(bad))
        for b in bad:
            print("     - %s" % b)
        print()
        print("   本脚本的前提是「batch16 已经成功 --write 过」。这个前提不成立时")
        print("   继续改文件，只会把状态搅得更乱 —— 停在这里比蒙着走一步便宜。")
        print("   ⇒ 把 %s 里对应那几段贴回来，我看实际长什么样。" % PACK)
        return 1

    # ── §2 补 A5 / A5b ─────────────────────────────────────────────────
    print("[2] 补做 batch16 唯一失败的那项（A5）")
    full = os.path.join(root, COLL)
    if not os.path.isfile(full):
        print("   ⛔ 文件不存在：%s" % COLL)
        return 1
    with open(full, "r", encoding="utf-8") as f:
        text = f.read()
    orig = text
    fail = []
    for e in EDITS:
        new, st = e.apply(text)
        if st == "skip":
            print("   ℹ  已经改过，跳过：%s" % e.why)
            continue
        if new is None:
            print("   ⛔ FAIL  %s" % e.why)
            print("      原因：%s" % st)
            print("      期望逐字节找到：")
            for line in e.old.rstrip("\n").split("\n"):
                print("          |%s" % line)
            fail.append(e.why)
        else:
            text = new
            print("   ok    %s" % e.why)
    if text != orig:
        do_backup(root, COLL, write)
        if write:
            with open(full, "w", encoding="utf-8", newline="") as f:
                f.write(text)
    else:
        print("   ℹ  文件无需改动（两项都已生效）。")
    print()

    print("=" * 74)
    if fail:
        print("⛔ %d 项没做成。把上面『期望逐字节找到』附近的实际文本贴回来。" % len(fail))
        return 1

    print("✅ batch16 收口完成。")
    print()
    print("   接下来（顺序别换）：")
    print("      1) python tools\\build\\check_release_size.py --selftest")
    print("         ⭐ 那个文件是 batch16 写进去的，但**它自己的自检你还没跑过**。")
    print("      2) node tools\\dev\\run_tests.cjs")
    print("      3) cd engines\\indextts2   然后   uv sync    （8GB，要联网）")
    print("      4) uv sync 之后**再跑一次** check_release_size.py，")
    print("         确认 engines/indextts2 那一桶没冒出来 —— 代码改对了不算数，")
    print("         得看那 8.1GB 真的被挡住。")
    print()
    print("   ⛔ 在 uv sync 跑通并真的推理成功之前，vendor\\micromamba\\（8.2GB）")
    print("      和 D:\\AI\\index-tts\\.venv\\ 一个都别删 —— 它们是仅有的退路。")
    if not write:
        print()
        print("   这是 DRY-RUN，没有写过任何文件。确认后：")
        print("      python tools\\dev\\apply-r12c-batch16c.py --write")
    return 0


# ─────────────────────────────────────────────────────────────────────────
FAKE_PACK_AFTER = (
    'TOP_EXCLUDE = {\n'
    '    # ".venv" 搬去了 NAME_EXCLUDE\n'
    '    # "venv_idx241" 已删\n'
    '    "venv", "assets", ".staging",\n'
    '    "logs",\n'
    '}\n'
    'NAME_EXCLUDE = {\n'
    '    ".git", ".hg", ".svn",\n'
    '    # r12c batch16: 每引擎自带一套 Python 环境\n'
    '    ".venv",\n'
    '    "__pycache__",\n'
    '}\n'
    'PATH_EXCLUDE = {\n'
    '    # r12c batch16: 四条 vendor/gsv-tools/* 排除已删\n'
    '    os.path.join("vendor", "micromamba"),\n'
    '}\n')

FAKE_PACK_BEFORE = (
    'TOP_EXCLUDE = {\n'
    '    "venv", ".venv", "venv_idx241", "assets", ".staging",\n'
    '}\n'
    'NAME_EXCLUDE = {\n'
    '    ".git", ".hg", ".svn",\n'
    '}\n'
    'PATH_EXCLUDE = {\n'
    '    os.path.join("vendor", "gsv-tools", "pretrained"),\n'
    '    os.path.join("vendor", "micromamba"),\n'
    '}\n')

FAKE_COLL = (
    '# ── 2. 第三方运行时树：永远不收 ────────────────────────────────\n'
    '#    ⚠ 反向的坑：engines/ 和 pipeline/ 下面装的同样是上游代码，但那是**我们\n'
    '#    改过、要自己维护的**上游代码（每棵树里都有 LOCAL-CHANGES.md 为证），\n'
    '#    必须收。别看见"第三方"三个字就顺手排掉。\n'
    '#    真正不收的只有 vendor/ 下我们一行没动过的成品（micromamba / ffmpeg）\n'
    '#    和 tools/runtime/ 里下载来的运行时。\n'
    'THIRD_PARTY_RE = re.compile(\n'
    '    r"^(vendor/micromamba/"\n'
    '    r"|vendor/ffmpeg/"\n'
    '    r"|tools/runtime/"\n'
    '    r"|tools/wheels/"\n'
    '    r"|web/node_modules/"\n'
    '    r"|web/dist/"\n'
    '    r"|.*/site-packages/"\n'
    '    r"|.*/dist-packages/"\n'
    '    r"|.*/node_modules/"\n'
    '    r"|.*/_vendor/)")\n')


def _mktree(tmp, pack_txt, coll_txt, with_files=True):
    root = os.path.join(tmp, "proj")
    for d in (os.path.join(root, "lib"),
              os.path.join(root, "engines", "indextts2"),
              os.path.join(root, "tools", "build"),
              os.path.join(root, "tools", "dev")):
        os.makedirs(d)
    open(os.path.join(root, "server.js"), "w").write("//\n")
    with open(os.path.join(root, PACK), "w", encoding="utf-8", newline="") as f:
        f.write(pack_txt)
    with open(os.path.join(root, COLL), "w", encoding="utf-8", newline="") as f:
        f.write(coll_txt)
    if with_files:
        for rel, want, _t in VERIFY_EXISTS:
            if want:
                p = os.path.join(root, rel)
                dd = os.path.dirname(p)
                if dd and not os.path.isdir(dd):
                    os.makedirs(dd)
                open(p, "w").write("x\n")
    return root


def _quiet(fn, *a, **kw):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        rc = fn(*a, **kw)
    finally:
        sys.stdout = old
    return rc, buf.getvalue()


def selftest():
    print(BANNER)
    print()
    print("[自检]")
    st = {"ok": 0, "fail": 0}

    def chk(c, m):
        print("   %s %s" % ("ok  " if c else "FAIL", m))
        st["ok" if c else "fail"] += 1

    chk(v_top_exclude(FAKE_PACK_AFTER), "后态判定：TOP_EXCLUDE 认出已改")
    chk(not v_top_exclude(FAKE_PACK_BEFORE),
        "⭐ 反例守卫：未改过的 TOP_EXCLUDE 不许判成已改")
    chk(v_name_exclude(FAKE_PACK_AFTER), "后态判定：NAME_EXCLUDE 认出已改")
    chk(not v_name_exclude(FAKE_PACK_BEFORE),
        "⭐ 反例守卫：未改过的 NAME_EXCLUDE 不许判成已改")
    chk(v_gsv_gone(FAKE_PACK_AFTER) and not v_gsv_gone(FAKE_PACK_BEFORE),
        "后态判定：gsv-tools 清空（含反例）")
    chk(v_micromamba_kept(FAKE_PACK_AFTER), "后态判定：micromamba 仍在")

    # ⭐ 最关键的一条：注释里提到 ".venv"/"venv_idx241"/"gsv-tools" 不算数
    tricky = FAKE_PACK_BEFORE.replace(
        'TOP_EXCLUDE = {\n',
        'TOP_EXCLUDE = {\n    # 说明：".venv" 和 "venv_idx241" 的历史\n')
    chk(not v_top_exclude(tricky),
        "⭐⭐ 反例守卫：注释里出现那些字符串不算『已改』（只看代码行）")

    tmp = tempfile.mkdtemp(prefix="b16c_")
    try:
        # 场景 1：batch16 已生效、A5 未做 ⇒ 应当补上
        root = _mktree(os.path.join(tmp, "s1"), FAKE_PACK_AFTER, FAKE_COLL)
        rc, out = _quiet(run, root, True)
        chk(rc == 0, "场景1（batch16 已生效，A5 未做）：返回 0")
        if rc != 0:
            print(out)
        c = open(os.path.join(root, COLL), encoding="utf-8").read()
        chk(r'r"|(.*/)?\.venv/)")' in c, "场景1：A5 已补上")
        chk("真正不收的只有三类" in c, "场景1：A5b 导语已改口")
        chk("必须收。别看见" in c,
            "⭐ 反例守卫：『engines/ 下上游代码必须收』那句没被误删")
        chk(all(('r"|%s"' % p) in c or ('r"^(%s"' % p) in c for p in (
            "vendor/micromamba/", "vendor/ffmpeg/", "tools/runtime/",
            "tools/wheels/", "web/node_modules/", "web/dist/",
            ".*/site-packages/", ".*/dist-packages/", ".*/node_modules/")),
            "⭐ 反例守卫：原有 9 条规则逐条还在")

        # ⭐ 场景 2：再跑一次必须是**幂等**的（这正是不能直接重跑 16b 的原因）
        before = c
        rc2, out2 = _quiet(run, root, True)
        after = open(os.path.join(root, COLL), encoding="utf-8").read()
        chk(rc2 == 0 and after == before,
            "⭐⭐ 场景2：重复 --write 幂等（内容逐字节不变，不会加第二遍）")
        chk("已经改过，跳过" in out2, "场景2：明说了是跳过，不假装做了")

        # 场景 3：batch16 **没**生效 ⇒ 必须拒绝往下做
        root3 = _mktree(os.path.join(tmp, "s3"), FAKE_PACK_BEFORE, FAKE_COLL)
        rc3, out3 = _quiet(run, root3, True)
        chk(rc3 == 1, "⭐⭐ 场景3（batch16 未生效）：拒绝执行，返回 1")
        c3 = open(os.path.join(root3, COLL), encoding="utf-8").read()
        chk(c3 == FAKE_COLL,
            "⭐⭐ 场景3：**一个字节都没写** —— 前提不成立就不许动文件")

        # 场景 4：文件缺失也要拦
        root4 = _mktree(os.path.join(tmp, "s4"), FAKE_PACK_AFTER, FAKE_COLL,
                        with_files=False)
        rc4, _ = _quiet(run, root4, True)
        chk(rc4 == 1, "场景4（配方/新文件缺失）：拒绝执行")

        # 场景 5：setup.bat 还在 ⇒ A6 没生效，要拦
        root5 = _mktree(os.path.join(tmp, "s5"), FAKE_PACK_AFTER, FAKE_COLL)
        open(os.path.join(root5, "engines", "indextts2", "setup.bat"),
             "w").write("x")
        rc5, _ = _quiet(run, root5, True)
        chk(rc5 == 1, "⭐ 场景5：setup.bat 仍在 ⇒ 判定 A6 没生效，拒绝执行")

        # restore
        rc6, _ = _quiet(do_restore, root)
        r = open(os.path.join(root, COLL), encoding="utf-8").read()
        chk(rc6 == 0 and r == FAKE_COLL, "⭐ --restore 还原成逐字节相同")

        # 正则语义
        import re as _re
        ns = {"re": _re}
        exec(before, ns)
        rx = ns["THIRD_PARTY_RE"]
        cases = [("engines/indextts2/.venv/Scripts/python.exe", True),
                 (".venv/x", True),
                 ("a/b/.venv/c", True),
                 ("engines/indextts2/uv.lock", False),
                 ("engines/indextts2/indextts/infer_v2.py", False),
                 ("engines/x/my.venv/f.py", False),
                 (".venvious/x.py", False),
                 ("vendor/micromamba/x", True)]
        chk(all(bool(rx.match(p)) == w for p, w in cases),
            "⭐⭐ 改完的正则**语义**正确（8 例，含 my.venv/.venvious 不误伤）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    print("   自检：%d ok / %d FAIL" % (st["ok"], st["fail"]))
    return 0 if st["fail"] == 0 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--restore", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--root", default=None)
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    root = a.root or find_root(os.path.dirname(os.path.abspath(__file__)))
    if a.restore:
        print(BANNER)
        print("项目根：%s" % root)
        print()
        return do_restore(root)
    return run(root, a.write)


if __name__ == "__main__":
    sys.exit(main())
