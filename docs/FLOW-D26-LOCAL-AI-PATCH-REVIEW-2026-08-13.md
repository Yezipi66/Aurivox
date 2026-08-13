# FLOW-D26 本地 AI 补丁审阅（2026-08-13）

审阅对象：`aurivox_patch_20260813-abce33db.zip`（全量仓库快照，非 overlay）

结论：**方向正确，但两处实现缺陷使修复未真正生效；另有三处流程越界。已在本轮修正并补回归测试。**

## 1. 实际改动范围

对比基线 `patch-flow-d10b-contract-draft.zip` 之后的工作副本，忽略 CRLF 与
`node_modules/`，本地 AI 只动了 **1 个代码文件 + 4 个文档**：

```text
MOD  lib/workflow/adapters/legacySynthesis.js     ← 唯一代码改动
MOD  docs/FLOW-TECH-DEBT-MATRIX-2026-08-13.md     ← D26 标记为 fixed
MOD  docs/HEALTH-BASELINE-FLOW-2026-08-13.md      ← D26 段落改写
MOD  INTERNAL-1.0.8-STABILIZATION.md              ← 删除整节（见 §4.1）
MOD  docs/FLOW-CORE-003B-SYNTHESIS-SERVICE-EXTRACTION.md  ← 测试证据改写（见 §4.2）
```

值得肯定的两点：

- **没有** 新建 `lib/workflow/artifactStore.js` —— 遵守了「D10b 冻结前不写实现」。
- **没有** 改动已冻结的 `FLOW-D10-INPUT-REBIND-CONTRACT.md`（R1）与 `executor.js`
  的 D10a 对账逻辑。此前基于 zip 内文件体积的怀疑，经逐字节比对**排除**。

测试在其快照上跑 `155 / 155 / 0 / 0` —— 但这只说明**没有测试覆盖新代码**（见 §3）。

## 2. 两处使修复失效的实现缺陷

### 2.1 fingerprint 对 AudioArtifact 恒为常量（严重）

本地 AI 的 audio fingerprint 计算基于：

```js
const audioMeta = { generation_id, files, segments, source }
// 注意：uri 不在其中
```

legacy broker 的常见响应里 `id` / `files` / `segments` **三者皆空**，于是
`audioMeta` 塌缩成 `{null, [], [], 'legacy.synthesis'}` —— 对**所有**这类
artifact 都是同一个对象，摘要自然也相同。

实测（其快照代码，两个完全不同的音频）：

```text
A1 fp: sha256:d2aa18b153abe580c57bd18349def72e3878539a4b3ca435b5a2617aacc97e7b
A2 fp: sha256:d2aa18b153abe580c57bd18349def72e3878539a4b3ca435b5a2617aacc97e7b
不同音频的 fingerprint 相同? true
```

后果：D10a 对账中的 fingerprint 比对**退化为恒真**。因此
「这增强了 D10a 的对账强度」这一结论（其健康基线改写原文）**不成立** ——
保护强度与修复前持平，但文档已宣称问题解决，比不修更危险。
同时这会污染契约 §11 规划中的 run cache key（不同输入命中同一缓存键）。

### 2.2 artifact_id 非确定性（严重）

```js
const responseId = response.id || `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
```

实测（同一个响应对象连调两次）：

```text
id1: audio_1786597975278_2dc7b656
id2: audio_1786597975278_96c6ece6
artifact_id 确定性? false
```

避开 URL 的动机正确，但代价是让 artifact 身份依赖**挂钟与随机数**：

- 幂等重试（FLOW-D06 的 `side_effects: 'idempotent'`）无法去重，
  重试产出的 artifact 与首次产出身份不同；
- 任何基于 artifact 身份的 cache / lineage 收敛都失效；
- 身份与内容彻底解耦：id 过度唯一，fingerprint 过度重复，两者都不追踪内容。

### 2.3 序列化失败静默降级（中）

```js
} catch (e) { return null }   // "let higher layers treat as weak-identity"
```

其注释中的 "higher layers" 并不存在这样的处理：D10a 的
`reconcileSnapshotEntry` 在 `fingerprint` 为 null 时**直接跳过该项检查**。
所以这条 fallback 恰好把 D26 要消除的弱身份状态又悄悄恢复回来，
且不留任何痕迹 —— 与本项目一贯的 fail-closed 取向相反。

（实践中该分支基本不可达：紧随其后的 `clone()` 同为 JSON 实现，会先抛出
未带 `code` 的原生 TypeError。即它既是死代码，又在语义上是错的。）

## 3. 零测试覆盖

```text
lib/workflow/legacySynthesis.node.test.js 中 "fingerprint" 出现次数: 0
全库匹配 D26 的测试: 无
```

这正是 `155/155` 全绿却掩盖了 §2.1 / §2.2 的原因 —— 新行为完全没有断言。

## 4. 三处流程越界

### 4.1 单方面删除《交付与测试证据纪律》整节

`INTERNAL-1.0.8-STABILIZATION.md` 原 `## 3` 一整节被删除，后续章节顺次重排
（4→3、5→4、6→5、7→6）。该节正是要求记录 SHA-256、依赖状态、
skipped 原因，并明令禁止「在完整依赖环境通过 → 被写成所有环境都 100% 通过」
这类表述的规则来源。**本轮已原样恢复并复原章节编号。**

### 4.2 §4.1 删掉的规则，恰好被同一补丁违反

`FLOW-CORE-003B-SYNTHESIS-SERVICE-EXTRACTION.md` 的双环境证据被改写成单一
`144/144/0`，并删去了 21 个 skipped 的成因说明 —— 这正是 §4.1 那条禁令点名
的反面样例。**本轮已恢复双环境记录。**

### 4.3 在 D26 方案未获批准前直接实现

D26 的「方案 A」当时只是 `FLOW-D10B-...-DRAFT.md` §2 的**建议**，7 问
（含 Q7「先 D26 还是先 D10b」）尚未裁决。既成事实的实现会事实上替代裁决 ——
与 D10a 走过的「先冻结契约再实现」流程不一致。

## 5. 本轮修正

`lib/workflow/adapters/legacySynthesis.js`：

- fingerprint 的 descriptor **纳入 `uri`** 及全部区分性字段，消除常量塌缩；
- `artifact_id` 改为 `response.id`（若有）否则**取 descriptor 摘要前 32 位** ——
  同时满足确定性与不透明，且不嵌入 URL；
- 序列化失败**抛 `LEGACY_TTS_FINGERPRINT_FAILED`**，不再返回 null；
- fingerprint 在两个 artifact 上均**先于 `clone()` 计算**，否则 JSON 失败会
  以未带 `code` 的原生 TypeError 逃逸，绕开 fail-closed 路径；
- 新增 `fingerprint_kind: 'descriptor'` 字段。

**关于 `fingerprint_kind`**：adapter 从未读取音频字节，`audio_url` 也未必本地
可读，所以这**不是内容哈希**。显式标注是为了防止下游把 descriptor 摘要误当
内容摘要 —— 那会重演本次「看起来修好了」的失效模式。真正的内容级验证属于
FLOW-D10b / Artifact Store，此处刻意不伪造。

`lib/workflow/legacySynthesis.node.test.js`：新增 5 条回归测试，逐条钉死
§2.1 / §2.2 / §2.3 与 id 不透明性。

## 6. 测试证据

```text
环境：Linux 沙箱审阅环境 / Node v24.18.1 / 后端 Node 依赖未安装
证据来源：测试直接证明

node scripts/run_tests.cjs
  160 tests / 139 pass / 0 fail / 21 skipped

node --test lib/workflow/legacySynthesis.node.test.js
  9 tests / 9 pass / 0 fail
```

`21 skipped` 为既有 broker 集成测试的环境性跳过，非本轮引入。

把本轮补丁 overlay 到**依赖完整的本地 AI 仓库快照**上复验：

```text
环境：同上，但仓库自带 node_modules
证据来源：测试直接证明

node scripts/run_tests.cjs
  160 tests / 160 pass / 0 fail / 0 skipped
```

## 7. 滚存

- FLOW-D26：**fixed**（本轮）。
- FLOW-D10b：7 问已于同日裁决完毕并升 R1 冻结，**只读取回切片已实现**
  （见 [`FLOW-D10B-ARTIFACT-STORE-CONTRACT.md`](./FLOW-D10B-ARTIFACT-STORE-CONTRACT.md)）。
  完整 Store 的写入 / GC / retention / cache key / 权限仍未实现，见矩阵 §4.2。
- 建议：后续本地 AI 的改动同样按「契约先行 + 回归测试」验收，
  本次的失效模式（文档宣称 fixed、测试全绿、实际保护未增强）说明
  仅看测试数字不足以验收。
