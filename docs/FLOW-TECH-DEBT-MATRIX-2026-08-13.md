# Aurivox Flow 技术债处理矩阵 — 2026-08-13

> 用于 FLOW-CORE-003B 及后续迭代。
>
> 重要区分：`Fail-closed / Warn-override / Observe` 描述运行时遇到问题时的处理动作；`P0 / P1 / P2 / P3` 描述开发迭代是否需要暂停。两套维度不能混为一谈。

## 0. 摘要（先看这张表，避免把「编号总数」误读为「欠债总数」）

> 更新于 2026-08-13（阶段 1 / D28 已修复）。**编号 D16–D20 从未使用**，是留白不是漏记。

| 分类 | 条目 | 数量 | 含义 |
|---|---|---|---|
| 已覆盖（设计之初即实现且有测试） | D01 D02 D03 D04 D05 D08 D09 | 7 | 从未欠过 |
| fixed（欠过、已还、有回归覆盖） | D06 D07 D10a D10b D21 D26 **D28** | **7** | 连续未修复轮数均为 0 |
| warn-override **策略项**（§3） | D11 D12 D13 D14 D15 | 5 | **不是债** —— 是「该警告而非拒绝」的设计规范 |
| deferred（显式记录、不伪装支持） | D22 D23 D24 D25 | 4 | 边界已写死 |
| **open** | **D27 D29** | **2** | 均为 2026-08-13 实测新发现 |

```text
open = 2（D28 已于阶段 1 修复并有两条回归守卫）
两条全部由 2026-08-13 实测挖出，不是历史积压
无一条阻断发布：Flow 由 FLOW_ENABLED 保护且默认关闭
```

**读法提醒**：本矩阵把「已还的」与「欠的」放在同一张表里，滚动阅读容易高估欠债量。
判断实际负债请只看本节的 `open` 行与 §4.1 的「累计连续未修复轮数」列。

## 1. 开发迭代规则

```text
P0
  暂停当前功能推进，优先修复

P1-P3
  原则上记录并继续当前迭代

同一实质问题连续两个迭代未修复
  暂停新增功能，进入集中清理
```

因此：

```text
某个 Run fail-closed
≠
整个项目必须停止开发
```

例如，恢复时 Run Plan mismatch 必须 fail-closed，但这不会阻止开发者继续做与其无关的纯 Service extraction。

## 2. Fail-closed 项

| ID | 场景 | 运行时动作 | 当前状态 | 责任文件 | 迭代级别 |
|---|---|---|---|---|---|
| FLOW-D01 | Journal header invalid | 拒绝 replay / 继续执行 | 已覆盖 | `fileJournalStore.js`, `runJournal.js` | P1 |
| FLOW-D02 | Journal 中间行损坏 | `JOURNAL_CORRUPT`，拒绝继续 | 已覆盖 | `fileJournalStore.js` | P1 |
| FLOW-D03 | sequence gap / duplicate event | 拒绝 append / replay | 已覆盖 | `runJournal.js` | P1 |
| FLOW-D04 | Run Plan / Workflow identity mismatch | 拒绝恢复 | 已覆盖 | `executor.js` | P1 |
| FLOW-D05 | 输入无法重新绑定 | `WORKFLOW_INPUT_REBIND_REQUIRED` | 已覆盖 | `executor.js` | P1 |
| FLOW-D06 | retryable handler 有未确认的副作用 | 禁止 retry 或将 Run 置为 failed | **已覆盖（FLOW-CORE-003B-DEBT）** | `executor.js`, `validator.js` | P1 |
| FLOW-D07 | retry backoff 期间收到 cancel | 必须停止等待/执行并记录取消 | **已覆盖（FLOW-CORE-003B-DEBT）** | `executor.js` | P1 |
| FLOW-D08 | Gate 状态/revision 冲突 | 拒绝 resolve | 已覆盖 | `humanGate.js` | P1 |
| FLOW-D09 | Artifact revision parent/lineage 无法证明 | 拒绝提交 Revision | 已覆盖基础校验 | `humanGate.js`, Artifact Store | P1 |
| FLOW-D10a | inputResolver 返回值从不与 `workflow_input_snapshot` 对账，可静默换掉恢复输入 | 逐 kind 对账 + 双向键集合检查，不符即拒绝恢复 | **已覆盖（FLOW-D10-INPUT-REBIND-CONTRACT R1 §2）** | `executor.js` | P1 |
| FLOW-D10b | typed Artifact 取回 / 权限 / lineage 的完整 resolver 契约 | 契约冻结后再实现，不提前假装支持 | **fixed（只读切片）**，R1 已冻结，见 [`FLOW-D10B-ARTIFACT-STORE-CONTRACT.md`](./FLOW-D10B-ARTIFACT-STORE-CONTRACT.md)；写入 / GC / retention / cache key / 权限**未做且不并入本条**，见 §4.2 | `executor.js`, `artifactStore.js` | P1（003B 不阻断） |
| FLOW-D26 | legacy adapter 产出的 Artifact 无 fingerprint，且 `artifact_id` 可派生自 `audio_url` | 补 **descriptor** fingerprint（含 `uri`，失败 fail-closed）；`artifact_id` 改为不透明且**确定性**的摘要派生 | **fixed**，5 条回归测试，见 §3.1 | `adapters/legacySynthesis.js` | P1 |

### 2.1 Journal 尾部损坏的边界

只有在以下条件同时满足时，才允许 best-effort 修复：

```text
损坏内容位于文件最后
之前的 event 全部可解析
无法解析的内容被明确判断为 torn tail
```

如果“最后一行带换行但 JSON 损坏”，不能因为它在尾部就默认忽略；除非有额外完整性证明，否则仍然 fail-closed。中间损坏永远 fail-closed。

## 3. Warn-override 项

| ID | 场景 | 运行时动作 | 前提 |
|---|---|---|---|
| FLOW-D11 | 非核心参数不符合推荐范围 | 警告，允许用户确认继续 | 不影响状态机、路径和身份 |
| FLOW-D12 | 语言/音色/文本 heuristic 不确定 | 警告 + 人工确认 | 不自动篡改已确认 Artifact |
| FLOW-D13 | 质量型 digest 不完全匹配 | 警告 + 用户决定 | 该 digest 不参与恢复身份/缓存键 |
| FLOW-D14 | retryable 失败但副作用已被明确声明幂等 | 警告或自动 retry | 必须有明确 idempotency declaration |
| FLOW-D15 | 输入格式不规范但可安全解释 | 友好提示 | 不改变 Artifact / Run 身份 |

### 3.1 Fingerprint 的特殊规则

不能按“核心/非核心 Artifact”简单决定 warn 或 fail：

```text
用于 Run Plan identity / Journal replay / cache key
  → mismatch 必须 fail-closed

只用于质量提示、推荐或展示
  → mismatch 可以 warn-override
```

**FLOW-D26 落点（已修复）**：`adapters/legacySynthesis.js` 现在为 `AudioArtifact` 与
`InferenceResult` 都产出 fingerprint，并额外标注 `fingerprint_kind: 'descriptor'`。

三条不可退让的规则，均由 `legacySynthesis.node.test.js` 的 5 条回归测试钉死：

```text
1. descriptor 必须包含 uri
   仅哈希 {generation_id, files, segments, source} 时，legacy 常见的
   “三者皆空” 响应会塌缩成同一个常量摘要 —— 不同音频共享同一 fingerprint，
   D10a 的 fingerprint 比对随之退化为恒真。

2. artifact_id 必须确定性且不透明
   用 Date.now()/随机数生成 id 会让身份依赖挂钟，破坏幂等重试去重与
   未来的 run cache key；直接用 audio_url 则把“位置”当成“身份”。
   取 descriptor 摘要前 32 位同时满足两项。

3. 序列化失败必须 fail-closed
   fingerprint 回落为 null 会被 D10a 的对账逻辑直接跳过，
   等于把 D26 要消除的弱身份状态又静默恢复回来。
   因此抛 LEGACY_TTS_FINGERPRINT_FAILED，不返回 null。
```

**这不是内容哈希**：adapter 从未读取音频字节，`audio_url` 也未必本地可读。
`fingerprint_kind: 'descriptor'` 就是为了防止下游把它误当作内容摘要。
真正的内容级验证属于 FLOW-D10b / Artifact Store，此处**刻意不伪造**。

## 4. Observe 项

| ID | 场景 | 说明 |
|---|---|---|
| FLOW-D21 | runtimeInputs Map 生命周期 | **已覆盖（FLOW-CORE-003B-DEBT）**：所有 executor 出口经 `_settle()`，Run 进终态即删除；`awaiting_human_review` 刻意保留供同进程 resume |
| FLOW-D22 | Journal 大小轮转 / retention | 进入 Artifact Store / retention task 后处理 |
| FLOW-D23 | 多进程 / 多机器 Journal 一致性 | 当前明确 local single-process，不伪装支持 |
| FLOW-D24 | retry policy 细分网络/GPU OOM/输入错误 | 当前统一 retryable，后续按错误域细分 |
| FLOW-D25 | 脏数据长期治理和统计 | 先记录指标，再集中治理 |

`retry backoff` 的取消本身不是纯 Observe：在真实用户可取消执行中，它最终需要 fail-closed 语义。003B 时它被判为「不阻断」，随后在 `FLOW-CORE-003B-DEBT` 收敛轮中实现，见 [`FLOW-CORE-003B-DEBT-CONVERGENCE.md`](./FLOW-CORE-003B-DEBT-CONVERGENCE.md) 与健康基线 [`HEALTH-BASELINE-FLOW-2026-08-13.md`](./HEALTH-BASELINE-FLOW-2026-08-13.md)。

## 4.1 本轮（FLOW-CORE-003B-DEBT）滚存计数

| ID | 本次迭代状态 | 累计连续未修复轮数 | 是否达到集中清理门槛 |
|---|---|---|---|
| FLOW-D06 | fixed | 0 | no |
| FLOW-D07 | fixed | 0 | no |
| FLOW-D21 | fixed | 0 | no |
| FLOW-D10a | fixed | 0 | no |
| FLOW-D10b | fixed（只读切片；完整 Store 另立条目，见 §4.2） | 0 | no |
| FLOW-D26 | fixed | 0 | no |
| **FLOW-D27** | **open — 契约 R1 已冻结，实现分阶段（阶段 0 完成，零代码）** | **1** | no |
| **FLOW-D28** | **fixed（阶段 1，根治 + 2 条回归守卫，见下）** | 0 | yes |
| **FLOW-D29** | **open — 新增（客户端原文留存），低优先级，未排期** | 0 | no |
| FLOW-D22 / D23 / D24 / D25 | deferred（明确记录，不伪装支持） | — | no |

### FLOW-D27｜输出原文经由 Journal 持久化

**发现方式**：FLOW-CORE-004 首次真实端到端运行实测（**不是审阅推断**）。

**事实**：D10a 保证的输入快照脱敏成立——`RUN_CREATED` 事件只含
`{kind, artifact_id, type, fingerprint}`。但**节点输出是逐字持久化的**，
而 legacy adapter 会把请求文本回填进 `InferenceResult.metadata.request.text`，
因此用户输入的原文最终仍落进 append-only 的 Journal 文件。

**为什么不顺手修**：

1. 属**契约冲突**而非实现瑕疵——Journal 存输出是可重放性的基础，删掉会削弱 replay；
2. 改动 `metadata` 会连带改变 D26 的 descriptor fingerprint 输入面，
   属于「契约先冻结再实现」明确禁止的动作。

**已采取的措施**：在 `lib/flow.integration.node.test.js` 中**显式钉住当前行为**，
并在注释中标明这是 **gap 而非保证**。任何修复都会让该测试变红，
**强制其成为一次决策而不是副作用**。

**裁决问题**：Journal 是否应持久化节点输出的原文？若否，replay 如何重建输出？

#### 2026-08-13 更新（草案 R0）：上面这段「事实」已被实测证明**不完整**

完整暴露面见 [`FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md) §1。
三点修正，每点都会改变修复方案：

1. **原文的源头不是 adapter**，而是 `NODE_SUCCEEDED(io.text_input)` 的
   `outputs.text.value`。**只改 adapter 的 metadata 不解决 D27**，只会让它看起来被解决。
2. split 路径上逐段原文还会进入 **`AudioArtifact.metadata.segments[].text`**，
   而 `segments` 在 D26 的 audio descriptor 内 —— 实测脱敏前后 fingerprint 不同。
   现有那条钉住 D27 的集成断言跑的是**非 split** 路径，**没有覆盖这条通道**。
3. `GATE_CREATED.payload.gate.input_artifacts` 是第三条独立通道（`clone()` 而非引用摘要）。

另有第四条通道在 Flow 之外：`server.js` 的 `writeGenMeta()` 早已把 `text` /
`recipe.text` / `ref_text` 写进 `outputs/generate/<id>/meta.json`，且是 Workbench
历史与 Rerun 的依赖。**因此「只抹 Journal」得到的是看起来脱敏的系统**，
范围问题必须先裁决（草案 Q1）。

**承重性修正**：只有通道 ① 承重（跨进程 resume 时下游节点从
`projection.node_runs[].outputs` 取输入）。通道 ②③ 当前**无任何 handler 读取**，
是纯审计负载。所以「隐私 vs 可重放性」的两难比原记载小得多，代价主要是
**审计信息量与 D26 指纹稳定性**。

**倾向方案（待裁决）**：现在只冻结契约与声明，行为改动并入 D10b 写入侧那一轮；
通道 ②③ 的脱敏必须与 `fingerprint_version` 同一次提交，否则是一次静默的产物身份变更。

#### 2026-08-13 裁决（R1 冻结）—— 以上各段仅为发现过程记录

**唯一实现依据**：[`FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-CONTRACT.md)（R1）。
本节上方的「事实」「裁决问题」「倾向方案」等表述**不再作为实现依据**。

裁决要点：

```text
范围   仅 Flow 持久层（Run Journal）。通道 ④（meta.json）与 ⑤（客户端）
       明知含原文、明确不在范围内 —— ④ 已实测承重（抹除后 Rerun/Reload 失能）
方案   E：现在 A（声明）/ 目标 D（值经 Store）/ 过渡 C（显式开关）；B 明确否决
前置   fingerprint_version 为硬性前置 —— 实测「指纹变、artifact_id 不变」，
       该组合在 artifactStore.js:111-116 下与「产物被篡改」不可区分
阶段   0 冻结（本轮，零代码）→ 1 修 D28 → 2 通道①→ 3 通道②③（允许永不做）
```

**通道 ④ 与 ⑤ 的声明**：Flow 持久层**不做出比 legacy 持久层更强的隐私承诺**。
任何「Flow 不落用户原文」的表述均为虚假承诺，见 R1 §1.1 的「不成立说法」清单。

### FLOW-D28｜缺依赖环境下 runtime 单测红灯而非 skip

**发现方式**：本轮在无 `node_modules` 的环境实跑 `scripts/run_tests.cjs`。

**事实**：`lib/workflow/runtime.node.test.js` 顶层 require `../routes/flow`，
后者顶层 require `express`，于是缺依赖时**整套件加载失败红灯**
（`MODULE_NOT_FOUND`），而 `lib/flow.integration.node.test.js` 在同样环境下带原因 skip。
这与 FLOW-CORE-004 自己写下的「缺依赖时 skip 而非红灯」纪律不一致。

```text
无 node_modules 实跑：191 tests / 161 pass / 1 fail / 29 skipped
                      191 + 12 − 1 = 202（套件加载即失败时，它的 12 条根本没被计数）
```

> 这同时是「只核对全绿不足以验收、必须核对总数」的又一个实例 ——
> 这里是**总数变小**先暴露了问题。

**根因**：纯函数 `statusFor()`（错误码→HTTP 映射）住在一个必须 require express 的模块里。

**本轮不修**（属实现改动，且需先决定 `statusFor` 该住哪）。候选：移到不依赖
express 的模块；或让测试按 `runtimeSkipReason()` 守卫。

#### 2026-08-13 裁决：根治（抽出零依赖模块），列为实施阶段 1

本地审计确认（`lib/routes/flow.js:42-48`）：`statusFor()` 只读 `err.status`、
`err.code` 与 `Object.freeze` 常量 `STATUS_BY_CODE`，不触碰 `req` / `res` /
模块级可变状态 / I/O / 时钟 / 随机 —— **是纯函数**。运行时依赖方只有
`server.js:1762-1765`，而它依赖的是 router factory，**不引用 `statusFor`**；
直接引用 `statusFor` 的只有 `lib/workflow/runtime.node.test.js:22`。

```text
新建 lib/workflow/errorStatus.js            零依赖，statusFor + STATUS_BY_CODE
改   lib/routes/flow.js                     从新模块引入
改   lib/workflow/runtime.node.test.js:22   必须直接 require 新模块
```

> ⚠️ **「在 flow.js 保留 re-export、测试不改」不算修复。**
> 测试若仍 `require('../routes/flow')`，依旧会触发顶层 `require('express')`，
> 缺依赖时依旧整套件红灯、12 条依旧不计数 —— 改了却没修，与 D26
> 「文档宣称 fixed 但保护未生效」同形。
>
> **验收条件**：在**移除 `node_modules`** 的环境下确认该套件不再整套件失败。
> 仅凭完整环境「全绿」不构成验收。

#### 2026-08-13 阶段 1：已修复（fixed）

实际改动就是上面裁决的三条，**没有多做一行**：

```text
新建 lib/workflow/errorStatus.js          零依赖（连 node 内建模块也不 require）
改   lib/routes/flow.js                   从新模块引入；删除末尾两行 re-export
改   lib/workflow/runtime.node.test.js    require('./errorStatus') + 2 条回归守卫
```

**搬移逐条核对**：11 个映射项与 `statusFor()` 函数体与原 `lib/routes/flow.js:25-48`
**完全一致**，本轮没有顺手改任何一个状态码。

**re-export 已删除**，不留兼容层。理由写在 `flow.js` 末尾的注释里：留着它，
任何人都能继续从 route 模块 import 而把 express 拖回来，债就会以「看起来已修」
的形式复活。仓库内没有任何其他消费者（`server.js:1762-1765` 只要 router factory）。

**验收（在移除 `node_modules` 的环境实跑，即 D28 的目标环境）**：

```text
修复前：191 tests / 161 pass / 1 fail / 29 skipped   ← 套件加载失败，12 条不计数
修复后：204 tests / 175 pass / 0 fail / 29 skipped   ← 套件正常加载并全部通过
        202 + 2（新增守卫）= 204
```

**两条守卫为什么必须是「读源码」而不是「跑用例」**：修好的性质是
「**缺依赖时**这套件仍能加载」，这在依赖完整的机器上**结构上不可观测** ——
跑一万次绿灯也证明不了它。所以只能靠读源码钉死：

| 守卫 | 钉住什么 | 反例验证结果 |
|---|---|---|
| `errorStatus.js` 零依赖 | 该文件不得出现任何 `require(` | 追加 `require("path")` → **红** |
| 本套件不经 route 模块 | 不得 `require('../routes/flow')` | 改回原写法 → **红** |

反例验证是必须的：**没被反例验证过的守卫，和没有守卫是一回事**（D26 教训）。
第一条反例同时复现了 D28 本身 —— 改回原 require 后，无依赖环境立刻退回
`191 / 161 / 1 / 29`，逐位等于修复前。

**行为未变**（有 express 时实测）：router factory 仍可构造；
`400/409/503/501/404/500` 六类映射与「显式 `err.status` 优先」均不变；
`STATUS_BY_CODE` 仍 frozen；`flow.js` 上的 `statusFor` / `STATUS_BY_CODE` 已为 `undefined`。

**本条 fixed 的确切含义**：修好的是「测试可加载性」这一条，**不多不少**。
它不表示 Flow 的错误映射变得更完备，也不表示其他套件的依赖健壮性被检查过 ——
本轮只看了 `runtime.node.test.js` 这一条 require 链。

### FLOW-D29｜客户端（浏览器）留存用户原文

**发现方式**：D27 本地审计的副产物 —— 为验证通道 ④ 而检查 `localStorage` 实物。

**事实（已实测）**：`web/src/usePersistentState.js` 以命名空间 `tf.v1.` 把若干编辑器
状态明文写入 `localStorage`，其中 `tf.v1.generate.text` 保存当前编辑框内容并**跨会话留存**
（仅在修改 `NS` 前缀时整体失效）。

**同轮被证伪的推断**：曾据代码路径推断 `tf.v1.generate.result` 也含原文。
localStorage 实物证明**不含** —— `/api/generate` 的响应本身只回传
`{ok,id,voice,split,concat,engine_batch,audio_url,seed}`。

```text
教训：客户端侧结论必须以实际存储内容为准，不得从代码路径推断。
      本轮该推断连续两次过强，均由实物纠正。
```

**待确认（不作断言）**：`generate.hanReadings` / `generate.hanForced` 按汉字与位置
索引保存读音覆盖，是否间接暴露原文字符集与结构，**未实测**。

**定性**：低优先级。桌面单机应用，与 D27 属不同存储介质、不同生命周期、不同责任方，
**明确不并入 D27**。未排期。

**关于 FLOW-D10 的拆分与重新计数**：原 FLOW-D10 在上一轮记为 open / 连续 1 轮。经 2026-08-13 评审（[`FLOW-D10-INPUT-REBIND-CONTRACT.md`](./FLOW-D10-INPUT-REBIND-CONTRACT.md) §6 Q1）拆为两条独立债务，理由是二者阻塞原因不同：D10a 的对账材料已全在 Journal 中、不依赖任何未落地组件，且是一条能静默产出错误产物的路径；D10b 客观阻塞于尚不存在的 Artifact Store。

拆分**不得**被用作规避集中清理门槛的手段。判据是：D10a 已在同一轮内实际修复并有测试覆盖，而非改名后继续搁置。D10b 从 0 重新计数，若其在后续迭代中持续 open 且 Artifact Store 已具备条件，仍按原规则触发门槛。

## 4.2 FLOW-D10b 标记 fixed 的确切含义（防止过度声称）

D10b 记为 fixed 指的是**契约 R1 §3 的只读取回切片已实现并有测试**，不是「Artifact Store 已经做好了」。按同一条拆分判据，本轮确实在同一轮内实现并覆盖了所声称的范围，而非改名搁置。

**已实现**：

```text
describe() 存在性校验 + type / fingerprint 对账
四个错误码，UNAVAILABLE 与 NOT_FOUND 分离且前者 retryable
Q5 禁止项由构造期断言强制（不是仅写在文档里）
校验顺序固定为「先 D10a 对账，后 Store」
createMemoryArtifactStore 参考实现（测试与本地单进程用）
```

**明确未实现，且不得算进本条**（契约 §5 原样保留）：

```text
写入 / 提交新 Artifact
GC 与 retention 执行
lineage revision 分配
cache key 计算
权限模型（Q3 裁决为「留位不定义」，ctx 参数存在但无语义）
跨进程 / 跨机一致性（沿用 FLOW-D23 的 local single-process 声明）
openContent() 的真实内容读取 —— 参考实现直接抛 ARTIFACT_CONTENT_UNSUPPORTED
```

上述条目应在需要时**另开债务条目**，不得因为 D10b 已 fixed 而被视为已支持。

**验证深度仍是 L1**（契约 §4，Q2 裁决）：比对的是 Store 自报的 fingerprint。**L1 没有消除信任，只是把信任从 resolver 转移到了 Store** —— 允许原地覆写而不更新 fingerprint 的 Store 一样能骗过 L1。字节级保证只有 L2，对 ModelCheckpoint 不现实，本切片不实现。

## 5. 当前代码映射

```text
lib/workflow/fileJournalStore.js
  FLOW-D01 / D02 / D03 / D22 / D23

lib/workflow/runJournal.js
  FLOW-D01 / D02 / D03 / D08 / D21

lib/workflow/executor.js
  FLOW-D04 / D05 / D06 / D07 / D10a / D10b / D21 / D24

lib/workflow/humanGate.js
  FLOW-D08 / D09

lib/workflow/validator.js
  retry_policy / resource_policy / Workflow identity 的前置校验

lib/workflow/artifactStore.js
  FLOW-D10b（只读切片：describe 对账 / Q5 禁止项 / 错误码）

lib/workflow/adapters/legacySynthesis.js
  typed request/response mapping + FLOW-D26 的 fingerprint 与 artifact_id 身份
```

## 6. 与 FLOW-CORE-003B 的关系

003B 的范围是：

```text
抽出不依赖 Express 的 synthesis service
保持 Workbench API 行为不变
让 Workbench 和 Flow 共用同一个 service
```

003B 不新增：

```text
retry policy
Journal 状态语义
Artifact GC
ResourceManager
多进程一致性
```

因此：

```text
FLOW-D06 / D07 / D10a
  003B 当轮只记录不扩张；已在随后的 003B-DEBT 收敛轮修复

FLOW-D10b
  继续记录，不在 Artifact Store 落地前假装支持

FLOW-D01-D05
  作为当前 Executor 基础约束保留
```

## 7. 两轮规则记录方式

每个实质问题必须使用稳定 ID：

```text
FLOW-D06
FLOW-D07
FLOW-D10a
FLOW-D10b
```

ID 一经使用不得回收或改写含义。拆分时保留原 ID 作为前缀（`D10` → `D10a` / `D10b`），使历史记录仍可追溯到同一问题域。

审阅时记录：

```text
本次迭代状态：open / fixed / deferred
累计连续未修复轮数：0 / 1 / 2
是否达到集中清理门槛：yes / no
```

只有同一实质问题连续两个迭代仍为 open，才触发暂停新增功能；不同的新问题不与旧问题混算。
