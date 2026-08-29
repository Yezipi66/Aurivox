# -*- coding: utf-8 -*-
"""mutate_apply_host_block —— 给 apply_host_block.py 验红。

⭐ 那个脚本的全部价值在于「**只加不删**」这一条自查。而自查这种东西，
  不去弄坏它一次，你永远不知道它是真在拦还是只是打印了一行漂亮的字。
  这一支就是去弄坏它。

⛔ 它会临时改写 engines/indextts2/manifest.json，跑完**逐字节还原**成你跑
  之前那个样子（补过的就还是补过的，没补的就还是没补的）。
"""

import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

APPLY = os.path.join(HERE, "apply_host_block.py")
MANIFEST = os.path.join(ROOT, "engines", "indextts2", "manifest.json")
BAK_SUFFIX = ".hostblockbak"

NEW_KEYS = ["_comment_call", "call", "_comment_params", "params",
            "_comment_output_formats", "output_formats"]

RESULTS = []


def check(name, ok, note=""):
    RESULTS.append((name, ok, note))
    print("  %-8s %s   [%s]" % ("RED-OK" if ok else "RED-FAIL", name, note))


def rb(p):
    with open(p, "rb") as f:
        return f.read()


def wb(p, b):
    with open(p, "wb") as f:
        f.write(b)


def rt(p):
    return rb(p).decode("utf-8")


def wt(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def sha(b):
    import hashlib
    return hashlib.sha256(b).hexdigest()[:12]


def run():
    r = subprocess.run([sys.executable, APPLY], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=300)
    return r.returncode, r.stdout.decode("utf-8", "replace")


def strip_blocks(raw):
    """把名片退回「还没补过」的样子 —— 反向还原出未打补丁的真身。"""
    d = json.loads(raw)
    for k in NEW_KEYS:
        d.pop(k, None)
    return json.dumps(d, ensure_ascii=False, indent=2) + "\n"


def main():
    print("=== apply_host_block 验红 ===")
    print("")

    original = rb(MANIFEST)
    apply_original = rb(APPLY)

    try:
        # ---- 前提：能造出「未补」的夹具 -------------------------------
        virgin = strip_blocks(original.decode("utf-8"))
        d0 = json.loads(virgin)
        check("⭐⭐ 前提：能反向还原出「还没补过」的名片（否则下面全是空转）",
              "call" not in d0 and len(d0) > 0,
              "%d 个顶层键" % len(d0))

        # ---- 基线 -----------------------------------------------------
        wt(MANIFEST, virgin)
        base_in = rb(MANIFEST)
        rc, out = run()
        check("基线：退出码 0", rc == 0, "rc=%d" % rc)
        after = json.loads(rt(MANIFEST))
        check("基线：六个键全补上", all(k in after for k in NEW_KEYS),
              "%d 个顶层键" % len(after))
        check("基线：只加不删（原有每个顶层键的值逐字节相同）",
              all(k in after and json.dumps(after[k], sort_keys=True) ==
                  json.dumps(d0[k], sort_keys=True) for k in d0),
              "%d 个原有键" % len(d0))
        check("基线：原文每一行都还在",
              all(ln in rt(MANIFEST) for ln in virgin.split("\n") if ln.strip()))
        check("基线：文件确实变长了",
              len(rb(MANIFEST)) > len(base_in),
              "%d → %d" % (len(base_in), len(rb(MANIFEST))))
        check("基线：没留备份", not os.path.exists(MANIFEST + BAK_SUFFIX))
        patched = rb(MANIFEST)

        # ---- 幂等 -----------------------------------------------------
        rc, out = run()
        check("⭐ 幂等：第二次一个字节没动",
              rc == 0 and rb(MANIFEST) == patched, sha(rb(MANIFEST)))

        # ---- 往返闭合 -------------------------------------------------
        wt(MANIFEST, virgin)
        rc, out = run()
        check("⭐⭐ 往返闭合：还原→重打 = 第一次那份的逐字节原样",
              rb(MANIFEST) == patched,
              "%s vs %s" % (sha(rb(MANIFEST)), sha(patched)))

        # ---- M1：params 已经在了 ⇒ 拒绝（要合并不是新增）--------------
        d1 = json.loads(virgin)
        d1["params"] = {"schema": {}}
        wt(MANIFEST, json.dumps(d1, ensure_ascii=False, indent=2) + "\n")
        snap = rb(MANIFEST)
        rc, out = run()
        check("⭐⭐ M1：名片已有 params ⇒ 拒绝动手（合并要动内层缩进，风险大于收益）",
              rc == 2, "rc=%d" % rc)
        check("⭐⭐ M1 连带：一个字节都没写", rb(MANIFEST) == snap, sha(snap))
        check("⭐ M1：报文把该手工加的两个键打出来了",
              "load_time" in out and "call_time" in out)

        # ---- M2：混合行尾 ⇒ 拒绝（不把混乱扩大）-----------------------
        mixed = virgin.replace("\n", "\r\n", 5)
        wt(MANIFEST, mixed)
        snap = rb(MANIFEST)
        rc, out = run()
        check("⭐ M2：行尾是混的 ⇒ 拒绝动手（一写就会统一，把真改动淹掉）",
              rc == 2, "rc=%d" % rc)
        check("⭐ M2 连带：一个字节都没写", rb(MANIFEST) == snap)

        # ---- M3：整份 CRLF ⇒ 能打，且打完还是 CRLF ---------------------
        wt(MANIFEST, virgin.replace("\n", "\r\n"))
        rc, out = run()
        got = rt(MANIFEST)
        n_crlf = got.count("\r\n")
        n_lf = got.count("\n") - n_crlf
        check("⭐⭐ M3：名片是 CRLF 也能打", rc == 0, "rc=%d" % rc)
        check("⭐⭐ M3 连带：打完**还是 CRLF** —— 没把行尾偷偷改成 LF",
              n_crlf > 0 and n_lf == 0, "CRLF %d / LF %d" % (n_crlf, n_lf))

        # ---- M4：本来就不是合法 JSON ⇒ 拒绝 ---------------------------
        wt(MANIFEST, virgin + "  这行让它不是 JSON\n")
        snap = rb(MANIFEST)
        rc, out = run()
        check("⭐ M4：名片本来就不是合法 JSON ⇒ 拒绝动手", rc == 2, "rc=%d" % rc)
        check("⭐ M4 连带：一个字节都没写", rb(MANIFEST) == snap)

        # ---- M5：把脚本改坏，让它**删掉一行** ⇒ 写后自查必须抓到 ------
        src = rt(APPLY)
        needle = 'new_body = stripped + insertion + tail.lstrip("\\n")'
        mutant = src.replace(
            needle,
            'new_body = "\\n".join(stripped.split("\\n")[:-1]) '
            '+ insertion + tail.lstrip("\\n")  # MUTANT')
        check("⭐ M5 前提：突变真的改到了 apply 脚本（不然下面是假绿）",
              mutant != src)
        wt(APPLY, mutant)
        wt(MANIFEST, virgin)
        snap = rb(MANIFEST)
        rc, out = run()
        check("⭐⭐ M5：脚本改成会吞掉一行 ⇒ 写后自查抓到并还原",
              rc == 1, "rc=%d" % rc)
        check("⭐⭐ M5 连带：名片被**还原回原样**，不是留在缺一行的状态",
              rb(MANIFEST) == snap, sha(rb(MANIFEST)))
        check("⭐ M5 连带：还原了就点名备份还留着（唯一的原件不能没）",
              os.path.exists(MANIFEST + BAK_SUFFIX) and BAK_SUFFIX in out)
        if os.path.exists(MANIFEST + BAK_SUFFIX):
            os.remove(MANIFEST + BAK_SUFFIX)
        wb(APPLY, apply_original)

        # ---- 还原后回到基线 -------------------------------------------
        wt(MANIFEST, virgin)
        rc, out = run()
        check("还原后回到基线（打完的字节与第一次逐字一致）",
              rb(MANIFEST) == patched, sha(rb(MANIFEST)))

    finally:
        wb(MANIFEST, original)
        wb(APPLY, apply_original)

    check("⭐ 验红跑完，名片退回你跑之前那个状态",
          rb(MANIFEST) == original, sha(original))
    check("没有残骸（.hostblockbak 不在）",
          not os.path.exists(MANIFEST + BAK_SUFFIX))
    check("apply 脚本自己字节级没被改坏", rb(APPLY) == apply_original)

    print("")
    print("=== 结账 ===")
    ok = sum(1 for _, o, _ in RESULTS if o)
    print("  %d 条，全过 = %s" % (len(RESULTS), ok == len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
