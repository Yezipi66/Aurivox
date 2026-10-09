# 引擎接入 · 实施计划（2026-10-09 起草）

> 分支：`research/engine-onboarding-complexity`
> 依据：[`ENGINE_ONBOARDING_RESEARCH_CONCLUSION.md`](./ENGINE_ONBOARDING_RESEARCH_CONCLUSION.md)
> 口径：`[实测]` = 本机跑出来的 · `[读码]` = 读代码得出 · `[待裁]` = **还没定，别当结论用**
>
> ⚠️ **本文件是提案，Owner 审阅通过后才执行。**

## 执行流程（Owner 2026-10-09 定）

```
1. Owner 审阅本计划 → 批准某一步
2. 派子 Agent 执行该步
3. 派【独立子 Agent】审阅产物（不许是执行的那个）
4. 审阅通过 → 修改本文件该步状态 → git commit → git push
5. 再进下一步
```

---

## 0. 目标与三条约束

**让「接一台新引擎」从「手写 46 个字段」变成「确认一份自动生成的草稿」。**

约束（不可违反）：
- ⛔ **不损害模型能力** —— 名片漏一个参数 = 用户永远看不到它（平台不兜底）
- ⛔ **平台是传话筒** —— 不校验、不判断、不替引擎补默认值
- ⛔ **`lib/` 的四个文件不许出现引擎名**（`registry.js` / `payload.js` / `profile.js` / `web/src/lib/engines.js`）

---

## 1. ⭐ 实测结论（决定本计划怎么排）

### 1.1 三个难点重排为两个

| 原难点 | 实测结论 |
|---|---|
| 一 · 找全参数 | 🔴 **真正的战场** |
| ~~二 · 映射到平台~~ | 🟢 **基本自动** —— `[实测]` 纯名字启发式 GSV 命中 8/10、CosyVoice2 命中 4/4 |
| 三 · 引导用户填 | 🟡 有 5 种可借鉴形式 |

**映射为什么不难**（Owner 指正，实测印证）：
- **(a) 平台词的含义** —— **GSV 定义**（前端按 GSV 写），⛔ 不需要人
- **(b) 引擎参数 → 平台词** —— ✅ 大部分自动；未命中的真因是「参数没找全」，不是「名字猜不准」

⇒ **映射降级为第 1 步的附属产出，不单独成步。**

### 1.2 ⭐ 前提：第 4 步时一切都在本地（Owner 指正，我原先搞错了）

```
第 1 步 prepare  → git clone 到 engines/<id>/    ⇒ 源码在本地
第 2 步 env      → 建 engines/<id>/.venv          ⇒ 环境在本地
第 3 步 models   → 下底模                        ⇒ 权重在本地
第 4 步 manifest → 写名片 ← 上游的一切都已在磁盘上
```

⇒ ⛔ **不需要联网、不需要 GitHub API。**
⇒ **兜底**：第 4 步发现引擎目录不存在 ⇒ 让用户回第 1 步克隆，不继续。

### 1.3 GSV 是基线，也是唯一的「答案卷」

Owner 2026-10-09：「GSV 本来就是我们的基线。」

`[实测]` GSV 是 **dict 型**（`TTS.run(inputs: dict)`），反射只给 2 个参数
⇒ **第 1 步的产物不含 GSV**（它的参数提取不走反射这条路）。

⭐ **但 GSV 是唯一有人手写好 `maps` 的完整样本**（`[实测]` 10 条）：

```
text             ← text          text_lang        ← text_lang
reference_audio  ← ref_audio_path  reference_text   ← prompt_text
reference_lang   ← prompt_lang   aux_reference_audio ← aux_ref_audio_paths
speed            ← speed_factor  seed             ← seed
media_type       ← media_type    streaming        ← streaming_mode
```

⇒ **这 10 条 = 现成的答案卷。** 第 1 步的映射逻辑**拿它对**：
机器猜的和人写的对得上，才说明逻辑对。
**产物不含 GSV，但考题必须是它。**（CosyVoice2 只有 4 条，样本太小）

### 1.4 ⭐ 签名型引擎（主流）反射干净可用

`[实测]` 本机两台：

| 引擎 | 反射产物 | 质量 |
|---|---|---|
| IndexTTS2 | `infer()` 签名 **17 个具名参数** + `**kwargs` | ✅ 零噪音 |
| CosyVoice2 | 5 个推理方法；`zero_shot` 签名 **7 个** | ✅ 零噪音 |

两台 **docstring 全空**，但**签名本身就够** ⇒ **不依赖上游写注释**。

**⇒ 本计划只针对签名型引擎。** ⚠️ 未实测其他新引擎（F5-TTS / Fish-Speech / Spark-TTS 等），
所以第 3 步的端到端验证必须包含「**拿一台真实新引擎走通**」。

---

## 2. 三步（按依赖顺序，⛔ 不许跳）

```
第 1 步  反射 → 参数草稿（难点一）+ 映射候选（难点二附属）
              ↓
第 2 步  草稿展示 + 引导填对（难点三）
              ↓
第 3 步  端到端验证（拿 index-tts 这台真引擎走完）
```

---

## 第 1 步 · 反射 → 参数草稿 + 映射候选

### scope

把**已有的反射能力**接进向导第 4 步：反射目标引擎 → 产 `parameters[]` 草稿 →
**同时给出平台词候选** → 用户在界面上确认 → 落盘。

只做**签名型引擎**。GSV 是 dict 型（反射拿不到），**产物不含它**，
但它**是第 1 步的考题**（见 §1.3）。

### 要动的文件

| 文件 | 改动 | 性质 |
|---|---|---|
| `tools/engine-wizard/core/paramsFromReflect.js` | **新建** —— 把 `reflect_params.py` 的 JSON 转成 `parameters[]` 草稿（复用 `scaffold-params.cjs` 已有的排除名单与 `REPLACE_ME` 纪律）；内含平台词候选（名字启发式打分） | 新文件 |
| `tools/engine-wizard/core/wizardbridge.js` | 加端点 `POST /wizard/params`，注册进 `HANDLERS` | 小改 |
| `tools/engine-wizard/editor/ManifestForm.jsx` | 加「从源码反射生成」按钮；映射候选单独一栏展示（⛔ 不自动写入 `maps`） | 中改 |
| `tools/engine-wizard/test/paramsFromReflect.node.test.js` | **新建** —— 真行为测试（喂真 JSON，验草稿形状） | 新文件 |

⛔ **不动** `lib/` 任何文件（反射器已在 `lib/engines/reflect_params.py`，直接用）

### 预期效果

- 第 4 步有一个按钮，点一下 → 列出该引擎的可调参数（含默认值、类型线索、**来源标注**）
- 每条标 `_needs_review`（`[实测]` 名字线索是弱证据：16 个 call 参数里 8 个类型 unknown）
- 平台词候选单独列出（如 `spk_audio_prompt` → 建议 `reference_audio`），**人点选后才写 `maps`**

### 验收点（⛔ 必须是真实执行输出）

| # | 验收 | 判据 |
|---|---|---|
| 1 | 对 **index-tts** 反射 → 草稿 | 产出 **≥17 条**（签名有 17 个具名参数） |
| 2 | 对 **cosyvoice2** 反射 → 草稿 | 产出 **≥13 条** |
| 3 | ⭐ **映射候选命中答案卷** | 拿 **GSV 人手写的 10 条 `maps`**（§1.3）当考题，候选至少命中 **8 条**（`[实测]` 纯启发式已达 8/10）—— 考题是 GSV，产物不含 GSV |
| 4 | **平台词混入要排除** | 草稿里**不得**出现 `format` / `split` / `concat` / `silence_ms` / `engine_batch`（`[实测]` 这些是平台自己的词，曾混进 GSV 提取结果） |
| 5 | **不自动落盘** | 按钮只填表单，⛔ 不直接写 `manifest.json` |
| 6 | ⭐ **变异测试** | 把映射启发式去掉 ⇒ 验收 3 的测试必须变红 |
| 7 | `npm test` 不退化 | 新增失败 = 0 |

### 风险与缓解

| 风险 | `[实测]` 依据 | 缓解 |
|---|---|---|
| CLI 源混入工具层开关 | index-tts 的 CLI 独有 28 个里一半是 `batch_file`/`concat`/`dry_run` | **本步不用 CLI 源**，只用反射 |
| `**kwargs` 里藏参数 | IndexTTS2 的 `generation_kwargs` 反射显式跳过 | 标「变长参数，未展开」，**如实说明**，不猜 |

---

## 第 2 步 · 草稿展示 + 引导填对（难点三）

### scope

第 4 步表单每个字段告诉用户「**填什么格式 + 例子 + 填错会怎样**」。
⛔ **只做展示，不做任何校验**（平台是传话筒）。

### 要动的文件

| 文件 | 改动 | 性质 |
|---|---|---|
| `tools/engine-wizard/core/fieldmeta.js` | 每个字段补三件套 `format` / `example` / `onError` | 中改 |
| `tools/engine-wizard/editor/ManifestForm.jsx` | 渲染三件套 | 小改 |
| `tools/engine-wizard/test/styleguard.node.test.js` | 视需要补守卫 | 视情况 |

⭐ **数据来源**：`[读码]` **`profile.js` 每条抛错本身就写着「应该写什么」**
⇒ **搬运已有文案，不是新写。**

### 预期效果

- 每个必填字段下方能看到「填什么格式 + 例子」
- 高危字段（`[实测]` 14 个静默失效字段）挂 `.badge-warn`
- ⛔ **界面上没有任何新增校验逻辑**

### 验收点

| # | 验收 | 判据 |
|---|---|---|
| 1 | 至少 **10 个字段**有 `format` + `example` | grep `fieldmeta.js` 可数 |
| 2 | ⭐ **文案来自平台已有抛错** | 至少 3 条 `onError` 能在 `profile.js` grep 到原句 |
| 3 | ⛔ **没新增平台侧校验** | `git diff lib/` 为空 |
| 4 | 静默失效字段有警告标 | `[实测]` 那 14 个字段有 `.badge-warn` |
| 5 | `npm test` 不退化 | 新增失败 = 0 |

---

## 第 3 步 · 端到端验证

### scope

**用 `engines/index-tts` 当真样本**（它现在**没有 `manifest.json`** —— 最干净的试验田），
走完整条链：克隆（已完成）→ 反射 → 草稿 → 用户确认 → 落盘 → 平台认它。

### 要动的文件

⛔ **不写新功能代码。** 这一步是**验证 + 记录**。
产物：`docs/ENGINE_ONBOARDING_E2E_INDEX-TTS.md`

### 预期效果

- 一张由「反射 + 人工确认」产出的 `engines/index-tts/manifest.json`
- 平台能解析它（`resolveEngineProfile` 不抛）
- 记录：哪一步卡住、哪些字段不得不人填、自动填了多少

### 验收点

| # | 验收 | 判据 |
|---|---|---|
| 1 | 端到端跑通 | `engines/index-tts/manifest.json` 存在且 `resolveEngineProfile('index-tts')` 不抛 |
| 2 | ⭐ **自动填写率** | 记录「平台自动填 N 项 / 人工填 M 项」—— 真实数字 |
| 3 | ⭐ **卡点清单** | 记录每步哪里卡住（下一轮的输入） |
| 4 | `npm test` 不退化 | 新增失败 = 0 |

---

## 3. 明确不做（本轮）

| | 理由 |
|---|---|
| **dict 型引擎自动提取** | `[实测]` 准确率 54%~75%，且 GSV 已人工搞定 |
| **CLI 源** | `[实测]` 与签名只重叠 3 个，28 个独有里一半是工具层开关；过滤规则未设计 |
| **扩充平台词**（`speaker` 等） | `[待裁]` 未定，是衍生需求不是必需 |
| **第 5 步 verify** | 已有独立计划，不混进本轮 |
| **环境缺陷 3**（进度文件脱钩） | 已记录，单独一刀 |

---

## 4. Owner 裁决（2026-10-09 已定）

| # | 裁决 | 结论 |
|---|---|---|
| 1 | 三步都做？ | ✅ **都做**，按 §2 顺序 |
| 2 | 第 1 步含映射候选？ | ✅ **含** —— 拿 GSV 的 10 条 `maps` 当考题 |
| 3 | 第 3 步样本引擎？ | ✅ **index-tts** —— 它没名片，最干净 |

---

## 4.1 遗留待裁（非本轮必需）

**是否扩充平台词**（`speaker` 等）—— `[待裁]`，第 3 步端到端时如果撞到再议。
`[读码]` 若要做：改 `payload.js:48-50`（`CANONICAL_KEYS` **只有一份定义**）
+ `payload.node.test.js` 用真名片做夹具 + `registry`/`profile` 守着"不许引擎名"
⇒ 是**契约变更**。

---

## 5. 本计划的不确定处

1. **签名型引擎结论只实测了 2 台**（IndexTTS2 / CosyVoice2），且都是本仓库内的。
   换真新引擎（F5-TTS / Fish-Speech 等）**未验证** ⇒ 第 3 步就是为补这个
2. **映射候选的 8/10** 是在 GSV（唯一有人手 `maps` 的完整样本）上测的；
   CosyVoice2 是 4/4 但只有 4 条 —— **样本都小**，第 3 步端到端再补
3. **「平台词混入」排除名单**（`format`/`split`/`concat`…）从 GSV 实测归纳，
   **未做成完整清单**，可能漏
4. **第 2 步「搬运 `profile.js` 抛错文案」** 没逐条数过有多少条能直接搬

---

## 附：步骤状态

| 步骤 | 状态 |
|---|---|
| 第 1 步 反射 → 草稿 + 映射候选 | ⬜ 待 Owner 批准 |
| 第 2 步 草稿展示 + 引导 | ⬜ 待第 1 步完成 |
| 第 3 步 端到端验证 | ⬜ 待第 2 步完成 |
