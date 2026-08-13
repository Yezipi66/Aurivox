# FLOW-CORE-002B：Journal Store / Executor Skeleton

> 状态：Internal implementation probe / not production Executor
>
> 本阶段验证 FileRunJournalStore、Plan identity、注入式 Node handler、Human Gate wait/resume 和失败映射；不接真实 GPT-SoVITS、不接 API、不接 ResourceManager。

## 1. 设计边界

```text
Workflow Validator / Run Plan
          ↓
WorkflowExecutor
  ├── injected node handlers
  ├── FileRunJournalStore
  ├── Run / Gate state model
  └── Journal replay
```

Executor 不从未知 `node.type` 自动加载代码。所有可执行 handler 必须由调用者显式注入：

```js
new WorkflowExecutor({
  journalStore,
  handlers: {
    'io.text_input': handler,
    'review.human_gate': handler,
    'tts.generate': handler,
  },
})
```

## 2. FileRunJournalStore

当前实现：

```text
每个 Run 一个 <run_id>.journal.ndjson
首行是 Journal header
后续每行是一个完整 event
每个 Run 使用单独 Mutex 串行追加
每次追加后执行 file handle sync
末尾半行可检测、截断并恢复到最后一个完整 event
```

这是本地单进程 / 单用户的持久化边界，不是多进程数据库事务。相比覆盖式 JSON，append-only event log 不需要删除旧 Journal 文件，能够减少 Windows replace fallback 的崩溃窗口。未来可以替换为数据库或更强的存储 adapter，但上层只依赖：

```text
create(journal)
read(run_id)
append(run_id, event)
replay(run_id)
listRunIds()
remove(run_id)
```

## 3. Executor skeleton

当前支持：

```text
start(plan, inputs)
resume(run_id, plan, gate decision)
```

当前骨架还提供：

```text
explicit retryable handler failure → bounded retry + exponential backoff
blocked scheduler → structured blocked_nodes diagnostics
workflow input snapshot → Artifact identity / digest only
```

执行流程：

```text
RUN_CREATED
→ RUN_VALIDATED
→ RUN_QUEUED
→ RUN_STARTED
→ topological node scheduling
```

普通 handler 返回：

```js
{
  status: 'succeeded',
  outputs: {},
  metrics: {}
}
```

Human Gate handler 返回：

```js
{
  status: 'waiting',
  gate: GateInstance
}
```

Executor 会：

```text
写入 NODE_STARTED
写入 GATE_CREATED
Run = awaiting_human_review
停止下游
```

恢复时：

```text
校验 workflow_revision_id / run_plan_fingerprint
校验 gate_revision
调用 resolveGate()
写入 GATE_RESOLVED
写入 RUN_RESUMED
继续未完成节点
```

## 4. 当前明确不做

```text
不自动导入社区代码
不按 node.type 动态 require
不执行真实 TTS
不执行训练
不实现 GPU 锁
不实现 Artifact Store
不实现 GC / retention
不实现 API
不实现并行分支
不实现 edge condition evaluator
```

如果 handler 缺失、不可重试 handler 抛错或调度无法继续，当前骨架将 Node 标记失败并将 Run 置为 `failed`，同时保留结构化错误和 blocked node diagnostics。明确标记 `retryable: true` 的错误才会按 node retry_policy 重试；这仍不是最终生产错误策略。

## 5. 验收证据

```text
FileRunJournalStore round-trip：通过
Human Gate wait / resume：通过
Run Plan mismatch：通过
handler failure mapping：通过
全量 Node tests：115 pass / 0 fail / 21 skipped
```

## 6. 下一步前的审阅重点

进入真正 Executor 前，需要本地 AI 重点审阅：

1. File Journal replace fallback 在 Windows 中的崩溃恢复边界；
2. `workflow_inputs` 是否应该直接写入 Journal，或改为 Input ArtifactRef；
3. handler 输入输出是否需要独立的 NodeExecutionContext 契约；
4. Gate output 如何被下游端口消费；
5. Executor 在等待 Gate 时是否能正确处理独立分支；
6. Node retry 和 `node_attempt` 的真实调度规则；
7. ResourceManager 接入后锁释放 / 重新申请位置；
8. 真实 Artifact Store 接入后的持久化一致性。
