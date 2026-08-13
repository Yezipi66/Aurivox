# Aurivox Flow 内核健康基线 — 2026-08-13

> 内部稳定化记录。这是一条**健康基线**，不是发布声明，不构成 `v1.0.8` 重新打 tag 的依据。
>
> 既有的 [`HEALTH-BASELINE-2026-08-09.md`](./HEALTH-BASELINE-2026-08-09.md) 覆盖 Workbench 的 Reading Proofing 交接；本文件覆盖 **Aurivox Flow 内核（`lib/workflow/` + `lib/services/`）**，两者并列不互相取代。

## 1. 基线范围

```text
lib/workflow/validator.js          Workflow 校验 / 不可变 Run Plan
lib/workflow/nodeRegistry.js       17 个内建节点定义
lib/workflow/runState.js           Run / Gate 状态机
lib/workflow/humanGate.js          Gate 实例与 gate_revision 乐观并发
lib/workflow/runJournal.js         事件投影与顺序约束
lib/workflow/fileJournalStore.js   append-only NDJSON 持久化
lib/workflow/executor.js           调度、重试、取消、恢复
lib/workflow/adapters/legacySynthesis.js  typed ↔ legacy 映射
lib/services/synthesisService.js   与 Workbench 共用的合成 service
```

## 2. 基线时的行为契约

以下行为在本基线中**已实现且有测试覆盖**：

| 领域 | 契约 | 证据 |
|---|---|---|
| 图校验 | DAG 环检测、端口类型匹配、单入端口不接双边、必需输入缺失即拒 | `validator.node.test.js` |
| Run Plan | fingerprint 忽略 UI-only 的 label/position；revision 必须显式；Run Plan 深度不可变 | `validator.node.test.js` |
| Journal | append-only NDJSON；尾部半行截断到最后完整 event；**中间损坏 fail-closed**；重复 event id / 序列跳号拒绝 | `executor.node.test.js`、`runLifecycle.node.test.js` |
| 输入隐私 | Journal 不落原始 workflow inputs，只落 ArtifactRef 身份 / 长度 + digest / opaque digest | `executor.node.test.js` |
| 人工门 | approve / submit_revision / reject / cancel 四决策；`gate_revision` 挡重复与陈旧提交；等待中不跑下游 | `runLifecycle.node.test.js` |
| 恢复 | Run Plan identity mismatch 拒恢复；跨进程缺输入时 `WORKFLOW_INPUT_REBIND_REQUIRED` 且发生在 Gate resolve 之前 | `executor.node.test.js` |
| **输入重绑定** | **`inputResolver` 返回值必须与 `workflow_input_snapshot` 逐 kind 对账；键集合双向检查；不符即 `WORKFLOW_INPUT_REBIND_MISMATCH` fail-closed；失败不写 Journal；诊断带 digest/length 不带原文** | `executor.node.test.js`（FLOW-D10a） |
| **重试** | **仅在显式副作用声明下重试，否则 `NODE_RETRY_BLOCKED_SIDE_EFFECTS` fail-closed；指数 backoff；尝试次数有界** | `executor.node.test.js`（本轮新增） |
| **取消** | **调度循环 / 失败边界 / backoff 等待三处协作观察 abort；产出 `NODE_CANCELLED` + `RUN_CANCELLED` 并保留结构化 reason** | `executor.node.test.js`（本轮新增） |
| **运行时输入生命周期** | **终态释放，`awaiting_human_review` 保留** | `executor.node.test.js`（本轮新增） |
| 失败诊断 | 无可执行节点时给 `EXECUTION_DEADLOCK` + `blocked_nodes`（含 waiting_on 与 edge_id） | `executor.js` |

## 3. 基线测试证据

```text
环境：Linux 沙箱审阅环境 / Node v24.18.1 / 后端 Node 依赖未安装

node scripts/run_tests.cjs
  182 tests / 161 pass / 0 fail / 21 skipped

node --test lib/workflow/executor.node.test.js
  29 tests / 29 pass / 0 fail

node --test lib/workflow/artifactStore.node.test.js
  10 tests / 10 pass / 0 fail

node --test lib/workflow/legacySynthesis.node.test.js
  9 tests / 9 pass / 0 fail
```

演进：`144 / 123 / 0 / 21`（onboarding 时）→ `150 / 129 / 0 / 21`（D06/D07/D21 收敛）→ `155 / 134 / 0 / 21`（D10a）→ `160 / 139 / 0 / 21`（D26）→ `182 / 161 / 0 / 21`（D10b）。skipped 数始终为 21，即新增测试均未落进跳过区。

`21 skipped` 全部是 broker 集成测试因**缺少后端 Node 依赖**产生的环境性跳过，不是失败，也不是本轮引入。

依赖完整的开发机上同一套用例**已由用户实测确认为 `155 / 155 / 0 / 0`**（2026-08-13 D10a 验收）。即 21 个 skipped 确系环境性，非用例缺陷。

D26 新增 5 条后：把补丁 overlay 到**依赖完整的本地 AI 仓库快照**（`aurivox_patch_20260813-abce33db.zip`）上实跑，得 **`160 / 160 / 0 / 0`**（证据来源：测试直接证明）。

D10b 新增 22 条后，在同一依赖完整快照上复验：**`182 / 182 / 0 / 0`**（证据来源：测试直接证明）。即 21 个 skipped 确系后端 Node 依赖缺失导致，与用例本身无关。

按 1.0.8 稳定化纪律，任何引用本基线的报告都必须同时写明环境与 skipped 原因，不得把单一数字当成通用结论。

## 4. 基线时的已知空缺（不是缺陷）

以下内容**在本基线中明确尚未实现**，审阅时不应报为回归：

```text
Artifact Store（真实产物落库与 GC）
ResourceManager / GPU 独占锁的真实调度
Executor live wiring（synthesisService 尚未注入 Executor）
真实模型端到端推理 / 训练
timeout cancellation（超时自动取消）
多进程 / 多机 Journal 一致性（明确 local single-process）
Flow Canvas 前端
Artifact Store 的写入 / GC / retention / cache key / 权限（D10b 只做了只读取回）
Artifact 内容读取（openContent 的真实实现，即 L2 字节级验证）
```

**关于 FLOW-D10a 的一处已知局限**（契约 R1 §2.6，非缺陷）：`artifact_ref` 的对账证明的是**引用相同**，不是**内容相同**。Artifact 内容不可变这一点由 [`ARTIFACT_AND_RUN_CONTRACT.md`](./ARTIFACT_AND_RUN_CONTRACT.md) §2 在契约层面保证，**但未被 executor 验证**。内容级验证属 FLOW-D10b。

**关于 FLOW-D26（已修复）**：`adapters/legacySynthesis.js` 现在为 legacy 产出的两类 Artifact 都计算 fingerprint，`artifact_id` 改为**确定性且不透明**的摘要派生（不再来自 `audio_url`），序列化失败 fail-closed。D10a 对账对 legacy 来源不再静默降级为只比 `artifact_id`。

该 fingerprint 是 **descriptor 摘要，不是内容哈希**，并以 `fingerprint_kind: 'descriptor'` 显式标注 —— adapter 没有读取音频字节的能力。详见 [`FLOW-TECH-DEBT-MATRIX-2026-08-13.md`](./FLOW-TECH-DEBT-MATRIX-2026-08-13.md) §3.1。

**关于 FLOW-D10b（只读切片已实现）**：注入 `artifactStore` 后，rebind 会在 D10a 对账**之后**再向 Store 确认每个 artifact 仍存在且 type/fingerprint 一致。顺序不可颠倒 —— Journal 是本地 append-only，Store 是外部可变状态，先信更强的一方，Store 被污染时 D10a 仍能拦住。`ARTIFACT_STORE_UNAVAILABLE`（retryable）与 `ARTIFACT_NOT_FOUND`（不可重试）分离。**不注入 Store 时行为与 D10a 完全一致**，Store 是可选增强而非新的必要条件。

**验证深度是 L1，上面那条 D10a 局限并未消除**：比对的是 Store 自报的 fingerprint，**L1 只是把信任从 resolver 转移到 Store**，允许原地覆写而不更新 fingerprint 的 Store 一样能骗过它。字节级（L2）需要真实内容读取，本切片不实现。D10b 记 fixed 的确切边界见矩阵 §4.2。

## 5. 滚存债务

| ID | 状态 | 连续未修复轮数 |
|---|---|---|
| FLOW-D06 | fixed | 0 |
| FLOW-D07 | fixed | 0 |
| FLOW-D21 | fixed | 0 |
| FLOW-D10a（rebind 对账） | fixed | 0 |
| FLOW-D10b（Artifact Store 只读取回） | fixed（只读切片，完整 Store 另立条目） | 0 |
| FLOW-D26（legacy artifact 身份） | fixed | 0 |
| FLOW-D22 / D23 / D24 / D25 | deferred / observe | — |

FLOW-D10 已按冻结契约拆为 D10a / D10b，拆分理由与「不得用于规避门槛」的判据见债务矩阵 §4.1。D10b 记 fixed 的**确切范围与未实现清单**见矩阵 §4.2 —— 它不表示 Artifact Store 已经建成。

## 6. Release gate 状态

```text
不合并 main
不 push main
不 release
不重新创建正式 v1.0.8 tag
本地仓库需在核对 dev / main / origin/main 位置后提交
```

## 7. 复核这条基线的命令

```powershell
node scripts/run_tests.cjs
node --test lib/workflow/executor.node.test.js
node --test lib/workflow/runLifecycle.node.test.js
node --test lib/workflow/validator.node.test.js
node --check lib/workflow/executor.js
node --check lib/workflow/validator.js
```
