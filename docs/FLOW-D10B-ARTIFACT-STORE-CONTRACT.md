# FLOW-D10b — Artifact Store 取回契约（R1 冻结）

> **状态：R1 冻结（2026-08-13）。** §6 七问已全部裁决，§3 为实现依据。
> §3 的接口形状、错误码语义与 §5 的不做清单属**冻结面**，变更需重新评审。
> §4 的验证分级、§5 关于权限的留位属**已裁决但未实现**，实现时不得偏离裁决。
>
> 前置：[`FLOW-D10-INPUT-REBIND-CONTRACT.md`](./FLOW-D10-INPUT-REBIND-CONTRACT.md) R1（D10a 已实现并验收）
> 关联：[`ARTIFACT_AND_RUN_CONTRACT.md`](./ARTIFACT_AND_RUN_CONTRACT.md) §1/§2/§10/§13、
> [`FLOW-TECH-DEBT-MATRIX-2026-08-13.md`](./FLOW-TECH-DEBT-MATRIX-2026-08-13.md) FLOW-D10b、
> [`FLOW-D26-LOCAL-AI-PATCH-REVIEW-2026-08-13.md`](./FLOW-D26-LOCAL-AI-PATCH-REVIEW-2026-08-13.md)（D26 已 fixed，Q1 前置条件已满足）
>
> **R0 → R1 的变化**：§2 记录的 FLOW-D26 已于 2026-08-13 修复（Q1 = 方案 A），
> 该节因此从「建议」转为「已完成的前置」保留，供追溯；其余章节文字未改，
> §6 由待评审问题表改为裁决表，新增 §8 实现状态。

---

## 0. 先澄清「继续做 D10b」意味着什么

D10a 是**债务清理**：材料齐备、范围封闭、当轮可完成。

**D10b 不是债务清理，是功能设计。** 矩阵里它的阻塞项写的是 "Artifact Store"，而勘察结果是：

```text
find . -iname "*artifact*"   →  只有 docs/ARTIFACT_AND_RUN_CONTRACT.md
                                 没有任何 Artifact Store 实现
```

也就是说 D10b 的全部内容 —— typed 取回、权限、lineage 验证 —— 都要求先有一个 Artifact Store。**「继续 D10b」在事实上等于「开始设计并实现 Artifact Store」**，这比前两轮的任何一件都大，且会牵动 §10 retention、§11 cache key、§13 legacy 兼容。

本草案因此**不建议一次做完 D10b**，而是提出一个窄切片（§2），并把完整 Store 的设计问题显式留给评审（§5）。

---

## 1. D10a 已经替 D10b 解决掉的部分（缩小了范围）

这一点值得先说，因为它让 D10b 比原先设想的小：

**D10a 的对账已经约束死了 resolver 的返回值形状。** resolver 必须返回能与 `workflow_input_snapshot` 对上的东西 —— 对 artifact 类输入而言就是带 `artifact_id` / `type` / `fingerprint` 的 ArtifactRef。

推论：

- Store **不需要**改变 resolver 返回什么。它的职责是**证实**这个 ref 指向的东西真实存在且未被改动，而不是构造新形状。
- 因此 D10b 不会推翻 D10a，只是在对账之外**再加一道存在性与完整性检查**。

**另一个已被结构性保证的点**：Q5 裁决「恢复绑定原 revision，不自动取最新」。由于 `artifact_id` 按契约 §2.1 标识的就是**一个不可变版本**（`lineage_id` 才标识逻辑产物），按 `artifact_id` 取回天然就是原 revision。**Q5 不需要额外代码来保证，只需要 Store 不提供「按 lineage_id 取最新」的隐式回退。** 这条建议写进 Store 契约作为禁止项。

---

## 2. 勘察中发现的一个现存缺口（建议优先于 Store 处理）

### 2.1 事实

`ARTIFACT_AND_RUN_CONTRACT.md` §2 规定：

> Artifact 必须有 fingerprint

但 `lib/workflow/adapters/legacySynthesis.js` 产出的两个 artifact **都没有 fingerprint 字段**：

```js
// normalizeLegacySynthesisResult()
const inference = { artifact_id: safeArtifactId('inference', responseId), type: 'InferenceResult', metadata: {...} }
const audio     = { artifact_id: safeArtifactId('audio', responseId), type: 'AudioArtifact', uri: response.audio_url, metadata: {...} }
```

`grep -n fingerprint lib/workflow/adapters/legacySynthesis.js` → 无命中。

且 `artifact_id` 由 `response.id || response.audio_url` 派生 —— 当 `response.id` 缺失时，**artifact 身份实际来自一个 URL**，这与 §2「业务层不直接依赖路径格式」和 §2.1「使用不透明标识」相抵触。

### 2.2 与 D10a 的相互作用（这才是要紧的）

`inputSnapshot()` 记录 artifact 时是 `fingerprint: value.fingerprint || null`，而 D10a 的对账逻辑是：

```js
if (expected.fingerprint !== null && expected.fingerprint !== undefined && ...) → 比对
```

**即 fingerprint 为 null 时跳过该项检查。** 于是：

> 对于来自 legacy backend 的 artifact，D10a 的保护**静默降级为「只比 artifact_id」**。而这些 artifact 的 id 又可能派生自 URL。

这不是 D10a 的实现缺陷（契约 R1 §2.6 已声明「只证明引用相同，不证明内容相同」），但它说明**降级发生的位置恰好是身份最弱的一类 artifact**，两个弱点叠在了一起。

### 2.3 建议

这条**不依赖 Artifact Store**，可以独立处理，建议编号 **FLOW-D26** 单列，且优先于 Store：

```text
方案 A（推荐）：legacy adapter 为其产出计算 fingerprint
  audio 可按内容或 (generation_id + files 清单) 计算
  artifact_id 改为不派生自 audio_url

方案 B：executor 侧把 fingerprint 为 null 的 artifact_ref 标为「弱身份」
  在 rebind 时对弱身份要求更严（例如强制 Store 存在性检查）
  但 Store 还不存在，所以 B 实际要等 D10b

方案 C：暂不处理，仅在健康基线中记录为已知局限
```

> **待评审 Q1：** 是否接受把它单列为 FLOW-D26 并优先于 D10b？倾向：**接受，选方案 A** —— 它便宜、不依赖 Store，且能实际提升 D10a 已交付的保护强度。

---

## 3. 建议的窄切片：ArtifactStore 只读取回接口

若评审同意继续 D10b，建议**只做 resolver 需要的只读部分**，理由与 D10a 同构：不实现的部分不会被实现细节反向定义。

### 3.1 接口形状（草案）

```ts
interface ArtifactStore {
  // 按不可变版本取回描述信息。不做内容读取。
  describe(artifact_id: string): Promise<ArtifactDescriptor | null>

  // 内容按需惰性打开，避免 ModelCheckpoint / AudioSet 整体入内存
  openContent(artifact_id: string): Promise<NodeJS.ReadableStream>
}

interface ArtifactDescriptor {
  artifact_id: string
  type: string                 // ∈ nodeRegistry.ARTIFACT_TYPES
  schema_version: number
  fingerprint: string | null   // null = legacy backend，见 §2
  lineage: { lineage_id, revision, parent_artifact_id } | null
  retention_hold: string | null
  exists: boolean
}
```

**明确禁止项**（写进契约，防止 Q5 被绕过）：

```text
不得提供 getLatestByLineage(lineage_id) 之类的隐式取最新
不得在 describe() 内部做任何写入或 retention 变更
不得让 describe() 的结果参与 Run Plan fingerprint 计算（沿用 R1 §1 的边界）
```

### 3.2 在 rebind 中的位置

```text
resolver 返回
  ↓
D10a 对账（已实现，不变）        ← 与 snapshot 比
  ↓
D10b 存在性检查（新增）          ← 与 Store 比
  ↓
写入 runtimeInputs
```

顺序刻意如此：**先与 Journal 对账，再问 Store**。因为 Journal 是本地的、append-only 的、不可被外部改动的，而 Store 是外部可变状态。先信任更强的一方，可以在 Store 被污染时仍然拦住。

### 3.3 新增错误码（草案）

```text
ARTIFACT_NOT_FOUND            describe() 返回 null 或 exists=false
ARTIFACT_TYPE_CONFLICT        Store 记录的 type 与 snapshot 不符
ARTIFACT_FINGERPRINT_CONFLICT Store 记录的 fingerprint 与 snapshot 不符
ARTIFACT_STORE_UNAVAILABLE    Store 本身不可达（区别于 artifact 不存在）
```

`ARTIFACT_STORE_UNAVAILABLE` 必须与 `ARTIFACT_NOT_FOUND` 分开：前者是可重试的基础设施故障，后者是恢复必须失败的语义错误。混在一起会让「Store 临时挂了」被误判成「产物被 GC 了」。

---

## 4. 内容验证的诚实边界

契约 R1 §2.6 的局限，Store 落地后**只能部分解除**：

| 验证深度 | 做法 | 成本 | 实际保证 |
|---|---|---|---|
| L0（当前 D10a） | 只比 snapshot 里的 ref | 零 | 引用相同 |
| L1（本切片建议） | 比 Store 记录的 fingerprint | 低 | 引用相同 **且 Store 也认为内容没变** |
| L2 | 重算内容 fingerprint | 高，ModelCheckpoint 不可接受 | 字节相同 |

**必须说清楚的一点：L1 并没有消除信任，只是把信任从 resolver 转移到了 Store。** 如果 Store 允许原地覆写而不更新 fingerprint，L1 一样会被骗过。真正的字节级保证只有 L2，而 L2 对大产物不现实。

> **待评审 Q2：** 默认取 L1 是否可接受？是否需要提供按 artifact type 分级的 `verify` 选项（例如 TextArtifact 走 L2、ModelCheckpoint 走 L1）？倾向：**默认 L1，为 L2 留出显式开关但本切片不实现**。

---

## 5. 本切片明确不做（留给完整 Store）

```text
写入 / 提交新 Artifact
GC 与 retention 执行（§10 的 retention_hold 只读不改）
lineage revision 的分配
cache key 计算（§11）
权限模型 —— 多用户模型尚不存在
跨进程 / 跨机一致性（沿用 FLOW-D23 的 local single-process 声明）
legacy assets/{voiceId}、.staging/{taskId} 的完整 manifest 迁移（§13）
```

关于权限：契约 R1 §3.2 列了「恢复者与原始发起者不同时是否允许」。当前**没有用户模型**，所以这条无法有意义地实现。建议**只在接口上留出 `ctx` 位置，不定义语义**，避免定义一个之后必然推翻的权限模型。

> **待评审 Q3：** 同意「留位不定义」吗？还是宁可现在完全不留，等用户模型出现再改接口？倾向：**留位不定义**。

---

## 6. 裁决表（2026-08-13 评审通过，R1 冻结）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| Q1 | legacy artifact 无 fingerprint（§2）是否单列 FLOW-D26 并优先于 D10b？ | **方案 A** | 已于 2026-08-13 实施，D26 = fixed。见 §2 与 D26 审阅报告 |
| Q2 | 内容验证默认取 L1（信 Store 的 fingerprint）？ | **是** | L2 留显式开关但本切片不实现；§4 的「L1 只是转移信任」必须写进代码注释 |
| Q3 | 权限是否「接口留位、不定义语义」？ | **是** | 无用户模型，现在定义必然推翻 |
| Q4 | D10b 是否按本草案切成「只读取回」一片？ | **是** | 其余留给完整 Store，见 §5 |
| Q5 | Store 是否禁止 `getLatestByLineage` 之类隐式取最新？ | **禁止** | 保 D10 R1 Q5「恢复绑原 revision」的结构性保证 |
| Q6 | `ARTIFACT_STORE_UNAVAILABLE` 与 `ARTIFACT_NOT_FOUND` 分离？ | **分离** | 可重试的基础设施故障 vs 恢复必须失败的语义错误 |
| Q7 | 先做 D26 再做 D10b 切片，还是并行？ | **已失去争议** | D26 已先行完成，Q7 自然消解 |

---

## 7. 执行顺序（已裁决）

```text
1. FLOW-D26：legacy adapter 补 fingerprint + artifact_id 不再派生自 URL
   ✅ 已完成 2026-08-13，5 条回归测试

2. 本文件升 R1 冻结 §3
   ✅ 本次

3. 实现 ArtifactStore 只读切片 + executor 接线 + 测试
   ✅ 本次，见 §8

4. 完整 Store（写入 / GC / retention / cache key）另开条目，不并入 D10b
   ⏸ 未开始，见 §5
```

---

## 8. 实现状态（R1 §3 落点）

### 8.1 代码落点

```text
lib/workflow/artifactStore.js          新增
  ARTIFACT_STORE_ERROR_CODES           §3.3 的四个错误码
  assertReadOnlyArtifactStore(store)    构造期形状校验 + Q5 禁止项强制
  reconcileArtifactDescriptor(...)      纯函数：descriptor vs snapshot
  createMemoryArtifactStore(...)        参考实现，仅供测试与本地单进程

lib/workflow/executor.js
  constructor({ artifactStore })         可选注入，null = 保持 D10a 行为
  _verifyArtifactsAgainstStore()         §3.2 的新增一段
  _resolveRuntimeInputs()                在 D10a 对账之后调用

lib/workflow/index.js                   导出 artifactStore
```

### 8.2 四条超出草案文字的收紧

草案未写明但实现时必须成立，否则契约会被绕过：

```text
1. artifactStore 为 null 时行为与 D10a 完全一致
   本切片不得把「没有 Store」变成新的失败模式。Store 是可选增强，
   不是新的必要条件 —— 否则单进程场景会被无谓地打断。

2. Q5 的禁止项由构造期断言强制，而非仅写在文档里
   assertReadOnlyArtifactStore() 检测到 getLatestByLineage /
   getLatest / resolveLatest 等方法名即抛 ARTIFACT_STORE_INVALID。
   一条只存在于 markdown 里的禁令，等于没有禁令。

3. 只校验 kind === 'artifact_ref' 的快照条目
   inline / inline_digest / opaque_digest 不是 artifact，
   不该去问 Store，否则会把内联输入误报成 ARTIFACT_NOT_FOUND。

4. snapshot.fingerprint 为 null 时不比对 fingerprint，但仍校验存在性与 type
   D26 之后 legacy 也有 fingerprint 了，但历史 Journal 里仍存着 null。
   对这些旧 run 静默跳过 fingerprint 是必要的向后兼容，
   跳过存在性检查则不是。
```

### 8.3 校验顺序（§3.2 的实现）

```text
resolver 返回
  ↓
D10a 对账（不变）              ← 与 Journal snapshot 比，本地不可篡改
  ↓
D10b Store 校验（新增）        ← 与外部可变状态比
  ↓
写入 runtimeInputs
```

顺序即 §3.2 所述：先信更强的一方。Store 被污染时 D10a 仍能拦住。

### 8.4 错误语义

```text
ARTIFACT_STORE_UNAVAILABLE   retryable: true    ← describe() 自身抛出
ARTIFACT_NOT_FOUND           retryable: false
ARTIFACT_TYPE_CONFLICT       retryable: false
ARTIFACT_FINGERPRINT_CONFLICT retryable: false
```

`describe()` 抛出的任何异常一律归入 `ARTIFACT_STORE_UNAVAILABLE`（Q6）：
无法区分「Store 挂了」与「实现有 bug」时，按可重试处理是安全侧 ——
反之会把临时故障永久判定成「产物已被 GC」。

与 D10a 一致，Store 校验失败**不向 Run Journal 追加事件**（D10 R1 Q4）：
它同样发生在 run 身份确立之前。

### 8.5 诊断不泄原文

沿用 D10 R1 Q3：诊断只带 `artifact_id` / `type` / `fingerprint`，
均为不透明标识，不含内容。由测试断言钉死。

### 8.6 测试证据

```text
环境：Linux 沙箱审阅环境 / Node v24.18.1 / 后端 Node 依赖未安装
证据来源：测试直接证明

node scripts/run_tests.cjs
  182 tests / 161 pass / 0 fail / 21 skipped

node --test lib/workflow/executor.node.test.js
  29 tests / 29 pass / 0 fail        （D10b 新增 12 条）

node --test lib/workflow/artifactStore.node.test.js
  10 tests / 10 pass / 0 fail        （纯函数与禁止项）
```

overlay 到**依赖完整的仓库快照**复验：`182 tests / 182 pass / 0 fail / 0 skipped`。

D10b 覆盖的 12 条 executor 场景：Store 全部确认通过、无 Store 时行为不变、
artifact 不存在、Store 不可达且 retryable、fingerprint 冲突、type 冲突、
构造期拒绝 `getLatestByLineage`、不询问 inline 输入、
**D10a 先于 Store 执行（被污染的 Store 无法放行错误 rebind）**、
冲突不写 Journal、诊断不含原文、pre-D26 的 null fingerprint 仍做存在性检查。

