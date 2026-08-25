#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""probe_new_engine 的验红。

⛔ 探针不验红就是摆设 —— 一个永远打印「墙：0 堵」的脚本和一个真的在量的
   脚本，输出长得一模一样。这里做 4 组突变，每组都要求：
   ① 退出码 / 报告真的变了；② 变的**理由正确**（不是碰巧红的）。

⭐ 最要紧的是 M2：把 profile.js 里「runtime.entry 必填」这条拆掉，探针必须
   **少要一个字段**。这一条证明那张必填清单是**问出来的**，不是我抄进脚本的
   常量 —— 不然平台改了要求，探针还在报旧账。

⚠ 本脚本会临时改写 engines/_TEMPLATE/manifest.json、lib/engines/profile.js
  和 tools/dev/probe_new_engine.cjs（先 .mutbak 备份，跑完还原）。
  中途强杀会留下 .mutbak —— 那就是还没还原，手动 copy 回去。
"""
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE = os.path.join(ROOT, "tools", "dev", "probe_new_engine.cjs")
PROFILE = os.path.join(ROOT, "lib", "engines", "profile.js")
TEMPLATE = os.path.join(ROOT, "engines", "_TEMPLATE", "manifest.json")
SMOKE_DIR = os.path.join(ROOT, "engines", "smoketest")

NODE = os.path.join(ROOT, "tools", "runtime", "node", "node.exe")
if not os.path.exists(NODE):
    NODE = "node"

results = []


def run():
    p = subprocess.run([NODE, PROBE], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def record(name, ok, detail):
    results.append((name, ok, detail))
    print("  %s  %s" % ("RED-OK " if ok else "MISS   ", name))
    if not ok:
        print("        %s" % detail)


def backup(path):
    shutil.copy2(path, path + ".mutbak")


def restore(path):
    bak = path + ".mutbak"
    if os.path.exists(bak):
        shutil.copy2(bak, path)
        os.remove(bak)


def asked_fields(out):
    """从报告里抠出「平台开口要过的字段」清单。"""
    fields = []
    for ln in out.splitlines():
        m = re.match(r"^\s{8}(?:缺|值错)\s+(\S+)\s*$", ln)
        if m:
            fields.append(m.group(1))
    return fields


print("=== probe_new_engine 验红 ===")
print()

def drop_entry():
    """把 runtime.entry 从模板里挖掉（调用方负责 backup/restore）。"""
    d = json.load(open(TEMPLATE, encoding="utf-8"))
    d.get("runtime", {}).pop("entry", None)
    json.dump(d, open(TEMPLATE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


# ---- 基线 -----------------------------------------------------------------
# ⭐⭐ 2026-08-25 改口径。原来这里断言「基线**要**了字段」，因为当时模板确实
#    缺 runtime.entry / ready_endpoint / maps.text。模板修好之后那三条突变
#    集体失效 —— 不是代码坏了，是**断言写得比意图窄**：意图是「清单随模板和
#    代码变化而变化」，写出来却成了「模板必须是坏的」。
#    改法是把 M1/M2 反向做（挖掉，看它喊不喊），这样两种模板状态下都成立，
#    顺带让基线那条变成**模板的回归守卫**：模板一旦退化，这里立刻红。
rc0, out0 = run()
base = asked_fields(out0)
record("⭐ 基线：退出码 0，且平台一次没开口（模板照抄就能用）",
       rc0 == 0 and base == [],
       "rc=%s；平台还在要这些字段：%s" % (rc0, base))
record("基线：探针自己清理干净（engines/smoketest 不在盘上）",
       not os.path.exists(SMOKE_DIR),
       SMOKE_DIR)

# ---- M1：把 runtime.entry 从模板里挖掉 ⇒ 探针必须喊出来 -------------------
# 证明探针读的是**模板真实内容**，不是把一张清单写死在脚本里。
backup(TEMPLATE)
drop_entry()
rc, out = run()
got = asked_fields(out)
ok = ("runtime.entry" not in base) and ("runtime.entry" in got)
record("M1：模板挖掉 runtime.entry ⇒ 探针喊出来（读的是模板真身）", ok,
       "基线要了 %s；挖掉后要了 %s" % (base, got))
restore(TEMPLATE)

# ---- M2：⭐⭐ 模板挖掉 + 平台也不再要求 ⇒ 探针必须**不喊** ----------------
# 这一条才是命门：M1 只证明「模板变了它跟着变」，M2 证明「**平台**变了它也跟着变」。
# 挖掉模板里的 entry，同时把 profile.js 那次 required() 换成直取 ——
# 平台不喊了，探针也必须不喊。它若还在报 runtime.entry，说明它在背一张
# 写死的清单，那平台哪天改了要求，它会一直报旧账。
backup(TEMPLATE)
backup(PROFILE)
drop_entry()
txt = open(PROFILE, encoding="utf-8").read()
pat = re.compile(r"required\(manifest,\s*'runtime\.entry',\s*r\.entry,[^)]*\)", re.S)
txt2, n = pat.subn("(r.entry || 'shim.py')", txt)
assert n == 1, "M2 没打上：profile.js 里没找到 runtime.entry 那次 required()（%d 处）" % n
open(PROFILE, "w", encoding="utf-8").write(txt2)
rc, out = run()
got = asked_fields(out)
ok = "runtime.entry" not in got
record("⭐⭐ M2：模板挖掉了、但平台也不再要求 ⇒ 探针跟着不喊（清单是问出来的）", ok,
       "挖掉模板 + 拆掉平台要求之后，探针仍在要：%s" % got)
restore(PROFILE)
restore(TEMPLATE)

# ---- M2b：只拆平台要求、模板不动 ⇒ 基线不该有任何变化 --------------------
# 正对照。没有它，M2 的绿可能只是「探针什么都不喊」这种平凡绿。
backup(PROFILE)
txt = open(PROFILE, encoding="utf-8").read()
open(PROFILE, "w", encoding="utf-8").write(pat.sub("(r.entry || 'shim.py')", txt))
rc, out = run()
record("M2b 正对照：只拆平台要求、模板不动 ⇒ 报告与基线一致",
       rc == 0 and asked_fields(out) == base,
       "rc=%s fields=%s vs base=%s" % (rc, asked_fields(out), base))
restore(PROFILE)

# ---- M3：盘上留着上次的残骸 ⇒ 自检必须 FAIL 并停手 -------------------------
os.makedirs(SMOKE_DIR, exist_ok=True)
open(os.path.join(SMOKE_DIR, "manifest.json"), "w", encoding="utf-8").write("{}")
rc, out = run()
ok = rc == 1 and "FAIL" in out and "上次没清理干净" in out
record("M3：残骸还在 ⇒ 自检 FAIL、退出码 1、且理由点名「上次没清理干净」", ok,
       "rc=%s" % rc)
shutil.rmtree(SMOKE_DIR, ignore_errors=True)

# ---- M4：⭐ 清理失效 ⇒ 必须喊，且退出码非零 --------------------------------
# 这是最要命的一条：假引擎留在 engines/ 下会被注册表当真引擎，还会进发行包。
# 把 rmrf 掏空来还原「清理失败」这个场景。
backup(PROBE)
txt = open(PROBE, encoding="utf-8").read()
marker = "function rmrf(p) {"
i = txt.index(marker)
j = txt.index("\n}", i)
txt2 = txt[:i] + "function rmrf(p) {\n  return   // MUTATED: 清理失效\n" + txt[j + 1:]
open(PROBE, "w", encoding="utf-8").write(txt2)
rc, out = run()
ok = rc == 2 and "清理失败" in out and "smoketest" in out
record("⭐ M4：清理失效 ⇒ 退出码 2，且报告点名「清理失败」+ 给出删除命令", ok,
       "rc=%s" % rc)
restore(PROBE)
shutil.rmtree(SMOKE_DIR, ignore_errors=True)

# ---- 收尾 -----------------------------------------------------------------
rc, out = run()
record("还原后回到基线（退出码 0，字段清单与基线一致）",
       rc == 0 and asked_fields(out) == base,
       "rc=%s fields=%s vs base=%s" % (rc, asked_fields(out), base))

leftovers = []
for p in (PROBE, PROFILE, TEMPLATE):
    if os.path.exists(p + ".mutbak"):
        leftovers.append(p + ".mutbak")
if os.path.exists(SMOKE_DIR):
    leftovers.append(SMOKE_DIR)
record("没有残骸（.mutbak / engines/smoketest 都不在）",
       not leftovers, "残留：%s" % leftovers)

print()
print("=== 结账 ===")
allok = all(ok for _, ok, _ in results)
print("  %d 条，全过 = %s" % (len(results), allok))
if not allok:
    print("  未过：")
    for name, ok, detail in results:
        if not ok:
            print("    - %s" % name)
sys.exit(0 if allok else 1)
