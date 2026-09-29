# 引擎接入 —— 现状台账

> **本文件是进度的唯一真相。** 做完一刀，当场改下面那张表的「状态」格。
> ⛔ 不许把状态记在别处（记忆、聊天、口头）——那些地方与仓库分叉过一次，
> 代价是整节契约被自己推翻重推。
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
| **A4** | GSV 迁新版声明 | ⬜ 待开 | [实测] GSV 无 `call` 段，`runtime.entry` = `lib/inference/infer_server.py` | **平台今天有两套推理实现并存**。高成本，不阻塞接新引擎 |
| **A5** | `input.text.parameter` 落地 | ⛔ **实测不可做** | [实测] `deriveTextBinding` 实现是 `{...m, maps:{text:p}}` ⇒ **maps 被整体替换** | 只能表达「只有一个输入概念」的引擎。GSV 有 10 个映射、IndexTTS2 有 4 个，**两台都无法用 input 表达**。要么扩语法，要么承认为死胡同 |

### B 组 · 多模型 / 资源占用

| # | 事项 | 状态 | 证据 | 备注 |
|---|---|---|---|---|
| **B1** | `MAX_LAUNCH_SLOTS = 1` | ⚠️ **已定位，未修** | [实测] `probe_max_launch_slots2.cjs`：两个 launch 位 → ⛔ 抛 `ENGINE_TOO_MANY_LAUNCH_SLOTS`，spawn 0 次；**两个 call 位不受影响** | ⭐ 天花板确认。⚠️ **拒绝在第一次合成时**，不在装引擎时（`registry.js`/`profile.js` 都不含它）⇒ 装得上、界面正常、点合成才炸。⚠️ 写它时**零测试覆盖**，上表是本次补的 |
| **B2** | launch 位只能换目录 | ⬜ 待开 | [读码] `{checkpoints}` 只有一个占位符 | B1 的根因：一个进程只有一个底模目录 |
| **B3** | `cap` 降级成护栏 | ✅ **2026-09-29 已修** | [实测] `cap.node.test.js` 16 条 + 6 条变异全抓住。**B3 之前 cap 只有夹具值、零行为测试**（改完 1633 条全绿 = 没有测试在看它） | 判据是 `needMb == null`（**不知道**），不是「内存够不够」。<br>⭐ cap 自动算：**总内存 / 8G**（8G→1 / 16G→2 / 32G→4 / 128G→16），`AURIVOX_ENGINE_CAP` 可覆盖 |
| **B4** | 端口归零 | ✅ **2026-09-29 已做（stdio）** | [实测] 提交 `2fe41e7`：`stdio_transport.py` + `stdioTransport.js` + `host.py --stdio`；真 IndexTTS2 `ready 60.5s`、`/tts` 出 270380 字节 WAV、`netstat` 确认 9881 无人监听；1690 测试全绿 | ⭐ **命名管道那套已按 Owner 裁决删除**（半双工 / nMaxInstances 配额 / createConnection 被静默忽略）。⚠️ **不接默认**，要走得显式 `buildLaunchPlan({transport:'stdio'})`。⚠️ 已知限制：严格串行 —— 但 `host.py:795` 的 `infer_lock` 在 HTTP 下也是一台一次一个 infer，**没有牺牲任何现有能力** |
| **B5** | 占用对用户可见 | ✅ **2026-09-29 已做完（后端+UI）** | [实测] `lib/engines/occupancy.js` + `GET /api/engines.occupancy`；26 条测试 + 10 条变异全抓住 | ⭐ **报「历史峰值」而不是实时读数** —— Owner 纠正：峰值就是 OOM 风险本身，Linux 上实时读数反而最危险（OOM killer 正在杀进程时读到的是崩溃中的数）。⛔ 字段名必须叫 `peak_mb`，不许叫 current/rss。✅ **前端已画**（顶部总览 + 每台徽章） | ⭐ UI 接线见提交 `100e85e`：23 条测试 + **10/10 变异全抓住**。⚠ 接线测试抓到两个「全绿但功能不存在」的真 bug（形状对不上 / 峰值恒为 0）。

### C 组 · 验收能力

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| **C1** | 第三道校验「出得了声」 | ✅ **2026-09-29 已做** | [实测] `lib/engines/verify_audio.py` + `verifyAudio.js` + `tools/verify-engine.cjs`；15 条 node 测试 + `tools/dev/probe_verify_audio.py` **7/7 判别力实测**（假宿主，行为已知） | ⭐ A/B 两级【Owner 裁决】：**B 级**宿主拿到合法响应（快、不吃显存、验「谈得拢」）、**A 级**真跑一次合成拿非空 WAV。⭐ A 级**先跑 B**（宿主没就绪时直接发 /tts 得 503，那结果与「声音不对」长得一样）。⭐ WAV 体检看**有没有帧** —— 44 字节空 WAV 能播 0 秒，界面上看不出异常。⬜ **A 级尚未在真引擎上实跑过**（需起 IndexTTS2，占 8.5GB） |
| C2 | Flow 默认关闭 | ✅ 已裁决 | [实测] 需 `FLOWGRAPH_ENABLED=1`。§12.12「两套节点表」已裁决不排期 |
| C3 | 训练管线绑死 GSV | ⛔ **Owner 2026-09-29 裁决：暂不做** | [实测] `pipelineIdentity.js:62` `TRAINING_ENGINE_ID='gpt-sovits'` | ⭐ **Owner 原话：「暂时还没见过其他开放微调的 TTS，所以暂时不做」** —— 训练/微调这条路今天只有 GSV 一条线，绑死不构成问题；等真有第二个可微调引擎再说。⚠ **不做 ≠ 不用记**：这一格留着，避免下一个人以为它已经做完了。 |

### D 组 · 文档

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| **D1** | README 目录导览过期 | ✅ **2026-09-04 已修** | [实测] `vendor/tts/` `vendor/gsv-tools/` `tools/checks/` 均已不存在；`outputs/flowgraph/` 实为 `_flow_runs/`；模型文件表把 GSV 写成了平台约定 |
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

### 当前偏差（2026-09-29 实测）

| | |
|---|---|
| 根 `venv/` | 6.6GB，⛔ **装着 GSV 的 torch 2.2.0+cu121 + CUDA 全套** |
| `engines/gpt-sovits/` | ⛔ **没有 `.venv`**，名片 `runtime.python: venv/Scripts/python.exe` 指根 venv |
| `engines/indextts2/.venv` | ✅ 7.9GB，**已是正确形态**（独立、版本自定） |
| `bootstrap.ps1` | ⛔ 步骤 3-4 **无条件**装 requirements.txt(200 包) + `install_torch.ps1`(CUDA 12.1) |

⚠️ **实测的平台重依赖分布**（`git grep` 量出来的，不是推断）：
- `routes/*` → **零**重依赖 ✅
- `lib/`（除 `lib/inference/`）→ **只有 `lib/engines/host.py` 一处** import numpy/torch，
  而它跑在**引擎自己的 venv** 里 ⇒ 平台 venv 不需要它
- `lib/inference/*`（7 文件）→ torch/librosa/soundfile/numpy/TTS/gsv_code/config_repair
  ⇒ **全是 GSV 专有**

⇒ **平台瘦下来在技术上成立**，且可验。

---

## 4. 下一刀

**待定。** 候选顺序与理由：

```
第一梯队   A3 → A2 → A1    解锁接入新引擎（三者一组，缺一另两没法定型）
           D1               ✅ 已完成

第二梯队   C1               唯一关键路径欠账，也是 B4 的验收器
           A4               兑现「兼容全部」

第三梯队   B3 → B5          资源占用的用户可见部分
           B4               端口归零（治存在感）
           B1 + B2          拆「多模型」天花板
           A5 / C3 / E3 / E4
```

✅ **B1 已于 2026-09-04 实测**（见第 2 节）。结论：撞墙点在**第一次合成**，
不在装引擎 ⇒ A1 做完仍然可用，只有真需要两个 launch 位时才炸。

---

## 5. 维护纪律

1. **做完一刀，当场改第 2 节那张表的状态格。** 不许记在别处。
2. **证据分级**：`[实测]` / `[读码]` 必须标。读码不等于跑过。
3. **不许把「已实现」写成「已验证」**——本项目最贵的 bug 都是这两者的差。
4. **台账只减不加会漏**：「该删的还剩几行」量不到「该接的还没接」。
   C 组那些 0 成本的条目当初就不在表上，正是这个原因。
