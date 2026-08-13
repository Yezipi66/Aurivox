# Artifact and Run Contract v1

## 1. ArtifactRef

节点之间传递结构化引用：

```json
{
  "artifact_id": "artifact_01HXYZ",
  "type": "Transcript",
  "schema_version": 1,
  "uri": "artifact://run_001/asr_001/transcript.json",
  "fingerprint": "sha256:...",
  "producer": {
    "run_id": "run_001",
    "node_id": "asr_001"
  },
  "metadata": {
    "language": "zh",
    "source": "faster-whisper"
  }
}
```

## 2. Artifact 规则

- Artifact ID 不可变；
- 内容生成后默认不可变；
- 修改必须生成新 Artifact，不允许审核节点原地覆盖输入；
- 同一逻辑产物的修改通过 `lineage` 表达版本关系；
- 文件可以位于 `assets/`、`.staging/` 或 outputs，但业务层不直接依赖路径格式；
- Artifact 必须有 fingerprint；
- Artifact 的 producer、输入、参数和环境应可追溯；
- 清理时只能删除没有被活动 Run 或已发布资产引用的中间产物。

### 2.1 Artifact lineage / revision

```json
{
  "lineage": {
    "lineage_id": "lineage_pron_001",
    "revision": 2,
    "parent_artifact_id": "artifact_pron_v1",
    "reason": "human_revision"
  }
}
```

`artifact_id` 标识一个不可变版本；`lineage_id` 把同一逻辑产物的多个版本关联起来。人工审核批准可以产生 `ReviewRecord`；用户修改后必须生成新的 Artifact，并把父 Artifact 写入 lineage。

第一期允许同一 lineage 分支：

```text
artifact_id 全局唯一
(lineage_id, revision) 唯一
parent_artifact_id 必须属于同一 lineage
revision 由存储层在 lineage 内分配
不强制 revision = parent.revision + 1
```

Artifact ID 使用不透明标识，不把 `_v2` 等版本语义拼进 ID。结构化 Artifact 可以额外提供 `changed_fields`、`change_summary` 和可选的 `patch_artifact_id`；音频和模型等二进制产物不强制支持 JSON Patch。

## 3. 训练产物分类

```text
raw_audio
extracted_vocals
slices
transcript
pronunciation_review
hubert_features
semantic_features
s1_checkpoint
s2_checkpoint
published_asset
```

## 4. 推理产物分类

```text
reference_audio
reference_text
text_override
inference_audio
comparison_batch
quality_report
```

## 5. Run

```json
{
  "run_id": "run_20260808_001",
  "workflow_id": "workflow_voice_train_001",
  "workflow_revision_id": "workflow_revision_003",
  "workflow_fingerprint": "sha256:...",
  "run_plan_fingerprint": "sha256:...",
  "status": "running",
  "created_at": "2026-08-08T00:00:00Z",
  "started_at": "2026-08-08T00:00:02Z",
  "finished_at": null,
  "seed": 4060894425,
  "environment": {
    "app_version": "1.0.8",
    "python": "3.11.x",
    "node": "20.x",
    "torch": "...",
    "cuda": "cu121"
  },
  "node_runs": {},
  "outputs": [],
  "error": null
}
```

## 6. Run 状态

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

`awaiting_human_review` 是人工审核 Gate 的正式运行状态，不等同于普通进程暂停。进入该状态时，Run、Gate instance、输入 Artifact 和预览信息必须已经持久化，GPU / 模型锁等可释放资源必须释放。

状态转换必须受限：

```text
created → validated
validated → queued
queued → running
running → awaiting_human_review
awaiting_human_review → resuming
resuming → running
running → succeeded
running → rejected
running → failed
running → cancelled
running → interrupted
interrupted → running
```

`reject` 是业务终态：Workflow 声明 `rejected` 出口时沿显式分支继续；没有该出口时 `Run = rejected`，并记录 `termination_code = HUMAN_REVIEW_REJECTED`。`cancel` 始终进入 `cancelled`。旧的 `paused` / `awaiting_review` 名称如需兼容，只能作为读取层别名，不能在新 Run 中混用。

## 7. NodeRun

```json
{
  "node_id": "asr_001",
  "node_attempt": 1,
  "status": "succeeded",
  "inputs": {},
  "outputs": {},
  "started_at": "...",
  "finished_at": "...",
  "logs": [
    {
      "level": "info",
      "message": "ASR completed",
      "timestamp": "..."
    }
  ],
  "metrics": {
    "duration_ms": 1234,
    "gpu_vram_peak_mb": 4096
  },
  "error": null
}
```

## 8. GateInstance

每次进入 `review.human_gate` 都创建一个持久化 Gate instance：

```json
{
  "gate_id": "gate_01J...",
  "run_id": "run_001",
  "node_id": "review_001",
  "node_attempt": 1,
  "gate_revision": 1,
  "status": "awaiting_review",
  "review_schema": "pronunciation.v1",
  "input_artifacts": ["artifact_pron_v1"],
  "decisions": ["approve", "submit_revision", "reject", "cancel"],
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
```

Gate 状态：

```text
awaiting_review
resolving
resolved
superseded
invalidated
```

Gate instance 必须支持：

- 浏览器关闭后继续等待；
- 后端重启后继续等待；
- 使用 `gate_revision` 防止重复提交和并发覆盖；
- 记录 operator、时间、决定和评论；
- 记录审核产生的新 Artifact 或 Revision；
- 让 Executor 根据已提交 Journal event 幂等恢复下游节点。

## 9. Workflow Revision 与 Resolve 并发

Run 创建时固定：

```text
workflow_id
workflow_revision_id
workflow_fingerprint
run_plan_fingerprint
```

等待期间用户可以编辑 Flow，但已经暂停的 Run 继续使用创建时的 Workflow Revision 和 Run Plan，不自动切换到最新版。

Gate resolve 使用 `gate_revision` 做乐观并发控制。逻辑更新必须同时满足：

```text
gate_id = expected gate
gate.status = awaiting_review
gate_revision = expected revision
```

成功后递增 `gate_revision`，并以一个可恢复的 Journal 提交边界记录：

```text
Artifact Revision（如有）
ReviewRecord
Gate output ArtifactRefs
GATE_RESOLVED event
Gate = resolved
Run = resuming / rejected / cancelled
```

进程崩溃后，恢复器依据已提交 event 重新调度尚未完成的下游 NodeRun；不能在 ReviewRecord 落盘前先恢复执行。

## 10. Preview retention

`awaiting_review` 期间，Gate 所需的 Preview Artifact 必须带有保留标记：

```text
artifact_ref_owner = gate_instance
retention_hold = awaiting_human_review
```

Gate resolved 后按 Run retention policy 保留；Run failed / rejected / cancelled 后保留到审计期限。只有显式 Purge 且没有其他引用时才允许清理。

## 11. Cache key

Cache key 至少由以下内容组成：

```text
node type
node type version
normalized params
input artifact fingerprints
model fingerprints
environment compatibility key
```

不能只用文件名或路径作为 cache key。

## 12. Journal

Run Journal 必须支持：

- 进程重启后恢复；
- 判断某个 node 是否已经成功；
- 判断输出是否仍然存在；
- 判断输入是否发生变化；
- 找到失败节点；
- 从失败节点重新执行；
- 不重复执行已经成功且输入未变化的节点。

## 13. 兼容现有资产

现有 `assets/{voiceId}` 和 `.staging/{taskId}` 先作为 Legacy Artifact backend：

```text
现有目录结构不立即迁移
Workflow 层通过 adapter 读取它们
新产物逐步写入 manifest
```

避免一次性重写所有用户资产。
