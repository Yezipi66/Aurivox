#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mutate_shim_split —— 给 measure_shim_split 验红。

一把尺子如果怎么改都读出同一个数，那它量的不是被测对象，是它自己的想象。
这里逐条把「被测对象」和「量法本身」改坏，确认读数**跟着变、而且变对方向**。

⭐ 备份纪律（吃过亏）：backup() 只在**还没有备份时**建，且**每次 patch 前调**；
   restore() 之后**不删备份**。否则同一个文件第二次突变就没有备份可还原，
   突变会留在盘上。

用法：python tools/dev/mutate_shim_split.py
退出码：0 全过 / 1 有条目没过 / 2 收尾没干净
"""

import hashlib
import io
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

TOOL = os.path.join(HERE, "measure_shim_split.py")
SHIM = os.path.join(ROOT, "engines", "indextts2", "shim.py")
FIXTURE_LEFTOVER = os.path.join(HERE, "_selftest_shim.py")

ROWS = []


def check(good, label, extra=""):
    ROWS.append((bool(good), label, extra))


# ⛔⛔ 备份/还原/改写一律走**二进制**。
#   2026-08-25 真机事故：原来用 io.open(...,encoding="utf-8") 文本模式往返，
#   读时 universal newlines 把 CRLF 折成 \n，写时又把 \n 摊成 os.linesep。
#   在 Linux 上 os.linesep="\n" ⇒ LF 文件往返恒等 ⇒ 沙箱里这个 bug 不存在；
#   在 Windows 上 os.linesep="\r\n" ⇒ **LF 的 shim.py 被整体写成 CRLF**，
#   内容一个字没变，git 却报 M（523 行全改）。
#   ⇒ 「还原」必须是字节级的，文本模式给不了这个保证。
def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path, data):
    with open(path, "wb") as f:
        f.write(data)


def sha(path):
    return hashlib.sha256(read_bytes(path)).hexdigest()


def backup(path):
    bak = path + ".mutbak"
    if not os.path.exists(bak):
        write_bytes(bak, read_bytes(path))
    return bak


def restore(path):
    bak = path + ".mutbak"
    if os.path.exists(bak):
        write_bytes(path, read_bytes(bak))


KEPT_BACKUPS = []


def drop_backups():
    """⛔⛔ 备份只有在**确认还原成功**之后才允许删。
    2026-08-25 验红时红出来的第二个真缺陷：原来这里无条件 unlink，
    于是「restore 失败 + 备份被删」＝**唯一的原件也没了**（没有 git 就真没了）。
    ⭐ 判据是字节比对，不是「restore() 有没有抛异常」——
      还原失败可以是静默的（只读、被占用、磁盘满都可能写了一半）。"""
    KEPT_BACKUPS[:] = []
    for p in (TOOL, SHIM):
        bak = p + ".mutbak"
        if not os.path.exists(bak):
            continue
        if os.path.exists(p) and read_bytes(p) == read_bytes(bak):
            os.unlink(bak)
        else:
            KEPT_BACKUPS.append(bak)
            print("⛔ %s 没还原成功 —— **保留备份不删**：%s\n"
                  "   还原命令：Copy-Item -Force %s %s"
                  % (os.path.relpath(p, ROOT), os.path.relpath(bak, ROOT),
                     bak, p))


def patch(path, old, new, count=1):
    """按锚点改写。⭐ 锚点里的 \\n 就是磁盘上的 \\n —— 不做行尾翻译。
    这两个脚本本来就是 LF 存的；哪天变成 CRLF，这里会**响亮地**报
    「锚点命中 0 次」，而不是静默改错行。"""
    backup(path)
    raw = read_bytes(path)
    src = raw.decode("utf-8")
    if src.count(old) != count:
        why = ""
        # ⭐ 命中 0 次 + 文件是 CRLF ⇒ 十有八九就是行尾，直接点名，
        #   别让人对着一行锚点发呆。（2026-08-25 真机就是这么撞上的。）
        if src.count(old) == 0 and b"\r\n" in raw:
            why = ("\n   ⚠ 这个文件是 CRLF（%d 行），而锚点是 LF —— 多半就是行尾。\n"
                   "     先 `git checkout -- %s` 把它还原成 LF 再跑。"
                   % (raw.count(b"\r\n"), os.path.relpath(path, ROOT)))
        raise SystemExit(
            "⛔ 锚点命中 %d 次（应为 %d），突变脚本自己过期了：%s\n   %s%s"
            % (src.count(old), count, os.path.relpath(path, ROOT), old[:70], why))
    write_bytes(path, src.replace(old, new, count).encode("utf-8"))


def run():
    proc = subprocess.run([sys.executable, TOOL], cwd=ROOT,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return proc.returncode, proc.stdout.decode("utf-8", "replace")


def num(out, pattern, default=None):
    m = re.search(pattern, out)
    return int(m.group(1)) if m else default


def buckets(out):
    return {k: num(out, r"%s\s+(\d+) 行" % k) for k in
            ("GENERIC", "NAMED", "ENGINE")}


def housed(out):
    return num(out, r"有家的（[^）]*）：(\d+) 条")


def homeless(out):
    return num(out, r"没家的（[^）]*）：(\d+) 条")


def main():
    print("=== measure_shim_split 验红 ===\n")

    if not os.path.isfile(TOOL):
        print("⛔ 找不到被测工具：%s" % TOOL)
        return 2
    if not os.path.isfile(SHIM):
        print("⛔ 找不到 engines/indextts2/shim.py —— 要么宿主已经建好了，")
        print("  要么这不是项目根。没有可突变的对象。")
        return 2

    # ⭐⭐ 跑任何突变之前，先把两个被改写对象的字节指纹钉下来。
    #    行为回到基线 ≠ 文件回到基线 —— 8-25 那次 shim.py 行为一模一样，
    #    磁盘上却 523 行全变了行尾，而当时的断言一条都没抓到。
    sha_shim_0, sha_tool_0 = sha(SHIM), sha(TOOL)

    # ---- 备份/还原自身必须字节恒等（平台无关的夹具） --------------------
    #    ⭐ 夹具故意用 CRLF：文本模式往返在 Linux 上会把它折成 LF、
    #      在 Windows 上会把 LF 摊成 CRLF —— 两个方向、同一个根因。
    #      只用 LF 夹具的话，这条守卫在 Linux 上永远绿，等于没写。
    rt = os.path.join(HERE, "_mut_roundtrip.tmp")
    try:
        for tag, blob in (("CRLF", b"a\r\nb\r\n"), ("LF", b"a\nb\n"),
                          ("混合", b"a\r\nb\nc")):
            write_bytes(rt, blob)
            backup(rt)
            write_bytes(rt, b"x")          # 假装突变改了它
            restore(rt)
            got = read_bytes(rt)
            check(got == blob,
                  "⭐⭐ 备份/还原字节恒等（%s 行尾）—— 还原是字节级的，不是"
                  "「内容看起来一样」" % tag,
                  "%r → %r" % (blob, got))
            os.unlink(rt + ".mutbak")
    finally:
        for p in (rt, rt + ".mutbak"):
            if os.path.exists(p):
                os.unlink(p)

    # ---- 基线 ----------------------------------------------------------
    rc0, out0 = run()
    b0 = buckets(out0)
    check(rc0 == 0, "基线：退出码 0", "rc=%d" % rc0)
    check("自检：10 ok / 0 FAIL" in out0, "基线：自检 10 条全过")
    check(all(v for v in b0.values()), "基线：三个桶都量到了数",
          "GENERIC=%s NAMED=%s ENGINE=%s" % (b0["GENERIC"], b0["NAMED"], b0["ENGINE"]))
    h0, hl0 = housed(out0), homeless(out0)
    check(h0 and hl0, "基线：有家/没家两桶都非空", "有家=%s 没家=%s" % (h0, hl0))
    check(not os.path.exists(FIXTURE_LEFTOVER), "基线：自检夹具没留在盘上")

    try:
        # ---- M1：改被测对象 -------------------------------------------
        # ⛔ 锚点必须带**整行缩进**。第一版只写了 8 个空格，而真身是 12 个 ——
        #   count 照样是 1（8 空格是 12 空格的后缀），替换后把行劈成两半，
        #   shim 变成语法错误。「命中 1 次」不等于「命中的是那一行」。
        patch(SHIM,
              "            _torch.manual_seed(seed)\n",
              "            pass  # mutated\n")
        rc, out = run()
        hl = homeless(out)
        check(rc == 0 and hl == hl0 - 1,
              "M1：shim 里拆掉 _torch.manual_seed ⇒ 没家的少一条（量的是真身）",
              "%s → %s" % (hl0, hl))
        restore(SHIM)

        # ---- M2 ⭐⭐：拆掉量法的 header_nodes -------------------------
        patch(TOOL,
              "    for top in header_nodes(stmt):\n"
              "        for node in ast.walk(top):\n"
              "            if isinstance(node, ast.Name) and node.id in names:",
              "    for top in [stmt]:\n"
              "        for node in ast.walk(top):\n"
              "            if isinstance(node, ast.Name) and node.id in names:")
        rc, out = run()
        fails = re.findall(r"   FAIL  (.+)", out)
        check(rc == 1 and len(fails) == 1 and "class 头" in fails[0],
              "⭐⭐ M2：判定不再只看语句抬头 ⇒ 自检**只红这一条**（判别力）",
              "rc=%d，红了 %d 条：%s" % (rc, len(fails),
                                        fails[0][:24] if fails else "无"))
        check("下面的数一个都别信" in out and buckets(out)["ENGINE"] is None,
              "⭐⭐ M2 连带：自检红了就**一个数都不打印** —— 虚高的读数根本没机会被读到")
        restore(TOOL)

        # ---- M3 ⭐：关掉污点传播 --------------------------------------
        patch(TOOL,
              "    upstream = propagate_taint(tree, set(upstream))",
              "    upstream = set(upstream)")
        rc, out = run()
        fails = re.findall(r"   FAIL  (.+)", out)
        check(rc == 1 and any("污点传播" in f for f in fails),
              "⭐ M3：关掉污点传播 ⇒ 自检点名「污点传播」这条",
              "rc=%d，红 %d 条" % (rc, len(fails)))
        check(len(fails) == 3 and any("方法调用会被列成待判事实" in f for f in fails),
              "⭐ M3 连带：它一倒，「合成方法能被认出来」也跟着倒 —— "
              "合成方法是**推**出来的，不是写死的",
              "红的三条：%s" % " / ".join(f[:16] for f in fails))
        restore(TOOL)

        # ---- M4 ⭐：契约落点表里删掉 call.method ----------------------
        patch(TOOL,
              '    ("call.method", "合成方法叫什么", "§5.2"),\n', "")
        rc, out = run()
        check(rc == 0 and homeless(out) == hl0 + 1 and housed(out) == h0 - 1,
              "⭐ M4：契约删掉 call.method ⇒ infer 从「有家」掉进「没家」"
              "（那张表是带电的，不是摆设）",
              "有家 %s→%s 没家 %s→%s" % (h0, housed(out), hl0, homeless(out)))
        restore(TOOL)

        # ---- M5 ⭐：自检夹具清理失效 ----------------------------------
        patch(TOOL,
              "        try:\n            os.unlink(tmp)\n        except OSError:\n            pass",
              "        try:\n            pass\n        except OSError:\n            pass")
        rc, out = run()
        check(rc == 1 and "FAIL" in out and "自检夹具已清理" in out,
              "⭐ M5：清理失效 ⇒ 自检 FAIL、退出码 1、且点名是哪一条",
              "rc=%d" % rc)
        check("下面的数一个都别信" in out,
              "⭐ M5 连带：自检没过时**拒绝打印读数**，不给出可能是错的数")
        restore(TOOL)
        if os.path.exists(FIXTURE_LEFTOVER):
            os.unlink(FIXTURE_LEFTOVER)
        check(not os.path.exists(FIXTURE_LEFTOVER), "M5 善后：突变留下的夹具已清掉")

    finally:
        restore(TOOL)
        restore(SHIM)

    # ---- 还原后必须回到基线 -------------------------------------------
    rc1, out1 = run()
    b1 = buckets(out1)
    check(rc1 == 0 and b1 == b0 and housed(out1) == h0 and homeless(out1) == hl0,
          "还原后回到基线（三个桶 + 两桶条目数逐字一致）",
          "%s / 有家%s / 没家%s" % (b1, housed(out1), homeless(out1)))

    # ---- ⭐⭐ 被测对象必须**字节级**回到跑之前 --------------------------
    #    这就是 8-25 漏掉的那条。当时「还原后回到基线」只比了读数，
    #    读数一模一样，而 git 报 engines/indextts2/shim.py 已修改。
    check(sha(SHIM) == sha_shim_0,
          "⭐⭐ shim.py 字节级回到跑之前（git 不该报 M）",
          "%s → %s" % (sha_shim_0[:12], sha(SHIM)[:12]))
    check(sha(TOOL) == sha_tool_0,
          "⭐ measure_shim_split.py 字节级回到跑之前（sha256 还对得上）",
          "%s → %s" % (sha_tool_0[:12], sha(TOOL)[:12]))

    # ---- 这条守卫自己得有判别力（改一个字节它必须叫） ------------------
    backup(SHIM)
    try:
        write_bytes(SHIM, read_bytes(SHIM) + b"# mutated\n")
        check(sha(SHIM) != sha_shim_0,
              "⭐ 字节守卫验红：shim.py 多一个字节，守卫立刻不认")
    finally:
        restore(SHIM)
    check(sha(SHIM) == sha_shim_0,
          "⭐ 字节守卫验红善后：还原后指纹又对上了",
          sha(SHIM)[:12])

    # ---- ⭐⭐ 进程级：半路死掉，现场必须是干净的 -----------------------
    #    2026-08-25 真机留下 shim.py.mutbak 的那条路径，就在这儿被守住。
    proc = subprocess.run([sys.executable, os.path.abspath(__file__),
                           "--selfcheck-abort"],
                          cwd=ROOT, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT)
    aout = proc.stdout.decode("utf-8", "replace")
    m = re.search(r"ABORT-MUTATED-SHA (\w+)", aout)
    check(m is not None and m.group(1) != sha_shim_0,
          "⭐ 收尾网验红前提：子进程真的把 shim.py 改坏了（不然下面两条是假绿）",
          (m.group(1)[:12] if m else "没打印出来"))
    check(proc.returncode != 0 and "这是故意的" in aout,
          "⭐⭐ 子进程半路 SystemExit（模拟锚点对不上）",
          "rc=%d" % proc.returncode)
    check(sha(SHIM) == sha_shim_0,
          "⭐⭐ 半路死掉之后 shim.py 仍字节级完好（收尾网挂在进程级 finally 上）",
          sha(SHIM)[:12])
    check(not os.path.exists(SHIM + ".mutbak"),
          "⭐⭐ 半路死掉之后没留下 .mutbak —— 这正是真机那次留下的残骸")

    # ---- ⭐⭐ 还原失败时，备份必须留着 ---------------------------------
    #    上一条的连带发现：收尾网拦住了「文件被改坏」，却拦不住
    #    「还原失败 + 备份照删」—— 那才是真正不可逆的一步。
    print("  （下面那条 ⛔「没还原成功」是这一步**故意造**的，不是事故）")
    backup(SHIM)
    write_bytes(SHIM, read_bytes(SHIM) + b"# restore-failed\n")
    drop_backups()                       # 此刻文件 != 备份
    check(os.path.exists(SHIM + ".mutbak"),
          "⭐⭐ 还原没成功时**备份必须留着** —— 否则唯一的原件也没了")
    check(KEPT_BACKUPS == [SHIM + ".mutbak"],
          "⭐ 而且它点名是哪个文件没还原（不是默默留着）",
          ", ".join(os.path.relpath(p, ROOT) for p in KEPT_BACKUPS) or "没点名")
    restore(SHIM)
    drop_backups()                       # 此刻文件 == 备份
    check(sha(SHIM) == sha_shim_0 and not os.path.exists(SHIM + ".mutbak"),
          "⭐ 还原成功之后备份才被删（判据是字节比对，不是「没抛异常」）",
          sha(SHIM)[:12])

    drop_backups()
    leftovers = [p for p in (TOOL + ".mutbak", SHIM + ".mutbak", FIXTURE_LEFTOVER,
                             os.path.join(HERE, "_mut_roundtrip.tmp"))
                 if os.path.exists(p)]
    check(not leftovers, "没有残骸（.mutbak / 自检夹具都不在）",
          ", ".join(os.path.relpath(p, ROOT) for p in leftovers))

    print()
    bad = 0
    for good, label, extra in ROWS:
        print("  %-8s %s%s" % ("RED-OK" if good else "RED-FAIL", label,
                               ("   [%s]" % extra) if extra else ""))
        if not good:
            bad += 1
    print("\n=== 结账 ===")
    print("  %d 条，全过 = %s" % (len(ROWS), bad == 0))
    if leftovers:
        return 2
    return 0 if bad == 0 else 1


def cleanup_all():
    """⛔⛔ 收尾网。2026-08-25 真机事故：`patch()` 锚点对不上抛 SystemExit，
    **直接跳过了 restore() 和 drop_backups()** ⇒ 盘上留下一个 .mutbak。
    那次它恰好死在改写之前，所以只留了备份；死在第二次 patch 就会同时留下
    「一个被改坏的文件」和「一个备份」—— 最坏的结局。
    ⭐ 「没有残骸」那条断言写在 main() 结尾，那条路径上根本执行不到 ——
      **守卫只守了成功路径**，和行尾那次是同一个病。
    ⇒ 还原 + 删备份必须挂在进程级 finally 上，任何退法都走一遍。"""
    for p in (TOOL, SHIM):
        restore(p)
    drop_backups()
    for p in (FIXTURE_LEFTOVER, os.path.join(HERE, "_mut_roundtrip.tmp")):
        if os.path.exists(p):
            os.unlink(p)


def selfcheck_abort():
    """隐藏开关：改坏 shim 之后故意死掉，用来验「半路死掉，现场干净吗」。
    ⭐ 这条必须是**进程级**的 —— 在 finally 里写几行代码不算修好，
      得有一次真的异常退出证明现场是干净的。"""
    patch(SHIM, "            _torch.manual_seed(seed)\n",
          "            pass  # selfcheck-abort\n")
    # ⭐ 把改坏之后的指纹打出来。父进程要拿它证明**文件真的被改过**，
    #   否则「跑完还是原样」这条断言在「patch 根本没生效」时也会绿 —— 那是假绿。
    print("ABORT-MUTATED-SHA %s" % sha(SHIM))
    raise SystemExit("⛔ --selfcheck-abort：这是故意的，用来验收尾网")


if __name__ == "__main__":
    try:
        if "--selfcheck-abort" in sys.argv:
            selfcheck_abort()
        _rc = main()
    finally:
        cleanup_all()
    sys.exit(_rc)
