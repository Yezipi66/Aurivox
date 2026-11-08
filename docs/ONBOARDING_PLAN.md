# 引擎接入 —— 现状台账

> **最后核对：2026-11-04**（最新一笔 `ccb352fa` 台账补；更早的 10-23 §3c 环境事实复核结论保留在正文 §3c）
>
> **2026-11-01 核对（文档体检）**：目标口径已按「名片是唯一事实源」重写（§0）；台账补记当前分支状态 ——
> 开发线 `research/engine-onboarding-complexity`（origin 停在 `a602b0c3`），本份台账提交前本地领先 origin 13 个提交（HEAD `0d01e91e`）；
> 外围契约化重构按「刀」推进：`refactor/periphery-cut1-wiring` 为底座，cut2a/2b/2c/2d / cut3a/3b / cut3c1/3c2 各自独立可回滚。
>
> **2026-11-03 复核（以 dev 为 base）**：dev 已推进至 `03dade47`（含 PR #39「dev 文案/注释规范化」合入）；
> 外围契约化重构（去 GPT-SoVITS 写死、改由名片驱动）现为 OPEN PR 链 `#27–#37`（其中 #36 已 CLOSE）+ `#38`/`#40`，均未进 dev；
> 第 6 行所引 research tip（`a602b0c3`/`0d01e91e`）为 11-01 快照、已滞后，当前 research tip 以 `git ls-remote` 为准。
>
> **2026-11-04 复核**：`feat/engine-device-arg` 已合入 dev 并推送（合并提交 `ce20d64f`，附 `1fa92247` 准入表登记），
> 当批提交后 dev 尖为 `ccb352fa`（`ce20d64f`/`1fa92247` 为其前序）。本批三笔见 A54（运行设备全链路）/ A55（推理入口嗅探接通）/ A56（第 4 步输出形态与折叠收尾）。
> research tip 与 periphery PR 链口径未变，仍以 `git ls-remote` 为准。
>
> **2026-11-04 复核（第二批）**：`feat/reference-text-row` 已合入 dev 并推送（合并提交 `c6bf9f4b`），
> **dev 尖 = `c6bf9f4b`**。本批一笔见 A57（参考文本声明进运行参数行 + resolveReference 优先级修复）。
>
> **2026-11-04 复核（第三批）**：**origin/dev 尖 = `a899934f`**（PR #41 文档/文案规范化复核）。
> `feat/platform-declared-inputs`（`ff970458`）已推远端、**尚未合入 dev**，本批三笔见 A58（补全可选能力）
> / A59（第 4 步五类字段收进「可选能力」区并默认展开）/ A60（名片改填开关名、输出格式接通透传）。
>
> **2026-11-05 复核（第四批）**：`feat/platform-declared-inputs` 已合入 dev 并推送，
> **origin/dev 尖 = `49223306`**，CI 双绿（run `41889367031`）。本批三笔见 A61（多权重位的交互与接线）
> / A62（留空即未声明：trim 归一、`call.bind.text` 放宽、未声明格灰显与栏头说明）/ A63（合入收尾，顺带修掉 dev 既有三类红）。
>
> **2026-11-05 复核（第五批）**：推理入口嗅探补强已合入 dev 并推送，
> **origin/dev 尖 = `71467897`**，CI 双绿（run `41973447026`）。本批一笔见 A64
> （打包声明 / src 布局 / README 写法变体 / 参数词表 / 路径基准）。
>
> **2026-11-05 复核（第六批）**：PR #43 修完并合入（squash `d4c6b53c`），入口嗅探再补一层框架支持
> （`28a41016`）。**origin/dev 尖 = `28a41016`**，CI 双绿（run `42020995804`）。本批一笔见 A65。
>
> **2026-11-05 复核（第七批）**：入口从「留空让人填」改成「从清单里选」，扫描不再限深度
> （`961ff3ec`）。**origin/dev 尖 = `961ff3ec`**，CI 双绿（run `42028615594`）。本批一笔见 A66。
>
> **2026-11-05 复核（第八批）**：从仓库地址到合法名片的沙箱实测跑通（`29a140d3`），
> **origin/dev 尖 = `29a140d3`**，CI 双绿（run `42041155471`）。本批一笔见 A67，
> 并订正 `ENGINE_ADOPTION_FLOW.md` §一里与实现不符的「名片必然两阶段」结论。
>
> **2026-11-05 复核（第九批）**：真引擎端到端五步实测跑通（`bbc77d9b`），
> **origin/dev 尖 = `bbc77d9b`**，CI 双绿（run `42049010386`）。本批一笔见 A68。
>
> **2026-11-05 复核（第十批）**：自动填值按证据强度分绿 / 黄徽标（`49f3136e`），
> CI 双绿（windows + ubuntu，run `42063996215`）。本批一笔见 A69。
>
> **2026-11-06 复核（第十一批）**：可选能力区改为分段框排版，必填区补灰显说明（`88af2b8f`），
> CI 双绿（windows + ubuntu，run `42078849435`）。本批一笔见 A70。
>
> **2026-11-06 复核（第十二批）**：参数池按推理入口收窄（`75956275`），
> CI 双绿（windows + ubuntu，run `42086670922`）。本批一笔见 A71。
>
> **2026-11-06 复核（第十三批）**：可选能力区补可复现性（seed）声明位（`a1ea9b05`），
> CI 双绿（windows + ubuntu，run `42095524001`）。本批一笔见 A72。
>
> **2026-11-06 复核（第十四批）**：seed 在 cli 形态下补 call.args 接线（`666864e9`），
> CI 双绿（windows + ubuntu，run `42100076786`）。本批一笔见 A73。
>
> **2026-11-06 复核（第十五批）**：实现 `call.returns = "dir"`（`5a7c271b`），
> CI 双绿（windows + ubuntu，run `42191612277`）。本批一笔见 A74。
>
> **2026-11-06 复核（第十六批）**：seed 收成设备行的第三个输入框（`ee7745b2`），
> CI 双绿（windows + ubuntu，run `42201573726`）。本批一笔见 A75。
>
> **2026-11-07 复核（第十七批）**：推理入口并入必填字段、seed 参与嗅探（`46ac9be5`），
> CI 双绿（windows + ubuntu，run `42241059998`）。本批一笔见 A76。
>
> **2026-11-07 复核（第十八批）**：模型权重的「值」按证据定目录或文件（`06722fa9`），
> CI 双绿（windows + ubuntu，run `42245695253`）。本批一笔见 A77。
>
> **2026-11-07 复核（第十九批）**：左栏已用参数弱化、分组措辞（`bf80769a`），
> CI 双绿（windows + ubuntu，run `42261548911`）。本批一笔见 A78。
>
> **2026-11-07 复核（第二十批）**：分组加中文注、辅助参考音频改名与多选透传（`842a6562`），
> CI 双绿（windows + ubuntu，run `42264913366`）。本批一笔见 A79。
>
> **2026-11-07 复核（第二十一批）**：IndexTTS2 情绪向量的两条实测缺口与修复（`2c683cbb`），
> CI 双绿（windows + ubuntu，run `42271211495`）。本批一笔见 A80。
>
> **2026-11-07 复核（第二十二批）**：拖拽带开关写法、向量参数按维度长成多格（`230c24ee`），
> CI 双绿（windows + ubuntu，run `42274527273`）。本批一笔见 A81。
>
> **2026-11-07 复核（第二十三批）**：多维参数声明成 `vector`，9886 专门的样式（`982929a5`），
> CI 双绿（windows + ubuntu，run `42279037032`）。本批一笔见 A82。
>
> **2026-11-07 复核（第二十四批）**：vector 维度名与默认值合成一维一行（`b04e9892`），
> CI 双绿（windows + ubuntu，run `42358706069`）。本批一笔见 A83。
>
> **2026-11-07 复核（第二十五批）**：vector 维度压成一行小格（`002d5f19`），
> CI 双绿（windows + ubuntu，run `42360009637`）。本批一笔见 A84。
>
> **2026-11-07 复核（第二十六批）**：参数名输入框吃满主行剩余宽度（`9c3ac2f7`），
> CI 双绿（windows + ubuntu，run `42360877091`）。本批一笔见 A85。
>
> **2026-11-07 复核（第二十七批）**：vector 切到别的类型不留逗号（`b24c45e3`），
> CI 双绿（windows + ubuntu，run `42362023078`）。本批一笔见 A86。
>
> **2026-11-07 复核（第二十八批）**：vector 独立控件、合成参数四列主行与按类型展开（`d66e4304`），
> CI 双绿（windows + ubuntu，run `42368044543`）。本批一笔见 A87。
>
> **2026-11-07 复核（第二十九批）**：合成参数加表头与填写引导、整排撤除「高级 / More」（`a652e973`），
> CI 双绿（windows + ubuntu，run `42371274269`）。本批一笔见 A88。
>
> **2026-11-07 复核（第三十批）**：合成参数收成一个大框、表头进框内、行间改分隔线（`cc04d80f`），
> CI 双绿（windows + ubuntu，run `42388907087`）。本批一笔见 A89。
>
> **2026-11-08 复核（第三十一批）**：右栏预览按 9886 派生形状读名片参数（`eb297e4a`），
> CI 双绿（windows + ubuntu，run `42392726833`）。本批一笔见 A90。
>
> **2026-11-08 复核（第三十二批）**：第 3 步支持一次嗅探上游给的全部仓库（`199c59a4`），
> CI 双绿（windows + ubuntu，run `42404508617`）。本批一笔见 A91。
>
> **2026-11-08 复核（第三十三批）**：权重落点统一按名片判，权重结论不再暗示能出声（`96141184`），
> CI 双绿（windows + ubuntu，run `42410709799`）。本批一笔见 A92。
>
> **2026-11-08 复核（第三十四批）**：第 3 步下载落点也按名片 runtime.checkpoints（`ef8debb1`），
> CI 双绿（windows + ubuntu，run `42463455937`）。本批一笔见 A93。
>
> **2026-11-08 复核（第三十五批）**：布尔参数补否定式声明，扫描结果预填到合成参数（`577a09dc`），
> CI 双绿（windows + ubuntu，run `42474422615`）。本批一笔见 A94。
>
> **2026-11-08 复核（第三十六批）**：权重落点在唯一模型子目录时下探一层（`845827d7`），
> CI 双绿（windows + ubuntu，run `42478820335`）。本批一笔见 A95。
>
> **2026-11-08 复核（第三十七批）**：第 3 步下载落点保留上游那一层子目录（`1263da03`），
> CI 双绿（windows + ubuntu，run `42482119863`）。本批一笔见 A96。
>
> **2026-11-08 复核（第三十八批）**：扫描前重读盘上现状（`01e39b30`），
> CI 双绿（windows + ubuntu，run `42482780866`）。本批一笔见 A97。
>
> **2026-11-08 复核（第三十九批）**：根 README 读不到下载命令时再去安装文档找一遍（`4822d8d0`），
> CI 双绿（windows + ubuntu，run `42483740441`）。本批一笔见 A98。
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

**名片（`manifest.json`）是唯一事实源**：平台替某个引擎做过的适配，一律收敛成名片的派生物；
加第二台引擎时 `lib/` / `server.js` / `web/` 不需要改。方向七条见
[`ENGINE_ONBOARDING_STATUS.md`](./ENGINE_ONBOARDING_STATUS.md)，当前这条重构线按 issue
[#26 外围契约化重构（三刀）](https://github.com/Yezipi66/Aurivox/issues/26) 推进。

旧表述「兼容全部 TTS」2026-11-01 作废：Engine Contract 已退休，GPT-SoVITS 与 IndexTTS2 的名片
是遗留实现数据、不是新引擎模板（见 [`README.md`](./README.md) 顶部声明）。

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

| **A35** | ⭐⭐ **组件模块顺带导出 hook 或普通函数 ⇒ Fast Refresh 失效，改一行就整个模块重载** | ✅ **2026-10-25 已做**（`337602f`）· 🔴 `editor/EngineScanZone.jsx` · `editor/useEngineDirs.js` · `editor/App.jsx` · `editor/factsQueryId.js`（新）· `editor/ParamDropZone.jsx` · `editor/paramDrop.js`（新）· `test/engineSwitch.node.test.js` · `test/editorModuleShape.node.test.js` · `test/appFactsQueryId.node.test.js` · `test/paramDrop.node.test.js` | [读码 + vite 日志 2026-10-25] vite 的 HMR 日志连续报 `Could not Fast Refresh ("useEngineDirs" export is incompatible)`；原因是 `useEngineDirs` 这个 hook 与组件写在同一个文件里。⚠️ **2026-10-26 又冒出第二类**（vite 日志）：`Could not Fast Refresh ("factsQueryId" export is incompatible)` —— 这次不是 hook，是**普通函数**。vite 的 react 插件的规则比「组件 + hook 混在一起」更严：**组件模块只许导出组件**（常量可以），导出任何别的函数都会坏 Fast Refresh ⇒ 改那个文件变成整页 reload。⇒ 守卫先前只查「既导出组件又导出 hook」，漏掉了普通函数这一类 | ✅ **三次一起改**：① hook 拆到 `editor/useEngineDirs.js`（项目既有约定就是每个 hook 一个文件：`useInstalled.js`、`useInstallSession.js`）② `factsQueryId` 拆到 `editor/factsQueryId.js` ③ `paramNameOf` 与 `applyParamDrop` 拆到 `editor/paramDrop.js`（两个纯函数原先在 `ParamDropZone.jsx` 里）。⚠️ **拆出去的纯函数文件只有具名导出，没有 default**：default 导出在 react-refresh 眼里是「组件出口」，那个文件会被当成组件模块 ⇒ 里面的具名导出又要被查一遍。⚠️ **同目录的 .js 互相 import 要带 .js 后缀**（`paramDrop.js` 里 `import ... from './paramType.js'`）：没有后缀时 Node 的 ESM 解析器认不出来，`require()` 直接报 ERR_MODULE_NOT_FOUND（项目既有做法见 `downloadRunner.js`）⚠️ **判据不是「有没有警告」而是「模块结构对不对」**：警告只在改动那个文件时才打出来，不改就看不到 ⇒ 守卫按文件结构查。新判据：模块里有 default 导出（组件出口）时，其余小写开头的具名函数导出都不许有；带变异检查（造一个组件模块加一个普通函数导出，看它被不被判成违规）⭐ **实测**（vite 9334 重启后 touch 这两个文件）：之前 `hmr invalidate /App.jsx Could not Fast Refresh ... ⇒ page reload`；现在 `hmr update /App.jsx` 与 `hmr update /ParamDropZone.jsx`，干净热更新，零警告 | |
| **A36** | ⭐⭐ **两条测试的结果取决于「跑它的机器」：一个写死了本机绝对路径，一个取决于本机有没有 Intel 显卡** | ✅ **2026-10-25 已做**（`bcb54e71` `ccd56ece`）· 🔴 `test/pencilClick.node.test.js` · `test/installChoicesUpgrade.node.test.js` | [CI 实测 2026-10-25] 推分支后 CI 红了 5 条（Windows 与 Ubuntu 各一套），其中 2 条是本机绿、CI 红：① `pencilClick.node.test.js` 把 `web/node_modules` 的位置写死成 `D:/Project/tts_broker_openai_compat` ⇒ 换个检出目录（CI 上就是）就 `MODULE_NOT_FOUND` ② 「不接受升级 ⇒ 装法原样返回」那条夹具传了 `backend: 'ipex'` 却没传 `recommendedBackend` ⇒ 判据会去探本机 GPU，探出来的后端与所选的不一致时换后端那条路线会重排装法 ⇒ 断言「原样返回」就红 | ✅ ① `web` 目录按测试文件的位置推算（`stepDepsRender.js` 里已有这个算法），不再写死；React 改用同模块导出的 `webRequire` 取（组件那边与测试那边必须是同一份 React，取两份会触发 Invalid hook call）② 显式传 `recommendedBackend: 'ipex'`：表达式 `input.recommendedBackend || detectRecommended()` 会短路，**GPU 探测根本不发生**（实测探测次数 0）⇒ 测试与本机硬件无关。⭐ **另补一条守真正的意图**：所选后端与本机推荐不同时，装法会重排（torch 挪到追加步、用所选后端的 index 装），但**版本号必须还是上游那个**（使用者没接受升级，不许闷头改版本）；变异检查：把版本换成建议版本后这条报红。⚠️ **这类坑本机查不出来**：本机有 Intel Arc（探出 ipex）⇒ 夹具恰好绿 ⇒ 只有 CI（runner 无 GPU）才照出真相 ⇒ 与 A18 同类，测试夹具不许依赖本机环境 | |
| **A37** | ⭐⭐⭐ **第 4 步的三栏外壳是自制的：三个栏头 + 三条边框把页面切成了三个盒子，与主界面的形态不一样** | 🔴 **Owner 验收不通过，已被 A38 推翻**（本行记录当时做成了什么、为什么不够）· 🔴 `editor/ThreeZone.jsx`（已删）· `editor/EngineIdentity.jsx` · `editor/EngineScanZone.jsx` · `editor/PanelPreview.jsx` · `editor/ManifestPage.jsx` · `editor/App.jsx` · `editor/editor.css` · `editor/useEngineDirs.js` · `test/threeZone.node.test.js` · `test/manifestLayout.node.test.js` · `test/editorModuleShape.node.test.js` | [读码 + 真浏览器实测 2026-10-25] 主界面的形态是：`.workspace-left` / `.workspace-right` 本身**没有边框也没有背景**，只是定位用的列（`web/src/styles.css:431-469` 是 `.section`，`:578-587` 是两个列容器）；视觉外壳由**内容自己带**（`.section` 或 `.card`）。而第 4 步原来每一栏外面套一层自制外壳（`.wz-zone` + `.wz-zone-hdr` + `.wz-zone-title` + `.wz-zone-body`），栏头里写着「扫到的参数」「名片内容」「预览」——**这三个标题在主界面里都不存在** | ✅ **当时做的四处**：① 删掉自制栏头层，三栏那一层改用项目现成的 `.workspace-left` / `.workspace-right` ② 新增 `editor/EngineIdentity.jsx`：引擎下拉 + 名片来源 + 现状三态，放**中栏顶部**（Owner 裁决 B：身份跟着名片走）③ 收起状态从 `ThreeZone` 提到 `ManifestPage`，收起那一栏换成 40px 窄轨 ④ 预览栏也用 `.section` 外壳，`Advanced Settings` 改成真的折叠 ⚠️ **Owner 验收不通过**（2026-10-25）：只把「自制栏头」换成了「项目现成的列容器」，但**页面骨架仍然是三栏并排**，而且第 4 步仍整页套在平台的 `.node-detail` 里（紫框 + 圆角 + 底色）。Owner 的判词是「拿一个带紫色描边的巨型棺材盒把三栏硬塞进去」—— 说的是**层级**问题，不是**样式**问题：左边条/中栏/右边条不该是同一张卡片里的三个格子，它们是页面自己的三根骨头 ⭐ **当时量到的数据**（CDP 9334，2026-10-25）：三栏 260px / 690px / 380px；收起左栏 ⇒ 40px 910px 380px；收起右栏 ⇒ 260px 1030px 40px；Advanced 真能折叠；拖拽端到端 35 个参数进 `parameters[]` ⚠️ **留到下一轮的教训**：改了「栏头长什么样」不等于改了「页面怎么排」。Owner 说的是三根平级的骨头，要动的是**容器层级**，不是类名 | |
| **A39** | ⭐⭐⭐ **PR #9 / #10 / #11 三个 PR 合入研究分支：主界面界面缺陷、向导渲染缺陷、第 4 步需求对齐骨架** | ✅ **2026-10-26 已合入**（`8115cd8e` #9 · `95392dda` #10 · `dd134e34` #11 · `22a21f85` 合入时修的两处）· 🔴 `web/src/styles.css` · `web/src/components/**` · `tools/engine-wizard/editor/**` · `tools/engine-wizard/core/cliDraft.js` · `tools/engine-wizard/core/paramDigest.js` · `test/manifestLayout.node.test.js` · `test/paramCertainty.node.test.js` · `test/fontScale.node.test.js` | [读码 + 真浏览器实测 2026-10-26] 三个 PR 都是叠的：#9 与 #10 都指向研究分支，**#11 叠在 #10 之上**（base = `fix/wizard-ui-defects`）⇒ 合并顺序 #9 → #10 → #11。⚠️ **唯一冲突**在 `web/src/styles.css` 的 `:root` token 段：#9 与 #10 各定义了一遍 `--fs-*` / `--sp-*`，**#9 那份是超集**（多一句「fontScale 守卫管着下限」的括注）⇒ 取 #9 那份即可，一句话解完 | ✅ **合入时修了两处**：① **注释违禁词**（`EngineIdentity.jsx` 的「那张」、`useSaveManifest.js` 的「这一下」）—— 那正是 #11 CI 红的原因 ② **右栏放大后的宽度式子写死了左边条的宽度**：`min(1400px, calc(100vw - 32px - 480px))` 里那个 32px 是左栏**收着**时的边条宽，左栏展开是 360px ⇒ 左抽屉开着、右栏又放大时，中栏被压到 **142px**（真浏览器实测），表单没法用。改法：`--wz-left-w` 跟着左栏实际占位变（收着 32px / 展开 360px / 窄屏 280px），左栏开合由 `Stage.jsx` 写在类名上（不用 `:has()`：本项目没用过，也没有 browserslist 声明最低浏览器版本）⭐ **实测**（CDP 9334，1410×805）：修前中栏 142px，修后 **470px**，两态下中栏中心的命中测试都落在 `select.control` 上 ⚠️ **A38 的三条已定性质没被改坏**（逐条查过）：无遮罩、点中栏不收抽屉、三根平级的骨头；命中测试复验：中栏可点、真打字进去（`value:"abc"`）、抽屉开着时点中栏不收抽屉、页面异常 0 ⛔ **两个待 Owner 裁决的开放项**（不阻塞合并，但影响第 4 步能不能用）：**① 保存按钮的位置被 #11 改了** —— 原来底部有吸底的 `SaveBar`（`docs/archive/STEP4_FRONTEND_REWRITE_RFC.md` 第 6 章，提交 `61e98fa`，独立验收通过，理由是「现埋在 7 屏下」），#11 把它删了、保存挪到中栏顶部的身份条最右边。⚠️ **但 #11 同时把中栏的滚动改成「整个页面滚」**（`.wz-stage-main` 的 `overflow` 是 `visible`，边条改成 sticky 跟着页面滚）⇒ 身份条在滚动内容的顶部，**往下滚，保存按钮就滚出视口**：真浏览器实测滚 332px 后保存按钮 `top: -154`，那个位置上连命中目标都没有 ⇒ 这正是那条 RFC 要防的问题。**② #11 是骨架 PR**（PR 正文自列 6 条 `TODO(骨架)`），其中「平台预填的格子标『平台已填』」「区头显示『还差 N 项』」「高级区与必填区重复的 runtime 编辑入口」这几条影响使用者判断还差什么 | | |
| **A41** | ⭐⭐ **合并后做了一轮「客观量」的界面验收：把「这界面长什么样」变成十条可断言的判据，在真浏览器里跑三种状态** | ✅ **2026-10-26 已做**（`scratch/cdpAudit.cjs`，不入库）· 🔴 `tools/engine-wizard/editor/Stage.jsx` · 🔴 `tools/engine-wizard/editor/editor.css` | [真浏览器实测 2026-10-26] 为什么做这个：A37 那次翻车（紫框棺材盒）就是没人看截图的结果 ⇒ **观感不能只靠「我觉得没问题」**，要变成可复跑的判据。十条判据在三种状态下全绿（默认 / 左抽屉开 / 左抽屉开+右栏放大）：① 三根骨头平级且左右不重叠 ② **骨架层零个带边框或底色的祖先**（紫框真的没了）③ 无遮罩 ④ 中栏中心的命中测试落在中栏内的真控件上 ⑤ 中栏字段无裁切 ⑥ 页面无横向滚动 ⑦ 三栏不重叠 ⑧ 左栏参数卡片有内容 ⑨ 落点在中栏内 ⑩ 中栏有内容（可见文字 1171 字符、58 个控件）⭐ 另做端到端（后端起来后）：选引擎 → 扫描 → **真拖拽**（CDP 的 `Input.dispatchDragEvent`）→ 名片里 `parameters[]` 真有了 `model_dir`、`call.args` 真有了 34 条 ⇒ 全链路通 ⚠️ **量出三件 Owner 要看的事**：① **保存按钮在滚到底后滚出视口**（`top: -93`，页面滚了 309px）—— 这是 #11 把滚动改成整页滚的直接后果，已在 A39 记为待裁决 ② **拖拽落点在首屏之外**（默认态它在 y=988，视口高 900）—— 必填字段那一段占 668px 高度，落点是第三个区段 ⇒ 用户得往下滚才看得到「拖到这里」 ③ 窄栏最窄态（470px）有两处字段名溢出 24px：`RequiredEight.jsx:103` 的 `<code>capabilities.requires_reference_audio</code>` 在药丸形 `.badge`/`code` 里换不了行 ⇒ 末尾 4 个字符被裁（**合入前就有**，来自 `82ee68f3`，不是这三个 PR 带来的）⭐ **顺手记两个测试手段的坑**：**① `Input.dispatchDragEvent` 的 `data` 是普通对象**（协议里 `type: object`），传 base64 的 CBOR 或 JSON 字符串都报「Failed to deserialize params.data - CBOR」；**② 坐标是相对视口的**，落点要先 `scrollIntoView` 才在视口内，否则事件根本到不了那个元素（我第一版量到落点在 y=1049、视口高 900，拖了也是白拖）⚠️ **还有一条 JSON 视图的性质要说清**：它是「切进去那一刻」的快照（编辑缓冲，不是实时镜像）⇒ 读名片必须在所有编辑动作**之后**第一次切进去读，否则读到的是旧值（我第一版就是这么误判的：以为拖拽没生效，其实落点文案已经写着「1 already added」） | | |
| **A42** | ⭐⭐⭐ **审查 PR #12（修 #11 引入的两个回归）：压窄那条修对了，但拖宽这条引入了新的回归，预览能把中栏压成 0px** | ✅ **2026-10-26 已修并合入**（作者提交 `7f1f0ca9` 修掉本条报的两条，PR 合并提交 `6f4141d6`）· ⚠️ 本条记的是**合并前**的审查结论，现已过时 → 合并后的情况见 A43 / A45 | 🔴 `tools/engine-wizard/editor/Stage.jsx` · 🔴 `tools/engine-wizard/editor/drawerWidth.js` · 🔴 `tools/engine-wizard/editor/editor.css` · 🔴 `tools/engine-wizard/test/drawerWidth.node.test.js` | [读码 + 真浏览器实测 2026-10-26] **PR #12 要修两件事**：① #11 把第 4 步移出 `.workspace-container`，而那个容器带 `margin: 0 auto`，在竖排 flex 里左右 auto margin 会按内容收缩、不再撑满 ⇒ 1600px 视口下顶栏只有 569px、流程条 975px ② 预览没法全屏（抽屉上两个按钮都要 `width:100%` 又都不许收缩，第二个被挤出抽屉、被 `overflow:hidden` 藏了）⭐ **第一条修对了**：主工作区实测容器 562px ⇒ PR 版 1400px；CSS 推理也成立（`editor.css:53` 的 `.wz-root > .workspace-container { width: 100% }`）；PR 正文说上限 1248px，我量到 1238px，差 10px 是因为三栏骨架的实际宽是 1590px 而不是 1600px（页面有 10px 滚动条留白），不是缺陷 ⭐ **第二条也修对了**：当前分支的「放大」按钮实测 `x:1590`（在抽屉 `x:1230, w:360` 的右边外面），命中测试落在 `null`，点它毫无反应；PR 版两个按钮各 32px 都在抽屉内，命中测试落在自己身上，点第二个真的进全屏（占满 0,0,1600×900，Esc 能退）⭐ **拖宽功能实测有效**：从 360px 往左拖 500px 变 863px，拖到底停在上限；键盘 `←`/`→` 每次 32px 正常，双击还原 360px；窄屏（900px 视口）没拖过时不写 inline 宽度 ⇒ 280px 降级规则照样生效 ⛔ **但 PR #12 引入了新的回归：预览能把中栏压成 0px**。`drawerWidth.js:25` 的 `clampPreviewWidth` 只在**拖的那一刻**算一次上限（`Stage.jsx:77` 的 `resizeTo`），算完就把宽度存进 `rightW`（`Stage.jsx:60`）。**左抽屉后开时没有任何地方重算这个上限** ⇒ 实测：先把预览拖到最宽（1238px，中栏 320px），再点左边条展开左抽屉（360px）⇒ 32 + 360 + 1238 = 1630px，超过骨架的 1590px ⇒ **中栏被压成 0px**，名片编辑区整条消失：里面 48 个输入框全部命中不到（`elementFromPoint` 全部落空），中栏 `clientWidth:0` 而 `scrollWidth:111`。**对照实验**：当前分支走的是 CSS 变量 `--wz-left-w`（左栏开合由 `Stage.jsx` 写在类名上），左抽屉一开就自动重算 ⇒ 同样操作下中栏是 870px，不会归零。⇒ **这条是 PR #12 新引入的，不是老问题** ⛔ **现有守卫拦不住这条**：`drawerWidth.node.test.js` 的 5 条只测 `clampPreviewWidth` 这个纯函数的数学（给定 stageW/leftW 时的夹取），不测「存下来的宽度在左栏变化后会不会重算」；变异检查：把 `resizeTo` 改成不调 clamp ⇒ 5 条守卫全绿；把「左栏变化后重算」的代码删掉 ⇒ 也全绿。`manifestLayout.node.test.js` 的「预览可拖动改宽，也能全屏」那条只查类名与 CSS 声明，不查运行时几何 ⭐ **已验证候选修法**：在 `leftOpen` 变化与 `window resize` 之后用新几何重夹一次已存的宽度（`rightW === null` 表示没拖过，不动它）⇒ 实测中栏稳定在 320px、预览自动从 1238px 收到 910px；注意抽屉有 160ms 的宽度过渡（`editor.css:155`），刚开的那一帧量到的是 32px，所以重算要等过渡结束（`setTimeout` 200ms 或等两帧）⚠️ **两条次要问题**：① **全屏时背后的页面还能滚**：全屏层是 `position:fixed`（`editor.css:185`）钉在视口，但页面本身还能滚 ⇒ 实测全屏时滚轮让 `window.scrollY` 从 0 变成 237，退出全屏后页面位置与进入时不同。当前分支没有「全屏」这一档（那是 sticky 参与 flex 布局，页面滚时预览跟着走），所以这是新功能自带的问题；预览内容自己够高时能自己滚（实测内容 3140px、容器 870px，滚轮让预览 `scrollTop` 0→400，背后没动）② **中栏 320px 时表单长标签互相压住**：通用重叠扫描查出 3 对重叠（`capabilities.requires_reference_audio` 与 `capabilities.output_sample_rate` 重叠 11px），另有 11 个元素横向溢出（`.section` 溢出 50px、`.form-grid` 溢出 62px）—— 这条 PR 正文自己承认了，说「下一步再处理」⭐ **PR 的其他部分核实无误**：merge-tree 预演 EXIT=0 无冲突；向导守卫全绿（drawerWidth 5、manifestLayout 17、threeZone 7、styleguard 24、paramDrop 11、editorModuleShape 7、appFactsQueryId 5）；CI 两个平台都绿 ⛔ **结论**：压窄与全屏两条修得都对，但拖宽这条引入了「中栏被压成 0px」的回归 ⇒ **先不合并**，请作者补上「左栏开合与视口变化后重算宽度」并加一条钉住它的守卫 | | |
| **A43** | ⭐⭐⭐ **PR #12 的第二个提交（`7f1f0ca9`）修好了我报的中栏归零与全屏漏滚两条，并补上了两条真会红的守卫 ⇒ 可以合** | ✅ **2026-10-26 已合并**（PR #12，合并提交 `6f4141d6`）· 🔴 `tools/engine-wizard/editor/Stage.jsx` · 🔴 `tools/engine-wizard/editor/editor.css` · 🔴 `tools/engine-wizard/editor/drawerWidth.js` · 🔴 `tools/engine-wizard/test/manifestLayout.node.test.js` · 🔴 `tools/engine-wizard/test/threeZone.node.test.js` | [真浏览器实测 2026-10-26] **作者采用的修法**：不再靠 JS 在拖的那一刻夹一次上限，而是把上限写进 CSS —— `.wz-drawer-right.is-open` 加 `max-width: max(var(--wz-drawer-w-narrow, 280px), calc(100% - var(--wz-left-w, 32px) - var(--wz-center-min, 320px)))`，左栏开合由 `Stage.jsx` 在骨架上写 `wz-stage-left-open` 类名（CSS 变量 `--wz-left-w` 随之从 32px 换成 360px，窄屏换 280px）⇒ **每帧按当前几何封顶**，不必等抽屉那 160ms 的宽度过渡 ⭐ **我报的两条都修好了（真浏览器实测，1600×900，PR 分支跑在 5202）**：① **中栏归零**：拖到最宽（1238px，中栏 320px）再展开左抽屉（360px）⇒ 中栏 **320px**、预览自动收到 910px；关掉再开反复切换，中栏稳定在 320px；视口缩到 1200 再回 1600 也稳定在 320px（上一版这三种情况都会归零）② **全屏漏滚**：全屏时 `documentElement.style.overflow` 实测为 `hidden`，滚轮不再让背后的 `window.scrollY` 变化（上一版是 0→237） ⭐ **新引入的边界也逐条量过，没有发现新问题**：拖到最宽后往回拖 300px ⇒ 预览真的缩到 938px（没有被 CSS 压死）；左抽屉开着时再拖 ⇒ 中栏守住 320px；窄屏 900px 下左抽屉开 ⇒ 中栏 320px、右 290px，左抽屉关 ⇒ 中栏 348px；全屏时 `max-width` 计算值是 `none`、占满 0,0,1600×900；Esc 退出后键盘 ←/→ 每次 32px 正常（510→414） ⭐ **新守卫钉得住（变异检查六个，全被抓住）**：M1 `max-width` 少减 `--wz-left-w` ⇒ 红；M2 `--wz-center-min` 改成 200px（与 `drawerWidth.js` 的 `CENTER_MIN` 不一致）⇒ 红；M3 去掉左栏开合的类名切换 ⇒ 红；M4 去掉全屏时的 `overflow:hidden` ⇒ 红；M5 `--wz-left-w` 默认值改成 0px ⇒ 红；M6 去掉全屏的 `max-width:none` ⇒ 红 ⭐ 向导守卫全绿（drawerWidth 5、manifestLayout 18、threeZone 9、styleguard 24、paramDrop 11、editorModuleShape 7、appFactsQueryId 5、fontScale 2）；CI 两个平台都绿（run `40300745249` / `40300737276`）；merge-tree 预演 EXIT=0 无冲突 ⚠️ **PR 正文自己承认的已知问题仍在**（中栏 320px 时 `capabilities.requires_reference_audio` 与 `capabilities.output_sample_rate` 重叠 11px、另有 11 个元素横向溢出）⇒ 复验结果与上一版完全一样，不是这次引入的；作者说下轮处理，可以先合 ⚠️ **一条方法上的提醒**：PR #12 的两个提交都是同一个身份（`Yezipi66`）推的，而 GitHub **不允许对自己的 PR 提交 REQUEST_CHANGES 或 APPROVE**（实测报错 `Review Can not request changes on your own pull request`）⇒ 我能拿到的最高规格是 COMMENT 型 review，它在 PR 的 Reviews 区块里作为正式 review 记录显示。给别的仓库审 PR 时不受这条限制 | | |
| **A44** | ⭐⭐⭐ **「必填 8 项」少了一项：平台的第 9 个硬必填键 `capabilities.reference_clip_seconds` 在向导里既填不了、校验也不报 ⇒ 向导能填出平台装不上的名片** | ✅ **2026-10-26 校验层已修**（`validate.js` 直接调平台 `profile/fields.js` 的判据，不再自己抄一份）· ✅ **2026-10-27 表单那一半也做了**（见 A46：并进必填区的两列网格，`capabilities.reference_clip_seconds` 现在是网格里的一格）· 🔴 `tools/engine-wizard/editor/RequiredEight.jsx`（**已删**）· 🔴 `tools/engine-wizard/editor/CoreBindings.jsx`（**已删**）· 🔴 `tools/engine-wizard/editor/RequiredFields.jsx` · 🔴 `tools/engine-wizard/core/fieldmeta.js` · 🔴 `lib/engines/profile.js` | [读码 + 真浏览器实测 2026-10-26] **Owner 问「那意思是其实这些是必填嘛？」** ⇒ 是，而且比「8 项」这个说法更硬：平台 `lib/engines/profile.js` 里 `required(...)` / `requiredBool(...)` / `positiveInt(...)` 的必填键一共 **9 个**，不是 8 个 ⭐ **漏掉的那第 9 个是 `capabilities.reference_clip_seconds`**（`profile.js:174-179`）：缺了直接抛 `ENGINE_MANIFEST_INCOMPLETE`，报错文案写得很清楚：「不限制请显式写 null。『忘了写』和『不限制』必须能区分开，否则一个漏写会静默变成『什么参考音频都收』，等到合成失败才发现」 ⇒ **这是平台故意的硬必填**（要区分「没写」与「不限制」） ⛔ **但向导第 4 步填不了它**：真浏览器把第 4 步所有折叠全部展开后，页面上 36 个 `code` 标签里**没有任何一个**是它；页面上也没有一处提到 `clip` 字样；连 `capabilities` 这个节在界面上都不存在（`capabilities` 属于 `CONTAINER_KEYS`，`ManifestForm.jsx:46-49` 把它从平铺渲染里跳过，而 `L3_GROUPS`（`:178`）虽然列了 `capabilities`，但 `byGroup` 里没有它的平铺子键 ⇒ 那节压根不渲染） ⛔ **向导自己的校验也不报**：拿 `gpt-sovits` 的现成名片删掉这个键，`validate.js` 的 `diagnose()` 返回 **0 条诊断** ⇒ 第 5 步的「四道校验」会放行 ⭐ **唯一的入口是 JSON 视图**：实测第 4 步的 JSON 视图是纯 textarea，能写任意键（读入 gpt-sovits 后里面确实带着 `reference_clip_seconds: [3,10]`）⇒ 所以不是「完全填不了」，是「表单里填不了，只能手改 JSON」 ⭐ **实测的四台已装引擎全都有这一项**（gpt-sovits `[3,10]`、cosyvoice2 `null`、cosyvoice-300m-sft、index-tts `[0,15]`），`engines/_TEMPLATE/manifest.json` 里也有（值 `null`）⇒ 现有的 8 项清单是**照着已装引擎总结出来的**，漏了这一项 ⭐ **文档里早有前科**：`docs/archive/ENGINE_ONBOARDING_E2E_INDEX-TTS.md:281` 记着「卡点 4：`reference_clip_seconds` 的形状与模板不一致 —— 平台报了错」，当时的结论是改模板注释 ⇒ 说明这个键一直是「平台要、人得自己记得写」的东西 ⚠️ **顺带记一笔已经量到的相邻问题**：`RequiredEight.jsx` 里那 8 项与「高级」段的 `RuntimeSection`（`ManifestForm.jsx:230-236`）是**同一份数据的两处编辑** —— 实测 `runtime.python` 在页面上有两个可编辑入口（必填字段区一个、高级 RUNTIME 段一个），提示文字一模一样，但高级那处多一个 `blocks loading` 徽标、必填那处没有 ⇒ 两处不只是长得像，行为也不一致；这正是 `ManifestForm.jsx:227-229` 那条 `TODO(骨架)` 记的事（「这里应只留必填之外的键」） ⚠️ **第 9 项要定两件事（等 Owner 拍板）**：① **它算不算「运行与能力」那块的一部分**（那一块的边界是 8 项还是 9 项）② **它的形状**：`[min,max]` 区间还是 `null`（平台两种都收，`profile.js:213` 的 `parseClipSeconds` 处理）—— 界面上的控件该怎么给？  ⭐ **这一笔（校验层）已做完**：`core/validate.js` 新增「3b. 平台当场校验的那几个键」段，**判据不重写**：直接 `require` 平台的 `lib/engines/profile/fields.js`，调它自己的 `required()` / `requiredBool()` / `positiveInt()` / `parseClipSeconds()` ⇒ 校验层不会比平台宽、也不会比平台严 ⛔ **第一次写的时候把判据抄了一遍，抄错了**（自己写的「缺 = undefined || null」放过了空串，而平台 `required()` 把空串也当缺（`fields.js:20`）；`requiredBool()` 的 null 是「写了但类型错」（`ENGINE_MANIFEST_INVALID_VALUE`），不是「缺」（`ENGINE_MANIFEST_INCOMPLETE`）） ⇒ **变异检查把这个错抓出来了**，改法不是把抄的那份补对，而是**改成直接调平台**（判据同源，不会漂） ⭐ **守卫**：`tools/engine-wizard/test/validateRequired.node.test.js`（11 条）—— 9 个键逐个删要报错、齐全不报、`null`/空串/非布尔/0/负数各按平台那一类的判据来、外加一条「不许自己抄判据，要 require 平台的 fields.js」⭐ **变异检查 11/11 全部被抓住**（`scratch/mutateValidate2.cjs`，不入库）：M1 删整段 3b、M2 漏掉 `reference_clip_seconds`、M3 放过空串、M4 放宽形状、M5 改错码、M6 改错 field、M7 砍清单、M8 整段抛异常、M9 布尔位 null 判成「缺」、M10 不 require 平台、M11 跳过 `positiveInt` ⛔ **顺带发现并修掉一个夹具漏洞**：`test/validate.node.test.js` 里那张「假引擎（wobble）」名片**平台自己也是拒绝的**（缺 `timeout_ms` / `max_chars` / `capabilities.*`）⇒ 它以前能过，是因为向导校验层比平台松，不是夹具对；已把那几个键补齐，现在平台与向导两边都通过 ⚠️ **表单那一半已在 A46 做完**（2026-10-27）：第 9 项现在是必填区两列网格里的一格，控件是「最短 / 最长」两个输入 + 一个「不限制 / 设一个范围」开关；同时那两个被拆掉的小组件（`RequiredEight.jsx` / `CoreBindings.jsx`）已删，高级段与必填区不再编辑同一份 `runtime.*` | | |
| **A45** | ⭐⭐ **PR #12 已合并进研究分支，顺带把 #9 / #10 / #11 的合并状态在 GitHub 与台账两边对齐** | ✅ **2026-10-26 已合入**（PR #12，合并提交 `6f4141d6`，分支 `hark/wizard-width-regression` → `research/engine-onboarding-complexity`）· 🔴 `tools/engine-wizard/editor/Stage.jsx` · 🔴 `tools/engine-wizard/editor/editor.css` · 🔴 `tools/engine-wizard/editor/drawerWidth.js` · 🔴 `tools/engine-wizard/test/manifestLayout.node.test.js` · 🔴 `tools/engine-wizard/test/threeZone.node.test.js` | [读码 + 真浏览器实测 2026-10-26] **#12 合并了两笔**：`c0274879`（修 #11 回归：顶栏与流程条被压窄、预览可拖宽可全屏）+ `7f1f0ca9`（预览上限交给 CSS 按当前几何封顶、左抽屉后开不再把中栏压成 0、全屏锁住背后页面滚动）⇒ 合并提交 `6f4141d6`，作者 Yezipi66、提交者 GitHub（GitHub 上真合并，不是本地手工 merge）⭐ **A42 报的两条回归在合并后都已消失**（A43 记了合并前的复验数据）：中栏归零与全屏漏滚都修好，六个变异全被新守卫抓住 ⛔ **PR 正文自己承认的已知问题仍在**（中栏 320px 时 `capabilities.requires_reference_audio` 与 `capabilities.output_sample_rate` 重叠 11px、另有 11 个元素横向溢出）⇒ 合并前后完全一样，不是这次引入的，作者说下轮处理 ⚠️ **A39 记的两个待裁决项没有被 #12 解决**（保存按钮滚出视口、#11 的 6 条 `TODO(骨架)`）⇒ 仍是开放项 ⚠️ **GitHub 与台账两边对齐**：① **#11 在 GitHub 上是手工 merge 进来的**（合并提交 `dd134e34` 的作者是 `unknown`、消息是中文「merge: … 合入 …」，不是 GitHub 的 PR merge）⇒ 内容确实进了分支（`7bfa1a0d` 是研究分支的祖先，且是 `dd134e34` 的第二个父亲），但 PR 在 GitHub 上一直挂在 open 列表里（base 还指着 `fix/wizard-ui-defects`，mergeable_state 是 `unstable`）⇒ 已手动 close 并留言说明来源，免得别人看 PR 列表误以为没合 ② **A42 / A43 的状态字段已订正**：原写「未合入，待作者修」「复验通过，待合并」，现已改成「已修并合入」「已合并」⇒ 台账不再与仓库实际状态矛盾 ③ **三个 PR 的内容都在分支里**（`git merge-base --is-ancestor` 逐个验过 #9 的 `d0cd7852`、#10 的 `bb0e4d15`、#11 的 `7bfa1a0d`、#12 的 `7f1f0ca9` 四个都是研究分支的祖先）⚠️ **一条方法上的提醒**：本地手工 merge 的 PR 在 GitHub 上不会自动变 merged ⇒ 这种 PR 合完要记得手动 close，否则 PR 列表会一直误导人 | | |
| **A40** | ⭐⭐ **合入 #9–#11 后，三个独立审查子 Agent 的复核发现两处守卫在跑但判据没钉住真正的东西** | ✅ **2026-10-26 已修**（`ce7daa43`）· 🔴 `tools/engine-wizard/test/manifestLayout.node.test.js` · 🔴 `web/src/components/engines/enginesTab.wiring.node.test.js` | [读码 + 变异检查 2026-10-26] ① **窄屏那条守卫自相矛盾**：`manifestLayout.node.test.js` 里有两条守卫 —— 119 行要求媒体块**不许**有 `position:absolute`（盖住中栏会点不到），214 行标题却写着「窄屏降级：改成**覆盖式**中栏」，判据是 `/\.wz-drawer\.is-open/.test(media[1])`。实际做法是**推开式**（窄屏把抽屉收到 280px），而推开式那条规则里同样有 `.wz-drawer.is-open` 这个子串 ⇒ 214 行照样绿 ⇒ **两条同时绿、意图互相否定，等于没守**。改成钉住真正的行为：窄屏抽屉收窄到 `var(--wz-drawer-w-narrow)`（默认 280px），并明确不许 `position:absolute` ⭐ 变异检查：窄屏抽屉改成 `position:absolute` ⇒ 两条守卫都红；宽度从 `var(--wz-drawer-w-narrow)` 改成写死 280px ⇒ 那条守卫红 ② **双语接线守卫漏断言 `processBadge`**：`lib/engines.js` 有五个文案函数都收 `lang`，守卫只钉了四个，漏了 `processBadge`（`EnginesTab.jsx:124` 实际传了）⇒ 将来有人改成不传 `lang` 不会被发现。补一行断言 ⭐ 变异检查：`processBadge(engine, lang)` 改成 `processBadge(engine)` ⇒ 守卫红 ③ 另把第 64 行理由句里的「SaveBar 另起一行」改掉（吸底 SaveBar 已随 #11 删除，那句话成了假陈述）⚠️ 附带记一笔：本轮补注释时自己踩了 `commentDiscipline` 的破折号禁令（写了 `——`）⇒ 全量测试当场红 2 条，改掉即绿 | | |
| **A46** | ⭐⭐ **第 4 步的必填区合成一个两列网格（去掉「核心输入」「运行与能力」两个小标题与那三行拖拽说明，全部沿用「合成文本 text」那种「中文人话 + 键名徽标」的形状），顺带收掉「同一份数据两处编辑」与「界面手抄了一份平台的 bind 槽位」两笔** | ✅ **2026-10-27 已做**· 🔴 `tools/engine-wizard/editor/RequiredFields.jsx` · 🔴 `tools/engine-wizard/editor/RequiredEight.jsx`（**已删**）· 🔴 `tools/engine-wizard/editor/CoreBindings.jsx`（**已删**）· 🔴 `tools/engine-wizard/editor/NestedSections.jsx` · 🔴 `tools/engine-wizard/editor/ManifestForm.jsx` · 🔴 `tools/engine-wizard/core/specbridge.js` · 🔴 `tools/engine-wizard/test/requiredZone.node.test.js`（新）· 🔴 `tools/engine-wizard/test/bindSlots.node.test.js`（新） | [Owner 裁决 + 读码 + 真浏览器实测 2026-10-27] **Owner 的原话**：「如果都是必填的情况下，那你去掉这个『运行与能力』的标题嘛，同时去掉『核心输入 平台会把这三个输入交给每台引擎。把左栏的参数拖到对应一格，或直接填参数名。』这几行，全部沿用『合成文本 text』这样的模式，因为这些字段平台是有固定的语义的，全部沿用一种就好了，然后一行两个参数」⭐ **为什么去小标题是对的（读码）**：那两段是同一件事 —— 缺 `call.bind` 三槽位，平台的三个输入没处去；缺其余各格，`lib/engines/profile.js` 加载名片时直接抛错 ⇒ 拆成两段读起来像两类不同重要性的东西，实际轻重一样 ⭐ **为什么去那三行说明（读码）**：那行说的是拖拽，而拖拽的落点就是那三格本身 ⇒ 说明是多余的；且 A41 已量到「拖拽落点在首屏之外（y=988，视口高 900）」，那行文字在首屏顶部而落点在下面 ⇒ 文字与落点分处两地，更没必要留 ✅ **四处一起改**：① **一个两列网格**：`.form-grid`（项目已有类，`web/src/styles.css:694-699`，`grid-template-columns: minmax(0,1fr) minmax(0,1fr)`），15 格全在里面（3 槽位 + 平台当场校验的 9 个键 + 3 个「那个数的出处」）② **每格统一成「中文人话 + 键名徽标」**：标签是中文（「合成文本」），键名进 `.badge-accent` 徽标（「text」）—— 键名照样看得见，但读起来是人话而不是一串路径 ③ **收掉「同一份数据两处编辑」**：`runtime.python` / `runtime.entry` / `runtime.ready_endpoint` / `runtime.ready_timeout_ms` / `runtime.ready_timeout_ms_source` 这五格原先在必填区与高级 `RuntimeSection` 各有一个入口，且两处徽标不一样（高级那处标「填错装不上」，必填那处不标）⇒ 高级段只留不是必填的 `args` / `checkpoints` / `verify` ④ **补上平台的第 9 个硬必填键**（A44 记的表单那一半）：`capabilities.reference_clip_seconds` 现在是网格里的一格，控件是「最短 / 最长」两个输入 + 一个「不限制 / 设一个范围」开关（值是 `null` 或 `[min,max]`，平台 `profile.js:213` 的 `parseClipSeconds` 两种都收）⭐ **顺带修掉一笔界面与平台脱节**（读码）：高级段的 `BindField`（`NestedSections.jsx`）手抄了一份 **6 个** bind 槽位（`text` / `ref_audio` / `output_path` / `ref_text` / `ref_lang` / `text_lang` / `out`），而平台只认 **3 个**（`lib/engines/hostProfile.js:51` 的 `BIND_SLOTS`，且 `:230` 对不认的槽位抛 `ENGINE_HOST_CONTRACT_INVALID`）⇒ 那 4 个是**填的时候不拦、加载名片时才拒**（使用者填完、保存成功、平台加载才炸）。改法：槽位清单从 `/wizard/spec` 拿（`specbridge.js` 直接 `require` 平台的 `hostProfile` 取 `BIND_SLOTS`），界面不手抄 ⇒ 必填区与高级段（顶层 bind + 分方法 bind）三处都照同一份 ⭐ **实测**（CDP 9334 真浏览器，1590px 视口，切中文）：① 网格 `gridTemplateColumns` = **`671px 671px`**（两列）② 15 格，每行格数 `[2,2,2,2,2,2,2,1]`，同排两格 x 差 **679px**（671 + 8px gap）、**y 完全对齐** ③ **零个小标题**（`.wz-subhead` 数 = 0）④ **那三行拖拽说明不在了**（整节文本里搜不到「平台会把这三个输入交给每台引擎」与「把左栏的参数拖到对应一格」）⑤ 每格形状对：合成文本/`text`、参考音频/`ref_audio`、输出/`output_path`、环境目录/`runtime.python`、启动脚本/`runtime.entry`、就绪端点/`runtime.ready_endpoint`、就绪等待（毫秒）/`runtime.ready_timeout_ms`、那个数的出处/`runtime.ready_timeout_ms_source`、单次请求超时（毫秒）/`timeout_ms`、那个数的出处/`timeout_ms_source`、单次请求最长字符数/`max_chars`、那个数的出处/`max_chars_source`、是否需要参考音频/`capabilities.requires_reference_audio`、输出采样率（Hz）/`capabilities.output_sample_rate`、参考音频时长（秒）/`capabilities.reference_clip_seconds` ⑥ **标签全中文**（零个标签不含汉字）⑦ **零个徽标被裁**、零个元素横向溢出 ⑧ 高级段 call 段的 bind 只有 `text` / `ref_audio` / `output_path` 三个 ⭐ **守卫**：`test/requiredZone.node.test.js`（9 条）—— 必填区是一个网格而不是两个小段、那三行说明不在、**平台当场校验的键一个不许漏（清单从平台源码挖出来，不手写）**、三个出处格都在、每格是「中文人话 + 键名徽标」且标签不许与键名一字不差、必填网格与高级段不再编辑同一份 runtime 数据、两个被拆掉的组件不在了；`test/bindSlots.node.test.js`（8 条）—— 平台只认三个槽位、`/wizard/spec` 原样送出、specbridge 直接取平台那份、界面不许出现平台不认的槽位名、高级段与必填区都照 spec 给的清单 ⭐ **变异检查 13/13 全部被抓住**（`scratch/mutateRequiredZone.cjs` 9 条 + `scratch/mutateBindSlots.cjs` 4 条，均不入库）：塞回小标题、塞回那三行说明、拿掉第 9 项、拿掉一个出处格、高级段把 `runtime.python` 加回来、去掉网格类、标签与键名一字不差、`CoreBindings.jsx` 放回来、TODO 塞回来、specbridge 自己抄一份 6 槽位、高级段用回 6 槽位、分方法 bind 漏传 slots、必填区不接 `bindSlots` ⭐ **全量测试绿**（`npm run test` 3060 条通过 / 0 失败；向导目录 870 条通过 / 0 失败）；`npm run build` 通过 ⚠️ **两条方法上的记录**：① **注释归位守卫会读自己写的注释** ⇒ 判据源码里提到「核心输入」这几个字时，必须先去掉注释再看（否则守卫被自己的解释文字绊住）—— `requiredZone` 那条守卫开头就有 `stripComments` ② **注释纪律禁「曾经」「实测」与破折号** ⇒ 本轮新写的两个测试文件都被 `styleguard` 拦过一次（`曾经`、一个 `——`），改掉即绿 | | |
| **A47** | ⭐⭐ **PR #14（名片只剩 5 项必填）本地合入研究分支：CI 拦的两处是纯措辞，另修掉一处 CI 抓不到的「加一项就凭空造出一条约束」** | ✅ **2026-10-27 已合入**（PR #14，合并提交 `7e015edf`，分支 `hark/wizard-five-required` → `research/engine-onboarding-complexity`）· ✅ **2026-10-27 措辞已修**（`022fe918`）· 🔴 `lib/engines/profile.js` · 🔴 `tools/engine-wizard/editor/optionalKeys.js` · 🔴 `tools/engine-wizard/test/requiredZone.node.test.js` | [读码 + 实跑 2026-10-27] **#14 的 CI 是红的，四个检查全挂，但挂的只有两条纯措辞**：Ubuntu 3043 条 / 3030 过 / **2 败** / 11 跳过，Windows 3043 条 / 3032 过 / **2 败** / 9 跳过 ⇒ 两边失败的都是同样那两个守卫（注释纪律、文案语气守卫），5 条违规**全指同样 3 处 `试跑` 注释**（`lib/engines/profile.js:107`、`:271`，`tools/engine-wizard/editor/optionalKeys.js:5`）⇒ 跨平台一致，无第二类失败。`试跑` 在 `lib/toneGuard.node.test.js:20` 的禁词表里，`实测` 在 `lib/commentDiscipline.node.test.js:33` 的现场叙述表里 ⇒ **纯措辞，零逻辑影响** ✅ **措辞修法**（用仓库已有的词，不自造）：`试跑实测` → `量出来之后`、`试跑后写回实测值` → `量出来之后写回量到的值`；「量出来/量得」是仓库里已有的说法（`lib/engines/profile/topkeys.js:3`、`lib/engines/measuredSources.node.test.js:3`）⭐ **合并前另外验了平台侧**（[实测]）：#14 的 `profile.js` 解析盘上 4 张真名片（gpt-sovits / cosyvoice2 / cosyvoice-300m-sft / index-tts）**全部通过且 `defaulted=[]`** ⇒ 放宽必填没有让任何已有名片被平台代填东西；造两张缺项名片验边界：缺 `runtime` 整段 ⇒ 收（`runtime=null`，合法状态）；缺 `capabilities` 整段 ⇒ 收且 `defaulted` 如实报出 3 个键 ⇒ 记进 `profile.defaulted` 的机制是通的 ⛔ **CI 抓不到的那一笔**（本条真正要记的）：`optionalKeys.js` 的 `initialValue` 里 `if (item.kind === 'range') return [3, 10]` ⇒ **点「添加一项 → 参考音频时长（秒）」默认往名片里写 `[3,10]`**，那是某台引擎自己的约束。链路实测：① `addItem` 确实写出 `[3,10]` ② 平台读成 `{"min":3,"max":10}` ③ `lib/services/synthesisService.js:131-135` 拿它在**合成前拦人**（参考音频不在区间内 ⇒ 抛 400）⇒ **一台能吃更长参考音频的引擎，只因用户点了「添加一项」就被平台在合成前拒掉** ⇒ 与 Owner 定的口径冲突（这一项可选、缺着时平台不检查、填了是给使用者的提示）⇒ 改成默认 `null`（不限制）✅ **为什么 CI 抓不到**：既有那条守卫（`requiredZone.node.test.js:115`）只测「加完再删回到原样」，**从没断言 `addItem` 写入的是什么值** ⇒ 补一条守卫钉住写入的值（`null`），变异检查（把起始值改回 `[3,10]`）⇒ 红 ⭐ **守卫**：`test/requiredZone.node.test.js`（8 条）—— 末条「加时长区间时起始值是不限制，不许写死某台引擎的范围」；**变异检查**：起始值改回 `[3,10]` ⇒ 红（断言消息直接点出「等于替这台引擎凭空造了一条约束」）⭐ **全量测试绿**（`npm run test` 3065 条 / 3062 过 / **0 败** / 3 跳过）；`npm run build` 通过；merge-tree 预演 EXIT=0 无冲突 ⚠️ **两条方法上的记录**：① **worktree 里跑不了这两个守卫**（worktree 不带 `node_modules`，`@babel/parser` 取不到 ⇒ 报「拿不到 @babel/parser」）⇒ 判回归必须在**主工作区**跑（主工作区有 `engines/` 与依赖）；往 worktree 挂 `node_modules` 的 junction 要用 `fs.unlinkSync` 摘，⛔ 不许 `rm -rf`（会顺着 junction 删掉主仓库那份）② **`resolveEngineProfile(id)` 收的是引擎 id 不是名片对象**，它自己从 `ENGINES_DIR` 读名片（`lib/paths/engines.js:7` 有 `ENGINES_DIR` 环境变量入口）⇒ 在 worktree 里测盘上真名片要设 `ENGINES_DIR` 指回主仓库 | | |
| **A48** | ⭐⭐ **uv 的包缓存归项目管，不归当前登录的用户：缓存从 `%LOCALAPPDATA%\uv\cache` 挪进项目内的 `cache/uv/`，顺带把硬链接救回来** | ✅ **2026-10-28 已做**· 🔴 `lib/paths/cache.js` · 🔴 `lib/paths/index.js` · 🔴 `tools/deploy/bootstrap.js` · 🔴 `tools/cli/install-torch.js` · 🔴 `tools/engine-wizard/core/envInstall.js` · 🔴 `tools/engine-wizard/test/uvCacheDir.node.test.js`（新） | [读码 + 实跑 2026-10-28] **Owner 的裁决**：「UV 缓存进到自己项目不是才是合理的嘛？这个才符合一般项目的情况，这个不是代价吧，你项目偷偷在别人电脑上面拉屎我觉得更不好，缓存放在项目里面比较合理，缓存肯定是跟平台走的，部署的时候缓存自然就在项目里面了」⭐ **先把三样东西拆开，结论才不会串**（Owner 问「部署的时候，uv 是不是没有跟着平台走」）：① **uv 本体是跟着平台走的** —— `bootstrap.js` 用 `VENV_PY -m pip install --upgrade uv` 把它装进平台根 venv（`venv/Lib/site-packages/uv/`，实测 `venv/Scripts/python.exe -m uv --version` = uv 0.12.1）⇒ **不是「安装 uv 有问题」**；② **缓存没跟着走** —— uv 默认写 `%LOCALAPPDATA%\uv\cache`，那是当前登录用户才看得到的地方，实测本机那一份 **20.2 GB / 96119 个文件**；③ **引擎 venv 里的包是跟着走的**（`engines/<id>/.venv/Lib/site-packages/`）。⇒ **要修的是缓存的归属，不是 uv 的安装** ✅ **改法：缓存路径收进 `lib/paths/cache.js` 做单一真源**（`uvCacheDirFor(root)`），四个调用点都从它取，不各写一遍路径：① **部署**（`bootstrap.js:357`）写 `process.env.UV_CACHE_DIR`，位置在全部 uv 调用点（`:367` / `:403` / `:625`）之前，`runNative` 默认继承 `process.env`（`:162`）⇒ 顺序已验（脚本实测：设置点行号 357，三个 uv 调用点全在其后）② **装 torch**（`install-torch.js:199`）放进传给 spawn 的那个 `env` 对象 ③ **向导装依赖**（`envInstall.js:348`）在 `runOne` 拼环境变量时带上 —— `runOne` 是向导唯一真正跑 uv 的地方（其余 `spawnSync` 都只是探版本、探导入）④ **路径权威** `lib/paths/cache.js` 自己算出 `UV_CACHE_DIR = <项目根>/cache/uv`，并由 `lib/paths/index.js` 导出 ⭐ **缓存放 `cache/uv/` 而不是新建目录**：`cache/` 已经是仓库既有的缓存约定（`lib/paths/cache.js` 的 `CACHE_DIR`，本机 257 MB），且 **`.gitignore:56` 已忽略整个 `cache/`** ⇒ uv 缓存不会进版本库（`git check-ignore -v cache/uv/probe.txt` 实测命中 `.gitignore:56`）⭐ **向导按它自己操作的项目根定位缓存**（`uvCacheDirFor(root)` 传 root，不传脚本自身位置）：向导能对着别的项目根干活，那时缓存要跟着那个根走 ✅ **顺带把硬链接救回来了**：`UV_LINK_MODE` 从写死的 `copy` 改成 `hardlink`（`bootstrap.js` 与 `install-torch.js` 两处原先都写死 `copy`，是为了绕开那个告警）。[实测] 设了 `UV_CACHE_DIR` 后 uv 不再打印「Failed to hardlink files; falling back to full copy」，且装完的文件与缓存里的是**同一个 inode**（`nlink=2`，实测 numpy 的 `_pocketfft_umath.cp314-win_amd64.pyd`：`ino 2251799814701542`，缓存侧 `cache/uv/archive-v0/QD7mpEzLEsalYsbo/numpy/fft/` 下同一 inode）⇒ 硬链接真的成立。**对照实验**：不设 `UV_CACHE_DIR`（C 盘缓存 → D 盘 venv）时**照旧打印那句告警** ⇒ 告警的根因是跨盘（`EXDEV: cross-device link not permitted`），不是 uv 的毛病，缓存挪进项目后与各 venv 同盘，跨盘消失 ⭐ **这一笔同时解决三件事**：① 缓存跟着平台走（换机器部署不会在那边留下几十 GB 残留）② 硬链接恢复 ③ 每台引擎省一份完整拷贝（盘上实测每台引擎 venv 的 site-packages 约 6.3–6.5 GB）⚠️ **代价要说清**：已有的 20.2 GB C 盘缓存**不会自动搬过去**，下次装依赖会重新下一份到项目内（旧的那份仍在原处，未动）；引擎 venv 里的旧包是拷贝不是链接，不受本条影响（运行时装的是真实文件，与 uv 怎么装的无关）⭐ **守卫**：`tools/engine-wizard/test/uvCacheDir.node.test.js`（5 条）—— 权威路径在项目内 / 向导的缓存跟着它操作的项目根走 / 四处调用点都把缓存指向项目内 / **真跑一步安装看子进程实际拿到的环境变量** / 缓存目录不会被 git 收进去。**变异检查五轮全被抓住**：M1 向导还原成不设 `UV_CACHE_DIR` ⇒ 红 2 条；M2 缓存路径改成用户目录 ⇒ 红 3 条；M3 部署与装 torch 两处都删掉 ⇒ 红 1 条；M3a 只删部署 ⇒ 红；M3b 只删装 torch ⇒ 红。⚠️ **第一版守卫只查「文件里有没有出现 UV_CACHE_DIR 这几个字」，结果 M3 没被抓住** —— 因为 require 那行就写着它，把真正赋值的行删掉，字样照样在 ⇒ **改成查赋值的形状**（部署查 `process.env.UV_CACHE_DIR = UV_CACHE_DIR`；装 torch查 `Object.assign` 的 env 对象里有 `UV_CACHE_DIR`；向导查 `env: {` 后面带它）⭐ **全量测试绿**（`npm run test` 3070 条 / 3067 过 / **0 败** / 3 跳过，比改前多 5 条即本组守卫）；`npm run build` 通过；注释纪律与文案语气守卫 6/6 绿 |||
| **A49** | ⭐⭐ **PR #15 审查通过并合入：输出采样率从「引擎配置」里拿掉，也不再记进 `profile.defaulted`（它是声明，平台不读）** | ✅ **2026-10-28 已合入**（PR #15，合并提交 `9cc27abe`，分支 `hark/drop-output-sample-rate` → `research/engine-onboarding-complexity`） | 🔴 `lib/engines/profile.js` · 🔴 `lib/engines/profile.node.test.js` · 🔴 `tools/engine-wizard/editor/optionalKeys.js` · 🔴 `tools/engine-wizard/test/requiredZone.node.test.js` | [读码 + 实跑 2026-10-28] **Owner 的裁决**：「审一下#15」⭐ **PR 的核心主张成立（逐条实测过）**：① **它确实只是声明、平台不读** —— 全仓消费点只有三处：`lib/routes/engines.js:59` 原样转出、`tools/engine-wizard/core/validate.js:156` 只在写了时查值是否为正整数、`lib/audio/wav.js:41` 的注释写明「名片里那个 output_sample_rate 只是声明，实际输出才是事实」；**拼接真按每段 wav 头的实际格式走**（`lib/audio/concat.js:39` 读 wav 头里的实际采样率（读不到才退回 22050） 生成静音）② **它不是平台的硬必填** —— `lib/engines/profile.js` 里 `output_sample_rate` 不在任何 `required()` 调用点（`:250-252` 是 `undefined/null` 时给 `null`，否则才 `positiveInt`），缺着不抛 ③ **缺着时平台没替它定值** ⇒ 记进 `defaulted` 是假的。`defaulted` 的语义写在 `profile.js:106-107`：「界面要能区分『名片写的』和『平台替你填的』」⇒ **平台没填却报成填了，这就是假陈述** ✅ **实测行为（合入后）**：盘上 4 张真名片（gpt-sovits / cosyvoice2 / cosyvoice-300m-sft / index-tts）全部照旧解析且 `defaulted=[]`；造一张缺该键的名片 ⇒ `output_sample_rate=null`、`defaulted=[]`、其余键一条不受影响 ⇒ 与 PR 主张逐字对上 ✅ **旧名片与接口不受影响**：5 张真名片（含 `_TEMPLATE`）本来就都写了这一项（22050 / 24000 / 24000 / 32000 / 22050）⇒ 缺着的名片照样解析；`describeEngine` 实测原样转出（`profile.output_sample_rate=32000` ⇒ 转出那份也是 32000）⭐ **一个容易踩的坑：它与 `reference_clip_seconds` 不是同一类** —— 后者**缺了要报错**（`lib/engines/profile/fields.js:56`：「『忘了写』和『不限制』必须能区分开」⇒ 平台确实替它填了 `null`，记进 `defaulted` 是对的）；前者缺了就是 `null`、平台什么都没填 ⇒ **只有前者该移出 `defaulted`**。这条对比是本条最该记下来的判据 ⭐ **守卫**（PR 自带，两条）：`profile.node.test.js` 的「缺 output_sample_rate ⇒ null 且不算平台默认」、`requiredZone.node.test.js` 的「引擎配置的清单…」（既断言清单里**不含**它，也断言其余项都在）。**变异检查两轮全被抓住**：M1 把该键放回 `optionalKeys.js` 的清单 ⇒ `requiredZone` 红；M2 把 `profile.js` 那行 `defaulted.push` 放回去 ⇒ `profile.node.test.js` 红 ⭐ **全量测试绿**（`npm run test` 3070 条 / 3067 过 / **0 败** / 3 跳过）；`npm run build` 通过；merge-tree 预演 EXIT=0 无冲突（PR base 落后两笔但改的文件与我这两笔零交叠） ||
| **A51** | ⭐⭐⭐ **PR #16 / #17 / #18 三个 PR 手动合入研究分支（向导下载修魔搭/鉴权/路径、测量/超时/本地计时、全站文案去第二人称）** | ✅ **2026-10-29 已合入**（#18 合并提交 `6c6cdb24`，含 #16 `060fbdfe`；#17 合并提交 `55e5aa1c`，分支本地 `pr16-review` / `pr17-review` / `pr18-review` → `research/engine-onboarding-complexity`）· 🔴 `tools/engine-wizard/core/download.js` · 🔴 `core/measure.js` · 🔴 `core/measureJob.js` · 🔴 `core/verify.js` · 🔴 `core/wizardbridge.js` · 🔴 `core/paramsFromReflect.js` · 🔴 `lib/engines/profile.js` · 🔴 `editor/StepsExtra.jsx` · 🔴 `editor/downloadSource.js` · 🔴 `web/**` · 🔴 `docs/**` | [读码 + dry-run 冲突预检 + 实跑全量 2026-10-29] **#16 / #18 是同一功能线的两截**：#18 的 base 就是 #16 的 tip（`d76088d6` 的父 `060fbdfe`），即 #18 严格包含 #16，所以合并时只合 #18 即同时含 #16 ⭐ **#16 / #18 修的三处真 bug（已在 HEAD 上实测过）**：① 界面写魔搭命令却从 HF 扒（`StepsExtra.jsx` 显示 modelscope、`download.js` 工具却写 `hf` 直连 `hf.co`）⇒ 改成 `sourceOf` 按 `c.tool` 决定走 modelscope 还是 hf；② 鉴权失败时只报裸 `401`、没人知道因为啥 ⇒ `gatedResult` 分三层（mc_token / hf_token / 匿名）给明确结论；③ 魔搭 URL 错了（`modelscope.cn` 而非 `modelscope.ai`、路径拼错）且无样本兜底 ⇒ `new URL(...)` 兜底成空、用镜像站修好的 URL ⭐ **测量/超时的修正**：`measure.js` 的 `ready_timeout_ms` 方向反转问题（原值偏小 40s 会误杀，改成偏大 30min 兜底）、`finally` 里 `killTree` 修好；`measureJob.js` 的 `AbortController` 孤儿进程修好；`verify.js` 仍写死 `ROOT`（未修，已知 benign）；`profile.js` 的 `opts.localTimings` 校验修好 ⭐ **#17 经逐笔核实是纯文案/注释清理、无逻辑变动**：8 笔提交全 `docs:` 前缀，非注释非空改动共 106 行，绝大多数是字符串字面量（`t('...')` / Python docstring / 前端去第二人称）改写；`portChoice.js` 那笔 32 行 `++++----` 全是注释措辞；`fe208331` 的 52 行是 Python docstring 改写；`installChoices.js` / `versionOverrides.js` / `torchVersionProbe.js` 等「逻辑文件」是共享祖先 `dab1a8f9` 之前的存量，#17 相对 #16/#18 没有新功能 ⚠️ **合并冲突只有一处**：`paramsFromReflect.js` —— #18 把 `ROOT` 改成 `engineRoot(b.id)`（按引擎 id 找 checkout，不钉死本 checkout），#17 只动了同文件的字符串文案；git 因上下文重叠报冲突，解时**取 #18 侧**（#17 的文案改动在文件其他位置已自动合并），解后 `node --check` 通过、两边改动都在 ⭐ **回归验证**：dry-run 两步合并均无 CONFLICT（除已知那一处）；合并后在独立 worktree（npm ci、零 junction）实跑全量 **3123 条 / 3096 过 / 15 败 / 12 跳过**，15 败全部是 worktree 缺 venv / 无 GPU / 缺 engines 权重的环境缺失（`uv was not found`、CUDA/ROCm 探测类），**没有任何一条逻辑回归**；相对基线 worktree 失败清单集合一致（同属环境缺失） | 
| **A52** | ⭐⭐⭐ **PR #20 手动合入研究分支（第4步进门不先报错＋名片补「模型权重」必填格）** | ✅ **2026-10-29 已合入**（合并提交 `087a4e11`，分支本地 `hark/manifest-weights-ux` → `research/engine-onboarding-complexity`）· 🔴 `lib/engines/hostProfile.js` · 🔴 `tools/engine-wizard/core/validate.js` · 🔴 `editor/EngineIdentity.jsx` · 🔴 `editor/ManifestForm.jsx` · 🔴 `editor/RequiredFields.jsx` · 🔴 `editor/weightsField.js`（新）· 🔴 `test/manifestWeights.node.test.js`（新） | [读码 + dry-run 冲突预检 + 实跑全量 2026-10-29] **#20 相对 research 有两处冲突，都已手动解**：① `hostProfile.js` —— 保留 #20 的 `weightsProblem` 调用逻辑（在 `parseCall` 里查权重有没有交到引擎手里）＋ 用 HEAD 更简洁的 seed 注释；② `ManifestForm.jsx` —— 取 HEAD 的短注释块 ＋ 把必填「5 格」改成「6 格」（#20 加了一个权重必填格）⭐ **#20 修的真问题**：① 进门不先报错 —— `EngineIdentity.jsx` 保存按钮从「有错就 disabled」改为「照点，点了不存只列问题」，进门时名片空的必然报缺但不在进门时先列一片红；② 名片补「模型权重」必填格（`RequiredFields.jsx` ＋ 新 `weightsField.js`）—— `hostProfile.js` 新增 `weightsProblem(manifest)` 判缺：没 `runtime.checkpoints` 就不要求（进门不先报错），但写了 checkpoints 就必须在 call 里交出去（python 要在 `init_args` 里有一项含 `{checkpoints}`，cli 要在 `argv` 里有一词含 `{checkpoints}`，否则报错），否则合成时引擎读默认路径可能联网拉或读错模型；③ `validate.js` 把 `weightsProblem` 接入向导诊断（仅 `needsBind` 时查，自带服务脚本的引擎不查）⭐ **回归验证**：合并后在主仓库实跑全量 **3130 条 / 3122 过 / 1 败 / 7 跳过**，唯一失败是 `buildSpec` 的 venv 环境缺失类（worktree 没装 venv），**零逻辑回归**；新守卫 `manifestWeights.node.test.js`（82 行）全过 |
| **A50** | ⭐⭐ **「引擎配置」里「参考音频时长」那一行补一句「为什么值得填」，用小一号暗一点的字体（平台的 `.field-note`）** | ✅ **2026-10-28 已做** | 🔴 `tools/engine-wizard/editor/optionalKeys.js` · 🔴 `tools/engine-wizard/editor/OptionalConfig.jsx` · 🔴 `tools/engine-wizard/test/optionalNote.node.test.js`（新） | [读码 + 实跑 + 真浏览器 2026-10-28] **Owner 的裁决**：「可以，这个文案用小一号的暗一点的字体就可以了。也不和现有改动冲突，然后#13已经关了，不管他的实现了。」⭐ **为什么这一行值得写这句**：这一项缺着时平台不拦，填了才拦（`lib/services/synthesisService.js:131-137` 只在 clip 存在时才量 wav 时长），而界面上原来只写「不限制」⇒ 使用者不知道填了会挡住什么、为什么该填。写的是三件每个使用者都能自己判断的事：参考音频越长，特征提取越慢、内存占用越高、首字节延迟越高 ✅ **小一号暗一点的字体怎么落地**：复用平台既有的 `.field-note`（`web/src/styles.css:143-149`：`font-size: var(--fs-11)` + `color: var(--muted)` + `opacity: 0.8` + 斜体）⇒ 比同行的控件（13px）小一号、比 `.field-hint` 还弱一层。**不自造类**：向导 `editor/index.jsx:5` 已 import `web/src/styles.css`，自造一套字号颜色会与平台的字号标度脱钩；平台字号标度的下限是 11px（`web/src/styles.css:28-30`：「更小的中文在暗色底上要靠猜」，`tools/engine-wizard/test/fontScale.node.test.js:25-41` 守这个下限）⇒ 11px 是能选到的最小一号。`.field-note` 是平台已有类、全项目 6 处以上在用 ⇒ **与现有改动零冲突**（这是 Owner 点名的前提，实测确认）⭐ **实测过的两件事**：① **真浏览器里看到的是新代码** —— 旧的后台 vite 进程服务的是另一个 worktree 的旧代码（指纹 curl 拿不到 `field-note`），杀掉重起后 `curl http://127.0.0.1:5199/OptionalConfig.jsx` 命中 `className: "field-note"`、`/optionalKeys.js` 命中新文案、`/@fs/.../web/src/styles.css` 命中 `.field-note` 的 `--fs-11` 与 `opacity: 0.8` ② **文案守契约** —— 无符号语气、无破折号、无口语、无第二人称「你」⭐ **守卫**（`tools/engine-wizard/test/optionalNote.node.test.js`，4 条）：① 时长区间那一项带 noteEn / noteZh 两份文案，中文说清「越长越慢」这个方向，且三个要点（特征提取 / 内存 / 首字节）都在 ② 提示用平台的 `.field-note` 不自造类（既查 JSX 里的 className，也查平台 CSS 里那条规则真的有 `--fs-11` 与 `opacity: 0.8`）③ 文案里不许出现内部原则与口语，不许第二人称「你」④ 变异检查自证三条判据能各自判红。**变异检查五轮全被抓住**（自己跑脚本，不靠子 Agent 自述）：M1 去掉 noteEn / noteZh ⇒ 红 2 条；M2 类名换成自造的 `wz-opt-note` ⇒ 红 1 条；M3 方向说反（越短越慢）⇒ 红 1 条；M4 提示掉「内存占用」那个要点 ⇒ 红 1 条；M5 文案里塞进第二人称「你」⇒ 红 1 条；恢复后基线绿。⚠️ **方向必须单独判**：M3 那句反方向的话仍然含「特征提取 / 内存 / 首字节」三个词 ⇒ 只查词会放过它，所以判据要查「越长」与「越慢」同时出现 ⭐ **全量测试绿**（`npm run test` 3074 条 / 3071 过 / **0 败** / 3 跳过，比 A49 多 4 条即本组守卫）；`npm run build` 通过（`dist/assets/index-DaWs_Qxe.js` 568.26 kB） ||
| **A38** | ⭐⭐⭐ **第 4 步的页面骨架做成了三根平级的骨头：左边条 32px、中栏占满、右边条 32px（Owner 验收不通过后重做）** | ✅ **2026-10-25 已做**（`0c40bff1` `3e6ac486` `61f97b53`）· 🔴 `editor/Stage.jsx`（新）· `editor/ThreeZone.jsx`（已删）· `editor/ManifestPage.jsx` · `editor/App.jsx` · `editor/editor.css` · `test/threeZone.node.test.js` · `test/manifestLayout.node.test.js` | [读码 + 真浏览器实测 2026-10-25] Owner 验收 A37 时给的判词：「拿一个带紫色描边的巨型棺材盒把左中右三栏硬塞进去供起来」「左、中、右是页面的三根骨头，根本不在同一个大容器里」。⇒ 问题不在「栏头长什么样」，在**容器层级**：① 第 4 步整页套在平台的 `.node-detail` 里（`web/src/styles.css:1107-1113`，`border: 1px solid var(--accent)` + 圆角 + 底色）② 三栏是同一个 grid 里的三格 ③ 左右两栏默认全展开，空状态盒子各占 200px / 380px 摆在首屏上 ④ 中栏只剩 690px，长路径要换行 | ✅ **四处一起改**：① **第 4 步在 `App.jsx` 里单独一支**，不进 `.node-detail`（`.node-detail` 那一支的条件改成 `page && page !== 'manifest'`）② **新组件 `editor/Stage.jsx`**：`<aside>` + `<main>` + `<aside>` 三根平级的骨头，外层只有一个 flex 行，**没有任何边框、圆角、底色**；`editor/ThreeZone.jsx` 删除（那套 grid 三列 + 40px 窄轨退役）③ **左右边条默认收成 32px**，只露 `→` 与 `←`；点一下滑出成 360px 抽屉（`transition: width 160ms`），再点箭头（或点 ×）就收回；**收着时内容完全不渲染**（省掉两个空状态盒子）④ **中栏 `flex: 1` 撑满剩余宽度**，内容居中（`.wz-stage-main-inner`）；窄屏（960px 以下）抽屉收窄到 280px，但仍然推开中栏，不浮在上面 ⚠️ **合入 PR #11 后这两处变了**（当时记的 `max-width: 960px` 现在是 **1400px**；窄屏「推开」这条仍然成立） ⚠️ **三个真 bug 是实测逼出来的，不是想出来的**：**遮罩盖住抽屉** —— 遮罩是 `position: fixed` 的固定层，边条是 `static` 的，fixed 层会盖住没有 z-index 的 static 元素 ⇒ 抽屉看着开着，里面的「Scan parameters」按钮点到的却是遮罩，一点抽屉就收回去，**扫描按钮永远点不动**（直接调 discover 端点是好的，35 个参数 ⇒ 是前端点不到，不是后端坏了）。改法：边条 `position: relative` + `z-index: 10`。**遮罩盖住中栏** —— 遮罩的作用是盖住中栏、点它就收抽屉，但第 4 步这三样东西是同时用着的（左边扫参、中间填表、右边看预览）⇒ 一打开抽屉，表单就点不动了，参数也没法真的拖到中栏。Owner 裁决「去掉这条逻辑」⇒ **遮罩整个删掉**：中栏照常可点，点中栏不收抽屉，抽屉只由箭头与 × 控制；窄屏降级也从 `position: absolute`（浮在上面盖住中栏一半）改成只把抽屉收窄到 280px、仍然推开中栏 ⭐ **实测**（CDP 9334 真浏览器，1440×900）：① 默认态量得 **32px / 1312px / 32px**（⚠️ 此数字为 #11 合入**前**的值，合入后是 32/1336/32），两箭头是 `→` 与 `←`，**边条内容不渲染、无遮罩、零个带边框的祖先**（紫框真的没了）、**零个可见的空状态盒子**；中栏内容区 960px 居中，长文本无一被裁切 ② 左抽屉开 ⇒ **360px / 984px / 32px**（合入 #11 后是 360/1038/32），**无遮罩**，空状态只在抽屉里，中栏照常能点 ③ 右抽屉开 ⇒ **32px / 984px / 360px**（合入 #11 后是 32/1038/360） ④ 页面异常 0（唯一的 console 错误来自浏览器扩展，与本项目无关）⑤ **拖拽端到端**：选引擎 → 开左抽屉 → 点扫描真扫出 **35 个参数** → 拖一个 `--model_dir` 进中栏落点 ⇒ 切 JSON 视图看到 `parameters: [{name: model_dir, type: text, tier: common, help: …}]`，名片真写进去了 ⚠️ **守卫**（`test/manifestLayout.node.test.js`，13 条）：骨架层不许有 border / border-radius / background（不许套娃）；**不许有遮罩**（遮罩会挡住中栏，点中栏还会收抽屉）；第 4 步那一支不许混进 `.node-detail`；`ThreeZone.jsx` 不许复活。`test/threeZone.node.test.js`（`Stage` 版）：三根骨头是平级的 `aside`/`main`、默认两边收着、点箭头开合、**点中栏不收抽屉**、箭头是 `→`/`←` 不是 `<`/`>` ⚠️ **一个测试手段的坑**：`transition: width 160ms` ⇒ 量宽度必须等过渡走完，否则量到的是起始值（我第一版脚本量出「展开后还是 32px」，差点当成 CSS 没生效）⭐ **修掉遮罩后的真浏览器复验**（CDP 9334，1440×900）：① 抽屉开着时 `scrim` 不存在；中栏中心那个点的**命中测试**（`elementFromPoint`）落在 `.section-hdr`（在中栏里），不是遮罩 ② 中栏里的 select 命中测试落在 `select.control` 上，直接可点 ③ **真打字进去**：`value` 变成 `"abc"`、`focused` 为真，**而且抽屉还开着**（宽度仍是 360px）④ 点中栏空白处：抽屉没收起 ⑤ 抽屉开着时拖拽仍通：落点的命中测试落在 `.field-hint`（在落点区内），拖一个 `--model_dir` 进中栏 ⇒ 名片里 `parameters[]` 真有了 `model_dir` ⭐ **命中测试比「派发事件」更能照出真相**：上一版的拖拽测试直接调 React props 上的 handler，绕过了浏览器的命中测试，所以遮罩盖住中栏这件事它照不出来 ⇒ 那条测试当时是绿的，界面却是坏的 | |

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

| **A53** | ⭐⭐ **PR #19 手动合入研究分支（前端文案规范化：去口语、消歧义、术语统一，向导与主应用全量通读中英文一致）** | ✅ **2026-10-29 已合入**（合并提交 `4299da01`，分支本地 `audit/wizard-ui-copy` → `research/engine-onboarding-complexity`）· 🔴 `web/src/**`（52 文件） | [读码 + dry-run 冲突预检 + GitHub 自动标 merged 2026-10-29] **纯文案层，+166/-166 字符串字面量替换，无逻辑改动**：去口语动词、去歧义指代、术语统一、中英文一致；英文 UI 文案去除第一/二人称（`I/you` → 无主语或 `the`）、`Expert → Advanced Parameters`、`Got it → Understood`、省略号统一全角、第三人称/被动语态。⚠️ **笔误已修**：PR 原版 `NodeDetailPanel.jsx` 里 `<strong>keep</strong> <strong>keep</strong>` 重复；Owner 在最后一提交 `1392b9fa` 修掉 ⇒ 合入时 diff 已是单个 `keep`。⭐ **回归验证**：合并无冲突（merge-tree dry-run `ea72445f`）；PR base 与研究分支 HEAD 同源（`b150425a`），52 文件全文案替换。GitHub 自动标 merged（state=MERGED），无需 `gh pr close`。 |
| **A54** | ⭐⭐⭐ **运行设备参数全链路：名片声明「这一格是运行设备」→ 扫描自动打标 → 界面可填 → 合成页选卡 → 下发前换算成引擎认的写法** | ✅ **2026-11-03 已做**（`d23519c1`，随 `ce20d64f` 合入 dev）· 🔴 `lib/engines/deviceValue.js`（新）· 🔴 `lib/engines/gpus.js`（新）· 🔴 `lib/engines/hostProfile.js` · 🔴 `lib/routes/system.js`（`GET /api/devices`）· 🔴 `lib/routes/synthesis.js` · 🔴 `web/src/components/common/DeviceSelect.jsx`（新）· 🔴 `web/src/components/generate/GenerateTab.jsx` · 🔴 `tools/engine-wizard/editor/StepVerify.jsx`（第 5 步）· 🔴 `tools/engine-wizard/editor/OptionalConfig.jsx`（第 4 步）· 🔴 `tools/engine-wizard/core/wizardbridge.js`（`device_options`）· 🔴 `test/deviceValue.node.test.js`（新） | [实测 2026-11-03] **名片只承载语义、不承载具体卡**（Owner 裁决）：`call.args.<name>` 白名单加 `role` / `device_format`，`role:"device"` 标记「这一格是运行设备」，`device_format` 为 `torch`（`cuda`/`cuda:1`/`mps`/`xpu`）或 `index`（`0`/`1`，Spark-TTS 的 `type=int`）；GPU 0/1 这些**不进名片**，由 `lib/engines/gpus.js` 运行时探测（`nvidia-smi -L` 保留 CUDA 编号；WMI 用 `AdapterCompatibility` 判厂商；`sameGpuName()` 归一化去重，同一块卡两来源写法不同不重复列）。**三台引擎 device 语义实测不同**：IndexTTS2 要 torch 字符串、Spark-TTS 要 CUDA 编号整数、fish 无此参数、gpt-sovits 走 HTTP 无此键 ⇒ 平台不统一具体值，界面统一按设备名呈现（`GPU 0: NVIDIA …` / `GPU 1: Intel Arc …` 连续编号，独显核显并列，NVIDIA 界面序号与 CUDA 编号错位时标注），落盘前 `resolveDeviceArgs` 换算。⭐ **两个静默失败被堵**：① 选核显时编号引擎返回 `null`（不传），不再静默用 `0` 跑独显；② **死参数守卫**——`call.args` 里的参数若既不在 `params.call_time`/`load_time`、开关又没进 `call.argv`、也不被 `bind` 引用，读名片时当场喊（实测 spark-tts 有 9 个 args 而 `call_time` 为空，`--device` 传不进引擎，host 侧 `call_params` 按白名单过滤后静默丢弃）⇒ 补白名单 + 校验 + 测试。`auto` 档一律不传参，让引擎用默认。扫描按名字词表（`device`/`devices`/`gpu`/`run_device`）自动打标，`--accelerator` 之类不猜。**两处下拉**（合成页 + 第 5 步校验页）共用 `DeviceSelect`，各自取值不共享存储（Owner 裁决：隔离开就行）。⚠️ 未做：`host._guess_device()` 仍只用于 `/health` 展示，与传给引擎的 `--device` 无联动（已知，不算断点）。守卫 + 回归 0 失败（含 deviceValue 17 条、hostProfileCli 死参数 3 条） |
| **A55** | ⭐⭐⭐ **推理入口嗅探接通：README 优先 + 四类打分回退，识别结果真正写进名片 argv** | ✅ **2026-11-03 已做**（`93ad21a5`，随 `ce20d64f` 合入 dev）· 🔴 `tools/engine-wizard/core/readmeEntry.js`（新）· 🔴 `tools/engine-wizard/core/entryPick.js`（新，四类打分）· 🔴 `tools/engine-wizard/editor/scanAutofill.js` · 🔴 `tools/engine-wizard/core/wizardbridge.js`（discover 返回 `entry`）· 🔴 `tools/engine-wizard/editor/ManifestPage.jsx`（notes 渲染）· 🔴 `tools/engine-wizard/editor/EngineIdentity.jsx`（切引擎读盘）· 🔴 `test/readmeEntry.node.test.js`（新）· 🔴 `test/computeAutoFill.node.test.js` | [实测 2026-11-03，spark-tts 端到端] **两层判据**（Owner 定的顺序）：① README 里作者自己写的 `python -m 模块` / `python 脚本.py`——**只认扫描结果里也出现过的文件**（README 常同时写 webui/训练/下载，光看名字分不清哪个是推理）；② 嗅不到回退四类打分：文本 + 参考音频 + 输出落点 + 模型，四类齐全才 high，前两名证据相同时 `ambiguous:true` 要人点选而非按字典序偷挑。位置参数（`add_argument("text")`）不兼容——不是「不规范」，是平台按名字绑槽位、位置参数无名可依（Owner 定性：更像 ABI 不像 CLI）。⭐ **接通后的实测**（真浏览器 CDP）：spark-tts 的 `cli.inference` 由 README 嗅出（`source: readme`），`_MODULE_` 占位符被替换成模块名、子命令只在后面空着时补、已写具体模块名的不改写、`cwd` 落到引擎目录；界面黄区显示「Entry point: cli/inference.py (from the README).」+ 同名冲突提示。⛔ **验证方法有坑，记档**：磁盘名片 argv 本来就写着 `cli.inference`，直接看 argv 是假阳性——真验证要先在 JSON 视图改回 `_MODULE_` 再扫描保存。⛔ **顺带修掉一个污染 bug**：args 填充原先收全部扫到的开关，一次保存把 spark-tts 的 `call.args` 从 9 个污染到 ~45 个（量化/server/benchmark 脚本的旋钮全进来）⇒ 认出入口后只收 `entry.file` 那个文件的开关（扫不出入口时不过滤，保持旧行为）。**切引擎读盘修复**（连带）：`pickEngine` 原先直接造空壳不读磁盘名片，第四步所有格子全空 ⇒ 先 `loadOne(id)` 读盘。测试 computeAutoFill 42 条（entry 消费 4 条 + args 收口 2 条）+ readmeEntry 7 条，回归 0 失败 |
| **A56** | ⭐⭐ **第 4 步收尾：输出格拆「路径 + 文件/目录」双控件（自动识别 + 逃生口）、save_dir 黄字提示、引擎配置折叠、运行设备格嵌进配置区** | ✅ **2026-11-03 已做**（`93ad21a5` 同批，随 `ce20d64f` 合入 dev）· 🔴 `tools/engine-wizard/editor/RequiredFields.jsx` · 🔴 `tools/engine-wizard/editor/OptionalConfig.jsx` · 🔴 `lib/engines/hostProfile.js`（`returns` 白名单加 `dir`） | [实测 2026-11-03] **输出形态**：落点开关名以 `_dir`/`_directory` 结尾判「目录」（引擎自己起文件名），其余判「文件」；**名字判据不可靠，下拉是逃生口**，最终以用户选的为准。切 file/dir 两列 grid 钉死宽度（`1fr 120px`），实测切换时输入框 x/宽/下一格 y 一个像素不动（此前 `slotNeeded` 在 `dir` 时把输出格禁用换提示，多一行把下面推下 20px，已改 `bytes`/`generator` 才免输出槽位；`hostProfile` 的 `returns` 白名单缺 `dir` 会拒存，已补）。**save_dir 提示**（黄字，Owner 定稿口径）：「本项目默认 save_dir 是训练产出的权重落点，output 与 output_dir 才是推理输出。也有引擎不这样（Spark-TTS 用 save_dir 作输出目录），故此处按参数名判断。」——不写「通常/一般来说」，只声明本项目默认；术语「检查点」全仓统一改「权重」（`modelState.js`/`fileOps.js` 两处一并）。**引擎配置折叠**：默认收起（`▸ Engine settings 10 · all left at defaults`），运行设备格按 TEXT TO SYNTHESIZE 同款「label + 输入框」放在合成参数与引擎配置之间、不跟着折叠；填值即写 `call.argv` 的 `--device <值>`，留空不出现，永远可填（无 `role` 声明时填值即声明）。⚠️ `host.py` 的 `returns:"dir"` 读回逻辑（`_newest_output_in`）**未搬**：选目录只记进名片，真跑时宿主仍按文件路径找产物 ⇒ 挂在此处等 host 侧补（下一批） |
| **A57** | ⭐⭐ **参考文本的声明进名片的运行参数行：与运行设备同排（一行多列），声明「参考文本由哪个开关收」（`call.bind.ref_text`）；顺带修掉手工参考文本被切片自动值静默覆盖** | ✅ **2026-11-04 已做**（`7d06d7c0` + `1b7fdf92`，随 `c6bf9f4b` 合入 dev）· 🔴 `tools/engine-wizard/editor/OptionalConfig.jsx`（运行参数行）· 🔴 `tools/engine-wizard/editor/RequiredFields.jsx`（ref_text 格移出）· 🔴 `lib/server/synthesis.js`（优先级）· 🔴 `lib/server/synthesisRefText.node.test.js`（新）· 🔴 `test/requiredZone.node.test.js` | [实测 2026-11-04] **Owner 定调**：reference text（参考音频的文字，平台特殊语义——请求里默认从音色卡切片自动取、也允许手工改）要「名片上面有一个声明参考文本的字段」，位置与运行设备同一行（一行多列多参数）。侦察结论（链路）：名片 `call.bind.ref_text`（哪个开关收参考文本）→ 请求体 `reference_text`（9886 合成页已在送：音色卡自动值或 VoiceSidebar 覆盖）→ `generateService` → `resolveReference` → host 按 `bind.ref_text` 展开引擎开关（如 `--prompt_text`）；`/v1/audio/speech`（OpenAI 路径）只从音色卡取、body 不收（设计如此）⇒ 9886 侧无需改动。⭐ **落法**：运行参数行改一行多列（`form-grid`）：RUNTIME DEVICE（值入 argv）| REFERENCE TEXT（声明 `call.bind.ref_text`，清空即删）；声明从必填区的可选格**挪**到该行（同一份 bind 数据只留一个编辑口，SLOT_LABELS 保留四项以过 bindSlots 守卫的「fallback 逐字等于 BIND_SLOTS」，渲染 filter 掉 ref_text）。⛔ **修掉一个静默覆盖**：`resolveReference` 在「没带参考音频→自动取第一条切片」分支里切片文本**无条件覆盖**请求手工值（填了没效果、不报错）⇒ 改为手工值优先（`if (!refText && seg.reference_text)`），切片文本只作缺省；4 条新测试（require.cache 桩 `firstRefAudio`），变异自证（旧逻辑判红）。⚠️ **过程记档**：首版把参考文本输入误加到 9886 合成页（用户要的是名片上的声明字段），已撤；变异检查还原误用 `git checkout --` 把未提交修复一并回滚，改用编辑回补。实测截图：RUNTIME DEVICE 与 REFERENCE TEXT 同排（y 同 x 异），spark-tts 名片的 `--prompt_text` 自动显示。合并点 41 条 0 fail | |
| **A58** | ⭐⭐⭐ **补全可选能力：音频类输入 / 多权重位 / 输出格式由名片驱动，前端「没填就不长控件」；扫描侧只给保守嗅探建议** | ✅ **2026-11-04 已做**（`ff970458`，`feat/platform-declared-inputs`，**未合 dev**）· 🔴 `lib/engines/declaredInputs.js`（新）· 🔴 `lib/engines/hostProfile.js` · 🔴 `lib/routes/engines.js` · 🔴 `lib/services/synthesisService.js` · 🔴 `tools/engine-wizard/core/declareHints.js`（新）· 🔴 `tools/engine-wizard/core/wizardbridge.js` · 🔴 `tools/engine-wizard/editor/ManifestPage.jsx` / `scanAutofill.js` · 🔴 `web/src/components/generate/GenerateTab.jsx` / `AdvancedParamsPanel.jsx` | [读码 2026-11-04] **判据**：`call.args.*.role=audio_ref` 声明平台上已有的音频输入语义，`weights[]` / `output_formats[]` 决定合成页长几个下拉；`declaredInputs()` 是名单与透传的单一真源，没填的名字既不长控件、不发请求、也不进 argv。辅助音频只透传 `--<开关> <路径>`，平台不解释上游叫什么语义；输出格式决定「要 mp3」该不该 400，且不再把 `wav` 写死在前端。**嗅探保守词表**（`declareHints.js`）：音频前缀、argparse 的 `choices`、同一文件里两个以上角色型权重开关；拿不准的一律不猜。⚠ 权重位嗅探不收任何上游专有名字，专用位在第 4 步手工添加 | |
| **A59** | ⭐⭐ **第 4 步五类可选能力收进同一区「可选能力」，默认展开（重要但非必填）；区名统一，引擎配置仍默认收起** | ✅ **2026-11-04 已做**（本批，`feat/platform-declared-inputs`）· 🔴 `tools/engine-wizard/editor/OptionalCapabilities.jsx`（由 `PlatformDeclarations.jsx` 改名）· 🔴 `tools/engine-wizard/editor/OptionalConfig.jsx` · 🔴 `tools/engine-wizard/test/optionalCapabilitiesWiring.node.test.js`（改名）· 🔴 `tools/engine-wizard/test/requiredZone.node.test.js` · 🔴 `tools/engine-wizard/core/declareHints.js` · 🔴 `docs/ONBOARDING_PLAN.md` | [实测 2026-11-04] **Owner 定调**：不要叫「平台声明」，运行设备与参考文本也属于同一组字段，统一换名并收纳到一起，默认展开（重要但非必填）。**落法**：五类（运行设备 / 参考文本 / 音频输入 / 多权重位 / 输出格式）同住一个可折叠区，标题 `可选能力 / Optional capabilities`，`useState(true)` 默认展开；下方「引擎配置」仍 `useState(false)` 默认收起。运行设备与参考文本保持同排 `form-grid`，值写入与编辑口一并搬到新组件，全部改函数式更新，避免同一次提交里被别的区盖掉。**顺带修掉本分支原本就红的一条守卫**：`declareHints.js` 的权重词表里写了具体引擎名，违反「向导活代码不许出现任何具体引擎名」⇒ 前缀改为通用架构词，测试 fixture 同步换名。真浏览器复核（5199，中英各一遍）：中文标题「可选能力 / 重要但非必填」、▾ 展开、点标题可折叠再展开、运行设备填 `cuda:1` 后名片 JSON 的 `call.argv` 出现 `--device cuda:1` | |
| **A60** | ⭐⭐⭐ **名片口径纠偏：可选能力填的是「参数从 CLI 哪个开关进去」，不是运行时的取值；输出格式接通透传** | ✅ **2026-11-04 已做**（本批，`feat/platform-declared-inputs`）· 🔴 `tools/engine-wizard/editor/OptionalCapabilities.jsx` · 🔴 `lib/engines/hostProfile.js` / `declaredInputs.js` · 🔴 `lib/services/synthesisService.js` · 🔴 `web/src/components/generate/GenerateTab.jsx` / `AdvancedParamsPanel.jsx` · 🔴 `tools/engine-wizard/core/declareHints.js` / `wizardbridge.js` · 🔴 `tools/engine-wizard/editor/scanAutofill.js` | [读码 + 实测 2026-11-04] **Owner 纠偏**：名片要填的是能力声明，即「用 CLI 调用这个能力时，参数到底输在哪个开关上」；`wav`、`GPU0` 这类是运行时值，归前端下拉，不进名片。对账五格发现**两格填反**：运行设备原来把 `cuda:1` 写进 `call.argv`（等于名片存了用哪块卡，与 A54「名片不承载具体卡」相悖），输出格式原来填 `wav, mp3`（那是能力白名单，不是开关）。⭐ **改法**：两格统一填开关名 —— 运行设备写 `call.args.<name>.flag`（默认 `--device`），输出格式写 `call.args.<name> = { flag:'--format', style:'value', role:'output_format' }`；声明同时把名字写进 `params.call_time`，否则 host 静默丢值、死参数守卫也会拒。**接通透传**：前端按声明的参数名发 `format_input` → `synthesisService` 用 `resolveFormatArg` 白名单过滤后并进 `cfg.engine_params` → `assembleEnginePayload` → host 按 `call_time` 收 → `_synthesize_cli` 展开成 `--format mp3`。`output_formats` 保留为**能力白名单**（宿主那道 400 判据 + 前端下拉选项），由扫描该开关的 argparse `choices` 自动派生（`formatArgNameFrom` / `formatHintsFrom` 同源），手动声明时默认 `['wav']`，不再当这一格的主输入。⚠ **已知边界**：`synthesisService` 仍按 WAV 收产物，引擎若真按 `--format` 吐出非 WAV 容器，9886 这条链路的字节处理与转码归上层，尚未适配；OpenAI 端点的 `response_format` + ffmpeg 是另一套，未动。实测（5199 真浏览器）：运行设备 `--device`、输出格式开关 `--format`、允许值 `wav`；名片 JSON 里 `call.args.format.role=output_format`、`params.call_time:['format']`，且不再有 `call.argv` 里的设备值。相关守卫 212 条 0 fail | |
| **A61** | ⭐⭐⭐ **多权重位：一位一个框、框内四参数一行、加减就地增删；写 `weights` 时四处接线一起写** | ✅ **2026-11-05 已做**（`d9b4a5f9`，随 dev `49223306`）· 🔴 `tools/engine-wizard/editor/OptionalCapabilities.jsx` · 🔴 `tools/engine-wizard/editor/weightSlots.js`（新）· 🔴 `lib/engines/profile.js` · 🔴 `lib/services/synthesisService.js` · 🔴 `test/weightSlotWiring.node.test.js`（新）/ `test/optionalCapabilitiesRender.node.test.js`（新） | [实测 2026-11-05] **编号从 2 起**：第 1 位是必填区的「模型权重」（开进程时载入的那一份，平台只送得进一个目录，`MAX_LAUNCH_SLOTS=1`）；本区声明的是合成时按位换的那几份（`call` 位，个数不限）。**形态**：一位一个框，框标题「第N权重位」，框内四个参数并排一行（位名 / 显示名 / 参数名 / 生效时机），框右侧竖排 `+` 与 `−`（加在上、减在下），**只剩一位时 `−` 置灰**（再减连行都没有）；位名留空的行不进名片（位名即磁盘目录名 `assets/<音色>/models/<引擎 id>/<位名>/`），所以空行等于没声明，但误点加号仍能靠减号收回。一位都没有时区尾只留一个「加一位权重位」，与「添加输出格式」并排；已有位时区尾不重复入口。**接线**：写 `weights` 的同时写 `param_keys`（词汇表，不在表上装不上）、`payload_keys`（请求体透传）、`params.call_time`（宿主白名单）、`call.args[参数名].flag`（CLI 开关形状），删位时四处一起收走；漏任一处的结果都是「下拉能选、引擎没收到」，而且一处都不报错。**平台两处**：`profile.js` 把权重位指向的参数从 `param_schema` 里滤掉（下拉与参数面板不能两个编辑口，面板那格永远被盖掉却看着像生效）；`synthesisService.js` 把 `call` 位选中的那一份按名片参数名搬进 `cfg`（此前只有 GSV 的 `switchModels` 与硬编码 cfg 键能到）。⚠ **边界不变**：多个 `launch` 位仍被 `ENGINE_TOO_MANY_LAUNCH_SLOTS` 拦；FishAudio 那类三份构造期权重走 `call` 位（每位一个 `--weightN`），不走三个 launch 位 | |
| **A62** | ⭐⭐⭐ **留空（含只敲空格）即视为不具备该能力；`call.bind.text` 不再硬必填；未声明的格灰显** | ✅ **2026-11-05 已做**（`d9b4a5f9`）· 🔴 `tools/engine-wizard/editor/RequiredFields.jsx` / `OptionalCapabilities.jsx` / `editor.css` · 🔴 `tools/engine-wizard/core/validate.js` · 🔴 `lib/engines/host.py` / `hostProfile.js` · 🔴 `test/requiredZone` / `validateRequired` / `optionalCapabilitiesRender` / `hostRefText` / `hostProfile` | [实测 2026-11-05] **Owner 定的兼容哲学**：名片只做两件事，声明引擎能力、把能力接到 9886 的对应控件；只容纳 `--argv` 形式（填 `--reference_text`、`--device` 这类开关名，不填变量名）；不填就是不具备该能力，前端控件消失、命令上也不出这个参数。**写侧**：bind 槽位、运行设备、音频输入、输出格式、参考文本全部 `trim()` 后判空才删键（原来只认空串），输出格式清空时连 `output_formats` 一起收走，设备格不再用 `value` 显示 `--device`（改 placeholder，免得「看着填了其实没声明」）。**宿主三层兜底**：`call.argv` 的空白词丢弃、bind 槽位空白跳过、`_render_cli_arg` 遇空白开关名返回空数组，绝不把空白词放进命令行。**`text` 放宽**：`hostProfile.js` 删掉硬必填；`host.py` 方法级 `requires_text` 默认改为「这张名片绑没绑 text」，只有显式写 `true` 才当矛盾；请求校验同口径；向导必填从 5 项降为 4 项（`ref_audio` / `output_path` / `runtime.python` / `runtime.entry`）。**保留两条**：`ref_audio` 跟 `capabilities.requires_reference_audio` 走、`output_path` 跟 `returns: "file"` 走，那两条是「声明与接线互相矛盾」，不是能力开关。**灰显**：`.wz-unset` 透明度 0.55、聚焦恢复，覆盖必填区 bind 格与可选能力四格；必填区栏头加一句「多数零样本 TTS 引擎都需要下列输入。某项留空即表示这台引擎不具备该能力：平台不为其生成控件，也不下发该参数。」 | |
| **A63** | ⭐⭐ **合入 dev 收尾：先修掉 dev 上原本就红的三类（Stage 接口、文案守卫、换引擎夹具）** | ✅ **2026-11-05 已做**（`d147acd6` / `908bbcec` / `b4f18039` / `49223306`）· 🔴 `test/threeZone.node.test.js` · 🔴 `test/engineSwitch.node.test.js` · 🔴 `editor/ManifestPage.jsx` / `OptionalCapabilities.jsx`（注释） | [实测 2026-11-05] merge `origin/dev` 无冲突（`ManifestPage.jsx`、`editor.css` 自动合并），dev `215b19ec → 49223306`，CI 双绿（run `41889367031`，ubuntu + windows 均 success）。三类既有红：#42 把全屏交给父层持有（`Stage` 新增 `full` / `onFull`），`threeZone` 五条还按旧接口渲染，`onFull` 是 `undefined` 一抛整棵树渲染不出来，于是「中栏没渲染」「没进全屏」跟着红，补两个属性、全屏那条用本地变量扮演父层；`toneGuard` / `commentDiscipline` 拦下四处（一句双破折号 + 三处口语「把草稿拉回来」「这一块」）；`engineSwitch` 两条的夹具 `loadOne` 对任何 id 都回上一台整份名片，选「还没名片的那台」又把上一台读了回来，改成只有上一台 `ok:true`，注释里也不点名具体引擎（守卫要求）。本地回归：向导 1135 条 1112 pass / 6 fail（进程与 uv 类，CI 干净环境全过），引擎 + 服务 774 条 766 pass / 4 fail（C11 既有、`memprobe`×2、盘上缺模型目录） | |
| **A64** | ⭐⭐⭐ **推理入口嗅探补强：打包声明、src 布局、README 写法变体、参数词表与路径基准** | ✅ **2026-11-05 已做**（`71467897`）· 🔴 `tools/engine-wizard/core/readmeEntry.js` · 🔴 `tools/engine-wizard/core/entryPick.js` · 🔴 `tools/engine-wizard/core/wizardbridge.js`（discover）· 🔴 `tools/engine-wizard/editor/scanAutofill.js`（cwd）· 🔴 `test/readmeEntry` / `test/computeAutoFill` | [实测 2026-11-05] **起因**：入口识别只认 README 里最标准的两种写法与四类参数打分，碰上 src 布局或参数稀少的引擎直接返回 null。**四处补强**：① **打包声明**当最强证据，读 pyproject 的 `project.scripts` / `project.entry-points.console_scripts` / `tool.poetry.scripts` 与 setup.py 的 `console_scripts`，取 `模块:函数` 的模块段（写错了装不上，比文档示例硬）；② **src 布局**：`moduleToFiles` 同时给扁平与 `src/` 两组候选，模块名反推时剥掉 `src`（`src/__init__.py` 存在则不剥），并把 `srcRoot` 带出去让名片 `cwd` 落到 `engines/<id>/src`（cwd 停在引擎根时 `-m a.b.c` 就是 ModuleNotFoundError）；③ **README** 认 `python3.10` 这类带版本号写法、认 `cd 子目录 &&` 前缀、认 `README_zh.md` 这类文件名变体（短名优先）；④ **词表与路径**：输出落点补 `wav/wave/flac/mp3/ogg`（`--save_wav` 这类），参考音频同步补；README 只写文件名时按**唯一后缀**匹配，同名文件不止一个仍按分数，不替使用者挑。**实测对比**（夹具）：`--text` + `--save_wav` 且 README 写 `python3.10` 的引擎由 `null` 变为 readme 命中；src 布局由 `src.a.b.c` 变为 `a.b.c` 且 cwd 指到 `src`；discover 端到端返回 `source=entry-points`、`module` 无 `src.` 前缀。**回归**：向导 1148 条 1127 pass / 4 fail（进程与 uv 类环境用例，CI 干净环境全过），引擎 + 服务 774 条 766 pass / 4 fail（C11 既有、`memprobe`×2、盘上缺模型目录），文案与注释守卫 6 条全过。⚠ **边界**：`bash run.sh`、只贴截图、参数只有一类的引擎仍然认不出，此时不推荐入口（不按文件名顺序猜） | |
| **A65** | ⭐⭐⭐ **入口嗅探认三种声明式命令行框架（click / typer / fire）** | ✅ **2026-11-05 已做**（`28a41016`）· 🔴 `tools/engine-wizard/core/cli_help_extract.py` · 🔴 `test/entryFrameworks.node.test.js`（新） | [实测 2026-11-05] **起因**：这三种框架的参数不在 `add_argument` 里，静态扫描一条都读不到，实测夹具结果是 `findCliFiles` 找得到文件、`flags: 0`，discover 只能说「没有可识别的参数」，这类上游等于完全没有自动嗅探。**做法**：argparse 读到 0 条时，用同一棵 AST 再按各自声明形式读一遍，产出的记录与 argparse 同形（`dest` / `flags` / `help` / `required` / `default` / `action` / `type`），下游的草稿与入口判定不需要知道来源：click 读 `@click.option` 的开关表与 `required` / `help` / `is_flag`；typer 读默认值形式的 `typer.Option` 与 `Annotated` 形式（`...` 表示必填）；fire 读 `Fire(fn)` 指向的函数签名（无默认值即必填，开关按 `--name`）。**只在确实出现那些声明时产出**，普通脚本的参数不会被认成命令行；argparse 的文件仍走原路径，名字保持下划线不被改成横线。**实测**：三个夹具各读出 4 个开关、`score: 4`、入口文件正确。**回归**：新增 6 条夹具用例（三种框架各自字段正确、三种都能凑出四类认出入口、argparse 不受影响），整套向导 1151 条 1136 pass / 4 fail（进程与 uv 类环境用例），CI 双绿。⚠ **仍然认不出**：`bash run.sh` 这类包装脚本、参数只有一类的引擎（证据不足时不推荐）、扫描深度 4 层与 4000 文件上限之外的文件 | |
| **A66** | ⭐⭐⭐ **推理入口改为可选可填的下拉；文件发现只搜 .py 且不限深度** | ✅ **2026-11-05 已做**（`961ff3ec`）· 🔴 `core/pyFiles.js`（新）· 🔴 `core/entryCandidates.js`（新）· 🔴 `core/cliHelp.js` / `core/cli_help_extract.py` / `core/wizardbridge.js`（discover）· 🔴 `editor/EntryChoice.jsx` + `editor/entryChoiceField.js`（新）· 🔴 `editor/ManifestForm.jsx` / `ManifestPage.jsx` · 🔴 `test/entryCandidates` / `entryChoiceField` / `entryChoiceRender`（新）/ `editorModuleShape` | [实测 2026-11-05] **Owner 定的三条口径**：① 包装脚本不猜，`bash run.sh` 与网页界面这类明显不是入口的排除；② 识别不出结论时不留空白格子让人填，给一个**既能下拉又能输入**的控件让人选；③ 扫描只搜 `.py`、深度不限。**文件发现**：新增 `pyFiles.js` 统一列文件，去掉深度 4 层与 4000 文件上限，剔除依赖/构建/文档/测试目录及 `setup.py`、`__init__.py`、`test_*.py`、`*_test.py`；`cliHelp.js` 的 `CLI_CANDIDATES` 降级为排序用，不再「命中即停」；CLI 标记补 argparse 之外的 click / typer / fire；Node 把文件清单写进 spec，Python 提取器不再自行找一遍（两处发现逻辑分叉会让界面候选与实际解析的源码不一致）。**候选清单**：discover 新增 `entry_candidates`，列出全部 Python 源文件，带模块名、`srcRoot`、参数打分、推荐标记，以及打包声明点过名但盘上无源文件的模块；识别不出结论时照样有值；网页界面类文件名从下拉里剔除，输入框仍可直接输入。**第 4 步控件**：新增「推理入口」一段，原生 `datalist` 让同一输入框既能选也能输入；选中文件后写进名片的是 `-m` 模块名或脚本路径（不是相对文件路径），并按 src 布局设 `call.cwd`；`webui/app/gradio/launch/demo` 类的文件不进下拉。**守卫**：`editorModuleShape` 加「editor/ 下不许有只差大小写的两个文件名」——组件 `EntryChoice.jsx` 与纯函数模块在 Windows 上撞名时，构建会报一个指向正确行的 `default is not exported`，已撞过三次。**验证**：新增 17 条用例（六层深目录、只列 .py、排除规则、候选排序与推荐、src 模块名、argv/cwd 读写、脚本形态、真渲染选值与输入），相关守卫与构建共 203 条全过；CI 双绿。⚠ **仍有边界**：一个文件挂多个子命令时不替使用者选子命令；选定入口后 `call.args` 可能仍含别的脚本的开关（仅在请求带该键时才下发）；`bash run.sh` 一类包装与只有一类参数的引擎仍不推荐入口 | |
| **A67** | ⭐⭐⭐ **沙箱实测「只给一个仓库地址能否自己接回来」；补上最后一处自动接线** | ✅ **2026-11-05 已做**（`29a140d3`）· 🔴 `editor/scanAutofill.js`（权重落点）· 🔴 `test/computeAutoFill.node.test.js` · 🔴 `docs/ENGINE_ADOPTION_FLOW.md`（订正） | [实测 2026-11-05] **起因**：Owner 追问「删掉全部引擎（GSV 除外）后能否只按 wizard 从头接回」。此前答复引用 10-04 设计文档，误判「第 2 步 `install.env_command` 只能来自名片」「第 3 步要人确认下载」，与实际代码不符。**沙箱做法**：`WIZARD_PROJECT_ROOT` 指向系统临时根，造本地 git 仓库当上游（README 含 `hf download` 与推理用法、`pyproject.toml` 含 `[project.scripts]`、`requirements.txt`、argparse CLI 源码），按 wizard 后端端点顺序真跑，不碰现有引擎、不联网。**逐步实测**：① `/wizard/resolve` 只收一个 URL ⇒ 自动出 `id=demo-tts` 与 cloneUrl；② `/wizard/clone` 成功；③ `/wizard/env` 传 `manifest: {}`、`execute:false` ⇒ `from:"probe"`、`guessed:true`、`from_file:"pyproject.toml"`，自动给出「建 venv + `uv pip install -e .`」两步计划（`envInstall.js` 的 `suggestEnvCommand` 从上游依赖清单推导，名片只是优先、不是前提）；④ README 自动嗅探出 `{tool:"hf", source:"hf", repo:"acme/demo-tts", dir:"checkpoints"}`（`extractDownloadCommands`）；⑤ `/wizard/discover` 自动得到 5 个参数、入口 `demo.infer_cli`、依据 `entry-points`、1 个候选；⑥ `computeAutoFill` 自动填出 `kind`/`argv`/`cwd`/5 个 `call.args`/三个 bind 槽位/`role:"device"`/`call_time`。**唯一 error**：`call.argv` 缺「模型权重」——`--model_dir` 已在 `args` 里却没接上下载落点。**补法**：`scanAutofill.js` 在名片里还没有 `{checkpoints}` 时，优先取入口文件里的模型目录类开关，追加 `--model_dir {checkpoints}`；无入口线索时只在唯一命中才补；`weights:"self"`、使用者已写过落点、python 形态一律不动；notes 留痕且第 4 步「模型权重」格仍可改。**复测**：同一沙箱从 URL 到名片，校验由 1 条 error 变为 **0 error / 0 warning**。**订正**：`ENGINE_ADOPTION_FLOW.md` §一原写「`install.env_command` 只能来自名片」，与 `buildEnvPlan` 不符，已保留原决策记录并加 [实测] 订正块，明确「两阶段」只在 `call` 段成立；文档头补最后核对日期。**回归**：新增 6 条用例，相关测试与守卫 125 条全过，CI 双绿。⚠ **边界（未实测 / 仍需人）**：① 沙箱只出计划未真装环境、未真下模型、未起引擎，第 5 步真实合成未验；② `models.required` 仍要人确认（A9），平台说不出权重齐不齐；③ `license_gate: true` 需人在发布页点同意，HF token 需人设置；④ **python 类形态要写适配器**（`fish-audio` 的 `FishAudioAdapter` 全仓无实体），GSV 无 `call` 段且训练线绑死，这两类不在自动嗅探形状内；⑤ 尚无 headless 编排端点把五步串成「给 URL 即出可用引擎」 | |
| **A68** | ⭐⭐⭐ **真引擎联网五步实测：clone / 装环境 / 下权重 / 写名片 / A 级真合成全绿；补 stdin 文本入口** | ✅ **2026-11-05 已做**（`bbc77d9b`）· 🔴 `lib/engines/host.py`（`stdin_payload` / `declares_text` / `_synthesize_cli` 的 `input=`）· 🔴 `lib/engines/hostProfile.js`（cli 键表加 `text_via`）· 🔴 `test/hostRefText` / `test/hostProfile` | [实测 2026-11-05] **做法**：`WIZARD_PROJECT_ROOT` 指向系统临时根（放 `server.js` 锚点、`lib/` 用 junction 只读挂真仓库、`engines/` 临时 junction 让相对路径命中沙箱资产，跑完即删），`AURIVOX_EXTRA_ENGINES_DIR` 指沙箱，`PATH` 补平台根 `venv/Scripts`（`uv.exe` 在那里）。真上游 `OHF-Voice/piper1-gpl`（轻量 onnx TTS）、真小权重 HF `rhasspy/piper-voices` 的 `en_US-lessac-low.onnx`（63,201,294 B）+ `.onnx.json`（4,882 B）。**逐步**：① `/wizard/resolve` 只收 URL ⇒ `id=piper1-gpl` + cloneUrl；② `/wizard/clone execute:true depth:1` 真克隆；③ `/wizard/env execute:false` 空名片自动推 `uv pip install -e .`（`from:probe`）；因上游根有 `setup.py`/`CMakeLists`（源码编译 C 扩展），按**名片优先**机制把 `install.env_command` 改成 `uv pip install piper-tts` 后 `execute:true` 真装成功（7 包 13 秒：piper-tts / onnxruntime / numpy / pathvalidate 等）；④ 真下两个权重文件，`/wizard/download/files` 列得到；⑤ `/wizard/discover` 得到 47 个 flag、入口 `piper.__main__`（依据打包声明）、35 个文件候选，`computeAutoFill` 自动填出 kind/argv/cwd/args/bind/call_time；⑥ `/wizard/save` 落盘；⑦ `/wizard/verify/checks?audio=A` **四块全绿**：装没装 ✓ / 起不起来 ✓ / 权重齐不齐 ✓ / **出得了声 ✓**（WAV 48,684 B、24,320 帧、16 kHz 单声道、1.52 s，宿主与探针读到的 WAV 头一致）；B 级契约（缺 text 应得 400）也过。**实测暴露并补掉的两个真缺口**：① 这类 CLI 没有 `--text` 开关，正文从 stdin 读；平台原先只把文本展开成 `bind.text` 的开关值，子进程 stdin 等 EOF ⇒ `/tts` 超时。补通用声明 `call.text_via="stdin"`，宿主按 UTF-8 写进 stdin，未声明时 `input=None` 保持原行为；与 `bind.text` 同时声明或写错值当场抛错；`declares_text()` 让请求校验与方法级自检都认这两种入口。② 自动接的 `--model {checkpoints}` 指向**目录**，单文件权重引擎要补到具体文件名。**第 4 步仍需人确认的格子（不夸大）**：自动词表把 `text→--input-file`、`ref_audio→--speaker`、`output_path→--output-dir` 误认了，需改成 `--output-file` 并删掉误认的两格；模型开关要补文件名；`models.required` 要人确认（A9）；`runtime.verify` 由 ManifestForm 的 effect 自动填（沙箱没渲染 React，照同形状补）。⇒ **五步全绿是「自动推导 + 第 4 步确认绑定」的结果，不是零输入全自动**。**回归**：新增 3 条用例（stdin_payload / declares_text / cli 键表），相关测试 176 条 173 pass / 3 skip / 0 fail；引擎+服务 778 条 769 pass / 4 fail（C11 既有、memprobe×2、盘上缺模型目录）；CI 双绿 | |
| **A69** | ⭐⭐ **自动填值按证据强度分绿 / 黄徽标：确定才绿，靠名字猜的一律黄** | ✅ **2026-11-05 已做**（`49f3136e`）· 🔴 `editor/scanAutofill.js`（`confidence`）· 🔴 `editor/RequiredFields.jsx` / `EntryChoice.jsx` / `ManifestPage.jsx` / `ManifestForm.jsx`· 🔴 `test/computeAutoFill.node.test.js` | [实测 2026-11-05] **起因**：A68 真引擎实测里词表把 `--speaker` 填进参考音频、`--output-dir` 填进输出路径，界面却一律显示绿色「扫描已匹配」，与确切同名命中无从区分。**做法**：`computeAutoFill` 产出 `confidence`（bind 四槽位 / returns / weights / entry），判据是「规范同名 + 证据出自推理入口文件 + 无竞争候选」⇒ certain，其余（相近名、扫描中另有更贴切参数、跨文件命中、按名字推的输出形态与权重落点、打分选出的入口）⇒ guess；候选词表与填出的值未改，界面只按分档用项目已有的 `badge-ok` / `badge-warn` 着色，hover 给出依据，输入框边框同色。**结果**：同树临时 5300 服务补 PATH 后真扫 spark-tts（56 个 flag），合成文本 `--text` 绿「扫描已确定」、参考音频 `--prompt_speech_path` 与输出 `--save_dir` 黄「推测，请核对」、推理入口 `cli/inference.py` 绿「入口已确定」；5299 服务进程 PATH 无 python，扫描只出「未匹配，需指定」，故未在该端口取图。**回归**：新增 7 条用例，computeAutoFill 60 条全绿；向导 + 注释守卫 111 条全绿；整跑 1196 条里 6 条真实失败全是既有环境性（uv 不在 PATH 4 条、本机 killProcessTree 2 条），16 条 cancelled 是整跑超时；补 PATH 后 env 相关 63/64（余 1 条 `resolveUv` 因 PATH 形态不同断言 `python -m uv`，与本批无关）。CI 双绿（run `42063996215`） | |
| **A70** | ⭐ **可选能力区分段框排版；必填区说明补「留空项灰显」，撤除两个「添加」按钮** | ✅ **2026-11-06 已做**（`43b53d6c` + `88af2b8f`）· 🔴 `editor/OptionalCapabilities.jsx`· 🔴 `editor/RequiredFields.jsx`· 🔴 `test/optionalCapabilitiesRender.node.test.js` / `test/optionalCapabilitiesWiring.node.test.js` | [实测 2026-11-06] **起因**：第 4 步可选能力区靠行距分段，权重位与其它参数之间只有一条分隔线，`输出格式` 未声明时整块不出现、`音频输入` 也没有边界，读不出「哪几格属于同一件事」。**做法**：① 输出格式常驻显示，排到运行设备之后、音频输入之前；② 输出格式、音频输入、多权重位各占一个框（同一份 `BOX` 常量，未新增样式类）；③ 第 2 与第 3 权重位同框共用，位间以细线分隔，权重位上方那条分隔线随独立边框一并去掉；④ 权重位默认摆出第 2 位，该空行不写进名片、整行按未声明弱化，因此不等于替单权重引擎声明了这一位；⑤ 区尾「加一位权重位」「添加输出格式」两个按钮撤除（默认一位可点、格式块已常驻，留着是同一动作的第二处入口），原先由按钮顺带写下的 `role: output_format` 改由输入框承担：填上开关名即补 `style: value` 与 `role: output_format`，缺了它 9886 不长格式下拉且不报错；⑥ 必填区栏头补一句留空项在本向导内以灰色显示，与「不生成控件、不下发参数」同句陈述、逗号衔接。**回归**：可选能力与必填区相关 63 条全绿；`lib/` + 向导整跑 22 条 not ok 全是既有环境性（15 条整跑超时取消、uv 不在 PATH、本机 `killProcessTree`）。**过程**：首推 `43b53d6c` 时`lib/toneGuard` 拦下注释里的「先点」（该守卫连注释一起扫），两平台同时挂在这一条，改写表述后 `88af2b8f` 双绿。CI 双绿（run `42078849435`） | |
| **A71** | ⭐⭐ **参数池按推理入口收窄：左栏只列入口文件里的参数，并写明收窄依据** | ✅ **2026-11-06 已做**（`75956275`）· 🔴 `editor/paramScope.js`（新）· 🔴 `editor/entryChoiceField.js`（`entryFileOf`）· 🔴 `editor/ManifestPage.jsx` 接线· 🔴 `editor/EngineScanZone.jsx`（依据行）· 🔴 `test/paramScope.node.test.js` / `test/entryChoiceField.node.test.js` | [实测 2026-11-06] **起因**：discover 扫的是整份仓库的 flag，训练、微调、工具脚本与推理参数混在一个池子里：fish-audio 74 个、spark-tts 56 个，真正属于推理入口的只有 23 与 9 个。**做法**：判据落在入口文件上，**不按目录名排除**（train/ 只是上游习惯，不是契约）；入口文件命中 ⇒ `basis: entry`；入口文件本身没有参数（薄 `__main__` 只做转调）⇒ 退到入口所在目录 `basis: dir`；再没有 ⇒ 退回全量 `basis: all`，拿不到依据时给全部、不给空池。收窄只改左栏可拖的源，不改 `/wizard/discover` 返回、不写进名片；左栏在数量行上方写明「只列出…的 N 个参数，另有 M 个不在入口内」并给一个「列出全部 / 只列入口」切换。**结果**：真扫描 fish-audio 74→23（收窄 51）、spark-tts 56→9（收窄 47）、indextts2.5 在 synth 分组内 18→18（分组已足够，不重复收窄）；切换后回到 74 / 56。**边界**：`gpt-sovits` 认不出入口 ⇒ 仍给全量；`entry.subcommand` 为 null 时子命令不进收窄判据（子命令不归平台猜，见第十一批口径）。**回归**：新增 8 条纯函数用例与 1 条 `entryFileOf` 用例；向导 + 注释 + 语气守卫 57 条全绿，相关布局/切换/入口测试 40 条全绿。CI 双绿（run `42086670922`） | |
| **A72** | ⭐⭐⭐ **可选能力区补可复现性（seed）声明位：三态必选，缺了就存不了也起不来** | ✅ **2026-11-06 已做**（`a1ea9b05`）· 🔴 `editor/OptionalCapabilities.jsx`· 🔴 `editor/scanAutofill.js`（默认声明）· 🔴 `test/optionalCapabilitiesRender.node.test.js` / `test/computeAutoFill.node.test.js` | [实测 2026-11-06] **缺口**：seed 在契约（`engines/_TEMPLATE/manifest.json` 写明 ⛔ 必填三态）、宿主（`host.py:SeedPlan`）、前端（`AdvancedParamsPanel.jsx` / `CompareRow.jsx` 的 seed，平台自有开关）三处都齐，唯独向导一处都没有 ⇒ 经向导接入的引擎在存名片（`hostProfile.js:369`「缺了：契约 §5.2.1 要求每张 manifest 显式声明可复现性」）或载入（`SeedPlan` 抛错）时必然失败。**做法**：可选能力区加一格「种子怎么传」：不可复现 / 引擎自己收（+ 参数名）/ 宿主播全局 RNG（+ 勾随机源，名单与 `_RNG_TABLE` 同一份四项）。**这一格没有「留空」选项**：参数名为空或一项随机源都不勾时界面直接说明会被拒，不等人到保存才报错。自动填：扫到名字就是 seed 的开关 ⇒ `{"arg": …}`；扫不到 ⇒ `"none"`；已声明不覆盖；名片缺这项时该区挂载即补 `"none"`。**回归**：渲染侧 4 条 + 自动填侧 3 条新用例；相关 158 条全绿。CI 双绿（run `42095524001`） | |
| **A73** | ⭐⭐ **seed 的 cli 接线：只写 call.seed 会合成失败，必须连 call.args 一起写** | ✅ **2026-11-06 已做**（`666864e9`）· 🔴 `editor/seedField.js`（新，按 kind 折算）· 🔴 `editor/OptionalCapabilities.jsx` · 🔴 `editor/scanAutofill.js`· 🔴 `test/seedField.node.test.js` / `test/optionalCapabilitiesRender.node.test.js` | [实测 2026-11-06] **起因**：A72 把「引擎自己收」写成 `{arg:"--seed"}`，对 cli 不成立。宿主 `_synthesize_cli` 把种子塞进 `params[arg]`，再由 `build_cli_argv` 用 `call.args[arg].flag` 拼命令行；`--seed` 不是 args 的键 ⇒ 抛「参数没有在 call.args 里说明该变成哪个命令行开关」。**做法**：两种形态分开折，python 写方法关键字名；cli 让人填开关、落盘补 `call.args[<键>] = {flag, style:"value"}` 并把 `--seed` 折算成键 `seed`，改名收旧键、清空收整条。cli 不再提供「宿主播全局 RNG」（`host.py` 对这条组合会抛「子进程里的随机源播不到」）。**验证**：用真宿主代码跑 `build_cli_argv`，`seed:{arg:"seed"}` + `args.seed` 时 argv 出现 `--seed 4242`，去掉 args 按预期报错。**边界（未验）**：盘上四台引擎都没有 seed 开关（spark/indextts2.5/fish 全是 `"none"`，gpt-sovits 无 `call` 段），端到端只能在有 seed 参数的真引擎上做，见台账下一批。**回归**：新增 `seedField` 9 条、渲染 13 条；相关 168 条全绿。CI 双绿（run `42100076786`） | |
| **A74** | ⭐⭐⭐ **`call.returns = "dir"` 落地：文件与目录这一对真正分开** | ✅ **2026-11-06 已做**（`3f3c907a` + `5a7c271b`）· 🔴 `lib/engines/host.py`· 🔴 `lib/engines/hostProfile.js`（校验同口径）· 🔴 `lib/engines/hostDirReturns.node.test.js`（新）/ `hostProfileCli.node.test.js` | [实测 2026-11-06] **缺口**：名片校验一直接受 `returns:"dir"`，宿主只实现了 file / bytes / generator 三支；dir 掉进 bytes 分支去读 stdout，报「call.returns 写的是 bytes，但 stdout 是空的」——与事实无关。Spark-TTS 这类「目录由引擎自己起名」的引擎因此接不进来。**做法**：cli 建空临时目录经 `bind.output_path` 递给子进程，python 同一目录传给方法，事后从目录取回音频；判定只有一条：恰好一个音频才用，零个报错并列出目录内容，两个以上报错不替人挑（同一目录躺着两条音频时平台没有依据）；扩展名只做类型筛选，不按大小或时间排序；临时目录在 finally 删除。名片校验同步：dir 与 file 同口径，必须绑 `call.bind.output_path`。**回归**：新增 4 条真引擎用例（python 单文件取回 / 两条报错 / 空目录报错带内容 / cli 真起子进程取回）+ 1 条校验用例；宿主相关 62 条 59 通过 3 跳过 0 失败。**过程**：`3f3c907a` 首推时 `lib/toneGuard` 拦下报错里的「读不了」，改「无法读取」后双绿。CI 双绿（run `42191612277`） | |
| **A75** | ⭐⭐ **seed 与运行设备、参考文本同排：一个输入框，不留下拉** | ✅ **2026-11-06 已做**（`ee7745b2`）· 🔴 `editor/OptionalCapabilities.jsx`· 🔴 `editor/seedField.js`（`withSeedSwitch`）· 🔴 `test/seedField.node.test.js` / `test/optionalCapabilitiesRender.node.test.js` | [实测 2026-11-06] **起因**：A72/A73 把它做成独立一框（标题「可复现性（seed）」+ 三态下拉），比其它格重：这一格要的只是「种子从哪个开关进去」。**做法**：收成设备行第三格，标签就是 `seed`，输入框填开关（占位符 `--seed`）；填了＝引擎自己收，留空＝不可复现。**留空不等于不声明**：名片缺 `call.seed` 会被存盘与启动拒掉，所以留空落盘是显式的 `"none"`，并把它上一次补出的 `call.args` 那条收走；cli 写 args 的键 + `{flag, style:"value"}`，python 写方法参数名。`mode:"global"` 没有对应输入框，名片里原本写着的那一份写回时不动。设备行改成显式列数（设备格数 + 2），否则 seed 被网格挤到下一行。**回归**：`seedField` 9 条按新接口重写、渲染侧 4 条改写；权重位的行选择器补「行里有下拉」一条，免得把设备行数成权重位。相关 124 条全绿。CI 双绿（run `42201573726`） | |
| **A76** | ⭐⭐ **推理入口并入必填字段；seed 接进同一套扫描嗅探** | ✅ **2026-11-07 已做**（`46ac9be5`）· 🔴 `editor/EntryChoice.jsx`（改成格）· 🔴 `editor/RequiredFields.jsx`（承载入口格）/ `editor/ManifestForm.jsx`（去掉独立段）· 🔴 `editor/scanAutofill.js`（seed 升级）/ `test/computeAutoFill.node.test.js` | [实测 2026-11-07] **起因**：入口本来就是必填（没有它引擎起不来），却单占一段，版式与必填区其它格不一致。**做法**：入口格排到「必填字段」区最上面，形状与同区一致（标签 + 键名徽标 `call.argv`/`call.module` + 置信度徽标 + 输入框 + 说明），空着挂「未指定」；候选项与置信度改由必填区传入，原独立段落与导入删除。**seed 嗅探**：扫到名字就是 seed 的开关即证据，入口文件里有同名开关优先取它；名片里写着 `"none"` 的允许升级为「引擎自己收」（这个值常是平台缺省，留着等于把扫到的开关丢掉），升级往 `notes` 写一句；已写成 `{arg}` / `{mode:"global"}` 的不动；没扫到仍补 `"none"`。文案：无候选时的提示改成「未扫描，或没有发现 Python 源文件」（原来那句在有入口却没扫过时是错的）。**回归**：自动填新增 3 条、入口渲染跟一条文案；相关 90 条全绿。CI 双绿（run `42241059998`） | |
| **A77** | ⭐⭐ **模型权重两格的填写：参数名按名字分级，值按「上游怎么说 + 盘上几个文件」** | ✅ **2026-11-07 已做**（`06722fa9`）· 🔴 `editor/scanAutofill.js`· 🔴 `editor/ManifestPage.jsx`（传下载清单）/ `editor/RequiredFields.jsx`（说明）· 🔴 `test/computeAutoFill.node.test.js` | [实测 2026-11-07] **两格是什么**：参数名＝引擎从哪个开关读权重（cli 写 `call.argv` 那一对，python 写 `call.init_args`），值＝`{checkpoints}`（第 3 步下载落点）。**参数名**：入口文件内的 cli 参数按名字分级（`model_dir/path/root` → `ckpt/checkpoint/weights_dir/path` → `model/ckpt/checkpoint/weights_file` → `model/ckpt/weights/pretrained`），命中即接 `{checkpoints}` 并标「权重开关为推测」。**值**：默认目录；只有「名字或说明指向文件」且「盘上恰好一个权重文件」才写 `{checkpoints}/<文件名>`；说明指向文件而盘上有多个时不替人挑，先接目录并提示手写。**补的一处**：名字分级表原来没有 `_file` 档，Piper 那类 `--model`/`--model-file` 一条都不命中。**回归**：新增 4 条用例；权重与守卫相关 162 条全绿。CI 双绿（run `42245695253`） | |
| **A78** | ⭐⭐ **左栏：已落进名片的参数卡弱化但仍可拖；分组下拉说清来源** | ✅ **2026-11-07 已做**（`bf80769a`）· 🔴 `editor/ParamPool.jsx`（`used`）· 🔴 `editor/EngineScanZone.jsx`（分组措辞）/ `editor/ManifestPage.jsx`（判据）· 🔴 `editor/editor.css`（`.wz-param-item-used`）/ `test/paramPoolRender.node.test.js`（新） | [实测 2026-11-07] **起因**：参数拖进某个格之后，左栏那张卡与没用过的长得一样，重复拖与漏拖都看不出来。**做法**：参数名进了 `call.args`、成了某个槽位的开关（`bind` 的值）、或已在 `argv` 里 ⇒ 这张卡 `opacity: .55`（悬停恢复），标题补「可以再次拖动」；**只弱化不锁死**，因为同一个参数可能同时喂两个槽位（正文与参考文本），拖错格也要能拖走；python 形态按名片 `parameters` 里是否已有同名参数判。**分组**：`(root)` 是平台占位，显示「顶层（无子命令）」；其余是上游子命令名，原样保留并加一行「名称取自上游子命令，未做翻译」（翻译 init/download/batch 反而与命令行上的写法不一致）。**既有行为**：必填置顶与「必填」徽标一直有（`paramPoolOrder` 按上游 `required===true` 分区），本批补了渲染侧守卫。**回归**：新增 3 条渲染用例；相关 9 条与守卫全绿。CI 双绿（run `42261548911`） | |
| **A79** | ⭐⭐⭐ **分组名加中文注；「音频输入」改名辅助参考音频；多选音频真的透传** | ✅ **2026-11-07 已做**（`cd157b9e` + `842a6562`）· 🔴 `editor/groupLabel.js`（新）· 🔴 `editor/EngineScanZone.jsx` / `editor/OptionalCapabilities.jsx`· 🔴 `editor/ManifestPage.jsx`（数量对齐）· 🔴 `lib/engines/host.py`（数组展开）· 🔴 `lib/engines/hostAudioArgs.node.test.js`（新）/ `test/groupLabel.node.test.js`（新） | [实测 2026-11-07] **分组**：下拉显示 `synth（合成语音）`——原名是命令行上要敲的字，不能改写，中文注只放括号里；表里没有的名字原样显示；`(root)` 是平台占位，只留「顶层（无子命令）」。**改名**：`音频输入` → `辅助参考音频`（前端那个 picker 本来就是多选）。**多选透传**：查下来最后一步是坏的——`_render_cli_arg` 对 `style="value"` 直接 `str(value)`，而平台下发的音频参数一律是数组，命令行上于是出现 `--aux ['a', 'b']` 这样一个词，上游只会说文件不存在。改成数组按 `nargs="+"` 展开（`--aux a.wav b.wav`），`repeat` / `join` 两态不变；只收单个值的上游拿到多个会自己报错，stderr 原样带回，不替它裁掉多余项。**顺带**：分组过滤与入口收窄换序，让「只列出 N 个」与列表条数一致。**回归**：新增 `hostAudioArgs` 4 条、`groupLabel` 4 条；本批相关 144 条全绿。CI 双绿（run `42264028271`、`42264913366`） | |
| **A80** | ⭐⭐⭐ **旧格式名片的参数迁移；`repeat` 大于等于 2 时的默认值** | ✅ **2026-11-07 已做**（`2c683cbb`）· 🔴 `editor/paramDrop.js`（`migrateLegacyParams`）· 🔴 `editor/paramDefault.js`（新）/ `editor/ParamRow.jsx`· 🔴 `test/paramDrop.node.test.js` / `test/paramDefault.node.test.js`（新） | [实测 2026-11-07] **起因**：拿 IndexTTS2 试它的 8 维情绪向量。引擎侧实测：CPU 跑通（3 分 39 秒出 194 KB WAV），`--device cuda` 报 `Torch not compiled with CUDA enabled`（这台 venv 装的是 CPU 版 torch）；`--emotion-vector` 是逗号分隔的 8 个数，顺序 `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`，总和不得超过 0.8（给 3.6 被拒，原文 `sum must be <= 0.8`）。**结论：平台承载得住**——`paramSchema.js` 的注释本来就写着「八维情绪向量 = number × repeat 8」，`dim_labels` 给每格起名，`call.args` 写 `style:"join"` + `join:","` 后 argv 上是 `--emotion-vector 0,0,0.8,0,0,0,0,0` 一个词（真 `build_cli_argv` 验过）。**卡住的是两处**：① 盘上四台名片都是旧格式 `params`，而向导拖参数写新格式 `parameters[]`，两者共存被校验拒（「参数只能声明一次」）⇒ 拖任何一个参数进来这张名片就存不了盘；② `repeat ≥ 2` 要求默认值是等长数组，而那一格只有一个输入框，八维直接填不出来。**做法**：落点先迁移（schema 键序保留、`default`→`suggested_value`、`load_time`→`phase:"load"`、只在 load/call_time 里出现的补一条 text），再写新条目；默认值在成排时按逗号分隔读写，空的一段写 `null` 不补 0。**回归**：新增 `paramDefault` 8 条、`paramDrop` 迁移 4 条；向导逐文件整跑，失败 5 个文件全是既有环境性（uv 不在 PATH、本机 `killProcessTree`、凭据弹框）。CI 双绿（run `42271211495`） | |
| **A81** | ⭐⭐⭐ **拖拽带上 `--flag`；「逗号分隔的 N 维」参数嗅探成 N 格 + `join`** | ✅ **2026-11-07 已做**（`230c24ee`）· 🔴 `editor/paramShape.js`（新，判定）· 🔴 `editor/paramDrop.js`（`dragLabelOf` / `PARAM_MIME` / 向量落点）· 🔴 `editor/ManifestPage.jsx` / `editor/ParamDropZone.jsx`（拖拽载荷）· 🔴 `editor/ParamRow.jsx` / `editor/editor.css`（多格）/ `editor/paramDefault.js`（`withVectorCell`）· 🔴 `editor/scanAutofill.js`（扫描回填同样判 `join`）· 🔴 `test/paramShape.node.test.js`（新）/ 拖拽 / 多格 / 回填用例 | [实测 2026-11-07] **拖拽**：`text/plain` 原来放整条参数的 JSON，跟着光标走的拖影就是一段 JSON。现在 `text/plain` 放命令行写法（`--emotion-vector`），整条参数放自定义类型 `application/x-aurivox-param`，落点优先读它、退回 `text/plain`（兼容只给 JSON 的旧拖拽源）。**向量判定**：上游说明里「逗号分隔」与「N 维」同时成立才推格数；只说逗号分隔时按一个词处理但不推维度（猜错格数会让名片存不下来）。`IndexTTS2` 的 `--emotion-vector` 原话 “Comma-separated 8-dimensional emotion vector” 命中 ⇒ `repeat 8`、默认值八格 `null`（不写 0）、`call.args` 写 `style:"join"` + `join:","`。**这一条同时解决扫描回填**：扫描给的 style 是 argparse 的默认写法 `value`，照抄会被按 nargs 拆成八个词，上游只吃第一个且不报错。**界面**：成排参数的默认值从 103px 一个框改成 N 格，每格按 `dim_labels` 起名，没给就显示序号。**实测**：真实页面上拖入 indextts2.5 的 `--emotion-vector`，参数行长出 8 格；落点结果过 `buildHostProfile`（repeat 8、default 八个 null、类型 number）。**边界**：`dim_labels` 不从 help 推（上游只写了几维、没写顺序），要名字得在「高级」里填；「重新扫描」不覆盖名片里已写过的 `call.args` 条目，所以先前写错 `style` 的那条要手动改或重拖。**回归**：新增 `paramShape` 8 条、拖拽 4 条、多格 3 条、回填 3 条；相关 172 条全绿。CI 双绿（run `42274527273`） | |
| **A82** | ⭐⭐⭐ **多维参数声明 `type:"vector"`：维度数只由 `dim_labels` 定，派生折成 `item × repeat`** | ✅ **2026-11-07 已做**（`d3fde541` + `982929a5`）· 🔴 `lib/engines/paramTypes.js`（`VECTOR_TYPE` / `vectorSizeOf` / `vectorItemTypeOf`）· 🔴 `lib/engines/profile/paramSchema.js`（折算）/ `lib/engines/parameterDeclaration.js`（`item` 进 UI_KEYS）· 🔴 `web/src/components/common/VectorField.jsx`（新）/ `ParamField.jsx` / `web/src/styles.css`· 🔴 `tools/engine-wizard/editor/ParamRow.jsx`（类型 + 维度编辑）/ `paramDrop.js` / `paramDefault.js`· 🔴 `lib/engines/vectorDecl.node.test.js`（新） | [实测 2026-11-07] **起因**：八维情绪向量原来要同时写三处（`type:number`、`repeat:8`、`dim_labels` 八个名字）再加一份长度八的默认值，四处必须对齐；错一处要么存不下、要么命令行被拆成八个词、要么界面只剩序号。**做法**：名片可写 `type:"vector"`，维度数**只**由 `dim_labels` 的长度决定，每维类型由 `item` 决定（默认 number）；派生时折成 `item × repeat`，**下游见到的仍是五种控件形状之一 + repeat** ⇒ `PARAM_TYPES` 仍是一个不多一个不少，`paramTable` 与宿主一行都不用改。同时写 `repeat` 直接拒（两份会漂移的事实）。**9886**：内联 grid 抽成 `VectorField`，每维名字在上、控件在下，列数自适应（宽四列、窄两列），样式在 `styles.css` 的 `.field-vector`；名字为空时界面显示序号。**向导**：类型下拉多一项 `vector`，选中时收起 `repeat`（维度数不从那里来），行下方给一串维度名输入（可加可删、至少两维，加一维补一格默认值、删一维连值一起收）；拖入命中「逗号分隔的 N 维」时直接落成 `vector` 声明，八个空名字留给使用者填。默认值每格按 `item` 折算，不归一的话 0.9 会以字符串存进去。**实测**：真实页面拖入 `--emotion-vector`，类型下拉显示 `vector`、八个名字输入、八个默认值格都带序号；探针名片过 `buildHostProfile`，派生结果是 `number × repeat 8` + 八个名字。**边界**：每维名字不从 help 推（上游只写了几维、没写顺序）；`vector` 不在 `canonicalType` 的出口里，折算只在派生那一步发生。**回归**：`vectorDecl` 8 条、`paramTypes` 补 1 条、向导侧补 2 条；引擎层逐文件跑，失败 3 个文件（C11 的 `profile.js:139` 是 10-29 既有、memprobe 与 registry 是本机环境）。CI 双绿（run `42279037032`） | |
| **A83** | ⭐⭐ **vector 填法被人看懂：不再摆两套 `#1…#8`** | ✅ **2026-11-07 已做**（`dc06daf1` + `b04e9892`）· 🔴 `editor/ParamRow.jsx` · 🔴 `editor/editor.css` | [实测 2026-11-07] **起因**：使用者反馈「看不懂怎么填」。原来主行有一排八个 `#1…#8` 输入框（每一维的**默认值**），下面一行又有一排 `#1…#8`（每一维的**名字**）：形状完全相同、标签却不同，分不清哪排是什么，也不知道「维度」要填什么。**做法**：主行只留一句 「8 维，见下方」；下方按维度一行一条，从左到右是序号、名字、默认值、删除，栏头写「名字」「默认值（可选）」，上方一句说明写清整块是**名片上的声明**、不是某一次合成的值，名字会显示在合成页对应输入框上方，默认值是那里预填的数、可以留空（留空不等于填 0）。标签与说明各占一行，栏头不折行。**兼容**：没写 vector、只写了 `repeat` 的旧名片仍按原来的八格画，不退化成逗号串。**实测**：真实页面拖入 `--emotion-vector`，主行是 `vector` + 「8 维，见下方」，下方八行各有名字格（占位「例如 happy」）与默认值格（占位「留空不预填」）。**回归**：向导构建、样式、模块形状、语气、注释守卫 32 条全绿。CI 双绿（run `42358706069`） | |
| **A84** | ⭐⭐ **vector 维度从八行表格压成一行小格；默认值收进「高级」** | ✅ **2026-11-07 已做**（`002d5f19`）· 🔴 `editor/ParamRow.jsx` · 🔴 `editor/editor.css` | [实测 2026-11-07] **起因**：A83 把两排 `#1…#8` 并成一维一行，看懂了，但八维八行、每行两格加序号与删除，把一条参数撑成一张表；而每行的默认值大多留空，高度几乎都花在不用填的东西上。**做法**：主行只写「8 维」；下方一行横排小格，一格一个维度名（从左到右即引擎读取的顺序），删除贴在格内右端、不再单独占列，末尾一个「加一维」；栏头与逐行说明合成一句短注，点明这里写的是名片声明、名字可留空、默认值在「高级」；各维默认值收进「高级」的一格，逗号分隔、可整格留空（留空不是 0）。**结果**：同一条参数从八行降到两行（主行 + 说明 + 一行小格），与相邻的普通参数行对比只多约 60px。**兼容**：只写 `repeat`、没写 `vector` 的旧名片仍按八格画。**过程**：改样式时幽灵类守卫拦下一次误删（`.wz-param-del` / `.wz-param-more*` 被整段覆盖），已从 `HEAD` 取回该段并复跑通过。**实测**：真实页面拖入 `--emotion-vector`，主行 `vector` +「8 维」，下面八个 `#1…#8` 小格横排、末尾「加一维」。**回归**：构建、样式、模块形状、语气、注释守卫 32 条全绿。CI 双绿（run `42360009637`） | |
| **A85** | **vector 行的参数名输入框不再被「8 维」抢宽度** | ✅ **2026-11-07 已做**（`9c3ac2f7`）· 🔴 `editor/editor.css`（`.wz-param-vector-note`） | [实测 2026-11-07] **起因**：A84 给「8 维」提示写了 `flex: 1 1 160px`，与参数名输入框一起分主行剩余宽度，导致同一列里 vector 那行的参数名比上面两条普通参数短一截。**做法**：提示只是提示，改成 `flex: 0 0 auto` + `white-space: nowrap`，只占自身宽度。**实测**：真页面三条参数名框宽度 `device 638 / emotion-audio 638 / emotion-vector 725`，vector 那行吃满剩余空间、与上面两条对齐，长名字能显示全。**边界**：这是「吃满主行剩余宽度」，不是参数名独占整行；独占会让每条参数多一行，与 A84 的紧凑口径相悖，故未采用。**回归**：构建 / 样式 / 语气 / 注释守卫 32 条全绿。CI 双绿（run `42360877091`） | |
| **A86** | **从 vector 切到单值类型：旧的多维值不再被画成一串逗号** | ✅ **2026-11-07 已做**（`b24c45e3`）· 🔴 `editor/paramDefault.js`（兜底）· 🔴 `editor/ParamRow.jsx`（切类型时收字段）· 🔴 `test/paramDefault.node.test.js` | [实测 2026-11-07] **起因**：使用者切类型时看到建议值框里留了几个逗号。切类型只改了 `type`，`suggested_value`（八个 null 的数组）、`dim_labels`、`item`、`repeat` 全留着；标量输入框 `String([null,null,…])` 就成了 `,,,,,,,`，看上去像填过东西，派生拿到的形状也不匹配。**做法**：从 vector 切走时把这四个多维专属字段一起删掉，不替用户从八维里挑一个值出来；另加兜底，标量类型收到数组时按「没填」显示，别处漏了也不会画出逗号。**实测**：真页面拖入 `--emotion-vector`（type vector、8 个维度格），把类型改成 text，结果 `defaultValue:""`、维度格 0 个、vector 提示消失。**回归**：新增 2 条纯函数用例；构建 / 样式 / 语气 / 注释守卫 46 条全绿。CI 双绿（run `42362023078`） | |
| **A87** | ⭐⭐⭐ **合成参数重做：四列主行 + 按类型展开；vector 改为第六种独立控件** | ✅ **2026-11-07 已做**（`4db8877f` + `f718b237` + `d66e4304`）· 🔴 `lib/engines/paramTypes.js` / `profile/paramSchema.js` / `paramTable.js` / `web/src/lib/engines.js`· 🔴 `editor/ParamRow.jsx` / `ParamDropZone.jsx` / `paramFields.js`（新）/ `editor.css`· 🔴 `web/src/components/common/VectorField.jsx` / `ParamField.jsx` / `styles.css` | [实测 2026-11-07] **口径（使用者给定）**：这块只服务「把某台引擎的额外旋钮翻译成 9886 Advanced Settings 里的一格」；vector 是独立控件，不是折成 item × repeat 的声明写法。**平台层**：`PARAM_TYPES` 六种、canonicalType 认 vector、派生不改 type；dim_labels 归一成 中英文成对；值按 text 数组收、长度与维度数对齐。A82 的折算方案撤回。**向导主行四列**：`--argv`（可编辑，参数名由它派生，改开关时 `withArgKey` 一起迁移 `call.args` 的键）/ 中文名 / 英文名（写成 `{zh,en}`，修掉填字符串被派生丢弃）/ 类型 / common-advanced。`label`/`help` 字符串不生效、`applies_to` 是假字段、`flag` 无编辑入口三处一并处理。**按类型展开**：text/number/boolean/file 填完类型即结束；select 是数量控制 + 三列表（传给 CLI 的值 / 中文 / 英文）并自动开 allow_custom 逃生口；vector 是维度数控制 + 两列表（中文 / 英文）。换类型收走旧类型专属字段。**9886**：VectorField 改成 fieldset 大框（标题取本项名字，内部按维度分小框、标题取本维名字、每格 text）；file 文本框右边加文件夹按钮展开素材库候选（浏览器开不了本机文件夹对话框，只给文件名拿不到服务端路径）；只写 repeat 的旧名片仍按 N 格画。**实测**：真页面拖入 `--emotion-vector`，主行 `--emotion-vector / 中文名 / 英文名 / vector / 常用`，下方维度 8、两列八行；切换类型 vector→select 各 3 行表格、text/number/boolean/file 为 0 行表格。**边界**：加载时（phase）语义按使用者要求保留在「高级」、未整理；9886 的 vector 大框只验到构建通过，未在真后端页面上打开；file 按钮走素材库而非本机目录。**回归**：新增 paramFields 11 条、重写 vectorDecl 8 条、paramTypes 六种守卫与 vector 收取侧；平台层 123 条、守卫与前端 142 条、9886 构建通过；向导全量逐文件跑，失败 5 个文件全是既有环境性（uv 不在 PATH、本机 killProcessTree、凭据弹框）。**过程**：`f718b237` 首推时 CI 两平台挂在 `threeZone` 的 ParamDropZone stub 缺 `./paramFields`，补替身后双绿。CI 双绿（run `42368044543`） | |
| **A88** | ⭐⭐ **合成参数加表头与填写引导；「高级 / More」整排撤除** | ✅ **2026-11-07 已做**（`a652e973`）· 🔴 `editor/ParamDropZone.jsx`（列标题 + 引导句）· 🔴 `editor/ParamRow.jsx`（撤 More、尾部定宽）· 🔴 `editor/editor.css`（表头样式） | [实测 2026-11-07] **起因**：使用者提出合成参数第一行做成表、表头带填写引导，并指出「高级」展开后的字段无法判断该怎么填，给出舍去或写得更详细两个方向；选定**整排舍去**。**口径核对**：More 那一排没有「再加一个 CLI 参数」的能力，加参数靠拖拽或「添加一个参数」，开关就是主行 `--argv`；那一排全是给已声明的这一条补属性。逐个查消费方：只影响 9886 界面的是 `suggested_value`（后端只派生 UI 初值，不派生平台默认值）与 `min/max`（输入框范围）；`group/order` 平台目前没有读取点；`phase`（每次合成 / 加载时，决定该值每次调用下发还是只在引擎启动时下发、改动需重启）、`repeat`（界面画几格 + 命令行按几个词展开）、`source`（选项从哪个平台库扫 + 宿主取文件值）界面与宿主都影响，故「More 只是和 9886 联动」不完全成立。**做法**：列表上方加一行列标题（命令行开关 / 中文名 / 英文名 / 控件类型 / 显示位置），与输入行共用 `.wz-param-row` 的列宽，1px 透明边框补上 `.card` 的边框；每列另有悬停说明，上方一句可见引导写清每行对应一个开关、两类名字显示在合成页控件上方、类型决定控件长相。撤掉 `<details>`、`.wz-param-more-grid` 及对应 CSS；名片里已有的这些字段原样保留不丢，需要时改 manifest.json。**对齐**：主行尾部收进定宽 `.wz-param-tail`（136px），表头末尾 `.wz-param-ops` 同宽。实测带「推测」徽标时后四列曾左移 49px；改后表头 / 无徽标 / 有徽标三组的列左边界均为 `[131,827,955,1083,1183]`，逐像素对齐。**实测**：真页面 5199 上点「添加一个参数」造三行，中文界面下表头、引导句、三行输入框整齐，删除按钮位置一致，`.wz-param-more` 元素数为 0。**回归**：向导与全仓守卫 67 条全绿；CI 双绿（windows + ubuntu，run `42371274269`）。**边界**：`phase` 等字段此后无法在向导内修改，只能改 manifest.json，这是选定方案的已知代价 | |
| **A89** | ⭐⭐ **合成参数收成一个大框：表头进框内、行间改分隔线** | ✅ **2026-11-07 已做**（`cc04d80f`）· 🔴 `editor/ParamDropZone.jsx`（表头与列表包进大框）· 🔴 `editor/ParamRow.jsx`（去 `.card`）· 🔴 `editor/editor.css`（`.wz-param-sheet` / 行分隔线） | [实测 2026-11-07] **口径（使用者给定）**：表头放进「填写的参数」的大框内部；参数之间不再用框框隔离，改用分割线；vector 与 select 这些，分割线要放在下面那些细节项的下面。**做法**：外层用项目现成的 `.card` 加 `.wz-param-sheet`（`padding:0`、`overflow:hidden`），表头与 `parameters[]` 的每一行同处框内；`ParamRow` 去掉 `.card`，行间只用 `.wz-param-row { border-bottom: 1px solid var(--border) }`，最后一行 `:last-child` 不画线。select / vector 的选项表是参数行的 flex 子项（`flex: 1 1 100%`），所以分隔线自然落在细节项之后，不会把主行与选项表切开。**对齐**：表头与数据行同处一个框、共用同一套 padding 与列宽，撤掉 A88 里「1px 透明边框补 `.card` 边框」的补偿；引导句仍留框外。**实测**：真 5199 页面造三行并把第 2、3 行切成 select / vector，测得 `headInsideSheet:true`、残留 `.card.wz-param-row` 为 0；select 行 `rowBottom 1007 > tableBottom 998`、vector 行 `1202 > 1194`，两处 `dividerBelowDetails:true`；截图表头与三行同框、细节表下方才出现线，最后一行下方无线。**回归**：向导与全仓守卫 67 条全绿；CI 双绿（windows + ubuntu，run `42388907087`） | |
| **A90** | ⭐⭐ **右栏预览按 9886 的派生形状读名片参数** | ✅ **2026-11-08 已做**（`eb297e4a`）· 🔴 `editor/PanelPreview.jsx`（`previewSchema` 换算 + 修 `coerceParamValue` 调用） | [实测 2026-11-08] **起因**：使用者问「右边的预览有没有同步更新，按理来说预览反映当前 UI 界面」。先核对边界：`PanelPreview` 复用 9886 真组件（`AdvancedParamsPanel` / `ParamField` / `VectorField` / `ModelPickRow` / `DeviceSelect`），显示的是「这张名片在 9886 生成页上长什么样」，**不是中栏「合成参数」编辑表格的镜像** ⇒ A88 的表头与 A89 的大框、分隔线都不需要同步过去；A87 改 9886 前端（vector 大框、file 按钮）反而因复用组件自动进了预览。**实时性实测**：真 5199 页面加两条参数切成 select / vector，预览出现对应控件；把 vector 改成 text，预览里 vector 大框从 1 个变 0 个，无需刷新。**但发现两处真实偏差**：① `PanelPreview.jsx` 把名片原始 `parameters[]` 直接当 `engine.param_schema` 传给 9886 组件，绕过后端 `deriveParameterViews` 的派生。名片写 `suggested_value:"hello"`、标签「示例」，实测预览标签显示「示例」而输入框为空；真 9886 会派生成 `default` 并预填。② [读码] `setParam` 里 `coerceParamValue(name, raw, prev[name])` 把参数名当字段对象传（真签名 `(field, raw)`），预览里改数值会按文本处理。**做法**：新增模块内 `previewSchema()` 做形状换算（`suggested_value` → `default`；`label` 非对象时按后端口径补 `{en:name, zh:name}`；`tier` 非 common 归 advanced），只换算不重做后端校验；`setParam` 改为按名字查整条字段再交给 `coerceParamValue`。**实测**：JSON 视图注入含 `suggested_value:"hello"` 的 text 参数与带两维中英文名的 vector 参数，预览里「语速」输入框预填 `hello`（`prefilledHello:true`）、「情绪」大框两个小框标题「快乐」「悲伤」、`vectorBoxes:1`。**边界**：换算只覆盖 9886 展示所需的形状，后端 `parseParamSchema` 的数字归一化与校验不在这里重做；预览仍是只读，`values` 随 manifest 变化重置。截图里「检查结果 4 错误」来自注入的极简名片缺必填段，与预览无关。**回归**：向导与全仓守卫 67 条全绿；CI 双绿（windows + ubuntu，run `42392726833`） | |
| **A91** | ⭐⭐ **第 3 步支持一次嗅探上游给的全部仓库** | ✅ **2026-11-08 已做**（`199c59a4`）· 🔴 `editor/StepsExtra.jsx`（`probeAll` / `repoCount` / 按钮与提示） | [实测 2026-11-08] **起因**：从零重走 Indextts2.5 时，第 3 步每个仓库一个「嗅探仓库」按钮，只点第一个就只下一个仓库；随后第 4 步 `models.required` 只覆盖已嗅探仓库，第 5 步按声明判 `ready:true`，真跑却报缺 `bpe.model` 与 `hf_cache/*`。**上游事实**：repo README 第 119-144 行给了两个仓库（2.5 → `checkpoints`、2 → `checkpoints_2`）与 modelscope 备选，HF 仓库 README 第 70 行写着 `hf_cache` 首次运行下载；第 1 步 probe 已把这些命令提取成 `downloader_cmds`（带 `dir` 落点）。**四台对比**：`synth` 子命令只有 indextts2.5 有（spark-tts 无子命令、fish-audio 是 python 形态、gpt-sovits 旧格式）⇒ 子命令不能做成必填；`models.required` 四种写法（fish-audio 写仓库名 `s2-pro`、gpt-sovits 写两个目录、spark-tts 写 28 条文件、indextts2.5 由下载扫盘生成）⇒ 没有统一的「引擎声明必需文件」来源。**做法**：当可见命令里出现多个仓库时，显示「嗅探全部仓库（N 个）」与一句提示（权重可能分散），按 `来源:仓库` 去重后逐个调 `loadManifest`，清单追加后一起下载。**边界**：这是串接的第一步；「声明齐 / 真跑通」两个结论分区、`install-state` 与 `verify` 的落点口径统一尚未做。**回归**：守卫与构建 65 条全绿；CI 双绿（windows + ubuntu，run `42404508617`） | |
| **A92** | ⭐⭐ **权重落点统一按名片判；权重结论不再暗示能出声** | ✅ **2026-11-08 已做**（`96141184`）· 🔴 `core/checkpointsPath.js`（`resolveCheckpointsRel`）· 🔴 `core/installState.js`（按名片落点扫盘）· 🔴 `editor/StepVerify.jsx`（通过时的提示） | [实测 2026-11-08] **起因**：同一台引擎的权重状态有两套口径。`installState` 用固定的 `engines/<id>/checkpoints` 扫盘，第 5 步的 `checkpoints` 用名片 `runtime.checkpoints` 判；旧名片把权重写在 `models/tts/<id>` 时，`install-state` 报 `done:false, ready:null`，`verify` 报 `ready:true`。**做法**：`checkpointsPath.js` 新增 `resolveCheckpointsRel(manifest, id)`：名片写了就按名片（只认相对项目根、拒绝绝对路径与 `..`），没写才回退统一落点；`installState` 读盘上名片、用它算 `weights` / `model_files` / `checkpoints_path` / `artifacts.checkpointsDir`。第 5 步权重项通过时补一句「名片点名的文件都在，这不代表能出声，用下面的 A 级校验真跑一次」，把「声明层」与「真跑层」分开。**实测**：四台逐个调 `installState`，旧名片那台从 `done:false, ready:null` 变为 `done:true, ready:true`、`checkpoints_path=models/tts/<id>`，其余三台不变。**边界**：第 3 步下载落点仍是统一路径（`download.js` 未改），名片落点与统一路径不同时，下载仍落在统一路径；这条留待下一批。**回归**：落点 / 安装状态 / 守卫 / 构建 74 条全绿；CI 双绿（windows + ubuntu，run `42410709799`） | |
| **A93** | ⭐⭐ **第 3 步下载落点按名片 `runtime.checkpoints`** | ✅ **2026-11-08 已做**（`ef8debb1`）· 🔴 `core/download.js`（`weightsDir` 与三处调用）· 🔴 `editor/StepsExtra.jsx`（存放位置说明） | [实测 2026-11-08] **起因**：A92 只把「判定」改成按名片，第 3 步「写盘」仍固定 `engines/<id>/checkpoints`。名片把权重写在别的目录时，下载落在一个没人读的路径，第 5 步仍报缺。**做法**：`download.js` 新增 `weightsDir(root, id)`，读 `engines/<id>/manifest.json` 取 `runtime.checkpoints`（非法路径回退统一落点）；写盘（`downloadFileFromUrl`）、核对（`checkFileStatus`）、删半截（`removePartialFiles`）与命令落点替换（`unifyDest`）四处统一走它。第 3 步「存放位置」补一句「名片声明了 runtime.checkpoints 时按名片」。**实测**：`unifyDest` 喂三台，旧名片那台替换成它声明的目录，其余两台与不存在的 id 都回退默认落点。**过程**：首轮漏了 `removePartialFiles` 一处，被 `downloadIntegrity` 的 8 条用例以 `checkpointsAbsPath is not defined` 拦下，补后全绿。**回归**：下载 / 落点 / 安装状态 / 守卫 / 构建 154 条（153 通过、1 跳过）；CI 双绿（windows + ubuntu，run `42463455937`） | |
| **A94** | ⭐⭐ **布尔参数补否定式声明；扫描结果预填到合成参数** | ✅ **2026-11-08 已做**（`577a09dc`）· 🔴 `core/cli_help_extract.py`（`_click_records` / `_typer_records` / `_dual_flag` / `_click_choices`）· 🔴 `core/cliDraft.js` / `core/paramDigest.js`（`negative` / `choices` / `default` 递出）· 🔴 `editor/paramFields.js`（`boolStyle`、`withArgKey` 带 style）· 🔴 `editor/paramDrop.js` / `editor/paramType.js` / `editor/ParamRow.jsx`（boolean 子表）/ `editor/ParamDropZone.jsx` / `editor/editor.css` | [实测 2026-11-08] **起因**：click 的 `--x/--no-x` 是同一个开关的两种拼法（写 `--x` 为真、写 `--no-x` 为假、都不写用引擎默认），扫描把它当成一条 `value` 型开关，`flag` 直接是 `--x/--no-x`，命令行上拼出 `--x/--no-x False`。**实测四种写法**：缺 style 或 `style=value` 时，真值出 `--half True`、假值出 `--half False`；`style=boolean` 真出 `--half`、假不出词；`style=boolean_optional` 真出 `--half`、假出 `--no-half`。**做法**：① 扫描把双写法拆成主开关加 `BooleanOptionalAction`，否定式原样记下；`click.Choice([...])` 的候选一并读出（此前一条都读不到）；② 合成参数的类型仍是既有那个 `boolean`，按类型展开的子表只放一个勾选框「取消勾选时发送否定式开关」，右侧显示会发出的那个词（由 `--no-` 加开关名推出，只做显示）；③ 样式写进 `call.args[name].style`，换类型时跟着改，不再把布尔留在 `value` 上；④ 落点预填：候选值铺成选项表，数值与开关的默认值填进 `suggested_value`，文本不收默认值（上游的文本默认值常是示例句子）；⑤ 统一层此前把 `choices` / `default` 丢掉，一并补齐。**实测界面**（真 5199，fish-audio）：四个双开关行都显示勾选态与 `--no-x`；boolean 改 text 后子表消失且 style 变回 `value`；text 改 boolean 后 style 为 `boolean`；勾上否定式后变 `boolean_optional`。**回归**：向导与全仓守卫 133 条全绿；CI 双绿（windows + ubuntu，run `42474422615`） | |
| **A95** | ⭐⭐ **权重落点在唯一模型子目录时下探一层** | ✅ **2026-11-08 已做**（`845827d7`）· 🔴 `editor/scanAutofill.js`（`flatFiles` / `topDirs` / `singleDir` 与三条提示文案）· 🔴 `test/computeAutoFill.node.test.js`（三条判据各一例） | [实测 2026-11-08] **起因**：fish-audio 的权重都在 `checkpoints/s2-pro/`，父目录下没有权重文件，而开关收的是「某个模型目录」。自动填写只写 `{checkpoints}`，每次都要人补一层；漏补的表现是引擎启动时找不到 `config.json`，且平台不会报错。**为什么不叫「多权重」**：盘上四台里三台的 checkpoints 下有子目录，但只有 fish 需要点名子目录——spark-tts 的三个子目录是同一套模型的不同部件，引擎要父目录；indextts2.5 父目录里就有 `.pth`。**判据（只读盘上事实）**：父目录有权重文件 ⇒ `{checkpoints}`；父目录没有但有多个子目录 ⇒ `{checkpoints}`；父目录没有、只有一个子目录且其中有 ⇒ `{checkpoints}/<该子目录>`。**实测**：临时移走 fish 名片从零重扫，自动得到 `--checkpoint-path {checkpoints}/s2-pro`，`models.required` 同步为 `s2-pro/…` 前缀；indextts2.5、spark-tts 的判定不变。**结论**：这不是新能力，`hostProfile` 本来就允许 `{checkpoints}/文件名` 这种带尾巴的写法，缺的只是嗅探。**回归**：144 条全绿；CI 双绿（windows + ubuntu，run `42478820335`） | |
