# FLOW-ARCH-002：Human Gate / Artifact Revision / Run Resume

> 状态：Proposed contract / R1 draft，待架构评审后 Accepted
>
> 本文件只冻结语义，不实现 Executor、API、数据库或 Flow 画布。
>
> 上位决策：[`FLOW-ARCH-001-DECISION.md`](./FLOW-ARCH-001-DECISION.md)

## 1. 目标

Aurivox Flow 必须能够把推理或数据处理产物展示给用户，等待用户确认、拒绝或修改，然后从同一个 Run 继续执行。

这不是浏览器层面的 modal，也不是把任务重新提交一次。它必须是可持久化、可恢复、可审计的执行状态。

## 2. R1 已冻结的决定语义

第一版 Human Gate 只接受以下四种决定：

```text
approve
submit_revision
reject
cancel
```

### 2.1 approve

用户批准当前输入 Artifact。Gate 生成 `ReviewRecord`，并通过明确的 `approved` 输出端口暴露被批准的 ArtifactRef。输入 Artifact 本身不复制、不修改。

### 2.2 submit_revision

用户已经提交编辑后的内容。Executor 验证编辑结果，创建新的 Artifact Revision，生成 `ReviewRecord`，Gate resolved，Run resuming。

`submit_revision` 不表示“请求上游生产者以后返工”。未来如果需要返工请求，再增加独立的：

```text
request_regeneration
request_revision
```

这两个决定不属于第一版。

### 2.3 reject

用户拒绝当前产物。它是业务决定，不是系统异常：

```text
Workflow 声明 rejected 出口
  → 沿 rejected 分支继续

Workflow 未声明 rejected 出口
  → Run = rejected
  → termination_code = HUMAN_REVIEW_REJECTED
```

第一版不把用户拒绝伪装成 `failed`。`failed` 保留给执行异常、输入错误、资源错误和节点失败。

### 2.4 cancel

用户取消当前 Run：

```text
Run = cancelled
```

`cancel` 永远是 Run 级终止，不作为普通业务分支出口。

## 3. 核心对象

```text
Human Gate Node
  Workflow 中的声明式节点

Gate Instance
  某次 Run 到达该节点后产生的持久化等待实例

Review Schema
  描述如何展示和编辑待审核 Artifact 的 UI/数据契约

Review Decision
  用户对本次 Gate 的决定

Review Record
  决定、用户、时间、评论、输入和输出的审计记录

Artifact Revision
  用户修改审核产物后产生的新不可变 Artifact
```

## 4. Canonical Node

规范节点类型：

```text
review.human_gate
```

示例：

```json
{
  "id": "review_pron_001",
  "type": "review.human_gate",
  "type_version": 1,
  "params": {
    "review_schema": "pronunciation.v1",
    "decisions": [
      "approve",
      "submit_revision",
      "reject",
      "cancel"
    ],
    "timeout_policy": "none"
  }
}
```

业务节点不自行实现暂停、等待、恢复和用户身份记录。业务差异通过 `review_schema` 描述。

### 4.1 输入端口

```text
review_target: ArtifactRef[]
review_schema: string
review_policy: object
```

### 4.2 输出端口

输出端口必须是显式的，不能让 Executor 或 UI 猜测批准后到底传递哪一个 Artifact：

```text
decision: GateDecision
review_record: ReviewRecord
approved: ArtifactRef[]
revised: ArtifactRef[]
rejected: ReviewRecord
```

规则：

```text
approve
  → decision + review_record + approved

submit_revision
  → decision + review_record + revised

reject
  → decision + review_record + rejected

cancel
  → decision + review_record；Run 终止，不进入普通业务分支
```

没有对应结果的端口不产生输出。`approved` 必须指向被批准的具体 Artifact ID，而不是隐式复用“输入数组”。

## 5. Review Schema

第一期允许的 schema 示例：

```text
pronunciation.v1
transcript.v1
audio_audition.v1
quality_report.v1
training_preview.v1
```

Review Schema 至少声明：

```text
schema id / version
可预览的 Artifact 类型
可编辑字段
编辑结果的 Artifact 类型
可用 decisions
是否允许批量选择
是否允许重新生成预览
```

例如 `pronunciation.v1` 可以接收：

```text
TextArtifact
LanguageAssignment
PronunciationRecipe
```

并产生：

```text
PronunciationRecipe revision
ReviewRecord
```

Review Schema 只描述展示和编辑契约，不拥有 Run 状态机。

## 6. Gate Instance

Run 第一次执行到 Human Gate 时创建：

```json
{
  "gate_id": "gate_01J...",
  "run_id": "run_01J...",
  "node_id": "review_pron_001",
  "node_attempt": 1,
  "gate_revision": 1,
  "status": "awaiting_review",
  "review_schema": "pronunciation.v1",
  "input_artifacts": [
    "artifact_text_01J...",
    "artifact_recipe_01J..."
  ],
  "available_decisions": [
    "approve",
    "submit_revision",
    "reject",
    "cancel"
  ],
  "created_at": "...",
  "resolved_at": null,
  "decision": null,
  "operator": null,
  "comment": null,
  "output_artifacts": []
}
```

约束：

```text
gate_id 全局唯一
(run_id, node_id, node_attempt) 唯一
同一个 node_attempt 只创建一个 Gate Instance
节点重试产生新的 node_attempt 和新的 Gate Instance
旧 Gate 只能保持 resolved / superseded / invalidated
```

第一版不需要额外的 `gate_sequence`。如果未来允许同一个 node attempt 内多次等待，再单独扩展该语义。

### 6.1 Gate 状态

```text
awaiting_review
resolving
resolved
superseded
invalidated
```

最小有效状态转换：

```text
awaiting_review → resolving → resolved
awaiting_review → invalidated
awaiting_review → superseded
```

- `resolved`：已经接受一个合法决定；
- `superseded`：节点重试或新的 Gate Instance 取代了它；
- `invalidated`：Run 被取消、Workflow 不再可恢复或输入完整性失效。

`Run.awaiting_human_review` 和 `GateInstance.awaiting_review` 是两个不同状态，不能混用。

## 7. 运行状态机

### 7.1 首次到达

```text
Node ready
  ↓
create GateInstance
  ↓
write Run Journal event
  ↓
Run = awaiting_human_review
  ↓
release GPU / model resources
  ↓
stop downstream scheduling
```

### 7.2 用户决定

```text
approve
  → record ReviewRecord
  → Gate = resolved
  → Run = resuming
  → downstream uses explicit approved output

submit_revision
  → validate edited payload
  → create new Artifact Revision
  → record parent lineage
  → Gate = resolved
  → Run = resuming
  → downstream uses explicit revised output

reject
  → record ReviewRecord
  → explicit rejected branch or Run = rejected

cancel
  → record ReviewRecord
  → Run = cancelled
```

Run 状态：

```text
created
validated
queued
running
awaiting_human_review
resuming
succeeded
rejected
failed
cancelled
interrupted
stale
```

禁止静默行为：

```text
不允许 approve 后悄悄使用未批准的 Artifact
不允许 submit_revision 原地覆盖输入
不允许 reject 后无记录地继续下游
不允许浏览器刷新导致 Gate 丢失
不允许重启后把等待中的 Run 重新从头执行
不允许把用户 reject 记成普通系统 failure
```

## 8. Workflow Revision 固定

Run 创建时必须绑定不可变的 Workflow Revision，而不是只保存可变的 `workflow_id`：

```json
{
  "workflow_id": "workflow_voice_001",
  "workflow_revision_id": "workflow_revision_003",
  "workflow_fingerprint": "sha256:...",
  "run_plan_fingerprint": "sha256:..."
}
```

等待期间用户可以编辑 Flow，但已经暂停的 Run 继续使用创建时绑定的 Workflow Revision 和 Run Plan。恢复时不能自动切换到最新 Workflow。

如果绑定的 Workflow Revision 已经无法读取，应报告存储完整性错误，而不是静默迁移到最新版。

## 9. Artifact Revision 语义

每个 Revision 都是独立且不可变的 Artifact，Artifact ID 必须是不透明 ID：

```json
{
  "artifact_id": "art_01J...",
  "type": "PronunciationRecipe",
  "fingerprint": "sha256:...",
  "lineage": {
    "lineage_id": "lin_01J...",
    "revision": 2,
    "parent_artifact_id": "art_01H...",
    "reason": "human_revision"
  }
}
```

第一版允许同一 `lineage_id` 出现分支：

```text
同一 lineage_id
  ├─ revision 2：中文方案
  └─ revision 3：粤语方案
```

因此：

```text
artifact_id 全局唯一
(lineage_id, revision) 唯一
parent_artifact_id 必须属于同一 lineage
revision 在 lineage 内由存储层分配
不强制 revision = parent.revision + 1
```

不把 `_v2` 拼进 Artifact ID。版本信息只放在结构化字段中。

### 9.1 修改摘要

结构化、可编辑的 Artifact 可以记录：

```json
{
  "change_set": {
    "changed_fields": [
      "/entries/12/reading",
      "/language_assignments/4/lang"
    ],
    "change_summary": "Changed two pronunciation assignments.",
    "patch_artifact_id": null
  }
}
```

- `changed_fields`：机器可读的 JSON Pointer 列表；
- `change_summary`：可读摘要；
- `patch_artifact_id`：可选的结构化 diff Artifact。

音频、模型等二进制产物不强制支持通用 JSON Patch。

## 10. 恢复、并发和幂等

Gate resolution 使用 `gate_revision` 做乐观并发控制。API 可以把它映射为 HTTP `If-Match`，但核心契约不依赖具体 HTTP 实现：

```text
resolve(gate_id, expected_gate_revision, decision)
```

持久化更新必须同时满足：

```text
gate_id = expected gate
status = awaiting_review
gate_revision = expected_gate_revision
```

成功后：

```text
gate_revision += 1
status = resolved
```

失败返回结构化错误：

```text
GATE_ALREADY_RESOLVED
GATE_REVISION_CONFLICT
GATE_INVALIDATED
```

同一个 Gate 可能被多个浏览器标签页打开，但只有第一个合法决定可以改变 Gate 状态。

### 10.1 Resolve 的逻辑提交顺序

实现可以使用数据库事务、文件锁或 Journal/outbox，但必须满足同一个逻辑原子边界：

```text
1. 验证 Gate 尚未解决、版本匹配、Run 仍有效
2. 验证 edited payload（如有）
3. 创建 Artifact Revision（如有）
4. 创建 ReviewRecord
5. 生成明确的 Gate output ArtifactRefs
6. 写入 GATE_RESOLVED Journal event
7. Gate = resolved
8. Run = resuming，或 reject/cancel 的终态
9. 提交持久化边界
10. Executor 根据已提交事件幂等调度下游
```

如果进程在提交后、下游调度前崩溃，恢复器必须能从 Journal 看到 Gate 已解决且下游尚未完成，然后只调度缺失的 NodeRun。不能先在内存里恢复，再补写 ReviewRecord。

## 11. Preview 与 Artifact 保留

Preview 的来源必须是 Artifact，而不是前端临时复制的对象。

```text
Artifact Store
   ↓
Preview Resolver
   ↓
Workbench review panel / Flow inspector
```

生命周期规则：

```text
Gate = awaiting_review
  → Preview Artifact 持有 retention hold

Gate = resolved
  → 按 Run retention policy 保留

Run = failed / rejected / cancelled
  → 保留到审计保留期结束

显式 Purge Run
  → 才允许清理仍未被其他对象引用的 Preview Artifact
```

建议引用原因至少能表达：

```text
artifact_ref_owner = gate_instance
retention_hold = awaiting_human_review
```

审核页面关闭不等于取消审核。只有用户明确选择 `cancel`，或者 Run 被显式取消，才改变运行状态。

## 12. 资源语义

人工等待期间不持有长时间资源锁：

```text
GPU lock：释放
模型 residency：允许被其他任务驱逐
临时文件：保留到 Gate 完成或 Run 清理
Run Journal：持续保留
Gate preview Artifact：必须可访问
```

用户批准或提交 Revision 后，Executor 重新进入 ResourceManager，不能假设等待前的 GPU / 模型状态仍然存在。

## 13. 质量门关系

Human Gate 与 Quality Gate 是两个不同概念：

```text
Quality Gate
  自动指标 / 规则 / 模型评分

Human Gate
  用户查看产物并作决定
```

两者可以串联：

```text
TTS
  → quality.audio_basic
  → review.human_gate
  → publish
```

自动 Quality Gate 的 `fail` 可以阻止 Human Gate；`warn` 可以把报告交给 Human Gate；具体组合策略由 Workflow 声明，不由 UI 猜测。

## 14. 第一版不解决的问题

以下内容暂不在本契约中做复杂化：

- 多用户权限和远程 operator；
- Gate 转交给其他用户；
- 超时自动批准；
- 多人并行审核投票；
- 任意第三方 Review Schema 热加载；
- 跨机器 Artifact 复制；
- 任意图循环中的 Human Gate；
- `request_regeneration` / `request_revision` 返工语义。

当前目标是 Windows + NVIDIA 本地单用户 / 可信内网工作流。

## 15. 文档验收标准

在进入 Executor 实现前，本契约必须能回答：

```text
Run 为什么等待
等待什么 Artifact
用户能做哪些决定
决定后产出什么
如何恢复同一个 Run
如何释放和重新申请 GPU
如何防止重复提交
如何保留审计记录
如何固定 Workflow Revision
如何让 Workbench 和 Flow 使用同一份审核数据
```
