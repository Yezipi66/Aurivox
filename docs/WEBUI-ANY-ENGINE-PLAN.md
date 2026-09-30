# WebUI 全引擎兼容 —— 实施计划

> 分支：`feat/webui-any-engine`
> 基线：`45586c9` · `1740 tests / 1740 pass / 0 fail / 1 skipped`
> 建立：2026-10-01
> 状态：✅ **三点全部完成**（2026-10-01，Owner 批准自主执行）
>
> | 点 | 提交 | 结果 |
> |---|---|---|
> | 1 多方法透出 | `4a0964e` | ✅ 12 条新测试 + 3 变异 |
> | 2 对比页按名片 | `60a6fbb` | ✅ 11 条新测试 + 7 变异 |
> | 3 Broker 去硬编码 | `3afd1f8` | ✅ 15 条新测试 + 8 变异 |
>
> **未 push**（等 Owner 说）。全量 `1763 pass / 0 fail`，`npm run build` 绿。

---

## 0. 目标与判据

平台对前端的承诺已经写在 `docs/ONBOARDING_PLAN.md` §0：

> 兼容全部 TTS。验收形式：**加一个引擎 = 一个目录 + 一张名片，
> `lib/` / `server.js` / `web/` 一个字不改。**

⭐ 本计划不是新增承诺，而是**兑现已有承诺里前端那半边**。

**Owner 2026-10-01 追加的范围界定**：

> 「对于前端来说，用其他引擎，比如 IndexTTS2 和 CosyVoice，和 GSV 是同样的功能吗？
> 当然以上两个没有开放官方的微调，也就是只是不能微调，微调页面的预处理以及
> S1 和 S2 后面的走不通了，但是按理来说其他的还是可以被兼容的。」

⚠️ **refine 不在这份计划里**。`AssetsTab.jsx:728` 的注释自己已经写明：

> 「精修」是**那条训练管线**自己的事：它要继续训的正是它自己产的那两份权重
> ⇒ 引擎名在这里是这个按钮自己的题目，不是平台写死一台引擎。

没有微调就没有 refine，逻辑自洽 —— 平台**不需要**为非 GSV 引擎加 refine 入口。

---

## 1. 核实到的事实

⚠️ 口径与 `docs/ONBOARDING_PLAN.md` 一致：
`[实测]` = 本机跑出来的；`[读码]` = 读代码得出的，**未实机验证**。

### 1.1 已经能用的（不重做）

| 功能 | 证据 | 状态 |
|---|---|---|
| 合成 | `param_schema` 四台都有（6 / 2 / 14 / 16 项）[实测] | ✅ |
| 参数面板 | `GenerateTab.jsx` 10/10 函数全接 `lib/engines.js` [读码] | ✅ |
| 训练页显隐 | `showsTrainingTab(engine) = engine.supports_finetune === true`；`gpt-sovits:true` / `indextts2:false` / cosyvoice 无此键 [实测] | ✅ |
| 名片参数派生 | `parameters[]` → `param_keys` / `payload_keys` / `load_time` / `call_time` / `param_schema` [读码] | ✅ |
| 前端守卫 | `web/src/lib/engines.js` 30 函数 / 82 条真函数测试 [读码] | ✅ |

### 1.2 三个缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| **1** | **`call.methods` 到不了前端** | `manifest.call.methods` 有 5 个 → `resolveEngineProfile('cosyvoice2').methods` = **`null`** [实测] | 五种方法在界面上**选不到** |
| **2** | **对比页写死 GSV** | `ReferenceCompareTab.jsx` 26 行活代码；`CMP_ENGINE = 'gpt-sovits'`；6 个 `useState` 硬编码 `top_k/top_p/repetition_penalty/text_split_method/speed_factor/if_sr`；与 cosyvoice2 参数**交集 = 空** [实测] | 换 CosyVoice：格子照常显示、填了发出去**上游不认**、**不报错** —— 违反平台第 2 条纪律「不静默忽略」 |
| **3** | **Broker 写死引擎** | `BrokerTab.jsx:41 REBIND_ENGINE = 'gpt-sovits'`；`:284` 印 `top_k` [读码] | 重绑只对 GSV 生效；换引擎显示错的参数 |

---

## 2. 三个改动点

### 【点 1】多方法透出到前端

**为什么先做它**：点 2 的「每行切方法」依赖点 1。

| 文件 | 改什么 |
|---|---|
| `lib/engines/profile.js` | 装配 `call.methods` → `profile.methods`（名字列表）+ `default_method` |
| `lib/routes/engines.js` | `describeEngine` 吐出这两个字段 |
| `tools/dev/probe_host_methods.py` | 补一条：profile 交出 `methods` 且 `default_method` ∈ methods |

⭐ **2026-10-01 订正（读码后）**：本计划初稿写的是「`hostProfile.js` 补放行」——
**那是多余的**。`hostProfile.js:68-240` 已有完整的 `methods` / `default_method` 校验
（5 条顶层规则 + 逐方法 `method`/`bind`/布尔标志/`call_time` 校验），那是 2026-09-30
随 `call.methods` 一起做完的。

⚠️ `hostProfile.js` 的角色是**给引擎进程用**（`spawnEngine.js` / `launchPlan.js` 写盘
给 `host.py`），**不是**前端那条路。前端这条路是
`profile.js` → `lib/routes/engines.js:describeEngine` → `/api/engines`。
⛔ 别去改 `hostProfile.js`：那是两份装配，改重了会漂移。

**预期效果**：`/api/engines` 里 CosyVoice2 带 5 个方法名
（`sft` / `zero_shot` / `cross_lingual` / `instruct2` / `vc`），
GSV / IndexTTS2 无 methods 时为 `null`。

**验收点**
1. `resolveEngineProfile('cosyvoice2').methods` 有 5 个键 [实测]
2. `default_method` ∈ `methods` [实测]
3. GSV / IndexTTS2 → `methods` 为 `null`，**不抛** [实测]
4. `probe_host.py` 29/29 不退化 [实测]（`probe_host_methods.py` 维持 18/18：
   计划写的「加到 19」是因为初稿以为 profile 那段没测；实际那些断言改成
   `lib/engines/profile.node.test.js` 的 6 条真行为测试更合适 —— JSX 之外
   的纯函数就该有真行为测试，不是探针里的字符串匹配）
5. **变异**：装配整个删掉 → 红 11 条；「取第一个」代替 default_method →
   红 7 条；空 methods 当成没声明 → 红 3 条 [实测]
6. [实测] `cosyvoice2` → 5 个方法 / `cosyvoice-300m-sft` → 3 个；
   `gpt-sovits` 与 `indextts2` 为 `null` 且**不抛**

---

### 【点 2】对比页接名片参数面板

**Scope：只改 `web/src/components/compare/ReferenceCompareTab.jsx` 一个文件。**

| 改什么 | 依据 |
|---|---|
| `import { fieldsForTier, ParamField, initialParamValues, paramsToSend } from '../../lib/engines'` | 与 `GenerateTab` 同一套，**不新写一套** |
| 删 7 个 GSV 超参的 `useState`（759–764）+ `useEffect`（767–772）| 改由 `ParamField` 渲染 |
| 删 `CMP_ENGINE = 'gpt-sovits'`（190）与两处 `modelsFromMeta`（192–193）| 权重位不属于这页 |
| 请求体 6 个键 → `paramsToSend(engine, values)` | 现有函数 |
| 每行加 `method` 字段（依赖点 1）| `call.methods` 已通 |

**预期效果**：对比页的格子 = 当前引擎 `param_schema` 的 `common` 层。
- 选 CosyVoice2 → 出现 `prompt_text` / `instruct_text` / `spk_id`，**不出现** `top_p`
- 选 GPT-SoVITS → 仍能改 `temperature` / `top_p` / …（`param_schema` 里有）

**验收点**
1. ⭐ **假引擎判据**：造一台参数叫 `wobble` / `flavour` 的引擎，对比页**必须**出现
   `wobble` 且**不出现** `top_p`（沿用 `lib/engines/fakeEngine.node.test.js` 的判据：
   「装一台谁都没见过的引擎，web/ 一个字都不用改」）
2. 每行能选方法（5 方法的引擎出现下拉；单方法的引擎不出现）
3. ⭐ **接线判据**：随便挑一个渲染点删掉 `engineId`，**必须有测试变红**
   （`ENGINE_ONBOARDING_CONTRACT.md` §9 的 E1 判据：`npm run build` 绿不证明接线对）
4. GSV 用户仍能改那 6 个超参（不回归）[实测] `fieldsForTier(gsv,'common')`
   仍返回那 6 项
5. `npm run build` 通过 + 全量不退化 [实测] 1763 pass / 0 fail
6. [实测] 假引擎 `wobble` / `flavour` 出现、`top_p` 消失、`secret` 归 advanced；
   只发用户动过的 `wobble`，不发明明摆着的 `flavour`
7. [变异] 7 个全抓到：写死 `top_p` 键 / 本地 state 复活 / `row['top_p']` 下标 /
   接线断掉不传 `engine` / 方法下拉无视 `length` / 依赖漏 `engine.id` /
   `touched` 不存回 / `seed` 被删 / `cut5` 枚举写死

---

### 【点 3】Broker 去硬编码

**Scope：只改 `web/src/components/broker/BrokerTab.jsx` 一个文件。**

| 改什么 |
|---|
| `REBIND_ENGINE = 'gpt-sovits'` → 从配方 / 资产的 `engine_id` 读，或按当前选中引擎 |
| `:284` 的参数摘要 → 按 `paramsToSend` 的键渲染，或显示「N 个参数」 |

**预期效果**：非 GSV 的配方不再显示 `top_k`；重绑按钮按当前引擎判定。

**验收点**
1. 非 GSV 配方 → 参数摘要不出现 `top_k` [实测] CosyVoice2 配方摘要 =
   `prompt_text … · spk_id … · text_frontend …`
2. `BrokerTab.jsx` 活代码里搜不到 `'gpt-sovits'`（含 `REBIND_ENGINE` 常量）[实测]
3. GSV 现有行为不变（不回归）[实测] GSV 配方摘要仍含
   `temperature / top_k / top_p`
4. 全量不退化 [实测] 1763 pass / 0 fail

⭐⭐ **2026-10-01 订正（读码后）**：本计划初稿写的是「从配方的 `engine_id`
读引擎」。**配方顶层根本没有 `engine_id`** —— 配方格式这轮不动
（Owner 2026-08-30 的决定），`lib/routes/recipes.js` 里没有任何一处写它。
所以实际做法是两条：
  - 重绑面板的引擎身份，从**它钉的那份权重**反查（`engineOfRecipe()`）
  - 参数摘要**不按引擎身份过滤** —— 显示配方自带的键，不编配方没有的键
    （`paramsSummaryOf`，纯函数 + 8 条真行为测试）

这样反而更不容易错：「猜它是哪台引擎然后只显示那几个键」一旦猜错，
参数就消失了；而「配方里有的就显示」永远不会错。

---

## 3. 执行顺序与提交纪律

```
点 1（后端透出）→ 独立提交 → 探针 + 变异 + 全量
点 2（对比页）  → 独立提交 → 假引擎判据 + 接线判据 + 全量
点 3（Broker）  → 独立提交 → 全量
```

- **三笔原子提交**，每笔只表达一个完整能力
- 每笔都跑全量，**1740 不许退化**
- ⛔ 不 push（等 Owner 说）

---

## 4. 明确不做（防范围蔓延）

| 不做 | 理由 |
|---|---|
| `AssetsTab` 的 `canRefine` | refine 是训练的附属；无微调即无 refine（`AssetsTab:728` 注释自陈）|
| 训练链 / `lib/training/` | 微调只 GSV 有，平台已用 `supports_finetune` 正确处理 |
| Flow / `lib/workflow` | Owner 2026-10-01：WebUI 是主线，Flow 不急 |
| 重写 `web/src/lib/engines.js` | 30 函数 / 82 测试已合格，是唯一权威实现 |
| 改 `GenerateTab` | 已正确（0 处硬编码，10/10 函数全接）|
| 抽 ASR / UVR5 / 切片为独立能力 | ⚠️ Owner 2026-10-01 纠正：它们本就是训练页的独立板块（`TRAIN_STEPS`），不是绑死流水线 |
| 发行包审计 / 联网策略文档 | 另一条线 |

---

## 5. 已知遗留（本计划不解决，记下来）

| # | 事项 | 备注 |
|---|---|---|
| L1 | `requires_reference_audio` 是**单开关**，但 CosyVoice2 五个方法需求不同（`sft` 用 `spk_id` 不要音频）| 名片 `_comment` 已自陈是「A5 那笔账的第二个实例」|
| L2 | `lib/workflow` 与 `lib/flowgraph` 两套图引擎并存 | 纯前者的生产代码 0 引用（测试 100+ 条在跑）；Flow 线再议 |
| L3 | 对比页「多引擎并排」（每行不同引擎）| 本计划的点 2 只做到「每行跟随当前引擎 + 可切方法」；真正的每行独立选引擎是更大的功能 |
| L4 | 联网策略文档（`host.py` 注释说「宿主永远不该联网」，实际是「默认离线 + 用户可覆盖」）| |
| L5 | **配方顶层没有引擎身份**（`engine_id` / `weight_slots`）— 2026-10-01 点 3 读码发现 | Broker 现在靠「从钉的权重反查」定位引擎。配方格式升级（`schema_version` v4？）后应改为直接存 `engine_id` + 按位存权重，届时 Broker 可以直接渲染任意位数的引擎 |
| L6 | **只有一位的引擎画不出「两份权重两两组合」** — 点 2 发现 | 对比页和 Broker 的模型下拉都是「两个位」的形状（配方顶层只有 `gpt_ckpt`/`sovits_pth` 两个字段）。CosyVoice 只有一个 `model` 位 ⇒ 这两处现在都退化成单下拉。解法跟 L5 是同一件：配方升级到按位存 |
| L7 | **配方参数摘要不按引擎身份过滤** — 点 3 的刻意选择 | 名片上没有的键会**显示**出来（`unknown` 计数保留）。这是为了「那台引擎还没装进项目」时不静默吞参数。代价：摘要里可能混入这台引擎不认的键。解 L5 时应改成按 `engine_id` 过滤 |

---

## 6. 验收总表

| # | 标准 | 怎么验 |
|---|---|---|
| 1 | 全量 1740 不退化 | `npm run test` |
| 2 | 装一台谁都没见过的引擎，**对比页按它的名片长** | 假引擎 `wobble` 判据 |
| 3 | 多方法能选，且 `default_method` 有效 | 探针 + 变异 |
| 4 | 前端无 `'gpt-sovits'` 硬编码（活代码）| grep + 测试 |
| 5 | `npm run build` 绿 **且** 运行时接线对 | build + 接线判据（E1）|
