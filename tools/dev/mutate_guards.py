#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mutate_guards.py — 突变验证：lib/root_layout.node.test.js 里那几块守卫真的能红吗？

守卫最常见的失败方式不是「写错」，而是**写成摆设**：断言恒真、锚点漂了、
或者一条测试只覆盖两分支里的一条。这些靠 review 看不出来，只能靠突变验证 ——
把产品代码故意改坏，看守卫红不红。

覆盖两组：
  A 组（5 条）  引擎起来后收掉 GPT_SoVITS 空壳（lib/inference/infer_server.py）
  B 组（6 条）  .gitignore 不许吞掉产品代码（.gitignore + 守卫自身的解析逻辑）

规矩：
  1. 先跑基线，fail 必须是 0；否则后面每一条 RED 都不可信。
  2. 每条突变的锚点必须**恰好**命中一次，抓不到就算「锚点坏」，不算 RED。
  3. 无论成败都还原（try/finally），跑完再验一次基线。

用法（在仓库根）：
    .\\venv\\Scripts\\python.exe tools\\dev\\mutate_guards.py
"""

import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, os.pardir, os.pardir))

TEST_REL = os.path.join("lib", "root_layout.node.test.js")
TEST = os.path.join(ROOT, TEST_REL)
PY = os.path.join(ROOT, "lib", "inference", "infer_server.py")
IGNORE = os.path.join(ROOT, ".gitignore")

NODE = os.path.join(ROOT, "tools", "runtime", "node", "node.exe")
if not os.path.exists(NODE):
    NODE = "node"


def run_tests():
    p = subprocess.run([NODE, "--test", TEST_REL], cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    m = re.search(r"^.{0,2}\s*fail (\d+)\s*$", p.stdout, re.M)
    return (int(m.group(1)) if m else -1), p.stdout


SWEEP_CALL = "\n_sweep_upstream_shell_dir()\n"

# (组, 名字, 目标文件, 原文, 替换, 为什么必须红)
MUTANTS = [
    # ---- A 组：空壳收尾 ----------------------------------------------------
    ("A", "只删调用，留一个没人叫的函数", PY,
     SWEEP_CALL, "\n",
     "空壳再也不会被收掉，根目录每次起引擎都脏一次"),

    ("A", "收尾被挪到 TTS_Config 构造之前", PY,
     "tts_config = TTS_Config(config_path)",
     "_sweep_upstream_shell_dir()\ntts_config = TTS_Config(config_path)",
     "空壳是 TTS_Config.__init__ 造的，提前删会被它随后重新造出来"),

    ("A", "去掉「有文件就原样留着」那道闸", PY,
     "    if files:", "    if False:",
     "变成无差别删目录 —— 有人把权重树搬回来就被悄悄删光"),

    ("A", "不再递归查里面有没有文件", PY,
     "os.walk(shell)", "[(shell, [], [])]",
     "只看顶层 -> 权重塞在 configs/ 子目录里就查不到，照样删"),

    ("A", "函数定义整个改名（模拟被重构掉）", PY,
     "def _sweep_upstream_shell_dir", "def _sweep_upstream_shell_dir_x",
     "锚点没了，守卫必须当场喊，而不是默默变成恒真"),

    # ---- B 组：.gitignore 不许吞产品代码 -----------------------------------
    ("B", "把 lib/cache 的反选删掉（复现 2026-08-24 真实事故）", IGNORE,
     "cache/\n!lib/cache/\n", "cache/\n",
     "lib/cache/ 又被吞 -> 主守卫必须红"),

    ("B", "裸目录名改成按整条路径比（不再比末段）", TEST,
     "  if (rule.kind === 'bare') return prefix.split('/').pop() === rule.path",
     "  if (rule.kind === 'bare') return prefix === rule.path",
     "cache/ 再也够不着 lib/cache -> 事故形状漏判 -> 自验必须红"),

    ("B", "反选被当成普通忽略（不看 ! ）", TEST,
     "      if (ruleMatches(r, prefix, isDir)) ignored = !r.neg",
     "      if (ruleMatches(r, prefix, isDir)) ignored = true",
     "!lib/cache/ 救不回来 -> 把能用的修法误伤成红 -> 自验必须红"),

    ("B", "规则顺序反过来（git 是后来者居上）", TEST,
     "    for (const r of rules) {",
     "    for (const r of [...rules].reverse()) {",
     "反选写在忽略规则前面时会被误判成有效 -> 自验必须红"),

    ("B", "锚定规则被当成裸目录名", TEST,
     "      rules.push({ neg, kind: 'anchored', path: p.slice(1), dirOnly })",
     "      rules.push({ neg, kind: 'bare', path: p.slice(1), dirOnly })",
     "/cache/ 会误伤 lib/cache -> 自验必须红"),

    ("B", "require 落点不再补 .js 后缀", TEST,
     "      for (const cand of [base, base + '.js', base + '.cjs', base + '.json',",
     "      for (const cand of [base, base + '.cjs', base + '.json',",
     "无后缀的 ./lib/sub/b 解析不出来 -> 自验必须红"),

    # 对照组：这一条**期望 GREEN**。主守卫的断言在盘面干净时本就恒真，
    # 单独把它挖空看不出来 —— 它的红由 B 组第一条（真把反选删掉）担保。
    # 留着这条是为了让「RED 全中」这个读数不至于是因为随便改哪都红。
    ("B", "对照组：主守卫断言挖空（预期 GREEN，不是 bug）", TEST,
     "  assert.deepEqual(swallowedRequires(edges, rules), [],",
     "  assert.deepEqual([], [],",
     "盘面本来就干净 -> 单独挖空看不出，靠 B 组第一条兜底"),
]

EXPECT_GREEN = {"对照组：主守卫断言挖空（预期 GREEN，不是 bug）"}


def main():
    for f in (TEST, PY, IGNORE):
        if not os.path.exists(f):
            print("找不到 %s —— 你在仓库根跑了吗？" % f)
            return 1

    fail, out = run_tests()
    if fail != 0:
        print("基线就不干净（fail=%s），先把它弄绿再来。" % fail)
        print(out[-2000:])
        return 1
    print("基线 OK：fail=0\n")

    red = green = broken = bad = 0
    for group, name, target, old, new, why in MUTANTS:
        src = open(target, encoding="utf-8").read()
        n = src.count(old)
        if n != 1:
            print("  [%s] 锚点坏  %s（命中 %d 次）" % (group, name, n))
            broken += 1
            continue
        shutil.copyfile(target, target + ".mutbak")
        try:
            with open(target, "w", encoding="utf-8") as fh:
                fh.write(src.replace(old, new, 1))
            f2, _ = run_tests()
            want_green = name in EXPECT_GREEN
            ok = (f2 == 0) if want_green else (f2 > 0)
            if not ok:
                bad += 1
            if f2 > 0:
                red += 1
            else:
                green += 1
            print("  [%s] %-5s %s  — %s  %s"
                  % (group, "RED" if f2 > 0 else "GREEN", name, why,
                     "OK" if ok else "<== 不符预期"))
        finally:
            shutil.move(target + ".mutbak", target)

    print("\nRED %d / GREEN %d / 锚点坏 %d / 不符预期 %d / 共 %d"
          % (red, green, broken, bad, len(MUTANTS)))
    after, _ = run_tests()
    print("还原后基线 fail=%d" % after)
    return 0 if (after == 0 and broken == 0 and bad == 0) else 1


if __name__ == "__main__":
    sys.exit(main())
