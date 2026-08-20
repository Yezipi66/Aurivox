#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
apply-r12c-batch14   [2026-08-20]  根目录收口（Batch 4 续）

本轮做什么
  A. 归档三棵死树到 ..\\junk\\ —— 判据不是大小，是内容：
     2026-08-20 的源码采集在这三棵树里只捞到 13 个文件，全是 HuggingFace
     缓存元数据 / userdict.md5 / 空 build 目录，**一行活代码都没有**。
     全仓 grep 确认无任何活代码 require/import 它们。
  B. 顶层 GPT_SoVITS\\ **有条件**归档：脚本自己扫，扫到 .py/.js 就不动并如实报告。
     （.gitignore:135 把它整棵 ignore，源码包里零文件**不能**当成"盘上没源码"）
  C. .gitignore 收口 6 条陈旧/空操作规则（D19 双向查，见下方注释）
  D. 根目录守卫从「猜坏名字的形状」改成 **反向白名单**：
     准入表写进 docs/ROOT_LAYOUT.md，守卫解析它，表上没有的一律红。
  E. 把 SCOPE_r12c.md 收进仓库（docs/），并回写它与现状的三处偏差

本轮不做
  - 不搬 tools\\runtime\\{python,node} → vendor\\（19+ 处 .bat/.ps1 引用，
    且在启动链上，单独一批，见 docs/SCOPE_r12c.md §3 Batch 5）
  - 不动 models\\ data\\ assets\\ dist\\ .hermes\\
  - 不修 tools/checks/check_*.py 里那批陈旧的 gsv-tools 路径（已在 SCOPE 登记）

用法
  python apply-r12c-batch14.py                 预演（默认，不写盘）
  python apply-r12c-batch14.py --selftest      自检（含反证）
  python apply-r12c-batch14.py --write         真改
  python apply-r12c-batch14.py --restore       回滚
"""

import json
import os
import shutil
import sys

BANNER = 'apply-r12c-batch14   [2026-08-20]  根目录收口'

# 备份与 manifest 都不落项目根 —— 本轮新守卫的准入表里没有它们，
# 落在根上补丁会当场触红自己立的规矩（batch13 踩过一次，见 tools/dev/README.md）。
WORK_DIR = 'cache/patch-backup/r12c-batch14'
MANIFEST_REL = WORK_DIR + '/manifest.json'


def _find_project_root(start):
    """上溯找 server.js 定位项目根（C7）。绝不数目录层数。

    本脚本跑完会把自己搬进 tools/dev/，之后 --restore 是从那里跑的。
    锚点用 server.js 不用 package.json：node_modules 里遍地是后者。
    """
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, 'server.js')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit(
                '找不到项目根：从 %s 一路上溯都没看见 server.js。'
                % os.path.abspath(start))
        d = parent


ROOT = _find_project_root(os.path.dirname(os.path.abspath(__file__)))
SELF_DST = 'tools/dev'

# ---------------------------------------------------------------- 归档表
#
# 落点在**项目之外**（与项目根同级的 junk\），沿用 Owner 处理顶层 GPT_SoVITS\
# 时的办法：不用 rmdir /s /q，判据还能回来。

JUNK_DIR = os.path.join(os.path.dirname(ROOT), 'junk', 'r12c-batch14')

# (相对项目根的目录, 归档理由)
ARCHIVE_DIRS = [
    ('vendor/gsv-tools',
     '2.9GB。主体 model.bin 在 models/asr/faster-whisper/large-v3/ 有确认副本；'
     '2026-08-20 采集只从整棵树里捞到 HF 缓存元数据，无活代码'),
    ('vendor/gsv_code',
     '920MB。744MB 孤儿 .pth 已证实是训练中断的截断文件；4 个词典已回迁'
     ' engines/gpt-sovits/gsv_code/text/；残留只剩 text/ja_userdic/userdict.md5'),
    ('vendor/gsv-infer',
     '584KB。CUDA 编译残留（BigVGAN/alias_free_activation/cuda/build/ 空目录），'
     '活的 BigVGAN 在 engines/gpt-sovits/infer/BigVGAN/'),
]

# 有条件归档：扫到源码就不动。GPT_SoVITS/ 被 .gitignore:135 整棵 ignore，
# 「源码包里零文件」只说明它不进包，**不说明盘上没有 .py**。
CONDITIONAL_ARCHIVE = [
    ('GPT_SoVITS',
     ('.py', '.js', '.jsx', '.cjs', '.mjs', '.ts'),
     'r12a 之前的历史遗留权重树（G2PWModel 等）。'
     '只有扫不到任何源码文件时才归档'),
]

# ---------------------------------------------------------------- 搬家表

FILE_MOVES = [
    # batch13 的回滚材料。Owner 已在真机验收 batch13（独立测试 + 前端人工测试，
    # 微调与推理均正常），不再需要从根目录回滚 —— 归档而不是删除。
    ('.r12c-batch13-manifest.json',
     'cache/patch-backup/r12c-batch13/.r12c-batch13-manifest.json'),
]

# ---------------------------------------------------------------- 改动表

GITIGNORE_OLD = """# vendored runtime / models / third-party
GPT_SoVITS/
# vendor/ holds third-party SOURCE, which is tracked. Ignore everything
# under it by default and re-admit the trees we vendor deliberately, so a
# new binary payload cannot slip in unnoticed.
/vendor/*
!/pipeline/uvr5/
!/pipeline/asr/
!/pipeline/slicer/
!/vendor/tts/
!/vendor/gsv-tools/
tools/runtime/
# Weights that stay put in this round. gsv-tools/ now holds nothing but
# these; r12b moves them to models/ and the directory disappears.
vendor/gsv-tools/asr/models/
vendor/gsv-tools/asr/faster-whisper-*/
vendor/gsv-tools/uvr5/uvr5_weights/
pipeline/uvr5/uvr5_weights/
"""

GITIGNORE_NEW = """# vendored runtime / models / third-party
#
# r12c batch14 收口。改这一段必须**双向**验（D19）：
#   删排除行 -> 大块二进制可能泄漏进 git（一进历史 git rm 也删不掉）
#   删例外行 -> 新代码整片被忽略，提交上去是空的
# 验收只看 `git status --short`（语义唯一），不看 `git check-ignore -v`
# （-v 命中任何规则都打印，含 ! 反向规则，读起来像失败其实是成功）。
#
# GPT_SoVITS/ ：顶层那棵历史遗留权重树已于 batch14 移出项目。
# 规则**刻意保留** —— 万一哪个脚本把权重重新下回原位，它必须仍然进不了 git。
# 「规则在、目录不在」在这里是有意为之，不是陈旧行。
GPT_SoVITS/
# vendor/ 现在只放第三方成品（ffmpeg / micromamba），整棵不进 git。
# batch14 删掉的 5 条：
#   !/vendor/tts/          -> 已搬去 engines/gpt-sovits/（batch12）
#   !/vendor/gsv-tools/    -> 已归档 ..\\junk\\（batch14）
#   !/pipeline/uvr5/ !/pipeline/asr/ !/pipeline/slicer/
#                          -> **空操作**：这三条是为抵消 /vendor/* 写的，
#                             可 pipeline/ 不被任何规则排除，搬家后一直没有作用。
#                             留着会让人以为 pipeline/ 需要靠例外才进 git。
/vendor/*
tools/runtime/
# gsv-tools/ 整棵已归档，它下面那三条权重排除行随之删除。
# pipeline/uvr5/uvr5_weights/ 是活的（uvr5 仍在用），保留。
pipeline/uvr5/uvr5_weights/
"""

GUARD_OLD = """// 助手产出物的形状。它们归 tools/dev/。
const ASSISTANT_ARTIFACT = [
  { re: /^apply-.*\\.py$/, why: '补丁脚本归 tools/dev/' },
  { re: /^probe_.*\\.(cjs|js|py)$/, why: '探针归 tools/dev/' },
  { re: /^collect_.*\\.py$/, why: '采集器归 tools/dev/' },
  { re: /^sources_.*\\.zip$/, why: '源码快照不得留在根目录' },
]

test('根目录不得再落助手产出物（补丁 / 探针 / 采集器 / 快照）', () => {
  const offenders = []
  for (const name of fs.readdirSync(ROOT)) {
    for (const rule of ASSISTANT_ARTIFACT) {
      if (rule.re.test(name)) offenders.push(`${name}（${rule.why}）`)
    }
  }
  assert.deepEqual(offenders, [],
    `项目根发现助手产出物：${offenders.join('、')} —— ` +
    '这些不是产品的一部分，归 tools/dev/（见 tools/dev/README.md）')
})
"""

GUARD_NEW = """// ---------------------------------------------------------------------------
//  准入表 = docs/ROOT_LAYOUT.md，不是这个文件
// ---------------------------------------------------------------------------
// batch13 的第一版守卫是**反过来**写的：列出坏名字的形状
// （apply-* / probe_* / collect_* / sources_*.zip）去抓。
// 2026-08-20 当场失效一次 —— 助手换了个 precheck_ 前缀，守卫一声没响，
// 读数仍是「助手产出物：无 ✅」。**按坏名字认目标 = 只抓我想得到的那几种。**
//
// 改成反向白名单：根目录只允许出现准入表里登记过的条目，多出来的一律红。
// 准入表写在 docs/ROOT_LAYOUT.md（一张 Markdown 表），因为它要给人读；
// 这里只负责解析它。**新增根目录条目的唯一途径是去那张表里登记并写明理由。**

const LAYOUT_DOC = path.join(ROOT, 'docs', 'ROOT_LAYOUT.md')

function parseRootLayout(md) {
  // | `名字` | 类型 | 归属 / 判据 | 必须存在 |
  const rows = []
  for (const line of md.split(/\\r?\\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    const m = cells[1].match(/^`([^`]+)`$/)
    if (!m) continue
    rows.push({ name: m[1], kind: cells[2], why: cells[3], must: cells[4] === '是' })
  }
  return rows
}

test('根目录准入表本身可解析（防守卫恒真）', () => {
  assert.ok(fs.existsSync(LAYOUT_DOC),
    'docs/ROOT_LAYOUT.md 不在盘上 —— 准入表没了，下面那条守卫会变成恒真')
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  assert.ok(rows.length >= 20,
    `准入表只解析出 ${rows.length} 条 —— 表格写法多半变了，` +
    '解析不到会让「根目录很干净」和「根本没检查」读数相同')
  for (const anchor of ['server.js', 'lib', 'engines', 'package.json']) {
    assert.ok(rows.some((r) => r.name === anchor),
      `准入表里没有 ${anchor} —— 解析结果不可信`)
  }
})

test('根目录只允许出现准入表登记过的条目', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const allowed = new Set(rows.map((r) => r.name))
  const offenders = fs.readdirSync(ROOT).filter((n) => !allowed.has(n))
  assert.deepEqual(offenders, [],
    `项目根出现未登记条目：${offenders.join('、')} —— ` +
    '要么把它放到该去的地方（助手产出物归 tools/dev/、缓存归 cache/），' +
    '要么去 docs/ROOT_LAYOUT.md 登记并写明「它是什么、丢了会怎样」。' +
    '不写理由的登记等于没有规则')
})

test('准入表里标了「必须存在」的条目必须真在盘上（防表烂掉）', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const missing = rows.filter((r) => r.must && !fs.existsSync(path.join(ROOT, r.name)))
  assert.deepEqual(missing.map((r) => r.name), [],
    '准入表登记了但盘上没有的条目 —— 清单腐烂成「加进去就不红」的垃圾场了')
})
"""

EDITS = [
    {'file': '.gitignore', 'old': GITIGNORE_OLD, 'new': GITIGNORE_NEW},
    {'file': 'lib/root_layout.node.test.js', 'old': GUARD_OLD, 'new': GUARD_NEW},
]

# ---------------------------------------------------------------- 新建文件

ROOT_LAYOUT_MD = """# 根目录准入表

> 权威。`lib/root_layout.node.test.js` 直接解析本文件的表格。
> **根目录只允许出现下表登记过的条目**，多一个就红。

## 为什么是反向白名单

batch13 的第一版守卫列的是**坏名字的形状**（`apply-*` / `probe_*` /
`collect_*` / `sources_*.zip`）。2026-08-20 当场失效一次：助手换了个
`precheck_` 前缀扔进根目录，守卫一声没响，读数仍是「助手产出物：无 ✅」。

**按坏名字认目标 = 只抓我想得到的那几种。**「没检查」和「检查过且干净」
读数相同，是本项目反复付学费的同一种缺陷。

## 表

| 条目 | 类型 | 归属 / 判据（丢了会怎样） | 必须存在 |
|---|---|---|---|
| `server.js` | 文件 | 我们的服务端入口。也是全项目定位项目根的锚点（C7） | 是 |
| `package.json` | 文件 | 依赖与脚本定义 | 是 |
| `package-lock.json` | 文件 | 锁定版本，必须与 package.json 同进退 | 是 |
| `README.md` | 文件 | 项目说明 | 是 |
| `LICENSE` | 文件 | 我们的许可证（MIT） | 是 |
| `NOTICE` | 文件 | 第三方归属声明，合规义务 | 是 |
| `requirements.txt` | 文件 | Python 依赖（torch 三行刻意注释掉，见头部说明） | 是 |
| `start.bat` | 文件 | 启动器 | 是 |
| `stop.bat` | 文件 | 停止器 | 是 |
| `deploy.bat` | 文件 | 部署入口 | 是 |
| `.env.example` | 文件 | 环境变量样例；真 `.env` 不进 git | 是 |
| `.gitattributes` | 文件 | 换行符规则（`*.ps1`/`*.bat` = CRLF），改错会让整份文件在 diff 里变红 | 是 |
| `.gitignore` | 文件 | 哪些东西不进 git。改它必须双向验（D19） | 是 |
| `lib` | 目录 | 我们的服务端代码。上游根本不知道它存在 | 是 |
| `web` | 目录 | 我们的前端 | 是 |
| `engines` | 目录 | 能选的 TTS 引擎，一个目录一个引擎；**换引擎时跟着换** | 是 |
| `pipeline` | 目录 | 打标 / 分离 / 切片，所有引擎共用；换引擎时不换 | 是 |
| `tools` | 目录 | 构建 / 部署 / 检查 / 开发脚本（助手产出物归 `tools/dev/`） | 是 |
| `docs` | 目录 | 契约与决策记录。本文件也在这里 | 是 |
| `data` | 目录 | 用户的东西：改过、删了要不回来 | 是 |
| `vendor` | 目录 | 第三方**成品**（ffmpeg / micromamba）：原封不动就能跑，我们没改过一行 | 否 |
| `models` | 目录 | 全部权重。二进制、能重新下载、不进 git | 否 |
| `assets` | 目录 | 用户音频资产根（`lib/paths.js` 的 `ASSETS_ROOT`，可被环境变量改到别处） | 否 |
| `.staging` | 目录 | 与 `assets` 同盘的原子暂存（`STAGING_ROOT`），保证 rename 不跨盘 | 否 |
| `cache` | 目录 | 全部可再生缓存（`lib/paths.js` 的 `CACHE_DIR`）。补丁备份也归这里 | 否 |
| `outputs` | 目录 | 合成产物 | 否 |
| `logs` | 目录 | 运行日志 | 否 |
| `dist` | 目录 | `tools/build/04_pack_release.py` 的发行产物 | 否 |
| `node_modules` | 目录 | npm 依赖，可重装 | 否 |
| `venv` | 目录 | Python 虚拟环境，可重建 | 否 |
| `THIRD_PARTY_LICENSES` | 目录 | 第三方许可证正文，合规义务 | 否 |
| `.git` | 目录 | git 自己 | 否 |
| `.hermes` | 目录 | 已 ignore；`docs/SCOPE_r12c.md` §3 Batch 5 决定它是迁 `cache/hermes/` 还是留 | 否 |

## 改这张表的规矩

1. **先问「它是什么、丢了会怎样」**，答不上来就说明它不该在根目录。
2. 助手产出物（补丁 / 探针 / 采集器 / 源码快照）**永远不登记**，一律 `tools/dev/`。
3. 缓存**永远不登记**，一律走 `lib/paths.js` 的 `CACHE_DIR`。
4. 登记必须写理由。没有理由的豁免等于没有规则 —— 清单会腐烂成
   「加进去就不红」的垃圾场。
"""

SCOPE_MD = """# SCOPE — 目录重整（r12c）

> 版本：**v2 / 2026-08-20**（v1 = 2026-08-19）
> 项目：aurivox@1.0.8 / `D:\\Project\\tts_broker_openai_compat` / 分支 `dev`
> 用途：**防漂移锚点**。任何一步动手之前先回来对一次；本文档没写的事情，这一轮就不做。

## v2 改了什么（先说偏差，别让锚点自己漂）

v1 是文档、实施是补丁，两边在 batch12 之后分了家。三处已回写：

1. **§3 的 Batch 1 / Batch 2 分章作废** —— Owner 2026-08-19 决定「和 batch2 合成一轮」，
   实际交付的 `apply-r12c-batch12.py` 就是合并后的。v1 一直是合并前的写法。
2. **§4.B 里 `tools\\runtime\\{python,node}` → `vendor\\` 本轮不做，挪到 Batch 5**。
   助手在 batch12 的补丁头部单方面写了「不做」，**但从没回到本文档、也没告知 Owner** ——
   于是「完成判据 2」永远不可能成立，而这份文档的用途正是防漂移。
   **纪律：补丁头部的「本轮不做」清单必须同步回写 SCOPE，写在补丁注释里不算告知。**
3. **完成判据 1 改写**。v1 写死「396 pass」，实际搬家后测试总数变成 408 → 412，
   因为 `run_tests.cjs` 新收了 `engines/`、`pipeline/` 两棵树，batch13 又加了 4 条守卫。
   **「测试数应为某个常数」正是本项目明令禁止的判据形态**（判据不能随磁盘状态漂移）。

## 1. TARGET（终局目标）

> **兼容一切 TTS 的 flow。**

可验收的形式：

> **加一个新引擎 = 新建 `engines\\<id>\\` 一个目录 + 写一个 `manifest.json`。
> `lib\\`、`server.js`、`web\\` 一个字都不用改。**

反面表述（任何一条成立即未达标）：

- 加引擎需要改 `server.js`
- 加引擎需要改 `lib\\flowgraph\\adapter.js`
- 加引擎需要改 `lib\\training\\` 下任何文件
- 加引擎需要在 `web\\` 里加分支
- 加引擎的人需要读 `pipeline\\` 下的代码才知道怎么打标 / 切片

## 2. 不变量：顶层目录的定义

**这一节是判据，不是现状描述。** 现状与本节冲突时，改现状。

| 目录 | 一句话定义 | 判据 |
|---|---|---|
| `engines\\` | 能选的 TTS 引擎，一个目录一个引擎 | 换引擎时**跟着换** |
| `pipeline\\` | 打标 / 分离 / 切片，所有引擎共用 | 换引擎时**不换**，但属于第三方代码 |
| `models\\` | 全部权重 | 是二进制权重；能重新下载 |
| `vendor\\` | 第三方**成品** | 下下来原封不动就能跑，我们**没改过一行** |
| `data\\` | **用户的东西** | 用户编辑过；删了要不回来 |
| `lib\\` `server.js` `web\\` | 我们自己的服务端与界面 | 上游根本不知道它存在 |

辅助判据：

1. **`LOCAL-CHANGES.md` 的有无** = 「我们改过上游」的物证 → 有则不是 `vendor\\`
2. **能否一键重新下载** → 能则 `vendor\\` / `models\\`；不能则 `data\\`
3. **`engines\\` 下的目录数 = 支持的引擎数**（工具类放进去会毁掉这个性质）

⭐ **v2 补一条**：上表只定义了 6 类共 7 个顶层目录，而根目录实际有 20+ 个条目。
其余条目（`assets` `cache` `docs` `tools` `dist` `logs` `outputs` `node_modules`
`venv` `THIRD_PARTY_LICENSES` `.git` `.hermes` `.staging`）**过去一条判据都没有** ——
谁往根上放个新目录都不会有任何东西报警。batch14 起，完整准入表在
**`docs/ROOT_LAYOUT.md`**，由 `lib/root_layout.node.test.js` 解析并强制。

## 3. 批次

| 批 | 内容 | 状态 |
|---|---|---|
| Batch 0 | 词典回迁 / C7 收口 / 配置写回 / 根 `GPT_SoVITS\\` 移出 | ✅ 完成 |
| Batch 1+2（合并交付 = `apply-r12c-batch12.py`） | 搬家（`vendor\\{tts,asr,uvr5,slicer}` → `engines\\`+`pipeline\\`）、`lib\\paths.js` 路径权威、引擎注册表、`manifest.json`、11 条守卫 | ✅ 真机已应用 |
| Batch 3 | 用 IndexTTS2 验证契约：只新建 `engines\\indextts2\\` + 写 manifest | ⬜ 未开工（目录在，刻意只有 `README.md`+`setup.bat`，无 manifest ⇒ 注册表看不见它 ⇒ 表现为「没装」） |
| Batch 4（`apply-r12c-batch13.py` + `apply-r12c-batch14.py`） | 根目录收尾：缓存归 `cache\\`、助手产出物归 `tools\\dev\\`、死树归档、准入表 + 反向白名单守卫 | 🔄 batch13 ✅ / batch14 本轮 |
| **Batch 5（新增）** | `tools\\runtime\\{python,node}` → `vendor\\`（19+ 处 `.bat`/`.ps1` 引用，在启动链上）；`.hermes\\` 去留；`tools/checks/check_*.py` 里那批陈旧 `gsv-tools` 路径 | ⬜ 未开工 |

## 4. Batch 4（batch14 本轮）做什么

**A. 归档三棵死树到 `..\\junk\\`**（不是 `rmdir /s /q`，判据还能回来）

| 目录 | 大小 | 放行依据（**内容判据，不只是大小**） |
|---|---|---|
| `vendor\\gsv-tools\\` | 2.9GB | 主体 `model.bin` 在 `models\\asr\\faster-whisper\\large-v3\\` 有确认副本；2026-08-20 全树采集只捞到 HF 缓存元数据 |
| `vendor\\gsv_code\\` | 920MB | 744MB 孤儿 `.pth` 已证实是训练中断的截断文件；4 个词典已回迁 `engines\\gpt-sovits\\gsv_code\\text\\`。⚠ 它与活着的 `engines\\gpt-sovits\\gsv_code\\` **同名**：全树 106 处 `from gsv_code...` 靠 `infer_server.py:51` 的 `sys.path.insert(0, GSV_DIR)` 解析，vendor 那棵从不在 `sys.path` 上；但只要有人把 `vendor\\` 加进 path 就会导入错的那棵 —— 归档同时消掉这个遮蔽隐患 |
| `vendor\\gsv-infer\\` | 584KB | CUDA 编译残留（空 `build\\` 目录）；活的 BigVGAN 在 `engines\\gpt-sovits\\infer\\BigVGAN\\` |

全仓 grep 确认：**无任何活代码 require/import 这三棵树**（命中全在注释、
`LOCAL-CHANGES.md`、`04_pack_release.py` 的排除表里）。

**B. 顶层 `GPT_SoVITS\\` 有条件归档** —— 补丁自己扫，扫到 `.py`/`.js` 就不动并如实报告。
`.gitignore` 把它整棵 ignore，**「源码包里零文件」只说明它不进包，不说明盘上没源码**。

**C. `.gitignore` 收口 5 条**：2 条陈旧例外（`!/vendor/tts/`、`!/vendor/gsv-tools/`）
+ 3 条对 `pipeline/` 的**空操作**例外（它们是为抵消 `/vendor/*` 写的，可 `pipeline/`
不被任何规则排除，搬家后一直没有作用）。`GPT_SoVITS/` 那行**刻意保留**：
规则在、目录不在，是为了防止权重被重新下回原位后进 git。

**D. 根目录守卫改反向白名单**（见 `docs/ROOT_LAYOUT.md`）。

## 5. 完成判据

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 测试**总数不低于上一轮**，且 `fail = 0`，且 `engines\\`+`pipeline\\` 下的测试文件数与搬走的数量对得上 | `node tools\\run_tests.cjs`。⛔**不写死常数** —— 判据不能随磁盘状态漂移 |
| 2 | `vendor\\` 下只剩 `ffmpeg` `micromamba`（`python`/`node` 见 Batch 5） | `dir /b vendor` |
| 3 | `engines\\` 下只有 `gpt-sovits` `indextts2` `_TEMPLATE` | `dir /b engines` |
| 4 | 全仓 grep 不到活代码引用 `vendor/tts`、`vendor/asr`、`vendor/uvr5`、`vendor/slicer` | 注释与文档里的命中不算 |
| 5 | **真机能起服务、能合成一段音频** | ⭐ **这条是第一道判据，不是最后一道**。搬家改的正是运行时才解析的东西；`lib\\inference\\infer_server.py` 不在任何 JS 测试覆盖面内，曾表现为「407 测试全绿但服务起不来」 |
| 6 | 根目录无未登记条目 | `node tools\\run_tests.cjs` 里的根布局守卫（准入表 = `docs/ROOT_LAYOUT.md`） |

## 6. 纪律（沿用，不因本轮放宽）

- 判据**不能随磁盘状态漂移**（「文件数应为 480」「测试数应为 396」都不是判据）
- 验证基线是**Owner 那棵树**；助手沙箱里的复刻件**不是判据**
- 「通过」和「根本没运行」长得一样的测试等于没测
- 探针必须带**反例守卫**（先证明它会失败）+ 正对照
- 代码改动一律走 `apply-*.py`：默认 dry-run / `--write` 留备份 / `--restore` / `--selftest`
- 给 Owner 的命令**不带尾部注释**（`cmd.exe` 会把 `#` 当参数）
- 提目录一律写**全路径**
"""

TABLE_END = '\n## 改这张表的规矩\n'


def render_layout_doc(skipped):
    """有条件归档若被放弃，就把留下来的条目**临时登记**进准入表。

    否则补丁会把树留在「守卫必红」的状态：GPT_SoVITS\\ 还在根上、表里没有它。
    临时登记写明「为什么没搬走 + 谁该来处理」，让欠账留在文档里可见，
    而不是让守卫一直红到没人再看它 —— 长期红的守卫等于没有守卫。
    """
    if not skipped:
        return ROOT_LAYOUT_MD
    rows = ''
    for rel, hits in skipped:
        rows += ('| `%s` | 目录 | ⚠ **临时登记（batch14 未能归档）**：本想移出项目，'
                 '但扫到 %d 个源码文件（如 `%s`），不是纯权重树，补丁不敢动。'
                 '需人工判断后另开一轮 | 否 |\n'
                 % (rel, len(hits), hits[0]))
    return ROOT_LAYOUT_MD.replace(TABLE_END, rows + TABLE_END, 1)


# ---------------------------------------------------------------- 工具

def p(rel):
    return os.path.join(ROOT, rel.replace('/', os.sep))


def read_text(path):
    """读文本并**归一化成 \\n 返回**，同时把原始换行风格带回去。

    CRLF 文件会让锚点静默失配（锚点里没有 \\r → count() 返回 0 →
    报「文件与预期不符」）。只在写回时还原。
    """
    with open(path, 'rb') as f:
        raw = f.read()
    bom = raw.startswith(b'\xef\xbb\xbf')
    if bom:
        raw = raw[3:]
    crlf = raw.count(b'\r\n')
    lf = raw.count(b'\n') - crlf
    style = 'crlf' if crlf > lf else 'lf'
    return raw.decode('utf-8').replace('\r\n', '\n'), (style, bom)


def write_text(path, text, meta):
    style, bom = meta
    data = text.replace('\r\n', '\n')
    if style == 'crlf':
        data = data.replace('\n', '\r\n')
    raw = data.encode('utf-8')
    if bom:
        raw = b'\xef\xbb\xbf' + raw
    with open(path, 'wb') as f:
        f.write(raw)


def scan_source_files(root_dir, exts):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d != '__pycache__']
        for fn in filenames:
            if fn.lower().endswith(tuple(e.lower() for e in exts)):
                hits.append(os.path.relpath(os.path.join(dirpath, fn), root_dir))
                if len(hits) >= 50:
                    return hits
    return hits


def plan():
    """算出这一轮要做什么。任何锚点对不上都在这里就退出，绝不半做半不做。"""
    archives, conds, moves, edits, creates, done, skipped = [], [], [], [], [], [], []

    for rel, why in ARCHIVE_DIRS:
        src = p(rel)
        if os.path.isdir(src):
            archives.append((rel, why))
        else:
            done.append('archive %s（已不在盘上）' % rel)

    for rel, exts, why in CONDITIONAL_ARCHIVE:
        src = p(rel)
        if not os.path.isdir(src):
            done.append('archive %s（已不在盘上）' % rel)
            continue
        hits = scan_source_files(src, exts)
        if hits:
            skipped.append((rel, hits))
        else:
            conds.append((rel, why))

    for src, dst in FILE_MOVES:
        if os.path.exists(p(src)):
            moves.append((src, dst))
        elif os.path.exists(p(dst)):
            done.append('move %s（已在目的地）' % src)
        else:
            done.append('move %s（源与目的地都不在，跳过）' % src)

    for e in EDITS:
        fp = p(e['file'])
        if not os.path.exists(fp):
            raise SystemExit('❌ 找不到 %s' % e['file'])
        cur, _ = read_text(fp)
        n_old = cur.count(e['old'])
        n_new = cur.count(e['new'])
        if n_old == 1:
            edits.append(e)
        elif n_old == 0 and n_new >= 1:
            done.append('edit %s（已经是改后的样子）' % e['file'])
        else:
            raise SystemExit(
                '❌ %s 的锚点命中 %d 次（期望 1 次）。'
                '这个补丁只能跑在 apply-r12c-batch13 已应用的树上。' % (e['file'], n_old))

    creates_spec = [
        ('docs/ROOT_LAYOUT.md', render_layout_doc(skipped)),
        ('docs/SCOPE_r12c.md', SCOPE_MD),
    ]
    for rel, body in creates_spec:
        fp = p(rel)
        if os.path.exists(fp):
            cur, _ = read_text(fp)
            if cur == body:
                done.append('create %s（已存在且内容相同）' % rel)
                continue
            raise SystemExit('❌ %s 已存在且内容不同，不敢覆盖' % rel)
        creates.append((rel, body))

    return archives, conds, moves, edits, creates, done, skipped


# ---------------------------------------------------------------- 自检

def selftest():
    print(BANNER)
    print('自检（不写盘）')
    print('=' * 70)
    ok = fail = 0

    def check(name, cond, detail=''):
        nonlocal ok, fail
        if cond:
            ok += 1
            print('   ok    %s' % name)
        else:
            fail += 1
            print('   FAIL  %s  %s' % (name, detail))

    # --- EDITS 方向守卫（自伤 #17：batch12 里 old/new 整条写反）-------------
    OLD_ONLY = ['!/vendor/tts/', '!/vendor/gsv-tools/', '!/pipeline/uvr5/',
                'vendor/gsv-tools/asr/models/', 'ASSISTANT_ARTIFACT']
    NEW_ONLY = ['docs/ROOT_LAYOUT.md', 'parseRootLayout', 'ROOT_LAYOUT']
    bad = []
    for e in EDITS:
        for tok in NEW_ONLY:
            if tok in e['old'] and tok not in e['new']:
                bad.append('%s: 新内容 %s 出现在 old 里' % (e['file'], tok))
        for tok in OLD_ONLY:
            if tok in e['new'] and tok not in e['old']:
                bad.append('%s: 旧内容 %s 出现在 new 里' % (e['file'], tok))
    check('EDITS 方向守卫（old=旧 / new=新，不得反）', not bad, '; '.join(bad))

    # --- 同文件多条 edit：备份只做一次 + 锚点互不包含 -----------------------
    seen, dup = set(), set()
    for e in EDITS:
        if e['file'] in seen:
            dup.add(e['file'])
        seen.add(e['file'])
    overlap = []
    for f in dup:
        olds = [e['old'] for e in EDITS if e['file'] == f]
        for i in range(len(olds)):
            for j in range(len(olds)):
                if i != j and olds[i] in olds[j]:
                    overlap.append(f)
    check('同文件多条 edit 的锚点互不包含', not overlap, '; '.join(set(overlap)))

    # --- 补丁自己不许违反它给别人立的规矩 -----------------------------------
    layout_names = set()
    for line in ROOT_LAYOUT_MD.splitlines():
        if line.startswith('|'):
            cells = [c.strip() for c in line.split('|')]
            if len(cells) >= 6 and cells[1].startswith('`'):
                layout_names.add(cells[1].strip('`'))
    check('准入表解析出 ≥20 条', len(layout_names) >= 20, '实际 %d' % len(layout_names))

    # 有条件归档被放弃时，留下来的条目必须进准入表 —— 否则补丁把树留在
    # 「守卫必红」的状态，而长期红的守卫等于没有守卫。
    fake_skip = [('GPT_SoVITS', ['inference_webui.py', 'a/b.py'])]
    doc2 = render_layout_doc(fake_skip)
    names2 = set()
    for line in doc2.splitlines():
        if line.startswith('|'):
            cells = [c.strip() for c in line.split('|')]
            if len(cells) >= 6 and cells[1].startswith('`'):
                names2.add(cells[1].strip('`'))
    check('放弃归档时会把该条目临时登记进准入表',
          'GPT_SoVITS' in names2 and 'GPT_SoVITS' not in layout_names
          and '临时登记' in doc2)
    check('准入表不含任何助手产出物 / manifest',
          not any(n.startswith(('apply-', 'probe_', 'collect_', 'precheck_',
                                'sources_', '.r12c-')) for n in layout_names))
    check('本补丁的备份与 manifest 都不落项目根',
          WORK_DIR.startswith('cache/') and MANIFEST_REL.startswith('cache/'))
    check('本补丁跑完把自己搬进 tools/dev/', SELF_DST == 'tools/dev')

    # --- 反证：守卫的解析器对「表格写法变了」必须失败，不能恒真 -------------
    broken = ROOT_LAYOUT_MD.replace('| `server.js` |', '  server.js  ')
    broken_names = set()
    for line in broken.splitlines():
        if line.startswith('|'):
            cells = [c.strip() for c in line.split('|')]
            if len(cells) >= 6 and cells[1].startswith('`'):
                broken_names.add(cells[1].strip('`'))
    check('反证：表格行被破坏后 server.js 解析不出来（守卫会红，不是恒真）',
          'server.js' not in broken_names)

    # --- 死树归档：确认无活代码引用（在本树上真扫一遍）---------------------
    #
    # ⚠ 按**裸目录名**扫会误报：`vendor/gsv_code` 和活着的
    # `engines/gpt-sovits/gsv_code` 同名，而全树 106 处 `from gsv_code...`
    # 走的是 `infer_server.py:51` 的 `sys.path.insert(0, GSV_DIR)`，
    # 解析到的是 engines/ 那棵，vendor/ 从来不在 sys.path 上。
    # 所以只认**带路径前缀**的引用。
    #（反过来说：正因为同名，vendor/gsv_code 留在盘上本身就是一个潜在的
    #  包遮蔽隐患 —— 谁哪天把 vendor/ 加进 sys.path 就会导入错的那棵。）
    def _needles(rel):
        out = [rel, rel.replace('/', '\\')]
        base = rel.split('/')[-1]
        if '-' in base:  # 带连字符 -> 不是合法 Python 包名 -> 出现即是路径
            out.append(base)
        return out

    def _ref_hit(line, needles):
        s = line.strip()
        if s.startswith('#') or s.startswith('//'):
            return False
        if 'require(' not in s and 'import ' not in s:
            return False
        return any(nd in s for nd in needles)

    # 正对照：这个检查必须**有能力**报警，否则「零命中」和「根本没扫」一样
    check('正对照：伪造的活引用能被抓到',
          _ref_hit("const x = require('./vendor/gsv-tools/a.js')",
                   _needles('vendor/gsv-tools'))
          and _ref_hit("const t = require('../vendor/gsv_code/text/x.js')",
                       _needles('vendor/gsv_code')))
    check('反对照：活着的 `from gsv_code.text import ...` 不算命中',
          not _ref_hit('from gsv_code.text import pron_correction',
                       _needles('vendor/gsv_code')))

    live_refs = []
    for rel, _why in ARCHIVE_DIRS:
        needles = _needles(rel)
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames
                           if d not in ('node_modules', '.git', '__pycache__',
                                        'vendor', 'cache', 'dist', 'venv')]
            for fn in filenames:
                if not fn.endswith(('.js', '.cjs', '.mjs', '.jsx', '.py')):
                    continue
                fp = os.path.join(dirpath, fn)
                relf = os.path.relpath(fp, ROOT).replace(os.sep, '/')
                if relf.startswith(('tools/dev/', 'tools/checks/', 'docs/')):
                    continue
                if os.path.abspath(fp) == os.path.abspath(__file__):
                    continue  # 补丁自己写着这些路径，扫到自己是废话
                try:
                    with open(fp, 'rb') as f:
                        body = f.read().decode('utf-8', 'replace')
                except OSError:
                    continue
                for line in body.splitlines():
                    if _ref_hit(line, needles):
                        live_refs.append('%s: %s' % (relf, line.strip()[:70]))
    check('三棵死树无活代码 require/import', not live_refs, '; '.join(live_refs[:3]))

    # --- 归档落点必须在项目之外（判据还能回来，且不会被 git 看见）----------
    check('归档落点在项目之外',
          not os.path.abspath(JUNK_DIR).startswith(os.path.abspath(ROOT) + os.sep),
          JUNK_DIR)

    print('-' * 70)
    print('自检结果：%d ok / %d FAIL' % (ok, fail))
    return 0 if fail == 0 else 1


# ---------------------------------------------------------------- 应用

def show_plan(archives, conds, moves, edits, creates, done, skipped):
    print('\n本轮将要做的事：')
    for rel, why in archives:
        print('   归档   %-24s -> ..\\junk\\r12c-batch14\\   （%s）' % (rel, why[:46]))
    for rel, why in conds:
        print('   归档   %-24s -> ..\\junk\\r12c-batch14\\   （有条件，已扫过无源码）' % rel)
    for src, dst in moves:
        print('   搬家   %-24s -> %s' % (src, dst))
    for e in edits:
        print('   改动   %s' % e['file'])
    for rel, _ in creates:
        print('   新建   %s' % rel)
    if done:
        print('\n已经是目标状态（跳过）：')
        for d in done:
            print('   -  %s' % d)
    if skipped:
        print('\n⚠ 有条件归档被**主动放弃**（扫到了源码，不敢动）：')
        for rel, hits in skipped:
            print('   ⛔ %s 下扫到 %d 个源码文件，例如：' % (rel, len(hits)))
            for h in hits[:8]:
                print('        %s' % h)
            print('      → 这棵树不是纯权重，本补丁不动它。请人工判断后另开一轮。')


def do_write(archives, conds, moves, edits, creates):
    man = {'batch': 'r12c-batch14', 'archived': [], 'moved': [],
           'edited': [], 'created': [], 'junk': JUNK_DIR}
    os.makedirs(p(WORK_DIR), exist_ok=True)

    # 顺序：先编辑/新建（路径不受搬家影响），再搬家，最后归档。
    # 回滚按**严格相反**的顺序做 —— batch13 的教训：回滚步骤的顺序能让还原
    # 静默失效（archived 的落点被 dir_moves 的回滚搬走了，if exists 不成立，
    # 什么都不做且不报错）。
    backed = set()
    for e in edits:
        fp = p(e['file'])
        cur, meta = read_text(fp)
        if e['file'] not in backed:
            bak = p(WORK_DIR + '/' + e['file'].replace('/', '__') + '.bak')
            os.makedirs(os.path.dirname(bak), exist_ok=True)
            shutil.copy2(fp, bak)
            backed.add(e['file'])
            man['edited'].append(e['file'])
        write_text(fp, cur.replace(e['old'], e['new'], 1), meta)
        print('   ✔ 改动 %s' % e['file'])

    for rel, body in creates:
        fp = p(rel)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, 'wb') as f:
            f.write(body.encode('utf-8'))
        man['created'].append(rel)
        print('   ✔ 新建 %s' % rel)

    for src, dst in moves:
        s, d = p(src), p(dst)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.move(s, d)
        man['moved'].append([src, dst])
        print('   ✔ 搬家 %s -> %s' % (src, dst))

    os.makedirs(JUNK_DIR, exist_ok=True)
    for rel, _why in list(archives) + list(conds):
        s = p(rel)
        d = os.path.join(JUNK_DIR, rel.replace('/', '__'))
        if os.path.exists(d):
            raise SystemExit('❌ 归档落点已存在：%s —— 先处理掉它再跑' % d)
        shutil.move(s, d)
        man['archived'].append([rel, d])
        print('   ✔ 归档 %s -> %s' % (rel, d))

    with open(p(MANIFEST_REL), 'w', encoding='utf-8') as f:
        json.dump(man, f, ensure_ascii=False, indent=2)
    print('\n   manifest: %s' % MANIFEST_REL)
    return man


def restore():
    mf = p(MANIFEST_REL)
    if not os.path.exists(mf):
        raise SystemExit('❌ 找不到 %s —— 这一轮没应用过，或 manifest 被删了' % MANIFEST_REL)
    with open(mf, encoding='utf-8') as f:
        man = json.load(f)
    print(BANNER)
    print('回滚')
    n = 0
    # 严格反序：归档 -> 搬家 -> 新建 -> 改动
    for rel, dst in man.get('archived', []):
        if os.path.exists(dst):
            shutil.move(dst, p(rel))
            print('   ✔ 取回 %s' % rel)
            n += 1
        else:
            # else 必须喊。`if exists(): move()` 天然静默 ——
            # 「什么都没干」和「干成了」读数相同。
            print('   ⚠ 找不到归档物 %s，%s 未能搬回' % (dst, rel))
    for src, dst in man.get('moved', []):
        if os.path.exists(p(dst)):
            os.makedirs(os.path.dirname(p(src)), exist_ok=True)
            shutil.move(p(dst), p(src))
            print('   ✔ 搬回 %s' % src)
            n += 1
        else:
            print('   ⚠ 找不到 %s，%s 未能搬回' % (dst, src))
    for rel in man.get('created', []):
        if os.path.exists(p(rel)):
            os.remove(p(rel))
            print('   ✔ 删除 %s' % rel)
            n += 1
        else:
            print('   ⚠ %s 已不在，无需删除' % rel)
    for rel in man.get('edited', []):
        bak = p(WORK_DIR + '/' + rel.replace('/', '__') + '.bak')
        if os.path.exists(bak):
            shutil.copy2(bak, p(rel))
            os.remove(bak)
            print('   ✔ 还原 %s' % rel)
            n += 1
        else:
            print('   ⚠ 找不到备份 %s，%s 未能还原' % (bak, rel))
    os.remove(mf)

    # 收尾：把本轮自己造出来的空目录也收掉，否则「回滚干净」是打折的
    # —— 下一轮做逐字节比对时这些空壳会一直冒出来当噪音。
    for d in [p(WORK_DIR),
              p('cache/patch-backup/r12c-batch13'),
              man.get('junk'),
              os.path.dirname(man.get('junk') or '.')]:
        try:
            if d and os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
                print('   ✔ 清掉空目录 %s' % d)
        except OSError:
            pass

    print('\n已回滚 %d 项。' % n)
    print('注意：cache\\ 与 docs\\ 若本来就不存在，回滚不会把它们删掉 —— '
          '空目录不进 git，也不触发根布局守卫（表里 cache 已登记）。')
    return 0


def move_self():
    src = os.path.abspath(__file__)
    dstdir = p(SELF_DST)
    os.makedirs(dstdir, exist_ok=True)
    dst = os.path.join(dstdir, os.path.basename(src))
    if os.path.abspath(src) == os.path.abspath(dst):
        return
    shutil.move(src, dst)
    print('   ✔ 本脚本已搬到 %s/（根目录不留助手产出物，这条规矩对补丁自己同样成立）'
          % SELF_DST)
    print('     回滚命令：python %s\\%s --restore'
          % (SELF_DST.replace('/', '\\'), os.path.basename(src)))


def main(argv):
    if '--selftest' in argv:
        return selftest()
    if '--restore' in argv:
        return restore()

    print(BANNER)
    print('项目根：%s' % ROOT)
    print('=' * 70)
    archives, conds, moves, edits, creates, done, skipped = plan()
    show_plan(archives, conds, moves, edits, creates, done, skipped)

    if '--write' not in argv:
        print('\n（预演，未写盘。确认无误后加 --write）')
        return 0

    print('\n开始写入…')
    do_write(archives, conds, moves, edits, creates)
    move_self()
    if any(m[0] == '.r12c-batch13-manifest.json' for m in FILE_MOVES):
        print('\n注意：batch13 的 manifest 已从根目录移到')
        print('      cache\\patch-backup\\r12c-batch13\\ 。')
        print('      日后若要回滚 batch13，先把它搬回项目根再跑它的 --restore。')
    print('\n完成。请跑：node tools\\run_tests.cjs')
    print('判据：总数不低于上一轮（412）且 fail=0；根布局守卫 3 条应为新加。')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
