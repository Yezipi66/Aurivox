# 引擎接入 —— 现状台账

> **最后核对：2026-10-23**（§3c 三笔环境事实逐句复核，X1/X2/X3 全部过期，已在原处标注）
>
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
| **A7** | ⭐ **第 3 步真下载**（断点续传 + 并发 + 进度 + 取消） | ✅ **3/3 已做**（2026-10-24 补齐并发与真取消）· 🔴 `core/download.js` · `editor/downloadQueue.js` · `editor/downloadRunner.js` | [读码] `models.source.command` **已经是名片声明的 argv**，平台已会填占位符（`{checkpoints}`→绝对路径）、已知道 `license_gate`。⇒ **执行它不违反「只验不建」** —— 规则禁的是「平台**生成**命令」，不是「平台**执行** | ✅ **三件已齐**（2026-10-24）：**断点续传**（`Range` + `.tmp` 探测）· **进度**（tqdm 解析 + 按文件分槽显示）· **并发**（默认 **6**，一文件一请求，`editor/downloadQueue.js` 调度 + `editor/downloadRunner.js` 执行）。⭐ **取消已从「后端函数级」补到「使用者能按」**：`POST /wizard/download/cancel` + 界面取消按钮（此前只有 `downloadFileFromUrl` 的 `signal` 参数，前端根本没有能按的取消，界面上也按不了）。⚠️ **订正旧记**：「已有取消」指的是上游命令那条路径的参数级取消，**不是使用者能取消**。⛔ **未做**：① 验收点 ①「拿 `cosyvoice-300m-sft` 当真实样本（2.2G）下完」未跑（2026-10-24 验的是 huggingface 上 144MB 的 `openai/whisper-tiny`，真机取消 ⇒ `CANCELLED`、无残留 `.tmp`、可重下）② 验收点 ② `license_gate: true` 的 401/403 提示未接（`core/models.js` 文案已有，尚未接上）⚠️ **规则没被写全**：「不替你下载」的准确含义是「**不替你决定从哪儿下**」，要回写进 `_TEMPLATE/README.md`。⚠️ `[待裁]` 是否加 SHA 字段（会动磁盘格式） |
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

> **2026-10-05 结项（部分）**：③ **已完成**，且顺手把主体从 372 行 PowerShell 移到 `tools/cli/install-torch.js`（跨平台；薄壳 `install-torch.bat` / `install-torch.sh`）。构建分支现按本机设备选：**NVIDIA→cu121 · Intel→xpu · AMD/Linux→rocm · 其余→CPU**（原文件第 12 行写着「no AMD / DirectML」）。8 条守卫（`tools/cli/install-torch.node.test.js`）。⛔ **本项剩下的**：①② 启动器拆两段 + ③ 的「CPU 版构建后自检」还没做 —— 也就是说**训练线不可用这件事仍然没有任何自检会告诉用户**。
| **A21** | ⭐ **项目探测器只认 `pyproject.toml`，读不出老式布局仓库的包名与许可证** | ⬜ **待开** · 🔴 `wizardbridge.js:200-215`（`/wizard/probe`） | [实测 2026-10-12] 用 `QwenAudio/CosyVoice` 触发：GitHub API 确认上游根目录**确实没有** `pyproject.toml`（只有 `requirements.txt` / `setup.py` / `LICENSE`），所以 `texts['pyproject.toml']` 为空 ⇒ 走 `:200` 那条「如实报读不到」的分支，`meta` 里只剩 `dependencies`，包名/许可证/PYTHON 三个字段全是 `—`。⚠️ **同一响应里它已经扫到了 `requirements.txt`**（`meta.dependencies.primary.f`），于是形成荒唐局面：**依赖清单读到了，却因为另一种文件缺失而拒绝报告其余事实** | ⛔ **不是回归**：该段代码最后改动是 `0b12be3`（2026-10-06 i18n），早于 python 参数发现那条线（2026-10-11 起）。⛔ **「如实报读不到」这个纪律本身没错**，错的是「认」的范围太窄 —— 把「`pyproject.toml` 里没有」当成了「上游没给」。⚠️ 三个字段的真实来源都**不需要** pyproject：包名在 `setup.py` 的 `name=`、许可证在根目录 `LICENSE` 文件、Python 版本在 `.python-version`。⚠️ 后果是**劝退级**的：CosyVoice 是最主流的开源 TTS 之一，探测器对它给出一片空白加一句「请改用带依赖清单的仓库」，而它自己刚读到那份依赖清单。⚠️ 与 P4 的关系：**P4 的验收目标之一（CosyVoice python 路端到端）在第 1 步就会断**，但这是**范围扩张**，Owner 2026-10-12 裁决选 C（先记台账，专心做完 P4）。⭐ 修的时候要分清边界：探测器的「认哪些文件」与参数发现的「读哪些参数」是两件事，别混进 P4 | |
| **A22** | ⭐⭐ **建引擎环境时用哪个 Python 版本** | ✅ **2026-10-24 已做**（`9a4db17`） | [实测 2026-10-24] 平台根 `venv/` 被外部工具换成了 **CPython 3.14.7**（2026-10-21 建的，base 在 Hermes 的工具目录里）。`envDetect.js` 的 `platformPythonAbs()` 只查文件存不存在、不查版本，`buildVenvStep()` 把这个路径塞进 `--python` ⇒ 引擎环境成了 cp314 ⇒ 上游钉的 `torch==2.5.1` 在 PyPI 只有 cp39/cp310/cp311/cp312 轮子 ⇒ 第 2 步报 `Because torch==2.5.1 has no wheels with a matching Python ABI tag (e.g., cp314)` | ⛔ **规则（Owner 定的，写进代码）**：**引擎声明了 Python 版本就用声明的，没声明就用平台基座 3.11** —— 引擎声明的来源是 `.python-version`（取主次）或 `pyproject.toml` 的 `requires-python`（**区间取区内最高的版本**：`>=3.10,<3.12` ⇒ 3.11、`>=3.10,<3.13` ⇒ 3.12、`>=3.10,<=3.12` ⇒ 3.12、只有下界 `>=3.10` ⇒ 3.10）。⭐ **取最高而不是最低**：区间表达的是「这一族都能跑」，上游通常在较新的 Python 上测过，取区内最高才落在上游真正测过的那一档。⛔ **绝不回落任意版本**：拿不到就报 `NO_PYTHON_FOR_VERSION`，不静默换一个能跑的版本。⚠️ **两个 Python 角色要分开**：`argv[0]` 是「跑 uv 的那个解释器」，它**必须带 uv**（平台根 venv / `cache/slim-venv`）；`--python` 后面那个才是「新环境用哪个版本」，给**版本号而不是路径** ⇒ 本机没有那个版本时 uv 自己下载（实测 3.10 / 3.11.13 / 3.12 都拉得下来）。⭐ **「跑 uv 的那个」的版本不重要**（uv 是跨 Python 版本的 Rust 二进制）—— [实测] 同一个 `uv.exe` 建 `--python 3.11` 得 3.11.15、建 `--python 3.12` 得 3.12.13 ⇒ 结果只由 `--python` 决定，所以选壳时**不必**加版本约束。⚠️ **平台基座 = 仓库内嵌解释器 `tools/runtime/python/python.exe`（3.11.9）**，而**不是**平台根 venv —— 后者的版本由本机历史决定（曾被换成 3.14.7），不作权威。⚠️ 内嵌解释器**没有 uv**，只能当目标解释器，不能当跑 uv 的那个。✅ [实测] `spark-tts`（无声明）建成 **Python 3.11.15**，`torch==2.5.1` + `torchaudio==2.5.1` 全部装上且能 import。✅ **平台根 venv 已重建为内嵌 base**（Owner 2026-10-24 裁定「从这里开始部署」，`cabbf76`）：现在是 **Python 3.11.9**，`pyvenv.cfg` 的 `executable` 指向 `tools/runtime/python/python.exe`，6 个包（pip / uv / packaging / hf_transfer / setuptools / wheel），`uv 0.12.1` 可用。⭐ 配套补了 **bootstrap 的健康检查第二道判据**（base 必须是内嵌解释器，原来只判「能不能跑」⇒ 3.14 那个场景完全看不见），并加了 `--venv-only` 开关（只做「把根 venv 部署成内嵌 base」这一件事，不装 torch / ffmpeg / npm / 模型）。⚠️ `tools/wheels/jieba_fast-0.53-cp311-cp311-win_amd64.whl` 只认 cp311 ⇒ 重建后 ABI 对上了 |
| **A23** | ⭐⭐ **上游钉的 torch 版本在本机后端上不可用时，平台应当先说清而不是装到一半才炸** | ✅ **2026-10-24 已做**（`3e40c75` + `66f3aed` + `538e682` + `4817602` + `c96fc59` + `eafbee9`） | [实测 2026-10-24] XPU/ROCm 的官方 index 起步比 PyPI 晚：`torch==2.5.1` 在 **xpu index 上根本没有**（连 2.5.0 也没有），xpu 的 cp311/cp312 从 **2.6.0** 才有。⇒ 上游按 PyPI 钉版本，装到 XPU 机器上必然失败，而 uv 的报错（`No solution found when resolving dependencies`）看不出真因是「torch 版本与后端/ABI 对不上」 | ⛔ **判据只读两样事实**：① 上游声明的 torch 版本（requirements / pyproject / lock 里读出来的事实）② 该 (官方 index, 平台族, Python ABI) 组合的版本下界（事实表）。**查不出就不猜、不给假建议。** 后端映射 `cuda→cu121` / `ipex→xpu` / `rocm→rocm6.4` / `cpu→cpu`；无 index 的后端（ZLUDA / DirectML）不判断。✅ **界面给两条路**：先显示警告，点「安装」时弹窗说清「上游钉的是哪个版本、建议装哪个版本、为什么」，**使用者可以取消**（取消 ⇒ 保持上游版本安装，装法原样返回，平台不替使用者改版本）。✅ 接受 ⇒ 主安装步跳过 torch 系整族（`--excludes`），追加一步从本机后端官方 index 装建议版本，**整族版本配对**（上游声明了哪些就升哪些，不凭空加没声明的兄弟包）。⚠️ 判据是**通用后端规则**，不是围绕本机（Intel Arc / XPU）写的。⚠️ `.wizard-excludes.txt` 是**执行期才写**的（`input.execute === true`），计划阶段盘上没有这个文件是正常的。⚠️ `suggestion.ok` 的语义是「**上游钉的版本可用**」⇒ 判断成立但结论是「不可用」时 `ok` 恰为 `false`，前端判「有没有建议」要看 `suggested` 字段，不要看 `ok`。⭐ **「xpu 上没有 2.5.1」不是 index 漏了，是官方本来就没发**：PyTorch 文档说 Intel GPU 支持自 2.5 起就绪（`docs.pytorch.org/.../notes/get_start_xpu.html`），但那是**源码层面**的上游；官方 xpu **二进制轮子从 2.6.0 才开始发布**。另外 PyPI 上的 `torch-2.5.1-cp311-cp311-win_amd64.whl` 是标准 CUDA 包、**不带 XPU 后端**（17 个轮子里 0 个带 xpu/intel 字样）⇒ 装它等于装 CPU/CUDA 版，XPU 用不上。⚠️ 对照：**cpu 与 cu121 index 上都有 2.5.1** ⇒ 同一个上游声明在 CPU/CUDA 机器上原样就能装，**只有 XPU/ROCm 机器会撞上** ⇒ 这正是弹窗提示该存在的场景。⭐ **判据必须是离线的，方向是单向的**（`c96fc59`）：后端对 torch 版本的支持有**下界**，只会往更高的版本扩，**不会回头兼容更老的**（XPU 永远不会兼容 2.5）⇒ 「这个版本在这个后端上有没有」是确定的事实，查表比大小即可，**不必联网爬 index**。事实表精确到 (index, 平台族, ABI) 三元组（`core/backendTorchSupport.js`），因为取「后端下界与 ABI 下界的较大者」会误报（`cu121+cp312` 实际从 2.2.0 起，`cpu+cp313` 实际从 2.6.0 起，`rocm6.4` 在 Windows 上一个轮子都没有），取小者会漏报。⚠️ 判据是**同步**的（`suggestTorchUpgrade` 不再返回 Promise），端点在计划阶段直接给结论，不等网络，断网时也照样提示。⭐ **结论只有两种**（`eafbee9`）：`version-not-on-this-backend`（低于这个组合的下界 ⇒ 给建议版本，由使用者决定升不升级）/ `no-wheel-for-this-python`（这个组合一个轮子都没有 ⇒ 换 torch 版本也解决不了，如实告知，不给版本建议）。**原先的 `could-not-check`（没能联网确认）这个状态不再存在** ⇒ 判据已是确定的查表，不存在「没确认」这一说。✅ **两种都弹窗**：有建议就问要不要升级，一个轮子都没有就说清装不了；两种都留「照原样装」这条路（由使用者承担结果），取消后界面上有一句交代。⚠️ 没有可替换版本时**不能走升级路线**（后端会报 `NO_TORCH_SUGGESTION`），计划请求与执行请求都据此判断。⚠️ `parseTorchIndex` 要同时认 index 页面上的两种后缀分隔符写法（链接文本里是字面 `+`，href 属性里是 `%2B`），只认一种时页面只留另一种就会静默误报成「装不了」 | |

| **A24** | ⭐⭐ **断点续传只看命令文本，产物版本变了也判成「已完成」** | ✅ **2026-10-24 已做**（`8c956e2`） | [实测 2026-10-24] 做 A23 的端到端闭环时撞到：引擎环境里手工把 torch 从 `2.6.0+xpu` 降回上游钉的 `2.5.1`（`uv pip install -p <引擎venv> torch==2.5.1 torchaudio==2.5.1`），盘上 torch 变成 `2.5.1`（CPU 版，不带 XPU 后端）。此时 `.wizard-install.json` 里那三条命令的 key **一字未变** ⇒ 重跑第 2 步时**三步全部 SKIPPED**（`"Previously completed successfully — skipped"`），装依赖那步没跑、装 torch 2.6.0 那步也没跑 ⇒ 界面报「完成」、`envCheck` 也报 torch 与 torchaudio 都 `OK`（**import 成功不等于版本对**），而实际装出来的是**用不上加速的 CPU 版** | ⛔ **这是断点续传判据的第二种形态**（第一种是「产物没了」，见 `stepArtifactExists` 原本只判「site-packages 非空」那种空壳场景）：**产物在、但已经不是命令要装的那一版** ⇒ 命令文本判重判成已完成 ⇒ 静默跳过。⇒ 产物判据要加第三层：**这步命令里声明了 `<包>==<版本>` 时，引擎 venv 里那个包当前装的就是那一版**（后端后缀也要对：`2.6.0+xpu` 与 `2.6.0+cpu` 版本号相同但**后端不同**，那是另一个产物）。⭐ 读已装版本**不 spawn python**：读 site-packages 下 `<包名>-<版本>[+后缀].dist-info` 的**目录名**（快、无进程、不会失败）；⚠️ 包名匹配不许用前缀（`torch` 不该匹配 `torchgen`）。⚠️ **清单形式的装包步（`-r requirements.txt`）解析不出逐个版本 ⇒ 不做版本核对**（只能判 site-packages 非空）⇒ 不许因为解析不出就判成「产物不在」，那会让每次都重装。⚠️ **`envCheck` 救不了这一类** ⇒ 它只验 `import` 成不成功，**不验版本与后端后缀**（`2.5.1+cpu` 能 import 成功）。⇒ 验「装对了」必须是**版本 + 后端后缀 + 设备层实算**三件一起看 | |
| **A25** | ⭐⭐ **第 2 步要能选依赖版本（含 torch）** | ✅ **2026-10-24 已做**（`7c7a513` + `178e11a` + `74cf184`） | [2026-10-24] 使用者诉求：第 2 步的依赖清单只能点「不安装」，不能选版本；连 torch 的版本也定死在上游声明的那一版 | ⛔ **改版本不能靠排除实现**：uv 的排除语义（`--excludes` / `--no-install-package`）是「这个包连同依赖它的其它包一起不装」⇒ 排除 `einops` 会把 `fugashi`、`descript-audiotools` 这些依赖它的包一起弄掉，环境装不完整。⇒ **改版本要改清单本身**：让 uv 在一次解析里装对版本，依赖关系不受影响。⭐ **写清单副本不改上游文件**（`.wizard-requirements.local.txt`，与 `.wizard-excludes.txt` 同一性质）：克隆下来的引擎目录要与上游一致。⚠️ 上游清单有两种写法（精确钉住 `einops==0.8.1` 与区间 `einops>=0.8.1`）⇒ 改写时**保留约束形式**（`>=0.8.1` 改成 `>=0.7.0`），原本没钉版本的才钉住。⚠️ **torch 换版本 ⇒ index 也要跟着换**（index 是命令级参数，清单表达不了）⇒ 主安装步跳过 torch 系，追加一步从该后端官方 index 装。⭐ **改任何一个包的版本都不许让 torch 静默降级**：清单副本里 torch 那几行也要按本机后端上可用的版本改（否则选一个普通包的版本就会把 torch 装成 CPU 版）；使用者显式选了 torch 就照他选的。⚠️ 锁文件路线（`uv.lock`）版本已锁死 ⇒ 如实报 `VERSION_OVERRIDE_ON_LOCK`，平台不替上游改 lock。⚠️ pyproject 路线（`uv pip install -e .`）读的是 pyproject 本身，改副本无效 ⇒ 拆成「按副本装依赖」+「装项目本体（--no-deps）」两步。⚠️ 判 torch 可用版本要**先知道引擎环境用哪个 Python**（判据要 ABI）⇒ `buildEnvPlan` 里要把 `buildVenvStep` 的结果提前算出来 | |
| **A26** | ⭐ **「不安装的包」那两个分区要一直在，全部安装时写明没有不安装的包** | ✅ **2026-10-24 已做**（`74cf184`） | [2026-10-24] 使用者看到依赖清单里的「要安装的包」/「设为不安装的包」两个分区**时有时无** | ⛔ 旧逻辑是「两个分区里有一个是空的就只渲染包名那一排、两个标题都不显示」⇒ 分组会随使用者的点击而变，看不出这两个分区本来就在。⇒ **两个分区一直都在**：全装时「设为不安装的包」那里写「没有设为不安装的包」，全不装时「要安装的包」那里写「没有要安装的包」。⚠️ 文案从「以下依赖将不会被安装」改成「设为不安装的包」：前者是绕口的被动句，后者说清了这是个**可切换的选择**（点一下就变） | |
| **A27** | ⭐ **CLI 扫描把引擎目录里的非推理脚本也扫进来，参数表混进部署工具参数** | ⬜ **待开** · 🔴 `core/cli_help_extract.py` · `core/cliDraft.js` · `editor/ParamPool.jsx` | [实测 2026-10-24] 用 `spark-tts` 试 `/wizard/discover` ⇒ 扫出 **35 个 flag，其中约 20 个是噪音**：来自 `engines/spark-tts/runtime/triton_trtllm/` 的部署脚本（`client_http.py` / `convert_checkpoint.py` / `fill_template.py`），参数是 `--tp_size` `--pp_size` `--use_weight_only` `--calib_dataset` `--embedding_sharding_dim` `--moe_tp_size` 等（help 原文写着「The path to save the TensorRT-LLM checkpoint」「triton model_repo module name」）—— 那是**部署推理服务**的工具参数，与「合成一段语音」无关 | ⛔ **不是阻塞项**（实测：`required:true` 只有 2 个真参数 `--text` 与 `--model_dir`，那 20 个噪音**全是选填**）⇒ 不挡任何人走完第 4 步。⭐ **根因是通用的，不是给某台引擎开的后门**：① `cli_help_extract.py:318` 的固定清单（`cli.py`/`inference.py`/`main.py`…）在 spark-tts **根目录一个都没命中**（它的 `inference.py` 在 `cli/` 子目录里）⇒ 走兜底递归，把**目录树里所有含 `add_argument(` 的 py 文件**都扫了 ② `cliDraft.js:7` 的 `is_tool` 靠**硬编码名字清单** `TOOL_FLAGS`，那 20 个噪音一个都不在清单里 ⇒ 全部标成「非工具」，与真参数混在一张表 ③ 界面参数表**平铺无折叠**；`groups` 只有 `["(root)"]` ⇒ 已有的「分组」下拉框对这种布局**不起作用**。⚠️ 该文件已随第 4 步三栏改造删除（见 A28），参数表现在住在左栏 `editor/ParamPool.jsx`。⚠️ 另有**同名 flag 重复**：`--model_dir` 出现两次（`cli/inference.py` 与 `client_http.py` 各定义一次，后者 help=null），用户会看到两个 model_dir。⭐ **修法方向（待定）**：收紧兜底递归（清单命中优先 + 找不到就如实报「没找到 CLI 源码」而不是全收）· 同一来源的同名 flag 合并（保留有 help 的那份）· 「工具/非工具」的判据不靠名字清单 | |

| **A28** | ⭐⭐ **第 4 步三栏工作台：左栏扫到的参数 · 中栏名片内容 · 右栏实时预览** | 🟡 **框架已搭（2026-10-25）· 交互待定** · 🔴 `editor/Stage.jsx`（原 `editor/ThreeZone.jsx`，已随 A38 删除）· `editor/EngineScanZone.jsx` · `editor/ParamPool.jsx` · `editor/ParamDropZone.jsx` · `editor/ParamRow.jsx` · `editor/paramType.js` · `editor/scanAutofill.js` | [Owner 2026-10-25 定] 使用者诉求：① 嗅探 TTS 的参数 ② 参数陈列在**可收起的左栏**，可拖拽 ③ 平台预先填入可识别的字段 ④ 用户拖左栏参数进参数区 ⑤ 右栏实时前端预览。⚠️ 之前的对照表：五项**几乎一个没实现** —— 嗅探只在新引擎的 cli 一条路上有（Python 反射要求盘上已有名片 ⇒ 鸡生蛋）、参数池嵌在 `DragBind.jsx` 内部不是独立左栏、平台预填只填 `call.kind`/`argv`/`args`/`bind` 四项（8 个必填项一个不填）、拖拽目标只有 `bind` 三槽位与 `call.args`（拖不进 `parameters[]`）、右栏 `PanelPreview` 读 `manifest.parameters` 而拖拽从不写它 | ✅ **三栏骨架已落地**（本轮）：左栏 `EngineScanZone`（统一入口 + 扫描 + 参数池，可收起）、中栏 `ManifestForm`（核心绑定区 + 必填 8 项 + `ParamDropZone` 落点）、右栏 `PanelPreview`（可收起）。⭐ **统一入口**：原来两个下拉（「读取名片」/「新建名片」）合成一个，判据是 `GET /wizard/installed?all=1` 返回的 `manifestPresent`（`core/save.js:151-153`）⇒ **平台侧零改动**。⭐ **已有名片不覆盖**：扫描只填空缺（`scanAutofill.js` 沿用 `computeAutoFill` 的只增不删语义），名片里原有的 `call.args` 原样保留，扫到的参数只是列在左栏让使用者自己挑。⭐ **拖拽落点定在 `parameters[]`**：盘上 5 台引擎 4 台是 `kind=python`（python 形态**没有** `call.args` 段，`hostProfile.js:38-40`）⇒ 界面参数只能落在 `parameters[]`。⚠️ **cli 形态要同时写 `call.args`**：宿主在命令行形态下只认 `call.args` 里声明过的名字（`lib/engines/host.py:280-289`，没声明就抛错）⇒ 拖一个 cli flag 进去时同时写 `parameters[]` 与 `call.args[name]={flag}`（守卫 `test/paramDrop.node.test.js` 11 条覆盖）。⚠️ **类型由扫到的 `kind` 映射**（`paramType.js`：`str→text` `int/float→number` `bool→boolean`，扫不出就落 `text`），不是平台猜的语义。⭐ **旧的 `CliGenPanel.jsx` 与 `DragBind.jsx` 已删除**（前者是扫描面板，后者自带的参数池正是 Issue #7 说的「参数池嵌在 DragBind 里」）⇒ 参数池现在**只有左栏那一个**。⚠️ **交互细节未定**：Owner 明说「4 涉及交互，先把框架搭好」⇒ 落下时的类型选择形态、`parameters[].name` 与引擎 flag 名的最终对应关系（当前做法：cli 去掉横线、python 原样）、以及已拖进去的参数怎么改类型，都等框架看过了再定 | |
| **A29** | ⭐ **第 2 步的「完成」标签要居右对齐，不许因为命令长就换行** | ✅ **2026-10-25 已做**（`17d54d2`） | [2026-10-25] 使用者看到第 2/3 步那条命令（`… -m uv pip install -p … -r requirements.txt --excludes …`）后面跟着的「完成」**掉到了下一行** | ⛔ **根因是 flex 里的两段内容宽度分配**：`.pf-row` 是 flex 行，命令文本 `.pf-val` 本身没有 flex 属性 ⇒ 它按内容宽度铺开，命令一长就把后面的状态标签挤到换行。⇒ 命令文本改成占满剩余宽度（`flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere`），状态标签靠右贴住同一行末尾（`margin-left: auto; white-space: nowrap`）。⭐ **状态标签要有颜色**：成功用 `--success` 绿、失败用 `--warning`（原来 `.pf-warn` 是黄色，成功也是黄的 ⇒ 看不出成败）。⚠️ **预览区与执行结果区两处都要改**：只改一处会出现「预览里对齐了、装完还是换行」。⚠️ 另有两处 `.pf-row`（依赖包行、实时执行行）**不显示状态标签** ⇒ 不该套这组类 | |
| **A30** | ⭐⭐ **改依赖版本只用「铅笔 + 手写」，平台不给候选版本** | ✅ **2026-10-25 已做**（`17d54d2`）· 🔴 **2026-10-25 改形态**（笔进 pill 内，见 A32） | [2026-10-25] 使用者指出选版本的方式不合理：「尤其是与 GPU 相关的包，点击一下，导致不安装了，UX 上是灾难」⇒ 要求改成版本号后面加一支铅笔，点铅笔进编辑态手写版本号 | ⛔ **旧形态是下拉框**：选项是「上游声明的那个」+「本机后端上建议的那个（只有 torch 系有）」+「手写版本号…」⇒ 点一下就选中一个值，而**选中下拉项这个动作本身没有任何后果提示**（使用者以为点了就等于「改成这个」，实际是「选中了但还没生效」，加上默认选项是上游那版 ⇒ 看起来就是「点一下就不装了」）。⇒ **形态换成铅笔 + 手写**：包名后面显示版本号，点铅笔才出现输入框，输入即覆盖。⭐ **平台不给候选版本**：下拉里的每个非上游选项都是平台编的，版本本是上游声明的事，平台手上没有「这个包有哪些版本」这份事实 ⇒ 候选列不出来就不列；torch 的「本机后端建议版本」也一并去掉（那是建议，不是上游声明）。⚠️ **「设为不安装的包」不给改版本**（它根本不装，给它版本号没有意义）；被排除的 torch 同理。⚠️ **已覆盖的版本要直接显示出来**（不必再点一次铅笔才看得见）。⚠️ 编辑态的清空 = 回到上游声明的版本；Esc = 放弃本次改动 | |

| **A31** | ⭐ **三栏工作台的运行时行为没有守卫：组件能编译不等于拖拽真能写进名片** | ✅ **2026-10-25 已做** · 🔴 `test/threeZone.node.test.js` · `test/wizardBuild.node.test.js` · `test/wizardDeps.node.test.js` · `editor/MainArea.jsx` | [实测 2026-10-25] 三栏框架落地后逐条查「这个行为有没有测试兜着」，发现四处是空的：① 三栏骨架、收起/展开、拖拽落下写名片**一条运行时测试都没有**（`paramDrop.node.test.js` 只测纯函数 `applyParamDrop`，算对了但没人把结果接到名片上，这种断裂它看不见）② 向导前端**整体模块图从没被构建过**（`npm run build` 只覆盖 `web/`，不覆盖 `tools/engine-wizard/editor/`）③ **模块环没检测**：Rollup 对循环依赖是容忍的（构建照样成功），而环上两个组件互相 import 时谁先被求值取决于打包顺序 ⇒ 「改一处就换个地方坏」的偶发行为 ④ `editor/MainArea.jsx` 里 3 处 JSX children 写成裸 `// 注释` ⇒ **渲染成可见文字**（右栏预览里直接显示「// 音色：平台扫盘才有，这里显示形状」）；`styleguard` 里那条「注释不许变成可见文本」守卫当时是绿的，因为它按行首缩进判，JSX children 的 `//` 缩进更深 | ✅ **四处都补上**：① `test/threeZone.node.test.js` 用 jsdom + 真 React 渲染，跑真 drop 事件（jsdom 不带 DragEvent，用 Event + dataTransfer 补），验三栏在、收起后内容不渲染、拖 cli 参数进 `parameters[]` 且同时写 `call.args`、**已有名片的 `call.args` 原样保留**、python 形态不写 `call.args`（5 条）② `test/wizardBuild.node.test.js` 用 Vite 的 build API 编译整个 editor 模块图（不走 CLI：`vite build` 会被当成常驻进程；Vite 的 ESM 入口在 `pkg.exports['.'].import.default`，`require.resolve` 拿到的是 CJS 入口）③ `test/wizardDeps.node.test.js` 解析 editor/ 的相对 import 画依赖图找环，并带一条「检测器自己能抓到环」的自证 ④ `MainArea.jsx` 的 3 处 `//` 改成 JSX 注释 `{/* */}`。⭐ **全部做过变异检查**：cli 不写 `call.args` ✗、覆盖已有 `call.args` ✗、python 也写 `call.args` ✗、收起时仍渲染 ✗、类型映射退化成 text ✗、import 路径写错 ✗、造真环 ✗ —— 每条都被对应的测试报红，改回去全绿 | |

| **A32** | ⭐⭐⭐ **笔要长在 pill 里面；版本号只出现一次；界面显示的那条 spec 与真正装进去的那条是同一条** | ✅ **2026-10-25 已做**（`4b21607a`）· 🔴 **补两处漏**（`3ba12d6d` `89633e00`） | [2026-10-25] 使用者指出三处：「我要的是你的 pill 里面的版本号右边带上笔，你为什么是在 pill 外面的右边，而且你这样引入了两个数据源的问题」「torch 的笔要写在 torch==x.x.x 右边」「你也没解决 torch 的点击逻辑嵌套的问题」 | ⛔ **病根是把「版本修改」当成一个独立控件**：于是在 pill 外面另起了一个 `VersionSelect`，它把版本号又抄了一遍（pill 显示上游原文、笔旁边显示手写值 ⇒ 同一个版本号两个数据源、两处还可能不一致），而整行 `onClick` 一字未改 ⇒ 点笔照样冒泡到整行 ⇒ 等于把这个包设为不安装。⇒ **最小单位应该是「pill 里那条 spec」**：笔改的就是这条 spec 里的版本号，笔与它必须在一起。⭐ **笔进 pill 内**（`SpecPill` 统一渲染 pill + 笔），GPU 区的 torch 那条同理（`torch==2.5.1 ✎`）。⭐ **版本号只出现一次**：pill 未编辑态是**一条连续的 `<code>`**（`einops==0.8.1`），拆成「头 + 版本」两个元素的话 DOM 文本不连续（复制粘贴会断、元素缝隙会让眼睛看到断开的地方）；编辑态才把版本号那一位换成输入框。⭐ **单一数据源**：界面显示的那条 spec 由**后端算好**随计划响应送回（`specs` 字段），前端只渲染不自己拼（前端拼会把 `>=` 变成 `==`，与后端保留上游约束形式的行为分叉）。⚠️ **断冒泡与执行动作必须写在同一个处理函数里**：同一个 prop 上写两个 `onClick`，后一个会覆盖前一个 ⇒ 断冒泡的那个会被吃掉。⚠️ 守卫分两层：SSR HTML 查不出事件属性 ⇒ 「点笔会不会真的不冒泡」用 jsdom + `react-dom/client` 真点一次来守（`test/pencilClick.node.test.js`）。🔴 **后端还有两处漏，界面显示的 spec 会与装进去的不一致**：① **「接受升级 torch」那条路线没返回 specs** ⇒ 界面退回显示上游那个版本，而实际装的是升级后的版本（`3ba12d6d` 补上，torch 族换成升级后的、其余照上游）；② **使用者没选后端时判不出 torch 版本** ⇒ `target` 为 null ⇒ torch 系静默不改写（界面显示上游那版、实际装另一版），且**调用方没传 Python 版本时也判不出来**（判 torch 版本要 Python 的 ABI，缺了这一项就静默不改）⇒ 修法是后端与 `suggestTorchUpgrade` 同口径自己算（后端用本机 GPU 推出来、Python 版本读引擎声明、缺省用平台基座）（`89633e00`）。⭐ **端点级验证过**：`POST /wizard/env` 回传的 `specs` 与写进 `.wizard-requirements.local.txt` 的那几行**逐条一致**（守卫 `test/installSpecs.node.test.js` `test/torchSpecSync.node.test.js`，各做过变异检查） | |
| **A33** | ⭐⭐ **三栏容器被外层两列 grid 挤扁：中栏从 690px 缩成 302px，右边空出一大片** | ✅ **2026-10-25 已做** · 🔴 `editor/ManifestPage.jsx` · `editor/editor.css` · `test/manifestLayout.node.test.js` | [实测 2026-10-25] 在真浏览器（headless Edge，CDP 9334）量三栏的实际几何，发现 `gridCols` 是 `260px 302px 380px` —— 中栏只有 302px，表单挤成一团，而右边空出 380px。⚠️ **根因**：名片页的外层容器用了项目的 `.workspace-grid`，而那个 grid **自己就是两列**（`minmax(0,1fr) 380px`，`web/src/styles.css:572-577`）⇒ 三栏容器 `.wz-three-zone` 被塞进它的**第一列**（958px），于是中栏只分到第一列里的 302px，右侧 380px 全是空的。⚠️ **所有既有守卫都抓不到**：逐文件编译绿（语法没问题）、Vite 构建绿（能构建出来）、jsdom 渲染绿（**jsdom 不做布局计算，所有元素宽度都是 0**）⇒ 只有真浏览器里量出来的宽度才会说话。⚠️ **右栏首屏被诊断面板占住**：`Diagnostics` 排在 `PanelPreview` 前面（Issue #7 已指出），而右栏的定义是「当前项目的前端预览」⇒ 预览挪到前面，诊断挪到后面 | ✅ **两处都改**：① 外层容器从 `.workspace-grid` 换成新增的 `.wz-manifest-layout`（单列 flex：三栏一行、SaveBar 另起一行）⇒ 三栏占满整行 1346px，中栏 302px → **690px**（实测 `gridCols` 变成 `260px 690px 380px`）② 右栏里 `PanelPreview` 挪到 `Diagnostics` 前面。⭐ **SaveBar 的 sticky 从内联样式挪进 CSS**（`.wz-savebar-row`）：原来那段 `position:sticky` + `gridColumn:1/-1` 是内联样式，挂在 grid 上才跨栏；换成 flex 布局后内联的 `gridColumn` 就没用了 ⇒ 一起挪进样式表。⭐ **补了布局守卫** `test/manifestLayout.node.test.js`（6 条）：判据落在**CSS 声明**上而不是渲染结果上 ⇒ 不需要浏览器也能跑。⚠️ **为什么判据落在声明上**：布局是浏览器算出来的，而现有测试里没有浏览器 ⇒ 只能把「不该出现的声明」（外层用两列 grid、列宽写死没有 1fr、SaveBar 不是 sticky）变成判据。变异检查三条全被抓：外层改回 `workspace-grid` ✗、列宽写死 `302px` ✗、SaveBar 去掉 sticky ✗ | |

| **A34** | ⭐⭐ **换引擎时上一台的名片内容整段留着：一张「id 写着新引擎、里面跑上一台」的名片** | ✅ **2026-10-25 已做** · 🔴 `editor/manifestAutoFill.js` · `editor/EngineScanZone.jsx` · `editor/App.jsx` · `editor/ManifestForm.jsx` · `test/manifestAutoFill.node.test.js` · `test/engineSwitch.node.test.js` | [真浏览器实测 2026-10-25] 在左栏先选一台磁盘上有名片的引擎，再选一台还没名片的引擎，中栏表单里 `runtime`（python 路径、checkpoints、verify 里的类名）、`call`（kind/module/class/method）、`max_chars`、`timeout_ms`、`base_url_env` 整段还是上一台的，而 id 已经写成了新引擎 | ✅ **四处一起改**：① 新增 `manifestForEngineSwitch(manifest, nextId, nextLabel)`（`editor/manifestAutoFill.js`）：按「段」清掉上一台的 `ENGINE_SPECIFIC_KEYS`（含 `runtime`/`call`/`models`/`maps`/`parameters`/`capabilities`/`output_formats`/`install`/`upstream` 与顶层的 `max_chars`/`timeout_ms`/`base_url_env`/`default_base_url`/`weights`/`local_changes` 等）与下划线开头的注释键；只留 `id`/`label`/`contract_version` 与平台不认的自定义段 ② `EngineScanZone.jsx` 的「没名片」分支改调它（原来只改 id）③ `App.jsx` 的权重落盘路径改为跟「正在编辑的那台」走（原来只查第 1 步克隆的那台）④ `shouldAutoFillCheckpoints` 新增「这一格指着另一台引擎 ⇒ 改」（原来「非空就不动」） ⚠️ **为什么按段清而不是逐个字段**：逐个硬编码清单会漏，漏一个就是残留混进去；按段清一次清全。⚠️ **纯函数测试抓不到接线漏**：改 `manifestForEngineSwitch` 算得对不对 ≠ `EngineScanZone` 真的调了它 ⇒ 另写 `test/engineSwitch.node.test.js`（真渲染组件、真选下拉、验 onChange 拿到什么）。变异检查六条全被抓（只改 id / 不清 runtime / label 回退 / 箭头换回 `<` `>` / 收起宽度写死 / 中栏也能收起） | |

| **A35** | ⭐ **左栏组件文件里顺带导出 hook ⇒ Fast Refresh 失效，改一行就整个模块重载** | ✅ **2026-10-25 已做**（`337602f`）· 🔴 `editor/EngineScanZone.jsx` · `editor/useEngineDirs.js` · `test/engineSwitch.node.test.js` | [读码 + vite 日志 2026-10-25] vite 的 HMR 日志连续报 `Could not Fast Refresh ("useEngineDirs" export is incompatible)`；原因是 `useEngineDirs` 这个 hook 与组件写在同一个文件里 | ✅ 把 hook 拆到 `editor/useEngineDirs.js`（项目的既有约定就是每个 hook 一个文件：`useInstalled.js`、`useInstallSession.js`），组件文件只导出组件。拆完 touch 一次文件触发 HMR，日志里 Fast Refresh 警告计数为 0 ⚠️ **判据不是「有没有警告」而是「模块里有没有既导出组件又导出 hook」**：警告只在改动那个文件时才打出来，不改就看不到 ⇒ 守卫按文件结构查 | |
| **A36** | ⭐⭐ **两条测试的结果取决于「跑它的机器」：一个写死了本机绝对路径，一个取决于本机有没有 Intel 显卡** | ✅ **2026-10-25 已做**（`bcb54e71` `ccd56ece`）· 🔴 `test/pencilClick.node.test.js` · `test/installChoicesUpgrade.node.test.js` | [CI 实测 2026-10-25] 推分支后 CI 红了 5 条（Windows 与 Ubuntu 各一套），其中 2 条是本机绿、CI 红：① `pencilClick.node.test.js` 把 `web/node_modules` 的位置写死成 `D:/Project/tts_broker_openai_compat` ⇒ 换个检出目录（CI 上就是）就 `MODULE_NOT_FOUND` ② 「不接受升级 ⇒ 装法原样返回」那条夹具传了 `backend: 'ipex'` 却没传 `recommendedBackend` ⇒ 判据会去探本机 GPU，探出来的后端与所选的不一致时换后端那条路线会重排装法 ⇒ 断言「原样返回」就红 | ✅ ① `web` 目录按测试文件的位置推算（`stepDepsRender.js` 里已有这个算法），不再写死；React 改用同模块导出的 `webRequire` 取（组件那边与测试那边必须是同一份 React，取两份会触发 Invalid hook call）② 显式传 `recommendedBackend: 'ipex'`：表达式 `input.recommendedBackend || detectRecommended()` 会短路，**GPU 探测根本不发生**（实测探测次数 0）⇒ 测试与本机硬件无关。⭐ **另补一条守真正的意图**：所选后端与本机推荐不同时，装法会重排（torch 挪到追加步、用所选后端的 index 装），但**版本号必须还是上游那个**（使用者没接受升级，不许闷头改版本）；变异检查：把版本换成建议版本后这条报红。⚠️ **这类坑本机查不出来**：本机有 Intel Arc（探出 ipex）⇒ 夹具恰好绿 ⇒ 只有 CI（runner 无 GPU）才照出真相 ⇒ 与 A18 同类，测试夹具不许依赖本机环境 | |
| **A37** | ⭐⭐⭐ **第 4 步的三栏外壳是自制的：三个栏头 + 三条边框把页面切成了三个盒子，与主界面的形态不一样** | 🔴 **Owner 验收不通过，已被 A38 推翻**（本行记录当时做成了什么、为什么不够）· 🔴 `editor/ThreeZone.jsx`（已删）· `editor/EngineIdentity.jsx` · `editor/EngineScanZone.jsx` · `editor/PanelPreview.jsx` · `editor/ManifestPage.jsx` · `editor/App.jsx` · `editor/editor.css` · `editor/useEngineDirs.js` · `test/threeZone.node.test.js` · `test/manifestLayout.node.test.js` · `test/editorModuleShape.node.test.js` | [读码 + 真浏览器实测 2026-10-25] 主界面的形态是：`.workspace-left` / `.workspace-right` 本身**没有边框也没有背景**，只是定位用的列（`web/src/styles.css:431-469` 是 `.section`，`:578-587` 是两个列容器）；视觉外壳由**内容自己带**（`.section` 或 `.card`）。而第 4 步原来每一栏外面套一层自制外壳（`.wz-zone` + `.wz-zone-hdr` + `.wz-zone-title` + `.wz-zone-body`），栏头里写着「扫到的参数」「名片内容」「预览」——**这三个标题在主界面里都不存在** | ✅ **当时做的四处**：① 删掉自制栏头层，三栏那一层改用项目现成的 `.workspace-left` / `.workspace-right` ② 新增 `editor/EngineIdentity.jsx`：引擎下拉 + 名片来源 + 现状三态，放**中栏顶部**（Owner 裁决 B：身份跟着名片走）③ 收起状态从 `ThreeZone` 提到 `ManifestPage`，收起那一栏换成 40px 窄轨 ④ 预览栏也用 `.section` 外壳，`Advanced Settings` 改成真的折叠 ⚠️ **Owner 验收不通过**（2026-10-25）：只把「自制栏头」换成了「项目现成的列容器」，但**页面骨架仍然是三栏并排**，而且第 4 步仍整页套在平台的 `.node-detail` 里（紫框 + 圆角 + 底色）。Owner 的判词是「拿一个带紫色描边的巨型棺材盒把三栏硬塞进去」—— 说的是**层级**问题，不是**样式**问题：左边条/中栏/右边条不该是同一张卡片里的三个格子，它们是页面自己的三根骨头 ⭐ **当时量到的数据**（CDP 9334，2026-10-25）：三栏 260px / 690px / 380px；收起左栏 ⇒ 40px 910px 380px；收起右栏 ⇒ 260px 1030px 40px；Advanced 真能折叠；拖拽端到端 35 个参数进 `parameters[]` ⚠️ **留到下一轮的教训**：改了「栏头长什么样」不等于改了「页面怎么排」。Owner 说的是三根平级的骨头，要动的是**容器层级**，不是类名 | |
| **A38** | ⭐⭐⭐ **第 4 步的页面骨架做成了三根平级的骨头：左边条 32px、中栏占满、右边条 32px（Owner 验收不通过后重做）** | ✅ **2026-10-25 已做**（`0c40bff1` `3e6ac486` `61f97b53`）· 🔴 `editor/Stage.jsx`（新）· `editor/ThreeZone.jsx`（已删）· `editor/ManifestPage.jsx` · `editor/App.jsx` · `editor/editor.css` · `test/threeZone.node.test.js` · `test/manifestLayout.node.test.js` | [读码 + 真浏览器实测 2026-10-25] Owner 验收 A37 时给的判词：「拿一个带紫色描边的巨型棺材盒把左中右三栏硬塞进去供起来」「左、中、右是页面的三根骨头，根本不在同一个大容器里」。⇒ 问题不在「栏头长什么样」，在**容器层级**：① 第 4 步整页套在平台的 `.node-detail` 里（`web/src/styles.css:1107-1113`，`border: 1px solid var(--accent)` + 圆角 + 底色）② 三栏是同一个 grid 里的三格 ③ 左右两栏默认全展开，空状态盒子各占 200px / 380px 摆在首屏上 ④ 中栏只剩 690px，长路径要换行 | ✅ **四处一起改**：① **第 4 步在 `App.jsx` 里单独一支**，不进 `.node-detail`（`.node-detail` 那一支的条件改成 `page && page !== 'manifest'`）② **新组件 `editor/Stage.jsx`**：`<aside>` + `<main>` + `<aside>` 三根平级的骨头，外层只有一个 flex 行，**没有任何边框、圆角、底色**；`editor/ThreeZone.jsx` 删除（那套 grid 三列 + 40px 窄轨退役）③ **左右边条默认收成 32px**，只露 `→` 与 `←`；点一下滑出成 360px 抽屉（`transition: width 160ms`），抽屉上盖半透明遮罩，点遮罩或再点箭头就收回；**收着时内容完全不渲染**（省掉两个空状态盒子）④ **中栏 `flex: 1` 撑满剩余宽度**，内容 `max-width: 960px` 居中（`.wz-stage-main-inner`）；窄屏（960px 以下）抽屉改成 `position: absolute` 盖在中栏上面，不把它挤成一条缝 ⚠️ **两个真 bug 是实测逼出来的，不是想出来的**：**遮罩盖住抽屉** —— 遮罩是 `position: fixed` 的固定层，边条是 `static` 的，fixed 层会盖住没有 z-index 的 static 元素 ⇒ 抽屉看着开着，里面的「Scan parameters」按钮点到的却是遮罩，一点抽屉就收回去，**扫描按钮永远点不动**（直接调 discover 端点是好的，35 个参数 ⇒ 是前端点不到，不是后端坏了）。改法：边条 `position: relative` + `z-index: 10`，遮罩 `z-index: 8`。**窄屏降级里的 z-index 也要抬** —— 那里抽屉变 `position: absolute`，不抬的话又盖不住遮罩 ⭐ **实测**（CDP 9334 真浏览器，1440×900）：① 默认态量得 **32px / 1312px / 32px**，两箭头是 `→` 与 `←`，**边条内容不渲染、无遮罩、零个带边框的祖先**（紫框真的没了）、**零个可见的空状态盒子**；中栏内容区 960px 居中，长文本无一被裁切 ② 左抽屉开 ⇒ **360px / 984px / 32px**，遮罩在，空状态只在抽屉里 ③ 右抽屉开 ⇒ **32px / 984px / 360px** ④ 页面异常 0（唯一的 console 错误来自浏览器扩展，与本项目无关）⑤ **拖拽端到端**：选引擎 → 开左抽屉 → 点扫描真扫出 **35 个参数** → 拖一个 `--model_dir` 进中栏落点 ⇒ 切 JSON 视图看到 `parameters: [{name: model_dir, type: text, tier: common, help: …}]`，名片真写进去了 ⚠️ **守卫**（`test/manifestLayout.node.test.js`，13 条）：骨架层不许有 border / border-radius / background（不许套娃）；边条 z-index 必须大于遮罩；第 4 步那一支不许混进 `.node-detail`；`ThreeZone.jsx` 不许复活。`test/threeZone.node.test.js`（`Stage` 版）：三根骨头是平级的 `aside`/`main`、默认两边收着、点箭头开合、箭头是 `→`/`←` 不是 `<`/`>` ⚠️ **一个测试手段的坑**：`transition: width 160ms` ⇒ 量宽度必须等过渡走完，否则量到的是起始值（我第一版脚本量出「展开后还是 32px」，差点当成 CSS 没生效） | |

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

## 3c. ⭐ 开发验证平台已换成 Arc（2026-10-04 立，**2026-10-23 逐句复核**）

> 这条**不是**一笔设计决策，是**环境事实**。记在这里是因为它改变了
> 「在这台机器上跑测试/跑引擎」这件事的每一个读数。
>
> ⚠️ **2026-10-23 复核结论：本节的三笔「环境事实」X1/X2/X3 已全部过期**，
> 逐句核对过程与今天的读数见下。过期原因是没有持续同步 —— 代码与测试改了，
> 这一节留在 10-04。**教训：环境事实类的段落必须跟着改动当天复核。**

**Owner 2026-10-04 指示**：开发验证平台换成 **Arc**（本机：ERYING B860，
Intel Arc 140T 核显 32GB 共享 + NPU 3720，**无 NVIDIA**），且为避免环境交叉污染，
**环境放 `C:\Aurivox`**（仓库外）。

> ✅ **2026-10-23 复核：这两句仍成立。** [实测] `inspectHardware()` 返回
> `{vendor:'intel', name:'Intel(R) Arc(TM) 140T GPU (32GB)'}`，`recommended: 'ipex'`。

### 可用的 XPU 环境（全部在仓库外）

`C:\Aurivox\envs\`：`platform`（py3.12 瘦环境）· `gpt-sovits311`（py3.11 ——
`jieba_fast` 必须吃 `tools/wheels` 的 cp311 轮子）· `indextts2`（py3.11）·
`cosyvoice2`（py3.10）。torch 2.14.1+xpu；transformers 各台独立
（GSV 4.43 / CosyVoice2 4.51.3 / IndexTTS2 4.52.1）。
完整实测记录（含踩坑表、性能、JIT 警告）：**`C:\Aurivox\ENV-XPU-REPORT.md`**。

> ✅ **2026-10-23 复核：仍成立，且多一个 `gpt-sovits`。**
> [实测] `C:\Aurivox\envs\` 下五个目录（`platform` / `gpt-sovits` /
> `gpt-sovits311` / `indextts2` / `cosyvoice2`）都有 `Scripts\python.exe`。

### ⛔ 三笔必须知道的环境事实 —— ⚠️ **以下三笔已于 2026-10-23 复核为过期，保留原文是为了让「当时这么记」可追**

| # | 2026-10-04 原文（已过期） | 2026-10-24 实测（今日） |
|---|---|---|
| **X1** | `venv/`、`engines/gpt-sovits/.venv`、`engines/indextts2/.venv` **是死的**：`pyvenv.cfg` 的 home 指向旧机 `MECHREVO X10 Pro`，起 interpreter 报 `uv trampoline failed to spawn Python child process` | ❌ **三句都不成立**。✅ **根 `venv/` 现在是好的**：Python **3.11.9**，`pyvenv.cfg` 的 `executable` 指向仓库内嵌的 `tools/runtime/python/python.exe`（2026-10-24 重建，见 A22）。⚠️ **它此前换过毛病**：曾被外部工具建成 CPython 3.14.7（base 在 Hermes 的工具目录里、2026-10-21）⇒ 引擎环境成了 cp314（见 A22）。✅ `engines/indextts2/.venv` 仍**是活的**（Python 3.11.13 · torch 2.8.0+xpu）；✅ `engines/spark-tts/.venv` 现在也**是活的**（Python 3.11.15 · torch 2.6.0+xpu，2026-10-24 由 A22/A23 重建）。⚠️ `engines/gpt-sovits/.venv` 与 `engines/cosyvoice2/.venv` **仍没有 `python.exe`** |
| **X2** | ⇒ `npm test` 的 22 条失败全是这一个根因，读数 `1982/1959/22/1`，⛔ 不是代码回归 | ❌ **已修**（Owner 2026-10-23 确认）。[实测] 2026-10-23 读数 `2751 tests / 2748 pass / 0 fail / 3 skipped`；2026-10-24 为 `2794 tests / 2791 pass / 0 fail / 3 skipped`（本轮新增 43 条） |
| **X3** | 浅层 `check-engine-env.cjs` 会报假绿灯：只查 `python.exe` 在不在 ⇒ 四台全报「装了」 | ❌ **不再复现**。[实测] 2026-10-23 四台（`cosyvoice-300m-sft` / `cosyvoice2` / `gpt-sovits` / `index-tts`）**全部如实报「没装/不全」**，退出码 1。⚠️ **但「装了」现在也不等于「能用」**：`engines/spark-tts/.venv` 现在 python.exe 在、torch 也在，但**版本对不对、装的是哪个后端的轮子、XPU 设备能不能真跑**，只有 A22/A23 那条链才查（见 A23） |

### ✅ 平台根 `venv/` 已重建为内嵌 base（Owner 2026-10-24 裁定，`cabbf76`）

**裁定**：「平台根需要 `D:\Project\tts_broker_openai_compat\tools\runtime\python` 从这里开始部署」

**重建前** [实测 2026-10-24]：平台根 `venv/` 是 **CPython 3.14.7**，base 指向
`C:\Users\User\AppData\Local\hermes\tools\python-3.14.7+...`，
**2026-10-21 由外部工具建成**（不是平台自己那份内嵌解释器）。
它仍然很薄（**4 个包**：pip / uv / packaging / hf_transfer），这点没问题。

⚠️ **但它的版本与平台基座（3.11）不符**，而 `tools/wheels/` 里的
`jieba_fast-0.53-cp311-cp311-win_amd64.whl` **只认 cp311** ⇒ 根 venv 若是 3.14，
GSV 训练线装那个轮子会失败。

**重建后** [实测 2026-10-24]：`pyvenv.cfg` 的 `executable` =
`D:\Project\tts_broker_openai_compat\tools\runtime\python\python.exe`，
`version = 3.11.9`，**6 个包**（pip / uv / packaging / hf_transfer / setuptools / wheel），
`uv 0.12.1` 可用（向导建引擎环境靠它）。

⭐ **重建走的是脚本不是手工**：`node tools/deploy/bootstrap.js --venv-only`。
为此补了两样东西：

| | 补的东西 | 为什么 |
|---|---|---|
| ① | **健康检查的第二道判据**：base 必须是当前内嵌解释器（读 `pyvenv.cfg` 的 `executable`） | 原来只判「解释器能不能跑」⇒ 3.14 那个场景完全看不见，bootstrap 说「already exists and works」就放过了。⭐ 比 base 而不是比版本号：同一版本但来自别处的 base 也可能有 ABI 差异 |
| ② | **`--venv-only` 开关**：只做「把根 venv 部署成内嵌 base」这一件事 | 「重建根 venv」要能独立、无人值守地重复做，不必连带装 torch / ffmpeg / npm / 模型。⚠️ 它固定走**平台瘦版** requirements（根 venv 是平台的环境，引擎依赖归各引擎自己的 .venv，见 A16 / A17） |

✅ **幂等**：[实测] 第二次跑输出「venv already exists and works」，不重建。
✅ **判据真的能抓住**：[实测] 把 `pyvenv.cfg` 的 base 改成外部工具那个路径后，
它报「its base interpreter is …, not the embedded runtime …; rebuilding it」并重建回内嵌 base。
⚠️ **A15 / A19 的账不受影响**：根 venv 仍然很薄（6 个包），训练线要 torch 仍然靠
`tools/cli/install-torch.js` 那条独立路径（A17 ③）。

### 后端本身不依赖 Python

`server.js` 是纯 Node ⇒ 即使引擎环境全缺，`node server.js` 照常起。
⚠️ 但日志会打 `[cuda] not available — inference will run on CPU`。

> ✅ **2026-10-23 复核：比 10-04 更成立。** [实测] `server.js` 已有
> `require.main === module` 守卫（P0 计划任务 0 已兑现），`app.listen` 已不在
> 该文件里（拆到 `lib/server/`）—— 现在 require 它不会再起监听。
>
> ❌ **但「平台今天没有 XPU 分支」这句已过期**：[实测] `tools/cli/install-torch.js`
> 有 8 处 `xpu` / 4 处 `XPU` / 6 处 `Intel`；`tools/engine-wizard/core/hardware.js`
> 有 18 处 `xpu` + 12 处 `ipex`。**平台侧已经有 XPU 分支了。**

### ⬜ 待 Owner 裁定：外部环境怎么接进平台（**2026-10-23 复核：仍未做，但实况比原文更细**）

名片路径**必须相对项目根**（`profile.js:503` `relPath` 拒绝绝对路径，C3 契约），
所以「把 venv 放 `C:\Aurivox`」这件事本身与契约冲突。两条路：

> **2026-10-23 [实测] 四张名片的 `runtime.python` 与 `.venv` 实况**
> （这条不裁，下面这笔账就一直挂着）：
>
> | 引擎 | 名片 `runtime.python` | `.venv` 实况 |
> |---|---|---|
> | `cosyvoice2` | `engines/cosyvoice2/.venv` | 真目录，**里面没有 `python.exe`** |
> | `cosyvoice-300m-sft` | `engines/cosyvoice2/.venv` | **自己没有 `.venv` —— 借 cosyvoice2 的环境** |
> | `gpt-sovits` | `engines/gpt-sovits/.venv` | 不存在 |
> | `index-tts` | `engines/index-tts/.venv` | 不存在（⚠️ `engines/indextts2/.venv` 是**另一台**，那个活着） |
>
> ⚠️ **`cosyvoice-300m-sft` 借 cosyvoice2 的环境**这件事，契约与文档里都没有记载
> —— 它让 `check-engine-env.cjs` 对这一台报出的解释器路径是 cosyvoice2 的，
> 看着像串号。是有意共享还是历史遗留，**待确认**。

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
⚠️ `archive/ENGINE_WIZARD_PLAN_v2.md` **已归档作废**。
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

#### ~~**A7**~~ · 真下载（续传 / 并发 / 进度） —— ✅ **2026-10-24 三件已齐**（并发 + 真取消 + 按文件分槽进度）

| | |
|---|---|
| **scope** | 执行名片里的 `models.source.command`（⛔ **不生成**，只执行） |
| **为什么不算破「只验不建」** | 规则禁的是「**平台生成**命令」（HF/ModelScope/直链/网盘各家不同，生成就把那一家写进 `lib/`）。而 `models.source.command` **已经是名片声明的 argv**，平台已经会填占位符、已经知道 `license_gate`。**执行 ≠ 生成** |
| **必须有的三件** | ✅ **断点续传**（5.49GB 断一次很难受）· ✅ **并发**（`llm.pt` 单文件 2GB 是串行瓶颈）· ✅ **进度显示**（前端要显示「3/8 完成」）—— **2026-10-24 全部落地** |
| **文件** | ✅ `tools/engine-wizard/core/download.js` · ✅ `tools/engine-wizard/test/download.node.test.js` · ✅ `wizardbridge.js`（加端点，走 SSE 回进度）· 🆕 `editor/downloadQueue.js`（调度，默认并发 6）· 🆕 `editor/downloadRunner.js`（执行 + SSE 归并）· 🆕 `test/downloadCancel.node.test.js` · 🆕 `test/downloadConcurrency.node.test.js` · 🆕 `test/stepModelsWiring.node.test.js`（三份守卫都带变异检查） |
| **验收** | ① ⭐ **拿 `cosyvoice-300m-sft` 当真实样本**（2.2G，最小的那台）：能下完、能中断续传、能报进度 —— ⛔ **未跑**（2026-10-24 验的是 huggingface 上 144MB 的 `openai/whisper-tiny`：真下 ⇒ 中途取消 ⇒ `CANCELLED`、无正式文件、无残留 `.tmp`、可重下）<br>② `license_gate: true` 的引擎在点同意之前 ⇒ **报出 401/403 并说清「那看着像网络故障，其实不是」**（这句话 `core/models.js` 已经写好了，要接上）—— ⛔ **未接**<br>③ ⛔ **不生成任何命令** —— 测试要断言执行的 argv 与名片里写的**逐字相同**（占位符替换除外）<br>④ 下完自动接 **A8** 复核，缺/多/后缀不符如实报 —— ⛔ **A8 未做**，此项随之未做<br>⑤ 🆕 **2026-10-24 加**：使用者能按的**取消**（此前只有后端函数级参数，前端按不了）—— ✅ 已做 |

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
| ~~**A7**~~ | ~~第 3 步真下载~~ ✅ **2026-10-24 三件已齐**（并发 6 + 使用者能按的取消 + 按文件分槽进度）| `core/download.js` · `editor/downloadQueue.js` · `editor/downloadRunner.js` |
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

## §5.12 ⭐ 向导第 3 步：下载模型（统一落盘，2026-10-06 Owner 定方向）

> ⚠️ **2026-10-24 落地订正 —— 本节是 2026-10-06 的原始计划，实际落地走的是另一条路。**
> 保留原文是为了让「当时这么记」可追，**以订正为准**。
>
> | # | 2026-10-06 原计划 | 2026-10-24 实际落地 |
> |---|---|---|
> | 路线 | **spawn CLI**（`hf download` / `modelscope download` / `snapshot_download`），靠解析 stderr 的 tqdm 出进度 | ❌ **没走这条**。实际走**文件级 HTTP**：`POST /wizard/download/file`，一文件一个请求（`Range` 续传 + sha256 核对）。⭐ 理由：`spawn` 路线下「并发」没法做（一次只 spawn 一个进程），而文件级 HTTP 一文件一请求天然并发。⚠️ 原计划里那条 `fetch('/wizard/download')`（跑上游命令）在前端**从来走不到**（`runDownload` 的调用点全传文件对象，条件恒真）⇒ 是死代码，2026-10-24 已删 |
> | 三件套 | 断点续传 · 并发 · 进度 | ✅ **全部落地**：断点续传（`Range` + `.tmp` 探测）· **并发（默认 6）** · 进度（按文件分槽显示） |
> | 取消 | 计划里没写 | ✅ **2026-10-24 补上**（计划外但必要）：`POST /wizard/download/cancel` + 界面取消按钮。⭐ **暂停 ≠ 取消**：暂停只停前端派单（在途继续跑完，这是有意设计，界面已写明「当前文件完成后生效」）；取消才终止在途请求（落点在后端 `AbortController`，前端 abort fetch 只会断 SSE、**后端照跑到底**） |
> | 验收点 ①②（提取命令 / snapshot_download） | 要跑 | ⛔ **未跑**：文件级 HTTP 路线不需要「提取下载命令」，但 README 提取那条路（`downloader_cmds`）仍在 `wizardbridge.js:270` 供展示 |
> | 验收点 ③④⑥⑦ | 下完 / 落盘替换 / 半截续传 / 表格 UI | ✅ **已验**：真下 huggingface 144MB 文件 ⇒ 落盘 `engines/<id>/checkpoints/`、续传可用、取消后无残留 `.tmp`、可重下；界面按文件分槽显示进度 + 取消按钮 |
> | 验收点 ⑤（`checkpointStatus` 三态） | 已下载/未下载/半截 | ✅ **已有**（`lib/engines/checkpoints.js:117` 的 `missing[]` + `ready` 三态） |
> | 验收点 ⑧ | `npm test` 不新增失败 | ✅ **已验**：2026-10-24 读数 `2893 pass / 0 fail / 3 skipped`（3 skipped 是原有的） |
> | ⛔ **仍未做** | — | ① **A7 验收点 ①**：拿 `cosyvoice-300m-sft` 当真实样本（2.2G）真下完 —— 本轮验的是 144MB 的 `openai/whisper-tiny`，**2.2G 那个没跑** ② **A7 验收点 ②**：`license_gate: true` 的引擎在点同意之前要报 401/403 并说清「那看着像网络故障，其实不是」—— `core/models.js` 文案已有，**尚未接上** |
>
> ⭐ **新增文件**（原计划的 scope 表里没有）：`editor/downloadQueue.js`（调度，默认并发 6）·
> `editor/downloadRunner.js`（执行 + SSE 归并）·
> `test/downloadCancel.node.test.js` · `test/downloadConcurrency.node.test.js` · `test/stepModelsWiring.node.test.js`
> （三份守卫都带**变异检查** —— 改坏实现后守卫必须变红）。

> **Owner 定的分法**：「统一的是落到引擎下面的目录」—— 落盘路径平台统一
> （`engines/<id>/checkpoints/`），下载方式跟随上游（hf / modelscope /
> snapshot_download，从 README 提取）。
>
> ⛔ 不是「统一管理模型」：TTS 生态零散（上游改文件名/加版本/换仓库），
>   平台维护模型清单 = 永远跟不上（Owner 已否定集中式）。
> ⛔ 唯一管不了的形态：`from_pretrained("repo")` 无 local_dir（模型进 HF 缓存）。
>   实测 VoxCPM 支持本地路径 ⇒ 可用 snapshot_download 统一落盘绕开。

### 三步（用户原话 + 落盘裁决）

1. **从 README 提取下载命令**（一般是 modelscope 和 HF）
   现有 `extractDownloadCommands`（wizardbridge.js）已认 CLI 形态
   （`hf download` / `modelscope download`，实测 IndexTTS 提取出 4 条）。
   ⚠️ **要扩展认 Python 形态**：`snapshot_download("repo", local_dir=...)`（VoxCPM）。
2. **嗅探并列出下载清单**（表格：模型名/仓库链接/大小/SHA-256/状态），
   默认内部去重，加复选框去掉去重。
3. **下载**（统一落盘 `engines/<id>/checkpoints/`，断点续传 + 进度显示，
   逐文件校验：已下载=已下载，未下好=未下载，半截=续传或删掉重下+提示）。

### scope（动到的文件）

| 文件 | 改动 |
|---|---|
| `tools/engine-wizard/core/wizardbridge.js` | `parseDownloadCmd` 扩认 `snapshot_download("repo", local_dir=…)`；badge 链接（`huggingface.co/<org>/<repo>`）推命令作兜底 |
| `tools/engine-wizard/core/download.js` | **新建**：下载执行器（照 `env.js` 的 `runOne` 异步 spawn + SSE 流式，透传 CLI 的 stderr 进度） |
| `tools/engine-wizard/core/models.js` | `describeModels` 增强：调 HF/MS API 展开 per-file 列表（大小可拿，SHA-256 待定）；下载前统一把 `local_dir` 替换成 `engines/<id>/checkpoints/` |
| `tools/engine-wizard/editor/StepsExtra.jsx` | `StepModels` 界面：表格（名/链接/大小/SHA/状态）+ 去重复选框 + 「下载」按钮 + 进度条（照第 2 步模式） |
| `tools/engine-wizard/test/models.node.test.js` 等 | 守卫：提取形态 / 落盘替换 / 状态三态 / SSE 流 |
| `tools/engine-wizard/editor/editor.css` | 表格/进度条样式 |

⛔ 不碰：`tools/deploy/download_models.py`（GSV 专用，models/tts 老路径）——
   Owner 已确认它不符合平台原则，本批不迁移它。
⛔ 不动 `tools/engine-wizard/editor/StepDeps.jsx`（第 2 步已完成）。

### 验收点（真实执行，不许「应该可以」）

1. `extractDownloadCommands` 对 IndexTTS README：提取 ≥4 条（hf×2 + modelscope×2）
2. 对 VoxCPM README：提取到 snapshot_download（Python 形态）
3. 下载执行：spawn CLI，SSE 出 step/line/done（用小模型实测）
4. 统一落盘：命令里 local_dir 实际变成 `engines/<id>/checkpoints/`
5. 下完刷新 `checkpointStatus`：三态正确（已下载/未下载/半截）
6. 半截文件：hf/modelscope 有缓存 ⇒ 续传；不支持时删缓存重下并提示
7. 表格 UI：五列渲染 + 去重复选框生效
8. `npm test` 不新增失败（wizard 现有守卫全绿）

### 依赖 / 顺序

```
1. parseDownloadCmd 扩展（认 snapshot_download + badge 链接）
   → 2. download.js（执行器 + SSE，照 env.js 模式）
   → 3. models.js（per-file 列表 + 落盘替换）
   → 4. StepModels.jsx（表格 + 去重 + 按钮 + 进度条）
   → 5. 守卫测试
```

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
