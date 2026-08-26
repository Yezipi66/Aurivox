# -*- coding: utf-8 -*-
"""
mutate_contract_seed —— apply_contract_seed 的验红

闸自己必须验红：还原出「锚点对不上」「文档是 CRLF」「写了一半」这几种真实情况，
确认它 ①非零退出 ②报的理由正确 ③**文档字节级没被动过**。
"""

import os
import subprocess
import sys
import hashlib

# ⛔ 不许留 __pycache__ —— 本脚本要 import apply_contract_seed 拿补丁表，
#    默认会在 tools/dev/ 下写 .pyc，那是 git status 里的残骸。
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DOC = os.path.join(ROOT, "docs", "ENGINE_CONTRACT.md")
APPLY = os.path.join(HERE, "apply_contract_seed.py")
PY = sys.executable

ROWS = []
KEPT = []


def rb(p):
    with open(p, "rb") as f:
        return f.read()


def wb(p, b):
    with open(p, "wb") as f:
        f.write(b)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def row(name, ok, note=""):
    ROWS.append((name, ok, note))
    print("  %-8s %s%s" % ("RED-OK" if ok else "FAIL", name,
                           ("   [%s]" % note) if note else ""))


def run():
    p = subprocess.run([PY, APPLY], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def main():
    print("=== apply_contract_seed 验红 ===")
    print()

    CUR = rb(DOC)
    CUR_SHA = sha(CUR)

    # ---------- 前提：把文档拉回「未打补丁」这个已知起点 ----------
    # ⛔ 2026-08-26 真机事故：本脚本原先直接拿「当前文档」当基线。
    #    Owner 先跑 apply、再跑验红 ⇒ 基线运行走进幂等分支（一个字没动）
    #    ⇒ 后面所有「基线会真的写入」的断言集体塌方，10 条假红。
    #    ⇒ 验红必须**自己造出已知起点**，不能假设别人没跑过 apply。
    sys.path.insert(0, HERE)
    import apply_contract_seed as AP

    txt = CUR.decode("utf-8")
    is_crlf = txt.count("\r\n") > 0
    work = txt.replace("\r\n", "\n") if is_crlf else txt
    started_patched = all(m in work for _, m, _, _ in AP.PATCHES)

    if started_patched:
        # 反向还原：每条补丁都是 (锚点 -> 替换) 的确定映射，倒过来就是真身
        for _, _, anchor, repl in AP.PATCHES:
            work = work.replace(repl, anchor, 1)
        gone = not any(m in work for _, m, _, _ in AP.PATCHES)
        ORIG = (work.replace("\n", "\r\n") if is_crlf else work).encode("utf-8")
        wb(DOC, ORIG)
        row("⭐⭐ 前提：文档已经打过补丁 ⇒ 反向还原出未打补丁的真身",
            gone and len(ORIG) < len(CUR),
            "%d → %d 字节" % (len(CUR), len(ORIG)))
    else:
        ORIG = CUR
        row("⭐ 前提：文档本来就没打过补丁（直接用作起点）",
            True, "%d 字节" % len(ORIG))

    ORIG_SHA = sha(ORIG)

    # ---------- 基线 ----------
    rc, out = run()
    after = rb(DOC)
    row("基线：退出码 0", rc == 0, "rc=%d" % rc)
    row("基线：四处全打上", out.count("✅") == 4, "%d 处" % out.count("✅"))
    row("基线：只加不删（原文每行都还在）", "只加不删）：是" in out)
    row("基线：文档确实变长了", len(after) > len(ORIG),
        "%d → %d" % (len(ORIG), len(after)))
    row("基线：没留备份", not os.path.exists(DOC + ".seedbak"))

    PATCHED = after
    PATCHED_SHA = sha(PATCHED)

    if started_patched:
        # ⭐⭐ 往返闭合：反向还原出来的真身，重新打一遍必须**逐字节**回到
        #    你手上那份。这一条同时证明了「反向还原是忠实的」——
        #    否则上面那个起点就是我编出来的，后面全部读数都不算数。
        row("⭐⭐ 往返闭合：还原→重打 = 你手上那份的逐字节原样",
            PATCHED_SHA == CUR_SHA, "%s vs %s" % (PATCHED_SHA[:12], CUR_SHA[:12]))

    # ---------- 幂等 ----------
    rc2, out2 = run()
    row("⭐ 幂等：第二次一个字节没动",
        rc2 == 0 and sha(rb(DOC)) == PATCHED_SHA and "一个字没动" in out2,
        PATCHED_SHA[:12])

    wb(DOC, ORIG)

    # ---------- M1：锚点对不上 ⇒ 一处都不写 ----------
    broken = ORIG.decode("utf-8").replace(
        "### §5.3 `cli` 形态要说清什么",
        "### §5.3 命令行形态要说清什么", 1).encode("utf-8")
    wb(DOC, broken)
    b_sha = sha(broken)
    rc, out = run()
    now = rb(DOC)
    row("⭐⭐ M1：一个锚点被改名 ⇒ 非零退出",
        rc != 0, "rc=%d" % rc)
    row("⭐⭐ M1 连带：**一处都不写** —— 文档字节级没被动过",
        sha(now) == b_sha, b_sha[:12])
    row("⭐ M1：报的理由正确（点名是哪一处 + 命中几次）",
        "锚点对不上" in out and "新增 §5.2.1 整节" in out and "命中 0 次" in out)
    row("⭐ M1：给了下一步（把文档发我重出锚点）",
        "发我" in out)
    wb(DOC, ORIG)

    # ---------- M2：锚点出现两次 ⇒ 同样拒绝 ----------
    dup = ORIG.decode("utf-8")
    dup = dup.replace("### §5.3 `cli` 形态要说清什么",
                      "### §5.3 `cli` 形态要说清什么\n\n### §5.3 `cli` 形态要说清什么", 1)
    wb(DOC, dup.encode("utf-8"))
    d_sha = sha(rb(DOC))
    rc, out = run()
    row("⭐ M2：锚点命中 2 次也拒绝（不是只查 0 次）",
        rc != 0 and "命中 2 次" in out, "rc=%d" % rc)
    row("⭐ M2 连带：文档仍字节级没被动过", sha(rb(DOC)) == d_sha)
    wb(DOC, ORIG)

    # ---------- M3：混合行尾 ⇒ 拒绝动手 ----------
    mixed = ORIG.decode("utf-8").split("\n")
    half = "\r\n".join(mixed[:50]) + "\n" + "\n".join(mixed[50:])
    wb(DOC, mixed_b := half.encode("utf-8"))
    m_sha = sha(mixed_b)
    rc, out = run()
    row("⭐ M3：混合行尾 ⇒ 拒绝动手（不把混乱扩大）",
        rc != 0 and "混合" in out, "rc=%d" % rc)
    row("⭐ M3 连带：文档字节级没被动过", sha(rb(DOC)) == m_sha)
    wb(DOC, ORIG)

    # ---------- M4：整份 CRLF ⇒ 照打，且**还是 CRLF** ----------
    crlf = ORIG.decode("utf-8").replace("\n", "\r\n").encode("utf-8")
    wb(DOC, crlf)
    rc, out = run()
    now = rb(DOC)
    n_lf = now.count(b"\n")
    n_crlf = now.count(b"\r\n")
    row("⭐⭐ M4：文档是 CRLF 也能打（锚点先归一化）",
        rc == 0 and out.count("✅") == 4, "rc=%d, %d 处" % (rc, out.count("✅")))
    row("⭐⭐ M4 连带：打完**还是 CRLF** —— 没把行尾偷偷改成 LF",
        n_lf == n_crlf and n_lf > 0, "CRLF %d / LF %d" % (n_crlf, n_lf - n_crlf))
    row("⭐ M4：报出来的行尾判断是对的", "文档行尾：CRLF" in out)
    wb(DOC, ORIG)

    # ---------- M5：写后自查能抓到「丢行」 ----------
    src = rb(APPLY)
    bak_apply = APPLY + ".mutbak"
    wb(bak_apply, src)
    KEPT.append(bak_apply)
    hurt = src.decode("utf-8").replace(
        '        work = work.replace(anchor, repl, 1)',
        '        work = work.replace(anchor, "", 1)  # mutated: 删掉不插入', 1)
    changed = hurt.encode("utf-8") != src
    wb(APPLY, hurt.encode("utf-8"))
    row("⭐ M5 前提：突变真的改到了 apply 脚本（不然下面是假绿）", changed)
    rc, out = run()
    row("⭐⭐ M5：把锚点删掉而不是替换 ⇒ 写后自查抓到「丢了行」并还原",
        rc != 0 and "丢了" in out, "rc=%d" % rc)
    row("⭐⭐ M5 连带：文档被**还原回原样**，不是留在丢了行的状态",
        sha(rb(DOC)) == ORIG_SHA, sha(rb(DOC))[:12])
    row("⭐ M5 连带：还原了就点名备份还留着（唯一的原件不能没）",
        "备份保留" in out and os.path.exists(DOC + ".seedbak"))
    if os.path.exists(DOC + ".seedbak"):
        os.unlink(DOC + ".seedbak")
    wb(APPLY, src)
    os.unlink(bak_apply)
    KEPT.remove(bak_apply)

    # ---------- 收尾 ----------
    rc, out = run()
    row("还原后回到基线（打完的字节与第一次逐字一致）",
        rc == 0 and sha(rb(DOC)) == PATCHED_SHA, PATCHED_SHA[:12])
    # ⭐ 退回**你跑之前那个状态**，不是退回未打补丁 ——
    #   打过就还它打过的，没打过就还它没打过的。验红不该替你改变文档状态。
    wb(DOC, CUR)
    row("⭐ 验红跑完，文档退回你跑之前那个状态（打过就还打过的）",
        sha(rb(DOC)) == CUR_SHA,
        "%s（%s）" % (CUR_SHA[:12], "已打补丁" if started_patched else "未打补丁"))
    row("没有残骸（.seedbak / .mutbak 都不在）",
        not os.path.exists(DOC + ".seedbak")
        and not os.path.exists(APPLY + ".mutbak"))
    row("apply 脚本自己字节级没被改坏", sha(rb(APPLY)) == sha(src))

    print()
    print("=== 结账 ===")
    bad = [n for n, ok, _ in ROWS if not ok]
    print("  %d 条，全过 = %s" % (len(ROWS), not bad))
    for n in bad:
        print("    FAIL  %s" % n)
    return 0 if not bad else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        for p in KEPT:
            if os.path.exists(p):
                print("⛔ 残留备份（请手工处理）：%s" % p)
