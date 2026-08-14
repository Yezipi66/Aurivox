# FLOW-D27 契约 R3（冻结）— 用户原文在 Flow 持久层中的留存

> **状态：R3，已冻结。** 本文件是 D27 的**唯一实现依据**。
> [`FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md)（R0）
> **不再是实现依据**，仅作为发现过程与实测记录保留。
> R1 / R2 的被推翻段落在本文件内以删除线原地保留，**同样不再是实现依据**。
>
> **R3 本轮零代码改动。** 修订契约本身不改变任何运行时行为，
> 因此**没有任何「已修复」可供声称**。
> R3 也**不修改任何实现或测试文件** —— 阶段 2 的实现在 R3 通过独立审阅后才继续。
>
> 沿用 FLOW-D10 / D10b 纪律：草案 → 逐问裁决 → 冻结 → 才实现。

---

## 0.0 R3 相对 R2 的变化（**先读这一节**）

R2 的三条阶段 2 前提是**探针实测**结论，比 R1 的代码阅读结论可靠得多。
但阶段 2 **实现**跑起来之后，实测又推翻了 R2 的**另外两条事实陈述**。
R3 因此产生。裁决人：用户 + 独立审阅（2026-08-13），裁决为 **A2 + B1**。

```text
R1  代码阅读     →  被 R2 的探针实测推翻 1 条
R2  探针实测     →  被 R3 的【实现实测】推翻 2 条
R3  实现实测     →  本文件
```

**这是同一形状的第三次前提错误，必须登记为方法教训**（详见 §0.2）。

### 变化 1 —— 「零功能损失」在 **executor 层同样不成立**（§3.1 第三次更正）

R2 修对了一半：它承认通道 ① 承载「同进程 Gate resume」，
但**保留**了 R1 的另一半 ——「跨进程 resume 反正不支持，那部分确实零损失」。

**实测推翻**：`FLOW_RUN_PLAN_UNAVAILABLE` 只是 **runtime / HTTP 层**的限制
（Run Plan 不持久化）。在 **executor 层**，调用方自带 Plan 并注入 `inputResolver` 时，
**新实例 resume 今天就能完整跑通** —— D10a / D10b 专门建过这个能力，
并有 **5 条测试**断言其 `status === 'succeeded'`：

```text
lib/workflow/executor.node.test.js
  :203  an input rebind that matches the recorded snapshot is accepted
  :332  FLOW-D10b: a rebind is accepted when the artifact store confirms every artifact
  :352  FLOW-D10b: with no artifact store injected, behaviour is unchanged from D10a
  :481  FLOW-D10b: the store is never asked about inline inputs
  :576  FLOW-D10b: a pre-D26 journal entry with a null fingerprint still gets an existence check
```

**它们能通过的原因，正是节点输出逐字躺在 Journal 里。**
按 §4.8 字面实现的第一版阶段 2 把这条路掐断，实测 `204 / 170 / 5 / 29`。

R3 因此把「resume」拆成**三种能力**分别定性（§3.1），并冻结
**journal-safe 直通规则**（§4.8.1），把能力损失面收窄到与数据保护**严格同延**。

### 变化 2 —— 形状 B 同时移除了**通道 ②** 的 Journal 持久化（§4.9 量化作废）

R2 §4.9 预测「仅做阶段 2 后剩 **1** 处原文（通道 ②）」，并据此冻结措辞
「阶段 2 之后仅可声称通道 ① 已修复」。

**实测推翻**：通道 ② 的原文位于
`NODE_SUCCEEDED.payload.node.outputs.result.metadata.request.text` ——
**它也在 `outputs` 里面**。形状 B 是**允许清单**，`metadata` 不在清单上，
于是一并被摘要。实测**剩 0 处**，不是 1 处。

§4.9 那次量化是用「只脱敏 text 节点输出」的旧探针做的，**不是用形状 B 做的**；
形状 B 冻结后量化未重算就留在了契约里。

R3 按实测改写 §4.9，并按裁决 B1 明确：**阶段 2 可同时移除通道 ①② 的
NODE_SUCCEEDED 明文持久化**，但**不得**为了迁就一份写错的预测而把
`metadata` 加回允许清单（那等于为对齐错误预测而故意把原文留在盘上）。

### 变化 3 —— 两条既有测试的演进方式被冻结（裁决 A2 / B1）

```text
A2  executor.node.test.js:481   保留裸字符串场景，终态期望由 succeeded
                                改为 fail-closed + NODE_OUTPUT_VALUE_UNAVAILABLE
B1  flow.integration.node.test.js:265  通道 ② 明文持久化断言改为【反向断言】
```

两条都**不在 R3 中改动**，R3 只冻结「改成什么」。见 §4.10。

---

## 0.2 方法教训登记（R3 新增，与 §0 / §0.1 同类但更贵）

```text
教训 1  「实测」不是一个等级，而是一串等级。
        代码阅读 < 探针实测 < 实现实测 < 完整依赖环境实测。
        R2 的探针实测【确实是实测】，但探针只运行了契约关心的那条路径，
        没有运行【契约会打断的其它既有路径】。
        → 今后凡「移除某个持久化字段」类改动，实测必须包含
          「谁在读这个字段」的反向普查，而不只是「原文还在不在」的正向计数。

教训 2  「对称于既有函数」是【职责】对称，不是【形状】照搬。
        §2.3 早已写下这一条；阶段 2 第一版实现仍照抄 inputSnapshot() 的
        kind:'artifact_ref' 包装写了进去 —— 契约从未要求它，
        而正是它破坏了 §4.1 的值保真。见 §4.8.1。

教训 3  冻结契约里的每一个【数字】必须与当前冻结的【方案】同步重算。
        §4.9 的量化产自形状 B 冻结【之前】的探针，方案换了、数字没换。
        这与此前抓到的「校验哈希工具给陈旧内容签名」是同一种错：
        证据看起来在场，但它测的不是现在这个东西。
```

---

## 0.3 R2 相对 R1 的变化（历史，保留）

R1 的**阶段 2 三条前提是代码阅读结论**。R2 之前把它们做成了探针实测，
结果**推翻了其中一条，并发现另一条的错误码写错了层**。R2 因此产生：

1. **前提 1 被推翻并改写**。R1 写「同进程 Gate approve → resume **仍然通过**」。
   实测：通道 ① 脱敏后 resume **确实通过**（`status=succeeded`，零异常），
   但 gate 之后的下游节点收到的是 `"[[REDACTED]]"` 而非原文 ——
   **按 R1 的字面标准，一个静默产出错误音频的实现会被判为验收通过**。
   新前提改为**值保真**，见 §4 阶段 2。
2. **「零功能损失」论证被限缩**。R1 §3.1 称通道 ① 只承载「当前就不支持的跨进程 resume」。
   实测证明它在**同进程 Gate resume**（现有且受支持的能力）上就已承重。见 §3.1。
3. **输出值 sidecar 从「实现方式」升级为「承重件」**，并冻结其生命周期与
   缺值时的 fail-closed 行为 —— R1 完全没有写这两项。见 §4.2 / §4.3。
4. **resume 错误码按层拆分**。R1 写的 `FLOW_RUN_PLAN_UNAVAILABLE` 是 runtime/HTTP 层的码；
   executor 层实际抛 `WORKFLOW_INPUT_REBIND_REQUIRED`。R1 的写法在 executor 层
   **永远不可能被满足**。见 §4.1 前提 2。

**审阅追加的三个阻断项（同属 R2，均为「不冻结就会被实现者自行发明」的正确性契约）**：

5. **sidecar 身份键冻结为四元组** `run_id + node_id + node_attempt + output_port`。
   「同进程 + 同 run」不足以定位一个值 —— FLOW-D06 的 retry 会让同一 `node_id`
   产生多个 attempt，仅按 `run_id + node_id` 存会让**新 attempt 静默读到旧 attempt 的值**。
   见 §4.5。
6. **sidecar 写入与 Journal 提交的一致性语义冻结**。`executor.js:328` 的 `_append()`
   只是直接委托 `journalStore.append()`，**当前没有任何事务边界**；
   「先 append 后写 sidecar 失败」会制造一个阶段 2 之前**不存在**的新状态
   ——「Journal 成功、真实输出丢失」。见 §4.6。
7. **专用错误码冻结名称** `NODE_OUTPUT_VALUE_UNAVAILABLE`（executor 层，
   `retryable=false`，HTTP 落默认 500）。只写「须抛专用结构化错误」而不定名，
   等于让实现自行发明、文档事后追认。见 §4.7。
8. **`outputSnapshot()` 的字段形状冻结为【形状 B】**（保留定位字段、只摘要内容字段）。
   §2.3 原本只写「对称于 `inputSnapshot()`」—— 实测表明照搬输入侧形状会丢失
   `uri` 与 `fingerprint_kind`，那是一次**对外投影形状变更**，而非单纯的数据保护。
   用户裁决（2026-08-13）：**功能不得发生变化，不得影响 WebUI**。见 §4.8。

> **教训登记（与 §0 R1 的教训同类，但更贵）**：第一版探针给出过一个
> **假 PASS**。它沿用 FLOW-CORE-004 的标准图，而该图中 Gate 之后唯一会执行的
> `output` 节点消费的是 `tts.audio`，**没有任何节点回读被脱敏的 `text.text`** ——
> 那张图**结构上不可能观测到通道 ① 的承重性**，跑绿了也证明不了任何事。
> 这与 FLOW-D28 守卫「在完整依赖环境里结构上不可观测」是同一类错误：
> **先问「这个实验有没有可能失败」，再问「它是不是通过了」。**

---

## 0.4 R1 相对 R0 的变化（历史，保留）

R0 冻结前追加了一轮**本地完整环境审计**（Windows + 完整依赖 + 真实 server 进程），
它带来三处实质变化：

1. **通道 ④ 从「推定承重」升级为「实测承重」**：抹掉 `meta.json` 的
   `text` 与 `recipe.text` 后，Recent Generations 的 **Rerun 与 Reload 双双失能**
   （编辑器为空 → Generate 报 `Enter text to synthesize`）。Q1 据此锁定。
2. **新增通道 ⑤（客户端）**，并在同一轮把它的范围**缩小**到实测支持的程度 ——
   `generate.result` **不含**原文，此前基于代码路径的推断被 localStorage 实物证伪。
   单列为 **FLOW-D29**，不并入 D27。
3. **Q5（`fingerprint_version`）从「建议」升级为「必须」**，理由见 §3.2 ——
   本地探针打印出的一行 `artifact_id changes too : audio_g2 -> audio_g2`
   证明脱敏会产生「指纹变、id 不变」的组合，而这个组合在
   `artifactStore.js:111-116` 下与「产物被篡改」不可区分。

> 教训登记：R0 的通道 ⑤ 判断连续两次过强，都是从代码路径推断而非读取实际存储内容。
> **客户端侧结论必须以实际存储内容为准。**

---

## 1. 暴露面（五通道，冻结版）

| # | 位置 | 内容 | 承重 | D26 指纹面内 | 本条范围 |
|---|---|---|---|---|---|
| ① | `NODE_SUCCEEDED(io.text_input).payload.node.outputs.text.value` | 完整原文逐字 | **是** | 否 | **在** |
| ② | `NODE_SUCCEEDED(tts.generate).payload.node.outputs` 的 `metadata.request.text` / `reference_text` / `pron_overrides`；**split 时**另有 `metadata.response.segments[].text` 与 `AudioArtifact.metadata.segments[].text` | 逐字 | 否 | **是** | **在** |
| ③ | `GATE_CREATED.payload.gate.input_artifacts`（`humanGate.js:74` 为 `clone()`） | 与 ② 同源 | 否 | 否 | **在** |
| ④ | `outputs/generate/<id>/meta.json`：`text`、`recipe.text`、`ref_text`、`recipe.reference_text` | 逐字，4 处 | **是（产品功能）** | 否 | **不在**（§2.1） |
| ⑤ | 浏览器 `localStorage` 键 `tf.v1.generate.text`（编辑器缓冲区，跨会话留存） | 当前编辑内容 | 否 | 否 | **不在**（FLOW-D29） |

**承重性判据（R2 已实测，此前为代码阅读）**：`executor.js:285` 的
`sourceOutputs(projection, edge.from.node)[edge.from.port]` 是**边输入的唯一来源**，
而 `resume()` 与 `_drive()` **无条件** `journalStore.replay(runId)` ——
executor 内**不存在**任何节点输出的内存副本。写入点是 `executor.js` 的
`NODE_SUCCEEDED` 分支 `outputs: clone(result.outputs || {})`。

> ⚠️ 不要与 `runtimeInputs` Map（`executor.js:325/340/461/484/493`）混淆：
> 它只承载 **workflow 级输入**，**不承载节点输出**。两者是不同的东西，
> R1 §3.1「平移 D21 模式」的说法正是在这里过于乐观（见 §3.1）。

当前注册的 6 个 handler **无一读取** ② 与 ③，二者是纯审计负载。

**通道 ③ 的一处修正（R2）**：`GATE_CREATED` 是否含原文**取决于图的形状**，不是恒定的。
R1 记录的实测（`GATE_CREATED carries plaintext = true`）来自 `review_target` 连接了
携带原文的产物；而在 R2 承重图中 `review_target` 只连 `tts1.audio`，
非 split 的 `AudioArtifact` 不带原文，同一位置实测**不含**原文。
**不得把任一次观测当作通道 ③ 的恒定性质。**

**D10a 仍然成立**：`RUN_CREATED.workflow_input_snapshot` 只含
`{kind, artifact_id, type, fingerprint}`，无 `value`。D27 是**输出侧**的独立通道，
与 D10a 不矛盾。

### 1.1 明确不成立的说法（防止后续被误引）

```text
「Flow 不落用户原文」                      —— 假，通道 ①②③ 均落
「D10a 已经解决了原文落盘问题」            —— 假，D10a 只覆盖输入侧
「只要改 adapter 的 metadata 就修好了 D27」—— 假，源头是 ①，改 ② 只是让它看起来被修
「抹掉 Journal 之后系统就不留原文」        —— 假，④⑤ 在 Flow 之外
「generate.result 里有原文」               —— 假，已被 localStorage 实物证伪
```

---

## 2. 七问裁决（冻结）

### 2.1 Q1 · 保护范围 —— **仅 Flow 持久层（Run Journal）**

通道 ④⑤ **明知含原文，明确不在本条范围内**。

- 通道 ④ 是**在售产品功能的承重数据**：实测抹除后 Recent Generations 的
  Rerun / Reload 立即失能。移除它是产品决策，不是工程决策，**不得以 D27 之名顺手做**。
- 通道 ⑤ 属客户端存储，责任边界不同，另立 **FLOW-D29**。

> 因此 D27 的目标被明确表述为：
> **「Flow 持久层不做出比 legacy 持久层更强的隐私承诺，且不留下暗示它更强的措辞」**，
> 而不是「用户原文不落盘」。后者本条**做不到**，写下即为虚假承诺。

### 2.2 Q2 · 本轮范围 —— **只冻结契约，不改行为**

行为改动分阶段执行，见 §4。

### 2.3 Q3 · `outputSnapshot()` —— **是，属方案 D 的一部分**

对称于 `executor.js:63` 的 `inputSnapshot()`。**不单独作为 C 方案上线**，
除非按 §4 阶段 2 的验收条件通过。

> **R2 补充**：「对称」在此**仅指职责对称，不指字段形状照搬**。
> 字段形状已由 §4.8 单独冻结为**形状 B**。本节不再是形状的实现依据。

### 2.4 Q4 · 通道 ②③ 可否先停写 —— **可以，但不得单独做**

必须与 Q5 的 `fingerprint_version` **同一次提交**。单独停写 = 一次静默的产物身份变更。

### 2.5 Q5 · `fingerprint_version` —— **必须**（本轮由实测升级为硬要求）

实测：同一条 split 响应，仅移除 `segments[].text`

```text
fingerprint          sha256:975e7c3cfaa34d412504d831a5c9643c7928a49e5c159838d8cae38bb7789355
fingerprint (脱敏后) sha256:3e9079cf0f77b138a55701ec3484f00ebe3ddd06d33c1406e4b69e55d0d4f3de
artifact_id          audio_g2 -> audio_g2   （未变）
```

**指纹变、artifact_id 不变**。而 `artifactStore.js:111-116` 的
`reconcileArtifactDescriptor` 对「同一 id、fingerprint 不符」的处置是
**fail closed 且不可重试**，诊断信息与「产物被第三方篡改」**完全同形**。

> 结论：没有 `fingerprint_version`，D27 的修复会把自己伪装成一次 D10b 安全告警。
> 有了它，D10a/D10b 可以「版本不同 → 明确拒绝比对」，而不是给出误导性 mismatch。

### 2.6 Q6 · 已落盘的 legacy Journal —— **不迁移、不删除、不改写**

Journal 是 append-only。既有文件标注为「legacy 明文 Journal」，
retention 纳入 **FLOW-D22**。

### 2.7 Q7 · 集成断言如何演进 —— **拆两条 + 补 split 用例**

- 通道 ①：在阶段 2 落地前**保持钉住原文**，注释须写明「这是 gap 而非保证」。
- 通道 ②③：一旦停写即改为**反向断言**。
- **必须新增一条 split 路径用例** —— 现有断言只覆盖非 split，
  实测确认非 split 的 `AudioArtifact.metadata.segments` 为 `[]`，
  结构上不可能覆盖 split 形态。

---

## 3. 冻结的方案：**E**

```text
现在   = A   维持行为 + 显式声明（本文件即为该声明）
目标   = D   值经 Artifact Store，Journal 只留 id + fingerprint
过渡   = C   outputSnapshot 作为显式开关，且必须承认其代价
否决   = B   只改 adapter metadata（治标，且静默改 D26 指纹）
```

**B 被明确否决**，任何后续提交不得以 B 的形式实现 D27。

### 3.1 阶段 2 的前提（R2：已实测，R1 的结论被限缩）

> **以下 R1 原文不再是实现依据，保留以记录判断是怎么错的：**
>
> ~~通道 ① 承重，但它承载的能力是**跨进程 resume**，而该能力**当前就不支持**~~
> ~~（Run Plan 仅存内存，重启后 resume 抛 `FLOW_RUN_PLAN_UNAVAILABLE` / 409）。~~
> ~~因此通道 ① 的修复不损失任何现有能力。~~

**实测结论（R2）**：该论证**只对跨进程 resume 成立**。通道 ① 在
**同进程 Gate resume** 上就已承重 —— 而同进程 Gate resume 是**现有的、受支持的、
有测试覆盖的能力**，不是「当前就不支持」的能力。因此：

```text
R1 的说法   通道 ① 只承载「本就不支持的能力」→ 脱敏零功能损失
R2 的事实   通道 ① 同时承载「现有受支持的同进程 Gate resume」
            → 直接脱敏 = 静默的语义损坏，不是零损失
```

> ⚠️ **R3 更正：上面这句 R2 的收尾话也是错的。** 原文为
> ~~「零功能损失」这一表述今后仅可用于跨进程 resume，不得用于同进程 Gate resume。~~
> 实测表明 executor 层的新实例 resume 是**真实存在且有测试覆盖的能力**，
> 因此「零功能损失」**在任何一种 resume 上都不再成立**。见 §3.2。

`runtimeInputs` Map 仍是**形态上的**先例（值放内存、终态即删、Journal 只留身份快照），
但它管的是 workflow 级输入，**不是**节点输出。所以阶段 2 **不是**「平移一个已有模式」，
而是**新建一个承重组件**（§4.2）。改动面因此比 R1 估计的大。

### 3.2 resume 的**三种能力**（R3 冻结；今后任何一处提到 resume 都必须指明是哪一种）

R1 与 R2 都把 resume 当成**一件事**在讨论，这正是两次前提错误的共同根源。
R3 起，它是**三件事**，各自的支持级别与阶段 2 后的表现分别冻结如下：

```text
① 同进程 Gate resume
   ── 支持级别   受支持，且【必须逐字保值】
   ── 阶段 2 后   不变。值来自 sidecar（同一 Executor 实例、同一 run）
   ── 验收判据   下游消费者收到的值与原值逐字符相等（§4.1 前提 1）

② Executor 新实例 resume（调用方自带 Plan + 注入 inputResolver）
   ── 支持级别   【部分支持】（R3 新定性；R1/R2 均误判为「不支持」）
   ── 阶段 2 后   按输出内容一分为二：
                  身份型输出（仅含允许清单字段）→ 仍可从 Journal 恢复，行为不变
                  含内容输出（TextArtifact.value、metadata 等）→ 依赖原进程 sidecar，
                                                              不可用时【fail-closed】
   ── 错误码     NODE_OUTPUT_VALUE_UNAVAILABLE（executor 层，§4.7）
   ── 既有测试   :203 / :332 / :352 / :576 属身份型，保持绿
                  :481 属含内容型，按裁决 A2 改为断言 fail-closed（§4.10）

③ Runtime / HTTP 重启 resume
   ── 支持级别   当前【不可用】，且原因与 D27 无关
   ── 原因       Run Plan 仅存内存，未持久化
   ── 错误码     FLOW_RUN_PLAN_UNAVAILABLE + HTTP 409（runtime/HTTP 层）
   ── 阶段 2 后   不变（阶段 2 没有让它更差，也没有让它变好）
```

**冻结的措辞纪律**：

```text
不得再写「跨进程 resume 不支持」——【必须】指明是 ② 还是 ③。
  ② 是部分支持，③ 才是不可用。
不得再用「零功能损失」论证 D27 的任何一部分。
  阶段 2 确实损失能力：② 中【含内容输出】的那一半。
  正确的论证是【损失面与保护面严格同延】（§4.8.1），不是「没有损失」。
```

---

## 4. 实施计划（分阶段，每阶段独立可验收、可中止）

### 阶段 0 —— ✅ 已完成：R1 冻结（纯文档）
改动：本文件 + R0 标注 + 矩阵 + 健康基线 + README。**测试总数不变：202/202/0/0。**

### 阶段 1 —— ✅ 已完成：FLOW-D28（最小、与 D27 无耦合）
```text
新建 lib/workflow/errorStatus.js            零依赖，statusFor + STATUS_BY_CODE
改   lib/routes/flow.js                     改为从新模块引入；re-export 已删除
改   lib/workflow/runtime.node.test.js      直接 require 新模块 + 2 条回归守卫
```
**验收不是「全绿」**：必须在**移除 `node_modules`** 的环境下确认
`runtime.node.test.js` 不再整套件红灯。**仅在 flow.js 保留 re-export 而测试不改
= 未修复**（测试仍会经 `routes/flow` 触发 `require('express')`）。

实测：`191/161/1/29` → **`204/175/0/29`**；期望总数由 **202 改为 204**。
两条守卫经反例验证。**re-export 选择删除而非保留**，理由见矩阵 §4.1。
**D27 本身未被触碰** —— 阶段 1 与 D27 语义零耦合，这正是它被排在前面的原因。

### 阶段 2 —— D27 通道 ①（承重项，单独一轮）— **R2 重写**
`executor.js`：输出值进**内存 sidecar（承重件）**，Journal 写 `outputSnapshot()`。

#### 4.1 验收前提（R2，已实测；任一不满足即停止）

```text
1. 【值保真，取代 R1 的「仍然通过」】
   Gate approve → resume 之后，Gate 之后的下游消费者收到的值
   必须与原值【逐字符相等】。
   run 成功、未抛异常、产出合法 WAV —— 三者【均不构成】通过。

2. 【按层拆分，修正 R1 写错的层】
   executor 层（无 runtime inputs）  : WORKFLOW_INPUT_REBIND_REQUIRED
   runtime / HTTP 层（Run Plan 不在内存）: FLOW_RUN_PLAN_UNAVAILABLE + HTTP 409
   测试必须断言【自己所处那一层】的错误码。R1 只写了后者，
   在 executor 层测永远不可能满足。

3. 「Journal 持久化并 replay 到同一状态」那条测试仍绿（状态机形状不变）

4. 【R3 新增】身份型输出的 Executor 新实例 resume 【不得被打断】
   §3.2 能力 ② 中「输出仅含允许清单字段」的那一半必须继续成功。
   验收：executor.node.test.js :203 / :332 / :352 / :576 保持绿，
   且【不得】通过修改这四条测试来达成。
   它们变红 = journal-safe 直通规则（§4.8.1）没有正确实现，不是可接受代价。

5. 【R3 新增】含内容输出在 Executor 新实例上必须 fail-closed，而非静默降级
   验收：:481 断言 NODE_OUTPUT_VALUE_UNAVAILABLE 且 retryable === false。
   断言「run 失败了」不够 —— 必须断言【就是这个码】。
```

**前提 1 为什么必须这样写**：R1 的「仍然通过」是一个**假绿判据**。实测中
通道 ① 脱敏后 `status=succeeded`、零异常、引擎正常返回、WAV 正常落盘 ——
唯一的问题是引擎合成的是 `"[[REDACTED]]"`。**这比报错坏得多**：
它是一次静默的语义损坏，且在 CI 里完全不可见。
（与纪律「文档宣称 fixed 但保护失效比不修更危险」同形。）

#### 4.1.1 承重回归图（必须保留，不得简化为标准图）

阶段 2 的回归测试**必须**使用一张「Gate 之后有节点直接消费 Gate 之前的 text 输出」的图：

```text
text ┬─────────────────────────→ tts2.text     ← 承重边：Gate 之后才回读
     └→ tts1 → review(gate) ──approved→ tts2.recipe
voice ┴→ tts1        voice ──────────→ tts2.voice
```

`tts2` 因存在一条来自 gate 的入边，必须等 gate 解决后才 ready；届时它经
`collectNodeInputs()` → `sourceOutputs(projection,'text')` 回读 `text` 节点输出，
而 projection 由 Journal replay 得到 —— **这才是通道 ① 的判决点**。

**为什么 FLOW-CORE-004 的标准图不行（必须记住）**：该图中 Gate 之后唯一会执行的
`output` 节点消费 `tts.audio`，**没有任何节点回读 `text.text`**。
用它测通道 ① 会得到一个**假 PASS** —— 已实际发生过一次。

#### 4.2 输出值 sidecar 是**承重件**（R2 新增）

它**不是**让实现更整洁的可选项；少了它，阶段 2 就是一个静默数据损坏补丁。
**必须动的三处**：

```text
写入点     节点成功时，真实输出值存入 sidecar；Journal 只落 outputSnapshot()
下游读取点 collectNodeInputs()/sourceOutputs() 取边输入时，值来自 sidecar，
           不是来自 replay 出来的 projection
生命周期点 终态清理
```

#### 4.3 sidecar 生命周期（冻结的最小语义）

```text
保留    awaiting_human_review 期间必须保留
复用    仅限【同一 Executor 进程】且【同一条 run】
释放    所有终态均须释放：succeeded / failed / rejected / cancelled
不承诺  不得声称具备跨进程可恢复性
```

#### 4.4 sidecar 缺值时 **fail-closed**（冻结）

实现**绝不允许**在 sidecar 缺值时回退到下列任一物件并将其作为**真实节点输入**：

```text
禁止    Journal 里的脱敏占位符（如 "[[REDACTED]]"）
禁止    摘要 / 指纹 / 长度描述符
禁止    snapshot 对象本身
```

缺失一个**必需的**运行时输出值，必须产生一个**专用的结构化错误**，
**不得**静默地把脱敏数据交给 handler。

> 这一条是 R2 的核心防线：阶段 2 唯一真正的失败模式就是
> 「拿占位符当真值往下传」，而它**不会**在任何「全绿」里显形。

#### 4.5 sidecar 的身份键（**冻结**）

§4.3 的「同进程 + 同 run」**不足以定位一个值**。一条 run 内存在多个节点、
每个节点多个输出端口、且 FLOW-D06 的 retry 会让**同一 `node_id` 产生多个 attempt**。
仅按 `run_id + node_id` 存储会产生下列**静默错值**：

```text
新 attempt 读到旧 attempt 的值
同一节点的某个输出端口覆盖另一个端口
retry 失败后残留的半旧输出仍可寻址
Journal 认定 attempt 2 成功，sidecar 却提供 attempt 1 的数据
```

**冻结的最小身份键**（四元组，缺一不可）：

```text
run_id
node_id
node_attempt      ← 已存在于代码：executor.js:305 effectiveNodeAttempt()
                    及 NODE_SUCCEEDED payload.node.node_attempt（executor.js:655）
output_port
```

**冻结的取值规则**：

```text
1. 只有与 Journal 中 NODE_SUCCEEDED 相对应的那个 attempt 才可向下游提供输出值
2. 新 attempt 不得回退读取旧 attempt 的值
3. 同一 attempt 的各输出端口相互隔离，不得互相覆盖
4. 下游读取必须以【replay projection 当前认定的成功 attempt】为准，
   不得以 sidecar 自身的内容为准
5. sidecar 中存在其他 attempt 的值，【不构成】可接受的 fallback ——
   该情形按 §4.4 fail-closed 处理
```

> 第 4 条是方向性的：**Journal 是权威，sidecar 只是值的载体**。
> 一旦允许 sidecar 反过来决定用哪个 attempt，D06 的 retry 语义就被绕过了。

#### 4.6 sidecar 写入与 Journal 提交的一致性（**冻结**）

`executor.js:328` 的 `_append()` 只是直接委托 `journalStore.append()`，
**当前不存在任何事务边界**。因此下列两种交错必须被契约排除：

```text
交错 A   先写 sidecar → Journal append NODE_SUCCEEDED 失败
         → sidecar 有值，但 Journal 不认为该节点成功
交错 B   先 append 脱敏后的 NODE_SUCCEEDED → 写 sidecar 失败
         → Journal 宣称节点成功，但真实值已丢失
```

**交错 B 尤其危险**：它制造一个**新的**状态 ——「Journal 成功、真实输出丢失」，
这在阶段 2 之前根本不存在。

**契约不规定实现顺序**（先写 Map 还是先 append 由实现者定），
**但冻结失败后的可观察语义**：

```text
1. sidecar 值与其 NODE_SUCCEEDED 属于【同一个逻辑提交边界】
2. 只有【已成功提交到 Journal】的 NODE_SUCCEEDED 才允许被下游消费
3. Journal append 失败时，不得留下任何可被调度器寻址、消费的 sidecar 输出
4. Journal 已提交、但所需 sidecar 值不可用时，必须 fail-closed（§4.4），
   不得降级、不得静默继续
5. 不得因为「sidecar 里碰巧还有值」就绕过 Journal 认定的成功 attempt 身份
6. retry 或失败 attempt 产生的临时值，必须丢弃或保证不可寻址
```

#### 4.7 专用错误码（**冻结名称**）

§4.4 要求「专用的结构化错误」，但不冻结名称就等于让实现自行发明、文档事后追认。
**冻结如下**：

```text
错误码   NODE_OUTPUT_VALUE_UNAVAILABLE
抛出层   executor（与 WORKFLOW_INPUT_VALUE_MISSING 同层、同风格）
语义     Journal 认定某 attempt 成功，但其真实输出值在本进程 sidecar 中不可用，
         因而无法为下游节点组装输入
retryable  false —— 这不是瞬态故障，重试不会让值回来
```

**必须携带的结构化字段**（对齐 §4.5 的身份键，便于定位到底缺了哪一个值）：

```text
run_id, node_id, node_attempt, output_port
```

**命名核对**：已比对 `executor.js` 现有 20 个 `executorError(...)` 码，
`NODE_OUTPUT_VALUE_UNAVAILABLE` **未与任何既有码冲突**，
且与既有 `WORKFLOW_INPUT_VALUE_MISSING` 构成「输入侧 / 输出侧」的对称命名。

**HTTP 映射（一并冻结，避免实现者自行决定）**：

```text
不加入 lib/workflow/errorStatus.js 的 STATUS_BY_CODE，
故落入 statusFor() 的默认分支 = 500。
```

理由：这是**服务端不变量被破坏**（值本该在而不在），不是客户端可纠正的请求问题。
映射成 409 会**错误地暗示「重试或重新绑定即可解决」**，而实际上值已经不可恢复。
**若将来要改成非 500，必须是一次显式裁决，不得在实现阶段顺手加映射。**

> ⚠️ FLOW-CORE-004 的 **D-2** 是反面教材：映射表里写了一个**猜测的**码名
> （`WORKFLOW_VALIDATION_FAILED`，实际是 `WORKFLOW_INVALID`），
> 导致每个非法图都返回 500 而非 400 —— **只存在于映射表里的错误码等于没有映射**。
> 因此本条要求：阶段 2 的测试必须断言**实际抛出的码字符串**，不得只断言 HTTP 状态。

#### 4.8 `outputSnapshot()` 的字段形状（**冻结：形状 B**）

§2.3 只写了「对称于 `inputSnapshot()`」，未冻结字段形状。
实测表明**照搬输入侧形状会造成一次对外形状变更**，因此本节单独冻结。

**裁决：形状 B —— 保留定位字段，只摘要内容字段。**
裁决人：用户（2026-08-13）。裁决理由：**功能不得发生变化，不得影响 WebUI。**

**冻结的字段规则**：

```text
artifact 类输出（带 artifact_id）
  逐字保留   artifact_id, type, uri, fingerprint, fingerprint_kind
  其余字段   一律转为摘要（{kind:'inline_digest', length, digest} 或 opaque_digest）
             —— 包含 TextArtifact.value，即通道 ①

非 artifact 输出
  string             {kind:'inline_digest', type:'string', length, digest}
  number/boolean/null {kind:'inline', type, value}
  其余                {kind:'opaque_digest', type, digest}
```

**默认方向必须是「摘要」而非「保留」**：上面 5 个逐字保留的字段是一份
**允许清单**（allowlist）。将来产物新增的任何字段**默认被摘要**。
这是有意的 —— D27 的整个论证前提是**默认必须安全**。

**第二个职责：必须保留端口键集合。**
`outputSnapshot()` 不得把整个 `outputs` 折叠成单个摘要对象。
`executor.js:286` 的 `if (value === undefined) continue` 承担着
「**该端口本来就没有输出**」这一合法语义（可选边）。下游读取据此区分：

```text
snapshot 中无该端口键        → continue（维持现状）
有该端口键但 sidecar 缺值    → 抛 NODE_OUTPUT_VALUE_UNAVAILABLE（§4.7）
```

丢掉键集合会导致二选一的错误：要么所有可选边变红，
要么落进 §4.4 明令禁止的**静默降级**。

**被否决的两个方案（记录理由，防止日后重提）**：

```text
形状 A 严格对称（照搬 inputSnapshot）
  否决：投影会丢失 uri 与 fingerprint_kind，
        破坏 flow.integration.node.test.js:134-140 的既有断言。
        这不只是测试变红，而是 HTTP 投影的对外形状变更 ——
        把一次数据保护改成了一次 API 变更，回归面远大于所修问题。

形状 C 只替换已知的 value 字段
  否决：这是黑名单。将来任何新增的内容字段都会默认泄漏，
        与 D27 的方向相反。
```

**影响面（实测，非推断）**：

```text
web/ 对 api/flow 与 node_runs 的引用数        0
lib/ 内 projection.node_runs[].outputs 的消费者  无（runJournal.js:157 仅写入）
Flow 挂载条件                                  server.js:1760 FLOW_ENABLED，默认关
```

故本形状变更**结构上不可能影响 WebUI**；形状 B 进一步保证即使
Flow 开启，投影中产物的可定位性也不变。

> **R3 复核（实测重跑，结论不变）**：`web/src` 内对 `api/flow` 与 `workflow`
> 的引用为 **0**（唯一命中 `web/src/lib/hanLanguage.js:1` 是注释里
> 「Han-language override workflow」的自然语言用词，与 Flow 内核无关）。
> `lib/workflow/executor` 的 require 方仅 `lib/workflow/index.js:9` 与
> `lib/workflow/runtime.js:39`；`runtime.js` 的唯一入口是
> `server.js:1762`，位于 `FLOW_ENABLED` 保护块内且**默认关闭**。
> 因此**阶段 2 的全部改动对 WebUI 的影响面为零，且这是结构性的，不是经验性的**。

#### 4.8.1 **journal-safe 直通规则**（R3 冻结 —— 阶段 2 的正确性核心）

§4.8 的字面规则是「允许清单内逐字保留、**其余字段**一律摘要」。
当一个输出值的**全部键都落在允许清单内**时，「其余字段」是**空集**，
于是按 §4.8 自身的字面意思，**它的快照就等于它本身**。

R3 把这条推论**显式冻结**为规则，因为不写下来就会被实现者当成优化而略过，
而它恰恰是 §3.2 能力 ② 前半段（身份型输出仍可 resume）的**唯一来源**：

```text
【journal-safe】—— 快照 === 原值，逐字留在 Journal，下游【从 Journal 读】
   · number / boolean / null
   · 对象且带 artifact_id 且【其全部键 ∈ 允许清单 5 字段】

【非 journal-safe】—— Journal 只留摘要，真实值【交由 sidecar 保管】
   · string（含 TextArtifact.value，即通道 ①）
   · 带 artifact_id 但含任何清单外字段（如 metadata，即通道 ②）
   · 其余一切
```

**这不是放宽保护，是精确化保护**：允许清单里的 5 个字段本来就是
「§4.8 判定为可以逐字落盘的字段」，直通只是不再对一个**完全由它们构成的值**
多做一层无意义的包装。

> ⚠️ **禁止事项（实现中真实发生过一次，必须写死）**：
> 对 journal-safe 值**不得**添加任何包装层，包括但不限于
> `{ kind: 'artifact_ref', ... }`。
> §4.8 从未要求该包装；阶段 2 第一版实现照抄 `inputSnapshot()` 的形状加了它，
> 结果下游收到的是 `{kind, ...}` 而非原值，**直接破坏 §4.1 的值保真**。
> 判据很简单：**journal-safe 值的快照必须与原值 `deepStrictEqual`。**

**能力损失面（冻结的论证方式）**：

```text
阶段 2 之后，能力 ② 的失效范围
  = 且仅等于  「节点输出携带真实内容」的那些图
  = 且仅等于  「原文本来会落进 Journal」的那些图
```

**损失面与保护面严格同延** —— 这才是阶段 2 站得住的论证，
而不是 R1/R2 用过的、已被两次推翻的「零功能损失」。

#### 4.8.2 `outputs_custody` 的语义（R3 冻结）

`NODE_SUCCEEDED.payload` 中新增字段 `outputs_custody`，冻结如下：

```text
类型      端口名数组（string[]），【不是】布尔、也【不是】节点级标量
含义      列出「Journal 中该端口的值是摘要，真实值在 sidecar」的端口
缺省      字段缺失或不含某端口 ⇒ 该端口在 Journal 中的值【就是原值】
```

**必须逐端口而非逐节点**：同一节点完全可以一个端口 journal-safe、
另一个端口进 sidecar。节点级标量会迫使实现在两者间二选一，
要么泄漏、要么过度 fail-closed。

**这条同时解决两个不写下来就会踩的坑**：

```text
坑 1  Gate 输出根本不经 executor 的 NODE_SUCCEEDED 路径
      review 节点的输出由 GATE_RESOLVED 事件经 runJournal.js:122
      `outputs: clone(gate.output_artifacts || {})` 写入 projection。
      若下游无条件走 sidecar，gate --approved--> 下游 的边会直接炸。
      端口列表天然处理：gate 节点没有 outputs_custody ⇒ 走 Journal 原值。

坑 2  阶段 2 之前写下的旧 Journal 没有这个字段
      ⇒ 落入「字段缺失」缺省分支 ⇒ 旧 Journal 仍能正确 replay。
      向后兼容【不是】额外工作，是同一条规则的自然结果。
```

**读取端权威性（重申 §4.5 规则 4）**：`node_attempt` 必须取自
`projection.node_runs[id].node_attempt`（Journal 权威），
**绝不允许**从 sidecar 里挑一个「碰巧存在」的 attempt —— 那会绕过 D06 retry 语义。

### 阶段 3 —— D27 通道 ②③（与 D26 纠缠，**必须同一次提交**）

> **R2 明确：阶段 3 未被本轮裁决授权。** 阶段 2 实现并经独立审阅之后，
> 通道 ②③ 与 `fingerprint_version` 将获得一次**单独的显式裁决**。
> 不得因阶段 2 通过而顺势开工阶段 3。

`adapters/legacySynthesis.js` 停写 + `fingerprint_version`；
`humanGate.js` 的 `input_artifacts` 改为身份摘要。
**预期主动打红**至少 3 条既有断言（钉住 gap 那条 + D26 两条）——
**这是设计意图，不是回归**。

**阶段 3 允许永远不做**：通道 ②③ 无消费者，将其记为 `deferred`
并保留本文件的声明，是站得住的工程决策（同 D22–D25）。

### 4.9 阶段 2 与阶段 3 的关系（**R3 按实现实测重算；R2 的数字作废**）

> **R2 原文（作废，保留以记录数字是怎么过期的）**：
> ~~脱敏前 2 处；仅做阶段 2（通道 ①）后 **1 处**，剩余为通道 ②。~~
>
> **作废原因**：该量化产自「只脱敏 text 节点输出」的旧探针，
> 是在**形状 B 冻结之前**做的。形状 B 是允许清单，作用于**整个 `outputs`**，
> 而通道 ② 的原文位于 `outputs.result.metadata.request.text` —— **也在 `outputs` 里**。
> 方案换了，数字没重算。（教训 3，§0.2）

**R3 实测量化**（承重图 §4.1.1，阶段 2 实现真实运行，统计 Journal 全文原文出现次数）：

```text
脱敏前                              2 处
阶段 2 实现之后（形状 B 全量生效）   0 处   ← 通道 ①② 的 NODE_SUCCEEDED 持久化【一并消除】
```

逐事件定位（实测，非推断）：

```text
脱敏前   #7  NODE_SUCCEEDED [text]  payload.node.outputs.text.value                   通道 ①
         #11 NODE_SUCCEEDED [tts1]  payload.node.outputs.result.metadata.request.text  通道 ②
阶段2后  （无）
```

阶段 2 后 `tts1` 的 `audio` 端口在 Journal 中的实际形状（实测抓取）：

```text
{"artifact_id":"audio_gen_e2e","type":"AudioArtifact",
 "uri":"/outputs/generate/gen_e2e/audio.wav",
 "fingerprint":"sha256:3acb8bf…","fingerprint_kind":"descriptor",
 "redacted_fields":{"kind":"opaque_digest","keys":["metadata"],"digest":"sha256:c44ba11…"}}
```

#### 4.9.1 **通道 ② 只被做掉了一半**（R3 冻结的精确措辞）

通道 ② 是**两件事**，阶段 2 只完成第一件。**不得**把它笼统说成「通道 ② 已修复」：

```text
✅ 阶段 2 已完成   停止将其【持久化】到 Run Journal
❌ 仍属阶段 3      adapter 停止【生成】它 + fingerprint_version
                   值仍在内存中由 legacySynthesis adapter 产生（sidecar 里的真实值仍带它）
                   D26 的 fingerprint 输入面【未变】
```

冻结的说法是「**通道 ② 的 Journal 持久化已消除，adapter 侧未变**」。

> ⚠️ **本图的 `GATE_CREATED` 不含原文**，故未出现在上表中 —— 因为承重图的 `review_target`
> 只连 `tts1.audio`，非 split 的 `AudioArtifact` 不带原文。
> **这不表示通道 ③ 已经干净**：R1 在另一种图形状下实测到 `GATE_CREATED` 含原文 = `true`。
> 通道 ③ 是否含原文**取决于图形状**，因此它**仍在阶段 3 范围内**，
> 只是没有在本次计数中出现。**不得把「本次没数到」当成「结构上不会有」。**

结论（**R3 按裁决 B1 重写，六条都必须照写，不得省略其一**）：

```text
1  通道 ① 的 Journal 持久化【已消除】
2  通道 ② 的 Journal 持久化【也已消除】，但 adapter 仍在内存中生成它
3  D26 的 fingerprint 输入面与 fingerprint_version 行为，阶段 2 【未变更】
4  通道 ③ 【未被触碰】，仍在阶段 3 范围内，且【取决于图形状】、结构上可达
5  D27 在阶段 2 之后【保持 open】
6  Journal 对通道 ①②③ 全面干净，仍需阶段 3
```

> **R2 原措辞「阶段 2 之后仅可声称通道 ① 已修复」作废** —— 它低估了阶段 2 的作用面。
> 但**不得**据此把 `metadata` 加回允许清单来迁就那句话：
> 那是**为了对齐一份写错的预测，而故意把用户原文继续留在盘上**。（裁决 B1）

#### 4.9.2 通道 ③ 的现状（R3 实测复核）

用「Gate 直连 text 输出」的图实测（`review_target <- text.text`）：

```text
 9 GATE_CREATED  review  PLAINTEXT
   payload.gate.input_artifacts
     = [{"artifact_id":"art_text","type":"TextArtifact","value":"<用户原文>"}]
   全 Journal 原文出现次数：1
```

`GATE_CREATED` 由 Gate 路径独立 append，**不经过 `NODE_SUCCEEDED`**，
因此**形状 B 结构上碰不到它**。R2 关于「通道 ③ 取决于图形状」的判断**正确并予保留**：
承重图（§4.1.1）的 `review_target` 连的是 `tts1.audio`，故那张图数不到它，
**「本次没数到」仍然不等于「结构上不会有」**。

**阶段取舍方案 B（只做通道 ②③、把 ① 记为 deferred）已被明确否决**：那会保留主要原文来源，
Journal 不会变干净。

> ⚠️ 即便阶段 2 与阶段 3 都完成，**也不得声称「Aurivox 全系统不存储用户原文」** ——
> legacy `meta.json`（通道 ④）与客户端存储（通道 ⑤ / FLOW-D29）**始终在 D27 范围之外**。

### 4.10 两条既有测试的演进（**R3 冻结「改成什么」；R3 本身不改它们**）

阶段 2 会打红两条既有断言。两条都**必须**按下述方式演进，
**不得**用其它方式（尤其不得用「让它继续绿」的方式）绕过。

#### A2 —— `lib/workflow/executor.node.test.js:481`

```text
测试名   FLOW-D10b: the store is never asked about inline inputs
现状     inputs = { text: 'a raw script', … }  ← 裸字符串
为什么会红  它今天能过的【唯一原因】就是 'a raw script' 被逐字写进了 Journal，
            而新实例 replay 得以读回它。D27 要删掉的正是这一点。
```

冻结的改法：

```text
✅ 保留裸字符串场景【不变】
✅ 终态期望由 status === 'succeeded'
   改为 fail-closed：NODE_OUTPUT_VALUE_UNAVAILABLE 且 retryable === false
✅ 该测试【必须继续断言它的原主张】：assert.deepEqual(asked, ['voice_1'])
   —— Artifact Store 不因内联输入而被查询。这条主张与 D27 无关，不得被削弱。
✅ 必须在测试内写明：阶段 2 【有意】移除「含内容输出」的新实例 resume，
   因为保住它就等于要求把内容继续持久化到 Journal。

❌ 不得把裸字符串换成 ArtifactRef 来保住一条绿的成功断言。
   仅含身份字段的 artifact 输出已由 :203/:332/:352/:576 覆盖且仍可 resume（§4.8.1）；
   换掉 fixture 只会让「能力真的少了一块」这件事从测试里消失。
```

#### B1 —— `lib/flow.integration.node.test.js:265`

```text
现状     断言 Journal 原文中【包含】用户原文，注释写明这是 D27 的 gap 钉子
为什么会红  §4.9 —— 形状 B 一并消除了通道 ② 的持久化
```

冻结的改法：

```text
✅ 改为【反向断言】：Journal 中【不再包含】用户原文
✅ 注释必须记录：该守卫【按设计工作了】—— 它成功地把一次本可以是副作用的变更
   强制变成了一次显式裁决（FLOW-CORE-004 原注释的原话即为
   "fixing it must trip this test so the change is a decision rather than a side effect"）
✅ 注释必须同时写明本次仍未修复的部分：通道 ② 的 adapter 侧生成、通道 ③、
   以及 D27 仍为 open

❌ 不得删除该测试。反向断言此后就是通道 ①② 持久化的回归守卫。
```

#### 冻结的测试总数口径

```text
基线（R2 已应用，完整依赖环境实测）      204 / 204 / 0 / 0
阶段 2 新增 T1–T7                        +7
阶段 2 目标（完整依赖环境）              211 / 211 / 0 / 0
```

```text
A2 与 B1 是【修改】既有测试，不是新增 ⇒ 不改变总数。
仅当【恰好新增 7 条】时目标才是 211；数目不同必须重新核算并在交付中写明。
「211 / 211 / 0 / 0」在真正跑出来之前【不得】作为已观测结果登记 ——
未执行就报告为「尚未执行」，不得由推断填写。
```

### 明确不做
```text
通道 ④ meta.json          实测承重，动它等于移除 Rerun/Reload
通道 ⑤ 客户端             FLOW-D29 单独排期
Run Plan 持久化 / Store 写入侧 / Canvas
任何 drive-by fix         含 meta.json 中的绝对路径泄露（另记，不在本条）
```

---

## 5. 已提前预告的后果（避免被当成回归）

- 阶段 3 会让钉住 D27 的集成断言变红 —— **设计意图**。
- 采纳 Q4+Q5 后，**legacy 产物 fingerprint 会变**，跨版本恢复时 D10a 应明确拒绝比对。
- 若启用 C 开关：跨进程 resume 必须在 executor 层以
  `WORKFLOW_INPUT_REBIND_REQUIRED` 显式失败（HTTP 层为
  `FLOW_RUN_PLAN_UNAVAILABLE` / 409），**不得静默降级**。
- 测试总数会变。**每一轮交付必须明写期望总数**；「全绿」不构成验收。
- **（R2 新增）**阶段 2 的失败模式是**静默语义损坏**，不是红灯。
  验收必须断言**下游收到的值**，断言 `status` 或产物存在性**无效**。
- **（R3 新增）**阶段 2 会打红**两条既有测试**，两条都是**设计意图**，不是回归：
  `executor.node.test.js:481`（按 A2 改为 fail-closed）与
  `flow.integration.node.test.js:265`（按 B1 改为反向断言）。见 §4.10。
- **（R3 新增）**阶段 2 **确实损失能力**：§3.2 能力 ② 中「含内容输出」的那一半。
  交付说明中**必须主动写出这一点**，不得只写「已修复通道 ①②」。
  正确论证是**损失面与保护面严格同延**（§4.8.1），**不是**「零功能损失」——
  后者已被两次实测推翻，**不得再用**。
- **（R3 新增）**阶段 2 对 **WebUI 影响面为零，且是结构性的**：
  `web/src` 对 Flow 内核引用为 0；`executor` 仅经 `runtime.js` 被
  `server.js:1762` 的 `FLOW_ENABLED` 保护块引用，**默认关闭**。（§4.8 R3 复核）

---

## 6. 验证深度声明

```text
已实测（沙箱 Linux 无依赖 + 本地 Windows 完整依赖，两套环境结果逐字节一致）：
    通道 ①②③；脱敏对 D26 指纹的影响（两个不同 sha256）；artifact_id 不随之变化
已实测（本地真实 server + WebUI）：
    通道 ④ 承重 —— 清空 text/recipe.text 后 Rerun/Reload 失能
已实测（localStorage 实物）：
    通道 ⑤ 仅为编辑器缓冲区；generate.result 不含原文
已实测：D10a 输入快照脱敏在同一条 run 上仍成立
已实测：完整依赖环境 202 tests / 202 pass / 0 fail / 0 skipped（阶段 0 时点）

R2 新增 —— 阶段 2 三条前提已从「代码阅读假设」升级为「实测证据」
（承重图，沙箱 Linux 无依赖环境，node v24.18.1）：

    P0   图的有效性：gate 未解决时 tts2 未执行            PASS
    P1a  同进程 approve→resume 基线，下游收到原文          PASS
    P1b  通道 ① 脱敏后，下游仍收到原文                     【FAIL】
         status=succeeded 且零异常，但下游实收 "[[REDACTED]]"
         → 前提 1 被推翻并改写为「值保真」，见 §4.1
    P2   跨进程 resume fail-closed                         PASS
         实抛 WORKFLOW_INPUT_REBIND_REQUIRED（executor 层）
         → R1 写的 FLOW_RUN_PLAN_UNAVAILABLE 是 HTTP 层的码，已按层拆分
    P3   通道 ① 脱敏后 replay 状态机形状不变               PASS
    量化 Journal 原文出现次数 2 → 仅阶段 2 后 1 → 全脱敏后 0（§4.9）

**假 PASS 更正记录（必须保留）**：本组实测的第一版探针沿用 FLOW-CORE-004 标准图，
曾对 P1b 报告 **PASS**。该结果**无效**：该图 Gate 之后无任何节点回读 `text.text`，
**结构上不可能观测到承重性**；且当时的脱敏亦未覆盖全部通道。
承重图（§4.1.1）重做后 P1b 立即转为 FAIL。

未实测：真实 GPT-SoVITS 引擎下的 split 分支（本地缺 torch，本轮未排期）
        —— stub 形状逐字取自 synthesisService.js:226/278，但「抄的」不等于「测的」
未实测：阶段 1（D28）在**完整依赖**环境下的 204/204/0/0
        —— 已实测的是**无依赖**环境的 204/175/0/29。前者是验收目标，
        在真正跑出来之前**不得**当作已观测结果登记
未实测：localStorage 的 generate.hanReadings / hanForced 是否间接暴露原文结构
        —— 归入 FLOW-D29 待确认项，不在本文件作任何断言

R3 新增 —— 阶段 2【实现】实测（沙箱 Linux 无依赖环境，node v24.18.1）：

    改动面     lib/workflow/executor.js 【1 个仓库文件】（逐字节比对确认，
               另有 3 个 tools-not-in-repo/ 探针，不入仓库）

    测试演进   基线（R2 已应用）              204 / 175 / 0 / 29
               阶段 2 第一版（照 §4.8 字面）   204 / 170 / 【5】/ 29
               阶段 2 第二版（journal-safe）   204 / 174 / 【1】/ 29

    第一版 5 条红全部是 D10a/D10b 的 rebind 测试
      → 推翻 R2「跨进程 resume 本就不支持」的残留假设（§0.0 变化 1、§3.2）
      → 探针实测：新实例 + inputResolver resume 抛 NODE_OUTPUT_VALUE_UNAVAILABLE，
         retryable=false，即契约要求的行为本身删除了一个现有能力

    第二版剩余 1 条红 = executor.node.test.js:481（裸字符串），
      按 §4.10 A2 演进；该红灯【与保护面严格同延】，不可修

    P1b（承重探针，通道 ① 值保真）  FAIL → 【PASS】
    承重探针整体                     5 PASS / 0 FAIL
    flow.integration.node.test.js:132-141（形状 B 的 5 条目标断言）  全部 PASS
      → 用【真实 adapter normaliser】+ 完全复刻的 minimalWorkflow() 实测，非推断
    flow.integration.node.test.js:265  raw.includes(原文) = false
      → 会变红，按 §4.10 B1 演进
    通道 ③（Gate 直连 text 的图）    仍 1 处原文，未被触碰（§4.9.2）

未实测：阶段 2 在【完整依赖】环境下的结果
        —— 本沙箱中 flow.integration.node.test.js 属那 29 条 skipped，
           §4.10 B1 那条变红【只会在完整依赖环境显形】。
           上述结论由复刻真实图形的探针取得，【不得】登记为完整依赖环境的实跑结果
未实测：阶段 2 目标 211 / 211 / 0 / 0 —— T1–T7 尚未编写，目标不得当作已观测
```

**R3 本身零行为改动、零实现改动、零测试改动，无「已修复」可供声称。**

---

### 6.1 阶段 2 收尾实测（R3 之后落笔，逐条为实跑读数）

```text
环境：沙箱 Linux 无依赖，node v24.18.1

改动面（逐字节 CRLF 归一化比对 stage2 基线，全仓库扫描）  【7 项，无溢出】
    docs/FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md      R3 + 本节
    docs/FLOW-TECH-DEBT-MATRIX-2026-08-13.md         R3
    docs/HEALTH-BASELINE-FLOW-2026-08-13.md          R3 + 阶段 2 读数
    docs/README.md                                   R3
    lib/workflow/executor.js                         实现（唯一产品代码）
    lib/workflow/executor.node.test.js               A2 + T1–T7
    lib/flow.integration.node.test.js                B1
  → 产品代码只动了 1 个文件，与 §4.8 冻结的改动面一致

测试总数（无依赖环境实跑）        211 / 182 pass / 0 fail / 29 skipped
    基线 204 + T1–T7 七条 = 211。A2/B1 是【修改】既有测试，不增总数，核对相符。
    完整依赖目标仍是 211 / 211 / 0 / 0，【尚未跑出】，不得登记为已观测。

executor.node.test.js 单文件                          36 / 36 / 0 / 0
```

**变异测试（本轮唯一真正的验收依据，"全绿"不是）**

```text
方法：保留 T1–T7 与 A2，仅把 lib/workflow/executor.js 换回 R2 原版，重跑。
预期：这 8 条【必须】全红；任何一条不红，说明它测不到自己声称的东西。

第一次变异运行  7 红 / 【T1 未红】
  → T1 是【假 PASS】。根因：D27_TEXT 里含 \u0000，
    JSON.stringify 会把它转义成 "\u0000" 落盘，
    于是 raw.includes(D27_TEXT) 恒为 false ——
    Journal 里明明有原文，断言却报告"没有"。
  → 这与 D27 已经犯过两次的错同型：证据看起来在场，但它测的不是那个东西。
    第一次是承重图缺 Gate 后消费者；第二次是校验脚本给陈旧内容签名。
  → 修正：探针文本剔除一切会被 JSON 转义的字符，并在常量处写明原因。

第二次变异运行  【8 红 / 8】
  ✖ FLOW-D10b: the store is never asked about inline inputs   （A2）
  ✖ FLOW-D27 T1 值保真
  ✖ FLOW-D27 T2 端口键集 + custody + 不加包装
  ✖ FLOW-D27 T3 身份型输出仍可新实例 resume
  ✖ FLOW-D27 T4 sidecar 四元身份
  ✖ FLOW-D27 T5 缺值 fail-closed
  ✖ FLOW-D27 T6 append 失败不留可寻址值
  ✖ FLOW-D27 T7 全终态释放
  → 八条都真的绑在实现上。

正例（实现在位）  36 / 36 / 0 / 0
```

**探针复核（改动后读数，与 R3 §4.9 预言逐条对照）**

```text
probe-d27-stage2-channels.js
    #7  NODE_SUCCEEDED[text]  原文  →  【消失】（通道 ① 已停写）
    #9  GATE_CREATED[review]  原文  →  仍在（通道 ③，阶段 3 范围）
    Journal 原文出现总次数           2 → 【1】
    NODE_SUCCEEDED outputs 原文次数  2 → 【0】   ← §4.9 预言相符

probe-d27-stage2-integration-shape.js（真实 adapter normaliser）
    :265  raw.includes("こんにちは") = 【false】  → 按 B1 反转，相符
    :132-141  形状 B 五条目标断言    【全 PASS】  → D26 指纹面未变
    line 258  RUN_CREATED 无原文     true        → D10a 仍成立
    redacted_fields.keys = ["metadata"]          → 通道 ② 的 Journal 面也没了

probe-d27-stage2-crossinstance.js
    A 同进程 resume        succeeded，值保真 true      （能力 ①）
    B 新实例 + resolver     succeeded（身份型输入）      （能力 ② 的【正半边】）
    → 该探针用的是身份型输入，故仍绿；能力 ② 的【负半边】
      （含内容输出 → fail-closed）由 A2 与 T5 钉死，不由本探针覆盖
```

**仍未实测（不得推断）**

```text
未实测：完整依赖环境的 211 / 211 / 0 / 0
未实测：完整依赖环境下是否【只有】:265 与 :481 两条需要演进
        —— 本沙箱 29 条 skipped 覆盖了整个集成套件
未实测：真实 GPT-SoVITS 引擎下的 split 分支（本地缺 torch，仍未排期）
未实测：并发 / GPU 独占下的 sidecar 行为
```

**本轮之后可声称与【不可】声称**

```text
可声称：通道 ① 的 Journal 持久化已消除
可声称：通道 ② 的 Journal 持久化【连带】消除（adapter 侧未动，仍在内存中生成）
不可声称：D27 已修复 —— 通道 ③ 未动，D27 仍 open
不可声称：Aurivox 全局不存原文 —— legacy meta.json 与客户端存储不在 D27 范围
不可声称：跨进程 resume 不受影响 —— 能力 ② 对含内容输出【确有能力缩减】，
          见 §3.2 与 §4.10 A2，这是知情放弃而非回归
```

---

## 7. R3 的范围与状态措辞（逐条照抄，不得改写）

```text
R3 本身不改变任何运行时行为，且不修改任何实现或测试文件
阶段 2 之后，可声称：
  · 通道 ① 的 Journal 持久化已消除
  · 通道 ② 的 Journal 持久化【也】已消除
阶段 2 之后，不得声称：
  · 「通道 ② 已修复」—— adapter 仍在内存中生成 metadata.request.text
  · 「零功能损失」—— §3.2 能力 ② 中含内容输出的那一半确实失效
  · 「跨进程 resume 不支持」—— 必须区分 §3.2 的能力 ② 与 ③
D26 的 fingerprint 输入面与 fingerprint_version 行为，阶段 2 未变更
通道 ③ 未变更，仍在阶段 3 范围内，且取决于图形状、结构上可达
D27 在阶段 2 之后保持 open
Journal 对通道 ①②③ 全面干净，需要阶段 2 与阶段 3 两者都做
即便两阶段都完成，也不得声称 Aurivox 全系统不存储用户原文
  —— legacy meta.json（通道 ④）与客户端存储（通道 ⑤ / FLOW-D29）始终在 D27 范围外
阶段 3 未被本轮裁决授权，需在阶段 2 独立审阅后单独裁决
```

### 7.1 R3 之后的推进顺序（冻结）

```text
1  本 docs-only R3 修订通过独立审阅          ← 当前所处位置
2  补丁完整性校验通过（CRLF 归一化逐字节 sha256，且先确认哈希确实变了）
3  git status 仅显示预期文档 + 已知的 pack-src.ps1 既有改动
4  才开始完成阶段 2 的实现与测试：
     · 按 §4.10 A2 修改 executor.node.test.js:481
     · 按 §4.10 B1 反转 flow.integration.node.test.js:265
     · 新增 T1–T7
     · 无依赖【与】完整依赖两套环境各跑一次
     · 报告【实际观测到的】总数与 skip 原因，不得由推断填写
5  阶段 2 独立审阅通过后，通道 ②③ 与 fingerprint_version 再单独裁决
```

**Release gate（不变，每轮重申）**：不合并 main / 不 push main / 不 release /
不重建 `v1.0.8` tag / 未经单独批准不打归档。
`tools-not-in-repo/` 与 `verify-*.cjs` **不入仓库**。
