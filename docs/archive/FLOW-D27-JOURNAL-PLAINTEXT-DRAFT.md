# FLOW-D27 契约草案 R0 — 用户原文在 Run Journal 中的持久化

> ## ⛔ 本文件已被取代，**不再是实现依据**
>
> 唯一实现依据是
> [`FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md)（R1，已冻结）。
>
> 本文件保留为**发现过程与实测记录**。阅读时注意以下三处已在 R1 中被修正：
>
> 1. §1 的通道表是**四条**；R1 为**五条**（新增客户端通道 ⑤ → FLOW-D29）。
> 2. §2.3 把通道 ④ 的承重性写为「产品功能依赖」，属推断；R1 已**实测确认**
>    抹除后 Rerun/Reload 失能。
> 3. §5 的七问在本文件里是**待裁决**；R1 中已**全部裁决并冻结**，
>    其中 Q5 由「需要」升级为**硬性前置条件**。
>
> 本文件中的任何倾向性表述（「我的倾向」「待裁决」）**均不得作为实现依据引用**。
>
> ---
>
> **状态：R0 草案（已被 R1 取代）。**
> 本轮**零代码改动**，只有本文件与三处文档登记的修改。
>
> 沿用 FLOW-D10 / D10b 的纪律：草案 → 逐问裁决 → R1 冻结 → 才实现。
> 先落实现会让实现事实上定义契约，而 D27 的实现横跨 adapter、executor、
> Journal、D26 指纹与 Artifact Store 写入侧，返工代价比 D10 更大。

---

## 0. 这份文档为什么必须先于实现存在

`FLOW-CORE-004-LIVE-WIRING.md` §3 D-6 把 D27 记为「legacy adapter 把请求文本回填进
`InferenceResult.metadata.request.text`」。

**本轮实测证明这条记载是不完整的，而且不完整的方向很危险**：按它去修（改
adapter 的 metadata）不会解决 D27，只会让 D27 看起来被解决了。

> 这正是本项目已经踩过的形状：**「文档宣称 fixed 但保护实际失效」比不修更危险**。
> 所以本轮的第一件事不是修，是把暴露面测准。

---

## 1. 实测暴露面（本轮修正上一轮记载）

复现方式见 §9。执行环境：真实 `validator` + 真实 `WorkflowExecutor` + 真实
`FileRunJournalStore` + 真实 `adapters/legacySynthesis.js`，**只有引擎侧
`generateService` 是桩**（本沙箱无 express / 无引擎）。

一条 `text → tts → gate → output` 的 run 落盘后，逐事件审计结果：

```text
  1 RUN_CREATED                 -
  2 RUN_VALIDATED               -
  3 RUN_QUEUED                  -
  4 RUN_STARTED                 -
  5 NODE_STARTED       text     -
  6 NODE_SUCCEEDED     text     PLAINTEXT   <-- 通道 ①
  7 NODE_STARTED       voice    -
  8 NODE_SUCCEEDED     voice    -
  9 NODE_STARTED       tts      -
 10 NODE_SUCCEEDED     tts      PLAINTEXT   <-- 通道 ②
 11 NODE_STARTED       output   -
 12 NODE_SUCCEEDED     output   -
 13 NODE_STARTED       review   -
 14 GATE_CREATED       gate     PLAINTEXT   <-- 通道 ③
```

### 1.1 四条通道

| # | 位置 | 内容 | 是否承重 | 是否在 D26 指纹输入面内 |
|---|---|---|---|---|
| ① | `NODE_SUCCEEDED(io.text_input).payload.node.outputs.text.value` | **完整原文逐字** | **是** | 否 |
| ② | `NODE_SUCCEEDED(tts.generate).payload.node.outputs` | `result.metadata.request.text`、`reference_text`、`pron_overrides`；**split 时**还有 `result.metadata.response.segments[].text` 与 **`audio.metadata.segments[].text`** | 否 | **是**（audio descriptor 含 `segments`） |
| ③ | `GATE_CREATED.payload.gate.input_artifacts` | review_target 的深拷贝 = 上面那个 audio artifact（split 时逐段原文随之进入）；`GATE_RESOLVED` 的 `output_artifacts` / `review_records` / `projection.outputs` 同样携带 | 否 | 否（但与 ② 同源） |
| ④ | `outputs/generate/<id>/meta.json` | `text`、`recipe.text`、`ref_text` —— **legacy 路径早已逐字写盘**，Flow 之前就存在 | 是（Workbench 历史 / Rerun 依赖） | 否 |

实测细节：

```text
io.text_input NODE_SUCCEEDED outputs = {"text":{"artifact_id":"art_text","type":"TextArtifact","value":"<原文>"}}
RUN_CREATED workflow_input_snapshot  = {"text":{"kind":"artifact_ref","artifact_id":"art_text","type":"TextArtifact","fingerprint":null}, ...}
GATE_CREATED 携带原文                = true
```

**D10a 的输入快照脱敏依旧成立**（`RUN_CREATED` 只有身份，无 value）——
D27 与 D10a 不矛盾，D27 是**输出侧**的独立通道。

### 1.2 上一轮记载被修正的三点

1. 原文的**源头不是 adapter**，而是 `io.text_input` 的 `NODE_SUCCEEDED`（通道 ①）。
   上一轮只看到通道 ②。**只改 adapter 的 `metadata`，通道 ①③ 原样保留**。
2. 通道 ② 在 **split 路径**上还会把逐段原文写进 **AudioArtifact** 的
   `metadata.segments`，而 `segments` 在 D26 的 audio descriptor 里
   （`adapters/legacySynthesis.js` 的 `audioDescriptor`）。集成测试跑的是短文本
   非 split 路径，所以这条通道**没有被那条「钉住 gap」的断言覆盖**。
3. `GATE_CREATED` 是第三条独立通道，`humanGate.js` 对 `input_artifacts` 做的是
   `clone()`，不是引用摘要。

---

## 2. 三条与直觉相反的结论

### 2.1 「隐私 vs 可重放性」的冲突，大部分是假的

上一轮把 D27 描述为「Journal 存输出是可重放性的基础」的契约冲突。实测之后这句话
需要收窄：

- **只有通道 ① 承重**。`executor.js:253` 的 `collectNodeInputs` 从
  `projection.node_runs[nodeId].outputs` 取下游输入，所以跨进程 resume 时
  `tts.generate` 的文本**只能**来自通道 ①。
- **通道 ②③ 不承重**。当前 6 个已注册 handler 中，**没有任何一个读取**
  `metadata.request.text` 或 `segments[].text`。它们是纯审计负载。

> 结论：真正的两难只存在于通道 ①，而通道 ① 的正解是**让文本以 Artifact 引用形式
> 存在**（值在 Store 里，Journal 里只有 id + fingerprint），也就是 D10b 的写入侧。
> 通道 ②③ 的代价不是可重放性，而是**审计信息量**与 **D26 指纹稳定性**。

### 2.2 抹掉通道 ② 会改变 D26 指纹（实测，不是推断）

同一条 split 响应，只把 `segments[].text` 去掉：

```text
audio fingerprint            : sha256:975e7c3cfaa34d412504d831a5c9643c7928a49e5c159838d8cae38bb7789355
audio fingerprint (已脱敏)   : sha256:3e9079cf0f77b138a55701ec3484f00ebe3ddd06d33c1406e4b69e55d0d4f3de
```

**指纹变了。** 这意味着任何对通道 ② 的脱敏都是一次**产物身份变更**：脱敏前后的
同一次合成会被 D10a / D10b 判为不同 artifact。**不能顺手做**，必须与指纹版本化
一起决策（见 Q5）。

### 2.3 Journal 脱敏 ≠ 系统不留原文

通道 ④ 已经把原文逐字写进 `outputs/generate/<id>/meta.json`，而且它是 Workbench
的**产品功能**（历史列表、Rerun 复现依赖 `meta.recipe`）。

> 因此：**只抹 Journal 得到的是「看起来脱敏」的系统**。
> 如果裁决的目标是「用户原文不落盘」，那么 D27 的范围必须包含通道 ④，
> 而那会直接冲掉 Workbench 的历史/Rerun 功能 —— 这是一个产品决策，不是工程决策。
> 如果目标只是「Flow 持久层与 legacy 持久层同密级、不做虚假承诺」，
> 那么正确的产出是**一条明确声明**，而不是一次脱敏实现。

---

## 3. append-only 带来的时间不对称（决定「以后再修」的真实代价）

Run Journal 是 append-only 且中间损坏 fail-closed（`fileJournalStore.js`）。

- **已经写下的原文无法被改写或删除**，只能整文件删除（属 FLOW-D22 retention，未实现）。
- 所以「先跑起来，以后再脱敏」在这件事上**不是零成本的推迟**：推迟一轮，就多一批
  永久携带原文的 Journal 文件。
- 反过来，**先冻结契约再实现**在这里也不是拖延：本轮之后新产生的 Journal 数量取决于
  `FLOW_ENABLED`，而它**默认关闭**，实际增量接近零。

> 这条不对称是 D27 应当**在下一轮内落地**、但**不应当在本轮顺手落地**的理由。

---

## 4. 候选方案与代价

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A 维持现状 + 显式声明** | 不改行为；在契约中写明「Run Journal 与 `meta.json` 同属可见原文的持久层，密级等同用户输入」 | 零实现风险；不解决任何隐私诉求；**必须同时撤掉任何暗示 Flow 已脱敏的措辞** |
| **B 只改 adapter metadata** | 不再把 `request` / `segments` 放进 artifact metadata | **建议否决**：治标（①③ 仍在），且静默改 D26 指纹，且削弱审计 |
| **C Journal 边界统一 outputSnapshot** | 对称于 `inputSnapshot()`，在 `_append` 前把输出中的字符串降级为 `{digest,length}` | 通道 ① 承重 → **跨进程 resume 直接失效**（除非同时有 Store）；改动集中、可测；对 D26 无影响（指纹在 adapter 内已算好） |
| **D 值必须经 Artifact Store** | `TextArtifact` 不再内联 `value`，Journal 只留 `artifact_id` + `fingerprint`，值由 Store 提供 | **结构正确、终局形态**；阻塞于 D10b **写入侧**（矩阵 §4.2 明列未实现）；牵动画布与 API 形状 |
| **E 分层：A 现在 + D 目标 + C 作为过渡开关** | 默认 A；提供 `FLOW_JOURNAL_REDACT` 开关执行 C，明确标注「开启后跨进程 resume 不可用」 | 需要一个诚实的开关语义；两条路径都要测 |

### 我的倾向：**E**（= 现在 A，目标 D，过渡 C 作为显式开关）

理由：

1. **不在 Store 写入侧存在之前，把承重数据抹掉**——那会用一个功能故障换一个
   隐私外观，且故障（resume 失败）比现状更晚才被发现。
2. A 的「声明」不是拖延，是**修掉一个更危险的东西**：当前文档里
   「D10a 输入快照脱敏」很容易被读成「Flow 不落原文」。这是认知层面的失效保护。
3. D 是唯一同时满足隐私、可重放、可寻址的形态，且它本来就在路线上
   （D10b 写入侧 → 第 3 项建议）。D27 应当**并入那一项的验收标准**，而不是单独做一次脱敏。
4. C 保留给「确实需要现在就不落原文」的部署，用开关承认它的代价，而不是默默降级。

---

## 5. 待裁决七问（每问附我的倾向）

| # | 问题 | 我的倾向 |
|---|---|---|
| **Q1** | D27 的保护对象范围：仅 Run Journal？Journal + `meta.json`？还是全系统「原文不落盘」？ | **仅 Flow 持久层（Journal）**，并在契约中**显式声明通道 ④ 不在本条范围内且同样含原文**。全系统脱敏是产品决策，会冲掉 Workbench 历史/Rerun。 |
| **Q2** | 本轮就改行为，还是只冻结契约？ | **只冻结契约**。行为改动并入 D10b 写入侧那一轮（见 Q6）。 |
| **Q3** | 是否引入对称于 `inputSnapshot()` 的 `outputSnapshot()`？ | **是**，但作为方案 D 的一部分实现；单独上 C 只在开关下启用。 |
| **Q4** | 非承重原文（通道 ②③）是否可以先停止写入？ | **可以，但不得单独做**——必须与 Q5 的指纹版本化同一次提交，否则是一次静默的产物身份变更。 |
| **Q5** | D26 fingerprint 是否需要 `fingerprint_version` 字段？ | **需要**。否则脱敏前后的同一次合成会被判为不同 artifact，而**看不出原因**。加版本后 D10a 可以「版本不同 → 明确拒绝比对」而不是给出误导性的 mismatch。 |
| **Q6** | 已落盘的 legacy Journal 怎么办？ | **不迁移、不删除、不改写**（append-only）。标注为「legacy 明文 Journal」，纳入 FLOW-D22 retention 处理。 |
| **Q7** | 集成测试里那条「钉住 gap」的断言裁决后如何演进？ | 拆成**两条**：通道 ①（承重）在 D 落地前**保持原文并注明理由**；通道 ②③ 一旦停止写入即改为**反向断言**。同时**补一条 split 路径用例**——当前那条只覆盖非 split，漏掉了 `audio.metadata.segments`。 |

---

## 6. 本轮明确不做（红线）

```text
不改任何 lib/ 下的代码
不改 adapters/legacySynthesis.js 的 metadata 形状（会静默改 D26 指纹）
不改 humanGate 的 input_artifacts 克隆语义
不动那条钉住 D27 的集成断言（它现在仍然是正确的：它记录的是事实）
不在契约冻结前引入 FLOW_JOURNAL_REDACT 开关
不声称 Flow 已脱敏
```

---

## 7. 一旦实现，会看见什么（提前写明，避免被当成回归）

- `lib/flow.integration.node.test.js` 中钉住 D27 的断言**必然变红**——这是设计意图。
- 若采纳 Q4 + Q5：**所有 legacy 产物的 fingerprint 与部分 artifact_id 会变**，
  旧 run 与新 run 的产物**不可比**，且 D10a 对账在跨版本恢复时应当明确拒绝。
- 若采纳 C 并开启开关：**跨进程 resume 在没有 Store 写入侧时必然失败**，
  且应当以 `WORKFLOW_INPUT_REBIND_REQUIRED` 显式失败，不得静默降级。
- 测试总数会变（新增 split 路径用例 + 版本化用例）。**交付时必须写明期望总数**；
  「全绿」本身不构成验收。

---

## 8. 验证深度声明（防止过度声称）

**本文档的全部结论均来自实际执行**，非代码阅读推断：

```text
已验证：validator + executor + FileRunJournalStore + legacySynthesis 真实代码路径下
        四条通道中的 ①②③，以及脱敏对 D26 指纹的影响（两个不同 sha256）
已验证：D10a 的输入快照脱敏在同一条 run 上仍然成立
已验证（读码 + 现有 gen meta 写入点）：通道 ④ 由 server.js:1050 writeGenMeta 落盘
未验证：真实 GPT-SoVITS 引擎下的 split 分支（本沙箱无 express / 无引擎，
        generateService 为桩，但其返回形状逐字取自 synthesisService.js:226/278）
未验证：Windows 下的实际 Journal 文件内容（路径与换行无关，风险极低但未实测）
```

**本轮不修改任何行为，因此没有「已修复」可供声称。**

---

## 9. 复现命令

两个探针脚本随补丁交付于 `tools-not-in-repo/`，**刻意不进仓库**（与
`verify-flow-patch.cjs` 同一处理）：

```powershell
node tools-not-in-repo/probe-d27-adapter.js   # 通道 ② 与指纹影响
node tools-not-in-repo/probe-d27-journal.js   # 真实 executor 落盘后的逐事件审计
```

`probe-d27-journal.js` 会在临时目录写一条真实 Journal 并逐事件报告是否含原文。
它只依赖 Node 标准库，不需要 express、不需要引擎、不写仓库目录。

---

## 10. 本轮顺带发现：**FLOW-D28**（新，open，小）

`lib/workflow/runtime.node.test.js` 顶层 `require('../routes/flow')`，而
`lib/routes/flow.js` 顶层 `require('express')`。在缺依赖的环境里该套件
**直接红灯**（`MODULE_NOT_FOUND`），而不是像 `flow.integration.node.test.js`
那样带原因 skip —— 与 FLOW-CORE-004 自己写下的「缺依赖时 skip 而非红灯」纪律不一致。

实测（本沙箱，无 `node_modules`）：

```text
node scripts/run_tests.cjs  ->  191 tests / 161 pass / 1 fail / 29 skipped
                                失败项 = lib/workflow/runtime.node.test.js（express 缺失）
```

> 注意 191 而不是 202：**套件加载即失败时，它的 12 条测试根本没有被计数**
> （191 + 12 − 1 = 202）。这是「只核对全绿不足以验收、必须核对总数」的又一个实例：
> 这里恰恰是**总数变小**先暴露了问题，而不是红灯。

它被单独引用的原因是 `statusFor()`（纯函数，错误码→HTTP 映射）住在一个必须 require
express 的模块里。**本轮不修**（属实现改动，且要决定 `statusFor` 该住哪）。
候选修法两种，留待裁决：把 `statusFor` 移到不依赖 express 的模块；或让测试按
`runtimeSkipReason()` 的方式守卫。
