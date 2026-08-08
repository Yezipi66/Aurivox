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
- 修改必须生成新 Artifact；
- 文件可以位于 `assets/`、`.staging/` 或 outputs，但业务层不直接依赖路径格式；
- Artifact 必须有 fingerprint；
- Artifact 的 producer、输入、参数和环境应可追溯；
- 清理时只能删除没有被活动 Run 或已发布资产引用的中间产物。

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
  "workflow_revision": 3,
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
queued
running
paused
awaiting_review
succeeded
failed
cancelled
interrupted
stale
```

状态转换必须受限：

```text
created → queued → running
running → paused
running → awaiting_review
running → succeeded
running → failed
running → cancelled
running → interrupted
paused → running
awaiting_review → running
interrupted → running
```

## 7. NodeRun

```json
{
  "node_id": "asr_001",
  "status": "succeeded",
  "attempt": 1,
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

## 8. Cache key

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

## 9. Journal

Run Journal 必须支持：

- 进程重启后恢复；
- 判断某个 node 是否已经成功；
- 判断输出是否仍然存在；
- 判断输入是否发生变化；
- 找到失败节点；
- 从失败节点重新执行；
- 不重复执行已经成功且输入未变化的节点。

## 10. 兼容现有资产

现有 `assets/{voiceId}` 和 `.staging/{taskId}` 先作为 Legacy Artifact backend：

```text
现有目录结构不立即迁移
Workflow 层通过 adapter 读取它们
新产物逐步写入 manifest
```

避免一次性重写所有用户资产。
