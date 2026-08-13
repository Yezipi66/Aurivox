# FLOW-CORE-003B-DEBT：Executor 取消 / 重试副作用 / 运行时输入生命周期收敛

> 状态：Implemented / local review required
>
> 目标：在进入 `FLOW-CORE-003C` 之前，把技术债矩阵中连续滚存的 `FLOW-D06`、`FLOW-D07`、`FLOW-D21` 收敛掉，建立一个可复核的 Flow 内核健康基线。
>
> 本轮不新增功能，不接 live wiring，不引入依赖，不改动 Workbench 的任何 HTTP 行为。

## 1. 变更边界

修改：

```text
lib/workflow/executor.js
lib/workflow/validator.js
lib/workflow/executor.node.test.js
docs/FLOW-TECH-DEBT-MATRIX-2026-08-13.md
```

未修改：

```text
lib/routes/*
lib/services/synthesisService.js
lib/workflow/runJournal.js
lib/workflow/fileJournalStore.js
lib/workflow/humanGate.js
lib/workflow/runState.js
lib/workflow/nodeRegistry.js
lib/workflow/adapters/legacySynthesis.js
web/*
```

没有新增运行时依赖，没有新增 Journal event 类型（`RUN_CANCELLED` / `NODE_CANCELLED` 早已在 `runJournal.js` 中定义但从未被 Executor 触发）。

## 2. FLOW-D07：取消成为 Executor 的真实语义

### 2.1 修复前的实际状态

`signal` 此前只被透传进 handler 的执行上下文，**调度器自身从不检查它**。因此：

```text
handler 不主动检查 signal        → Run 无法取消
retry backoff 期间用户取消       → 仍然睡满 backoff 并启动下一次尝试
start() 传入已经 aborted 的 signal → 整张图照常跑完
```

也就是说 `FLOW-D07` 的实际范围比矩阵里写的更大：不只是 backoff 期间，而是**整个调度循环对取消无感**。

### 2.2 修复后的语义

Executor 在三个位置协作式地观察 abort：

```text
调度循环每一轮开始           → RUN_CANCELLED
节点抛错进入 catch 时         → NODE_CANCELLED + RUN_CANCELLED
retry backoff 等待结束时      → NODE_CANCELLED + RUN_CANCELLED
```

backoff 等待本身改为可中断：

```text
Promise.race([ sleep(backoff), abort ])
```

取消原因来自 `signal.reason`：

```text
reason.code 是字符串        → 用该 code
reason 本身是非空字符串      → 用该字符串
其他                        → RUN_CANCELLED_BY_SIGNAL
```

该 code 同时写进 `NODE_CANCELLED` 的 node error 和 `RUN_CANCELLED` 的 `payload.reason`，让用户可见的取消原因是结构化的，而不是一个匿名终态。

### 2.3 实现期间发现并修复的丢唤醒缺陷

`_abortableSleep` 的第一版只在进入时检查一次 `signal.aborted`，随后才注册 `abort` 监听器。若 abort 恰好落在这两步之间，事件不会再次触发，等待将永远挂起。

该缺陷被新增测试 `cancelling during the backoff wait interrupts the wait itself` 以确定性方式复现（注入的 sleep 只能由 abort 竞速结束），随后在 race 的 executor 内部补上二次 `signal.aborted` 检查修复。监听器在 `finally` 中移除，不残留。

**这是本轮唯一一次“修复过程中引入又修掉”的问题，记录在此以免后续审阅误判为遗留缺陷。**

## 3. FLOW-D06：重试必须有副作用声明

### 3.1 修复前

任何带 `error.retryable === true` 的失败都会被重试，Executor 不关心这次尝试是否已经产生了副作用（写文件、发布资产、占用 GPU、调用外部引擎）。这与矩阵中 `FLOW-D06 = 禁止 retry 或将 Run 置为 failed` 的既定动作矛盾。

### 3.2 修复后：fail-closed，声明才放行

只有在**显式声明**存在时才允许重试，两条来源二选一：

```text
handler 抛出的 error.side_effects === 'none' | 'idempotent'
  → 由 handler 证明这次失败没留下需要清理的副作用

node.retry_policy.idempotent === true
  → 由 workflow 作者声明该节点整体幂等
```

都没有时，即便 `retryable === true` 且尝试次数未用尽，也**不重试**，直接失败：

```json
{
  "code": "NODE_RETRY_BLOCKED_SIDE_EFFECTS",
  "retryable": false,
  "cause": { "code": "TEMPORARY", "message": "..." }
}
```

原始错误保留在 `cause` 中，不被吞掉。这与 `FLOW-D14`（warn-override：有明确 idempotency declaration 时允许自动 retry）是同一条规则的两面。

放行时，`NODE_RETRY_SCHEDULED` 事件额外记录声明来源：

```json
{ "side_effect_declaration": { "source": "handler_error.side_effects", "value": "none" } }
```

使得“为什么这次允许重试”在 Journal 中可审计，而不是隐式规则。

### 3.3 validator 同步

`retry_policy.idempotent` 现在被校验为 boolean（`RETRY_POLICY_IDEMPOTENT_INVALID`）。这是解锁 fail-closed 行为的开关，不能允许 `"false"` 这类真值字符串蒙混过关。

### 3.4 兼容性影响（这是一次刻意的契约收紧）

原有测试 `executor retries an explicitly retryable handler failure with backoff policy` 抛出的是**无声明**的 retryable 错误，在新契约下会 fail-closed。该测试已按新契约改写为声明 `side_effects: 'none'`，并新增一条测试断言“无声明的 retryable 不得重试”。

对尚不存在的真实 handler 没有迁移负担；未来写 handler 时必须显式声明才能获得重试。

## 4. FLOW-D21：runtime inputs 生命周期

`this.runtimeInputs` 此前只增不删，长时间运行的进程会持续累积每个 Run 的输入副本（其中可能包含完整文本）。

现在所有 Executor 出口统一经过 `_settle(runId)`：

```text
Run 进入 TERMINAL_RUN_STATES  → 删除该 run 的 runtimeInputs
awaiting_human_review          → 刻意保留，供同进程 resume
```

保留语义是必要的：删掉会让同进程 resume 也被迫走 `WORKFLOW_INPUT_REBIND_REQUIRED`。跨进程重启仍然按既有契约要求 rebind，本次不改变该行为。

## 5. 测试证据

环境：

```text
Linux 沙箱审阅环境 / Node v24.18.1
后端 Node 依赖未安装（既有集成测试因此环境性跳过）
```

命令与结果：

```text
node scripts/run_tests.cjs
  150 tests / 129 pass / 0 fail / 21 skipped

node --test lib/workflow/executor.node.test.js
  12 tests / 12 pass / 0 fail / 0 skipped

node --check lib/workflow/executor.js            OK
node --check lib/workflow/validator.js           OK
node --check lib/workflow/executor.node.test.js  OK
```

与收敛前的基线对比：

```text
收敛前：144 tests / 123 pass / 0 fail / 21 skipped
收敛后：150 tests / 129 pass / 0 fail / 21 skipped
```

新增 6 条测试，skipped 数量不变（新测试没有落进跳过区），0 失败。

> 依赖完整的开发工作区中，同一套用例应为 `150 / 150 / 0 / 0`。该数字**未在本环境实测**，不能当作已验证结论；请在本地开发机复跑后记录。

新增/改写的测试：

```text
retries a retryable failure that declares it produced no side effects   （D06 放行路径）
a node declared idempotent in retry_policy may retry                     （D06 第二种声明来源）
FLOW-D06: undeclared side effects fails closed instead of retrying       （D06 fail-closed）
FLOW-D07: cancelling during a failing attempt stops the Run              （D07 catch 边界）
FLOW-D07: cancelling during the backoff wait interrupts the wait itself  （D07 可中断等待 + 丢唤醒回归）
FLOW-D07: an already aborted signal cancels before any node executes     （D07 入口）
FLOW-D21: awaiting review 保留 runtime inputs，终态释放                   （D21 生命周期两侧）
```

## 6. 需要本地 AI / 人工重点审阅的问题

1. `RUN_CANCELLED` 是否应当在取消时额外释放 ResourceManager 资源（当前无 ResourceManager，属下一阶段）；
2. handler 已经开始产生副作用但尚未返回时被取消，是否需要 `NODE_CANCELLED` 之外的补偿契约；
3. `side_effects` 词表是否应扩展（当前只有 `none` / `idempotent`）；
4. `retry_policy.idempotent` 是否应该同时影响 Run Plan fingerprint 的语义解释；
5. 取消是否需要区分「用户取消」与「系统关停」两种 reason 域；
6. `_settle` 删除 runtime inputs 后，同一 run_id 被重复 `start()` 的防护是否足够。

## 7. 明确不在本轮范围

```text
Artifact Store
ResourceManager / GPU 锁
timeout cancellation（超时自动取消）
Executor live wiring 与真实 TTS E2E
多进程一致性
FLOW-D10 typed input resolver 契约
Flow Canvas
```

`FLOW-D10` 本轮仍为 open，滚存计数 1。若下一轮仍未处理，按 1.0.8 稳定化纪律将触发「暂停新增功能，集中清理」。

## 8. SHA-256

```text
lib/workflow/executor.js
107951ae121448a653ab63fe391638edac82ba164a9d2374467fc1c58f63acb3

lib/workflow/validator.js
04bae561146e74b0a3441994bb0667b67aea9a4925dab485380afa23404509d0

lib/workflow/executor.node.test.js
6bb3b9961110a4815eeb6c556c61e7d48adcb01984b7d3c14004bc36aaac85c2
```
