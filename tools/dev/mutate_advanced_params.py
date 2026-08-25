#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 advanced_params.json 那个真实发生过的 bug 原样还原，确认守卫真的会红。

⛔ 守卫不验红就是摆设。这里做 4 组突变（A/B/C/D），每组都要求：
   ① 非零退出 / 报出问题；② 报的**理由正确**（不是碰巧红的）。

⭐ D 是本轮真正的病根：DATA_KEEP 这张白名单以前只对**目录**生效，
   data/ 顶层的**文件**从来没走过它 —— 所以光把 advanced_params.json
   从白名单里删掉，它照样进包。

⚠ 本脚本会**临时改写** tools/build/04_pack_release.py 与
  tools/dev/probe_release_contents.py（先 .mutbak 备份，跑完还原）。
  中途强杀会留下 .mutbak —— 那就是还没还原，手动 copy 回去。
"""
import os
import re
import shutil
import subprocess
import sys

# 仓库根 = 本脚本所在目录（tools/dev/）往上两级。⇒ 换机器不用改常量。
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE = os.path.join(ROOT, "tools", "dev", "probe_release_contents.py")
PACKER = os.path.join(ROOT, "tools", "build", "04_pack_release.py")
AP = "data/advanced_params.json"

results = []


def run(args, cwd=ROOT):
    p = subprocess.run([sys.executable] + args, cwd=cwd,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def record(name, ok, detail):
    results.append((name, ok, detail))
    print(("  %s  %s" % ("RED-OK " if ok else "MISS   ", name)))
    if not ok:
        print("        %s" % detail)


def data_files_in_release():
    """现场 import 打包器本体，问它 data/ 下到底有哪些文件会进包。
    ⇒ 判据来自打包器自己，不是来自我对它的复述。"""
    import importlib.util
    if os.path.join(ROOT, "tools", "build") not in sys.path:
        sys.path.insert(0, os.path.join(ROOT, "tools", "build"))
    spec = importlib.util.spec_from_file_location("_packer_probe", PACKER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    inc = mod.collect_included(ROOT)
    return sorted(r.replace("\\", "/") for r, _, _ in inc
                  if r.replace("\\", "/").startswith("data/"))


def backup(path):
    shutil.copy2(path, path + ".bak")


def restore(path):
    shutil.move(path + ".bak", path)


print("=== advanced_params 反向断言 · 验红 ===\n")

# ---- 0. 基线：现在必须是绿的 -------------------------------------------
rc, out = run([PROBE, "--selftest"])
base_green = (rc == 0 and "0 FAIL" in out)
record("基线自检为绿（不然后面红了也说明不了什么）", base_green, out[-400:])

rc, out = run([PROBE])
# 正常运行时，那条禁运规则应报 0 个
line = [l for l in out.splitlines() if AP in l and ("✅" in l or "⛔" in l)]
base_ship_green = bool(line) and "✅" in line[0]
record("基线整包扫描：包里没有它（✅）", base_ship_green,
       "没找到该行或它是红的：%s" % (line or "<无>"))

# ---- 突变 A：把它加回 MUST_SHIP -----------------------------------------
backup(PROBE)
txt = open(PROBE, encoding="utf-8").read()
txt2 = txt.replace('    ("deploy.bat", "文件", "部署入口"),',
                   '    ("%s", "文件", "出厂默认参数"),\n'
                   '    ("deploy.bat", "文件", "部署入口"),' % AP, 1)
assert txt2 != txt, "突变 A 没打上"
open(PROBE, "w", encoding="utf-8").write(txt2)
rc, out = run([PROBE, "--selftest"])
ok = (rc != 0
      and "FAIL  advanced_params 已不在 MUST_SHIP" in out
      and "界面记忆不是出厂默认值" in out)
record("突变 A：它被加回 MUST_SHIP ⇒ 自检红，且理由点名 MUST_SHIP", ok, out[-600:])
restore(PROBE)

# ---- 突变 B：把反向断言整条删掉 ------------------------------------------
backup(PROBE)
txt = open(PROBE, encoding="utf-8").read()
txt2 = re.sub(r'    \("data/advanced_params\.json",\n'
              r'     "界面记忆而非出厂默认值[^\n]*\n', "", txt, count=1)
assert txt2 != txt, "突变 B 没打上"
open(PROBE, "w", encoding="utf-8").write(txt2)
rc, out = run([PROBE, "--selftest"])
ok = (rc != 0
      and "FAIL  advanced_params 在 MUST_NOT_SHIP 里" in out
      and "DATA_KEEP" in out)
record("突变 B：反向断言被删 ⇒ 自检红，且理由点名 DATA_KEEP 会失守", ok, out[-600:])
restore(PROBE)

# ---- 突变 C：⭐ 真身 —— 打包器 DATA_KEEP 把它加回去 ----------------------
# 这才是那个 bug 真正发生的地方：探针本身一个字没改，只是打包器又开始收它。
backup(PACKER)
txt = open(PACKER, encoding="utf-8").read()
txt2 = txt.replace('DATA_KEEP = {\n',
                   'DATA_KEEP = {\n    "advanced_params.json",\n', 1)
assert txt2 != txt, "突变 C 没打上"
open(PACKER, "w", encoding="utf-8").write(txt2)
rc, out = run([PROBE])
line = [l for l in out.splitlines() if AP in l and ("✅" in l or "⛔" in l)]
ok = bool(line) and "⛔" in line[0] and "1 个" in line[0]
record("⭐ 突变 C：打包器 DATA_KEEP 加回它 ⇒ 探针报泄漏 1 个", ok,
       "该行：%s" % (line or "<无>"))
# 自检不该被这次突变影响（它查的是探针自己的表，不是包内容）
rc2, out2 = run([PROBE, "--selftest"])
record("突变 C 下自检仍绿（说明两层判据各管各的，没有互相顶替）",
       rc2 == 0 and "0 FAIL" in out2, out2[-300:])
restore(PACKER)

# ---- 突变 D：⭐⭐ 把新补的「data/ 顶层文件也走白名单」那道闸拆掉 ----------
# 这是本轮真正的修复点。拆了它 ⇒ DATA_KEEP 对文件又变回一张废纸，
# advanced_params.json / voices.json / app-config.json 会一起漏进发行包。
backup(PACKER)
txt = open(PACKER, encoding="utf-8").read()
txt2 = txt.replace(
    '            if norm(rel_dir) == "data" and fn not in DATA_KEEP:\n'
    '                continue\n', "", 1)
assert txt2 != txt, "突变 D 没打上"
open(PACKER, "w", encoding="utf-8").write(txt2)
rc, out = run([PROBE])
line = [l for l in out.splitlines() if AP in l and ("✅" in l or "⛔" in l)]
ok = bool(line) and "⛔" in line[0]
record("⭐⭐ 突变 D：拆掉 data/ 文件级白名单 ⇒ 探针报泄漏", ok,
       "该行：%s" % (line or "<无>"))
# ⭐⭐ 这道闸真正的价值不是护住 advanced_params.json 这一个名字，而是让
# 「以后新长出来的本机状态文件」默认进不去 —— 不必等它先漏一次才被人点名。
# 所以造一个 EXCLUDE_FILES 里**没有**的新文件来量：
NEWCOMER = os.path.join(ROOT, "data", "_probe_newcomer_state.json")
open(NEWCOMER, "w", encoding="utf-8").write("{}")
try:
    leaked = data_files_in_release()      # 仍在突变 D 下
    ok2 = "data/_probe_newcomer_state.json" in leaked
    record("⭐⭐ 突变 D 连带：新长出来的 data/ 文件也会漏（洞是结构性的）", ok2,
           "突变下 data/ 进包清单：%s" % leaked)
    restore(PACKER)

    leaked = data_files_in_release()      # 修复态
    ok3 = ("data/_probe_newcomer_state.json" not in leaked
           and AP not in leaked
           and "data/training_defaults.json" in leaked
           and any(x.startswith("data/pron_lexicon/") for x in leaked))
    record("修复态：界面记忆与新来者都不进包，出厂默认值与词典仍进包", ok3,
           "修复态 data/ 进包清单：%s" % leaked)
finally:
    os.remove(NEWCOMER)

# ---- 收尾：确认全部还原 --------------------------------------------------
rc, out = run([PROBE, "--selftest"])
record("还原后自检回绿", rc == 0 and "0 FAIL" in out, out[-300:])

bad = [n for n, ok, _ in results if not ok]
print("\n=== 结账 ===")
print("  %d 条，全过 = %s" % (len(results), not bad))
if bad:
    print("  未过：")
    for n in bad:
        print("    - %s" % n)
sys.exit(1 if bad else 0)
