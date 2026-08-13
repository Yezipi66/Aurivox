# FLOW-CORE-004 — Live Wiring：Flow 内核首次在真实进程中跑通

> 状态：**已实现并实测**（2026-08-13）
> 前置：FLOW-CORE-002B / 002C / 003 / 003B、FLOW-D10 R1、FLOW-D10B R1、FLOW-D26
> 测试：`202 tests / 202 pass / 0 fail / 0 skipped`（此前基线 182）
> 验证深度：**L2 — 真实进程、真实 HTTP、真实落盘 WAV、真实 Journal 文件**

---

## 0. 这一轮到底改变了什么

在本轮之前，`lib/workflow/` 下的全部内核代码**在运行的进程里是不可达的**：
`server.js` 与 `lib/routes/` 中没有任何一处 `require` 它。182 条测试证明的是
「**被调用时**内核行为正确」，而不是「有任何东西调用过它」。

本轮补上了那根线，并且**第一次让真实的 TTS 请求穿过内核**：

```
HTTP POST /api/flow/runs
  → lib/routes/flow.js
    → FlowRuntime (lib/workflow/runtime.js)
      → WorkflowExecutor
        → legacySynthesis adapter
          → 真实 synthesisService
            → 真实 HTTP → GPT-SoVITS 引擎
              → 真实 WAV 落盘
                → Journal 落盘 → Human Gate → approve → 终态
```

**这才是本轮的真正价值**：它暴露了 7 处「内核自测通过、但接到真实进程上就是错的」
偏差。这些偏差全部是 mock handler 测试**结构上不可能发现**的（§3）。

---

## 1. 范围（刻意窄）

实现的节点**只有** FLOW-CORE-004 切片所需的 6 个：

| 节点类型 | 处理方式 |
|---|---|
| `io.text_input` / `io.voice_input` / `io.audio_input` | 从 `workflow_inputs` 按 `params.workflow_input` 取 |
| `tts.generate` | 复用 FLOW-CORE-003 的 `createLegacySynthesisAdapter` |
| `review.human_gate` | `createGateInstance`，gate_id 确定性派生 |
| `io.audio_output` | 记录产物身份，**不发布、不搬运、不注册** |

**其余 11 个节点刻意不注册**。请求它们会得到 executor 的 `NODE_HANDLER_NOT_FOUND`
——这是正确的 fail-closed 答案：**未实现的节点绝不能看起来像能用的节点**。

### 1.1 默认关闭

Flow 仅在 `FLOW_ENABLED` 非空且非 `"0"` 时构造并挂载。标志未设时：

- 内核**根本不被构造**；
- `/api/flow/*` 路由**不存在**（404）；
- Workbench 全部既有行为**逐字节不变**。

这条由测试 `flow: with FLOW_ENABLED unset the Flow surface is absent entirely`
钉死——它**另起一个不带标志的真实 server** 来验证，而不是读代码推断。

构造失败时打日志但**不拖垮 Workbench**：Flow 是实验性可选件，legacy 表面必须继续服务。

---

## 2. 已知限制（不得因「已接线」而被视为已支持）

沿用 D10b §4.2 的纪律，先写清楚**没做什么**：

| 项 | 状态 |
|---|---|
| 跨进程 resume | **不支持**。Run Plan 与 workflow inputs 只存在内存 Map。重启后 Journal 还在但 plan 没了，resume 抛 `FLOW_RUN_PLAN_UNAVAILABLE`（409）。这是 D05/D10a 契约行为，不是 bug——自动恢复需要 Artifact Store 的写入侧，而 D10b 明确不实现。 |
| Artifact Store | **未注入**。`createFlowRuntime` 支持 `artifactStore` 参数，生产路径传 `null`，行为等同 D10a。 |
| inputResolver | **未注入**。同上。 |
| 产物发布 / retention / GC | **未实现**。`io.audio_output` 只回报 uri。 |
| 训练、切片、ASR、UVR5 等 11 个节点 | **未实现** |
| 画布（Flow Canvas） | **未实现**。本轮零前端改动。 |
| 并发 Run | 未做隔离验证。GPU 独占策略（`exclusive_gpu`）**尚未接入真实的 generation lock**。 |

---

## 3. 真实运行偏差清单（本轮的核心产出）

以下 7 项**全部是实测发现**，不是审阅推断。每一项都附「为什么单元测试抓不到」。

### D-1｜绑定键名猜错：`params.input_key` → 实为 `params.workflow_input`

初版 runtime 自创了 `params.input_key`。validator 校验的是
`params.workflow_input`（对照 workflow 顶层 `inputs` 声明）。
**实测症状**：首个真实请求返回 5 条 validation error。

> 单测抓不到：mock handler 从不经过 validator 的绑定检查。

### D-2｜错误码猜错：`WORKFLOW_VALIDATION_FAILED` → 实为 `WORKFLOW_INVALID`

路由的状态码映射表写了一个**不存在的错误码**，导致**每一个非法图都返回 500 而不是 400**。

> 这是「只存在于文档里的禁令等于没有禁令」的同构失败：
> **只存在于映射表里的错误码等于没有映射**。已改为从 validator 实际抛出的
> `WorkflowValidationError.code` 取值，并把 `errors` 数组透传给客户端——
> 否则 400 不告诉调用方**哪个节点**错了。

### D-3｜Workflow 文档形状与 R1 契约不同

- 顶层需要 `schema: 'aurivox.workflow'`、`id`（不是 `workflow_id`）；
- 需要 `inputs` **类型声明块**；
- **不存在** `workflow_inputs` 绑定块——绑定写在节点的 `params.workflow_input`。

> 影响外部：任何 Flow API 的调用方（含未来画布）都必须按这个形状发文档。

### D-4｜Projection 的键是 `node_runs`，不是 `nodes`

### D-5｜参考音频时长是硬约束：3–10s

`synthesisService` 拒绝 0.0s 参考片段。测试 harness 的 `minimalWav()` 是 64 采样（≈0s），
于是**每一个 Flow run 都在到达引擎之前就 `LEGACY_TTS_SERVICE_FAILED`**。

> 这不是测试瑕疵而是真实约束：**任何经 Flow 走 `tts.generate` 的音色，
> 其参考片段必须 3–10s**。harness 已加 `refSamples` 参数（Flow 套件用 64000 = 4.0s）。

### D-6｜**FLOW-D27（新债）：明文经由节点输出进入 Journal**

D10a 保证的是**输入快照**脱敏——实测确认成立：`RUN_CREATED` 里只有
`{kind, artifact_id, type, fingerprint}`，没有 value。

**但节点输出是逐字持久化的**，而 legacy adapter 把请求文本回填进了
`InferenceResult.metadata.request.text`。于是**用户输入的原文最终仍然落进了
append-only 的 Journal 文件**。

实测证据：Journal 文件中 `grep` 得到输入原文；`RUN_CREATED` 那一行则没有。

处理方式（刻意不顺手改）：

- 已在集成测试中**显式钉住当前行为**，注释标明这是 **gap 而非保证**；
- 任何修复都会让该测试变红，**强制它成为一次决策而不是副作用**；
- 单列为 **FLOW-D27**，需要先裁决「Journal 该不该存输出原文」——
  这牵动可重放性（replay 需要输出）与隐私，属于契约问题，不是实现问题。

> 顺手改掉它会同时改变 D26 的 descriptor fingerprint 输入，
> 属于「冻结前不写实现」明确禁止的动作。

### D-7｜`X-Text-Lang` 实为 `ja`，非 `all_ja`

非回归断言写错了期望值。真实响应头是 `ja`。

---

## 4. 真实产物形状（直接决定 Artifact Store 怎么建）

这是 D10b 一直缺的经验数据。实测一条真实 run 的产物：

```json
{
  "artifact_id": "audio_2026-08-13T06-2_rk8zc",
  "type": "AudioArtifact",
  "uri": "/outputs/generate/2026-08-13T06-2_rk8zc/audio.wav",
  "fingerprint": "sha256:21c1ffd0…",
  "fingerprint_kind": "descriptor",
  "metadata": { "source": "legacy.synthesis", "generation_id": "…", "files": [], "segments": [] }
}
```

三条对 Artifact Store 设计的直接结论：

1. **`uri` 是 web 相对路径**（`/outputs/…`），不是文件系统绝对路径。
   Store 的 `openContent()` 必须自己解析 `OUTPUT_ROOTS`，**不能把 uri 当路径直接打开**。
2. **`artifact_id` 与 `generation_id` 一一对应**，天然是不可变版本标识
   ——这再次印证 D10b R1 Q5「禁止 `getLatestByLineage`」是结构性正确的。
3. D26 的两条修复在真实路径上**确实生效**：fingerprint 非空且随 uri 变化，
   `artifact_id` 不内嵌 URL。集成测试对这两点都有断言。

---

## 5. 测试证据

| 套件 | 条数 | 性质 |
|---|---|---|
| `lib/workflow/runtime.node.test.js` | 12 | 单元：handler 注册面、绑定、Gate 确定性、fail-closed、状态码映射 |
| `lib/flow.integration.node.test.js` | 8 | **真实 server + 真实引擎桩 + 真实落盘** |

全量：**`202 tests / 202 pass / 0 fail / 0 skipped`**（此前 182，本轮 +20）。

> **验收纪律**：「全绿」本身不足以验收 —— 必须同时核对总数为 **202**。
> 若得到 182 或 194，说明补丁没落全，请先查补丁完整性再谈通过。

集成套件在缺少后端依赖时会带**明确原因**地 skip 而非红灯，与
`broker.integration.node.test.js` 保持一致。

### 5.1 集成用例清单

1. `FLOW_ENABLED=1` 时内核可达
2. 一次 run 经**真实引擎调用**停在 Human Gate，并产出带 D26 fingerprint 的真实 WAV
3. Gate 可 approve，run 经 `io.audio_output` 走到 `succeeded`
4. 陈旧 gate_revision 得到 **409**，而不是静默重跑
5. 引擎真实失败时 run **fail-closed**，不产出 artifact、不到达 Gate
6. Journal 真实落盘、可 replay、输入快照不含明文（并钉住 D27 gap）
7. 开启 Flow **不影响** legacy OpenAI 兼容合成路径
8. `FLOW_ENABLED` 未设时 Flow 表面**完全不存在**

---

## 6. HTTP 表面

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/flow/status` | 无需鉴权；报告是否启用、journal 目录 |
| GET | `/api/flow/runs` | 列出 run id |
| POST | `/api/flow/runs` | `{ workflow, inputs, run_id? }` → 启动并驱动到首个阻塞点 |
| GET | `/api/flow/runs/:runId` | replay projection |
| POST | `/api/flow/runs/:runId/gate` | `{ gate_id, expected_gate_revision, decision, operator, comment?, outputs? }` |

除 `/status` 外全部经 `requireApiKey`。

状态码映射（**刻意不是「一律 500」**，内核的 fail-closed 码对客户端有真实含义）：

| code | HTTP |
|---|---|
| `WORKFLOW_INVALID` | 400 |
| `GATE_REVISION_CONFLICT` / `GATE_NOT_RESOLVABLE` / `RUN_PLAN_MISMATCH` | 409 |
| `WORKFLOW_INPUT_REBIND_REQUIRED` / `_MISMATCH` / `_ARTIFACT_CONFLICT` | 409 |
| `FLOW_RUN_PLAN_UNAVAILABLE` | 409 |
| `ARTIFACT_STORE_UNAVAILABLE` | **503**（可重试的基础设施故障，必须与语义拒绝分开） |
| `NODE_HANDLER_NOT_FOUND` | 501 |
| 其他 | 500 |

---

## 7. 「FLOW-CORE-004 标记 fixed 的确切含义」

**是**：Flow 内核已可从运行进程到达，一条 text→tts→gate→output 的管线
已用真实合成服务、真实 HTTP、真实落盘产物端到端跑通并被测试钉死。

**不是**：Flow 已可用于生产；不是画布已存在；不是产物已被管理；
不是跨进程可恢复；不是 17 个节点已可用；不是并发/GPU 独占已验证。

**信任转移到哪**：从「内核逻辑正确」转移到「内核 + 真实合成服务的接缝正确」。
`synthesisService` 本身的正确性仍由 legacy 测试与 broker 集成套件承担。

---

## 8. 下一步候选（按建议顺序）

1. **裁决 FLOW-D27**（Journal 是否持久化输出原文）——涉及隐私与可重放性的契约冲突，
   在写更多节点前定下来，越晚改代价越大。
2. **Run Plan 持久化**，解锁跨进程 resume（当前唯一的功能性阻塞）。
3. **Artifact Store 写入侧**——现在有真实产物形状了（§4），可以据实设计。
4. **Flow Canvas**——图文档形状已被 §3 D-3 钉死，前端可以据此实现。
