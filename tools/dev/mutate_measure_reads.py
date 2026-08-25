#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""measure_manifest_reads 的验红。

⛔ 为什么非有不可：这把尺子在 2026-08-25 当天就被抓出**两个**错读 ——
   ① 虚报：把「平台读它是为了判断你有没有写它，而正确答案是别写」的键，
      报成「⭐ 你漏了」（照着补 ⇒ 名片当场抛）；
   ② 低报：量法自己把 `m.maps` 整个覆盖掉，模板另外 9 个 map 键
      **既不在活也不在死**，凭空消失。
   两个都不会让任何东西变红 —— 尺子读错了，输出照样漂亮。
   所以下面每一条突变，还原的都是**真实发生过的那个 bug**。

只改自己的备份能还原的东西；跑完必须回到基线。
"""
import io
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE = sys.argv[1] if len(sys.argv) > 1 else "node"
TOOL = os.path.join(ROOT, "tools", "dev", "measure_manifest_reads.cjs")
TEMPLATE = os.path.join(ROOT, "engines", "_TEMPLATE", "manifest.json")
PROFILE = os.path.join(ROOT, "lib", "engines", "profile.js")
PROBE_DIR = os.path.join(ROOT, "engines", "readprobe")

results = []


def record(ok, what):
    results.append((ok, what))
    print("  %-8s %s" % ("RED-OK" if ok else "**RED-FAIL**", what))


def run():
    p = subprocess.Popen([NODE, TOOL], cwd=ROOT,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out, _ = p.communicate()
    return p.returncode, out.decode("utf-8", "replace")


def section(text, title):
    """取报告里某一节的正文（到下一个 [ 开头的行或分隔线为止）。"""
    lines = text.splitlines()
    buf, on = [], False
    for ln in lines:
        if ln.startswith("[" + title):
            on = True
            continue
        if on and (ln.startswith("[") or ln.startswith("====")):
            break
        if on:
            buf.append(ln)
    return "\n".join(buf)


def live_keys(text):
    return set(re.findall(r"^\s+✅ (\S+)\s*$", section(text, "活键"), re.M))


def backup(paths):
    """⛔⛔ 只在没有备份时建 —— 而且每次突变前都要调。

    2026-08-25 亲手踩到：原写法是开场 backup 一次、每次 restore 后把 .mutbak
    删掉，于是**同一个文件的第二次突变没有备份可还原** —— restore 变成空操作，
    M5 那条「把清理掏空」的突变就这么留在了盘上。后果不是报错，是**被测工具
    从此是坏的**，而它照样输出漂亮的报告。
    ⭐ 是最后那条「还原后回到基线」的断言把它抓出来的 —— 验红脚本自己也需要
    一条「我有没有把现场恢复原样」的断言，不能只断言被测对象。
    """
    for p in paths:
        if not os.path.exists(p + ".mutbak"):
            shutil.copyfile(p, p + ".mutbak")


def restore(paths):
    for p in paths:
        if os.path.exists(p + ".mutbak"):
            shutil.copyfile(p + ".mutbak", p)
            os.remove(p + ".mutbak")


def patch(path, old, new):
    backup([path])            # ⭐ 每次突变前自己备份，不指望开场那一次
    s = io.open(path, encoding="utf-8").read()
    if s.count(old) != 1:
        print("  ⛔ 突变锚点命中 %d 次（要 1 次）：%s" % (s.count(old), old[:60]))
        return False
    io.open(path, "w", encoding="utf-8", newline="").write(s.replace(old, new, 1))
    return True


print("=== measure_manifest_reads 验红 ===")
print("")

ALL = [TOOL, TEMPLATE, PROFILE]
try:
    # ---- 基线 --------------------------------------------------------------
    rc, base = run()
    base_live = live_keys(base)
    record(rc == 0 and len(base_live) > 30,
           "基线：退出码 0，量到 %d 个活键" % len(base_live))
    record(not os.path.exists(PROBE_DIR),
           "基线：临时引擎目录跑完不在盘上")

    # ---- M1：真被读的键从模板挖掉 ⇒ 必须从活键里消失 -----------------------
    ok = patch(TEMPLATE, '"speed": null,', "")
    rc1, out1 = run()
    live1 = live_keys(out1)
    record(ok and "maps.speed" in base_live and "maps.speed" not in live1,
           "M1：模板挖掉 maps.speed ⇒ 它从活键消失（量的是模板真身）")
    restore([TEMPLATE])

    # ---- M2 ⭐⭐：还原「量法覆盖被测对象」那个真 bug ------------------------
    ok = patch(TOOL,
               "if (!m.maps || !m.maps.text) m.maps = Object.assign({ text: 'text' }, m.maps || {})",
               "m.maps = { text: 'text' }")
    rc2, out2 = run()
    live2 = live_keys(out2)
    vanished = {k for k in base_live if k.startswith("maps.")} - live2
    dead2 = section(out2, "死数据")
    record(ok and len(vanished) >= 5,
           "⭐⭐ M2：量法写死 m.maps ⇒ %d 个 map 键从活键掉队（低报回潮）" % len(vanished))
    record(ok and not any(k in dead2 for k in vanished),
           "⭐⭐ M2 连带：掉队的键**也没进死数据** —— 它们凭空消失，这才是这个 bug 最阴的地方")
    restore([TOOL])

    # ---- M3 ⭐：还原「把别写的键报成你漏了」那个虚报 ------------------------
    ok = patch(PROFILE, "if (inDefaults && inSchema) {",
               "if (false && inDefaults && inSchema) {")
    rc3, out3 = run()
    cand = section(out3, "平台读过")
    add3 = cand.split("⛔ 别写")[0]
    record(ok and "params.schema.example_strength.default" in add3,
           "⭐ M3：拆掉 profile.js 的二选一检查 ⇒ schema.default 从「别写」挪到「真该补」")
    record(ok and "ENGINE_LEGACY_DEFAULT_AMBIGUOUS" in out3,
           "⭐ M3 连带：legacy_default 仍在「别写」（两条判据各管各的，没互相顶替）")
    restore([PROFILE])

    # ---- M4：基线里「别写」两条都必须带平台自己的错误码 --------------------
    rc4, out4 = run()
    band = section(out4, "平台读过")
    record("ENGINE_LEGACY_DEFAULT_AMBIGUOUS" in band
           and "ENGINE_MANIFEST_INVALID_VALUE" in band
           and "真该补（加上去平台照跑不误）：0 个" in band,
           "M4：基线上「真该补」为 0，两条「别写」都贴着平台自己的错误码")

    # ---- M5 ⭐：清理失效 ⇒ 退出码 2 且点名 ---------------------------------
    ok = patch(TOOL, "fs.rmSync(PROBE_DIR, { recursive: true, force: true })",
               "/* 突变：清理被掏空 */")
    rc5, out5 = run()
    leftover = os.path.exists(PROBE_DIR)
    record(ok and rc5 == 2 and "清理失败" in out5,
           "⭐ M5：清理失效 ⇒ 退出码 2，且报告点名「清理失败」")
    restore([TOOL])
    if leftover:
        shutil.rmtree(PROBE_DIR, ignore_errors=True)
    record(not os.path.exists(PROBE_DIR), "M5 善后：突变留下的探针目录已清掉")

    # ---- 还原 --------------------------------------------------------------
    rc9, out9 = run()
    record(rc9 == 0 and live_keys(out9) == base_live,
           "还原后回到基线（退出码 0，活键清单与基线逐字一致）")

finally:
    restore(ALL)
    shutil.rmtree(PROBE_DIR, ignore_errors=True)

stray = []
for dirpath, _dirs, files in os.walk(ROOT):
    if os.sep + ".git" in dirpath or "node_modules" in dirpath:
        continue
    for f in files:
        if f.endswith(".mutbak"):
            stray.append(os.path.join(dirpath, f))
record(not stray and not os.path.exists(PROBE_DIR),
       "没有残骸（.mutbak / engines/readprobe 都不在）")

print("")
print("=== 结账 ===")
allok = all(ok for ok, _ in results)
print("  %d 条，全过 = %s" % (len(results), allok))
sys.exit(0 if allok else 1)
