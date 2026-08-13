# Node and Quality Gate Contract v1

> `Aurivox Workbench` 与 `Aurivox Flow` 共用 Node Contract。Flow 的人工等待不是前端局部逻辑，而是 Executor 和 Run Journal 的一等语义。
>
> 架构决策见 [`FLOW-ARCH-001-DECISION.md`](./FLOW-ARCH-001-DECISION.md)。

## 1. Node 注册表

每种节点通过注册表声明：

```js
{
  type: 'asr.transcribe',
  version: 1,
  label: 'Transcribe audio',
  inputSchema: {...},
  outputSchema: {...},
  parameterSchema: {...},
  resourcePolicy: {...},
  validate(context, inputs, params),
  estimate(context, inputs, params),
  execute(context, inputs, params),
  cancel(context, nodeRun),
}
```

第一期 Node API 不强制 TypeScript，但必须有可验证 schema。

## 2. validate

`validate()` 只检查执行前条件：

```text
文件存在
Artifact 类型正确
模型可用
路径在允许范围内
参数合法
显存/磁盘需求可接受
```

失败时返回结构化结果：

```json
{
  "ok": false,
  "code": "MODEL_MISSING",
  "message": "Required S2 checkpoint is missing",
  "blocking": true,
  "details": {}
}
```

## 3. estimate

估算不是承诺，只用于 UI 预览：

```json
{
  "duration_ms": null,
  "vram_mb": 4096,
  "disk_mb": 1200,
  "requires_gpu": true,
  "exclusive_gpu": true,
  "confidence": "low|medium|high"
}
```

## 4. execute

节点执行必须：

- 只读取声明的 inputs；
- 只写入 Artifact Store；
- 不直接修改别的 node 的文件；
- 支持日志回调；
- 支持取消信号；
- 返回输出 ArtifactRef；
- 把关键 metrics 写入 NodeRun。

## 5. Quality Gate

质量门不是一个特殊的 if，而是有标准结果的 Node：

```json
{
  "type": "quality.audio_basic",
  "version": 1,
  "params": {
    "min_duration_sec": 3,
    "max_silence_ratio": 0.8
  }
}
```

结果：

```json
{
  "gate_id": "gate_001",
  "status": "pass",
  "blocking": true,
  "score": 0.92,
  "metrics": {
    "duration_sec": 5.2,
    "silence_ratio": 0.08,
    "clipping_ratio": 0.001
  },
  "message": "Audio passed basic checks",
  "evidence": [
    "artifact://run_001/gate_001/report.json"
  ]
}
```

状态：

```text
pass
warn
fail
skipped
needs_review
```

## 6. Human Review Gate

人工审核门的规范节点名是：

```text
review.human_gate
```

它接收待审核的 Artifact，展示由 `review_schema` 决定的预览界面，并让用户作出决定。它不是普通的 `quality` 布尔判断，也不是只在浏览器内暂停的组件。

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
    ],
    "timeout_policy": "none"
  }
}
```

### 6.1 输入输出

```text
inputs:
  review_target: ArtifactRef[]
  review_schema: string
  review_policy: object

outputs:
  decision: GateDecision
  review_record: ReviewRecord
  approved: ArtifactRef[] (optional)
  revised: ArtifactRef[] (optional)
  rejected: ReviewRecord (optional)
```

`approved` 必须明确指向被批准的 Artifact；不能依赖下游节点隐式复用输入数组。

`review_schema` 负责描述如何展示和编辑目标 Artifact，例如：

```text
pronunciation.v1
transcript.v1
audio_audition.v1
quality_report.v1
```

### 6.2 等待和恢复

首次执行 Human Gate 时：

1. 创建持久化 `GateInstance`；
2. 记录 `node_attempt` 和 `gate_revision`；
3. 将 Run 状态改为 `awaiting_human_review`；
4. 写入输入 Artifact、review schema 和预览引用；
5. 写入 Run Journal event；
6. 释放可释放的 GPU / 模型资源；
7. 不执行下游节点。

Gate 状态至少包括：

```text
awaiting_review
resolving
resolved
superseded
invalidated
```

用户提交决定后，Executor 必须使用 `gate_revision` 做乐观并发校验，并以幂等方式恢复：

```text
approve
  → resolved → approved output → resuming → downstream

submit_revision
  → validate payload → new Artifact revision
  → resolved → revised output → resuming → downstream

reject
  → resolved → explicit rejected output
  → no rejected edge: Run = rejected

cancel
  → Run = cancelled
```

重复提交统一返回结构化错误：

```text
GATE_ALREADY_RESOLVED
GATE_REVISION_CONFLICT
GATE_INVALIDATED
```

同一个 Gate 的重复提交不能重复执行下游节点。

### 6.3 审核结果

人工审核结果必须写入 Run Journal：

```json
{
  "gate_id": "gate_01J...",
  "decision": "approve",
  "operator": "local-user",
  "timestamp": "...",
  "comment": "Pronunciation confirmed",
  "input_artifacts": ["artifact_pron_v1"],
  "output_artifacts": ["artifact_pron_v1"],
  "review_schema": "pronunciation.v1",
  "gate_revision": 2
}
```

审核修改不得原地覆盖输入 Artifact。用户编辑后必须生成新的 Artifact，并记录 `parent_artifact_id` / lineage。

## 7. 社区扩展规则

社区可以提供：

- Quality Gate；
- ASR adapter；
- 音频分析器；
- 模型 adapter；
- 评估指标；
- 自定义推理节点。

第一期必须遵守：

- 本地显式安装；
- 不自动执行未知代码；
- 节点 type/version 明确；
- 输入输出 schema 明确；
- 失败可恢复；
- 依赖清单明确；
- 不允许静默修改用户资产。

## 8. 资源策略

节点声明：

```json
{
  "requires_gpu": true,
  "exclusive_gpu": true,
  "estimated_vram_mb": 4096,
  "can_run_on_cpu": false
}
```

当前单卡引擎必须通过 ResourceManager 串行化。未来即使 Flow 有多条分支，也不能未经资源调度直接并行调用同一个 TTS 引擎。

进入 `awaiting_human_review` 后，节点不应长期持有 GPU / 模型锁。恢复执行时重新申请资源，并由 NodeRun / Run Journal 保证恢复幂等。

## 9. Legacy Adapter

现有步骤先用 adapter 包装：

```text
legacy.denoise.v1 → lib/training/steps/denoise.js
legacy.slice.v1 → lib/training/steps/slice.js
legacy.asr.v1 → lib/training/steps/asr.js
legacy.train.v1 → lib/training/pipeline.js
```

Adapter 稳定后，再逐个替换为原生 Node。
