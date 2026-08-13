# FLOW-D10 — typed Artifact 与 inputResolver 恢复契约（R1，已冻结）

> **状态：R1 冻结（2026-08-13）。** 评审于 2026-08-13 完成，Q1-Q7 七问全部按草案倾向通过。
> **§2（FLOW-D10a）已实现**，见 `lib/workflow/executor.js` 与 `executor.node.test.js`。
> **§3（FLOW-D10b）已被独立文件取代并冻结**：见
> [`FLOW-D10B-ARTIFACT-STORE-CONTRACT.md`](./FLOW-D10B-ARTIFACT-STORE-CONTRACT.md)（R1，只读切片已实现）。
> 本文件 §3 保留为历史记录，**不再是实现依据**。
>
> 修改本文件 §2 的任何契约条款都属破坏性变更，需重新评审。
>
> 关联：[`FLOW-TECH-DEBT-MATRIX-2026-08-13.md`](./FLOW-TECH-DEBT-MATRIX-2026-08-13.md) FLOW-D10、
> [`ARTIFACT_AND_RUN_CONTRACT.md`](./ARTIFACT_AND_RUN_CONTRACT.md) §1-§2、
> [`FLOW-CORE-003B-DEBT-CONVERGENCE.md`](./FLOW-CORE-003B-DEBT-CONVERGENCE.md)

---

## 0. 本草案要解决的问题

### 0.1 当前实现（事实陈述）

`lib/workflow/executor.js` 的恢复路径：

```js
async _resolveRuntimeInputs(runId, plan, projection) {
  if (this.runtimeInputs.has(runId)) return clone(this.runtimeInputs.get(runId))   // 同进程，未丢失
  if (this.inputResolver) {
    const resolved = await this.inputResolver({ run_id, plan, snapshot })
    if (!resolved || typeof resolved !== 'object')
      throw executorError('WORKFLOW_INPUT_REBIND_INVALID', 'inputResolver must return an object')
    this.runtimeInputs.set(runId, clone(resolved))
    return clone(resolved)
  }
  throw executorError('WORKFLOW_INPUT_REBIND_REQUIRED', ...)  // 无 resolver：fail-closed
}
```

**已经防守到位的部分**：没有 resolver 时不假装恢复成功，抛 `WORKFLOW_INPUT_REBIND_REQUIRED` 并把 snapshot 附在错误上。这条本草案不改。

### 0.2 缺口（本草案的核心）

**resolver 返回什么，executor 就信什么 —— 从不与 `workflow_input_snapshot` 对账。**

唯一的校验是 `typeof resolved === 'object'`。而 Journal 里 `inputSnapshot()`（`executor.js:40-60`）已经存了对账所需的全部材料：

```text
artifact_ref    → { kind, artifact_id, type, fingerprint }
inline_digest   → { kind, type:'string', length, digest }        // 字符串不落原文
inline          → { kind, type, value }                          // number/boolean/null 落原值
opaque_digest   → { kind, type:'array'|'object', digest }         // 结构体只落摘要
```

后果：一个写错或被污染的 resolver 可以在跨进程恢复时喂进**与原 run 无关的输入**，run 会正常跑完并产出 artifact，而 Journal 上仍留着原始 snapshot 作为"证据"。这击穿两条既定不变量：

- Run Plan 与 run 输入不可变；
- Artifact lineage 可证（产物无法再声称由 snapshot 所记的输入产生）。

**这是一条能静默产出错误产物的路径，严重性高于"契约未冻结"本身。**

### 0.3 与 Artifact Store 的依赖关系（拆分理由）

上述对账逻辑**不依赖** Artifact Store、不依赖 typed 取回语义、不依赖权限模型 —— 材料全在 Journal 里。因此本草案建议把 FLOW-D10 拆成两条独立债务：

| 新 ID | 内容 | 阻塞于 | 可否现在做 |
|---|---|---|---|
| **FLOW-D10a** | 恢复完整性：resolver 返回值必须与 snapshot 对账，不符即 fail-closed | 无 | **可以** |
| **FLOW-D10b** | typed Artifact 取回 / 权限 / lineage 的完整 resolver 契约 | Artifact Store | 否（当时）；**只读切片已于 2026-08-13 冻结并实现**，见独立契约文件 |

拆分**不是为了绕过滚存门槛**。理由是两者阻塞原因不同：D10b 客观依赖尚未存在的 Artifact Store，把它与一个当下就能修的静默缺陷绑在同一个计数器上，只会在门槛触发时逼出仓促的 Store 实现。D10a 完成后即 fixed，D10b 继续按 open 计数。

> **待评审 Q1：** 是否接受这个拆分？若不接受，D10 整体在下一轮触发"暂停新增功能进集中清理"时的处理方式需要另行约定。

---

## 1. 架构边界（本草案主动划定的红线）

本地 AI 的建议中包含"把 Artifact Store 接口/校验并入 validator"。**本草案不采纳该项**，理由如下：

```text
validator.js  =  创作期（authoring-time）
  职责：图结构、DAG 环检测、端口类型匹配、必需输入、Run Plan fingerprint
  性质：纯函数、无 IO、可复现
  约束：fingerprint 必须只由图内容决定

Artifact 取回  =  运行期（run-time）
  性质：有 IO、有权限、有网络/磁盘失败模式、结果随时间变化
```

把 Artifact Store 取回并入 validator，会让 Run Plan fingerprint 的计算依赖外部可变状态，Run Plan 的确定性与可复现性即失效 —— 这比 FLOW-D10 本身更贵。

**因此正确落点是 Executor 与 Artifact Store 之间的运行期 rebind 校验。** validator 至多承担静态部分（见 §5）。

> **待评审 Q2：** 是否同意这条边界？这决定了 D10b 实现时 Store 接口挂在哪一层。

---

## 2. FLOW-D10a：snapshot 对账契约（建议冻结）

### 2.1 契约声明

> Executor 在跨进程恢复时，**必须**验证 `inputResolver` 的返回值与 Journal 中 `workflow_input_snapshot` 一致。任何不一致 —— 包括键集合差异 —— 都必须 fail-closed，不得降级为警告，不得部分接受。

### 2.2 逐 kind 的比对规则

对 snapshot 中每个键，按其 `kind` 采用对应规则重新计算并比对：

| snapshot kind | 比对内容 | 不符时 |
|---|---|---|
| `artifact_ref` | `artifact_id` 必须完全相等；`fingerprint` 若 snapshot 中非 null 则必须相等；`type` 若非 null 则必须相等 | `WORKFLOW_INPUT_REBIND_MISMATCH` |
| `inline_digest` | 值必须是 string；`length` 必须相等；重算 `sha256(JSON.stringify(value))` 必须等于 `digest` | 同上 |
| `inline` | 值必须严格相等（`number`/`boolean`/`null`，用 `Object.is` 以正确处理 `NaN` / `-0`） | 同上 |
| `opaque_digest` | 重算 digest 必须相等；`type`（`array` / `object`）必须一致 | 同上 |

**键集合规则**（两侧都要查）：

```text
snapshot 有、resolved 缺  →  MISSING_KEY   →  fail
resolved 有、snapshot 缺  →  UNEXPECTED_KEY → fail
```

`UNEXPECTED_KEY` 同样必须失败：多出来的键会进入 `_drive()` 的 inputs，可能被节点读取，属于未记录的输入。

### 2.3 错误形状

```js
executorError('WORKFLOW_INPUT_REBIND_MISMATCH',
  `Run '${runId}' input rebind does not match recorded snapshot`, {
    run_id: runId,
    mismatches: [
      { key: 'reference_audio', reason: 'ARTIFACT_ID_MISMATCH',
        expected: 'artifact_01H...', actual: 'artifact_01J...' },
      { key: 'script', reason: 'DIGEST_MISMATCH',
        expected_digest: 'sha256:...', expected_length: 412, actual_length: 415 },
      { key: 'speed', reason: 'MISSING_KEY' },
      { key: 'debug_flag', reason: 'UNEXPECTED_KEY' },
    ],
  })
```

`reason` 词表（建议冻结）：

```text
ARTIFACT_ID_MISMATCH
ARTIFACT_FINGERPRINT_MISMATCH
ARTIFACT_TYPE_MISMATCH
KIND_MISMATCH          // 例：snapshot 记为 inline_digest，resolved 给了对象
DIGEST_MISMATCH
LENGTH_MISMATCH
VALUE_MISMATCH
MISSING_KEY
UNEXPECTED_KEY
```

> **待评审 Q3：** 诊断中是否可以带 `expected_digest`？digest 本身不泄漏原文（这正是 `inline_digest` 存在的理由），但会泄漏"两次输入是否相同"这一位信息。当前倾向：**可以带 digest 与 length，不带任何原文**。

### 2.4 失败是否写入 Journal

**建议：不写。** 理由：rebind 失败发生在 run 恢复**之前**，此时尚未确立"这是同一个 run"，往 Journal 追加事件等于用一次失败的身份验证去污染 append-only 记录。失败以异常形式抛给调用方，由上层决定是否记录到运维日志。

> **待评审 Q4：** 是否同意不写 Journal？反方观点是"恢复被拒"本身是重要的运维事件，应当留痕。折中方案是新增 `RUN_REBIND_REJECTED` 但**不计入 run 状态机**、仅作旁路审计流。

### 2.5 明确不做（D10a 范围内）

```text
不校验 artifact 内容真实存在（那需要 Artifact Store）
不校验调用方是否有权读取该 artifact（权限模型未定义）
不校验 lineage 的父子关系（Store 落地后由 D10b 承担）
不改变无 resolver 时 WORKFLOW_INPUT_REBIND_REQUIRED 的现有行为
不碰 validator.js
不引入任何新依赖
```

### 2.6 已知局限（须在实现文档中显式记录，避免被误判为缺陷）

**`artifact_ref` 的对账只能证明"引用相同"，不能证明"内容相同"。** 若 Artifact Store 允许原地覆写，则 artifact_id + fingerprint 相同仍可能对应不同字节。当前 `ARTIFACT_AND_RUN_CONTRACT.md` §2 规定 Artifact 内容不可变，所以这条在契约层面成立 —— 但**它是被假设的，不是被 executor 验证的**。真正的内容验证属于 D10b。

---

## 3. FLOW-D10b：typed Artifact resolver 契约（历史草案，已被取代）

> **已由 [`FLOW-D10B-ARTIFACT-STORE-CONTRACT.md`](./FLOW-D10B-ARTIFACT-STORE-CONTRACT.md)（R1）取代。**
> 本节保留为设计过程的历史记录，**不是实现依据**；与该文件冲突时以该文件为准。

以下内容当时**不建议冻结**，列出以界定 D10a 的边界，并作为 Store 设计的输入。

### 3.1 resolver 接口形状（草案）

```ts
type InputResolver = (ctx: {
  run_id: string
  plan: RunPlan              // 深拷贝，只读
  snapshot: InputSnapshot    // 深拷贝，只读
}) => Promise<Record<string, unknown>>
```

当前实现已是此形状（`executor.js:282-286`），D10a 不改变它。D10b 需要补充的是 resolver **如何**从 Store 取回 typed artifact。

### 3.2 待定义的语义

| 议题 | 问题 |
|---|---|
| 取回 | 按 `artifact_id` 取回时，返回 ArtifactRef 还是句柄还是内容流？大文件（ModelCheckpoint / AudioSet）显然不能整体入内存 |
| 类型 | `nodeRegistry.js` 的 `ARTIFACT_TYPES`（16 个）与 Store 的存储类型如何映射？`schema_version` 不匹配时是拒绝还是迁移 |
| 缺失 | artifact 已被 GC 清理时的错误形状；与 `ARTIFACT_AND_RUN_CONTRACT.md` §2「只能删除没有被活动 Run 引用的中间产物」如何互相保证 |
| 权限 | 恢复者与原始发起者不同时是否允许？多用户模型尚不存在，但契约需为其留位 |
| lineage | 恢复时若 artifact 已产生新 revision，是绑定原 revision（保真）还是最新（可能更正确）？**倾向：绑定原 revision，否则恢复即静默改变语义** |
| 内容验证 | 是否在 rebind 时重算内容 fingerprint？对 ModelCheckpoint 成本极高，可能需要按类型分级 |

> **待评审 Q5：** lineage 那条的倾向（绑定原 revision）是否认可？这会影响"人工修订后重启恢复"的用户可见行为。

---

## 4. 对现有测试与行为的影响

D10a 若冻结并实现：

```text
新增测试（预计 5 条）
  resolver 返回一致输入        → 恢复成功
  artifact_id 不符             → MISMATCH
  string 长度/digest 不符      → MISMATCH
  缺键 / 多键                  → MISMATCH
  无 resolver                  → 仍为 REBIND_REQUIRED（回归保护）

现有测试影响
  无。executor.node.test.js 的 rebind 测试走的是无 resolver 路径
```

破坏性：**对外部调用方是破坏性的** —— 任何现存的、返回近似输入的 resolver 实现将开始失败。

已核实当前代码库的实际影响面为零：`grep -rn "inputResolver" --include=*.js`（排除 node_modules）仅命中 `executor.js` 的 7 处（注释 1、构造参数与校验 3、赋值 1、恢复路径 2），**没有任何生产实现，也没有任何测试注入过 resolver**。即这条路径至今从未被真实执行过 —— 这也解释了缺口为何一直没暴露。

---

## 5. validator 的（有限）角色

D10a 不碰 validator。D10b 落地时，validator **可以**承担的静态部分仅限：

```text
节点声明的输入端口类型 ∈ nodeRegistry.ARTIFACT_TYPES
workflow 级 input 声明的类型合法性
```

validator **不得**承担：取回、存在性、权限、内容校验 —— 全部属运行期。

---

## 6. 评审需要回答的问题（汇总）

| # | 问题 | 裁决（2026-08-13） |
|---|---|---|
| Q1 | 是否接受把 FLOW-D10 拆为 D10a / D10b？ | **接受** — D10a 可立即修复静默缺陷，D10b 依赖 Artifact Store |
| Q2 | 是否同意 Artifact Store 校验**不**并入 validator？ | **同意** — validator 是创作期纯函数，Store 是运行期 IO，混合破坏确定性 |
| Q3 | 失败诊断中是否可带 `expected_digest` / `length`？ | **同意** — digest/length 不泄原文，仅表明相等性，便于排查 |
| Q4 | rebind 失败是否写 Journal？ | **不写** — 可作独立审计/运维事件，但不 append 到该 run 的 Journal |
| Q5 | 恢复时 lineage 绑定原 revision 还是最新？ | **原 revision** — 要用新 revision 须由人工显式操作 |
| Q6 | `UNEXPECTED_KEY` 是否必须失败？ | **必须失败** — 多余键会进入运行输入并可能被节点读取 |
| Q7 | D10a 是否本轮实现？ | **本轮实现** — 立刻堵住静默攻击面，影响面为零 |

---

## 7. 实现状态（R1 冻结后）

```text
[x] 本文件升版 R1 并冻结 §2
[x] 矩阵中 FLOW-D10 拆为 D10a（fixed）/ D10b（open，等 Store）
[x] 实现 D10a：executor.js 新增 reconcileSnapshotEntry / reconcileRuntimeInputs
[x] 新增 5 条测试（executor.node.test.js 17/17 通过）
[x] 更新 HEALTH-BASELINE-FLOW-2026-08-13.md 契约表与空缺清单
[ ] D10b 保持 open，等待 Artifact Store
```

### 7.1 实现落点

```text
lib/workflow/executor.js
  reconcileSnapshotEntry(key, expected, actual)   逐 kind 比对，返回 mismatch 或 null
  reconcileRuntimeInputs(snapshot, resolved)      双向键集合 + 逐键比对
  _resolveRuntimeInputs()                         resolver 返回后立即对账，不符即抛

lib/workflow/executor.node.test.js
  an input rebind that matches the recorded snapshot is accepted
  an input rebind with a different artifact is rejected fail-closed
  an input rebind with altered inline text is rejected and leaks no plaintext
  an input rebind is rejected when keys are missing or unexpected
  a rejected input rebind does not append to the run journal
```

### 7.2 实现中收紧的一处（超出草案，但方向一致）

草案写的是 `typeof resolved !== 'object'` 即 `WORKFLOW_INPUT_REBIND_INVALID`。实现时补上了 `Array.isArray(resolved)` —— JS 中数组的 `typeof` 也是 `'object'`，原判断会放行数组，随后在对账阶段被 `UNEXPECTED_KEY`（数字索引键）拦下，但错误码会失真。现在数组在入口即被判为 `INVALID`。

### 7.3 Q3 的执行方式

「不带原文」不是靠约定，是靠测试钉死的：`an input rebind with altered inline text...` 会把 `error.mismatches` 序列化后断言其中**不包含原文与被篡改文本的任何片段**。今后若有人往诊断里加原文字段，这条测试会失败。
