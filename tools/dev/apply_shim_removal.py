# -*- coding: utf-8 -*-
r"""apply_shim_removal —— 删掉 engines/indextts2/shim.py，并把它留下的账全部结掉

    python tools\dev\apply_shim_removal.py --check    # 只看不写
    python tools\dev\apply_shim_removal.py            # 真写

⭐⭐ 这一刀结的是**契约 §11 判据 8**：接一台新引擎 = 只写一张名片，
   不写一行代码。判据的量化形态是 engines/indextts2/shim.py **523 行 → 0**。

它做四件事：
  ① 删 4 个文件（shim.py 正主 + 上一刀留下的 3 个 .bak-call-cwd）
  ② engines/_TEMPLATE —— **本刀真正的重头戏**。原模板缺 call 段、缺
     params.load_time / params.call_time、缺 output_formats，照它接引擎
     宿主会直接 FATAL ⇒「只写一张名片」在补齐之前是**假的**。
  ③ 把指向 shim.py 的引用分两类处理：
       说明「今天这个行为在哪」 ⇒ 改指 lib/engines/host.py 的新行号
       说明「当初凭什么这么填」 ⇒ **保留原 shim.py:NNN，显式标注存档引文**
     ⛔ 后一类照抄到新位置等于**伪造出处**，所以不改。
  ④ docs/ENGINE_CONTRACT.md 结账（§1 / §5 / §5.2.1 / §11 判据 8 / §12）

⛔ 三条纪律，和上一把 apply_profile_json_wiring.py 完全一致：
   - **幂等**：已经打过的 hunk 认得出来，跳过，不重复插入
   - **全有或全无**：任何一处锚点命中次数 != 1 且又不是「已打过」，
     就**一个字都不写**，并点名是哪一处。⛔ 半打的树比没打的树更难救。
   - **不整文件覆盖**：这棵树上有几笔比我手里的快照新（上一刀的接线），
     整文件顶上去会把它们静默回滚掉。

⚠ 打完之后必须按顺序验三条 —— 少一条都不算数：
     node tools\run_tests.cjs          ⭐ 先看 tests **总数 839**，再看 fail
     node lib\engines\engine-launch-plan.cjs --engine indextts2
     python tools\dev\verify_launch.py ⛔ 删 shim 之后**必须再验一次真出声**
   测试全绿不等于能出声，这是契约 §11 判据 5 写死的。
"""
import argparse
import hashlib
import io
import json
import os
import sys

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA = json.loads(r"""
{
 "patches": [
  {
   "path": ".gitignore",
   "hunks": [
    {
     "old": "tools/dev/_scratch/\n\n# --- IndexTTS2：上游源码与上游文件不进仓库（license）---\n# 仓库里只保留我们自己写的胶水：shim.py / manifest.json /\n# UPSTREAM.md / LOCAL-CHANGES.md / SOURCE_MANIFEST.json / README.md\n# 源码按 UPSTREAM.md 记的 commit 由安装脚本拉取。\nengines/indextts2/indextts/\nengines/indextts2/pyproject.toml",
     "new": "tools/dev/_scratch/\n\n# --- IndexTTS2：上游源码与上游文件不进仓库（license）---\n# 仓库里只保留我们自己写的胶水：manifest.json /\n# UPSTREAM.md / LOCAL-CHANGES.md / SOURCE_MANIFEST.json / README.md\n# ⭐ 2026-08-27：这一行原先第一个列的是 shim.py。它已经删了（判据 8），\n#   \"我们自己写的胶水\"里现在**一行 Python 都没有** —— 只剩一张名片。\n# 源码按 UPSTREAM.md 记的 commit 由安装脚本拉取。\nengines/indextts2/indextts/\nengines/indextts2/pyproject.toml"
    }
   ]
  },
  {
   "path": "docs/ENGINE_CONTRACT.md",
   "hunks": [
    {
     "old": "契约按它自己的判据是通过的。但代价转移到了引擎作者身上：\n**必须写一个 523 行的 `shim.py`。**\n\n把那 523 行按\"该归谁\"拆开：\n\n| 这部分干什么 | 该归谁 |",
     "new": "契约按它自己的判据是通过的。但代价转移到了引擎作者身上：\n**必须写一个 523 行的 `shim.py`。**\n\n> ✅ **2026-08-27 结账：那 523 行已经归零，文件删了。**\n> 下面这张\"该归谁\"的表不是设想，是**实际搬完的账单** ——\n> 左边每一行今天都在 `lib\\engines\\host.py` 里（一份，所有引擎共用），\n> 右边那一行在 `engines\\indextts2\\manifest.json` 的 `call` 段里。\n> 判据 8 的三份取证见 §11。\n\n把那 523 行按\"该归谁\"拆开：\n\n| 这部分干什么 | 该归谁 |"
    },
    {
     "old": "下一个引擎作者要把那 96% 再写一遍，而且大概率写得不如这份好 ——\n种子那个坑（收下 `seed` 却不用，导致\"重跑声音不一样\"而 `meta.json` 里\n白纸黑字记着一个没生效的种子）他多半会踩。\n\n**版本 2 的全部动机就是这一句：那 96% 属于平台，不属于插件作者。**\n",
     "new": "下一个引擎作者要把那 96% 再写一遍，而且大概率写得不如这份好 ——\n种子那个坑（收下 `seed` 却不用，导致\"重跑声音不一样\"而 `meta.json` 里\n白纸黑字记着一个没生效的种子）他多半会踩。\n\n> ⭐ **这句话已经不再成立了，这正是想要的结果。**\n> `engines\\_TEMPLATE\\` 里今天没有任何 `.py` —— 模板教的是填 `call` 段，\n> 不是照抄一个脚本。⛔ 哪天模板里又长出一个 `shim.py`，\n> 就是这一节说的问题原样复发，**别让它过夜**。\n\n**版本 2 的全部动机就是这一句：那 96% 属于平台，不属于插件作者。**\n"
    },
    {
     "old": "\n---\n\n## §5 名片：怎么调这个引擎 【待建】\n\n> ⚠ **2026-08-25：本节描述的 `call` 一节，已从 `engines\\_TEMPLATE\\manifest.json` 里移除。**\n> 它今天**没有任何代码读它**（实测：`tools\\dev\\measure_manifest_reads.cjs`，读取 0 次）。\n> 今天真正管用的是 `runtime.entry` —— 引擎自带一个 `shim.py`，平台去跑它。\n> 两条路同时摆在模板里，作者会选看起来更省事的那条，然后发现什么都不发生。\n> **条款没有作废**，等通用宿主落地、本节改成【现状】那天，`call` 再回到模板里。\n\n**核心主张：调用方式是一串数据，不是一段代码。**\n",
     "new": "\n---\n\n## §5 名片：怎么调这个引擎 【现状】\n\n> ✅ **2026-08-27：`call` 一节已通电，并且已经回到 `engines\\_TEMPLATE\\manifest.json` 里。**\n> 读它的是通用宿主 `lib\\engines\\host.py`（经 `lib\\engines\\hostProfile.js` 装配）。\n>\n> 2026-08-25 本节还是【待建】，当时的理由是：`call` **没有任何代码读它**\n> （实测 `tools\\dev\\measure_manifest_reads.cjs`，读取 0 次），而真正管用的是\n> 引擎自带一个 `shim.py`。两条路同时摆在模板里，作者会选看起来更省事的那条，\n> 然后发现什么都不发生 —— 所以当时把 `call` 从模板里**摘掉**了。\n>\n> ⭐ 那次\"摘掉\"是对的，这次\"装回\"也是对的，**判据是同一条**：\n> 模板里只许摆**真的会发生点什么**的键。今天 `call` 满足了，`shim.py` 不再需要。\n>\n> ⚠ 仍是【待建】的只剩 §5.3 `cli` 和 §5.4 `http` 两种形态的宿主实现 ——\n> 名片里填了会被**当场拒绝启动**，不会静默。\n\n**核心主张：调用方式是一串数据，不是一段代码。**\n"
    },
    {
     "old": "}\n```\n\n### ⭐ §5.2.1 `call.seed`：种子是副作用，不是实参 【待建】\n\n**这一节是 2026-08-25 量 `engines/indextts2/shim.py` 时发现的契约缺口。**\n\n§1 早就点名过这个坑 —— 原话是「收下 `seed` 却不用，导致\"重跑声音不一样\"\n而 `meta.json` 里白纸黑字记着一个没生效的种子」，并把它列为版本 2 的动机之一。",
     "new": "}\n```\n\n### ⭐ §5.2.1 `call.seed`：种子是副作用，不是实参 【现状】\n\n**这一节是 2026-08-25 量 `engines/indextts2/shim.py` 时发现的契约缺口。**\n（⚠ 那个文件 2026-08-27 已删，下文凡引 `shim.py:NNN` 的都是**存档引文**。）\n\n✅ 三态全部通电，逐条有取证：`tools/dev/probe_host.py` [3] 同 seed 两次\n**字节完全相同**、换 seed 字节不同（后者不做的话前一条是假绿）；\n[5] `call.seed = \"none\"` 的引擎**拒收**带 seed 的请求（400，不是收下扔掉）；\n[6] `mode: \"global\"` 却没列 `rngs`、`scope` 不是 `locked`、`rngs` 里有不认识\n的随机源 —— 三种都**拒绝启动**（rc=2），不是运行时吞异常。\n\n§1 早就点名过这个坑 —— 原话是「收下 `seed` 却不用，导致\"重跑声音不一样\"\n而 `meta.json` 里白纸黑字记着一个没生效的种子」，并把它列为版本 2 的动机之一。"
    },
    {
     "old": "#### 取证：播了什么要记下来\n\n宿主播完种要把**实际生效的 RNG 列表**写进 `meta.json`\n（今天 `shim.py` 的 `apply_seed()` 返回 `\"numpy+torch+cuda\"` 就是干这个的）。\n理由同上：只播不记，用户没法区分\"播了\"和\"以为播了\"。\n\n⚠ 即使四个 RNG 全播到，CUDA 上部分 kernel 本身非确定性，",
     "new": "#### 取证：播了什么要记下来\n\n宿主播完种要把**实际生效的 RNG 列表**写进 `meta.json`\n（`lib/engines/host.py` 的 `X-Seed-Applied` 响应头就是干这个的，实测值\n`python+numpy+torch+torch.cuda`；这个做法承自已删的 `shim.py.apply_seed()`，\n它当年返回的是 `\"numpy+torch+cuda\"` —— ⭐ 少一个 `python`，\n那正是\"名片列 `rngs`、平台不写死\"要解决的那类漏播）。\n理由同上：只播不记，用户没法区分\"播了\"和\"以为播了\"。\n\n⚠ 即使四个 RNG 全播到，CUDA 上部分 kernel 本身非确定性，"
    },
    {
     "old": "7. ~~**参数清单只有一份**（C11）~~ ✅ 守卫已建：\n   `lib\\engines\\c11ParamTable.node.test.js`，见 C11 节。\n   ⚠ 判据本身**长期有效**（守卫留在那儿常红常绿），划掉的只是\"建守卫\"这件事\n8. **IndexTTS2 的 `shim.py` 缩到零** —— 只剩一张名片。\n   缩不到零，说明通用宿主还漏了东西，**这是版本 2 的主验收判据**\n9. **装一个假引擎**（只有名片、不真出声）：界面能正常长出它的参数面板，\n   且**不显示训练页** —— 证明界面确实在按名片长，不是按 GSV 长\n10. **`engines\\<id>\\` 里搜不到上游源码和权重**（C10）；",
     "new": "7. ~~**参数清单只有一份**（C11）~~ ✅ 守卫已建：\n   `lib\\engines\\c11ParamTable.node.test.js`，见 C11 节。\n   ⚠ 判据本身**长期有效**（守卫留在那儿常红常绿），划掉的只是\"建守卫\"这件事\n8. ~~**IndexTTS2 的 `shim.py` 缩到零** —— 只剩一张名片。~~\n   ✅ **2026-08-27 达成：523 → 0，文件已删。**\n   缩不到零，说明通用宿主还漏了东西，**这是版本 2 的主验收判据**。\n   ⚠ 判据长期有效（`engines/<id>/` 里再长出一个 shim 就是退步），\n   划掉的只是\"缩这一刀\"。三份取证：\n\n   | 取证 | 问的是什么 | 读数 |\n   |---|---|---|\n   | `tools/dev/run_ab.py` | 换了路径，出来的**声音**还一样吗 | 5 条 5 过。跨路径梅尔差 **0.00%**、时长差 0.00%；天花板 127.25%（证明 5% 这个阈值分得出差别，全绿不是空转）；地板 0.00% |\n   | `tools/dev/verify_launch.py` | **平台自己的启动路径**照新名片起得来、出得了声吗 | 14 条 14 过。ready 29.6s，`/tts` 200 / 138796 字节 / 3.146s，同 seed 两次逐字节相同 |\n   | `tools/dev/probe_host.py` | 宿主把那 96% 样板**真的**做了吗 | 29 条 29 过（四类 400、播种取证、名片不完整拒绝启动） |\n\n   ⛔ **三份缺一不可，而且顺序不能倒**：`run_ab` 证的是\"host 能替代 shim\"，\n   `verify_launch` 证的是\"平台照新名片起得来\" —— 那是**两件事**。\n   我一度把前者读成后者，是 `verify_launch.py` 存在的理由：\n   `run_ab.py` 自己拼命令起引擎，**从来没走过 `engine-launch-plan.cjs`**，\n   而那才是 `start.ps1` 真正用的东西。\n\n   ⚠ **这一刀的连带修复**（不修就是留了个必炸的雷）：走通用宿主之后\n   所有引擎的**入口绝对路径必然相同**，而 `own_process_mark` 原先取的正是\n   入口绝对路径 ⇒ `start.ps1` 会认为\"我的引擎已经在跑了\"，\n   **第二台永远起不来且不报任何错**。改用\n   `cache/engines/<id>.profile.json` 当记号（见 `lib/engines/launchPlan.js`）。\n   ⇒ 教训：**抽公共实现时，先问\"哪些东西原来靠'各家不一样'才成立\"**。\n9. **装一个假引擎**（只有名片、不真出声）：界面能正常长出它的参数面板，\n   且**不显示训练页** —— 证明界面确实在按名片长，不是按 GSV 长\n10. **`engines\\<id>\\` 里搜不到上游源码和权重**（C10）；"
    },
    {
     "old": "|---|---|---|\n| **0** | **给老路径补钉子测试**（不改行为） | 全仓最危险的 `synthesisService.js` 目前只有 4 个测试直接覆盖。先把今天 GSV 的实际表现钉死：同输入同种子，档案字段、分段数、段边界、批次号一字不差 |\n| 1 | 合成路径改成读名片（地址、超时、分段长度、要不要换权重、参考音频约束、采样率） | GPT-SoVITS 行为一个字不变，测试仍全绿 |\n| 2 | 通用引擎宿主 + 三道校验 | IndexTTS2 的 523 行缩到零 |\n| 3 | 界面按名片生成（参数面板、权重槽、训练页显隐） | 假引擎测试（判据 9、11） |\n| 4 | 安装脚本：按 pin 的 commit 拉上游 | `engines\\<id>\\` 只剩名片 + 说明 |\n\n### ⭐ 第 0 步：钉子测试要钉哪几颗\n",
     "new": "|---|---|---|\n| **0** | **给老路径补钉子测试**（不改行为） | 全仓最危险的 `synthesisService.js` 目前只有 4 个测试直接覆盖。先把今天 GSV 的实际表现钉死：同输入同种子，档案字段、分段数、段边界、批次号一字不差 |\n| 1 | 合成路径改成读名片（地址、超时、分段长度、要不要换权重、参考音频约束、采样率） | GPT-SoVITS 行为一个字不变，测试仍全绿 |\n| 2 | 通用引擎宿主 + 三道校验 | IndexTTS2 的 523 行缩到零 —— ✅ **2026-08-27 达成**（见 §11 判据 8 的三份取证）。⚠ 见下方「第 2 步是两半」 |\n| 3 | 界面按名片生成（参数面板、权重槽、训练页显隐） | 假引擎测试（判据 9、11） |\n| 4 | 安装脚本：按 pin 的 commit 拉上游 | `engines\\<id>\\` 只剩名片 + 说明 |\n\n### ⛔⛔ 第 2 步是两半，别把做完一半读成做完了\n\n上面那一格 ✅ 打在**第一半**上。完整的第 2 步是：\n\n| | 是什么 | 状态 |\n|---|---|---|\n| ① **启动**路径由名片驱动 | 名片说跑什么，平台就跑什么；引擎自带脚本归零 | ✅ **2026-08-27 达成** |\n| ② **合成**路径带 `engine_id` | 每一次合成调用自己说清\"发给哪台引擎\" | ⛔ **没做** |\n\n②**不是**①的前置，两者可以分开做 —— 但**没有②，界面上就只有一台引擎**：\n\n- `tools\\scripts\\start.ps1:57-58`：起哪台引擎看环境变量 `ENGINE_ID`，\n  默认**写死** `'gpt-sovits'`，界面上没有切换的地方\n- `lib\\engines\\legacyDefault.js` 文件头写得很直白：webui 的合成路径\n  **从来没有\"引擎\"这个参数**，它绑死在 `legacy_default: true` 那张名片上\n- `server.js` 全文**零次**出现 `indextts2`\n\n⇒ 所以\"从界面真起一次 IndexTTS2\"**今天做不到**，那不是漏装、不是配置问题，\n是②还没做。⭐ 验第一半要用 `tools\\dev\\verify_launch.py`（照平台真实启动\n路径起一次），**不是**去界面上找。\n\n②做完的标志：`lib\\engines\\legacyDefault.js` 和名片里的 `legacy_default`\n键**整个删掉** —— 那个文件的注释里已经写好了自己的死刑条件。\n\n### ⭐ 第 0 步：钉子测试要钉哪几颗\n"
    }
   ]
  },
  {
   "path": "engines/_TEMPLATE/README.md",
   "hunks": [
    {
     "old": "├── README.md         这个引擎怎么装、有什么坑\n├── UPSTREAM.md       上游地址 + commit + 已知的坑\n├── LOCAL-CHANGES.md  改了上游哪几行；一行没改也要写「零改动」并留证据\n├── shim.py           平台按 manifest 的 runtime.entry 去跑它  ← 今天真正的接入点\n├── smoke/ref_a.wav   【待建】冒烟用的固定参考音频（⭐ 落地后要进 git）\n├── smoke/ref_b.wav   【待建】另一个人的音色，绑定判别用（⭐ 同样要进 git）\n├── driver.js         【待建】逃生门，只在 manifest 明写 escape_hatch 时启用",
     "new": "├── README.md         这个引擎怎么装、有什么坑\n├── UPSTREAM.md       上游地址 + commit + 已知的坑\n├── LOCAL-CHANGES.md  改了上游哪几行；一行没改也要写「零改动」并留证据\n│                     ⭐⭐ 没有 shim.py 这一行 —— **你不需要写任何 Python**。\n│                     平台的通用宿主 lib/engines/host.py 所有引擎共用一份，\n│                     怎么调你这台引擎全看名片的 call 段（见下）\n├── smoke/ref_a.wav   【待建】冒烟用的固定参考音频（⭐ 落地后要进 git）\n├── smoke/ref_b.wav   【待建】另一个人的音色，绑定判别用（⭐ 同样要进 git）\n├── driver.js         【待建】逃生门，只在 manifest 明写 escape_hatch 时启用"
    },
    {
     "old": "└── venv/             ⛔ 不进 git\n```\n\n## 三种调用形态 【待建】\n\n⚠ 下面这张表描述的是**通用宿主落地之后**的样子。今天平台只有一种做法：\n名片写 `runtime.entry`，你自己在引擎目录里放一个脚本，平台去跑它。\n`engines/indextts2/shim.py` 就是这么一个脚本，可以直接照着改。\n\n| 形态 | 什么意思 | 什么时候用 |\n|---|---|---|\n| `python` | 平台起子进程，导入一个类、调一个方法 | 上游提供 Python 接口 |\n| `cli` | 平台起子进程，传命令行参数，产出音频文件 | **多数开源 TTS。往往比 Python 接口更稳** |\n| `http` | 引擎自己是常驻服务，平台发请求 | 上游本来就是个服务 |\n\n⭐ **`cli` 是一等公民，不是降级方案。**作者通常会保证命令行向后兼容，\n内部类名却说改就改。\n\n**不在兼容范围内**：闭源云端服务（不需要这套抽象）、流式输出\n（与分段拼接冲突，要接走逃生门）。\n\n## ⭐ `runtime` 段：让平台替你把引擎起起来\n",
     "new": "└── venv/             ⛔ 不进 git\n```\n\n## 三种调用形态\n\n| 形态 | 什么意思 | 什么时候用 | 状态 |\n|---|---|---|---|\n| `python` | 平台起子进程，导入一个类、调一个方法 | 上游提供 Python 接口 | **【现状】** |\n| `cli` | 平台起子进程，传命令行参数，产出音频文件 | **多数开源 TTS。往往比 Python 接口更稳** | 【待建】 |\n| `http` | 引擎自己是常驻服务，平台发请求 | 上游本来就是个服务 | 【现状】※ |\n\n※ `http` 形态今天的做法是**不走通用宿主**：名片不写 `call` 段，\n`runtime.entry` 指你自己的服务入口（GPT-SoVITS 就是这样）。\n\n⭐ **`cli` 是一等公民，不是降级方案。**作者通常会保证命令行向后兼容，\n内部类名却说改就改。它的名片形状见 `docs/ENGINE_CONTRACT.md §5.3`，\n宿主侧尚未实现 —— 今天填了不会生效，会被拒绝启动而不是静默。\n\n**不在兼容范围内**：闭源云端服务（不需要这套抽象）、流式输出\n（与分段拼接冲突，要接走逃生门）。\n\n### ⭐⭐ `python` 形态：你要写的是名字，不是代码\n\n**2026-08-27 起，接一台 `python` 形态的引擎不需要写一行 Python。**\n名片里 `runtime.entry` 指向平台的通用宿主，`call` 段告诉它怎么调你：\n\n```jsonc\n\"call\": {\n  \"kind\": \"python\",\n  \"cwd\": \"engines/<id>\",          // 调用时上游需要待在哪（很多上游有相对 CWD 硬编码）\n  \"module\": \"yourtts.infer\",      // import 谁\n  \"class\":  \"YourTTS\",            // 构造谁\n  \"init_args\": { \"model_dir\": \"{checkpoints}\" },   // 加载期，改它要重启\n  \"method\": \"infer\",              // 每次合成调哪个方法\n  \"bind\": {                       // 平台的三个词 → 你这个方法的形参名\n    \"text\": \"text\",\n    \"ref_audio\": \"ref_audio\",\n    \"output_path\": \"output_path\"\n  },\n  \"returns\": \"file\",              // file = 写到 output_path；bytes = 直接返回\n  \"seed\": { \"mode\": \"global\", \"rngs\": [\"python\", \"numpy\", \"torch\"], \"scope\": \"locked\" }\n}\n```\n\n⛔ **`seed` 不许省略**（契约 §5.2.1）。三选一：你的方法自己收\n（`{\"arg\":\"seed\"}`）、宿主替你播全局 RNG（上面那种）、或者老实写 `\"none\"`\n表示这台引擎不可复现 —— 那时宿主会对带 `seed` 的请求**回 400**。\n省略 = 静默忽略 = 用户拿到一个声音对不上、`meta.json` 里却白纸黑字记着\n种子的档案。**\"不支持\" 和 \"没写\" 必须能区分开。**\n\n⭐ `rngs` 必须**你来列**，平台不写死。你要是纯 ONNX / JAX 引擎，`torch`\n根本没装；平台无条件去播只能 `try/except` 吞掉 —— 那等于播种失败是静默的。\n\n⚠ `call.module` / `call.class` / `call.method` 必须和\n`runtime.verify.imports` 里那三个名字**同源**，否则「验的」和「跑的」\n不是同一个东西。\n\n## ⭐ `runtime` 段：让平台替你把引擎起起来\n"
    },
    {
     "old": "\n```jsonc\n\"runtime\": {\n  \"python\": \"{engine_dir}/.venv/Scripts/python.exe\",  // 你的解释器\n  \"entry\":  \"{engine_dir}/shim.py\",                    // 入口脚本\n  \"args\":   [\"--host\", \"{host}\", \"--port\", \"{port}\"],  // 命令行，占位符会展开\n  \"cwd\":    \"{root}\",\n  \"ready_endpoint\": \"/health\",\n  \"ready_timeout_ms\": 180000,\n  \"preload\": true\n}\n```\n\n认识的占位符只有 `{host}` `{port}` `{root}` `{engine_dir}` `{checkpoints}`。\n⛔ **拼错的占位符会当场报错，不会原样传下去** —— 原样传的后果是引擎说\n\"某个文件找不到\"，而名片看着完全正常。\n\n⚠ **\"我该监听哪个端口\"来自 `default_base_url`，不是 `runtime`。**\n那个地址必须带端口。（它和环境变量顶出来的地址是两件事：前者是\"我听哪儿\"，",
     "new": "\n```jsonc\n\"runtime\": {\n  \"python\": \"engines/<id>/.venv/Scripts/python.exe\",   // 你的解释器（相对项目根）\n  \"entry\":  \"../../lib/engines/host.py\",               // ⭐ 平台的通用宿主，照抄\n  \"args\":   [\"--profile-json\", \"{profile_json}\",       // ⭐ 照抄这三对\n             \"--host\", \"{host}\", \"--port\", \"{port}\"],\n  \"cwd\":    \".\",\n  \"ready_endpoint\": \"/health\",\n  \"ready_timeout_ms\": 180000,\n  \"preload\": true\n}\n```\n\n⚠ **解释器仍然是你自己 venv 的** —— 换的是脚本，不是环境。torch 那一套\n还得装在 `engines/<id>/.venv` 里。这两件事别混。\n\n认识的占位符只有 `{host}` `{port}` `{root}` `{engine_dir}` `{checkpoints}`\n`{profile_json}`。\n⛔ **拼错的占位符会当场报错，不会原样传下去** —— 原样传的后果是引擎说\n\"某个文件找不到\"，而名片看着完全正常。\n\n### ⭐ `{profile_json}` 是什么，为什么必须写\n\n它是平台把你这张名片**解析好之后落盘的那份**\n（`cache/engines/<id>.profile.json`，路径由 `lib/engines/engine-launch-plan.cjs`\n算出来并在 spawn 之前写好）。宿主**不读 `manifest.json`** —— 名片的语义\n只有 `lib/engines/profile.js` 一个实现，写两遍迟早分叉。\n\n⛔ 入口指了 `host.py` 却漏写这个占位符，表现是宿主开口就 FATAL\n「`--profile-json` 是必须的」，看着像宿主坏了，其实是 `args` 里漏了一对。\n\n⭐ 它还兼着第二个差事：`start.ps1` 靠命令行里这个值**认自家进程**。\n走宿主的引擎入口路径全都一样，只有这份 profile 一台引擎一个 ——\n要是拿入口当记号，A 引擎占着端口时平台会认为「我的引擎已经在跑了」，\n**B 永远起不来而且不报任何错**。\n\n⚠ **\"我该监听哪个端口\"来自 `default_base_url`，不是 `runtime`。**\n那个地址必须带端口。（它和环境变量顶出来的地址是两件事：前者是\"我听哪儿\"，"
    }
   ]
  },
  {
   "path": "engines/_TEMPLATE/manifest.json",
   "hunks": [
    {
     "old": "    \"量过（把名片包一层 Proxy，记录平台每一次取值）。填了不生效的键一个都没有。\",\n    \"⚠ 唯一的例外是 upstream / local_changes 两处，那里单独注明了。\",\n    \"\",\n    \"契约版本 2 里还没通电的设计（通用宿主 call、强制冒烟 smoke、逃生门）\",\n    \"已经从这张表里挪走了，见 docs/ENGINE_CONTRACT.md「终局形态」一节。\",\n    \"留在这里只会让人认真填完、然后什么都不发生。\",\n    \"\",\n    \"以 _ 开头的键是注释，注册表读名片的第一步就把它们剥掉（registry.js:32）。\",",
     "new": "    \"量过（把名片包一层 Proxy，记录平台每一次取值）。填了不生效的键一个都没有。\",\n    \"⚠ 唯一的例外是 upstream / local_changes 两处，那里单独注明了。\",\n    \"\",\n    \"⭐⭐ 2026-08-27：`call` 一段**回到这张表里了**。通用宿主\",\n    \"lib/engines/host.py 已经落地并通过 A/B 判据（tools/dev/run_ab.py，\",\n    \"跨路径梅尔差 0.00%、天花板 127.25%，5 条判据 5 过），\",\n    \"IndexTTS2 的 523 行 shim.py 已经删干净 —— 也就是说：\",\n    \"**接一台新引擎不用再写任何 Python，把下面 call 段填对就行。**\",\n    \"\",\n    \"契约版本 2 里**仍然**没通电的设计（强制冒烟 smoke、逃生门 escape_hatch）\",\n    \"还在这张表外面，见 docs/ENGINE_CONTRACT.md「终局形态」一节。\",\n    \"留在这里只会让人认真填完、然后什么都不发生。\",\n    \"\",\n    \"以 _ 开头的键是注释，注册表读名片的第一步就把它们剥掉（registry.js:32）。\","
    },
    {
     "old": "    \"的隐蔽形态。\",\n    \"\",\n    \"python           : 引擎 venv 的解释器，相对项目根，⛔不许写绝对路径\",\n    \"entry            : 平台要跑起来的那个脚本，相对 cwd。必填。\",\n    \"args             : 追加给 entry 的命令行参数。可选，默认空。\",\n    \"cwd              : 工作目录，相对项目根。可选，默认引擎目录。\",\n    \"checkpoints      : 权重目录，相对项目根。⭐ 权重不进 git（C10）\",\n    \"ready_endpoint   : 探活地址，必须以 / 开头。必填 —— 平台靠它判断起来没有。\",\n    \"ready_timeout_ms : 冷启动预算。按实测冷启动耗时取三倍余量。\",\n    \"preload          : 平台启动时要不要顺带把它拉起来。\",\n    \"verify           : 深度体检。可选，整节删掉 = 只查解释器在不在。\",\n    \"  写了它，平台会用上面那个解释器去 import 一遍，确认依赖真的装好了 ——\",\n    \"  这能把「装了但 import 就炸」和「没装」区分开。\",\n    \"\",\n    \"⛔ runtime 下平台只认这 9 个键，多写一个就抛。理由是拼错会被静默忽略，\",\n    \"表现成「轮询永远超时」而名片看着完全正常。\"\n  ],\n  \"runtime\": {\n    \"python\": \"engines/<id>/.venv/Scripts/python.exe\",\n    \"entry\": \"shim.py\",\n    \"args\": [],\n    \"cwd\": \"engines/<id>\",\n    \"checkpoints\": \"models/tts/<id>/checkpoints\",\n    \"ready_endpoint\": \"/health\",\n    \"ready_timeout_ms\": 180000,",
     "new": "    \"的隐蔽形态。\",\n    \"\",\n    \"python           : 引擎 venv 的解释器，相对项目根，⛔不许写绝对路径\",\n    \"entry            : 平台要跑起来的那个脚本，相对**本 manifest 所在目录**。必填。\",\n    \"  ⭐⭐ 照抄下面那行就行：`../../lib/engines/host.py` 是平台的**通用宿主**，\",\n    \"    所有引擎共用一份。你不需要在自己目录里放任何 Python —— 宿主怎么调\",\n    \"    你这台引擎，全看下面的 `call` 段。\",\n    \"  ⚠ 解释器仍然是**你自己 venv 的**：换的是脚本，不是环境。torch 那一套\",\n    \"    还得装在 engines/<id>/.venv 里，这两件事别混。\",\n    \"  ⛔ 上游本来就是个常驻服务（形如 GPT-SoVITS）才写自己的入口 —— 那种引擎\",\n    \"    不由通用宿主托管，名片里也就没有 call 段。两条路，别同时走。\",\n    \"args             : 追加给 entry 的命令行参数。可选，默认空。\",\n    \"  走通用宿主就照抄下面那三对。⭐ {profile_json} = 平台把这张名片解析好\",\n    \"  之后落盘的那个文件（cache/engines/<id>.profile.json，由\",\n    \"  lib/engines/engine-launch-plan.cjs 算路径并在 spawn 之前写出来）。\",\n    \"  宿主**不读 manifest.json**：名片的语义只有 lib/engines/profile.js 一个\",\n    \"  实现，写两遍迟早分叉。\",\n    \"  ⛔ 入口指到 host.py 却漏写这个占位符，表现是宿主开口就 FATAL\",\n    \"    「--profile-json 是必须的」—— 看着像宿主坏了，其实是这行漏了。\",\n    \"  ⭐ 它还兼着第二个差事：start.ps1 靠命令行里这个值认自家进程。\",\n    \"    走宿主的引擎入口路径全都一样，只有它一台一个。\",\n    \"cwd              : 工作目录，相对项目根。可选，默认引擎目录。\",\n    \"checkpoints      : 权重目录，相对项目根。⭐ 权重不进 git（C10）\",\n    \"  ⭐ 走宿主时它**没有退休**，只是读它的人换了：宿主从解析结果里自己取，\",\n    \"  再把 call 段里的 {checkpoints} 填成绝对路径。所以别因为 args 里看不到\",\n    \"  --checkpoints 就删掉它。\",\n    \"ready_endpoint   : 探活地址，必须以 / 开头。必填 —— 平台靠它判断起来没有。\",\n    \"ready_timeout_ms : 冷启动预算。按实测冷启动耗时取三倍余量。\",\n    \"preload          : 平台启动时要不要顺带把它拉起来。\",\n    \"verify           : 深度体检。可选，整节删掉 = 只查解释器在不在。\",\n    \"  写了它，平台会用上面那个解释器去 import 一遍，确认依赖真的装好了 ——\",\n    \"  这能把「装了但 import 就炸」和「没装」区分开。\",\n    \"  ⭐ 走宿主的话它**别删**：verify.sys_path 有第二个消费者 —— 宿主起来时\",\n    \"  按它把引擎源码目录加进 sys.path。验哪条路径就得跑哪条路径。\",\n    \"  ⭐ verify.imports 里的 module/class/methods 必须和下面 call 段的\",\n    \"  call.module / call.class / call.method **同源** —— 不一致等于\",\n    \"  「验的和跑的不是同一个东西」。\",\n    \"\",\n    \"⛔ runtime 下平台只认这 9 个键，多写一个就抛。理由是拼错会被静默忽略，\",\n    \"表现成「轮询永远超时」而名片看着完全正常。\"\n  ],\n  \"runtime\": {\n    \"python\": \"engines/<id>/.venv/Scripts/python.exe\",\n    \"entry\": \"../../lib/engines/host.py\",\n    \"args\": [\n      \"--profile-json\", \"{profile_json}\",\n      \"--host\", \"{host}\",\n      \"--port\", \"{port}\"\n    ],\n    \"cwd\": \".\",\n    \"checkpoints\": \"models/tts/<id>/checkpoints\",\n    \"ready_endpoint\": \"/health\",\n    \"ready_timeout_ms\": 180000,"
    },
    {
     "old": "          \"init_params\": [\"model_dir\"]\n        }\n      ]\n    }\n  },\n",
     "new": "          \"init_params\": [\"model_dir\"]\n        }\n      ]\n    }\n  },\n\n  \"_comment_call\": [\n    \"⭐⭐ 通用宿主 lib/engines/host.py 全靠这一段才知道怎么调你这台引擎。\",\n    \"**全是名字，没有一行逻辑** —— 这一段就是「不写代码」的兑现处。\",\n    \"\",\n    \"⛔ 什么时候整节删掉：你这台引擎自带常驻服务（GPT-SoVITS 那种），\",\n    \"  不由宿主托管。那时 runtime.entry 指你自己的入口，call 段不要写。\",\n    \"  ⚠ 反过来，entry 指了 host.py 却没有 call 段 ⇒ 宿主拒绝启动（rc=2）。\",\n    \"\",\n    \"kind      : python / cli / http。今天宿主真正实现的是 python，\",\n    \"            cli / http 见 docs/ENGINE_CONTRACT.md §5.3 / §5.4。\",\n    \"cwd       : 调用时上游需要待在哪，相对项目根。\",\n    \"  ⛔ 和 runtime.cwd 同名不同义：那个是「启动器从哪儿 spawn」，\",\n    \"    这个是「调用时上游需要待在哪」（很多上游有相对 CWD 的硬编码）。\",\n    \"    各有各的消费者，别混，也别在两处各 chdir 一次。\",\n    \"module / class      宿主要 import 的模块和要构造的类。\",\n    \"init_args           构造那个类时传什么。⭐ 这里是**加载期**，改它要重启。\",\n    \"method              每次合成调的那个方法名。\",\n    \"bind                平台的三个词 → 你这个方法的**形参名**：\",\n    \"  text / ref_audio / output_path。⛔ 漏 text 一定拒绝启动。\",\n    \"returns   : file（方法把音频写到 output_path）或 bytes（直接返回）。\",\n    \"            写 file 就必须在 bind 里给 output_path，否则拒绝启动。\",\n    \"seed      : ⭐⭐ 三选一，**不许省略**（契约 §5.2.1）：\",\n    \"  {\\\"arg\\\": \\\"<形参名\\\"}         你的方法自己收 seed\",\n    \"  {\\\"mode\\\":\\\"global\\\", \\\"rngs\\\":[…], \\\"scope\\\":\\\"locked\\\"}  你不收，宿主播全局 RNG\",\n    \"  \\\"none\\\"                      这台引擎不可复现 ⇒ 宿主对带 seed 的请求回 400\",\n    \"  ⛔ 省略 = 静默忽略 = 用户拿到一个声音对不上、却白纸黑字记着 seed 的\",\n    \"    meta.json。「不支持」和「没写」必须能区分开。\",\n    \"  ⭐ rngs 必须**你来列**，平台不写死：你要是纯 ONNX/JAX 引擎，torch 根本\",\n    \"    没装，平台无条件去播只能 try/except 吞掉 —— 那等于播种失败是静默的。\",\n    \"    列了但环境里没有 ⇒ 拒绝启动，不是运行时吞异常。\",\n    \"\",\n    \"⭐ 大括号是**占位符**，由宿主在启动时填成本机绝对路径。认得的只有三个：\",\n    \"  {root} / {engine_dir} / {checkpoints}。写错会被当场拒绝启动，不会静默。\",\n    \"  名片不知道、也不该知道这台机器上的绝对路径。\",\n    \"\",\n    \"⛔ 改完这一段就重跑 tools/dev/probe_host.py（29 条），它逐条验的就是\",\n    \"  这里的每一项到底有没有生效。\"\n  ],\n\n  \"call\": {\n    \"kind\": \"python\",\n    \"cwd\": \"engines/<id>\",\n    \"module\": \"yourtts.infer\",\n    \"class\": \"YourTTS\",\n    \"init_args\": {\n      \"model_dir\": \"{checkpoints}\"\n    },\n    \"method\": \"infer\",\n    \"bind\": {\n      \"text\": \"text\",\n      \"ref_audio\": \"ref_audio\",\n      \"output_path\": \"output_path\"\n    },\n    \"returns\": \"file\",\n    \"seed\": {\n      \"mode\": \"global\",\n      \"rngs\": [\"python\", \"numpy\", \"torch\"],\n      \"scope\": \"locked\"\n    }\n  },\n"
    },
    {
     "old": "    \"⚠ 下面 example_strength 是一个**能真的跑通**的样例（param_keys、schema、\",\n    \"payload_keys、defaults 四处一致）。改成你自己的参数，或者整组删掉。\"\n  ],\n  \"param_keys\": [\"example_strength\"],\n  \"params\": {\n    \"schema\": {\n      \"example_strength\": {\n        \"type\": \"number\",",
     "new": "    \"⚠ 下面 example_strength 是一个**能真的跑通**的样例（param_keys、schema、\",\n    \"payload_keys、defaults 四处一致）。改成你自己的参数，或者整组删掉。\"\n  ],\n  \"_comment_params_whitelists\": [\n    \"⭐⭐ 走通用宿主的引擎**必须**填这两张白名单。它们分别喂 /tts 上的两道 400：\",\n    \"    load_time  只能在起进程时给。出现在合成请求里 ⇒ 400。\",\n    \"    call_time  允许透传给上面 call.method 的额外形参。不在表上 ⇒ 400。\",\n    \"\",\n    \"  ⛔ 不在表上的键**被拦下**，不是被忽略 —— 否则参数名拼错会表现成\",\n    \"    「设了没效果」，那是最难查的一类 bug。实现在\",\n    \"    lib/engines/host.py 的 validate_request()（host.py:637-645）。\",\n    \"\",\n    \"  ⛔ 同一个名字不能同时出现在两张表里：两道 400 会互相打架，而且没人\",\n    \"    说得清改了它到底要不要重启。lib/engines/hostProfile.js 会拒绝装配。\",\n    \"\",\n    \"  ⛔ 别拿 payload_keys 顶替这张表 —— 那张回答的是「HTTP 载荷里放哪些键」，\",\n    \"    里面混着 text / seed 这类核心键，当白名单用会把两道闸都判错。\",\n    \"\",\n    \"  ⭐ 这两个键是 params.schema（界面画格子那套）的**兄弟键**，各管各的。\",\n    \"    ⚠ 两边容易漂：schema 里有、call_time 里没有的参数，界面能调、\",\n    \"      发出去必被 400。加参数时两处一起加。\"\n  ],\n  \"param_keys\": [\"example_strength\"],\n  \"params\": {\n    \"load_time\": [],\n    \"call_time\": [\"example_strength\"],\n    \"schema\": {\n      \"example_strength\": {\n        \"type\": \"number\","
    },
    {
     "old": "    }\n  },\n\n  \"_comment_do_not_write\": [\n    \"⛔ legacy_default —— 别写这个键。\",\n    \"它回答的是『老合成路径没人指定引擎时连哪台』，全平台**有且只能有一张**\",",
     "new": "    }\n  },\n\n  \"_comment_output_formats\": [\n    \"你这台引擎**自己**能直接吐出来的格式。要别的格式 ⇒ 宿主回 400，\",\n    \"由平台去转 —— 不在引擎里塞转码逻辑（契约：引擎只管推理）。\",\n    \"整行删掉 = 默认 [\\\"wav\\\"]。\"\n  ],\n  \"output_formats\": [\"wav\"],\n\n  \"_comment_do_not_write\": [\n    \"⛔ legacy_default —— 别写这个键。\",\n    \"它回答的是『老合成路径没人指定引擎时连哪台』，全平台**有且只能有一张**\","
    }
   ]
  },
  {
   "path": "engines/gpt-sovits/manifest.json",
   "hunks": [
    {
     "old": "    \"\",\n    \"搬家前这五个键名硬写在 server.js:773-779 的 buildTtsPayload 里 ——\",\n    \"那意味着任何一台不叫 ref_audio_path 的引擎都收到一个它看不懂的请求体。\",\n    \"IndexTTS2 的 shim 对不认识的键直接 400（shim.py:382-392），所以那不是\",\n    \"「兼容性一般」，是「根本调不动」。\",\n    \"\",\n    \"没写的词 = 这台引擎没这个概念，平台就不发。GPT-SoVITS 这几个词都有，\",",
     "new": "    \"\",\n    \"搬家前这五个键名硬写在 server.js:773-779 的 buildTtsPayload 里 ——\",\n    \"那意味着任何一台不叫 ref_audio_path 的引擎都收到一个它看不懂的请求体。\",\n    \"通用宿主对不认识的键直接 400（lib/engines/host.py:637-645），所以那不是\",\n    \"「兼容性一般」，是「根本调不动」。\",\n    \"\",\n    \"没写的词 = 这台引擎没这个概念，平台就不发。GPT-SoVITS 这几个词都有，\","
    },
    {
     "old": "    \"tools/scripts/start.ps1 直接起的，名片说了不算。这正是契约 §9 记的那\",\n    \"笔账：平台的启动脚本里写死了这一台引擎的知识。\",\n    \"\",\n    \"⛔ entry 的 `../../` 就是这笔账的可见形态：别的引擎的入口脚本在自己\",\n    \"的目录里（engines/<id>/shim.py），只有 GPT-SoVITS 的入口在平台的\",\n    \"lib/inference/ 下。这个 `../../` 不是笔误，是提醒 —— 第 3 步做出通用\",\n    \"宿主之后，infer_server.py 应该搬进 engines/gpt-sovits/，届时这两个点\",\n    \"点会消失。它一天还在，账就一天没还完。\",\n    \"\",\n    \"python: 根 venv。Owner 2026-08-24 定案：平台只维护 GPT-SoVITS 这一套\",\n    \"  环境（6.8 GB），其他引擎的环境一概由引擎作者/用户自己负责。\",",
     "new": "    \"tools/scripts/start.ps1 直接起的，名片说了不算。这正是契约 §9 记的那\",\n    \"笔账：平台的启动脚本里写死了这一台引擎的知识。\",\n    \"\",\n    \"⛔⛔ 2026-08-27 更正：这条注释原先写「entry 的 `../../` 就是这笔账的\",\n    \"可见形态 —— 别的引擎入口在自己目录里，只有 GPT-SoVITS 指到平台」。\",\n    \"通用宿主落地之后**那个判别法失效了**：走宿主的引擎（indextts2、以及\",\n    \"_TEMPLATE）entry 也是 `../../lib/engines/host.py`，同样两个点点。\",\n    \"⇒ 别再拿 `../../` 认「谁欠着账」。今天真正的判别法是**有没有 call 段**：\",\n    \"  有 call 段 = 由通用宿主托管（entry 指 host.py，是终局形态）；\",\n    \"  没有 call 段 = 引擎自带常驻服务，自己的入口（本引擎就是这种）。\",\n    \"\",\n    \"⚠ 账本身**一分没还**：infer_server.py 还躺在平台的 lib/inference/ 下，\",\n    \"  它应该搬进 engines/gpt-sovits/。只是这笔账现在不体现在 `../../` 上，\",\n    \"  体现在「入口路径跑出了自己的引擎目录」这件事上。它一天还在，\",\n    \"  账就一天没还完。\",\n    \"\",\n    \"python: 根 venv。Owner 2026-08-24 定案：平台只维护 GPT-SoVITS 这一套\",\n    \"  环境（6.8 GB），其他引擎的环境一概由引擎作者/用户自己负责。\","
    }
   ]
  },
  {
   "path": "engines/indextts2/manifest.json",
   "hunks": [
    {
     "old": "    \"  aux_reference_audio 没有。它只接一条参考音频。\",\n    \"  streaming       没有（capabilities.streaming 也是 false）。\",\n    \"\",\n    \"⭐ 「没写 = 不发」这条规则在这里才显出价值：shim.py:382-392 对不认识\",\n    \"的键**直接 400 并把键名逐个列出来**。搬家前平台按 GPT-SoVITS 的形状\",\n    \"拼请求体，发过来的 text_lang / prompt_text / prompt_lang / speed_factor /\",\n    \"top_k / ... 会被一次性全列成 unknown parameter —— 也就是说，在这一刀\",",
     "new": "    \"  aux_reference_audio 没有。它只接一条参考音频。\",\n    \"  streaming       没有（capabilities.streaming 也是 false）。\",\n    \"\",\n    \"⭐ 「没写 = 不发」这条规则在这里才显出价值：通用宿主\",\n    \"lib/engines/host.py:637-645 对不认识\",\n    \"的键**直接 400 并把键名逐个列出来**。搬家前平台按 GPT-SoVITS 的形状\",\n    \"拼请求体，发过来的 text_lang / prompt_text / prompt_lang / speed_factor /\",\n    \"top_k / ... 会被一次性全列成 unknown parameter —— 也就是说，在这一刀\","
    },
    {
     "old": "\n  \"_comment_payload_keys\": [\n    \"⭐ 允许从合成配置透传给引擎的**引擎原生**键名白名单。\",\n    \"逐条等于 shim.py 的 CALL_TIME_KEYS（shim.py:120-125）——两端各设一道，\",\n    \"这道防「平台乱发」，那道防「名片和 shim 不同步」。\",\n    \"\",\n    \"⛔ 这里不包含 LOAD_TIME_KEYS（use_fp16 / use_cuda_kernel / ...）：\",\n    \"那些只能在引擎进程启动时设，按次发过去 shim 会明确报错而不是假装接受\",\n    \"（shim.py:394-403）。把它们列进来等于骗调用方以为能热切。\"\n  ],\n  \"payload_keys\": [\n    \"emo_alpha\",",
     "new": "\n  \"_comment_payload_keys\": [\n    \"⭐ 允许从合成配置透传给引擎的**引擎原生**键名白名单。\",\n    \"逐条等于下面 params.call_time —— 两端各设一道，\",\n    \"这道防「平台乱发」，那道防「引擎收到不该收的」。\",\n    \"\",\n    \"⭐⭐ 2026-08-27：另一端从前是 shim.py 里手抄的 CALL_TIME_KEYS，\",\n    \"  它自己的注释写着「与 manifest.json 必须一致」——「必须一致」＝\",\n    \"  没有任何东西保证一致。shim.py 删掉之后那份手抄件没了，宿主直接读\",\n    \"  名片的 params.call_time。⇒ 两端同源，不会再分叉。\",\n    \"\",\n    \"⛔ 这里不包含 params.load_time（use_fp16 / use_cuda_kernel / ...）：\",\n    \"那些只能在引擎进程启动时设，按次发过去宿主会明确报错而不是假装接受\",\n    \"（host.py:647-652）。把它们列进来等于骗调用方以为能热切。\"\n  ],\n  \"payload_keys\": [\n    \"emo_alpha\","
    },
    {
     "old": "    \"替它决定 emo_alpha 该是多少 —— 那正是 GPT-SoVITS 那 14 行默认值犯的错，\",\n    \"别在第二台引擎上重犯一遍。\",\n    \"media_type 不写在这里：平台已经通过 maps.media_type 显式送 wav 过去，\",\n    \"而 shim 只认 wav（shim.py:135）。\"\n  ],\n  \"defaults\": {},\n",
     "new": "    \"替它决定 emo_alpha 该是多少 —— 那正是 GPT-SoVITS 那 14 行默认值犯的错，\",\n    \"别在第二台引擎上重犯一遍。\",\n    \"media_type 不写在这里：平台已经通过 maps.media_type 显式送 wav 过去，\",\n    \"而这台引擎只认 wav（下面 output_formats 就是那道闸的判据，\",\n    \"host.py:653-659 「要 mp3 ⇒ 400」）。\"\n  ],\n  \"defaults\": {},\n"
    },
    {
     "old": "\n  \"_comment_call\": [\n    \"⭐ 通用宿主 lib/engines/host.py 全靠这一段才知道怎么调上游。\",\n    \"  每一项的出处都是 engines/indextts2/shim.py 的实际代码，行号在后面。\",\n    \"  ⛔ 改这里等于改「平台怎么调这台引擎」，改完必须重跑 tools/dev/probe_host.py。\",\n    \"\",\n    \"  module / class      shim.py:162\",",
     "new": "\n  \"_comment_call\": [\n    \"⭐ 通用宿主 lib/engines/host.py 全靠这一段才知道怎么调上游。\",\n    \"  每一项的出处都是**已删的** engines/indextts2/shim.py 的实际代码，\",\n    \"  行号在后面。⚠ 那个文件 2026-08-27 随判据 8 删掉了（523 → 0）——\",\n    \"  下面的行号是**存档引文**，不是还能打开的路径。留着是因为「这一项\",\n    \"  当初凭什么这么填」只有它回答得了；照抄一遍到这里等于伪造出处。\",\n    \"  ⛔ 改这里等于改「平台怎么调这台引擎」，改完必须重跑 tools/dev/probe_host.py。\",\n    \"\",\n    \"  module / class      shim.py:162\","
    },
    {
     "old": "    \"    load_time  只能在加载引擎时给。出现在合成请求里 ⇒ 400。\",\n    \"    call_time  允许透传给上游方法。不在这张表里 ⇒ 400（拼错当场抓）。\",\n    \"\",\n    \"  出处：shim.py:116-118（LOAD_TIME_KEYS）、shim.py:121-124（CALL_TIME_KEYS）。\",\n    \"\",\n    \"  ⛔ 同一个名字不能同时出现在两张表里 —— 那样两道 400 会互相打架，\",\n    \"    而且没人说得清改了它到底要不要重启。hostProfile.js 会拒绝装配。\",",
     "new": "    \"    load_time  只能在加载引擎时给。出现在合成请求里 ⇒ 400。\",\n    \"    call_time  允许透传给上游方法。不在这张表里 ⇒ 400（拼错当场抓）。\",\n    \"\",\n    \"  ⭐ 今天读它们的是通用宿主：host.py:637-645（未知键 400）、\",\n    \"    host.py:647-652（加载期参数出现在调用里 400）。\",\n    \"  出处（存档引文，文件已删）：shim.py:116-118（LOAD_TIME_KEYS）、\",\n    \"    shim.py:121-124（CALL_TIME_KEYS）。那两张表当年是**手抄**在\",\n    \"    Python 里的，注释写着「与 manifest.json 必须一致」——\",\n    \"    这一刀之后不用再靠人保证一致：只剩这一份。\",\n    \"\",\n    \"  ⛔ 同一个名字不能同时出现在两张表里 —— 那样两道 400 会互相打架，\",\n    \"    而且没人说得清改了它到底要不要重启。hostProfile.js 会拒绝装配。\","
    }
   ]
  },
  {
   "path": "lib/engines/env_probe.py",
   "hunks": [
    {
     "old": "-------------\n这个文件会被**任意引擎的 venv** 拿去跑（IndexTTS2 的 torch 2.8+cu128、\nGPT-SoVITS 的 2.2+cu121，将来还有别的）。这些环境之间没有共同依赖，\n唯一能指望的就是标准库。这条纪律和 engines/_shim 那份是同一条。\n\n⛔ 不许 import 名片没点名的东西\n-------------------------------",
     "new": "-------------\n这个文件会被**任意引擎的 venv** 拿去跑（IndexTTS2 的 torch 2.8+cu128、\nGPT-SoVITS 的 2.2+cu121，将来还有别的）。这些环境之间没有共同依赖，\n唯一能指望的就是标准库。这条纪律和 `lib/engines/host.py` 那份是同一条 ——\n⚠ 原文写的是「engines/_shim 那份」，那个路径**从来不存在**（是笔误，指的是\n  engines/indextts2/shim.py）；那个文件也已于 2026-08-27 随判据 8 删掉，\n  同一条纪律现在由通用宿主继承。\n\n⛔ 不许 import 名片没点名的东西\n-------------------------------"
    }
   ]
  },
  {
   "path": "lib/engines/host.py",
   "hunks": [
    {
     "old": "把「传话的」那 294 行样板（HTTP 服务、探活、四类 400 校验、wav 头解析、\n推理排队、洗 sys.path）从每台引擎的目录里收上来，只留下名片描述的那部分。\n\n它怎么知道要跑哪台引擎\n----------------------\n⛔ **它不读 `manifest.json`。**\n名片的语义只有一个实现 —— `lib/engines/profile.js`。宿主收的是**已经解析好**\n的 JSON。理由是 `shim.py` 第 106 行那句自白：\n\n    #  2) 参数白名单 —— 与 manifest.json 的 param_keys 必须一致\n    LOAD_TIME_KEYS = frozenset({...})",
     "new": "把「传话的」那 294 行样板（HTTP 服务、探活、四类 400 校验、wav 头解析、\n推理排队、洗 sys.path）从每台引擎的目录里收上来，只留下名片描述的那部分。\n\n✅ 2026-08-27：`engines/indextts2/shim.py`（523 行）**已经删掉了** ——\n契约 §11 判据 8「shim.py 缩到零」结账。判据不是「看着能跑」：\n`tools/dev/run_ab.py` 采四段音频比梅尔差，跨路径 0.00% / 天花板 127.25%，\n5 条判据 5 过；`tools/dev/verify_launch.py` 照平台真实启动路径起了一次\n并真出了声，14 条 14 过。\n⇒ 下面凡是引 `shim.py:NNN` 的地方，都是**已删文件的存档引文**，\n  保留是因为那些行号是当初每一条设计的出处；别去那个路径找它。\n\n它怎么知道要跑哪台引擎\n----------------------\n⛔ **它不读 `manifest.json`。**\n名片的语义只有一个实现 —— `lib/engines/profile.js`。宿主收的是**已经解析好**\n的 JSON。理由是（已删的）`shim.py` 第 106 行那句自白：\n\n    #  2) 参数白名单 —— 与 manifest.json 的 param_keys 必须一致\n    LOAD_TIME_KEYS = frozenset({...})"
    }
   ]
  },
  {
   "path": "lib/engines/hostProfile.js",
   "hunks": [
    {
     "old": "//   `maps`      管第一段：平台的词 → HTTP JSON 的键名。payload.js 在用。\n//   `call.bind` 管第二段：平台的词 → 上游**方法参数**的名字。\n//\n//   在某些引擎上两者恰好长得一样，那是巧合。删掉 shim 之后两段都还在。\n// ⭐ `cwd` 是契约 §5.3 就有的键（那边的例子是 `\"cwd\": \"{engine_dir}\"`），\n//   只是 §5.2 的 python 形态例子里漏了它 —— 键不是新发明的，是补齐。\n//   ⛔ 别跟 `runtime.cwd` 混：那个是「启动器从哪儿 spawn」（§9），",
     "new": "//   `maps`      管第一段：平台的词 → HTTP JSON 的键名。payload.js 在用。\n//   `call.bind` 管第二段：平台的词 → 上游**方法参数**的名字。\n//\n//   在某些引擎上两者恰好长得一样，那是巧合。\n//   ✅ 2026-08-27 shim.py 已删，两段**果然都还在** —— 那不是它带来的。\n// ⭐ `cwd` 是契约 §5.3 就有的键（那边的例子是 `\"cwd\": \"{engine_dir}\"`），\n//   只是 §5.2 的 python 形态例子里漏了它 —— 键不是新发明的，是补齐。\n//   ⛔ 别跟 `runtime.cwd` 混：那个是「启动器从哪儿 spawn」（§9），"
    }
   ]
  },
  {
   "path": "lib/engines/launchPlan.js",
   "hunks": [
    {
     "old": "  // 认自家进程用的记号：调用方拿它去 Contains() 一个进程的命令行。\n  //\n  // 搬家前 start.ps1:149 写死的是文件名 'infer_server.py'。这里给的是\n  // **入口的绝对路径**（小写），理由是文件名会撞：两台引擎的入口都叫\n  // shim.py 是完全可能的（_TEMPLATE 就是这么起名的），而 Test-IsOwnProcess\n  // 的另一半守卫只查「在不在本项目根下」—— 两台自家引擎之间它分不开。\n  // 撞了的后果很具体：IndexTTS2 占着 9880 时，start.ps1 会认为「我的引擎\n  // 已经在跑了」，于是 GPT-SoVITS 永远起不来，而且不报任何错。",
     "new": "  // 认自家进程用的记号：调用方拿它去 Contains() 一个进程的命令行。\n  //\n  // 搬家前 start.ps1:149 写死的是文件名 'infer_server.py'。这里给的是\n  // **入口的绝对路径**（小写），理由是文件名会撞：两台引擎的入口重名是\n  // 完全可能的（当时 _TEMPLATE 教人写 shim.py，撞名几乎是必然），\n  // 而 Test-IsOwnProcess\n  // 的另一半守卫只查「在不在本项目根下」—— 两台自家引擎之间它分不开。\n  // 撞了的后果很具体：IndexTTS2 占着 9880 时，start.ps1 会认为「我的引擎\n  // 已经在跑了」，于是 GPT-SoVITS 永远起不来，而且不报任何错。"
    }
   ]
  },
  {
   "path": "lib/engines/launchPlan.node.test.js",
   "hunks": [
    {
     "old": "})\n\ntest('⛔ launchPlan: 用了 {checkpoints} 却没写 runtime.checkpoints 要抛', () => {\n  // 不抛的话，shim 会收到字面量 \"{checkpoints}\" 并报「目录不存在」——\n  // 那句话会把人引到「权重没下」，而真相是名片少写一行。\n  assert.throws(\n    () => buildLaunchPlan(",
     "new": "})\n\ntest('⛔ launchPlan: 用了 {checkpoints} 却没写 runtime.checkpoints 要抛', () => {\n  // 不抛的话，引擎进程（今天是 lib/engines/host.py）会收到字面量\n  // \"{checkpoints}\" 并报「目录不存在」——\n  // 那句话会把人引到「权重没下」，而真相是名片少写一行。\n  assert.throws(\n    () => buildLaunchPlan("
    },
    {
     "old": "})\n\ntest('⛔ launchPlan: 两台引擎的入口同名时，记号必须仍然分得开', () => {\n  // _TEMPLATE 里入口就叫 shim.py，所以「两台引擎的入口同名」不是假想。\n  // 记号要是只取文件名，start.ps1 会把 B 引擎的进程认成 A 的，于是 A\n  // 永远起不来且不报错。\n  const a = buildLaunchPlan(fakeProfile({\n    id: 'a', dir: path.join(ROOT, 'engines', 'a'), runtime: { entry: 'shim.py' },\n  }), { rootDir: ROOT })\n  const b = buildLaunchPlan(fakeProfile({\n    id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: { entry: 'shim.py' },\n  }), { rootDir: ROOT })\n  assert.notEqual(a.own_process_mark, b.own_process_mark)\n})",
     "new": "})\n\ntest('⛔ launchPlan: 两台引擎的入口同名时，记号必须仍然分得开', () => {\n  // ⚠ 这条的原话是「_TEMPLATE 里入口就叫 shim.py，所以同名不是假想」。\n  //   2026-08-27 那个前提没了：shim.py 已删，模板的入口改成了通用宿主。\n  //   但**这条测试本身没有过期** —— 不由宿主托管、自带服务端的引擎（今天是\n  //   gpt-sovits）仍然写自己的入口文件，重名照样可能发生。下面用 serve.py\n  //   做夹具，就是为了把「同名」这件事和某个具体历史文件解绑。\n  // 记号要是只取文件名，start.ps1 会把 B 引擎的进程认成 A 的，于是 A\n  // 永远起不来且不报错。\n  // ⭐ 走宿主的那一路更狠：不是「可能同名」而是「必然同路径」，由下一条盯着。\n  const a = buildLaunchPlan(fakeProfile({\n    id: 'a', dir: path.join(ROOT, 'engines', 'a'), runtime: { entry: 'serve.py' },\n  }), { rootDir: ROOT })\n  const b = buildLaunchPlan(fakeProfile({\n    id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: { entry: 'serve.py' },\n  }), { rootDir: ROOT })\n  assert.notEqual(a.own_process_mark, b.own_process_mark)\n})"
    }
   ]
  },
  {
   "path": "lib/engines/payload.js",
   "hunks": [
    {
     "old": "//   14 行 `if (payload.x === undefined) payload.x = ...`\n//                                      ← 平台在替 GPT-SoVITS 决定它的默认值\n//\n// 后果是可证的：IndexTTS2 的 shim 对不认识的键**直接 400**\n// （engines/indextts2/shim.py:382-392「未知键拦下不放行」），所以那个\n// GPT-SoVITS 形状的请求体发过去，会被一次性列出二十来个 unknown parameter。\n// 配方能存 indextts2，但调不动 —— 割线就卡在这里。\n//",
     "new": "//   14 行 `if (payload.x === undefined) payload.x = ...`\n//                                      ← 平台在替 GPT-SoVITS 决定它的默认值\n//\n// 后果是可证的：IndexTTS2 对不认识的键**直接 400**\n// （通用宿主 lib/engines/host.py 的 validate_request()：host.py:637-645\n//  「未知键拦下不放行」；⚠ 这个论据搬过家 —— 它原先在\n//  engines/indextts2/shim.py:382-392，2026-08-27 那个文件随判据 8 删掉了，\n//  行为一个字没变，只是从「引擎自己写的」变成「平台所有引擎共用的」），所以那个\n// GPT-SoVITS 形状的请求体发过去，会被一次性列出二十来个 unknown parameter。\n// 配方能存 indextts2，但调不动 —— 割线就卡在这里。\n//"
    },
    {
     "old": " *   4. defaults   只填还没人填过的键\n *\n * 第 3 步为什么不过滤：Owner 2026-08-23 定的规矩 —— 平台只校验格子非空，\n * 不看里面。键名写错了引擎自己会报错，那个报错比我们瞎猜的准（IndexTTS2 的\n * shim 就会把拼错的键名逐个列出来）。平台是搬运工，不是翻译。\n *\n * 第 4 步为什么放在最后而不是最前：defaults 的语义是「没人管的时候用它」，\n * 搬家前那 14 行也是 `if (payload.x === undefined)`。放最前会变成「默认值",
     "new": " *   4. defaults   只填还没人填过的键\n *\n * 第 3 步为什么不过滤：Owner 2026-08-23 定的规矩 —— 平台只校验格子非空，\n * 不看里面。键名写错了引擎自己会报错，那个报错比我们瞎猜的准（宿主\n * 就会把拼错的键名逐个列出来：host.py:638-645 的 unknown parameter(s)）。\n * 平台是搬运工，不是翻译。\n *\n * 第 4 步为什么放在最后而不是最前：defaults 的语义是「没人管的时候用它」，\n * 搬家前那 14 行也是 `if (payload.x === undefined)`。放最前会变成「默认值"
    }
   ]
  },
  {
   "path": "lib/engines/payload.node.test.js",
   "hunks": [
    {
     "old": "})\n\n// ===========================================================================\n//  第二组：IndexTTS2 形状 —— 这一条直接对应 shim.py 的 400\n// ===========================================================================\n\ntest('⭐⭐ IndexTTS2 只收到它认识的键 —— 一个 GPT-SoVITS 的键都没有', () => {",
     "new": "})\n\n// ===========================================================================\n//  第二组：IndexTTS2 形状 —— 这一条直接对应通用宿主的 400\n//  （lib/engines/host.py 的 validate_request()，host.py:637-645。\n//   ⚠ 这个论据 2026-08-27 从 engines/indextts2/shim.py:382-392 搬过来的，\n//     行为一个字没变，实测见 tools/dev/probe_host.py [4] 四类 400）\n// ===========================================================================\n\ntest('⭐⭐ IndexTTS2 只收到它认识的键 —— 一个 GPT-SoVITS 的键都没有', () => {"
    },
    {
     "old": "    interval_silence: 200,\n  })\n\n  // 逐个点名 shim.py:382-392 会拦下来的键，把\"必然 400\"钉死。\n  for (const leaked of [\n    'text_lang', 'prompt_text', 'prompt_lang', 'top_k', 'top_p', 'temperature',\n    'text_split_method', 'batch_size', 'batch_threshold', 'split_bucket',",
     "new": "    interval_silence: 200,\n  })\n\n  // 逐个点名 host.py:637-645 会拦下来的键，把\"必然 400\"钉死。\n  for (const leaked of [\n    'text_lang', 'prompt_text', 'prompt_lang', 'top_k', 'top_p', 'temperature',\n    'text_split_method', 'batch_size', 'batch_threshold', 'split_bucket',"
    },
    {
     "old": "    'aux_ref_audio_paths', 'pron_overrides', 'lang_overrides',\n  ]) {\n    assert.ok(!(leaked in payload),\n      `${leaked} 漏进了 IndexTTS2 的请求体 —— 它的 shim 对未知键直接 400` +\n      '（engines/indextts2/shim.py:382-392），这次调用会整个失败')\n  }\n})\n",
     "new": "    'aux_ref_audio_paths', 'pron_overrides', 'lang_overrides',\n  ]) {\n    assert.ok(!(leaked in payload),\n      `${leaked} 漏进了 IndexTTS2 的请求体 —— 宿主对未知键直接 400` +\n      '（lib/engines/host.py:637-645），这次调用会整个失败')\n  }\n})\n"
    },
    {
     "old": "  const profile = resolveEngineProfile('indextts2', {})\n  for (const loadTimeKey of ['use_fp16', 'use_cuda_kernel', 'use_deepspeed', 'use_accel', 'use_torch_compile']) {\n    assert.ok(!acceptsKey(profile, loadTimeKey),\n      `${loadTimeKey} 是 IndexTTS2 的**加载期**参数（shim.py:115-118），` +\n      '它属于起进程的时候，不属于每一次调用')\n  }\n})",
     "new": "  const profile = resolveEngineProfile('indextts2', {})\n  for (const loadTimeKey of ['use_fp16', 'use_cuda_kernel', 'use_deepspeed', 'use_accel', 'use_torch_compile']) {\n    assert.ok(!acceptsKey(profile, loadTimeKey),\n      `${loadTimeKey} 是 IndexTTS2 的**加载期**参数（名片 params.load_time，` +\n      '宿主的第二道 400 在 lib/engines/host.py:647-652），' +\n      '它属于起进程的时候，不属于每一次调用')\n  }\n})"
    }
   ]
  },
  {
   "path": "lib/routes/synthesis.enginePayload.node.test.js",
   "hunks": [
    {
     "old": "//\n//   ① 请求体拼完之后，这里还会**直接写引擎的键名**再补几刀\n//      （sample_steps / if_sr / speed_factor / media_type / streaming_mode）。\n//      对一台不认识这些键的引擎，IndexTTS2 那种严格的 shim 会当场 400，\n//      宽松的会静默忽略 —— 后者更糟。\n//\n//   ② ⛔ 更要命的：调 gsvPost / gsvStream 时**根本没带地址**。配方明明写了",
     "new": "//\n//   ① 请求体拼完之后，这里还会**直接写引擎的键名**再补几刀\n//      （sample_steps / if_sr / speed_factor / media_type / streaming_mode）。\n//      对一台不认识这些键的引擎，通用宿主（lib/engines/host.py:637-645）会当场 400，\n//      宽松的会静默忽略 —— 后者更糟。\n//\n//   ② ⛔ 更要命的：调 gsvPost / gsvStream 时**根本没带地址**。配方明明写了"
    },
    {
     "old": "  // \"问名片要\"produce 出一样的东西 —— 测试当时测了个寂寞。\n  //\n  // 真实世界里这台引擎是存在的：只吐一种格式、没有 media_type 这个参数的\n  // TTS 服务很常见（IndexTTS2 的 shim 就只认 wav）。给它塞一个 media_type\n  // 就是一次必然失败的调用。\n  const NO_MEDIA = { ...LEAN, id: 'engine-nomedia', base_url: 'http://127.0.0.1:9882',\n    maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed' } }",
     "new": "  // \"问名片要\"produce 出一样的东西 —— 测试当时测了个寂寞。\n  //\n  // 真实世界里这台引擎是存在的：只吐一种格式、没有 media_type 这个参数的\n  // TTS 服务很常见（IndexTTS2 的名片 output_formats 就只写了 wav）。给它塞一个 media_type\n  // 就是一次必然失败的调用。\n  const NO_MEDIA = { ...LEAN, id: 'engine-nomedia', base_url: 'http://127.0.0.1:9882',\n    maps: { text: 'text', reference_audio: 'ref_audio_path', seed: 'seed' } }"
    }
   ]
  },
  {
   "path": "server.js",
   "hunks": [
    {
     "old": "  // 补一次是因为白名单那一段会把空串/null 过滤掉，而布尔 false 必须显式送达\n  // （不发和发 false 在引擎那边是两件事）。\n  // ⭐ 第 1c 步加了名片门控：这台引擎的 payload_keys 上没有这个键就不发 ——\n  //   IndexTTS2 的 shim 对不认识的键直接 400，硬塞过去等于必然失败。\n  // ⭐ C11：原来这里写死补 [\"sample_steps\",\"if_sr\"] 两个键 —— 那是 GPT-SoVITS\n  //   的私有参数名。现在补的是「这台引擎名片上声明的全部旋钮」，所以下游引擎\n  //   的布尔参数不会再在这一行上被静默丢掉。",
     "new": "  // 补一次是因为白名单那一段会把空串/null 过滤掉，而布尔 false 必须显式送达\n  // （不发和发 false 在引擎那边是两件事）。\n  // ⭐ 第 1c 步加了名片门控：这台引擎的 payload_keys 上没有这个键就不发 ——\n  //   通用宿主对不认识的键直接 400（lib/engines/host.py:637-645），\n  //   硬塞过去等于必然失败。\n  // ⭐ C11：原来这里写死补 [\"sample_steps\",\"if_sr\"] 两个键 —— 那是 GPT-SoVITS\n  //   的私有参数名。现在补的是「这台引擎名片上声明的全部旋钮」，所以下游引擎\n  //   的布尔参数不会再在这一行上被静默丢掉。"
    }
   ]
  },
  {
   "path": "tools/dev/ab_capture.py",
   "hunks": [
    {
     "old": "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\"\"\"ab_capture —— 给 ab_compare 采四段音频，且**不许采错**\n\n用法（两条路径各起一台，各跑一次；两次的 text/ref/seed 必须一模一样）：\n",
     "new": "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\"\"\"ab_capture —— 给 ab_compare 采四段音频，且**不许采错**\n\n⛔⛔ 2026-08-27：`--role shim` 那一半已经没有对象了 —— engines/indextts2/shim.py\n   随契约 §11 判据 8 删掉了（523 → 0）。这个脚本连同 run_ab.py 一起退休，\n   留着是因为 §11 拿它们的读数结账，判据的出处不能是空气。详见 run_ab.py 抬头。\n   ⚠ `--role host` 那一半技术上还能单跑，但**单侧采样不构成任何判据** ——\n     A/B 的全部意义就是两侧对比。要验 host 一侧，用 tools/dev/verify_launch.py。\n\n用法（两条路径各起一台，各跑一次；两次的 text/ref/seed 必须一模一样）：\n"
    },
    {
     "old": "    ap.add_argument(\"--out\", default=os.path.join(\"outputs\", \"ab\"))\n    ap.add_argument(\"--timeout\", type=float, default=600.0,\n                    help=\"单次请求超时（秒）；TTS 慢，默认给 600\")\n    ap.add_argument(\"--altered-param\", default=\"emo_alpha\",\n                    help=\"天花板那段改哪个参数（默认 emo_alpha）\")\n    ap.add_argument(\"--altered-value\", default=\"0.3\",\n                    help=\"改成什么值（默认 0.3）\")\n    ap.add_argument(\"--force\", action=\"store_true\",\n                    help=\"覆盖已有文件（⚠ 覆盖后两侧都要重采）\")\n    args = ap.parse_args(argv)",
     "new": "    ap.add_argument(\"--out\", default=os.path.join(\"outputs\", \"ab\"))\n    ap.add_argument(\"--timeout\", type=float, default=600.0,\n                    help=\"单次请求超时（秒）；TTS 慢，默认给 600\")\n    # ⛔ 出厂默认原先是 emo_alpha=0.3，那是**坏的默认值**：真机实测天花板那段\n    #   和 shim-a **逐字节相同**（差 0%）。原因在上游 —— infer_v2.py:428-433\n    #   无条件覆写 emo_alpha，名片传什么都不算数。\n    #   天花板差 0% ⇒ 阈值在放行一切 ⇒ 全绿是空转。所以默认值必须换成一个\n    #   在当前配置下**真的起作用**的参数。max_text_tokens_per_segment=4 实测\n    #   把 3.15s 变成 6.80s、梅尔差 127.25%，闸门当场证明自己有分辨力。\n    ap.add_argument(\"--altered-param\", default=\"max_text_tokens_per_segment\",\n                    help=\"天花板那段改哪个参数（默认 max_text_tokens_per_segment）\")\n    ap.add_argument(\"--altered-value\", default=\"4\",\n                    help=\"改成什么值（默认 4）\")\n    ap.add_argument(\"--force\", action=\"store_true\",\n                    help=\"覆盖已有文件（⚠ 覆盖后两侧都要重采）\")\n    args = ap.parse_args(argv)"
    }
   ]
  },
  {
   "path": "tools/dev/measure_manifest_reads.cjs",
   "hunks": [
    {
     "old": "//    于是从头到尾没进过被测对象：既不在「活」里也不在「死」里，**凭空消失**。\n//    量法把被测对象改掉，量出来的就不是被测对象的账。\nm.runtime = m.runtime || {}\nif (!m.runtime.entry) m.runtime.entry = 'shim.py'\nif (!m.runtime.ready_endpoint) m.runtime.ready_endpoint = '/ready'\nif (!m.maps || !m.maps.text) m.maps = Object.assign({ text: 'text' }, m.maps || {})\n",
     "new": "//    于是从头到尾没进过被测对象：既不在「活」里也不在「死」里，**凭空消失**。\n//    量法把被测对象改掉，量出来的就不是被测对象的账。\nm.runtime = m.runtime || {}\n// ⚠ 2026-08-27 起模板自己就带 entry（指向通用宿主），这行兜底基本不会触发。\n//   值跟着改是为了：万一它触发了，量出来的也不是一个已经不存在的形状。\nif (!m.runtime.entry) m.runtime.entry = '../../lib/engines/host.py'\nif (!m.runtime.ready_endpoint) m.runtime.ready_endpoint = '/ready'\nif (!m.maps || !m.maps.text) m.maps = Object.assign({ text: 'text' }, m.maps || {})\n"
    }
   ]
  },
  {
   "path": "tools/dev/probe_new_engine.cjs",
   "hunks": [
    {
     "old": "  if (keyPath.startsWith('maps.')) return leaf\n  if (keyPath.startsWith('capabilities.')) return false\n  if (leaf === 'python') return '.venv/Scripts/python.exe'\n  if (leaf === 'entry') return 'shim.py'\n  if (leaf === 'ready_endpoint') return '/health'\n  if (leaf === 'module') return 'os'\n  if (/base_url/.test(leaf)) return 'http://127.0.0.1:19999'",
     "new": "  if (keyPath.startsWith('maps.')) return leaf\n  if (keyPath.startsWith('capabilities.')) return false\n  if (leaf === 'python') return '.venv/Scripts/python.exe'\n  // ⚠ 模板自己带 entry（指向通用宿主），这条兜底基本不会触发。\n  //   2026-08-27 值跟着改：别拿一个已经不存在的形状当占位。\n  if (leaf === 'entry') return '../../lib/engines/host.py'\n  if (leaf === 'ready_endpoint') return '/health'\n  if (leaf === 'module') return 'os'\n  if (/base_url/.test(leaf)) return 'http://127.0.0.1:19999'"
    }
   ]
  },
  {
   "path": "tools/dev/run_ab.py",
   "hunks": [
    {
     "old": "# -*- coding: utf-8 -*-\n\"\"\"run_ab —— 一条命令跑完整个 shim vs host 的 A/B 验收\n\n    python tools/dev/run_ab.py\n",
     "new": "# -*- coding: utf-8 -*-\n\"\"\"run_ab —— 一条命令跑完整个 shim vs host 的 A/B 验收\n\n⛔⛔ 2026-08-27：**这个脚本已经跑不了了，而且是故意的。**\n   它比的是 engines/indextts2/shim.py 和 lib/engines/host.py，而 shim.py\n   在同一天随契约 §11 判据 8 删掉了（523 → 0）。⇒ 老路径那一侧不存在了。\n\n   ⭐ 为什么不一起删：契约 §11 判据 8 拿它的读数结账。判据的可信度来自\n     「量了什么、阈值多少、天花板证明了阈值有分辨力」—— 那些只有这份源码\n     说得清。删了它，§11 就变成一句没有出处的自我宣称。\n   ⚠ 但也别指望重跑：shim 那一侧永久消失了，**这次判决不可复现**。\n     不可复现是这一刀的必然代价，不是这个脚本的缺陷。\n\n   ⭐ 还活着的两个：\n     tools/dev/verify_launch.py   照平台真实启动路径起引擎并真出声（14 条）\n     tools/dev/ab_compare.py      纯离线比两段音频，跟 shim 没关系，随时能用\n\n   最后一次真机读数（2026-08-27，Owner 的机器）：\n     地板   梅尔相对差 0.00%   时长差 0.00%\n     跨路径 梅尔相对差 0.00%   时长差 0.00%    ← 判据本体\n     天花板 梅尔相对差 127.25% 时长差 116.25%  ← 证明 5% 这个阈值分得出差别\n     结账：5 条，5 过。判决：host.py 可以替代 shim.py\n\n    python tools/dev/run_ab.py\n"
    }
   ]
  }
 ],
 "deletes": [
  {
   "path": "engines/indextts2/shim.py",
   "why": "判据 8 的正主：523 行引擎专属胶水，已被 lib/engines/host.py 完全取代",
   "sha": "f5721e940ca34876d36c08177db04bf1caa6d0d6501769e807efeede08622aed",
   "bytes": 22638
  },
  {
   "path": "engines/indextts2/manifest.json.bak-call-cwd",
   "why": "上一刀留下的备份，正本已验过",
   "sha": "4b140ca7e58ebe9b70d15552938834bd42207c0f98cc9f01394578fa4781f5fe",
   "bytes": 12396
  },
  {
   "path": "lib/engines/host.py.bak-call-cwd",
   "why": "同上",
   "sha": "37818583ed96e80b2d8d1ee37c8ce20f9b343eac22e6a2c1bcc8c6710d227b93",
   "bytes": 32477
  },
  {
   "path": "lib/engines/hostProfile.js.bak-call-cwd",
   "why": "同上",
   "sha": "2e4379a4023873cdd8104a3d912e48a4104b10d3d3ea37f1272811e145b6e22c",
   "bytes": 8559
  }
 ]
}
""")


def read(p):
    """读成 \\n 文本，同时记住它原来的换行形态。"""
    b = open(p, 'rb').read()
    crlf = b.count(b'\r\n')
    lf = b.count(b'\n') - crlf
    return b.decode('utf-8').replace('\r\n', '\n'), ('\r\n' if crlf > lf else '\n')


def write(p, text, nl):
    if nl == '\r\n':
        text = text.replace('\n', '\r\n')
    with open(p, 'wb') as f:
        f.write(text.encode('utf-8'))


def main(argv=None):
    ap = argparse.ArgumentParser(prog='apply_shim_removal')
    ap.add_argument('--check', action='store_true', help='只看不写')
    args = ap.parse_args(argv)

    print('apply_shim_removal —— 删掉 shim.py 并结掉判据 8')
    print('  仓库根 %s' % ROOT)
    print('  模式   %s' % ('只看不写（--check）' if args.check else '真写'))
    print('=' * 74)

    problems = []
    staged = []          # (abs_path, new_text, nl, path, applied, already)
    del_plan = []        # (path, action, note)

    # ---- 一、正文 hunk ----------------------------------------------------
    for entry in DATA['patches']:
        rel = entry['path']
        p = os.path.join(ROOT, *rel.split('/'))
        if not os.path.isfile(p):
            problems.append('%s —— 文件不在。补丁是对着 2026-08-27 的树写的，'
                            '对不上就别硬打' % rel)
            continue
        text, nl = read(p)
        applied = already = 0
        bad = False
        for i, h in enumerate(entry['hunks']):
            old, new = h['old'], h['new']
            # ⛔⛔ 顺序很要紧：**先问「打过没有」，再问「锚点在不在」**。
            #   很多 hunk 是纯插入 —— new 里**整段包含** old。要是先按
            #   old 命中就打，第二次跑会再插一遍，把文件插烂。
            #   试打时这条真的翻车了（第二次跑又「写了 1 处」），才改成这样。
            if text.count(new) >= 1:
                already += 1
                continue
            c = text.count(old)
            if c == 1:
                text = text.replace(old, new, 1)
                applied += 1
            else:
                head = old.split('\n')[0].strip()[:64]
                problems.append('%s 第 %d 处 —— 锚点命中 %d 次（要 1 次），'
                                '也不像已经打过。锚点首行：%s'
                                % (rel, i + 1, c, head))
                bad = True
        if not bad:
            staged.append((p, text, nl, rel, applied, already))

    # ---- 二、删文件 --------------------------------------------------------
    for d in DATA['deletes']:
        rel = d['path']
        p = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(p):
            del_plan.append((rel, 'skip', '已经删过了'))
            continue
        sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        if sha != d['sha']:
            problems.append('%s —— 内容和我手里的快照对不上（sha %s… vs %s…）。'
                            '有人改过它 ⇒ 我不替你删，你先看一眼'
                            % (rel, sha[:12], d['sha'][:12]))
            continue
        del_plan.append((rel, 'delete', '%d 字节 · %s' % (d['bytes'], d['why'])))

    # ---- 三、全有或全无 ----------------------------------------------------
    if problems:
        print()
        print('⛔ 对不上，一个字都没写：')
        print()
        for m in problems:
            print('   - %s' % m)
        print()
        print('   多半是这棵树和补丁写的时候不是同一版。')
        print('   处置：把这几个文件当前的样子发出来，我按你的版本重出锚点。')
        print('   ⛔ 别用整文件覆盖顶上去 —— 那会把上一刀的接线静默回滚掉。')
        return 1

    n_new = sum(s[4] for s in staged)
    n_old = sum(s[5] for s in staged)
    for p, text, nl, rel, applied, already in staged:
        tag = '打了 %d 处' % applied if applied else ''
        if already:
            tag += ('，' if tag else '') + '%d 处早就打过了' % already
        print('  %-46s %s' % (rel, tag or '没什么可打的'))
        if not args.check and applied:
            write(p, text, nl)

    print('-' * 74)
    for rel, action, note in del_plan:
        if action == 'delete':
            print('  删 %-44s %s' % (rel, note))
            if not args.check:
                os.remove(os.path.join(ROOT, *rel.split('/')))
        else:
            print('  － %-44s %s' % (rel, note))

    n_del = sum(1 for _, a, _ in del_plan if a == 'delete')
    print('=' * 74)
    if args.check:
        print('结账：%d 处待打、%d 个文件待删（--check 没写盘）。'
              '去掉 --check 再跑一次。' % (n_new, n_del))
        if n_old:
            print('      另有 %d 处早就是目标形态了 —— 幂等，不会重复插入。' % n_old)
        return 0

    print('结账：写了 %d 处，删了 %d 个文件' % (n_new, n_del))
    if n_old:
        print('      另有 %d 处早就是目标形态，跳过了。' % n_old)
    print()
    print('⭐⭐ 判据 8 的量化形态：engines/indextts2/shim.py  523 行 → 0')
    print()
    print('下一步，三条，按顺序 —— ⛔ 少一条都不算数：')
    print()
    print('    node tools\\run_tests.cjs')
    print('    node lib\\engines\\engine-launch-plan.cjs --engine indextts2')
    print('    python tools\\dev\\verify_launch.py')
    print()
    print('  第一条：⭐ **先看 tests 总数，应当仍是 839**，然后才看 fail 0。')
    print('          总数掉了说明有测试没被跑到 —— 那种「全绿」是空的。')
    print('          这一刀改了 launchPlan.node.test.js 的两条注释和一个夹具')
    print('          （入口从 shim.py 换成 serve.py），条数不该变。')
    print('  第二条：entry 仍指向 lib\\engines\\host.py，args 里仍带 --profile-json。')
    print('  第三条：⛔⛔ **删掉 shim.py 之后必须再验一次真出声**。')
    print('          判据 5 写死了：测试全绿不等于能出声。前两条都是静态的。')
    print('          14 条应当全过，其中「同 seed 两次 ⇒ 字节完全相同」是核心。')
    print()
    print('  ⚠ 顺带说一句 run_ab.py：它比的是 shim 和 host，shim 没了 ⇒ **它')
    print('    永久跑不了了**，脚本里已经盖了退休章。没删它是因为契约 §11')
    print('    拿它的读数结账 —— 删了，判据就成了没有出处的自我宣称。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
