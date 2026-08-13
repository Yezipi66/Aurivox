# FLOW-CORE-003：Legacy Synthesis Adapter

> 状态：Pure adapter implemented / live integration pending
>
> 本阶段只把现有 Broker synthesis service 包装成 Flow Node handler，不修改 `server.js`、不复制 `synthesis.js`、不直接导入 Express。

## 1. 目标

让 Flow 后续可以把已有的：

```text
lib/routes/synthesis.js 的 generateService
```

接到：

```text
WorkflowExecutor → tts.generate
```

适配器不拥有推理逻辑，只负责：

```text
Typed Artifact inputs
      ↓
Legacy request body
      ↓
Injected generateService
      ↓
Typed AudioArtifact / InferenceResult
```

## 2. 适配边界

实现文件：

```text
lib/workflow/adapters/legacySynthesis.js
lib/workflow/legacySynthesis.node.test.js
```

入口：

```js
createLegacySynthesisAdapter({ generateService })
```

`generateService` 必须由上层显式注入。Adapter 不会：

```text
require Express
扫描 server.js
动态查找 route handler
加载未知 Python / Node 代码
```

## 3. 输入映射

Adapter 接收：

```text
inputs.text
inputs.voice
inputs.recipe (optional)
inputs.reference_audio (optional)
inputs.reference_text (optional)
inputs.language (optional)
node.params
workflow_inputs
```

输出到 Legacy Broker 请求的字段使用 allowlist，当前允许复用现有 synthesis service 的字段：

```text
voice
text
ref_audio
reference_text
pron_overrides
lang_overrides
auto_base_lang
text_lang
prompt_lang
gpt_model
sovits_model
seed
split / concat / engine_batch
以及现有推理参数
```

未知字段不会自动透传。

Node 参数优先级：

```text
recipe Artifact
  ↓
node.params 覆盖
  ↓
text / voice / explicit Flow inputs 覆盖身份字段
```

## 4. 输出映射

Legacy service 返回：

```json
{
  "ok": true,
  "id": "gen_001",
  "audio_url": "/outputs/generate/gen_001/audio.wav",
  "files": []
}
```

Adapter 输出：

```text
AudioArtifact
InferenceResult
```

```json
{
  "outputs": {
    "audio": {
      "artifact_id": "audio_gen_001",
      "type": "AudioArtifact",
      "uri": "/outputs/generate/gen_001/audio.wav"
    },
    "result": {
      "artifact_id": "inference_gen_001",
      "type": "InferenceResult"
    }
  }
}
```

Legacy response 的完整摘要保存在 `InferenceResult.metadata`，但 Adapter 不把它变成新的推理逻辑。

## 5. 当前已验证

```text
TextArtifact → text
VoiceRef → voice
PronunciationRecipe → allowlisted request fields
LanguageAssignment → lang_overrides
Legacy response → AudioArtifact / InferenceResult
缺少 typed input → structured adapter error
缺少 audio_url → structured adapter error
```

## 6. 当前未实现

```text
没有把 generateService 从 synthesis.js 导出
没有修改 server.js ctx 注入
没有新增 /api/flow route
没有真实模型调用
没有真实 Artifact Store 注册
没有真实 E2E 音频验证
没有把训练 pipeline 接入 Flow
```

当前适配器只能通过注入 fake 或真实 service 进行测试。Live wiring 是下一项集成任务，不应通过复制 synthesis.js 解决。

## 7. 下一步

进入 live integration 前需要确认：

1. `generateService` 是否抽到一个不依赖 Express 的 service module；
2. 该 service module 的请求和错误契约是否稳定；
3. Flow Artifact URI 如何映射到 Broker `ref_audio`；
4. Legacy response 的输出文件是否由 Artifact Store 接管；
5. 生成失败、取消和流式输出如何映射到 NodeRun。
