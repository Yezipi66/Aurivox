# FLOW-CORE-002C：Persistence / Retry Hardening

> 状态：Implemented hardening / local review required
>
> 目标：处理本地 AI 对 002B 指出的 Journal 崩溃窗口、调度失败分类和输入状态泄漏问题。

## 1. Journal 写入修复

旧风险：

```text
temp + rename
Windows rename-over-existing fallback
remove old file
process crash
```

当前改为：

```text
<run_id>.journal.ndjson
header line
one complete event per line
per-run Mutex
file handle sync()
torn final line detection
truncation to last complete event
```

特性：

- 不删除旧 Journal 再替换；
- 已写入的历史事件不会被后一次全量 JSON 覆盖；
- 末尾半行视为 torn tail，可以恢复到最后一个完整 event；
- 中间损坏行仍然报 `JOURNAL_CORRUPT`；
- 仍然是单进程边界，不宣称多进程数据库一致性。

## 2. Executor retry / blocked diagnostics

节点可以声明：

```json
{
  "retry_policy": {
    "max_attempts": 2,
    "backoff_ms": 500
  }
}
```

只有 handler 显式设置：

```js
error.retryable = true
```

才会进入重试。当前使用指数 backoff：

```text
attempt 1 → backoff_ms
attempt 2 → backoff_ms * 2
```

调度器没有可执行节点时，错误会附带：

```json
{
  "code": "EXECUTION_DEADLOCK",
  "blocked_nodes": [
    {
      "node_id": "tts",
      "status": null,
      "waiting_on": []
    }
  ]
}
```

当前不实现自动 timeout cancellation；超时需要由 handler 产生 `retryable` 或不可重试错误。

## 3. Workflow input Journal 安全边界

Journal 不再保存原始 `workflow_inputs`：

```text
ArtifactRef
  → artifact_id / type / fingerprint

String
  → length / sha256 digest

Number / Boolean
  → inline primitive

Object
  → opaque digest
```

同一 Executor 进程内仍保留 runtime input。进程重启后：

```text
有 inputResolver
  → 根据 snapshot 重新绑定

没有 inputResolver
  → WORKFLOW_INPUT_REBIND_REQUIRED
```

这样不会把长文本、路径或潜在敏感内容直接复制进 Run Journal，同时不会假装“重启后可以凭空恢复原始输入”。

## 4. 当前仍未解决

```text
Artifact Store
Input Artifact Resolver
多进程 / 多机器一致性
真正的 timeout cancellation
ResourceManager
真实 TTS integration
```

## 5. 证据

当前 Node 测试：

```text
142 tests
121 pass
0 fail
21 skipped
```

新增覆盖：

```text
Journal torn tail repair
Journal no raw input payload
Executor restart input rebind requirement
retryable handler failure
retry policy attempt count
```
