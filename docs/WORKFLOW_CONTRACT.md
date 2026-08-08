# Workflow Contract v1

> 工作流文档是可保存、可回载、可执行的 JSON。它描述意图和节点关系，不直接保存运行时进程状态。

## 1. 顶层结构

```json
{
  "schema": "aurivox.workflow",
  "schema_version": 1,
  "id": "workflow_voice_train_001",
  "name": "Voice training",
  "description": "Optional description",
  "created_at": "2026-08-08T00:00:00Z",
  "updated_at": "2026-08-08T00:00:00Z",
  "inputs": {},
  "nodes": [],
  "edges": [],
  "settings": {},
  "metadata": {}
}
```

### 必填字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 固定为 `aurivox.workflow` |
| `schema_version` | integer | 工作流契约版本，不等同于 App 版本 |
| `id` | string | 工作流标识，不随显示名变化 |
| `name` | string | 用户可见名称 |
| `nodes` | array | 节点列表 |
| `edges` | array | 节点连接 |

## 2. Node

```json
{
  "id": "asr_001",
  "type": "asr.transcribe",
  "type_version": 1,
  "label": "Transcribe",
  "params": {
    "engine": "faster-whisper",
    "language": "auto"
  },
  "position": {
    "x": 480,
    "y": 160
  },
  "disabled": false,
  "resource_policy": {
    "requires_gpu": true,
    "exclusive_gpu": true,
    "estimated_vram_mb": 4096
  },
  "retry_policy": {
    "max_attempts": 1,
    "backoff_ms": 1000
  }
}
```

### Node ID 规则

- 在一个 Workflow 内唯一；
- 只允许 ASCII `a-zA-Z0-9_-`；
- 不把显示名称作为 ID；
- 节点复制时生成新 ID；
- 节点类型由注册表解析，不允许前端自行执行未知类型。

## 3. Edge

```json
{
  "id": "edge_001",
  "from": {
    "node": "slice_001",
    "port": "audio_set"
  },
  "to": {
    "node": "asr_001",
    "port": "audio"
  },
  "condition": null
}
```

字段：

- `from.node`：源节点；
- `from.port`：源输出端口；
- `to.node`：目标节点；
- `to.port`：目标输入端口；
- `condition`：第一期允许引用控制节点输出，不能写任意 JavaScript。

## 4. Workflow 输入

输入应是显式声明的：

```json
{
  "inputs": {
    "source_audio": {
      "type": "AudioSet",
      "required": true,
      "label": "Source audio"
    },
    "voice_name": {
      "type": "string",
      "required": true,
      "label": "Voice name"
    }
  }
}
```

## 5. 端口类型

第一期定义以下基础类型：

```text
AudioFile
AudioSet
Transcript
PronunciationMap
LanguageAssignment
ModelCheckpoint
ModelPair
Recipe
QualityReport
ReviewDecision
InferenceResult
TrainingAsset
Scalar
Boolean
String
```

端口类型不匹配时，Workflow 在执行前失败，而不是执行到一半才失败。

## 6. 控制节点

第一期控制节点：

```text
control.if
control.and
control.or
control.not
control.pause
control.retry
control.merge
control.fail
```

### Pause

```json
{
  "type": "control.pause",
  "params": {
    "reason": "Review extracted vocals",
    "required_decision": "approve|reject|edit"
  }
}
```

Pause 状态必须写入 Run Journal，重启后仍然处于可恢复状态。

## 7. 典型节点类型

```text
io.audio_input
io.asset_input
audio.vocal_extract
audio.slice
asr.transcribe
text.proofread
text.pronunciation_preview
text.preprocess
train.s1
train.s2
asset.publish
tts.generate
evaluation.generate_matrix
evaluation.compare
quality.audio_basic
quality.asr_confidence
quality.human_review
legacy.training_pipeline.v1
```

节点类型可以增加，但已发布 Workflow 的节点类型和版本必须可迁移或明确标记为 unavailable。

## 8. 执行规则

执行器必须：

1. 校验 Workflow schema；
2. 校验节点类型和端口；
3. 检测 DAG 是否有环；
4. 计算可执行节点；
5. 检查输入 Artifact 是否存在；
6. 检查资源需求；
7. 计算 cache key；
8. 写入 node run 状态；
9. 执行节点；
10. 原子保存输出 Artifact；
11. 更新 Run Journal；
12. 执行后继节点或进入 pause/gate 状态。

## 9. 版本和迁移

- `schema_version` 只描述 Workflow Contract；
- `type_version` 描述单个 Node Contract；
- App 版本升级不自动修改旧 Workflow；
- 迁移必须显式运行；
- 无法迁移时应显示具体节点和字段，而不是静默改写。
