# 引擎接入 —— 现状台账

> **本文件是进度的唯一真相。** 做完一刀，当场改下面那张表的「状态」格。
> ⛔ 不许把状态记在别处（记忆、聊天、口头）——那些地方与仓库分叉过一次，
> 代价是整节契约被自己推翻重推。
>
> **2026-10-04 全文复核过一遍**：§3b 的偏差表已订正、新增 §3c（开发平台换成 Arc）、
> C1 补了「A 级判据不够」那条实测。其余各行未动。
>
> 前身 `docs/ENGINE_CONTRACT.md`（3080 行）随「契约退休」删除
> （`c3f0ae8`）。那份是**规范**，本份是**进度**。规范没了、进度还在，
> 所以本文件不重复规范内容，只回答两件事：**现在在哪**、**下一刀是什么**。

## 怎么读这份文件

| 你想知道 | 读哪 |
|---|---|
| 这个项目要做什么 | [`../docs/IDEA.md`](../docs/IDEA.md) |
| 现在的进度、下一刀 | 本文件 |
| 引擎抽象层长什么样 | [`ENGINE_ONBOARDING_CONTRACT.md`](./ENGINE_ONBOARDING_CONTRACT.md)（为什么是这样）· `lib/engines/*.js` 的文件头注释（那里是最新的） |
| **怎么装一个引擎** | [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md) 操作手册 · [`../engines/_TEMPLATE/manifest.json`](../engines/_TEMPLATE/manifest.json) 逐字段注释 |

⚠️ **口径**：下面每一条都标注了**证据来源**。
`[实测]` = 我在这台机器上跑出来的；`[读码]` = 从代码读出来的，**未实机验证**。
两者混为一谈是本项目反复付学费的同一种缺陷，所以这里分开标。

---

## 0. 目标

兼容全部 TTS。验收形式：**加一个引擎 = 一个目录 + 一张名片，
`lib/` / `server.js` / `web/` 一个字不改。**

**这个目标今天达成了多少**：推理链 ✅（见下），训练链 ⬜（绑死 GSV）。

---

## 1. 抽象层：已经建成的部分

| 机制 | 文件 | 状态 |
|---|---|---|
| 目录即注册（不写死引擎名） | `lib/engines/registry.js` | ✅ |
| 一份 `parameters[]` 派生 5 份视图 | `lib/engines/parameterDeclaration.js` | ✅ IndexTTS2 已迁 |
| 平台词表 → 引擎方言（`maps`） | `lib/engines/payload.js` | ✅ |
| 通用 Python 宿主（`python` / `cli` 两种形态） | `lib/engines/host.py` | ✅ 1082 行 |
| 进程看管（用到才起 / 空闲就放） | `lib/engines/supervisor.js` + `residency.js` | ✅ |
| 内存判据（实测优先，`cap` 仅兜底） | `lib/engines/memprobe.js` + `memledger.js` | ⚠️ `cap` 仍在当法官（B3） |
| 前端按名片长面板 | `web/src/lib/engines.js` | ✅ 82 条真函数测试 |
| 顶层键白名单（不认识就抛） | `lib/engines/profile.js:294` | ✅ 23 键 |
| 第一道校验「装得上」 | `lib/engines/envCheck.js` 浅层 | ✅ |
| 第二道校验「起得来」 | `lib/engines/envCheck.js` 深层 | ✅ |
| **第三道校验「出得了声」** | — | ⬜ **B4，唯一关键路径欠账** |

### ⭐ 一条纪律（比任何单点能力都重要）

`registry.js` / `payload.js` / `profile.js` / `web/src/lib/engines.js`
**四个文件里不许出现任何具体引擎名**，各有守卫测试盯着。
判据：**装一台谁都没见过的引擎，这些文件一个字都不用改。**

`fakeEngine.node.test.js` 用一台参数叫 `wobble` / `flavour` / `goose_count` 的
假引擎走完整条链路——平台但凡还有一处写死，当场就长歪。

⚠️ **例外（必须知道）**：`lib/training/` 那一整套（人声分离 / 切片 / ASR / S1 / S2）
**不是薄的**，它绑死 GSV（见 C3）。接新 TTS 走推理链，碰不到它；
但「兼容全部 TTS」这个承诺在训练侧**没有兑现**。

---

## 2. 进度表

### A 组 · 引擎接入

| # | 事项 | 状态 | 证据 | 备注 |
|---|---|---|---|---|
| **A1** | 参数草稿生成器 | ✅ **2026-09-04 已建** | [实测] `tools/scaffold-params.cjs` + `lib/engines/reflect_params.py`；拿 IndexTTS2（人已手写 14 条）当标准答案：**漏 0、误排 0、类型 13/14 一致** | 剩下 1 处分歧（`emo_audio_prompt` 真人写 select+audio 源，生成器给 text）是**人工判断**，不是缺陷。⚠ 它生成**草稿**，`min/max/label/help/only_when` 反射拿不到，仍要人核对 |
| **A2** | `engines/_TEMPLATE/` | ✅ **2026-09-04 已建** | [实测] 模板 + README；**经平台自己的 registry/profile/hostProfile 校验通过**；14 种「照着填错」变体逐一验过反应 | 目录名下划线开头 ⇒ `registry.js:83` 跳过，不会被当成真引擎 |
| **A3** | onboarding 契约成文 | ✅ **2026-09-04 已建** | [实测] `docs/ENGINE_ONBOARDING_CONTRACT.md`（11 节，每条标 [实测]/[读码]） | 是**已实现行为的说明书**，不是规范。A1 的规格书 |
| **A4** | GSV 迁新版声明 | ⬜ **待开** · 🔴 `engines/gpt-sovits/**` | [实测] GSV 无 `call` 段，`runtime.entry` = `lib/inference/infer_server.py` | **平台今天有两套推理实现并存**。高成本，不阻塞接新引擎 |
| **A4'** | ⭐ **`installPlan.js` 整体退役**（Owner 2026-10-04 裁决，走 **B 方案**）| ✅ **2026-10-04 已退役**（`b5f20c8` 等）· 顺带补了 `tools/engine-checkpoints.cjs` | [实测] `lib/engines/installPlan.js` + `installPlan.node.test.js` + `tools/install-engine.cjs` **三个文件已删**；`tools/engine-checkpoints.cjs` 是从 `install-engine.cjs` 劈出来活下来的那一半 | ⛔ **理由不是「顺序排错」，是前提被证伪**（详见 §2.6）。⚠️ **代价：拉源码这条路今天没有可用工具** —— 向导未提交，且缺「钉版本 + 删 `.git`」那一步（见 A4''）。⚠️ 顺带丢了 `install.env_command` 的**平台侧 parse 期校验**（`parseInstall` 随文件走了），现在只有执行它的向导 `env.js` 在动手前校验 |
| **A5** | `input.text.parameter` 落地 | ⛔ **实测不可做** | [实测] `deriveTextBinding` 实现是 `{...m, maps:{text:p}}` ⇒ **maps 被整体替换** | 只能表达「只有一个输入概念」的引擎。GSV 有 10 个映射、IndexTTS2 有 4 个，**两台都无法用 input 表达**。要么扩语法，要么承认为死胡同 |
| **A4''** | ⭐ **向导补「钉版本 + 删 `.git`」**（A4' 退役的**直接后果**）| ⬜ **待开** · 🔴 `core/pin.js`（wizard） | [读码] 2026-10-04 通读 `tools/engine-wizard/core/clone.js`：它 `git clone` 后**不删 `.git`、不 pin**；`core/env.js` 也不碰版本 | ⛔ **这是 A4' 之后唯一挡在「版本可追溯」前面的东西**。今天的状态是「版本有两个来源（`.git` 里的分支名 + 名片里可能为 null 的 `commit`），且都不权威」。⚠️ 与 §6.1「commit 必不填」是同一笔账的两面：**commit 在第 4 步才产生 ⇒ pin 必须能被推迟到第 4 步之后**，而旧 `installPlan.js:78` 的硬拦时机是「装之前」，对不上 |
| **A6** | ⭐ **权重路径搬迁**：`models/tts/`（20G）→ `engines/<id>/checkpoints/` | ⬜ **待开** · 🟢 仅 A6①（改 3 张名片，跳过 GSV） | [实测] `models/` 各支归属：`tts/` 20G = 四台引擎专属；`asr/` 5.9G · `separation/` 1.7G · `vocoder|sr|lang/` 455M = **训练线/校验线共用，不动**。✅ `.gitignore:213-221` **已有 `engines/*/checkpoints/`**；✅ C3 不破（仍相对项目根，名片只改一个字符串）；✅ 顺带闭环 `engines/cosyvoice2/` 那个嵌套 `.git` | ⛔ **必须分两步**：先搬三台非训练线引擎（17.6G），**GSV 那 2.8G 要等 C3** —— `lib/paths.js` 有 5 处以上硬编码（`GSV_PRETRAINED_DIR:301` / `BASE_DIRS:343-351` / `S1_V2_FILE:362` / `BASE_WEIGHTS_*:376-393` 带 legacy/canonical 双读），而 `lib/training/` 读的就是它，**一次全搬 = 立刻弄坏训练**。⚠️ 过渡期三台在新路径、GSV 留旧路径 —— **不违反任何契约**（`runtime.checkpoints` 逐台声明） |
| **A7** | ⭐ **第 3 步真下载**（现在只打印命令）| ⬜ **待开** · 🔴 `core/download.js` | [读码] `models.source.command` **已经是名片声明的 argv**，平台已会填占位符（`{checkpoints}`→绝对路径）、已知道 `license_gate`。⇒ **执行它不违反「只验不建」** —— 规则禁的是「平台**生成**命令」，不是「平台**执行**」 | ⚠️ **规则没被写全**：「不替你下载」的准确含义是「**不替你决定从哪儿下**」，而决定已在名片里。要回写进 `_TEMPLATE/README.md`。必须有三件：**断点续传**（5.49GB）· **并发**（`llm.pt` 单文件 2GB）· **进度**。⚠️ `[待裁]` 是否加 SHA 字段（会动磁盘格式） |
| **A8** | ⭐ **权重下完对一次名**（缺/多/后缀不符三态）| ⬜ **待开** · 🔴 `core/checkpoints-audit.js` | [实测] **这个不一致真的发生过**：`indextts2/checkpoints/config.yaml` 写 `gpt.pt` / `s2mel.pt`，盘上是 **`gpt.pth` / `s2mel.pth`**；而 config 还漏了 `bpe.model` / `pinyin.vocab` / `qwen0.6bemo4-merge/` | 零成本（只列两个目录），比 hash 可靠 —— 上游不一定给 hash，而 config 名字本身不可信。⚠️ 「多出来」的一类里有 `.cache/` 和 `hf_cache/`，那是**运行期产物不是权重**，别误报 |
| **A9** | ⭐ **权重候选探针**（自动发现，多源交叉）| ⬜ **待开** · 🔴 `core/weight-discovery.js` | [实测] **三源都不完全可靠**：① IndexTTS2 的 `config.yaml` 点名 5 个但**后缀错 + 漏 3 项**；② **CosyVoice2 的 `cosyvoice2.yaml` 里一个权重文件名都没有** ⇒ 钩子完全失效；③ 代码里的下载调用只覆盖第三方包拉的（`models.external[]` 为它留了形状） | ⛔ **`models.required` 永远要人确认** —— 自动判定会把好引擎报成「缺文件」。⭐ 复用的形状是 A1 的 `reflect_params.py`（实测：漏 0 / 误排 0 / 类型 13/14），**维护的是探针不是清单** |
| **A10** | ⭐ **名片表单三件套 + 三段分组** | ⬜ **待开** · 🔴 `editor/ManifestForm.jsx` | [读码] `fieldmeta.js` + `NestedSections.jsx` 已有中文标签，但**没说格式、也没说填错报什么** | ⭐ **第三件几乎零成本**：`profile.js` 每个键的抛错消息**本身写了「应该写什么」** ⇒ 把已有消息提到字段下面即可。三段 = 必须人填 / 能反射 / 有先例。⭐ 顺序上正好成立（第 2 步建环境 → 反射 → 第 4 步落盘） |
| **A11** | 术语裁决：权重→**Checkpoint**、名片→**Manifest** | ⬜ **待改**（已裁）· 🟢 `web/src/` 为主 | [实测] 「权重」在中文 ML 里 = 模型内部参数，而这一步是**训练产出的文件**；`gpt-sovits` 权重目录里 `chinese-hubert-base/` 和 `chinese-roberta-wwm-ext-large/` **根本不是权重**。`i18n.jsx:4-7` 明文点名 Checkpoint 保持英文；`i18n.jsx:29` **默认语言是 `en`** | ⛔ **不改名片键**（`models.*` / `runtime.checkpoints` 是磁盘既有格式）。⛔ **不改注释** —— 全树「名片」247 处里只有 16 处是用户可见文案，其余 231 处是注释，而注释用中文是对的。⚠️ 残留不一致要显式承认：**步骤叫 Checkpoint、端点仍叫 `/wizard/models`** |
| **A19** | ⭐⭐ **把盘上那个根 venv 换成瘦版（大清理）** | ✅ **2026-10-04 已做**（`24478ea`） | [实测] 盘上 `venv/` = **7.0 GB · 457 个包**（torch 2.2.0+cu121 占 4.4GB + librosa + soundfile + fastapi）—— 而它**已经起不来**（base 解释器在旧机）。⚠️ **A16/A17 只是改配方与构建流程，没有一刀真的清理它** —— 这一条才是那个「清理」 | ⭐ **本机低风险**：删掉的东西**本来就不可用**，而包清单在 git 里（`requirements.txt` / `requirements-platform.txt`）⇒ 可完全重建。⛔ **前置**：A14（训练不再指根 venv）+ A16（已更名）+ A17（有构建后自检）。⚠️ **必须配一条守卫测试**，否则它会慢慢长回 457 个包 —— **C12 不变式 1 至今没有任何守卫** |
| **A20** | 「名片」这个词**按受众分** | ✅ **已裁**（Owner 2026-10-04） | [实测] `web/src/components/compare/ReferenceCompareTab.jsx:1363` 是**全项目唯一**一处「名片」出现在产品界面（`web/src` 里 192 处「名片」全是代码注释）。Owner 裁定：**「名片」要出现在给最终用户看的界面上** ⇒ **该处不改** | ⭐ 由此形成一条**有意的**规则：**面向最终用户 = 名片**（更好懂）；**面向接入者/AI = Manifest**（与技术文件同名）。⚠️ **这是按受众分的区分，不是漂移** —— 必须写在这里，否则下一个人会把它「统一」掉。⚠️ 而 `i18n.jsx:29` 的默认语言是 `en` ⇒ 中文位那个词只在中文界面出现 |
| **A13** | ⭐ **`envCheck` 不验「环境是不是按名片配方装的」** | ⬜ **待开** · 🟢 `lib/engines/envCheck.js`（零代码） | [读码] 它只验「解释器能起 + 名片点名的模块能 import」。⇒ **没有任何机制能发现「名片说 `uv sync`、实际是 hand-built 的 XPU 环境」** —— 而后者已实测存在（`C:\Aurivox\envs\indextts2` 是 torch 2.14.1+xpu + transformers 4.52.1，名片配方却是 `uv sync`/cu128） | ⛔ **这是平台侧一个真缺口**，不是配置问题。⚠️ 它与 §3c 的 X3（浅层报假绿灯）是**两个不同形状的缺口**：X3 是「文件在但跑不起来」，这条是「跑得起来但不是按配方装的」 |
| **A14** | ⭐ **`lib/training/python.json` 指向引擎 venv** | ✅ **指向已改**（`24478ea`）· ⚠️ **目标环境仍不可用** | [读码] 训练线源码**已经在引擎目录**（`engines/gpt-sovits/train/{s1_train.py,s2_train.py}`，`paths.js` 有 `GSV_TRAIN_DIR`）—— 只有解释器指针留在平台层：`python.json` → `./venv/Scripts/python.exe` | ⭐ **这是 A16/A17 的前提** —— 训练不指根 venv 了，根 venv 才敢瘦。⚠️ `python_helper.js:52-76` 已有完整解析链 + 对「绝对路径失效」的容错，**但按「文件存在」挑，不按「能起」挑**（见 A15）。⚠️ **待裁**：训练与 GSV 推理**共用一个 venv**（简单，但推理会背上 `deepspeed`/`wavmark`）还是 `train/` 另开一个 |
| **A15** | ⭐ **按「能起」挑解释器，不按「文件存在」挑** | ✅ **2026-10-04 已达成 22 → 0** | [实测] **不是两处，是三份副本**：`configRepair.node.test.js` · `aliasFold.node.test.js` · `envCheck.node.test.js` 各有一份 `findPython()`，判据全是 `fs.existsSync` —— 而 venv 的文件**在**，只是 base 解释器指向另一台机器。⭐ 已收成一份：`lib/util/pythonResolve.js` + `projectPythonCandidates()` | ✅ **22 → 5**，零新增失败。⭐ 判据比「能跑」更严：**必须能按绝对路径 spawn** —— [实测] PATH 上那个 python 的安装路径带 `*`，裸名能跑但绝对路径 ENOENT，且 `path.relative` 会吃掉反斜杠（round-trip 不成立）。⚠️ **计划的「22 → 0」没达成**，剩 5 条被 **A18** 挡住。⚠️ `lib/training/python_helper.js` 的根 venv 回退**已删**（`24478ea`）—— 那次回退返回的是「能启动但没有 torch」的解释器，`ModuleNotFoundError` 会让人去装包而不是看环境 |
| **A18** | ⭐ **测试夹具只复制 `python.exe`、不带 DLL** | ✅ **2026-10-04 已做**（`e64d999`） | [实测] `lib/engines/envCheck.node.test.js:115` 的 `pythonRef()`：`fs.copyFileSync(PYTHON, dest)` —— 只复制**一个 exe** 进人造 venv 形状目录。而 **Python 的 `python.exe` 不是自包含的**，它要同目录的 `python311.dll` ⇒ `0xC0000135 STATUS_DLL_NOT_FOUND` | ⚠️ **A15 没有制造它**：改之前复制的是那个坏 venv 的 exe（报 `uv trampoline failed`），改之后复制的是能跑的内嵌 python（报 `0xC0000135`）—— **同一个夹具缺陷，两个症状**。⚠️ 那个注释自己写着「复制它进 probe-venv/Scripts/python.exe 是可行的」—— **在 Linux/macOS 上可行（单文件 trampoline），在 Windows 上不成立**。可能的修法：真建一个 venv / 连 DLL 一起复制 / 换夹具形状。⛔ **别用仓库外手建的环境去凑**（那会让测试依赖没有 freeze、没有进版本库的环境） |
| **A16** | `requirements.txt` 更名 → `requirements-gpt-sovits.txt` | ✅ **2026-10-05 已做**（`6d7feba`+`bac77f4`） | [实测] 它是**根 venv 的 pip freeze**，而那个 venv 装的是 GSV 的依赖（torch 2.2.0+cu121 + CUDA 全套 + librosa + soundfile + fastapi，200 包 / 6.6GB）。[读码] GSV 的名片 **`install: null`** ⇒ 它走的就是这份文件 | ⚠️ **动它之前必须先解一道待裁**（见 §5.7）：GSV 的依赖该归「引擎环境」还是「训练扩展环境」。⚠️ 一旦根 venv 改用 `requirements-platform.txt`，这份文件**只对 GSV 有效**，继续叫 `requirements.txt` 就是**撒谎的文件名** |
| **A17** | ⭐ **平台构建流程切片**（瘦身的另一半） | 🟡 **③已完成，①②未做**（2026-10-05） | [已修 ✅] `install_torch.ps1` **只支持 N 卡**，无卡时装 CPU 版 —— 那个版本 `requirements-platform.txt:41-46` 自己说会让**训练立刻坏掉**。⚠️ 所以「根 venv 只装 3 个包」这件事**只改 requirements 不够** | 拆三件：① 启动器的 venv + npm + ffmpeg 分支（瘦身）② 模型下载分第二段 ③ **`install_torch.ps1` 加 XPU 分支**（按 `hardware.js` 的 StabilityMatrix 偏好顺序）+ **CPU 版构建后自检** + 明写「训练线在本机不可用」。⛔ **不是「补文档」，是独立一刀**

> **2026-10-05 结项（部分）**：③ **已完成**，且顺手把主体从 372 行 PowerShell 移到 `tools/cli/install-torch.js`（跨平台；薄壳 `install-torch.bat` / `install-torch.sh`）。构建分支现按本机设备选：**NVIDIA→cu121 · Intel→xpu · AMD/Linux→rocm · 其余→CPU**（原文件第 12 行写着「no AMD / DirectML」）。8 条守卫（`tools/cli/install-torch.node.test.js`）。⛔ **本项剩下的**：①② 启动器拆两段 + ③ 的「CPU 版构建后自检」还没做 —— 也就是说**训练线不可用这件事仍然没有任何自检会告诉用户**。 |

---

## 2.6 ⭐ 为什么 `installPlan.js` 整体退役（2026-10-04 Owner 裁决，B 方案）

> 记在这里是因为**它不是一次重构，是一次前提的推翻** —— 而推翻它的是项目自己的工具。

`installPlan.js` 整个建立在一句话上（它的 `:94-97` 自陈）：

> 「⛔ 这里不能用 `git clone`。**安装的前提是「名片已经写好了」**，也就是
> `engines/<id>/manifest.json` 已经躺在目标目录里 —— 而 `git clone` 拒绝
> 拉进一个非空目录。用 `init` + `fetch` 就没这个限制。」

⚠️ **那句话要求「先有名片，再克隆」。而项目自己的工具证明它反了 —— 三条独立证据：**

| # | 证据 | 出处 |
|---|---|---|
| **1** | **`scaffold-params.cjs` 要在「你这台引擎的解释器里」反射 `__init__`** —— 可源码是手册第 3 步才克隆的、环境也是那时才建的。⇒ **手册第 2 步需要第 3 步的产物，手册自相矛盾** | `_TEMPLATE/README.md` 第 2 步原文 |
| **2** | **`upstream.commit` 在这个顺序里不可得** —— 要填它就得先知道 sha，而 sha 在上游仓库里。实证：`gpt-sovits` 至今 `commit: null`（理由：搬进仓库时 `.git` 已删），于是在旧流程下**它今天装不了**（`installPlan.js:78` 硬拦） | [实测] 名片 + 代码 |
| **3** | **`init` + `remote add` + `fetch` 存在的唯一理由就是绕开「clone 不进非空目录」** —— 克隆先做（目录本来就是空的），理由消失 ⇒ **这三步是纯 workaround，剩下有用的只有 `checkout --detach` + `drop-git`** | [读码] `installPlan.js:98-130` |

⭐ **一句话**：「先有名片」这个前提，需要的是**一个占位文件**（手册第 1 步干的事是
`copy _TEMPLATE/manifest.json` —— 复制一张全是 `REPLACE_ME` 的模板），
而不是**一份已知事实**。而事实的因果顺序是：clone → 读它 → 才知道
入口/依赖/参数长什么样 → 才写得出来名片的 `call.*` / `parameters[]`。

### ⭐⭐ 但有一条设计事实**从来没人写下来过**：名片必然是**两阶段**的

正确顺序里第 2 步「建环境」卡住了 —— 环境要在名片之前建，而 `env_command`
只能来自名片。⇒ `install.env_command` + `upstream.url` 必须在 clone 之后
**立刻**就有（用户凭上游 README 填），`call.*` / `parameters[]` / `commit`
要等源码和解释器都在了才写得出来。

[读码] `tools/engine-wizard/core/env.js:110-111` **已经隐式承认了**这件事
（「上游仓库是第 2 步刚克隆的，manifest.json 还不存在 ⇒ 这一步的命令只能
来自『用户填好的那张名片』，不是读盘」），**但它没出现在任何文档或计划里**。
六步表（`editor/steps.js`）把 `env` 排在 `manifest` 之前，也没解释它怎么
拿到 `env_command`。⇒ 谁照着文档走都会撞墙。

### 退役的连带后果（一笔都记下，不许当没发生）

| # | 后果 | 现状 |
|---|---|---|
| 1 | **拉源码这条路今天没有可用工具** | ⚠️ 向导未提交，且缺 pin + drop-git（**A4''**）⇒ 今天只能照上游 README 手工 clone |
| 2 | `install.env_command` 的**平台侧 parse 期校验**随 `parseInstall` 一起没了 | ⚠️ 现在只有执行它的向导 `env.js` 在动手前校验。时机更贴近动作（仍是响亮失败，不是静默），但**少了一道 parse 期守卫**。要不要把 `parseInstall` 那段搬进 `profile.js`，**待裁** |
| 3 | `profile.js` 的 `install` 顶层键仍在白名单里 | [读码] `profile.js:340` —— 但 `profile.js` **不校验它的内容**。⇒ 名片写错 `env_command` 形状，平台解析期不再报 |
| 4 | `checkpoints.js` 的「计划/执行分家」先例少了一个引用 | ✅ 已改注释指向 `launchPlan.js`（那个形状仍活着） |
| 5 | 从 `install-engine.cjs` 劈出来的**底模那半活下来了** | ✅ 新文件 `tools/engine-checkpoints.cjs`（新名字，因为旧名字已答不了它做的事） |

⚠️ **纪律提醒**：这三条「记录在别处、代价就自己付了」正是本文件 §5 第 1 条
要防的事。A4' 是本项目第一次**主动删掉一个已提交的、被手册和两张名片引用的
平台文件** —— 记下来是为了让下一个人知道这不是漏改，是裁决。

### B 组 · 多模型 / 资源占用

| # | 事项 | 状态 | 证据 | 备注 |
|---|---|---|---|---|
| **B1** | `MAX_LAUNCH_SLOTS = 1` | ⚠️ **已定位，未修** | [实测] `probe_max_launch_slots2.cjs`：两个 launch 位 → ⛔ 抛 `ENGINE_TOO_MANY_LAUNCH_SLOTS`，spawn 0 次；**两个 call 位不受影响** | ⭐ 天花板确认。⚠️ **拒绝在第一次合成时**，不在装引擎时（`registry.js`/`profile.js` 都不含它）⇒ 装得上、界面正常、点合成才炸。⚠️ 写它时**零测试覆盖**，上表是本次补的 |
| **B2** | launch 位只能换目录 | ⬜ **待开** · 🟢 `lib/engines/launchPlan.js` | [读码] `{checkpoints}` 只有一个占位符 | B1 的根因：一个进程只有一个底模目录 |
| **B3** | `cap` 降级成护栏 | ✅ **2026-09-29 已修** | [实测] `cap.node.test.js` 16 条 + 6 条变异全抓住。**B3 之前 cap 只有夹具值、零行为测试**（改完 1633 条全绿 = 没有测试在看它） | 判据是 `needMb == null`（**不知道**），不是「内存够不够」。<br>⭐ cap 自动算：**总内存 / 8G**（8G→1 / 16G→2 / 32G→4 / 128G→16），`AURIVOX_ENGINE_CAP` 可覆盖 |
| **B4** | 端口归零 | ✅ **2026-09-29 已做（stdio）** | [实测] 提交 `2fe41e7`：`stdio_transport.py` + `stdioTransport.js` + `host.py --stdio`；真 IndexTTS2 `ready 60.5s`、`/tts` 出 270380 字节 WAV、`netstat` 确认 9881 无人监听；1690 测试全绿 | ⭐ **命名管道那套已按 Owner 裁决删除**（半双工 / nMaxInstances 配额 / createConnection 被静默忽略）。⚠️ **不接默认**，要走得显式 `buildLaunchPlan({transport:'stdio'})`。⚠️ 已知限制：严格串行 —— 但 `host.py:795` 的 `infer_lock` 在 HTTP 下也是一台一次一个 infer，**没有牺牲任何现有能力** |
| **B5** | 占用对用户可见 | ✅ **2026-09-29 已做完（后端+UI）** | [实测] `lib/engines/occupancy.js` + `GET /api/engines.occupancy`；26 条测试 + 10 条变异全抓住 | ⭐ **报「历史峰值」而不是实时读数** —— Owner 纠正：峰值就是 OOM 风险本身，Linux 上实时读数反而最危险（OOM killer 正在杀进程时读到的是崩溃中的数）。⛔ 字段名必须叫 `peak_mb`，不许叫 current/rss。✅ **前端已画**（顶部总览 + 每台徽章） | ⭐ UI 接线见提交 `100e85e`：23 条测试 + **10/10 变异全抓住**。⚠ 接线测试抓到两个「全绿但功能不存在」的真 bug（形状对不上 / 峰值恒为 0）。

### C 组 · 验收能力

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| **C1** | 第三道校验「出得了声」 | ✅ **2026-09-29 已做** | [实测] `lib/engines/verify_audio.py` + `verifyAudio.js` + `tools/verify-engine.cjs`；15 条 node 测试 + `tools/dev/probe_verify_audio.py` **7/7 判别力实测**（假宿主，行为已知） | ⭐ A/B 两级【Owner 裁决】：**B 级**宿主拿到合法响应（快、不吃显存、验「谈得拢」）、**A 级**真跑一次合成拿非空 WAV。⭐ A 级**先跑 B**（宿主没就绪时直接发 /tts 得 503，那结果与「声音不对」长得一样）。⭐ WAV 体检看**有没有帧** —— 44 字节空 WAV 能播 0 秒，界面上看不出异常。⚠️ **A 级仍未通过 `verify-engine.cjs` 在真引擎上跑过**（[实测] 2026-10-03 有一次 CosyVoice2 zero_shot 在 XPU 上真出声音，但走的是 `C:\Aurivox` 的探针脚本，⛔ 不算本行的验收）。⭐⭐ **2026-10-02 新发现：A 级这道判据不够** —— 它查「WAV 有没有帧」，而实测有一段音频所有非空判据全绿、FunASR 反查相似度只有 **0.216**（乱码）；换配对参考音频+文本后 **1.000**。⇒ 「出得了声」与「说得对」是两件事，**后者平台今天没有判据** |
| **C4** | 第 5 步改成「三块独立显示」 | ⬜ **待开** · 🔴 第 5 步在向导里 | [决定] ① 引擎起没起 + 状态码 ② **音频 → 复用 Generate 的 `Player.jsx`**，⛔ ffmpeg/ffprobe 降级掉 ③ ASR 回读（延后，缺了就写「这一块没有」）。⛔ **三块不绑成一个必须全过的门** | ⭐ ② 比 ffmpeg 强：[读码] `Player({src})` 内部 `fetch` + `decodeAudioData` ⇒ **「能解码并出声」本身就是校验**，且给人看**波形图**。[实测] 相似度 0.216 那段音频**所有非空类判据全绿（含 ffprobe）**，而波形图会立刻显示「一段一段的」。⚠️ 落地障碍：`Player` 吃 **URL**，产物要落 `outputs/_verify/`；⚠️ **wizard 的 vite config 只 proxy 了 `/api`，没 proxy `/outputs`**。③ 已有可用实现（`C:\Aurivox\verify_tts.py`，且**在 XPU 上跑过**）—— 延后的不是可行性是优先级 |
| C2 | Flow 默认关闭 | ✅ 已裁决 | [实测] 需 `FLOWGRAPH_ENABLED=1`。§12.12「两套节点表」已裁决不排期 |
| C3 | 训练管线绑死 GSV | ⛔ **Owner 2026-09-29 裁决：暂不做** | [实测] `pipelineIdentity.js:62` `TRAINING_ENGINE_ID='gpt-sovits'` | ⭐ **Owner 原话：「暂时还没见过其他开放微调的 TTS，所以暂时不做」** —— 训练/微调这条路今天只有 GSV 一条线，绑死不构成问题；等真有第二个可微调引擎再说。⚠ **不做 ≠ 不用记**：这一格留着，避免下一个人以为它已经做完了。 |

### D 组 · 文档

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| **D1** | README 目录导览过期 | ✅ **裁定已在代码里**（`core/clone.js`：整仓克隆 + 此刻不问 sha）· ⛔ 本节作废 | [实测] `vendor/tts/` `vendor/gsv-tools/` `tools/checks/` 均已不存在；`outputs/flowgraph/` 实为 `_flow_runs/`；模型文件表把 GSV 写成了平台约定 |
| **D2** | CHANGELOG「待重新标记」无解释 | ✅ **2026-09-04 已修** | [实测] 已补 release gate 说明 + 指向稳定化计划 |
| **D3** | `ENGINE_ONBOARDING_STATUS.md` 只有目标 | ✅ **已被 A3 覆盖** | 该文件已指向契约 + 台账 |
| **D4** | **本文件** | ✅ **2026-09-04 已建** | 旧台账随契约退休删除 |

### E 组 · 顺手查出来的

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| E1 | `engines/indextts2/checkpoints/` 161MB 未下完的 HF 缓存 | ✅ **2026-09-04 已清** | [实测] `f834541` 加 ignore；`33c58fd` 后删除该目录。IndexTTS2 底模复验 `ready: true`、缺 0 个 | ⭐ 根因：那次迁移把底模落错了地方 —— 名片说的是 `models/tts/indextts2/checkpoints`，真底模一直好好在那儿 |
| E2 | `state/engine_memory.json` 有悬挂 `attempting` | ✅ **2026-09-29 已清** | [实测] 那条 `startedAt` 是 **2026-09-04** 留的（不是当天），25 天前；已删，备份 `engine_memory.json.bak-before-reap` | ⭐ `engines` 账本**保留**（8574MB 是实测峰值，删了得重新量） |
| E3 | `lib/inference/infer_server.py` 还在 `lib/` 下 | ⬜ 裁定延后 | [实测] 违反 `SCOPE §2` |
| E4 | `default_base_url` / `base_url_env` 在退休路上但是活键 | ⬜ 待拆 | [读码] `profile.js:302` 注释自陈 |

---

## 2.5 ⬜ 欠账：A1 的增强（Owner 2026-09-29 指示暂缓）

A1 的**主体已完成**（反射生成 `parameters[]`，见上表）。以下是实测后
**新发现**的增强方向，Owner 指示**先记欠账，不做**。

| # | 欠账 | 实测依据 | 为什么没做 |
|---|---|---|---|
| **N6** | **`--help` 解析器**（`tools/scaffold-cli-help.cjs`） | [实测] 两台真引擎给出**相反**答案：<br>· IndexTTS2 `cli_v2 synth --help` 信息量很大<br>· GSV `infer_server.py --help` **只有 3 个服务启动参数，推理参数一个都没有**（它们走 HTTP body） | Owner 指示暂缓 |
| **N7** | **UI 表单辅助填写名片** | 同上 | 同上；且现在瓶颈不是参数，是「用户不知道 module/class」——一个输入框解决不了 |

### ⭐ 但侦察得到的三条结论要留着（别重新测一遍）

**1. `--help` 与反射是互补，不是替代。**

| | 反射 | `--help` |
|---|---|---|
| 默认值（`interval_silence=200`） | ✅ | ❌ argparse 不显示 |
| 必填/选填 | ✅ | ❌ |
| Python 参数名（`spk_audio_prompt`） | ✅ | ❌ 是 `--voice` |
| **参数说明文本** | ❌ | ✅ |
| **维度**（"8-dimensional emotion vector"） | ❌ | ✅ |
| **语义别名**（`--emotion-weight` → `emo_alpha`） | ❌ | ✅ |
| **互斥组**（`--fp16\|--no-fp16`） | ❌ | ✅ 正是 `boolean_optional` 的证据 |
| **覆盖 GSV** | ✅ | ❌ **完全失效** |

⇒ 那三样（维度/别名/互斥组）是**反射根本拿不到**的，
而它们恰好是手写名片**最容易错**的地方。

**2. GSV 证明 `--help` 覆盖不了全部引擎。** 它的推理参数在
`TTS_PASS_THROUGH_KEYS` 里，不在 argparse 里 ⇒ 任何 `--help` 方案
**必须**能回落到反射，不能只做 `--help`。

**3. ⚠ 平台注入会污染 `sys.path`。** 实测起 GSV 的解释器时，
Hermes 注入的 numpy 覆盖了项目 venv 的，报
`ModuleNotFoundError: No module named 'numpy._core._multiarray_umath'`。

⇒ `reflect_params.py` 的 `_scrub_sys_path()` 就是为这个写的，**它拦住了**。
⛔ **任何「起引擎解释器跑东西」的工具都必须做这个防护** ——
将来做 `--help` 解析器时同理。

---

## 3. Owner 裁决（2026-09-04）

| 议题 | 裁决 |
|---|---|
| 资源占用形态 | **C —— 全常驻 RAM、按需换进显存**（低延迟 API 服务）。⚠️ 该形态假设多卡机器；8GB 单卡上「100 个常驻」物理上不成立。**部署侧**的事，不阻塞接入新引擎 |
| A4（GSV 迁移） | **先不做** |
| C1 验收形态 | **C —— A 级真合成 + B 级合法响应，两级** |
| E1 那 161MB | **删** |
| CosyVoice2 模型位形状 | **不预判**（避免凭印象下判断） |

## 3b. 环境分层 —— C12（Owner 2026-08-24/25 拍板，2026-09-29 重新立此条）

> ⭐ **这条曾经写在被删掉的 `docs/ENGINE_CONTRACT.md` C12 段里。**
> 那份契约在 `c3f0ae8` 删了，**设计意图随之消失** ——
> 于是 2026-09-29 有人（AI）把「GSV 住根 venv」读成了设计，
> 连续五次判断错误。**账要还。**

**Owner 原话（2026-08-24）**：「我们不可能维护这么多环境，我只维护
GPT-SoVITS 兼容这一套，其他一概不负责。」

**Owner 原话（2026-08-25）**：Aurivox 要成为**平台**，而不是「一个基于
GPT-SoVITS 的项目」。**根环境里住着一台引擎，本身就是后者的物证。**

### 三条不变式

| | |
|---|---|
| **1** | ⛔ **根 `venv/` 只装平台自己的**（fastapi/uvicorn/pydantic），⛔ 不含 torch / CUDA / librosa |
| **2** | ⭐ **每台引擎住 `engines/<id>/.venv`**，版本互相独立（GSV 要 torch 2.2+cu121，IndexTTS2 要 2.8+cu128，物理上无法共存） |
| **3** | ⛔ **平台只验不建**（同 C12.2）：核对（名片声明的解释器/模块/类/方法在不在）+ 启动。**核对不过 = 没装** |

### 「平台只验不建」的落地形状（ComfyUI 式，2026-09-29 Owner 确认）

| 事情 | 谁做 | 平台提供什么 |
|---|---|---|
| 下模型 | **用户** | 名片 `models.required` / `source.url`（indexedt2 已给 modelscope URL） |
| 建引擎环境 | **用户** | 名片 `install.env_command`（契约里早有这个字段） |
| GSV 的下载脚本 | ⭐ **另一回事** | 它成熟，值得单独做 |

⚠️ **Owner 原话（2026-09-29）**：「每周都有新的 TTS，我怎么可能专门维护所有 TTS 引擎」
⇒ **平台绝不为每台引擎写下载/安装脚本。** 那是「平台维护所有引擎」。

### ⭐ 日常判法

**一件事该不该做，问它是让 GPT-SoVITS 更特殊，还是更像一台普通引擎。**

⛔ 因此**不许新增任何依赖「共用」的机制** —— 例如让平台代码假设 GSV 的包
一定在自己的 `sys.path` 里。每加一处这样的假设，将来拆环境就要多还一笔。

### 当前偏差（2026-09-29 实测 · **2026-10-04 订正**）

> ⚠️ 下面这张表是 2026-09-29 的读数。**2026-10-04 复核：C12 的三条不变式已经落地**，
> 表里「⛔」那几格不再成立。订正见最后一列，**以订正为准**。

| | 2026-09-29 实测 | 2026-10-04 订正 |
|---|---|---|
| 根 `venv/` | 6.6GB，装着 GSV 的 torch 2.2.0+cu121 + CUDA 全套 | ✅ **已瘦**：`requirements-platform.txt`（3 包）已建，`deploy.bat --platform-only` 可用。但**本机那个根 venv 已死**（见 §3c），且训练线仍指向它（`lib/training/python.json`），所以「切默认」那一步**仍未做** |
| `engines/gpt-sovits/` | ⛔ 没有 `.venv`，名片指根 venv | ✅ **已改**：`engines/gpt-sovits/.venv` 已建，名片 `runtime.python` 已改成 `engines/gpt-sovits/.venv` |
| `engines/indextts2/.venv` | ✅ 7.9GB，形态正确 | ✅ 形态不变（⚠️ 本机起不来，见 §3c） |
| `bootstrap.ps1` | ⛔ 步骤 3-4 无条件装 requirements.txt(200 包) + torch | ⚠️ 仍如此，但已加 `--platform-only` 开关（默认不传 ⇒ 老用户零影响） |

⚠️ **实测的平台重依赖分布**（`git grep` 量出来的，不是推断）：
- `routes/*` → **零**重依赖 ✅
- `lib/`（除 `lib/inference/`）→ **只有 `lib/engines/host.py` 一处** import numpy/torch，
  而它跑在**引擎自己的 venv** 里 ⇒ 平台 venv 不需要它
- `lib/inference/*`（7 文件）→ torch/librosa/soundfile/numpy/TTS/gsv_code/config_repair
  ⇒ **全是 GSV 专有**（E3 那笔账：它该搬进 `engines/gpt-sovits/`）

⇒ **平台瘦下来在技术上成立**，且可验。**⛔ 但「成立」≠「已切默认」**：
训练线还指着根 venv，切默认会立刻弄坏训练。这是「不弄坏正在用的东西」的有意排序，
不是忘了。

---

## 3c. ⭐ 开发验证平台已换成 Arc（2026-10-04）

> 这条**不是**一笔设计决策，是**环境事实**。记在这里是因为它改变了
> 「在这台机器上跑测试/跑引擎」这件事的每一个读数。

**Owner 2026-10-04 指示**：开发验证平台换成 **Arc**（本机：ERYING B860，
Intel Arc 140T 核显 32GB 共享 + NPU 3720，**无 NVIDIA**），且为避免环境交叉污染，
**环境放 `C:\Aurivox`**（仓库外）。

### 可用的 XPU 环境（全部在仓库外）

`C:\Aurivox\envs\`：`platform`（py3.12 瘦环境）· `gpt-sovits311`（py3.11 ——
`jieba_fast` 必须吃 `tools/wheels` 的 cp311 轮子）· `indextts2`（py3.11）·
`cosyvoice2`（py3.10）。torch 2.14.1+xpu；transformers 各台独立
（GSV 4.43 / CosyVoice2 4.51.3 / IndexTTS2 4.52.1）。
完整实测记录（含踩坑表、性能、JIT 警告）：**`C:\Aurivox\ENV-XPU-REPORT.md`**。

### ⛔ 三笔必须知道的环境事实

| # | 事实 | 证据 |
|---|---|---|
| **X1** | **`venv/`、`engines/gpt-sovits/.venv`、`engines/indextts2/.venv` 在本机是死的** —— `pyvenv.cfg` 的 home 指向 `C:\Users\MECHREVO X10 Pro\...\cpython-3.11`（**旧机**），起 interpreter 报 `uv trampoline failed to spawn Python child process` | [实测] 2026-10-04 逐个起 interpreters |
| **X2** | ⇒ **`npm test` 的 22 条失败全部是这一个根因**（`lib/inference/configRepair.*`、`aliasFold.*`、`envCheck` 深层 —— 它们 shell out 到根 `venv/Scripts/python.exe`）。读数：`1982 tests / 1959 pass / 22 fail / 1 skipped`。⛔ **不是代码回归**，别去改代码 | [实测] 2026-10-04，失败清单逐条对得上 X1 |
| **X3** | **浅层 `check-engine-env.cjs` 会报假绿灯**：它只查 `python.exe` 文件在不在 ⇒ 四台全报「装了」，而 gpt-sovits / indextts2 根本起不来 | [实测] 2026-10-04，四台全绿 + X1 同时成立 |

### 后端本身不依赖 Python

`server.js` 是纯 Node ⇒ 即使三个 venv 全死，`node server.js` 照常起
（[实测] 2026-10-04 后端在 9886 正常服务，`/api/health` 返回四台引擎
`online:false`）。⚠️ 但日志会打 `[cuda] not available — inference will run on CPU`
—— 那是 CUDA 探测，**平台今天没有 XPU 分支**，XPU 只活在引擎自己的环境里。

### ⬜ 待 Owner 裁定：外部环境怎么接进平台（**未做**）

名片路径**必须相对项目根**（`profile.js:503` `relPath` 拒绝绝对路径，C3 契约），
所以「把 venv 放 `C:\Aurivox`」这件事本身与契约冲突。两条路：

| | 方案 | 代价 |
|---|---|---|
| **A** | **目录 junction**：`engines/<id>/.venv` → `C:\Aurivox\envs\<id>` | 零代码改动。语义略脏（名片说 `.venv`，实物在别处） |
| **B** | 新增名片键 `runtime.python_env`（仿既有 `models.checkpoints_env` / `base_url_env` 先例，由名片自己声明变量名） | 要改 `profile.js` + `envCheck.js` + `launchPlan.js`，且要过「四个文件不许有引擎名」守卫 |

⚠️ **注意 X2 的修法与这里是两件事**：X2 是**测试**要一个能跑的根 venv
（重建，或让测试的解释器解析认 `C:\Aurivox\envs\platform`）；这里是**引擎**
要一个能跑的 venv。别把两笔账合成一笔。

---

## 4. 下一刀

**2026-10-04 重排。** 上一版的三梯队是按「解锁接入新引擎」排的，
而 Owner 那一轮把流程推翻重推了一遍 ⇒ 顺序跟着新设计走。

**⛔ 但在排任何一刀之前，有两个前置挡着**（都不是设计问题）：

| | |
|---|---|
| **① 向导整棵树未提交，且当前是坏的** | [实测] `tools/engine-wizard/` 全部 `??`。且 `editor/StepPrepare.jsx` 有一个 `<ol>` 残骸（219 行的 div 没闭合，272 行拿 `</ol>` 去收）⇒ **dev server 起不来**。另有 **4 个死组件**（`StepEnv` / `StepClone` / `StepProbe` / `StepResolve`，无任何 import），其中 `StepEnv.jsx:8` 引用**已删除的 `installPlan.js:44`** —— ⛔ **没有「孤儿组件」守卫**，而项目对孤儿**测试**是有守卫的（`run_tests.cjs` 自检） |
| **② 本机三个 venv 是死的** | [实测] `venv/` · `engines/gpt-sovits/.venv` · `engines/indextts2/.venv` 的 base 解释器指向旧机 ⇒ 拉起即失败。而**第 5 步要真的起引擎** —— 验证器自己跑不起来的时候，第 5 步没有意义。⇒ 先解 §3c 的 junction / `runtime.python_env` |

```
第 0 批   D1   commit 必不填（裁定）        ⛔ 纯决定。A4'' 唯一的硬前置
          A15  按「能起」挑解释器            ⛔ 零下载零安装，解掉 npm test 那 22 条
          A13  登记缺口：envCheck 不验配方一致性   ⛔ 纯文档

第 1 批   ⛔ 卡在 §5.8（GSV 那 200 个包搬去哪）—— 裁完才动
          A14  训练 python.json → 引擎 venv      ⇒ A16/A17 的前提
          A16  requirements.txt → requirements-gpt-sovits.txt
          A17  构建流程切片 + install_torch.ps1 加 XPU 分支 + CPU 版自检

第 2 批   E1   重建 engines/<id>/.venv ×2      ⚠️ 引擎层，不是平台的事
          E2   冻结 C:\Aurivox 的推导产物进 tools/dev/ + 手册
第 3 批   A8 / A9 / A7 / A4''                 ⚠️ 在向导树内但不在 editor/，要你点头
第 4 批   A6①  搬三台非训练线引擎 17.6G         ⚠️ 唯一动真实数据的一步
第 5 批   A10 / A11 / C4                       ⛔ 全在 editor/，等那棵前端收工

⛔ 不做   搬 GSV —— Owner 定：GSV 是例外模型，永不搬。不再是「等 C3」
⛔ 已删   N1「重建根 venv」—— 它违反 C12 不变式 1（把 GSV 的依赖装进平台环境）
⛔ 已删   P2「junction 到 C:\Aurivox」—— 那会让一个不在体系内的环境冒充「按名片装好的」
```

⚠️ **上一版这两条是越界的**（2026-10-04 Owner 指出后重排）：
把 GSV 的 200 个包装回**平台** venv，是 C12 不变式 1 明令禁止的；
用 junction 让手建的 XPU 环境冒充「按名片装好的」，正是「漂移不报错」。

⚠️ **上一版这三梯队把「下一刀」当成一件事列，那是错的** —— 真正的先后在 §5，
而 §5 里最要紧的一句是：**第 0 批两件都不写代码，却解掉 22 条测试失败 + 放出 A4''。**

⭐ **一份新的设计文档已经写好**：[`ENGINE_ADOPTION_FLOW.md`](./ENGINE_ADOPTION_FLOW.md)
（五步流程 · 第 3 步真下载 · 第 5 步三块 · 权重新路径 · 自动发现 · 名片三件套 · 术语裁决）。
⚠️ `ENGINE_WIZARD_PLAN_v2.md` **已归档作废**。
逐批实施计划见 **§5**。

---

## 5. 实施计划（2026-10-04）

> 每一步四件：**scope · 动到什么文件 · 预期效果 · 验收点**。
> ⚠️ 验收点必须是**真实执行输出**，不接受「应该能」。

### ⛔ 两条硬约束（Owner 2026-10-04）

| | |
|---|---|
| **GSV 是例外模型，永不搬** | `models/tts/gpt-sovits/`（2.8G）留在原地。⇒ **A6 只做另外三台**，「搬 GSV」不再是待办 |
| **⛔ 不碰 `tools/engine-wizard/editor/`** | 那棵树的前端正在被另一路开发。⇒ **第 4 批整批延后**，等它收工 |

⚠️ 另一条不是 Owner 定的、但同样挡路的事实：
**`npm test` 那 22 条失败用的是根 `venv/`，不是任何引擎的 `.venv`**
⇒ 它既不是引擎层的事，也不是「重建根 venv」能解决的 ⇒ 是 **A15**（判据按「能起」挑）。

### 5.1 第 0 批 · 零安装、零边界争议（马上能做）

---

#### ~~**D1**~~ · `upstream.commit` —— ✅ **2026-10-05 复核：裁定已在代码里，本节作废**

> ⭐ **Owner 2026-10-05 指出：「不是说走克隆嘛？克隆就没有 sha 了。」—— 对。**
>
> 复核 `tools/engine-wizard/core/clone.js` 的注释，白纸黑字：
> 「先克隆、第 5 步才写名片，**此刻还不知道要哪个 sha**」，
> 且**默认整仓克隆** —— 理由是「按 sha 浅取会被服务端拒绝
> （`allowReachableSHA1InWant`）⇒ 整仓是为了将来还能 checkout 到指定版本」。
>
> ⇒ **`commit` 选填这件事从来不需要「裁定」，代码里已经是那个形状了。**
> ⇒ 是**本节落后**，把它写成了「待裁」。
> ⇒ 连带作废：`lib/engines/profile.js` 里那句「这一段注释在 A4' 落地前是悬空的」
>   —— D1 不是它的前置，**A4'' 才是**（§2 进度表 A4'' 行已改）。

#### **A15** · 按「能起」挑解释器，不按「文件存在」挑 —— ⭐ **计划里最干净的一步**

| | |
|---|---|
| **scope** | 两处：`lib/inference/configRepair.node.test.js:28-42` 的 `findPython()` · `lib/training/python_helper.js:52-76` 的 `getPythonPath()`。判据从 `fs.existsSync(p)` 换成「**起一次 `--version` 看退出码**」 |
| **文件** | 上面两个 + 各自的测试 |
| **预期效果** | `npm test` 那 22 条失败大部分消失 |
| **验收** | ① ✅ **fail 22 → 5**（`1974 pass / 5 fail / 1 skipped`），**零新增失败**<br>② ✅ **没有靠跳过达成** —— `skipped` 仍是 1（与基线同），aliasFold 那 6 条是**真跑绿**的<br>③ ✅ **变异判据成立**：把判据注入成 `existsSync ⇒ 直接 true` ⇒ **5 条变红**（文件级手术式改法会切坏文件，那种不算判别力）<br>④ ✅ 干净机器上行为不倒退（venv 仍是第一优先，内嵌 runtime 只是新增的兜底）<br>⛔ ⑤ **「22 → 0」没达成** —— 剩 5 条是 **A18**（夹具只复制 exe 不带 DLL），**先于 A15 存在** |

⚠️ **零下载、零安装、零平台边界争议。**

⚠️ **`lib/training/python_helper.js` 这一处只改了「怎么验」，没改「验谁」**：
它的兜底分支刻意返回**期望路径**（而不是 null），好让报错指向正确的位置。
⛔ 所以**不给它加「内嵌 runtime」候选** —— 训练要 torch，
悄悄回落到一个裸解释器，只会把「训练线不可用」变成一句 `ModuleNotFoundError`。
⚠️ 那属于 A14 的范围（训练环境的归属），本刀不碰。

---

#### **A13** · 登记缺口：`envCheck` 不验「环境是不是按名片配方装的」

| | |
|---|---|
| **scope** | ⛔ **不改代码**，只把缺口写进台账 + 在 `lib/engines/envCheck.js` 文件头留一条交叉引用 |
| **文件** | `lib/engines/envCheck.js`（注释）· 本表 A13 行 |
| **⚠️ 为什么必须记** | [读码] `envCheck` 只验「解释器能起 + 名片点名的模块能 import」⇒ **没有任何机制能发现「名片说 `uv sync`、实际是 hand-built 的 XPU 环境」**。而后者已实测存在：`C:\Aurivox\envs\indextts2` 是 torch 2.14.1+xpu + transformers 4.52.1，而那张名片的配方是 `uv sync`（cu128） |
| **验收** | ① 台账 A13 行在 ② `envCheck.js` 文件头能 grep 到这条缺点的说明 |

⚠️ **它与 §3c 的 X3（浅层报假绿灯）是两个不同形状的缺口**：
X3 是「文件在、跑不起来」；这条是「跑得起来、但不是按配方装的」。
⚠️ **后者更危险** —— X3 会失败得很响，**这条全绿**。

---

#### **欠账** · 清 3 处用户可见文案里对已删除文件的引用

| | |
|---|---|
| **scope** | `tools/engine-wizard/core/env.js:39` `:122` `:173` 与 `core/clone.js:141` 的**用户可见文案**里写着「（installPlan.js:44「猜错的表现是装了一半才炸」）」「（lib/engines/installPlan.js:117 记了这个坑）」—— 而那个文件已在 A4' 退役。⛔ **用户会看到一条指向不存在文件的引用** |
| **已核实** | ✅ **没有任何一处是真 `require`**（`grep -E "require\(.*installPlan"` 为空）⇒ 运行时不会炸；⛔ 但至少 3 处是显示给用户的 |
| **改法** | 删掉行号与文件名，**把它原本要传达的那句话本身留下**（那句话本身是好文案）—— 同时按 `aurivox-voice` 的要求：**用户可见文案里不该出现源码行号** |
| **验收** | ① `grep -rn "installPlan" tools/engine-wizard/core/` 的命中**只剩纯注释**，且注释里也已无「用户会照着找不到」的行号<br>② ⚠️ **这要动 `core/`** —— 与「不碰 editor/」不冲突，但**要你点头**（那棵树今天仍被另一路开发写过） |

---

### 5.2 第 1 批 · 平台瘦身 —— 顺序有依赖，⛔ 别跳

> ⛔ **Owner 2026-10-04 定方向**：「平台直接环境大瘦身，留下必要的就行，引擎的归引擎自己管。」
> ✅ **§5.8 已裁**（GSV 的 200 个包归 `engines/gpt-sovits/.venv`，训练与推理共用，**暂时的候补**）。
> ⚠️ **瘦身不只是删包** —— `install_torch.ps1` 只支持 N 卡，无卡时装 CPU 版，
> 而 CPU 版 + 瘦 venv = 训练线彻底不可用，且**没有任何自检会告诉你**。

```
依赖顺序（⛔ 跳步就会把训练线或安装流程弄坏）：

  A14  python.json → 引擎 venv  ──┐ 两者都在动「谁用哪个解释器」，
  A16  requirements.txt → GSV 专用名 ─┘ 必须先于 A19
                    ↓
  A17  构建流程切片 + install_torch.ps1 加 XPU 分支 + CPU 版自检
                    ↓
  A19  ⭐ 真正把盘上那个 7GB 根 venv 换成瘦版（大清理）
```

---

#### **A14** · `lib/training/python.json` 指向引擎 venv

| | |
|---|---|
| **✅ 裁定** | Owner 2026-10-04：「训练和 GSV 推理**暂时共用一个 venv**，这个已经经过本机和上一部开发机验证」 |
| **scope** | `python.json` 的 `python` 从 `./venv/Scripts/python.exe` 改成 `engines/gpt-sovits/.venv/Scripts/python.exe`；`python_helper.js` 的候选顺序同步（⚠️ **只改顺序，不加「内嵌 runtime」候选** —— 训练要 torch，悄悄回落到裸解释器会把「训练线不可用」变成一句 `ModuleNotFoundError`） |
| **文件** | `lib/training/python.json` · `lib/training/python_helper.js` |
| **预期效果** | 训练线不再依赖平台 venv ⇒ 根 venv 才有资格瘦身 |
| **验收** | ① 训练相关的库报出**哪个解释器**（不许含糊）<br>② ⛔ **本机训练线不可用时要明说 + 为什么**（无 CUDA · UVR5 不支持 CPU），**不许静默**<br>③ `npm test` 不退化 |

---

#### **A16** · `requirements.txt` 更名 → `requirements-gpt-sovits.txt`

| | |
|---|---|
| **理由** | 它是**根 venv 的 pip freeze**，而那个 venv 装的是 GSV 的依赖。⚠️ 而 GSV 的名片 **`install: null`** ⇒ 它走的就是这份文件 |
| **scope** | 文件更名 + **全仓库引用同步** |
| **文件** | `requirements.txt` → `requirements-gpt-sovits.txt` · `tools/deploy/bootstrap.ps1` · `tools/deploy/install_torch.ps1` · `deploy.bat`? · `README.md`「依赖锁定」节（它现在明写「Python 依赖只有**一个** `requirements.txt`」） |
| **预期效果** | 文件名不再撒谎 —— 它只对 GSV 有效 |
| **验收** | ① `git grep -n "requirements.txt"` 的命中**全部**指向新的 GSV 专用名或 `requirements-platform.txt`，⛔ 没有裸的旧名<br>② 干净构建后新用户装平台**不再下 6.6GB**（瘦版 62MB） |

---

#### **A17** · 平台构建流程切片

| | |
|---|---|
| **理由** | ⛔ `install_torch.ps1` **只支持 N 卡**，无卡时装 CPU 版 —— 而 CPU 版 + 瘦 venv = 训练彻底不可用，且**没有自检会告诉你** |
| **scope** | ① 启动器拆两段：**第一段** venv + npm + ffmpeg（瘦身）· **第二段** 模型下载<br>② `install_torch.ps1` 加 **XPU 分支**（判据可复用 `tools/engine-wizard/core/hardware.js` 的 StabilityMatrix 偏好顺序）<br>③ **CPU 版构建后自检**：装完 probe torch，**断言训练线可用/不可用**，不可用就明写 |
| **文件** | `tools/deploy/bootstrap.ps1` · `tools/deploy/install_torch.ps1` · `deploy.bat` |
| **验收** | ① 干净构建后 `venv` ≤ 100MB 量级<br>② 无 N 卡机器上 `install_torch.ps1` **明确说走了哪条分支**<br>③ ⭐ **构建产物里明写「本机训练线可用 / 不可用 + 原因」** |

---

#### **A19** · ⭐⭐ 把盘上那个根 venv 换成瘦版（大清理）

| | |
|---|---|
| **scope** | 删掉 `venv/`（**7.0 GB · 457 个包**）→ 用仓库内嵌 python 重建 → 只装 `requirements-platform.txt`（**3 个包 / 62MB**） |
| **文件** | ⛔ **零代码改动**（只有 `venv/` 目录本身）· ✅ **但要加一条守卫测试**（见验收 ⑥） |
| **⛔ 前置** | **A14**（训练不再指根 venv）· **A16**（已更名，没有东西再引用它）· **A17**（有构建后自检兜底） |
| **⭐ 为什么本机低风险** | [实测] 盘上那个 venv **已经起不来**（base 解释器在旧机）⇒ **删掉不损失任何可用能力**；而包清单在 git 里（`requirements-gpt-sovits.txt` / `requirements-platform.txt`）⇒ **可完全重建** |
| **预期效果** | 根 venv 从 **7.0 GB → ~62 MB**；`lib/training/` 不再指向它；**训练线在本机不可用，且必须明写** |
| **验收** | ① `venv/Lib/site-packages` 里只有那 3 个包（+ pip/setuptools 之类构建物）<br>② `du -sh venv` ≤ **100 MB**<br>③ ⭐ `npm test` **仍然 0 fail** —— 这是 A15 的红利：**测试不再依赖根 venv**，所以换掉它不会动摇基线<br>④ `node tools/dev/check-engine-env.cjs` 四台读数不变<br>⑤ ⭐ **构建/自检输出里明写「本机训练线不可用：无 CUDA + 根 venv 不含 torch」**<br>⑥ ⭐ **加一条守卫测试**：断言根 venv 的 site-packages 里**没有** `torch` / `librosa` / `soundfile` / `fastapi` —— ⚠️ **C12 不变式 1 至今没有任何守卫**，不配守卫它会慢慢长回 457 个包 |

⚠️ **⑥ 是这一刀真正的耐久度所在。** 前五条是一次性的，⑥ 才防它长回来。

---

### 5.3 第 2 批 · ⭐ **引擎层（不是平台的事）**

> ⚠️ **Owner 2026-10-04：「引擎的归引擎自己管。」**
> ⇒ 重建 `engines/<id>/.venv` 是**接入者/引擎层**的事。平台只提供
> 「照名片跑 `env_command`」（向导 `core/env.js`）+ 三道校验。
> ⚠️ 但「本机跑得起来」≠「按名片装好了」⇒ 见 A13。

---

#### **E1** · 重建两个死掉的引擎 venv

| | |
|---|---|
| **现状** | [实测] `engines/gpt-sovits/.venv` 与 `engines/indextts2/.venv` 的 `home` 都指向旧机 ⇒ `uv trampoline failed to spawn`。⚠️ `engines/cosyvoice2/.venv` **是活的**（用仓库内嵌 python 建的）—— **不要动它** |
| **⭐ 建法（这是「以后注意」的落地）** | **用 uv，但 base 指向仓库内嵌解释器** ⇒ 跟 `cosyvoice2` 一样可跟着仓库搬：<br>`uv venv --python tools/runtime/python/python.exe engines/<id>/.venv`<br>⚠️ ⛔ **别用 uv 默认的托管解释器** —— 那正是今天这四个死掉的成因（`home` 写死 `%APPDATA%\uv\python\...`，项目一搬就作废） |
| **装什么** | ⛔ **每台装什么由它的名片的 `install.env_command` 决定，平台不猜**（`installPlan.js:44`）。⚠️ IndexTTS2 的配方是 `uv sync`；⛔ **GSV 的名片 `install: null`** ⇒ 它没有配方 ⇒ 见 §5.7 |
| **验收** | ① `node tools/dev/check-engine-env.cjs --engine <id> --deep` 退出码 0<br>② ⭐ **freeze 必须提交** —— `uv pip freeze` 出来进仓库（项目纪律：「freeze 就是锁，没有第二个文件、没有生成器」）<br>③ 变异/回归：`npm test` 不退化<br>④ ⚠️ **先只对一台做**（建议 `indextts2`，它有现成配方），验通再对第二台 |

---

#### **E2** · 冻结 `C:\Aurivox` 的推导产物 —— ⭐ **不然这台机器的结论无法复现**

| | |
|---|---|
| **问题** | `C:\Aurivox\envs\*` 是 2026-10-02/03 **手建**的（torch 2.14.1+xpu + 每台独立 transformers 版本 + 不装 flash-attn），**没有 freeze、没有进仓库、没有进任何契约** ⇒ 谁都复现不出来 |
| **⚠️ 但它现在只是「参考样本」** | ⛔ **不作为接线目标** —— 名片说 `uv sync`，那套环境与配方矛盾 ⇒ 接上去就是「漂移不报错」（A13） |
| **scope** | 把三件事**固化进仓库**：① 各台 XPU 版的**包清单**（freeze 或 requirements）② 需要的**补丁**（`ta_soundfile_shim.py` 等，⚠️ 探针补丁不是平台解法）③ **可复跑的探针脚本** |
| **文件** | 全部归 `tools/dev/`（`ROOT_LAYOUT.md`：助手产出物永远归 `tools/dev/`）· 配方本身进手册 |
| **验收** | ① 一个**没参与过那次探测的人**照仓库里的清单能重建出等价环境<br>② 手册里写清「哪些是探针结论、哪些已进平台代码」 |

---

### 5.4 第 3 批 · 向导 `core/`（⚠️ 在向导树内，但**不在 `editor/`**）

> ⚠️ **这三条要你确认**：它们在 `tools/engine-wizard/` 里，和那棵正在被改的树同属一棵，
> 但改的是 `core/`（纯 Node 模块，跟着 `npm test` 跑，**不需要界面能打开**）。
> [实测] `core/` 最近一次写入是 20:06，`editor/` 是 23:14 ⇒ 冲突概率低。

---

#### **A8** · 下完对一次名（缺 / 多 / 后缀不符，三态）

| | |
|---|---|
| **scope** | 比较「盘上实际有的」vs「名片 `models.required`」，报三态：<br>**缺** —— required 里有、盘上没有<br>**多** —— 盘上有、required 里没有（⚠ 要排除运行期产物）<br>**后缀不符** —— strip 扩展名后同名但后缀不同 |
| **为什么需要「后缀不符」** | [实测] `indextts2/checkpoints/config.yaml` 写 `gpt.pt` / `s2mel.pt`，**盘上是 `gpt.pth` / `s2mel.pth`** —— 这个不一致真的发生过 |
| **⛔ 不许复制占位符替换** | 权威实现是 `lib/engines/checkpoints.js` 的 `checkpointStatus` / `fillPlaceholders`。**自己写一遍替换规则 = 两处会漂**，而漂移的校验会骗人 |
| **文件** | 新建 `tools/engine-wizard/core/checkpoints-audit.js` · 新建 `tools/engine-wizard/test/checkpoints-audit.node.test.js` · `tools/engine-wizard/core/wizardbridge.js`（加端点 + 注册进 `HANDLERS`） |
| **预期效果** | 前端拿到一份三态清单，而不是一个布尔 |
| **验收** | ① ⭐ **用 `indextts2` 当真实回归样本**：必须报出「后缀不符：`gpt.pth` vs `gpt.pt`」<br>② `.cache/`（cosyvoice2）与 `hf_cache/`（indextts2）**必须被识别为运行期产物，不报「多」**<br>③ ≥6 条真行为测试<br>④ ⭐ **变异**：把「后缀不符」判据去掉 ⇒ 必须有测试变红<br>⑤ **接线判据**：测试要断言它调的是 `checkpoints.js` 那个实现（`ENGINE_ONBOARDING_CONTRACT.md` §9 的 E1 判据：全绿不证明接线对） |

---

#### **A9** · 权重候选探针（多源交叉 + 置信度）

| | |
|---|---|
| **scope** | 扫出候选权重清单，**每条标来源 + 置信度**。三源：<br>① 引擎自带的 config（yaml/json 里指向文件的字段）<br>② 代码里的下载调用（`snapshot_download` / `from_pretrained` / HF repo id）<br>③ 上游的结构化清单文件 |
| **⚠️ [实测] 三源都不完全可靠** | IndexTTS2 的 `config.yaml` 点名 5 个但**后缀错 + 漏 3 项**（`bpe.model` / `pinyin.vocab` / `qwen0.6bemo4-merge/`）<br>⛔ **CosyVoice2 的 `cosyvoice2.yaml` 里一个权重文件名都没有** ⇒ 源①对它**完全失效** |
| **⛔ 硬纪律** | 探针**永远不写盘**，产物**永远不进 `models.required`** —— 只有人确认过的才算「齐了」。理由：自动判定会把一台好好的引擎报成「缺文件」（`gpt.pt` vs `gpt.pth` 就是现成例子） |
| **文件** | 新建 `tools/engine-wizard/core/weight-discovery.js` · 新建 `tools/engine-wizard/test/weight-discovery.node.test.js` |
| **预期效果** | 候选清单 + 每条标 `_confidence` / `_why`，照抄 A1（`reflect_params.py`）的形状 |
| **验收** | ① 对 `indextts2` 跑：必须捞出 `feat1.pt` / `feat2.pt` / `gpt.pth` / `s2mel.pth` / `wav2vec2bert_stats.pt`，**并显式报出「config 说 `.pt` 而盘上是 `.pth`」这个冲突**（而不只是给候选）<br>② ⛔ 对 `cosyvoice2` 跑：必须**如实报「config 源一个文件名都没找到」**，不许返回空数组了事<br>③ 变异：把置信度恒设 `high` ⇒ 必须有测试变红<br>④ 探针跑完盘上文件数**一个不变** |

---

#### **A7** · 真下载（续传 / 并发 / 进度）

| | |
|---|---|
| **scope** | 执行名片里的 `models.source.command`（⛔ **不生成**，只执行） |
| **为什么不算破「只验不建」** | 规则禁的是「**平台生成**命令」（HF/ModelScope/直链/网盘各家不同，生成就把那一家写进 `lib/`）。而 `models.source.command` **已经是名片声明的 argv**，平台已经会填占位符、已经知道 `license_gate`。**执行 ≠ 生成** |
| **必须有的三件** | **断点续传**（5.49GB 断一次很难受）· **并发**（`llm.pt` 单文件 2GB 是串行瓶颈）· **进度显示**（前端要显示「3/8 完成」） |
| **文件** | 新建 `tools/engine-wizard/core/download.js` · 新建 `tools/engine-wizard/test/download.node.test.js` · `wizardbridge.js`（加端点，⛔ 走流式/轮询回进度） |
| **验收** | ① ⭐ **拿 `cosyvoice-300m-sft` 当真实样本**（2.2G，最小的那台）：能下完、能中断续传、能报进度<br>② `license_gate: true` 的引擎在点同意之前 ⇒ **报出 401/403 并说清「那看着像网络故障，其实不是」**（这句话 `core/models.js` 已经写好了，要接上）<br>③ ⛔ **不生成任何命令** —— 测试要断言执行的 argv 与名片里写的**逐字相同**（占位符替换除外）<br>④ 下完自动接 **A8** 复核，缺/多/后缀不符如实报 |

---

#### **A4''** · 钉版本 + 删 `.git` —— ⛔ **有破坏性，需要 Owner 在场**

| | |
|---|---|
| **⛔ 硬前置** | **D1**（§6.1 裁定）—— 不知道 pin 该在哪一刻强制，这一步没法写 |
| **scope** | clone 之后、名片写完之后：`git checkout --detach <commit>` → 删 `.git` |
| **⚠️ 为什么必要** | C10：删掉上游 `.git` 之后，`upstream.commit` 就是**唯一**还记得这是哪一版的地方。而今天 clone 完 `.git` 留着、名片 `commit` 可能为 null ⇒ **版本有两个来源，都不权威** |
| **⚠️ 三个安全阀** | ① commit 为 null ⇒ **不删 `.git`**，并明确警告「版本只有 `.git` 知道」<br>② 删之前把 commit 的**全 sha** 显示出来 + **显式解锁**（照 `RiskUnlock`）<br>③ **幂等**：`.git` 不在就跳过，不报错 |
| **文件** | 新建 `tools/engine-wizard/core/pin.js` · 新建 `tools/engine-wizard/test/pin.node.test.js` |
| **验收** | ① 在**临时目录**造一个假引擎（`git init` + 一次 commit + clone）⇒ 跑 pin 后 `.git` 不在了、**文件内容 == 那个 commit**<br>② commit 为 null ⇒ `.git` **还在**，返回明确警告<br>③ ⭐ **变异**：把 `checkout --detach` 去掉只删 `.git` ⇒ **必须有测试变红**（那会**丢掉源码内容**，这是本步最危险的错法）<br>④ 幂等：连跑两次不报错 |

---

### 5.5 第 4 批 · 动真实数据（17.6 GB）

#### **A6①** · 搬三台非训练线引擎的权重

| | |
|---|---|
| **⛔ 不动 GSV** | `models/tts/gpt-sovits/`（2.8G）留在原地。**Owner 2026-10-04：GSV 是例外模型，永不搬** |
| **scope** | `models/tts/{cosyvoice2, cosyvoice-300m-sft, indextts2}` → `engines/<id>/checkpoints/` |
| **文件** | 3 张名片的 `runtime.checkpoints`（**各一个字符串**）· 新建 `tools/dev/move-engine-checkpoints.ps1`（助手产出物归 `tools/dev/`） |
| **为什么这么便宜** | ✅ `.gitignore:213-221` **已有 `engines/*/checkpoints/`**（2026-09-04 就加了）<br>✅ C3 契约不破（`profile.js:503` 禁的是**绝对路径**，仍相对项目根）<br>✅ 同盘（D: → D:）⇒ `Move-Item` 秒级，**不踩 `.staging` 那条「rename 不能跨盘」的坑**<br>✅ 顺带闭环 `engines/cosyvoice2/` 那个**嵌套 `.git`**（C10 明令禁止那种，权重进引擎目录后它必须删） |
| **⚠️ 注意路径深度不同** | `indextts2` 现在是**两层** `models/tts/indextts2/checkpoints` ⇒ 搬完变**一层**。名片改一个字符串就对得上，但别以为搬错了 |
| **预期效果** | 「引擎自己下载到自己的目录」成立；`models/tts/` 只剩 GSV |
| **验收** | ① `node tools/engine-checkpoints.cjs <id>` 三台仍 ✅<br>② `node tools/dev/check-engine-env.cjs` 三台的「权重: 在」不变<br>③ ⛔ **加一条守卫测试**：断言 `gpt-sovits` 的 `runtime.checkpoints` **没有被这次改动碰过**<br>④ `npm test` 不退化<br>⑤ ⚠️ **先只搬一台**（建议 cosyvoice2，最小且它还带嵌套 `.git`），验通再搬剩下两台 |

---

### 5.6 第 5 批 · `editor/` —— ⛔ **等向导前端收工后再做**

> ⚠️ 这三条全部改 `tools/engine-wizard/editor/`。那棵树的前端正在被另一路开发，
> **Owner 明确要求不碰**。列在这里是为了让「下一刀接得上」，不是现在就动。

| | scope | 文件 | 验收 |
|---|---|---|---|
| **A11** 术语改名 | 权重→**Checkpoint** · 名片→**Manifest** | `editor/steps.js` · `StepsExtra.jsx` · `NestedSections.jsx` · `MainArea.jsx` · `Diagnostics.jsx` · ⚠ 产品前端 `ReferenceCompareTab.jsx:1363`（**单独裁**：它面对最终用户） | ⛔ 名片键 `models.*` / `runtime.checkpoints` **一个都不许改**（磁盘既有格式）<br>⛔ **231 处注释里的「名片」一个字都不动**（只有 16 处是用户可见文案）<br>⚠️ 残留不一致要显式承认：**步骤叫 Checkpoint、端点仍叫 `/wizard/models`** |
| **A10** 名片三件套 | 白话标题 · 一句话说填什么 · **格式+例子+填错报什么**；三段分组（必须人填 / 能反射 / 有先例） | `editor/ManifestForm.jsx` · `NestedSections.jsx` · `core/fieldmeta.js` | ⭐ **第三件零成本**：`profile.js` 每个键的抛错消息**本身写了「应该写什么」** ⇒ 提到字段下面<br>三段分组的界面对应「不填不许下一步 / 自动填+标反射 / 自动填+标来源」 |
| **C4** 第 5 步接 Player | 三块独立显示：① 引擎起没起 + 状态码 ② **音频 → 复用 `web/src/components/common/Player.jsx`** ③ ASR 回读（延后，缺了就写缺） | `editor/StepsExtra.jsx` · 新建 `core/verify-audio-ui.js` · `web/wizard.vite.config.mjs`（**加一条 `/outputs` proxy**） | ① ⛔ **`Player` 吃 URL 不是 blob** ⇒ 产物要落 `outputs/_verify/<id>/<ts>.wav`（`server.js:344` 已挂 `/outputs` 静态）<br>② ⭐ **「能解码并出声」本身就是校验** —— `Player` 内部 `fetch` + `decodeAudioData`，[实测] 相似度 0.216 那段音频**所有非空判据全绿（含 ffprobe）**，而波形图会立刻显示「一段一段的」<br>③ 三块**互不依赖**，缺③不许把①②标红<br>④ ⚠️ 浏览器 autoplay 会拦 ⇒ 界面上别写「自动播放」 |

---

### 5.7 明确不做

| | |
|---|---|
| **搬 GSV 的权重** | ⛔ **Owner 2026-10-04：GSV 是例外模型，永不搬。** 不再是「等 C3」，是**不做** |
| **C3 训练线解绑 GSV** | ⛔ Owner 2026-09-29 已裁决「暂不做」—— 而 A6① 不再需要它 |
| **A 级自动合成** | ⛔ 已降级：向导第 5 步改成「三块独立显示」，A 级那套留在 `tools/verify-engine.cjs` 供手工用 |
| **给 `models` schema 加 SHA 字段** | ⚠️ 会动磁盘既有格式 ⇒ 要走 C11 豁免那套论证。**别顺手做** |

---

## §5.10 ⭐ 跨平台抽离（2026-10-05，Owner 指令）

> Owner 定的形状：**脚本主体用通用语言（Node），`.bat` / `.sh` 只是薄壳**。
> 起因：开发验证平台从 CUDA 机器换成 Arc，而部署与启动链 **1723 行 PowerShell
> 全是 Windows 独占** ⇒ Linux / macOS 上根本装不起来。

⭐ **实测结论和原本的估计不同**：那 665 行（bootstrap）里真正锁死 Windows 的
只有两处 —— `venv\Scripts\python.exe`（6 处）与 `Join-Path` 的反斜杠（7 处）；
`Get-NetTCPConnection` / `Get-CimInstance` / `Get-Process` / `netstat` /
`nvidia-smi` / `Win32_` / `taskkill` / 注册表 **各 0 处**。
⇒ 那 600 行是**平台无关的流程**，只是用 PowerShell 的壳写着 ⇒ **照搬换壳**，
不是重新设计。这条结论值得记住：**下次估「移植工作量」别只看行数。**

| 原文件 | 行数 | 新主体 | 薄壳 |
|---|---|---|---|
| `bootstrap.ps1` | 665 | `tools/deploy/bootstrap.js` | `bootstrap.bat` / `.sh` |
| `start.ps1` | 547 | `tools/cli/start.js` | `start.bat` / `.sh` |
| `install_torch.ps1` | 372 | `tools/cli/install-torch.js` | `install-torch.bat` / `.sh` |
| `stop.ps1` | 139 | `tools/cli/stop.js` | `stop.bat` / `.sh` |
| `install_pytorch.bat` | 55 | **删**（同一件事的第二个入口名 = 会漂移） | — |

⭐ **共享原语抽成两个库**，而不是四个入口各写一份：
  · `lib/system/ports.js` —— 三平台的「谁在监听 / 这是谁 / 杀掉它 / 拉起后台进程」
  · `lib/system/portChoice.js` —— 那 90 行端口归属算法，**逐条搬**（含来历）

⚠️ 顺带做完 A17 的 ③：`install-torch` 的设备分支从「只支持 NVIDIA」扩到
**NVIDIA / Intel(XPU) / AMD(ROCm, Linux only) / Apple / CPU**。

### 三条「不许删」的纪律，随主体一起搬到了守卫里

1. ⛔ **只认 LISTENING**，不认 TIME_WAIT —— 否则 start 误判「上次还在跑」而拒绝重启
2. ⭐ **端口必须在第一个 spawn 之前全部定完** —— 端口经环境变量传递，而
   `spawnDetached` 出来的进程是脱离的，spawn 那一刻就把环境变量拷走了
3. ⛔ **绝不调 `npm.cmd`** —— 它按 PATH 推断 npm 在哪，装过全局 Node 的机器上
   会跳到全局那份，报 ERR_REQUIRE_ESM 而**错误里一个字都不提这件事**

### 实测踩到并已写进守卫的坑

· **`.bat` 必须纯 ASCII** —— cmd.exe 按系统 OEM 代码页（本机 GBK）读 `.bat`，
  GBK 解码 UTF-8 会把行尾 `0x0A` 当成双字节字符后半截吃掉 ⇒ 换行错位 ⇒
  cmd 把注释碎片当命令执行。`chcp 65001` **救不了**（只影响它之后的行）。
· **ROCm 的 index 不能照抄 CUDA 的拼法** —— ROCm 用**自己的版本号**（`rocm6.1`），
  照抄会得到不存在的 `rocm121`。由守卫抓到。
· **目录扫描只能比可执行文件路径，不能比命令行** —— 命令行里含仓库路径的东西
  包括用户那个「cd 到项目目录再运行 stop」的 shell ⇒ 比命令行会**杀掉用户的 shell**。
· **逐个 pid 查进程 = 每个进程起一次 PowerShell** ⇒ 204 个进程要几十秒。
  改成一条命令拿全 ⇒ **353 ms**。
· **进程表缓存不能是进程生命周期级** —— 之后才起的进程查不到 ⇒ stop 的第二遍
  （专门为「已经不监听但还活着」准备的）会说「没有」。

### ⭐⭐ 一次教训，值得单列

**「文本扫描」测不出代码行为** —— 这个项目已经为它栽了**四次**：
守卫按「文件存在」判 · 守卫静默 skip · `engine_online` 扫到 JSDoc ·
守卫读着自己的说明书（「⛔ 不许报成 MISSING/FAILED」）判自己不合格。

⇒ **规律：扫文本之前先问「注释会不会被算进去」。**
⇒ 更进一步：`engine_online` 那条守卫最终改成**问函数自己**
（给它两个 health 变体，看读数动不动）—— ⭐ **测行为，不是测文本**。

## §5.11 ⭐ 剩下的事，按「谁来做」分（2026-10-05 复核磁盘实况）

> ⛔ **Owner 指示：`tools/engine-wizard/**` 不用我做** ⇒ 下表按落点分开。

### 🔴 落点在 wizard（不用我做）

| | 内容 | 落点 |
|---|---|---|
| **A4** | GSV 迁新版声明 | `engines/gpt-sovits/**` |
| **A4''** | 向导补「钉版本 + 删 `.git`」 | `core/pin.js` |
| **A7** | 第 3 步真下载（现在只打印命令） | `core/download.js` |
| **A8** | 权重下完对一次名（缺/多/后缀不符） | `core/checkpoints-audit.js` |
| **A9** | 权重候选探针（自动发现，多源交叉） | `core/weight-discovery.js` |
| **A10** | 名片表单三件套 + 三段分组 | `editor/ManifestForm.jsx` |
| **C4** | 第 5 步三块独立显示（复用 `common/Player.jsx`，**已存在**） | 向导第 5 步 |
| ~~欠账~~ | 清用户可见文案里的 `installPlan.js:行号` | `core/env.js` · `core/clone.js` |

### 🟢 落点不碰 wizard（我能做）

| | 内容 | 落点 | 备注 |
|---|---|---|---|
| **E1** | ⭐ **重建引擎环境** | `engines/*/.venv` | **[实测] 三个 venv 是 uv 建的、不可搬运** ⇒ 训练/微调/UVR5/ASR/切片**现在全部不可用**，而没有任何自检会告诉用户 |
| **A17③ 后一半** | ⭐ **构建后自检**：训练线不可用时**明写原因** | `tools/deploy/bootstrap.js` | 与 E1 配套 |
| **A17①②** | 启动器拆两段（venv+npm+ffmpeg / 模型下载） | `tools/deploy/bootstrap.js` | E1 走新流程要先有它 |
| **A13** | 登记 `envCheck` 不验「是否按名片配方装的」 | `lib/engines/envCheck.js` 文件头 + 本表 | **零代码**。⚠️ [实测] `C:\Aurivox\envs\indextts2` 是 torch 2.14.1+xpu，而那张名片的配方是 `uv sync`（cu128）⇒ **全绿但环境不对**，比会响的失败更危险 |
| **A6①** | 3 张名片写 `runtime.checkpoints` | `engines/*/manifest.json` | ⚠️ **GSV 永不做** ⇒ 只动另外三张。[实测] 现在 4 张全是 `models/tts/*` |
| **A11** | 术语：权重→**Checkpoint**、名片→**Manifest** | `web/src/` 为主 | [实测] 现在 `名片` 190 处 / `Manifest` 36 处；`web/src/` 里 名片 23 文件 / Manifest **2** |
| **B2** | launch 位只能换目录 | `lib/engines/launchPlan.js` | B1（`MAX_LAUNCH_SLOTS=1`，已定位未修）的根因 |
| ~~D1~~ | ~~commit 必不填~~ | — | ✅ **已由代码落地**，见 §5.1 |

### ⭐ 我这边该做的顺序

```
1.  A17③ 的自检框架   ← 先搭框（能报「不可用 + 原因」）
2.  E1 重建引擎环境   ← 让框架有东西可验
3.  → 自检真跑出「训练线不可用 + 为什么」
4.  A13 登记（零代码，随时可插）
```
⚠️ E1 的前提是 A17①（新的安装流程第一段）。

⭐ **分支 `feat/env-isolation-gpu-detect` 上叠了 11 笔，全部未 push**，
其中 3 笔是另一个会话的（`b6f233e` / `52f08d4` / `c93fe65`）—— 两人在同一条历史上。

## 5. 维护纪律

1. **做完一刀，当场改第 2 节那张表的状态格。** 不许记在别处。
2. **证据分级**：`[实测]` / `[读码]` 必须标。读码不等于跑过。
3. **不许把「已实现」写成「已验证」**——本项目最贵的 bug 都是这两者的差。
4. **台账只减不加会漏**：「该删的还剩几行」量不到「该接的还没接」。
   C 组那些 0 成本的条目当初就不在表上，正是这个原因。

---

### 5.8 ✅ 那道待裁：已裁（Owner 2026-10-04）

**裁定原文**：「GSV 那 200 个包归**引擎环境兼训练扩展环境**，这个是作为**暂时的候补**」
「训练和 GSV 推理**暂时共用一个 venv**，这个已经经过本机和上一部开发机验证」

⇒ **落成三句**：

| | |
|---|---|
| **GSV 的依赖装在哪** | `engines/gpt-sovits/.venv`（**不是**根 `venv/`、**不是** `train/` 另开） |
| **训练用哪个解释器** | 同一个 `engines/gpt-sovits/.venv`（A14：`lib/training/python.json` 指向它）—— ⭐ 用户已验证过（本机 + 上一部开发机） |
| **性质** | ⚠️ **暂时的候补** —— 真正的形态是「每台引擎一套，而训练作为引擎的扩展共用它」。等真有第二个可微调引擎时再拆 |

⚠️ **这个裁定同时解开了 A16 / A17 / A19 的卡点**，而且它与 C3（训练链绑死 GSV，Owner 裁决「暂不做」）**不矛盾**：
C3 说的是「不做第二个可微调引擎的训练抽象」，而这里是把**已存在的 GSV 训练环境**归位。

### 5.8b ⛔ 由此暴露的下一个卡点（**待裁**）

`engines/gpt-sovits/.venv` 要装 GSV 的 **200 个包**，而 GSV 的名片 **`install: null`**
⇒ **它没有 `env_command`** ⇒ 平台「只验不建」，不会替它装。

| | 选项 | 后果 |
|---|---|---|
| **甲** | 给 GSV 名片补 `install.env_command` | ⭐ 名片从此是这 200 个包的**唯一权威**；但那份 freeze 得进版本库（约 200 行） |
| **乙** | 承认它是**手工的、不受平台管的**历史环境 | ⛔ 与「`runtime.python` 是活键」矛盾 —— 平台会一直报「没装」而人不知道为什么 |

⚠️ **这落在 E1（重建引擎 venv）上**，而 E1 是引擎层的事。**等第 2 批开工时再定。**
