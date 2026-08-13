# FLOW-CORE-003B：Synthesis Service Extraction

> 状态：Implemented / live Flow wiring pending
>
> 目标：把现有 `/api/generate` 的合成业务逻辑从 Express Router 中抽出，使 Workbench HTTP route 和未来 Flow Adapter 共用同一份 service。

## 1. 变更边界

新增：

```text
lib/services/synthesisService.js
lib/services/synthesisService.node.test.js
```

修改：

```text
lib/routes/synthesis.js
```

旧的 `generateService` 逻辑已经从 route factory 中移动到：

```text
createSynthesisService(ctx).generateService
```

Route 仍然负责：

```text
Express router
API key middleware
in-flight / shutdown registration
asyncHandler / HTTP error translation
```

Service 负责：

```text
voice validation
TTS payload construction
reference validation
model switching
segment splitting
position override remap
engine-batch path
WAV output generation
concat
metadata
```

## 2. Service 契约

```js
const { generateService } = createSynthesisService(ctx)
const result = await generateService({ body })
```

Service：

- 接收 request-like `{ body }`；
- 不读取 `res`；
- 不写 HTTP response；
- 返回 JSON-serialisable service result；
- 使用注入的 `ctx` 依赖；
- 保留原有 `HttpError` 行为。

当前仍然保留 request-like 形态，是为了降低一次性改动风险。后续可以再把 body mapping 单独抽成 typed service request。

## 3. 行为保持要求

本次抽取不应改变：

```text
/api/generate
/v1/audio/speech
lang_overrides
pron_overrides
segment source_start
engine_batch
metadata
seed
reference validation
existing error responses
```

现有 Broker 集成测试在依赖完整的工作区中通过。

## 4. Flow 边界

当前 Flow Adapter：

```text
lib/workflow/adapters/legacySynthesis.js
```

已经可以把 typed Artifact 转成旧 service request，并把旧 response 转成：

```text
AudioArtifact
InferenceResult
```

但还没有把真实 `synthesisService` 注入 `WorkflowExecutor`。因此当前状态是：

```text
Service extraction：完成
Request/response adapter：完成
Executor live wiring：未完成
真实模型 E2E：未完成
```

## 5. 测试证据

`node scripts/run_tests.cjs` 的结果必须随运行环境记录，不能写成脱离环境的单一结论。

当前有两份有效证据：

```text
依赖完整的开发工作区：
144 tests
144 pass
0 fail
0 skipped

本地最小环境 / 未安装后端 Node 依赖：
144 tests
123 pass
0 fail
21 skipped
```

21 个 skipped 是既有后端集成测试依赖缺失导致的环境性跳过，不是失败。003B 相关 service/workflow tests 在本地审阅环境中为：

```text
31 pass
0 fail
```

报告必须同时记录依赖状态和 skipped 原因；不能把依赖完整环境的 `144/144/0` 当成所有机器的通用结果。

新增 service 测试：

```text
service 不依赖 Express response
缺少 voice/text 的验证行为保持
voice registration boundary 保持
```

## 6. 下一步

进入 `FLOW-CORE-003C` 前需要确认：

1. 是否把 request-like body 进一步收敛为 `LegacySynthesisRequest`；
2. 旧 service 的错误和取消语义如何转成 NodeRun；
3. 真实生成输出如何注册进 Artifact Store；
4. Flow executor 如何注入 service，而不是在 handler 中重复构造 context；
5. `streaming_mode` 是否在第一版 Flow 节点中支持。

当前不把 live wiring 和真实模型调用混入 003B。