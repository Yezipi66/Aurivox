# 外围契约化重构计划（三刀）

> 状态：计划，已按 Hark 评审修订（2026-10-31），未开工。每一条“现状”都标了证据；标 `[实测]` 的是跑过的，`[读码]` 的是从代码读的。
>
> 跟踪 issue：[#26 外围契约化重构：让名片成为唯一事实源（三刀计划）](https://github.com/Yezipi66/Aurivox/issues/26)
>
> 目标一句话：**把“平台替 GSV 适配的外围”收敛成名片的派生物，让第二台引擎不需要改 `lib/` / `web/`。**
>
> 原则：不新增抽象层。现有的 `profile → paramTable → payload → residency` 就是那一层；
> 本计划做的是**删掉绕过它的主路径**，再给确实缺失的契约补字段。

---

## 0. 先记录一个必须修的现状（P0）

`/api/generate` 把一切非 GSV 参数静默丢掉，`method` 也丢。

复现（临时探针，跑完即删；结果 `[实测]`）：

```
res.ok              = true
cfg.x               = undefined
cfg.engine_params   = undefined
⇒ 参数到达引擎了吗  = undefined
```

原因：

- `generateService` 的 `cfg` 是从写死的 GSV 字段清单拼的：
  [lib/services/synthesisService.js:60-97](../lib/services/synthesisService.js#L60)
- `engine_params` 只被校验、回写回 `req.body`，从未进 `cfg`：
  [lib/services/synthesisService.js:143-195](../lib/services/synthesisService.js#L143)
- `buildTtsPayload` 读的是 `cfg.engine_params`：
  [lib/server/synthesis.js:98](../lib/server/synthesis.js#L98)
- Compare Refs 已经在下拉里选方法并发送 `method`：
  [web/src/components/compare/ReferenceCompareTab.jsx:369](../web/src/components/compare/ReferenceCompareTab.jsx#L369)
- `host.py` 已经支持 `body["method"]`：
  [lib/engines/host.py:969](../lib/engines/host.py#L969)
- Flow 的引擎节点适配器调的就是 `generateService`：
  [lib/flowgraph/adapter.js:100-121](../lib/flowgraph/adapter.js#L100)
  （`known` 平铺一份、`engine_params[engineId]` 一份，两路都会被同一个 cfg 漏掉。）
- 中间的服务层既不认也不转。

对照：`/v1/audio/speech` 是通的——`cfg` 由名片 `param_schema` 循环生成，
并显式 `cfg.engine_params = callEngineParams`：
[lib/routes/synthesis.js:330-361](../lib/routes/synthesis.js#L330)。

> 这也说明 `docs/ENGINE_ONBOARDING_CONTRACT.md` §0 里“推理链 ✅ 兑现”的证据
> `fakeEngine.node.test.js` 只证明“界面能按名片长面板”，没有证明“参数到达引擎”。
> 本计划第一刀完成后，把那行证据改掉。

---

## 1. 硬约束（每一刀都必须满足）

1. **GSV 行为逐字节不变**（唯一允许的例外：缓存指纹版本升级导致冷启动一次）。
2. **名片是唯一事实**：`lib/` 与 `web/` 里不出现任何引擎 id、槽位名、引擎私有参数名。
3. 平台词表不扩：CORE / OPTIONAL 仍是那 10 个词；`method` 作为“调用入口选择”单独处理，不进 canonical。
4. 不改训练/Refine 管线、不改部署脚本、不搬 `lib/inference`。
5. 每一刀独立可合并、独立可回滚；测试红即停，不许带着红测试进入下一刀。
6. 每加一条通用路径，必须同时加一条“非 GSV 引擎走通”的测试；只测 GSV 等于没测。

---

## 2. 开工前的基线（只记录，不改代码）

1. `npm test` 全绿，保存输出（runner：[tools/run_tests.cjs](../tools/run_tests.cjs)）。
   2026-10-30 已跑相关 5 个套件：146 pass / 0 fail
   （`synthesisService.engine`、`synthesis.enginePayload`、`segmentCache`、`slotPicks`、`profile`）。
2. 用固定请求抓一份 GSV 基准：
   - 文本：`你好，世界。`
   - 音色：任一可用音色；`engine_id: "gpt-sovits"`；固定 `seed`
   - 记录：最终 `payload`（`buildTtsPayload` 的返回）、`meta`、输出 wav 时长、
     **`segmentCache` 指纹**（第一刀不应改变它：指纹取的是 payload，而 GSV 名片的 `defaults`
     与今天写死的值逐项相同）
   - 存放：`lib/services/__fixtures__/gsv-baseline.json`（新建，仅测试用）
3. 浏览器手工三点验收（改前各跑一次，记下现状）：
   - Generate：能出声，参数面板可改
   - Compare Refs：两槽位下拉、单行生成、全部生成
   - Flow：`FLOWGRAPH_ENABLED=1` 下一个引擎节点能合成
   - 若 Flow 本机起不来，标注“待验证”，不阻塞第一刀，但第一刀不能宣称 Flow 已验收。

---

## 3. 第一刀：接线（最高价值，最小爆炸半径）

### 3.1 范围

让 `/api/generate` 的参数装配与 `/v1` 共用同一套名片契约。

**只改装配，不改语义；平台字段一个都不动。**

### 3.2 文件级改动

| 文件 | 改什么 |
|---|---|
| [lib/services/synthesisService.js](../lib/services/synthesisService.js) | 把 `cfg` 拆成四段拼装（见 3.3）；`method` 进 `cfg`；`engine_params` 进 `cfg`；删除 141 行过时注释（“webui 老路径不发 engine_id”已不成立：今天缺 `engine_id` 直接 400） |
| [lib/server/synthesis.js](../lib/server/synthesis.js) | `buildTtsPayload` 末尾按名片注入 `method`（仅当 `profile.methods` 含该值） |
| [lib/engines/payload.js](../lib/engines/payload.js#L76) | 第 3 步跳过 `maps` 的值（平台占用的引擎原生键），禁止配方格子反超平台语义（见 3.3 出口守卫） |
| [lib/engines/paramTable.js](../lib/engines/paramTable.js) | `PLATFORM_REQUEST_KEYS` 增加 `method`（voices PUT / workflow 适配器不丢） |
| [lib/services/synthesisService.engine.node.test.js](../lib/services/synthesisService.engine.node.test.js) | 增加断言；不改既有断言 |
| 新增 `lib/services/synthesisService.params.node.test.js` | 非 GSV 参数端到端、平台键不被格子反超 |
| 新增/扩充 `lib/flowgraph/adapter.node.test.js` | 适配器 → 真实 `generateService` + 假引擎，断言参数到达 |
| 新增 `lib/services/__fixtures__/gsv-baseline.json` | 基线快照（含 payload 与指纹） |

### 3.3 cfg 的拼装顺序（写死，评审重点）

```
1) knobs     = 请求体里出现、且在本引擎 param_schema 里的键（按 schema type 归一）
2) slots     = 请求体里本引擎每个 weight_slot 的 slot.param 值
3) platform  = reference_audio / reference_text / text_lang / prompt_lang / speed_factor /
               seed / media_type / aux_ref_audio_paths / pron_overrides / lang_overrides /
               auto_base_lang / force_resynth / launch_weights        ← 与今天逐字相同
4) engine_params = 本引擎那格去掉 phase=load 的键
```

- 顺序固定为 `knobs → slots → platform → engine_params`：`speed_factor` / `seed` / 参考音频是平台语义，必须压过同名旋钮。
- **不写任何默认值**：未出现的键保持 `undefined`，由 `buildTtsPayload` 第 4 步用名片 `defaults` 填。
  已核对：GSV 名片的 `defaults` 与今天写死的值逐项相同（`temperature 1`、`top_k 15`、`top_p 1`、
  `repetition_penalty 1.35`、`text_split_method cut5`、`batch_size 4`、`batch_threshold 0.75`、
  `split_bucket true`、`fragment_interval 0.3`、`parallel_infer true`、`streaming_mode false`、
  `media_type wav`）。
- 类型归一沿用 [lib/engines/paramTypes.js](../lib/engines/paramTypes.js)：
  `number` + integer 味 → `parseInt`，其余 `number` → `parseFloat`，`boolean` → `!!`，其余原样。
- `method`（与宿主同口径，不另写一份规则）：
  - `profile.methods` 是**非空列表**（多方法引擎）：请求值必须在表里，否则 400 并列出可用值；请求没给就不注入，交给宿主用 `default_method`。
  - `profile.methods === null`（单方法引擎）：服务层不拦。请求带了 `method` 就原样透传；值与 `call.method` 不同时由宿主返回 400
    （[host.py 的 `resolve_method`](../lib/engines/host.py#L1046) 是这条规则的唯一出处）。
  - GSV 没有 `call.methods` ⇒ `profile.methods === null`；GSV 的 `TTS_Request` 没有 `method` 字段、pydantic v2 静默忽略未知键（已核实），
    所以即便请求带了 `method` 也不改变 GSV 的输出。基线快照的请求不带 `method`。
- `engine_params`：沿用现有“别的引擎的格子 ⇒ 400”的校验，只把结果放进 `cfg`，不再只回写 `req.body`。

**出口守卫（payload 第 3 步）**

cfg 第四段允许装任意键，但真正出门时要防止它反超平台语义。
[lib/engines/payload.js:76-82](../lib/engines/payload.js#L76) 的第 3 步现在“一个键都不看”，
而 GSV 的 `payload_keys` 本来就含 `seed` / `speed_factor`：
配方格子只要带同名键，就会在 payload 里压过平台算好的 seed（meta 记平台值、引擎收格子值，Rerun 复现不了）。

规则：**第 3 步跳过 `maps` 的值**——即这张名片里由平台占用的引擎原生键
（GSV 的 `seed`、`speed_factor`、`ref_audio_path`、`prompt_text` 等），其它键照旧不过滤。
放在 `payload.js` 而不是服务层：`/api/generate` 与 `/v1` 都经过同一个出口，只修一处。

### 3.4 明确不做

- 不动 `text_lang` 的取值词汇（第三刀）。
- 不动 Compare Refs 的两槽位（第二刀）。
- 不动缓存指纹（第二刀）。
- 不动 voices / 配方格式。

### 3.5 测试与验收

**单元**

1. 假引擎（参数 `x`）经 `generateService`：`cfg.x` 有值，`generateOneSegment` 收到的 `cfg` 带 `engine_params`。
2. Flow 适配器 → 真实 `generateService`：`known` 与 `engine_params[engineId]` 两路都能到达假引擎。
   这一条把 Flow 从“人工待验证”升级成可回归的单测；Flow 与 P0 同根，第一刀合进去就一起修好。
3. `method`（与宿主同口径）：
   - 多方法引擎 `methods: ["zero_shot","vc"]` + `method:"vc"` ⇒ payload 有 `method:"vc"`；
   - 多方法引擎收到表外的值 ⇒ 400，一次推理都不发生；
   - 单方法引擎（`profile.methods === null`）收到 `method`：服务层不拦；同值放行、异值由宿主 400
     （用假宿主记录请求，断言“请求确实发出去了”，而不是平台抢答）。
4. 平台键不被格子反超：GSV 名片 + 平台 `seed=7` + 配方格子 `{seed: 42, speed_factor: 9}`
   ⇒ payload 的 `seed` / `speed_factor` 仍是平台值，且 meta 与 payload 一致。
5. GSV 基线快照：同一请求的 `payload` 与 `gsv-baseline.json` 深度相等；
   **同一次请求的 `segmentCache` 指纹与改前一致**（指纹取的是 payload，默认值逐项相同 ⇒ 第一刀不冷缓存）。

**集成（人工）**

6. Generate 页：改一个 GSV 参数（如 `top_k`）仍生效。
7. Compare Refs：单行与全部生成仍出声，`gpt_model/sovits_model` 仍被消费。
8. Flow：画布引擎节点带一个 `engine_params` 键，合成成功（本机起不来只影响这条人工项；第 2 条单测已覆盖接线）。

**验收口径**

- 一台参数名与 GSV 完全无关的引擎，从 WebUI 发起的参数**第一次**能到达引擎。
- GSV 的 payload / meta / 音色结果与基线一致。

### 3.6 回滚

单 commit；回滚 = revert 该 commit。不涉及数据迁移。

---

## 4. 第二刀：槽位（多槽位引擎真正能跑）

### 4.1 范围

把“换权重、算缓存、画对比、存配方字段”从 `gpt/sovits` 改成 `weight_slots` 的派生物。

拆成 4 个可独立提交的子步，顺序即依赖顺序。

### 4.2 子步 2a：换权重执行器通用化

**问题**

判据已经通用（`callSlots(engine).length > 0`：
[lib/services/synthesisService.js:307](../lib/services/synthesisService.js#L307)），
执行器只有 GSV：`/set_gpt_weights`、`/set_sovits_weights`
（[lib/gsv/modelState.js:61-98](../lib/gsv/modelState.js#L61)）。
GSV 的 `/tts` 不读 body 里的 `gpt_model`（[lib/inference/infer_server.py](../lib/inference/infer_server.py) 只有 `/set_*_weights`），
所以不能简单“删掉切换器、靠 payload 发过去”。

**契约加法（可选字段，老名片不受影响）**

```json
"weights": [
  { "name": "gpt", "param": "gpt_model", "applies_at": "call",
    "switch": { "endpoint": "/set_gpt_weights", "query": "weights_path" } }
]
```

- `switch` 只允许出现在 `call` 位；没有 `switch` = 这台引擎不需要额外请求（参数已随 payload 送到）。
- `switch` 只对 **HTTP 形态**的引擎有意义（`transport === 'http'`、`base_url` 非空）。
  stdio 引擎（PR #22 的通用宿主，`base_url === null`）的 call 位不写 `switch`：
  权重值随 payload 送进宿主，重不重载由宿主按进程驻留自己判断。
- 驻留表按 `engine.id` 记，不按 `base_url`：stdio 引擎的 `base_url` 全是 `null`，
  按地址记会让它们共用一格、互相串权重。
- [lib/assets/modelLayout.js:108](../lib/assets/modelLayout.js#L108) 的 `normalizeWeightSlots` 保留该字段；
  [lib/engines/profile/maps.js:60](../lib/engines/profile/maps.js#L60) 的 `checkSlotSwitching`
  校验“`switch` 只在 call 位”“endpoint 以 `/` 开头”，**并拒绝 stdio 形态的引擎写 `switch`**
  （名片声明了一个平台不会发的请求，静默忽略等于骗人）。transport 在
  [profile.js:279](../lib/engines/profile.js#L279) 已算出，调用 `checkSlotSwitching` 时传进去即可。

**代码改动**

| 文件 | 改什么 |
|---|---|
| [lib/assets/modelLayout.js](../lib/assets/modelLayout.js#L108) | `normalizeWeightSlots` 保留 `switch` |
| [lib/engines/profile/maps.js](../lib/engines/profile/maps.js#L60) | `checkSlotSwitching` 增加校验：call 位、endpoint 以 `/` 开头、stdio 拒绝 `switch` |
| [lib/engines/profile.js](../lib/engines/profile.js#L324) | 把已算出的 `transport` 传给 `checkSlotSwitching` |
| 新增 `lib/engines/weightSwitch.js` | 通用切换器：按 `engine.id` 记驻留（按位名）、只对 HTTP 位发请求、失败清该位；HTTP 客户端注入 |
| [lib/server/synthesisInstance.js](../lib/server/synthesisInstance.js) | 用 `weightSwitch` 替掉 `ModelSwitcher` |
| [lib/server/synthesis.js](../lib/server/synthesis.js) | `switchModels` 的注入签名不变，内部换实现 |
| [lib/gsv/modelState.js](../lib/gsv/modelState.js) | 删除（或保留到 2a 合并后单独删除；不留双实现） |
| [engines/gpt-sovits/manifest.json](../engines/gpt-sovits/manifest.json) | 两个位补 `switch` |

**必须保住的语义**

- 驻留去重：同一地址、同一位、同一路径 ⇒ 不发请求。
- 失败后该位驻留状态清空，下次必换。
- 健康探测 `offline → online` 清空所有驻留（[lib/gsv/modelState.js:42-49](../lib/gsv/modelState.js#L42)）。
- 合成锁内执行，顺序不变。

**测试**

- 假 HTTP 记录请求：两个位各换一次，第二次同值不发；换一台引擎互不串。
- 无 `switch` 的 call 位：一次额外请求都不发。
- 两张 stdio 名片（`base_url === null`）：驻留互不串；写了 `switch` 的名片在解析期被拒。
- GSV 集成：与原 `ModelSwitcher` 的请求序列相同。

### 4.3 子步 2b：缓存指纹按槽位

[lib/cache/segmentCache.js:104-105](../lib/cache/segmentCache.js#L104) 现在只吃
`cfg.gpt_model` / `cfg.sovits_model`。

改为：

```
weights[slot.name] =
  slot.param ? fileIdentity(cfg[slot.param])      // call 位
             : fileIdentity(cfg.launch_weights[slot.name])  // launch 位
```

- 指纹形状变了 ⇒ `FINGERPRINT_VERSION` 2 → 3（文件里已写明“改了取材方式必须加一”）。
- 代价：升级后缓存冷一次；行为不变。
- 测试：换任一槽位指纹变化；两条内容相同但槽位不同的记录不互相命中。

### 4.4 子步 2c：Compare Refs 模型轴

现状：

- 只取 `slots[0]` / `slots[1]`，不足两槽静默 `return`（0 组合）：
  [ReferenceCompareTab.jsx:195-202](../web/src/components/compare/ReferenceCompareTab.jsx#L195)
- 请求体写死 `gpt_model` / `sovits_model`：
  [ReferenceCompareTab.jsx:384-385](../web/src/components/compare/ReferenceCompareTab.jsx#L384)

改为：

- 槽位下拉按 `weight_slots` 渲染 N 组；请求体按 `slot.param` 写。
- 交叉积按 N 槽位；**行数上限 24**，超过时截断，并在提示里给出被丢弃的组合数
  （如“已截断 40 组，本次只生成前 24 组”），不要只说“请减少候选”（防止 3 槽位 × 每槽 4 份 = 64 行）。
- `rowModels` 形状从 `{gptCheckpoint, sovitsModel, ...}` 改为 `{ picks: { [slotName]: path }, ... }`；
  `CompareRow` 的混音展示按槽位名渲染（GSV 两个槽位外观不变）。
- 参考音频仍跟随“音色槽位”。目前写死跟随 SoVITS：
  [ReferenceCompareTab.jsx:341-343](../web/src/components/compare/ReferenceCompareTab.jsx#L341)。
  名片没有“哪个槽位代表音色/参考”的概念，**这一刀不发明它**：改为跟随 `slots` 中第一个有 `param` 的位；
  GSV 下就是 sovits，行为不变。将来若需要显式声明，再进第三刀。

**测试**

- 纯函数：两槽位时组合数与今天相同；三槽位时按笛卡尔积；超上限被截断且提示含丢弃数。
- GSV 两槽位生成的请求体与今天逐键相同。

### 4.5 子步 2d：Flow 保存音色

[lib/flowgraph/adapter.js:227-231](../lib/flowgraph/adapter.js#L227) 写死
`gpt_model` / `sovits_model` / `text_split_method=cut5`。

改为按名片槽位与 `defaults` 写；GSV 旧字段保留读取兼容。

### 4.6 明确不做（本刀）

- **voices.json 字段迁移**：`gpt_model/sovits_model`
  （[lib/routes/voices.js:61](../lib/routes/voices.js#L61)）经核实**不在合成路径上**
  （`generateService` 不读 `voiceReg.gpt_model`），本刀不动，避免无收益的数据迁移。
- **配方 schema v5**：`gpt_ckpt/sovits_pth` 的通用化留到第三刀之后单独评估；
  本刀只保证非 GSV 引擎可通过 `engine_params` 携带自己的槽位参数。
- 训练/Refine 槽位：不动。

### 4.7 验收

- 造一台两槽位（launch + call）的测试引擎：任选一个槽位换值，值到引擎、缓存失效、meta 记录正确。
- GSV：两个下拉、交叉积、生成结果与基线一致。

### 4.8 回滚

2a / 2b / 2c / 2d 分开提交。2a 回滚即恢复 `ModelSwitcher`；2b 回滚需同时把版本号退回 2（否则缓存全冷，不致命）。

---

## 5. 第三刀：契约扩展（加法，GSV 不变）

按价值排序；每一项都能独立合并。

### 5.1 语言值映射

**问题**：名片只映射键名不映射值；`all_zh / all_yue / all_ja / all_ko / auto_zh_ja_yue`
写死在平台四处：
[langOptions.js:5-47](../web/src/lib/langOptions.js#L5)、
[hanLanguage.js:119-136](../web/src/lib/hanLanguage.js#L119)、
[autoLanguage.js:1-3](../web/src/lib/autoLanguage.js#L1)、
[SPEECH_LANG_ALIAS](../lib/routes/synthesis.js#L120)。

**契约**：

```json
"languages": {
  "zh": "all_zh", "yue": "all_yue", "ja": "all_ja", "en": "en", "ko": "all_ko",
  "auto": "auto_zh_ja_yue", "auto_zh_ja": "auto_zh_ja_yue"
}
```

- `profile.language_map` 由名片产出；缺省 = 平台语种原样发（不猜）。
- 读取顺序：先接受请求里的 canonical 值，再接受引擎原值（双读期）。
- UI 选项由 `/api/engines` 返回的映射生成；一次只切一个消费者，最后删表。
- `auto_base_lang` 的回落规则是平台语义，不搬进名片。

**验收**：GSV 名片补上 `languages` 后，四种语言的 `text_lang` 与今天逐字相同；
一台只认 `zh/en` 的引擎不再收到 `all_ja`。

### 5.2 读音预览能力

**问题**：[lib/routes/pron.js:70-71](../lib/routes/pron.js#L70) 固定 `POST /pron/preview` 且用 `gsvPost`；
注释明确拒绝把能力写进名片（[51-52](../lib/routes/pron.js#L51)），靠 404/502 探测。

**契约（二选一，默认 A）**

A. 名片声明能力与端点：

```json
"pron": { "preview": { "endpoint": "/pron/preview", "request": "json" } }
```

B. 维持探测，但把端点路径变成名片字段，且用平台 HTTP 客户端而不是 `gsvPost`。

未声明 ⇒ 前端灰掉并按“这台引擎不支持读音校对”提示（不是报错）。

**验收**：GSV 行为不变；无 `pron` 段的引擎调用返回明确的 501/不可用，不产生 502 噪音。

### 5.3 扫描约定与底模来源

**问题**：语言正则、`.pth` 版本头、`GPT_weights_v2Pro` 目录写在通用扫描器里
（[scan.js:41-95](../lib/assetScanner/scan.js#L41)、[consts.js:14-15](../lib/assetScanner/consts.js#L14)）；
底模目录表与注册写死（[paths/models.js:16-64](../lib/paths/models.js#L16)、[server.js:199-202](../server.js#L199)）。

**契约**：引擎目录下放 `scan.json`（或名片 `assets.scan`），声明：

- 命名模式 → 语言
- 版本判定方式（字节头映射 / 文件名）
- 训练产物目录
- 底模来源（`models.source`，新向导已在读 `manifest.install`）

扫描器只执行声明；没有声明的引擎按“不推断”处理（不猜语言、不猜版本）。

**验收**：GSV 扫描结果与今天相同；无 `scan.json` 的引擎扫描不报错、不产生错误语言标注。

### 5.4 明确不做

- 配方 schema v5 / voices 迁移（除非 5.1-5.3 完成后另有需求）。
- 训练/Refine 通用化。
- `lib/inference` 搬家（独立事项，搬代码不是加契约）。

---

## 6. 风险登记

| 风险 | 触发点 | 缓解 |
|---|---|---|
| GSV 默认值偷偷变化 | 第一刀删掉写死默认值 | 基线快照测试；已逐项核对 `defaults` |
| 平台字段被旋钮覆盖 | 拼装顺序写错 | 固定 `knobs → slots → platform → engine_params`；加顺序测试 |
| 配方格子反超平台键（seed / speed） | payload 第 3 步不过滤 | 第 3 步跳过 `maps` 的值；测试写死“格子带 seed 不影响 payload.seed” |
| 换权重语义变化 | 2a 重写切换器 | 保留驻留/失败清空/健康翻转三条语义；请求序列对比测试 |
| stdio 引擎驻留串格 | 2a 按 `base_url` 记驻留（stdio 全是 `null`） | 驻留键 = `engine.id`；stdio 名片写 `switch` 在解析期报错 |
| 缓存整体失效一次 | 2b 版本号升级 | 预期内；写入计划，不当回归。第一刀另断言指纹不变 |
| Compare 组合爆炸 | 2c N 槽位 | 24 行上限 + 提示含被丢弃的组合数 |
| 语言双读期出现两套值 | 5.1 切换中途 | 一次只切一个消费者；先读后写；GSV token 在完成前不删 |
| Flow 无法本机验证 | 第一刀人工验收 | 接线由 `adapter → generateService` 单测兜底；人工项只验证画布运行，不冒充单测 |

---

## 7. 提交与验证矩阵

| 刀 | 单元测试 | 集成/人工 | 回滚单位 |
|---|---|---|---|
| 1 接线 | 假引擎参数、Flow 适配器、method、平台键守卫、GSV 快照+指纹 | Generate / Compare / Flow | 1 commit |
| 2a 切换器 | 假 HTTP 请求序列 | GSV 出声、换权重 | 1 commit |
| 2b 指纹 | 槽位变化 → 指纹变化 | 第二次同请求命中 | 1 commit |
| 2c Compare | 组合纯函数 | 两槽位外观不变 | 1 commit |
| 2d Flow 存音色 | 适配器单测 | 画布保存音色 | 1 commit |
| 3 契约 | 每项独立 | GSV 逐字一致 | 每项 1 commit |

每刀合并前必须：`npm test` 全绿 + 对应人工验收记录写进 PR 描述。

---

## 8. 计划成立的前提（已核实）

- `/v1` 已经证明“名片驱动 cfg”可行，第一刀是把它搬回 `/api/generate`，不是发明新机制。
- WebUI 生成页已经用通用助手发槽位参数：
  `weightsToSend` / `launchWeightsToSend`
  （[modelPickers.pure.js:128-150](../web/src/lib/modelPickers.pure.js#L128)）。
  第二刀主要改 Compare，不是从零开始。
- `buildTtsPayload` 是唯一装配点，`applyEngineKnobs` 已经按 schema 读 cfg；
  第一刀之后它们才第一次真正吃到非 GSV 参数。
- `voices.json` 的 `gpt_model/sovits_model` 不在合成路径上，可以安全地不碰。
- GSV 的 `/tts` 不读 `gpt_model/sovits_model`，所以 2a 必须保留“额外切换请求”这条契约，不能只靠 payload。

---

## 9. 完成定义

三刀全部合并后，应满足：

1. 一台只有 `manifest.json`、参数名与槽位名都与 GSV 无关的引擎，从 WebUI / Compare / Flow
   三个入口发起的参数与槽位选择都到达引擎。
2. `lib/` 与 `web/` 中不再有 `gpt-sovits`、`gpt_model`、`sovits_model`、`all_zh` 这类
   作为**平台逻辑**出现的词（测试夹具与兼容读取除外，需在代码里标明用途）。
3. GSV 的 payload、meta、缓存命中与升级前一致（缓存冷启动一次除外）。
4. 训练/Refine 明确仍是 GSV 专属，且文档如实写明。

---

## 10. 评审记录（2026-10-31）

Issue #26 第一轮评审（Hark）提出 6 条，全部核实后采纳：

| # | 评审意见 | 处置 |
|---|---|---|
| 1 | Flow 也中 P0，台账 ✅ 应为 🟡 | §0 补 Flow 证据；§3.5 第 2 条改为 `adapter → generateService` 单测 |
| 2 | payload 第 3 步会让配方格子反超平台 seed | §3.3 增加“出口守卫”：第 3 步跳过 `maps` 的值；§3.5 第 4 条测试 |
| 3 | 默认值相同 ⇒ 第一刀不会冷缓存 | §2 基线记录指纹；§3.5 第 5 条断言指纹不变 |
| 4 | `method` 校验比宿主严 | §3.3 改为与 `resolve_method` 同口径：只有声明了 `methods` 才校验；单方法交给宿主 |
| 5 | `switch` 与 stdio 的关系未说清 | §4.2 明确只对 HTTP 生效、驻留键用 `engine.id`、`checkSlotSwitching` 拒绝 stdio 写 `switch` |
| 6 | 141 行注释过时；截断提示太含糊 | §3.2 删除过时注释；§4.4 提示给出被丢弃的组合数 |

结论（Hark）：先做第一刀，把第 2 条与 Flow 单测一起写进去；2a 等 `switch × stdio` 关系定稿再动。
本计划按此排序，2a 的契约已按第 5 条定稿，但仍排在第一刀合并且基线稳定之后。
