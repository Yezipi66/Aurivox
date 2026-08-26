# -*- coding: utf-8 -*-
"""两个方向各验一次红，证明「扁平 requires_reference_audio」这处修改扛事。"""
import re
import shutil
import subprocess
import sys

import os
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOST = ROOT + "/lib/engines/host.py"
PROBE = ROOT + "/tools/dev/probe_host.py"

NEW_HOST = 'needs_ref = bool(profile.get("requires_reference_audio"))'
OLD_HOST = 'needs_ref = bool(profile.get("capabilities", {}).get("requires_reference_audio"))'
NEW_FIX = '"requires_reference_audio": True,'
OLD_FIX = '"capabilities": {"requires_reference_audio": True},'


def run():
    r = subprocess.run([sys.executable, "tools/dev/probe_host.py"], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
    out = r.stdout.decode("utf-8", "replace")
    # ⭐ 第 11 条教训：只数实时表格那一段，结账段是复述，数两遍会翻倍。
    head = out.split("=== 结账")[0].split("结账：")[0]
    fails = re.findall(r"^\s*FAIL\s+(.*)$", head, re.M)
    return r.returncode, fails, out


def patch(path, old, new):
    s = open(path, encoding="utf-8").read()
    assert old in s, "找不到要替换的串：%r" % old[:50]
    open(path, "w", encoding="utf-8").write(s.replace(old, new, 1))


def main():
    results = []

    # ---- 基线 ----
    rc, fails, out = run()
    results.append(("基线：29 条全过", rc == 0 and not fails,
                    "rc=%d 红 %d 条" % (rc, len(fails))))

    host_bak = open(HOST, encoding="utf-8").read()
    probe_bak = open(PROBE, encoding="utf-8").read()

    # ---- A) host.py 退回旧读法，夹具保持真形状 ----
    patch(HOST, NEW_HOST, OLD_HOST)
    rc, fails, out = run()
    hit = [f for f in fails if "参考音频" in f]
    results.append(("⭐⭐ A：host.py 退回 capabilities 读法 ⇒「缺参考音频」那条 400 立刻红",
                    len(hit) >= 1, "红 %d 条：%s" % (len(fails), (hit[0][:60] if hit else "—"))))
    # ⭐⭐ 这里原本断言「只红 1 条」，实测红 2 条。去量了 host.py:513 才发现
    #   needs_ref 是**两道闸共用的开关**（:514 缺参考音频、:517 参考音频不存在）。
    #   ⇒ 是我的断言写得比现实窄，不是代码牵连。按纪律改断言、不改代码。
    #   顺带把这个 bug 的真实杀伤面从「1 道 400」修正为「2 道 400」。
    both = [f for f in fails if "参考音频" in f]
    results.append(("⭐⭐ A 连带：恰好红这 2 条 —— needs_ref 是两道闸共用的开关",
                    len(fails) == 2 and len(both) == 2,
                    "红 %d 条 / 参考音频相关 %d 条" % (len(fails), len(both))))
    open(HOST, "w", encoding="utf-8").write(host_bak)

    # ---- B) 夹具退回旧形状，host.py 保持新读法 ----
    patch(PROBE, NEW_FIX, OLD_FIX)
    rc, fails, out = run()
    hit = [f for f in fails if "参考音频" in f]
    results.append(("⭐⭐ B：夹具退回 capabilities 形状 ⇒ 同一条也红（夹具是承重的，不是装饰）",
                    len(hit) >= 1, "红 %d 条" % len(fails)))
    open(PROBE, "w", encoding="utf-8").write(probe_bak)

    # ---- 还原后回基线 ----
    rc, fails, out = run()
    results.append(("还原后回到基线", rc == 0 and not fails,
                    "rc=%d 红 %d 条" % (rc, len(fails))))

    print("=== requires_reference_audio 修复验红 ===")
    print()
    for name, ok, note in results:
        print("  %-8s %s   [%s]" % ("RED-OK" if ok else "RED-FAIL", name, note))
    print()
    ok_all = all(o for _, o, _ in results)
    print("=== 结账 ===")
    print("  %d 条，全过 = %s" % (len(results), ok_all))
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
