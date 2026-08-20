# SCOPE — 目录重整（r12c）

> 版本：**v2 / 2026-08-20**（v1 = 2026-08-19）
> 项目：aurivox@1.0.8 / `D:\Project\tts_broker_openai_compat` / 分支 `dev`
> 用途：**防漂移锚点**。任何一步动手之前先回来对一次；本文档没写的事情，这一轮就不做。

## v2 改了什么（先说偏差，别让锚点自己漂）

v1 是文档、实施是补丁，两边在 batch12 之后分了家。三处已回写：

1. **§3 的 Batch 1 / Batch 2 分章作废** —— Owner 2026-08-19 决定「和 batch2 合成一轮」，
   实际交付的 `apply-r12c-batch12.py` 就是合并后的。v1 一直是合并前的写法。
2. **§4.B 里 `tools\runtime\{python,node}` → `vendor\` 本轮不做，挪到 Batch 5**。
   助手在 batch12 的补丁头部单方面写了「不做」，**但从没回到本文档、也没告知 Owner** ——
   于是「完成判据 2」永远不可能成立，而这份文档的用途正是防漂移。
   **纪律：补丁头部的「本轮不做」清单必须同步回写 SCOPE，写在补丁注释里不算告知。**
3. **完成判据 1 改写**。v1 写死「396 pass」，实际搬家后测试总数变成 408 → 412，
   因为 `run_tests.cjs` 新收了 `engines/`、`pipeline/` 两棵树，batch13 又加了 4 条守卫。
   **「测试数应为某个常数」正是本项目明令禁止的判据形态**（判据不能随磁盘状态漂移）。

## 1. TARGET（终局目标）

> **兼容一切 TTS 的 flow。**

可验收的形式：

> **加一个新引擎 = 新建 `engines\<id>\` 一个目录 + 写一个 `manifest.json`。
> `lib\`、`server.js`、`web\` 一个字都不用改。**

反面表述（任何一条成立即未达标）：

- 加引擎需要改 `server.js`
- 加引擎需要改 `lib\flowgraph\adapter.js`
- 加引擎需要改 `lib\training\` 下任何文件
- 加引擎需要在 `web\` 里加分支
- 加引擎的人需要读 `pipeline\` 下的代码才知道怎么打标 / 切片

## 2. 不变量：顶层目录的定义

**这一节是判据，不是现状描述。** 现状与本节冲突时，改现状。

| 目录 | 一句话定义 | 判据 |
|---|---|---|
| `engines\` | 能选的 TTS 引擎，一个目录一个引擎 | 换引擎时**跟着换** |
| `pipeline\` | 打标 / 分离 / 切片，所有引擎共用 | 换引擎时**不换**，但属于第三方代码 |
| `models\` | 全部权重 | 是二进制权重；能重新下载 |
| `vendor\` | 第三方**成品** | 下下来原封不动就能跑，我们**没改过一行** |
| `data\` | **用户的东西** | 用户编辑过；删了要不回来 |
| `lib\` `server.js` `web\` | 我们自己的服务端与界面 | 上游根本不知道它存在 |

辅助判据：

1. **`LOCAL-CHANGES.md` 的有无** = 「我们改过上游」的物证 → 有则不是 `vendor\`
2. **能否一键重新下载** → 能则 `vendor\` / `models\`；不能则 `data\`
3. **`engines\` 下的目录数 = 支持的引擎数**（工具类放进去会毁掉这个性质）

⭐ **v2 补一条**：上表只定义了 6 类共 7 个顶层目录，而根目录实际有 20+ 个条目。
其余条目（`assets` `cache` `docs` `tools` `dist` `logs` `outputs` `node_modules`
`venv` `THIRD_PARTY_LICENSES` `.git` `.hermes` `.staging`）**过去一条判据都没有** ——
谁往根上放个新目录都不会有任何东西报警。batch14 起，完整准入表在
**`docs/ROOT_LAYOUT.md`**，由 `lib/root_layout.node.test.js` 解析并强制。

## 3. 批次

| 批 | 内容 | 状态 |
|---|---|---|
| Batch 0 | 词典回迁 / C7 收口 / 配置写回 / 根 `GPT_SoVITS\` 移出 | ✅ 完成 |
| Batch 1+2（合并交付 = `apply-r12c-batch12.py`） | 搬家（`vendor\{tts,asr,uvr5,slicer}` → `engines\`+`pipeline\`）、`lib\paths.js` 路径权威、引擎注册表、`manifest.json`、11 条守卫 | ✅ 真机已应用 |
| Batch 3 | 用 IndexTTS2 验证契约：只新建 `engines\indextts2\` + 写 manifest | ⬜ 未开工（目录在，刻意只有 `README.md`+`setup.bat`，无 manifest ⇒ 注册表看不见它 ⇒ 表现为「没装」） |
| Batch 4（`apply-r12c-batch13.py` + `apply-r12c-batch14.py`） | 根目录收尾：缓存归 `cache\`、助手产出物归 `tools\dev\`、死树归档、准入表 + 反向白名单守卫 | 🔄 batch13 ✅ / batch14 本轮 |
| **Batch 5（新增）** | `tools\runtime\{python,node}` → `vendor\`（19+ 处 `.bat`/`.ps1` 引用，在启动链上）；`.hermes\` 去留；`tools/checks/check_*.py` 里那批陈旧 `gsv-tools` 路径 | ⬜ 未开工 |

## 4. Batch 4（batch14 本轮）做什么

**A. 归档三棵死树到 `..\junk\`**（不是 `rmdir /s /q`，判据还能回来）

| 目录 | 大小 | 放行依据（**内容判据，不只是大小**） |
|---|---|---|
| `vendor\gsv-tools\` | 2.9GB | 主体 `model.bin` 在 `models\asr\faster-whisper\large-v3\` 有确认副本；2026-08-20 全树采集只捞到 HF 缓存元数据 |
| `vendor\gsv_code\` | 920MB | 744MB 孤儿 `.pth` 已证实是训练中断的截断文件；4 个词典已回迁 `engines\gpt-sovits\gsv_code\text\`。⚠ 它与活着的 `engines\gpt-sovits\gsv_code\` **同名**：全树 106 处 `from gsv_code...` 靠 `infer_server.py:51` 的 `sys.path.insert(0, GSV_DIR)` 解析，vendor 那棵从不在 `sys.path` 上；但只要有人把 `vendor\` 加进 path 就会导入错的那棵 —— 归档同时消掉这个遮蔽隐患 |
| `vendor\gsv-infer\` | 584KB | CUDA 编译残留（空 `build\` 目录）；活的 BigVGAN 在 `engines\gpt-sovits\infer\BigVGAN\` |

全仓 grep 确认：**无任何活代码 require/import 这三棵树**（命中全在注释、
`LOCAL-CHANGES.md`、`04_pack_release.py` 的排除表里）。

**B. 顶层 `GPT_SoVITS\` 有条件归档** —— 补丁自己扫，扫到 `.py`/`.js` 就不动并如实报告。
`.gitignore` 把它整棵 ignore，**「源码包里零文件」只说明它不进包，不说明盘上没源码**。

**C. `.gitignore` 收口 5 条**：2 条陈旧例外（`!/vendor/tts/`、`!/vendor/gsv-tools/`）
+ 3 条对 `pipeline/` 的**空操作**例外（它们是为抵消 `/vendor/*` 写的，可 `pipeline/`
不被任何规则排除，搬家后一直没有作用）。`GPT_SoVITS/` 那行**刻意保留**：
规则在、目录不在，是为了防止权重被重新下回原位后进 git。

**D. 根目录守卫改反向白名单**（见 `docs/ROOT_LAYOUT.md`）。

## 5. 完成判据

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 测试**总数不低于上一轮**，且 `fail = 0`，且 `engines\`+`pipeline\` 下的测试文件数与搬走的数量对得上 | `node tools\run_tests.cjs`。⛔**不写死常数** —— 判据不能随磁盘状态漂移 |
| 2 | `vendor\` 下只剩 `ffmpeg` `micromamba`（`python`/`node` 见 Batch 5） | `dir /b vendor` |
| 3 | `engines\` 下只有 `gpt-sovits` `indextts2` `_TEMPLATE` | `dir /b engines` |
| 4 | 全仓 grep 不到活代码引用 `vendor/tts`、`vendor/asr`、`vendor/uvr5`、`vendor/slicer` | 注释与文档里的命中不算 |
| 5 | **真机能起服务、能合成一段音频** | ⭐ **这条是第一道判据，不是最后一道**。搬家改的正是运行时才解析的东西；`lib\inference\infer_server.py` 不在任何 JS 测试覆盖面内，曾表现为「407 测试全绿但服务起不来」 |
| 6 | 根目录无未登记条目 | `node tools\run_tests.cjs` 里的根布局守卫（准入表 = `docs/ROOT_LAYOUT.md`） |

## 6. 纪律（沿用，不因本轮放宽）

- 判据**不能随磁盘状态漂移**（「文件数应为 480」「测试数应为 396」都不是判据）
- 验证基线是**Owner 那棵树**；助手沙箱里的复刻件**不是判据**
- 「通过」和「根本没运行」长得一样的测试等于没测
- 探针必须带**反例守卫**（先证明它会失败）+ 正对照
- 代码改动一律走 `apply-*.py`：默认 dry-run / `--write` 留备份 / `--restore` / `--selftest`
- 给 Owner 的命令**不带尾部注释**（`cmd.exe` 会把 `#` 当参数）
- 提目录一律写**全路径**
