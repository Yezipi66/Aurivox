# Aurivox Flow 技术债处理矩阵 — 2026-08-13

> 用于 FLOW-CORE-003B 及后续迭代。
>
> 重要区分：`Fail-closed / Warn-override / Observe` 描述运行时遇到问题时的处理动作；`P0 / P1 / P2 / P3` 描述开发迭代是否需要暂停。两套维度不能混为一谈。

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
| FLOW-D22 / D23 / D24 / D25 | deferred（明确记录，不伪装支持） | — | no |

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
