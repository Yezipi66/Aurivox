# Node and Quality Gate Contract v1

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

## 6. 人工审核门

```json
{
  "type": "quality.human_review",
  "version": 1,
  "params": {
    "title": "Review extracted vocals",
    "decisions": ["approve", "reject", "retry"]
  }
}
```

人工审核结果也必须写入 Run Journal：

```json
{
  "decision": "approve",
  "operator": "local-user",
  "timestamp": "...",
  "comment": "Vocals are clean"
}
```

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

## 9. Legacy Adapter

现有步骤先用 adapter 包装：

```text
legacy.denoise.v1 → lib/training/steps/denoise.js
legacy.slice.v1 → lib/training/steps/slice.js
legacy.asr.v1 → lib/training/steps/asr.js
legacy.train.v1 → lib/training/pipeline.js
```

Adapter 稳定后，再逐个替换为原生 Node。
