# Workflow Contract v1

> 工作流文档是可保存、可回载、可执行的 JSON。它描述意图和节点关系，不直接保存运行时进程状态。
>
> 产品形态：`Aurivox Workbench`（当前固定流程 UI）与 `Aurivox Flow`（专业节点工作流）共享本契约。详细架构决策见 [`FLOW-ARCH-001-DECISION.md`](./FLOW-ARCH-001-DECISION.md)。
>
> 本契约是架构设计，不代表当前已经有可用画布或执行器实现。

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
      "type": "String",
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
InferenceResult
TrainingAsset
GateDecision
ReviewRecord
ArtifactRef
Scalar
Boolean
String
```

端口类型不匹配时，Workflow 在执行前失败，而不是执行到一半才失败。

## 6. Node input bindings

Source nodes may bind a value to a Workflow input:

```json
{
  "id": "text",
  "type": "io.text_input",
  "type_version": 1,
  "params": {
    "workflow_input": "text"
  }
}
```

A non-source node may bind an unconnected input port to a declared Workflow input:

```json
{
  "id": "output",
  "type": "io.audio_output",
  "type_version": 1,
  "bindings": {
    "audio": {
      "workflow_input": "audio"
    }
  }
}
```

An input port is satisfied by exactly one of:

```text
incoming Edge
node binding
literal source-node parameter
```

A required port with none of these is a validation error. Bindings are declarations only; they do not execute code or read arbitrary paths.

## 7. 控制节点与人工等待

第一期允许的控制语义：

```text
control.if
control.and
control.or
control.not
control.retry
control.merge
control.fail
review.human_gate
```

`control.pause` 不是用户层面的人工审核节点。暂停是 Executor 的运行状态；需要用户查看产物并作出决定时，必须使用一等节点 `review.human_gate`。

### Human Gate

```json
{
  "type": "review.human_gate",
  "type_version": 1,
  "params": {
    "review_schema": "pronunciation.v1",
    "decisions": [
      "approve",
      "submit_revision",
      "reject",
      "cancel"
    ]
  }
}
```

Human Gate 输入一个或多个 `ArtifactRef`，进入 `awaiting_human_review` 后停止下游节点。Executor 必须持久化 Gate instance、输入 Artifact、预览信息和当前 Run，释放可释放资源；用户决策后从该 Gate 恢复。

Human Gate 必须声明显式输出端口：

```text
decision
review_record
approved
revised
rejected
```

`submit_revision` 表示用户已经提交编辑后的 payload，必须产生新的 Artifact 或 Revision，并把父产物写入 lineage。`reject` 不是系统故障；没有显式 `rejected` 出口时，Run 进入 `rejected` 终态并记录 `HUMAN_REVIEW_REJECTED`。

Human Gate 的具体呈现由 `review_schema` 决定，例如：

```text
pronunciation.v1
transcript.v1
audio_audition.v1
quality_report.v1
```

Human Gate 的详细输入、输出和状态语义见 [`NODE_AND_GATE_CONTRACT.md`](./NODE_AND_GATE_CONTRACT.md)。

## 8. 典型节点类型

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
review.human_gate
legacy.training_pipeline.v1
```

节点类型可以增加，但已发布 Workflow 的节点类型和版本必须可迁移或明确标记为 unavailable。

## 9. 执行规则

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
12. 执行后继节点或进入 `awaiting_human_review` / gate 状态。

## 10. Immutable Run Plan

创建 Run 前，Validator 根据 Workflow Revision 生成不可变 Run Plan：

```json
{
  "schema": "aurivox.run_plan",
  "schema_version": 1,
  "workflow_id": "tts_demo",
  "workflow_revision_id": "workflow_revision_003",
  "workflow_fingerprint": "sha256:...",
  "run_plan_fingerprint": "sha256:...",
  "node_order": ["text", "route", "review", "tts"],
  "nodes": [],
  "edges": []
}
```

Run Plan 必须固定：

```text
节点 type / type_version
节点 params / bindings
端口连接
资源声明
Workflow input declarations
DAG 执行顺序
```

以下 UI 属性不影响 execution fingerprint：

```text
node.position
node.label
workflow.description
workflow.created_at / updated_at
```

Run 创建后绑定 `workflow_revision_id`、`workflow_fingerprint` 和 `run_plan_fingerprint`。用户之后编辑 Flow，不改变已经创建或等待中的 Run。

Run Plan 是内存和持久化层面的只读快照。任何修改都必须创建新的 Workflow Revision 和新的 Run Plan。

## 11. 版本和迁移

- `schema_version` 只描述 Workflow Contract；
- `type_version` 描述单个 Node Contract；
- App 版本升级不自动修改旧 Workflow；
- 迁移必须显式运行；
- 无法迁移时应显示具体节点和字段，而不是静默改写。
