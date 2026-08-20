#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply-r12c-batch13   [2026-08-20]  根目录收尾（Batch 4）

本轮做什么
  A. 把根目录的助手产出物 / 文档 / 缓存目录挪到该去的地方
  B. 修 batch12 留下的一处反向补丁（tools/scripts/dump_tree.ps1）
  C. 修两个「搬走就静默失准」的根定位（C7 原则：上溯找锚点，绝不数层数）
  D. 补 .gitignore 的 cache/（否则缓存迁进去反而会进 git）
  E. 两条守卫测试：根目录不许再落助手产出物；dump_tree 引用的目录必须存在

本轮不做
  - 不动 models/ data/ dist/（dist 是 04_pack_release.py 的发行产物，Owner 已确认保留）
  - 不动 .hermes/（Owner: 已 ignore，当看不见）
  - 不删 batch12 的 .bak 与 manifest（--restore 依赖它们）；
    确认不再回滚后用 --archive-batch12 归档

用法
  python apply-r12c-batch13.py                    预演（默认，不写盘）
  python apply-r12c-batch13.py --write            真改，逐文件留 .r12c-batch13.bak
  python apply-r12c-batch13.py --restore          回滚本补丁
  python apply-r12c-batch13.py --selftest         自检（含 EDITS 方向守卫）
  python apply-r12c-batch13.py --write --archive-batch12
                                                  额外归档 batch12 残留物
"""

import json
import os
import shutil
import sys

BANNER = 'apply-r12c-batch13   [2026-08-20]  根目录收尾（Batch 4）'
MANIFEST = '.r12c-batch13-manifest.json'

# 备份不落在原地。本轮要编辑 .gitignore，原地备份会在项目根留下
# .gitignore.r12c-batch13.bak —— 而本轮新加的守卫正是「根目录不得残留 .bak」，
# 补丁跑完测试立刻红。备份统一进 cache/patch-backup/，跟本轮的收纳原则一致。
BAK_DIR = 'cache/patch-backup/r12c-batch13'

def _find_project_root(start):
    """\u4e0a\u6eaf\u627e server.js \u5b9a\u4f4d\u9879\u76ee\u6839\uff08C7\uff09\u3002

    \u672c\u811a\u672c\u8dd1\u5b8c\u4f1a\u628a\u81ea\u5df1\u642c\u8fdb tools/dev/\uff0c\u4e4b\u540e --restore \u662f\u4ece\u90a3\u91cc\u8dd1\u7684\u3002
    \u5199 dirname(__file__) \u5f53\u9879\u76ee\u6839\uff0c\u642c\u5b8c\u5c31\u6307\u5411 tools/dev/ \u2014\u2014 \u8fd9\u6b63\u662f\u672c\u8f6e\u5728\u7ed9
    \u91c7\u96c6\u5668\u548c\u63a2\u9488\u4fee\u7684\u6bdb\u75c5\uff0c\u8865\u4e01\u81ea\u5df1\u4e0d\u80fd\u5e26\u7740\u3002\u4e0d\u7528 package.json \u4f5c\u951a\uff0c
    node_modules \u91cc\u904d\u5730\u90fd\u662f\u3002
    """
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, 'server.js')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit(
                '\u627e\u4e0d\u5230\u9879\u76ee\u6839\uff1a\u4ece %s \u4e00\u8def\u4e0a\u6eaf\u90fd\u6ca1\u770b\u89c1 server.js\u3002'
                % os.path.abspath(start))
        d = parent


ROOT = _find_project_root(os.path.dirname(os.path.abspath(__file__)))

# 本脚本跑完把自己搬到这里。「根目录不留助手产出物」这条规矩对补丁自己同样成立；
# 否则用户 --write 完一跑测试，第一条守卫就被补丁自己触红。
SELF_DST = 'tools/dev'

# ---------------------------------------------------------------- 搬家表

# (src, dst) —— 相对项目根，正斜杠
FILE_MOVES = [
    ('GUIDANCE.md', 'docs/GUIDANCE.md'),
    ('collect_repo_source_v4.1.py', 'tools/dev/collect_repo_source_v4.1.py'),
    ('probe_basemodel_gate.cjs', 'tools/dev/probe_basemodel_gate.cjs'),
]

DIR_MOVES = [
    ('.numba_cache', 'cache/numba'),
    ('.patch-backup', 'cache/patch-backup'),
]

# --archive-batch12 才动：batch12 的回滚材料 + 交给助手的源码快照
ARCHIVE_TO = 'cache/patch-backup/r12c-batch12'
ARCHIVE_FILES = [
    'server.js.r12c-batch12.bak',
    'README.md.r12c-batch12.bak',
    'collect_repo_source_v4.1.py.r12c-batch12.bak',
    '.r12c-batch12-manifest.json',
]
ARCHIVE_GLOB_PREFIX = ('sources_aurivox_',)

# ---------------------------------------------------------------- 改动表
#
# 注意：file 一律写【搬家之后】的路径。EDITS 在 MOVES 之后应用。

EDITS = [
    # --- 1. numba 缓存落点 ---------------------------------------------------
    # 根目录那个 .numba_cache/ 就是这一行造的。lib/paths.js:396 早已定义
    # CACHE.numba = cache/numba，lib/training/python_helper.js:141 也在用；
    # 唯独 infer_server.py 是 start.ps1:362 直接拉起的，不经过 python_helper，
    # 于是走了自己硬编码的落点。它不在任何 JS 测试的覆盖面内。
    {
        'file': 'lib/inference/infer_server.py',
        'old': '# numba (librosa \u4f9d\u8d56) \u7f13\u5b58\u76ee\u5f55: \u6307\u5411\u9879\u76ee\u5185\u53ef\u5199\u76ee\u5f55, \u907f\u514d site-packages \u53ea\u8bfb\u5bfc\u81f4\u7684 PermissionError\nos.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(PROJECT_ROOT, ".numba_cache"))\n',
        'new': '# numba (librosa \u4f9d\u8d56) \u7f13\u5b58\u76ee\u5f55: \u6307\u5411\u9879\u76ee\u5185\u53ef\u5199\u76ee\u5f55, \u907f\u514d site-packages \u53ea\u8bfb\u5bfc\u81f4\u7684 PermissionError\n# r12c batch13: \u843d\u70b9\u7edf\u4e00\u5230 cache/numba\uff0c\u4e0e lib/paths.js:396 \u7684 CACHE.numba \u5bf9\u9f50\u3002\n# \u8fd9\u91cc\u53ea\u80fd\u628a\u540c\u4e00\u4e2a\u4f4d\u7f6e\u518d\u5199\u6210 Python\uff08\u8ddf download_models.py \u4e00\u6837\uff09\uff0c\n# \u4f4d\u7f6e\u6743\u5a01\u4ecd\u5728 lib/paths.js\u3002\u6539\u90a3\u8fb9\u5c31\u8981\u540c\u6b65\u6539\u8fd9\u91cc\u3002\nos.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(PROJECT_ROOT, "cache", "numba"))\n',
    },

    # --- 2. batch12 的反向补丁（自伤 #17） -----------------------------------
    # batch12 里这条 edit 的 old/new 整条写反了：old 写的是 sweep 之后的
    # pipeline\uvr5，new 写的是搬家之前的 vendor\uvr5 —— 净效果是把 sweep 的
    # 正确结果又改回旧路径。Dump-Tree 对不存在的目录不报错、只输出空，
    # 于是「这两棵树是空的」和「这两棵树根本没扫」读数一模一样。
    # 这个脚本是认识盘面的诊断工具，它坏了等于看到的世界坏了。
    {
        'file': 'tools/scripts/dump_tree.ps1',
        'old': "Dump-Tree (Join-Path $root 'vendor\\uvr5') 'vendor\\uvr5 (vocal separation code)'\nDump-Tree (Join-Path $root 'vendor\\asr') 'vendor\\asr (speech recognition code)'\nDump-Tree (Join-Path $root 'vendor\\tts') 'vendor\\tts (TTS engines)'\nDump-Tree (Join-Path $root 'vendor\\gsv-tools') 'vendor\\gsv-tools (weights only, moving to models/)'\nDump-Tree (Join-Path $root 'vendor') 'vendor (ffmpeg etc.)'\n",
        # 刻意不加 models/ 一行：dump_tree 看的是代码树，权重由 probe / download_models
        # 负责；而且 models/ 不进 git，助手侧没有它，加了会让守卫在助手树上恒红。
        'new': "Dump-Tree (Join-Path $root 'pipeline\\uvr5') 'pipeline\\uvr5 (vocal separation code)'\nDump-Tree (Join-Path $root 'pipeline\\asr') 'pipeline\\asr (speech recognition code)'\nDump-Tree (Join-Path $root 'pipeline\\slicer') 'pipeline\\slicer (audio slicing code)'\nDump-Tree (Join-Path $root 'engines') 'engines (one dir per TTS engine)'\nDump-Tree (Join-Path $root 'vendor') 'vendor (prebuilt third-party: ffmpeg / micromamba)'\n",
    },

    # --- 3. .gitignore：cache/ 从来没被 ignore 过 ----------------------------
    {
        'file': '.gitignore',
        'old': '# numba JIT cache, created at runtime by the inference stack\n.numba_cache/\n',
        'new': '# Runtime caches. r12c batch13 consolidated every cache under cache/\n# (see lib/paths.js CACHE_DIR / CACHE). The bare .numba_cache/ line stays so a\n# tree that predates the move keeps ignoring its leftovers.\ncache/\n.numba_cache/\n',
    },

    # --- 3.5 采集器白名单漏收 engines/ 与 pipeline/ ---------------------------
    # batch12 搬家后，采集器旁边的注释被改成了「engines/ 和 pipeline/ 必须收」，
    # 但 TOP_ALLOW 本身一个字没动 —— 注释改了、判据没改。后果不是报错：
    # 采集器照跑照出包，只是包里没有 engines/ 和 pipeline/。真机跑一次就看得见：
    #   自检 RED: engines/gpt-sovits/infer/TTS.py、pipeline/uvr5/uvr5_models.js
    #   闭合检查 RED: 4 条断链（server.js 和 lib/ 三处都 require pipeline/uvr5）
    # 角色给 "vendored"（1MB 上限）：它们和原 vendor/ 一样是我们改过的上游代码，
    # 那些超大词典本来就该被上限挡掉，行为与搬家前一致。
    {
        'file': 'tools/dev/collect_repo_source_v4.1.py',
        'old': '    ("vendor",               "vendored"),  # \u4e0a\u6e38\u5f15\u64ce\u4ee3\u7801'
               '\uff08\u6211\u4eec\u6253\u8865\u4e01\u7684\u5bf9\u8c61\uff09\n'
               '    ("GPT_SoVITS",           "vendored"),  # \u5386\u53f2\u9057\u7559'
               '\uff0c\u6b63\u5728\u8bc4\u4f30\u80fd\u5426\u5220\n',
        'new': '    ("vendor",               "vendored"),  # \u9884\u7f16\u8bd1\u7b2c\u4e09\u65b9'
               '\uff08ffmpeg / micromamba / python / node\uff09\n'
               '    ("engines",              "vendored"),  # \u6bcf\u4e2a TTS \u5f15\u64ce\u4e00\u4e2a'
               '\u76ee\u5f55\uff0c\u91cc\u9762\u662f\u6211\u4eec\u7ef4\u62a4\u7684\u4e0a\u6e38\u4ee3\u7801\n'
               '    ("pipeline",             "vendored"),  # uvr5 / asr / slicer'
               '\uff0c\u540c\u4e0a\n'
               '    ("GPT_SoVITS",           "vendored"),  # \u5386\u53f2\u9057\u7559'
               '\uff0c\u6b63\u5728\u8bc4\u4f30\u80fd\u5426\u5220\n',
    },

    # --- 4. 搬走就静默失准之一：采集器 ---------------------------------------
    # ROOT = dirname(__file__) 在根目录时恰好等于项目根。搬进 tools/dev/ 之后
    # ROOT 变成 tools/dev/，于是它会去 tools/dev/lib、tools/dev/web 找源码,
    # 全都不存在 —— 结果不是报错，是采集出一棵空树。
    # C7 原则：上溯找锚点 server.js，绝不数目录层数。
    # 锚点用 server.js 而不是 package.json：node_modules 里遍地 package.json。
    {
        'file': 'tools/dev/collect_repo_source_v4.1.py',
        'old': 'ROOT = os.path.dirname(os.path.abspath(__file__))\n',
        'new': 'def _find_project_root(start):\n'
               '    """\u4e0a\u6eaf\u627e server.js \u5b9a\u4f4d\u9879\u76ee\u6839\uff08C7\uff09\u3002\n\n'
               '    \u7edd\u4e0d\u5199 dirname(dirname(...)) \u8fd9\u79cd\u6570\u5c42\u6570\u7684\u5199\u6cd5\uff1a\u672c\u6587\u4ef6\u5f53\u521d\u5c31\u5728\n'
               '    \u9879\u76ee\u6839\uff0cr12c batch13 \u628a\u5b83\u642c\u8fdb tools/dev/ \u540e\u5c42\u6570\u53d8\u4e86\uff0c\u800c\u6570\u5c42\u6570\n'
               '    \u7684\u5199\u6cd5\u4e0d\u4f1a\u62a5\u9519 \u2014\u2014 \u53ea\u4f1a\u91c7\u96c6\u51fa\u4e00\u68f5\u7a7a\u6811\u3002\n'
               '    \u9525\u70b9\u7528 server.js \u800c\u4e0d\u662f package.json\uff1anode_modules \u91cc\u904d\u5730\u662f\u540e\u8005\u3002\n'
               '    """\n'
               '    d = os.path.abspath(start)\n'
               '    while True:\n'
               '        if os.path.exists(os.path.join(d, "server.js")):\n'
               '            return d\n'
               '        parent = os.path.dirname(d)\n'
               '        if parent == d:\n'
               '            raise SystemExit(\n'
               '                "\u627e\u4e0d\u5230\u9879\u76ee\u6839\uff1a\u4ece %s \u4e00\u8def\u4e0a\u6eaf\u90fd\u6ca1\u770b\u89c1 server.js\u3002"\n'
               '                % os.path.abspath(start))\n'
               '        d = parent\n'
               '\n'
               '\n'
               'ROOT = os.environ.get("AURIVOX_ROOT") or _find_project_root(\n'
               '    os.path.dirname(os.path.abspath(__file__)))\n',
    },

    # --- 5. 搬走就静默失准之二：底模探针 -------------------------------------
    {
        'file': 'tools/dev/probe_basemodel_gate.cjs',
        'old': 'const ROOT = __dirname\n',
        'new': '// \u4e0a\u6eaf\u627e server.js \u5b9a\u4f4d\u9879\u76ee\u6839\uff08C7\uff09\u3002\u539f\u5148\u5199\u7684\u662f __dirname \u2014\u2014 \u63a2\u9488\u5f53\u65f6\n'
               '// \u5c31\u5728\u9879\u76ee\u6839\uff0c\u6070\u597d\u76f8\u7b49\uff1br12c batch13 \u628a\u5b83\u642c\u8fdb tools/dev/ \u540e\u5c31\u4e0d\u76f8\u7b49\u4e86\u3002\n'
               'function findProjectRoot(start) {\n'
               '  let d = start\n'
               '  for (;;) {\n'
               "    if (fs.existsSync(path.join(d, 'server.js'))) return d\n"
               '    const parent = path.dirname(d)\n'
               '    if (parent === d) {\n'
               '      throw new Error(\n'
               '        `\\u627e\\u4e0d\\u5230\\u9879\\u76ee\\u6839\\uff1a\\u4ece ${start} \\u4e00\\u8def\\u4e0a\\u6eaf\\u90fd\\u6ca1\\u770b\\u89c1 server.js`)\n'
               '    }\n'
               '    d = parent\n'
               '  }\n'
               '}\n'
               '\n'
               'const ROOT = process.env.AURIVOX_ROOT || findProjectRoot(__dirname)\n',
    },
]

# ---------------------------------------------------------------- 新建文件

CREATES = [
    ('tools/dev/README.md',
     '# tools/dev\n'
     '\n'
     '\u4e00\u6b21\u6027 / \u8f85\u52a9\u6027\u7684\u5f00\u53d1\u811a\u672c\uff1a\u8865\u4e01\uff08`apply-*.py`\uff09\u3001\u63a2\u9488\uff08`probe_*`\uff09\u3001\n'
     '\u6e90\u7801\u91c7\u96c6\u5668\uff08`collect_*`\uff09\u3002\n'
     '\n'
     '\u5b83\u4eec **\u4e0d\u662f\u4ea7\u54c1\u7684\u4e00\u90e8\u5206**\uff0c\u4e0d\u8fdb\u53d1\u884c\u5305\uff0c\u4e5f\u4e0d\u5f97\u88ab `lib/` `server.js`\n'
     '`web/` \u5f15\u7528\u3002\u653e\u5728\u8fd9\u91cc\u53ea\u4e3a\u4e86\u4e24\u4ef6\u4e8b\uff1a\u6839\u76ee\u5f55\u4e0d\u518d\u88ab\u5237\u5c4f\uff0c\u4ee5\u53ca\u4e0b\u6b21\u8fd8\u627e\u5f97\u5230\u3002\n'
     '\n'
     '## \u89c4\u77e9\n'
     '\n'
     '- \u5b9a\u4f4d\u9879\u76ee\u6839\u4e00\u5f8b **\u4e0a\u6eaf\u627e `server.js`**\uff0c\u7edd\u4e0d\u5199 `dirname(dirname(...))`\u3002\n'
     '  \u6570\u5c42\u6570\u7684\u5199\u6cd5\u4e00\u642c\u5c31\u5931\u51c6\uff0c\u800c\u4e14**\u4e0d\u62a5\u9519**\uff08r12c batch13 \u5f53\u573a\u629b\u4e86\u4e24\u4f8b\uff09\u3002\n'
     '- \u8865\u4e01\u811a\u672c\u4e00\u5f8b\uff1a\u9ed8\u8ba4 dry-run / `--write` \u7559 `.bak` / `--restore` / `--selftest`\u3002\n'
     '- \u63a2\u9488\u53ea\u8bfb\u3002\u8981\u6539\u76d8\u7684\u5199\u6210\u8865\u4e01\uff0c\u4e0d\u8981\u6df7\u5728\u63a2\u9488\u91cc\u3002\n'),

    ('lib/root_layout.node.test.js',
     "'use strict'\n"
     '\n'
     '// ---------------------------------------------------------------------------\n'
     '//  \u6839\u76ee\u5f55\u5e03\u5c40\u5b88\u536b\uff08r12c batch13\uff09\n'
     '// ---------------------------------------------------------------------------\n'
     '// \u6839\u76ee\u5f55\u662f\u6700\u5bb9\u6613\u817b\u6389\u7684\u5730\u65b9\uff1a\u6bcf\u6b21\u6392\u67e5\u90fd\u4f1a\u843d\u4e00\u4e2a\u63a2\u9488\u3001\u6bcf\u6b21\u6539\u52a8\u90fd\u4f1a\n'
     '// \u843d\u4e00\u4e2a\u8865\u4e01\uff0c\u79ef\u5230\u4e00\u5b9a\u7a0b\u5ea6\u5c31\u770b\u4e0d\u51fa\u54ea\u4e9b\u662f\u4ea7\u54c1\u3001\u54ea\u4e9b\u662f\u5783\u573e\u3002\n'
     '// \u8ba9\u6d4b\u8bd5\u76ef\u7740\uff0c\u4e0d\u9760\u8bb0\u6027\u3002\n'
     '\n'
     "const test = require('node:test')\n"
     "const assert = require('node:assert')\n"
     "const fs = require('node:fs')\n"
     "const path = require('node:path')\n"
     '\n'
     "const P = require('./paths')\n"
     '\n'
     'const ROOT = P.APP_DIR\n'
     '\n'
     '// \u52a9\u624b\u4ea7\u51fa\u7269\u7684\u5f62\u72b6\u3002\u5b83\u4eec\u5f52 tools/dev/\u3002\n'
     'const ASSISTANT_ARTIFACT = [\n'
     "  { re: /^apply-.*\\.py$/, why: '\u8865\u4e01\u811a\u672c\u5f52 tools/dev/' },\n"
     "  { re: /^probe_.*\\.(cjs|js|py)$/, why: '\u63a2\u9488\u5f52 tools/dev/' },\n"
     "  { re: /^collect_.*\\.py$/, why: '\u91c7\u96c6\u5668\u5f52 tools/dev/' },\n"
     "  { re: /^sources_.*\\.zip$/, why: '\u6e90\u7801\u5feb\u7167\u4e0d\u5f97\u7559\u5728\u6839\u76ee\u5f55' },\n"
     ']\n'
     '\n'
     "test('\u6839\u76ee\u5f55\u4e0d\u5f97\u518d\u843d\u52a9\u624b\u4ea7\u51fa\u7269\uff08\u8865\u4e01 / \u63a2\u9488 / \u91c7\u96c6\u5668 / \u5feb\u7167\uff09', () => {\n"
     '  const offenders = []\n'
     '  for (const name of fs.readdirSync(ROOT)) {\n'
     '    for (const rule of ASSISTANT_ARTIFACT) {\n'
     '      if (rule.re.test(name)) offenders.push(`${name}\uff08${rule.why}\uff09`)\n'
     '    }\n'
     '  }\n'
     '  assert.deepEqual(offenders, [],\n'
     "    `\u9879\u76ee\u6839\u53d1\u73b0\u52a9\u624b\u4ea7\u51fa\u7269\uff1a${offenders.join('\u3001')} \u2014\u2014 ` +\n"
     "    '\u8fd9\u4e9b\u4e0d\u662f\u4ea7\u54c1\u7684\u4e00\u90e8\u5206\uff0c\u5f52 tools/dev/\uff08\u89c1 tools/dev/README.md\uff09')\n"
     '})\n'
     '\n'
     "test('\u6839\u76ee\u5f55\u4e0d\u5f97\u6b8b\u7559 .bak', () => {\n"
     '  const offenders = fs.readdirSync(ROOT).filter((n) => n.endsWith(\'.bak\'))\n'
     '  assert.deepEqual(offenders, [],\n'
     "    `\u9879\u76ee\u6839\u6b8b\u7559\u8865\u4e01\u5907\u4efd\uff1a${offenders.join('\u3001')} \u2014\u2014 ` +\n"
     "    '\u786e\u8ba4\u4e0d\u518d\u56de\u6eda\u540e\u5f52\u6863\u5230 cache/patch-backup/\u3002' +\n"
     "    '\u7559\u5728\u6839\u76ee\u5f55\u4f1a\u88ab\u5f53\u6210\u6d3b\u4ee3\u7801\u8bfb\uff0c\u8bfb\u4e86\u5c31\u4f1a\u7167\u9519\u7684\u6539')\n"
     '})\n'
     '\n'
     "test('numba \u7f13\u5b58\u4e0d\u5f97\u518d\u843d\u5728\u9879\u76ee\u6839', () => {\n"
     '  // \u843d\u70b9\u6743\u5a01\u662f lib/paths.js \u7684 CACHE.numba\u3002infer_server.py \u66fe\u7ecf\u81ea\u5df1\u786c\u7f16\u7801\n'
     "  // PROJECT_ROOT/.numba_cache\uff0c\u800c\u5b83\u662f start.ps1 \u76f4\u63a5\u62c9\u8d77\u7684\uff0c\u4e0d\u7ecf\u8fc7 python_helper\u3002\n"
     "  assert.ok(!fs.existsSync(path.join(ROOT, '.numba_cache')),\n"
     "    '\u9879\u76ee\u6839\u53c8\u51fa\u73b0\u4e86 .numba_cache/ \u2014\u2014 \u6709\u4eba\u7ed5\u8fc7\u4e86 lib/paths.js \u7684 CACHE.numba\uff0c' +\n"
     "    '\u53bb\u67e5\u8c01\u5728 setdefault(\"NUMBA_CACHE_DIR\", ...) \u91cc\u5199\u4e86\u81ea\u5df1\u7684\u843d\u70b9')\n"
     '})\n'
     '\n'
     "test('dump_tree.ps1 \u5f15\u7528\u7684\u76ee\u5f55\u5fc5\u987b\u5b58\u5728\uff08\u9632\u8bca\u65ad\u5de5\u5177\u9759\u9ed8\u5931\u660e\uff09', (t) => {\n"
     '  // \u81ea\u4f24 #17\uff1abatch12 \u628a\u8fd9\u4e2a\u811a\u672c\u6539\u6210\u5f15\u7528\u5df2\u4e0d\u5b58\u5728\u7684 vendor\\\\uvr5\u3002\n'
     '  // Dump-Tree \u5bf9\u4e0d\u5b58\u5728\u7684\u76ee\u5f55**\u4e0d\u62a5\u9519\u3001\u53ea\u8f93\u51fa\u7a7a**\uff0c\u4e8e\u662f\n'
     "  // \u300c\u8fd9\u68f5\u6811\u662f\u7a7a\u7684\u300d\u548c\u300c\u8fd9\u68f5\u6811\u6839\u672c\u6ca1\u626b\u300d\u8bfb\u6570\u4e00\u6a21\u4e00\u6837\u3002\n"
     "  const ps1 = path.join(ROOT, 'tools', 'scripts', 'dump_tree.ps1')\n"
     '  if (!fs.existsSync(ps1)) {\n'
     "    t.skip('tools/scripts/dump_tree.ps1 \u4e0d\u5728\u76d8\u4e0a')\n"
     '    return\n'
     '  }\n'
     "  const src = fs.readFileSync(ps1, 'utf8')\n"
     '  const re = /Dump-Tree \\(Join-Path \\$root \'([^\']+)\'\\)\\s*\'([^\']*)\'/g\n'
     '  const missing = []\n'
     '  let m\n'
     '  let seen = 0\n'
     '  while ((m = re.exec(src)) !== null) {\n'
     '    seen += 1\n'
     '    const rel = m[1]\n'
     '    const label = m[2]\n'
     '    // \u6807\u4e86 (if any) \u7684\u662f\u53ef\u9009\u76ee\u5f55\uff0c\u4e0d\u5728\u76d8\u4e0a\u662f\u6b63\u5e38\u7684\u3002\n'
     "    if (label.includes('if any')) continue\n"
     "    const full = path.join(ROOT, rel.split('\\\\').join(path.sep))\n"
     '    if (!fs.existsSync(full)) missing.push(rel)\n'
     '  }\n'
     "  assert.ok(seen > 0, 'dump_tree.ps1 \u91cc\u4e00\u6761 Dump-Tree \u8c03\u7528\u90fd\u6ca1\u89e3\u6790\u51fa\u6765 \u2014\u2014 ' +\n"
     "    '\u6b63\u5219\u8ddf\u811a\u672c\u5199\u6cd5\u5bf9\u4e0d\u4e0a\u4e86\uff0c\u8fd9\u6761\u65ad\u8a00\u5df2\u7ecf\u53d8\u6210\u6052\u771f')\n"
     '  assert.deepEqual(missing, [],\n'
     "    `dump_tree.ps1 \u5f15\u7528\u4e86\u4e0d\u5b58\u5728\u7684\u76ee\u5f55\uff1a${missing.join('\u3001')} \u2014\u2014 ` +\n"
     "    '\u5b83\u662f\u8ba4\u8bc6\u76d8\u9762\u7684\u8bca\u65ad\u5de5\u5177\uff0c\u5f15\u7528\u5931\u51c6\u65f6\u8f93\u51fa\u770b\u8d77\u6765\u53ea\u662f\u300c\u90a3\u91cc\u662f\u7a7a\u7684\u300d')\n"
     '})\n'),
]


# ---------------------------------------------------------------- 工具

def p(rel):
    return os.path.join(ROOT, rel.replace('/', os.sep))


def bak_path(rel):
    """\u5907\u4efd\u843d\u5230 cache/patch-backup/r12c-batch13/\uff0c\u76ee\u5f55\u5206\u9694\u7b26\u538b\u6210 __\u3002"""
    return p('%s/%s.bak' % (BAK_DIR, rel.replace('/', '__')))


def read_text(path):
    """\u8bfb\u6210 \u005cn \u884c\u5c3e\uff0c\u5e76\u544a\u77e5\u539f\u672c\u662f\u4e0d\u662f CRLF\u3002

    dump_tree.ps1 / .bat \u5728 .gitattributes \u91cc\u88ab\u89c4\u5b9a\u4e3a eol=crlf\u3002
    \u951a\u70b9\u91cc\u6ca1\u6709 \u005cr \u4f1a\u8ba9 count() \u8fd4\u56de 0\uff0c\u8868\u73b0\u4e3a\u300c\u6587\u4ef6\u4e0e\u9884\u671f\u4e0d\u7b26\u300d\u3002
    """
    with open(path, 'rb') as f:
        raw = f.read()
    crlf = b'\r\n' in raw
    return raw.decode('utf-8').replace('\r\n', '\n'), crlf


def write_text(path, text, crlf):
    data = text.replace('\n', '\r\n') if crlf else text
    with open(path, 'wb') as f:
        f.write(data.encode('utf-8'))


def load_manifest():
    mp = p(MANIFEST)
    if not os.path.exists(mp):
        return None
    with open(mp, 'rb') as f:
        return json.loads(f.read().decode('utf-8'))


# ---------------------------------------------------------------- 计划

def plan():
    """\u7b97\u51fa\u8fd8\u6ca1\u505a\u7684\u4e8b\u3002\u5df2\u505a\u7684\u4e0d\u91cd\u590d\u505a\uff08\u5e42\u7b49\uff09\u3002"""
    moves, dirmoves, edits, creates, done = [], [], [], [], []

    for src, dst in FILE_MOVES:
        s, d = p(src), p(dst)
        if os.path.exists(d) and not os.path.exists(s):
            done.append('move  %s -> %s' % (src, dst))
        elif os.path.exists(s):
            moves.append((src, dst))
        else:
            done.append('skip  %s\uff08\u4e24\u8fb9\u90fd\u4e0d\u5728\u76d8\u4e0a\uff09' % src)

    for src, dst in DIR_MOVES:
        s, d = p(src), p(dst)
        if os.path.isdir(s):
            dirmoves.append((src, dst))
        elif os.path.isdir(d):
            done.append('move  %s/ -> %s/' % (src, dst))
        else:
            done.append('skip  %s/\uff08\u4e0d\u5728\u76d8\u4e0a\uff09' % src)

    for e in EDITS:
        fp = p(e['file'])
        if not os.path.exists(fp):
            # 可能是搬家之后才出现的路径；MOVES 先跑，这里按搬家后判断
            src_of = None
            for s, d in FILE_MOVES:
                if d == e['file']:
                    src_of = s
            if src_of and os.path.exists(p(src_of)):
                txt, _ = read_text(p(src_of))
                n = txt.count(e['old'])
                if n == 1:
                    edits.append(e)
                    continue
                if e['new'] in txt:
                    done.append('edit  %s\uff08\u5df2\u662f\u4fee\u597d\u7684\u7248\u672c\uff09' % e['file'])
                    continue
            raise SystemExit('\u274c \u627e\u4e0d\u5230\u6587\u4ef6\uff1a%s' % e['file'])
        txt, _ = read_text(fp)
        if e['new'] in txt:
            done.append('edit  %s\uff08\u5df2\u662f\u4fee\u597d\u7684\u7248\u672c\uff09' % e['file'])
            continue
        n = txt.count(e['old'])
        if n != 1:
            raise SystemExit(
                '\u274c %s \u4e0e\u9884\u671f\u4e0d\u7b26\uff1a\u951a\u70b9\u51fa\u73b0 %d \u6b21\uff08\u5e94\u4e3a 1\uff09\u3002\n'
                '   \u8fd9\u4e2a\u8865\u4e01\u53ea\u80fd\u8dd1\u5728 apply-r12c-batch12 \u5df2\u5e94\u7528\u7684\u6811\u4e0a\u3002' % (e['file'], n))
        edits.append(e)

    for rel, body in CREATES:
        fp = p(rel)
        if os.path.exists(fp):
            cur, _ = read_text(fp)
            if cur == body:
                done.append('create %s\uff08\u5df2\u5b58\u5728\u4e14\u5185\u5bb9\u76f8\u540c\uff09' % rel)
                continue
            raise SystemExit('\u274c %s \u5df2\u5b58\u5728\u4e14\u5185\u5bb9\u4e0d\u540c\uff0c\u4e0d\u6562\u8986\u76d6' % rel)
        creates.append((rel, body))

    return moves, dirmoves, edits, creates, done


# ---------------------------------------------------------------- 自检

def selftest():
    print(BANNER)
    print('\u81ea\u68c0\uff08\u4e0d\u5199\u76d8\uff09')
    print('=' * 66)
    ok = fail = 0

    def check(name, cond, detail=''):
        nonlocal ok, fail
        if cond:
            ok += 1
            print('   ok    %s' % name)
        else:
            fail += 1
            print('   FAIL  %s  %s' % (name, detail))

    # --- EDITS 方向守卫 ---------------------------------------------------
    # 自伤 #17：batch12 里 dump_tree.ps1 那条 edit 的 old/new 整条写反。
    # 人眼逐条读 old/new 在几十条规模上必漏，让机器读。
    OLD_ONLY = ['vendor\\uvr5', 'vendor\\asr', 'vendor/uvr5', 'vendor/asr',
                'vendor/tts/gpt-sovits', '.numba_cache']
    NEW_ONLY = ['pipeline\\uvr5', 'pipeline\\asr', 'pipeline/uvr5', 'pipeline/asr',
                'engines/gpt-sovits']
    bad = []
    for e in EDITS:
        for tok in NEW_ONLY:
            if tok in e['old'] and tok not in e['new']:
                bad.append('%s: \u65b0\u8def\u5f84 %s \u51fa\u73b0\u5728 old \u91cc\u5374\u4e0d\u5728 new \u91cc' % (e['file'], tok))
        for tok in OLD_ONLY:
            if tok in e['new'] and tok not in e['old']:
                bad.append('%s: \u65e7\u8def\u5f84 %s \u51fa\u73b0\u5728 new \u91cc\u5374\u4e0d\u5728 old \u91cc' % (e['file'], tok))
    check('EDITS \u65b9\u5411\u5b88\u536b\uff08old=\u65e7 / new=\u65b0\uff0c\u4e0d\u5f97\u53cd\uff09', not bad, '; '.join(bad))

    # 同一文件多条 edit：备份必须只做一次，且 man['edited'] 不得重复。
    seen, dup_files = set(), set()
    for e in EDITS:
        if e['file'] in seen:
            dup_files.add(e['file'])
        seen.add(e['file'])
    backed, edited_list = set(), []
    for e in EDITS:
        if e['file'] not in backed:
            backed.add(e['file'])
            edited_list.append(e['file'])
    check('\u540c\u6587\u4ef6\u591a\u6761 edit \u65f6\u5907\u4efd\u53ea\u505a\u4e00\u6b21',
          len(edited_list) == len(set(edited_list)) and len(backed) == len(seen),
          '\u6709\u91cd\u590d\u5907\u4efd\uff0c--restore \u4f1a\u56de\u4e0d\u5230\u539f\u59cb\u6001')
    # 多条 edit 落在同一文件时，各自的 old 不得互相包含，否则先改的那条会把
    # 后一条的锚点吃掉（或反过来），表现为「锚点找不到」而不是错误的改动。
    overlap = []
    for f in dup_files:
        olds = [e['old'] for e in EDITS if e['file'] == f]
        for i in range(len(olds)):
            for j in range(len(olds)):
                if i != j and olds[i] in olds[j]:
                    overlap.append(f)
    check('\u540c\u6587\u4ef6\u5404\u6761 edit \u7684\u951a\u70b9\u4e92\u4e0d\u5305\u542b', not overlap,
          '; '.join(sorted(set(overlap))))

    # 反例守卫：把一条故意写反的 edit 喂进去，上面那套判据必须抓到它。
    fake_old = "Dump-Tree (Join-Path $root 'pipeline\\uvr5')\n"
    fake_new = "Dump-Tree (Join-Path $root 'vendor\\uvr5')\n"
    caught = any(tok in fake_old and tok not in fake_new for tok in NEW_ONLY)
    check('\u65b9\u5411\u5b88\u536b\u7684\u53cd\u4f8b\uff08\u5199\u53cd\u7684 edit \u5fc5\u987b\u88ab\u6293\u4f4f\uff09', caught,
          '\u5b88\u536b\u6293\u4e0d\u4f4f\u6545\u610f\u5199\u53cd\u7684\u4f8b\u5b50 \u2014\u2014 \u5b83\u662f\u6052\u771f\u7684')

    # --- CRLF 往返 --------------------------------------------------------
    ps1 = p('tools/scripts/dump_tree.ps1')
    if os.path.exists(ps1):
        txt, crlf = read_text(ps1)
        check('dump_tree.ps1 \u8bfb\u51fa\u4e3a CRLF\uff08.gitattributes \u89c4\u5b9a\uff09', crlf,
              '\u8bfb\u51fa\u4e0d\u662f CRLF\uff0c\u4e0e .gitattributes \u4e0d\u7b26')
        check('\u5f52\u4e00\u5316\u540e\u4e0d\u542b \\r', '\r' not in txt)
        with open(ps1, 'rb') as f:
            raw = f.read()
        rt = (txt.replace('\n', '\r\n') if crlf else txt).encode('utf-8')
        check('CRLF \u5f80\u8fd4\u65e0\u635f', rt == raw,
              '\u5f52\u4e00\u5316\u518d\u5199\u56de\u5f97\u5230\u7684\u5b57\u8282\u4e0e\u539f\u6587\u4e0d\u540c')
    else:
        print('   skip  dump_tree.ps1 \u4e0d\u5728\u76d8\u4e0a')

    # --- 搬家后根定位 ------------------------------------------------------
    # 这两条是本轮存在的理由之一：搬走就静默失准。
    # ⚠ 按「这条 edit 改的是不是 ROOT 定义」来认，不能按文件名认：同一个文件
    # 现在有两条 edit（另一条改 TOP_ALLOW 白名单），按文件名会把不相干的那条
    # 也拖来检查 server.js 锚点，凭空报红。
    root_edits = [e for e in EDITS if e['old'].lstrip().startswith(('ROOT =', 'const ROOT ='))]
    check('\u627e\u5f97\u5230\u4e24\u6761 ROOT \u5b9a\u4f4d\u6539\u52a8', len(root_edits) == 2,
          '\u5b9e\u9645 %d \u6761' % len(root_edits))
    for e in root_edits:
        who = '\u91c7\u96c6\u5668' if e['file'].endswith('.py') else '\u63a2\u9488'
        check('%s\u65b0 ROOT \u4e0d\u518d\u6570\u5c42\u6570' % who,
              'dirname(os.path.dirname' not in e['new'] and "'..'" not in e['new'])
        check('%s\u65b0 ROOT \u4ee5 server.js \u4e3a\u951a\u70b9' % who, 'server.js' in e['new'])

    # --- 搬家表不得自相覆盖 ------------------------------------------------
    dsts = [d for _, d in FILE_MOVES] + [d for _, d in DIR_MOVES]
    check('\u642c\u5bb6\u76ee\u7684\u5730\u65e0\u91cd\u590d', len(dsts) == len(set(dsts)))

    print('=' * 66)
    print('   %d \u9879\u901a\u8fc7\uff0c%d \u9879\u5931\u8d25' % (ok, fail))
    return 1 if fail else 0


# ---------------------------------------------------------------- 回滚

def restore():
    print(BANNER)
    print('\u6a21\u5f0f\uff1aRESTORE\uff08\u56de\u6eda\u672c\u8865\u4e01\uff09')
    print('=' * 66)
    man = load_manifest()
    if not man:
        raise SystemExit('\u274c \u627e\u4e0d\u5230 %s\uff0c\u65e0\u6cd5\u56de\u6eda' % MANIFEST)

    n = 0
    # 1) 先还原被编辑的文件
    for rel in man.get('edited', []):
        fp, bp = p(rel), bak_path(rel)
        if os.path.exists(bp):
            shutil.move(bp, fp)
            print('   \u8fd8\u539f  %s' % rel)
            n += 1
    # 备份目录还原完就该空了；空了才删，非空说明有东西没还原成功，留着给人看。
    bd = p(BAK_DIR)
    if os.path.isdir(bd) and not os.listdir(bd):
        os.rmdir(bd)
    # 2) 删掉新建的文件
    for rel in man.get('created', []):
        fp = p(rel)
        if os.path.exists(fp):
            os.remove(fp)
            print('   \u5220\u9664  %s' % rel)
            n += 1
    # 3) 搬回去
    for src, dst in reversed(man.get('file_moves', [])):
        s, d = p(src), p(dst)
        if os.path.exists(d):
            os.makedirs(os.path.dirname(s) or ROOT, exist_ok=True)
            shutil.move(d, s)
            print('   \u642c\u56de  %s <- %s' % (src, dst))
            n += 1
    # ⚠ 归档物必须在 dir_moves 之前搬回。归档落点是 cache/patch-backup/r12c-batch12/，
    # 而 dir_moves 的回滚会把整个 cache/patch-backup/ 搬回 .patch-backup/ —— 一旦先跑
    # dir_moves，这里的 exists() 就为假，静默跳过、一声不吭，归档物再也回不了根目录。
    for src, dst in reversed(man.get('archived', [])):
        s, d = p(src), p(dst)
        if os.path.exists(d):
            shutil.move(d, s)
            print('   \u642c\u56de  %s <- %s' % (src, dst))
            n += 1
        else:
            # 不静默。回滚漏了东西必须喊出来。
            print('   \u26a0 \u627e\u4e0d\u5230\u5f52\u6863\u7269 %s\uff0c%s \u672a\u80fd\u642c\u56de' % (dst, src))
    ad = p('cache/patch-backup/r12c-batch12')
    if os.path.isdir(ad) and not os.listdir(ad):
        os.rmdir(ad)

    for src, dst in reversed(man.get('dir_moves', [])):
        s, d = p(src), p(dst)
        if os.path.isdir(d):
            shutil.move(d, s)
            print('   \u642c\u56de  %s/ <- %s/' % (src, dst))
            n += 1

    os.remove(p(MANIFEST))
    sm = man.get('self_move')
    print('=' * 66)
    print('   \u5df2\u56de\u6eda %d \u9879\uff0c\u5220\u9664 %s' % (n, MANIFEST))
    if sm:
        print('   \u6ce8\uff1a\u8865\u4e01\u672c\u4f53\u4ecd\u5728 %s\uff08\u6ca1\u642c\u56de\u6839\u76ee\u5f55\uff0c\u514d\u5f97\u53c8\u5f04\u810f\uff09\u3002'
              % sm[1].replace('/', os.sep))
    return 0


# ---------------------------------------------------------------- 主流程

def main():
    args = sys.argv[1:]
    if '--selftest' in args:
        return selftest()
    if '--restore' in args:
        return restore()

    write = '--write' in args
    archive = '--archive-batch12' in args

    print(BANNER)
    print('\u9879\u76ee\u6839\uff1a%s' % ROOT)
    print('\u6a21\u5f0f\uff1a%s' % ('WRITE\uff08\u771f\u6539\uff09' if write else 'DRY-RUN\uff08\u9884\u6f14\uff0c\u4e0d\u5199\u76d8\uff09'))
    print('=' * 66)

    if not os.path.exists(p('server.js')):
        raise SystemExit('\u274c \u8fd9\u91cc\u4e0d\u50cf\u9879\u76ee\u6839\uff08\u6ca1\u6709 server.js\uff09')

    moves, dirmoves, edits, creates, done = plan()

    # 归档清单（opt-in）
    arch = []
    if archive:
        for name in ARCHIVE_FILES:
            if os.path.exists(p(name)):
                arch.append((name, '%s/%s' % (ARCHIVE_TO, name)))
        for name in sorted(os.listdir(ROOT)):
            if name.startswith(ARCHIVE_GLOB_PREFIX) and name.endswith('.zip'):
                arch.append((name, '%s/%s' % (ARCHIVE_TO, name)))

    if done:
        print('\n== \u5df2\u7ecf\u662f\u76ee\u6807\u72b6\u6001\uff0c\u8df3\u8fc7 ==')
        for d in done:
            print('   %s' % d)

    print('\n== \u642c\u5bb6\uff08\u6587\u4ef6\uff09==')
    for s, d in moves:
        print('   %-34s -> %s' % (s, d))
    if not moves:
        print('   \uff08\u65e0\uff09')

    print('\n== \u642c\u5bb6\uff08\u76ee\u5f55\uff09==')
    for s, d in dirmoves:
        print('   %-34s -> %s' % (s + '/', d + '/'))
    if not dirmoves:
        print('   \uff08\u65e0\uff09')

    print('\n== \u6539\u52a8 ==')
    for e in edits:
        print('   %s' % e['file'])
    if not edits:
        print('   \uff08\u65e0\uff09')

    print('\n== \u65b0\u5efa ==')
    for rel, _ in creates:
        print('   %s' % rel)
    if not creates:
        print('   \uff08\u65e0\uff09')

    print('\n== \u5f52\u6863 batch12 \u6b8b\u7559\u7269 ==')
    if not archive:
        print('   \uff08\u672a\u5f00\u542f\uff09\u52a0 --archive-batch12 \u624d\u52a8\u3002\u5b83\u4eec\u662f batch12 --restore \u7684\u4f9d\u636e\uff0c')
        print('   \u786e\u8ba4\u4e0d\u518d\u56de\u6eda\u518d\u5f52\u6863\uff1a')
        for name in ARCHIVE_FILES:
            if os.path.exists(p(name)):
                print('       %s' % name)
        for name in sorted(os.listdir(ROOT)):
            if name.startswith(ARCHIVE_GLOB_PREFIX) and name.endswith('.zip'):
                print('       %s' % name)
    else:
        for s, d in arch:
            print('   %-46s -> %s' % (s, d))
        if not arch:
            print('   \uff08\u65e0\uff09')

    if not write:
        print('\n' + '=' * 66)
        print('   \u4ee5\u4e0a\u662f\u9884\u6f14\u3002\u786e\u8ba4\u65e0\u8bef\u540e\u52a0 --write')
        print('=' * 66)
        return 0

    # ---------------- 真改 ----------------
    man = {'file_moves': [], 'dir_moves': [], 'edited': [], 'created': [], 'archived': []}

    for s, d in moves:
        os.makedirs(os.path.dirname(p(d)), exist_ok=True)
        shutil.move(p(s), p(d))
        man['file_moves'].append([s, d])
        print('   \u642c  %s -> %s' % (s, d))

    for s, d in dirmoves:
        os.makedirs(os.path.dirname(p(d)), exist_ok=True)
        if os.path.isdir(p(d)):
            # 目的地已存在：逐项并入，不覆盖已有内容
            for item in os.listdir(p(s)):
                tgt = os.path.join(p(d), item)
                if not os.path.exists(tgt):
                    shutil.move(os.path.join(p(s), item), tgt)
            shutil.rmtree(p(s), ignore_errors=True)
            print('   \u5e76  %s/ -> %s/\uff08\u76ee\u7684\u5730\u5df2\u5b58\u5728\uff0c\u5df2\u9010\u9879\u5e76\u5165\uff09' % (s, d))
        else:
            shutil.move(p(s), p(d))
            print('   \u642c  %s/ -> %s/' % (s, d))
        man['dir_moves'].append([s, d])

    os.makedirs(p(BAK_DIR), exist_ok=True)
    # ⚠ 一个文件可能有多条 edit（采集器就有两条）。备份只能在第一次改之前做，
    # 否则第二条会把备份覆盖成「已经改过一次」的版本，--restore 永远回不到原始态，
    # 而且回滚看上去是成功的 —— 又一个不报错的静默失效。
    backed_up = set()
    for e in edits:
        fp = p(e['file'])
        txt, crlf = read_text(fp)
        if e['file'] not in backed_up:
            shutil.copy2(fp, bak_path(e['file']))
            backed_up.add(e['file'])
            man['edited'].append(e['file'])
        write_text(fp, txt.replace(e['old'], e['new'], 1), crlf)
        print('   \u6539  %s' % e['file'])

    for rel, body in creates:
        fp = p(rel)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        write_text(fp, body, False)
        man['created'].append(rel)
        print('   \u65b0  %s' % rel)

    for s, d in arch:
        os.makedirs(os.path.dirname(p(d)), exist_ok=True)
        shutil.move(p(s), p(d))
        man['archived'].append([s, d])
        print('   \u5f52  %s -> %s' % (s, d))

    # 最后搬自己。放在写 manifest 之前，好让 self_move 也记进去。
    self_abs = os.path.abspath(__file__)
    self_name = os.path.basename(self_abs)
    self_rel_now = os.path.relpath(self_abs, ROOT).replace(os.sep, '/')
    self_dst_rel = '%s/%s' % (SELF_DST, self_name)
    if self_rel_now == self_name:  # 只有当它确实还在项目根时才搬
        os.makedirs(p(SELF_DST), exist_ok=True)
        shutil.move(self_abs, p(self_dst_rel))
        man['self_move'] = [self_rel_now, self_dst_rel]
        print('   \u642c  %s -> %s\uff08\u8865\u4e01\u672c\u4f53\uff0c\u6839\u76ee\u5f55\u4e0d\u7559\u52a9\u624b\u4ea7\u7269\uff09'
              % (self_rel_now, self_dst_rel))
        restore_cmd = 'python tools\\dev\\%s --restore' % self_name
    else:
        restore_cmd = 'python %s --restore' % self_rel_now.replace('/', os.sep)

    with open(p(MANIFEST), 'wb') as f:
        f.write(json.dumps(man, ensure_ascii=False, indent=1).encode('utf-8'))

    print('\n' + '=' * 66)
    print('   \u5b8c\u6210\u3002\u56de\u6eda\uff1a%s' % restore_cmd)
    print('   \u4e0b\u4e00\u6b65\uff1anode tools\\run_tests.cjs')
    print('=' * 66)
    return 0


if __name__ == '__main__':
    sys.exit(main())
