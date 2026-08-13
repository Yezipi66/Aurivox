# FLOW-D27 契约 R1（冻结）— 用户原文在 Flow 持久层中的留存

> **状态：R1，已冻结。** 本文件是 D27 的**唯一实现依据**。
> [`FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md`](./FLOW-D27-JOURNAL-PLAINTEXT-DRAFT.md)（R0）
> **不再是实现依据**，仅作为发现过程与实测记录保留。
>
> **本轮（阶段 0）零代码改动。** 冻结契约本身不改变任何行为，
> 因此**没有任何「已修复」可供声称**。
>
> 沿用 FLOW-D10 / D10b 纪律：草案 → 逐问裁决 → R1 冻结 → 才实现。

---

## 0. R1 相对 R0 的变化（先读这一节）

R0 冻结前追加了一轮**本地完整环境审计**（Windows + 完整依赖 + 真实 server 进程），
它带来三处实质变化：

1. **通道 ④ 从「推定承重」升级为「实测承重」**：抹掉 `meta.json` 的
   `text` 与 `recipe.text` 后，Recent Generations 的 **Rerun 与 Reload 双双失能**
   （编辑器为空 → Generate 报 `Enter text to synthesize`）。Q1 据此锁定。
2. **新增通道 ⑤（客户端）**，并在同一轮把它的范围**缩小**到实测支持的程度 ——
   `generate.result` **不含**原文，此前基于代码路径的推断被 localStorage 实物证伪。
   单列为 **FLOW-D29**，不并入 D27。
3. **Q5（`fingerprint_version`）从「建议」升级为「必须」**，理由见 §3.2 ——
   本地探针打印出的一行 `artifact_id changes too : audio_g2 -> audio_g2`
   证明脱敏会产生「指纹变、id 不变」的组合，而这个组合在
   `artifactStore.js:111-116` 下与「产物被篡改」不可区分。

> 教训登记：R0 的通道 ⑤ 判断连续两次过强，都是从代码路径推断而非读取实际存储内容。
> **客户端侧结论必须以实际存储内容为准。**

---

## 1. 暴露面（五通道，冻结版）

| # | 位置 | 内容 | 承重 | D26 指纹面内 | 本条范围 |
|---|---|---|---|---|---|
| ① | `NODE_SUCCEEDED(io.text_input).payload.node.outputs.text.value` | 完整原文逐字 | **是** | 否 | **在** |
| ② | `NODE_SUCCEEDED(tts.generate).payload.node.outputs` 的 `metadata.request.text` / `reference_text` / `pron_overrides`；**split 时**另有 `metadata.response.segments[].text` 与 `AudioArtifact.metadata.segments[].text` | 逐字 | 否 | **是** | **在** |
| ③ | `GATE_CREATED.payload.gate.input_artifacts`（`humanGate.js:74` 为 `clone()`） | 与 ② 同源 | 否 | 否 | **在** |
| ④ | `outputs/generate/<id>/meta.json`：`text`、`recipe.text`、`ref_text`、`recipe.reference_text` | 逐字，4 处 | **是（产品功能）** | 否 | **不在**（§2.1） |
| ⑤ | 浏览器 `localStorage` 键 `tf.v1.generate.text`（编辑器缓冲区，跨会话留存） | 当前编辑内容 | 否 | 否 | **不在**（FLOW-D29） |

**承重性判据（实测）**：`executor.js:253` 的 `sourceOutputs()` 从
`projection.node_runs[nodeId].outputs` 取下游输入，写入点是 `executor.js` 的
`NODE_SUCCEEDED` 分支 `outputs: clone(result.outputs || {})`。当前注册的 6 个 handler
**无一读取** ② 与 ③，二者是纯审计负载。

**D10a 仍然成立**：`RUN_CREATED.workflow_input_snapshot` 只含
`{kind, artifact_id, type, fingerprint}`，无 `value`。D27 是**输出侧**的独立通道，
与 D10a 不矛盾。

### 1.1 明确不成立的说法（防止后续被误引）

```text
「Flow 不落用户原文」                      —— 假，通道 ①②③ 均落
「D10a 已经解决了原文落盘问题」            —— 假，D10a 只覆盖输入侧
「只要改 adapter 的 metadata 就修好了 D27」—— 假，源头是 ①，改 ② 只是让它看起来被修
「抹掉 Journal 之后系统就不留原文」        —— 假，④⑤ 在 Flow 之外
「generate.result 里有原文」               —— 假，已被 localStorage 实物证伪
```

---

## 2. 七问裁决（冻结）

### 2.1 Q1 · 保护范围 —— **仅 Flow 持久层（Run Journal）**

通道 ④⑤ **明知含原文，明确不在本条范围内**。

- 通道 ④ 是**在售产品功能的承重数据**：实测抹除后 Recent Generations 的
  Rerun / Reload 立即失能。移除它是产品决策，不是工程决策，**不得以 D27 之名顺手做**。
- 通道 ⑤ 属客户端存储，责任边界不同，另立 **FLOW-D29**。

> 因此 D27 的目标被明确表述为：
> **「Flow 持久层不做出比 legacy 持久层更强的隐私承诺，且不留下暗示它更强的措辞」**，
> 而不是「用户原文不落盘」。后者本条**做不到**，写下即为虚假承诺。

### 2.2 Q2 · 本轮范围 —— **只冻结契约，不改行为**

行为改动分阶段执行，见 §4。

### 2.3 Q3 · `outputSnapshot()` —— **是，属方案 D 的一部分**

对称于 `executor.js:63` 的 `inputSnapshot()`。**不单独作为 C 方案上线**，
除非按 §4 阶段 2 的验收条件通过。

### 2.4 Q4 · 通道 ②③ 可否先停写 —— **可以，但不得单独做**

必须与 Q5 的 `fingerprint_version` **同一次提交**。单独停写 = 一次静默的产物身份变更。

### 2.5 Q5 · `fingerprint_version` —— **必须**（本轮由实测升级为硬要求）

实测：同一条 split 响应，仅移除 `segments[].text`

```text
fingerprint          sha256:975e7c3cfaa34d412504d831a5c9643c7928a49e5c159838d8cae38bb7789355
fingerprint (脱敏后) sha256:3e9079cf0f77b138a55701ec3484f00ebe3ddd06d33c1406e4b69e55d0d4f3de
artifact_id          audio_g2 -> audio_g2   （未变）
```

**指纹变、artifact_id 不变**。而 `artifactStore.js:111-116` 的
`reconcileArtifactDescriptor` 对「同一 id、fingerprint 不符」的处置是
**fail closed 且不可重试**，诊断信息与「产物被第三方篡改」**完全同形**。

> 结论：没有 `fingerprint_version`，D27 的修复会把自己伪装成一次 D10b 安全告警。
> 有了它，D10a/D10b 可以「版本不同 → 明确拒绝比对」，而不是给出误导性 mismatch。

### 2.6 Q6 · 已落盘的 legacy Journal —— **不迁移、不删除、不改写**

Journal 是 append-only。既有文件标注为「legacy 明文 Journal」，
retention 纳入 **FLOW-D22**。

### 2.7 Q7 · 集成断言如何演进 —— **拆两条 + 补 split 用例**

- 通道 ①：在阶段 2 落地前**保持钉住原文**，注释须写明「这是 gap 而非保证」。
- 通道 ②③：一旦停写即改为**反向断言**。
- **必须新增一条 split 路径用例** —— 现有断言只覆盖非 split，
  实测确认非 split 的 `AudioArtifact.metadata.segments` 为 `[]`，
  结构上不可能覆盖 split 形态。

---

## 3. 冻结的方案：**E**

```text
现在   = A   维持行为 + 显式声明（本文件即为该声明）
目标   = D   值经 Artifact Store，Journal 只留 id + fingerprint
过渡   = C   outputSnapshot 作为显式开关，且必须承认其代价
否决   = B   只改 adapter metadata（治标，且静默改 D26 指纹）
```

**B 被明确否决**，任何后续提交不得以 B 的形式实现 D27。

### 3.1 阶段 2 的前提发现（降低了 D 的门槛）

通道 ① 承重，但它承载的能力是**跨进程 resume**，而该能力**当前就不支持**
（Run Plan 仅存内存，重启后 resume 抛 `FLOW_RUN_PLAN_UNAVAILABLE` / 409）。

仓库已有同形先例：`executor.js:325/340/493` 的 `runtimeInputs` Map ——
**值放内存、终态即删、Journal 只留身份快照**，这正是 D10a 的做法。

> 因此通道 ① 的修复可表述为：**把 D21 已有的模式从输入侧平移到输出侧**。
> 在当前能力边界内，它**不损失任何现有能力**。
>
> ⚠️ 该判断来自代码阅读，**尚未实测**。阶段 2 必须先用测试钉死 §4 的三条前提，
> 红了就停，不得硬改。

---

## 4. 实施计划（分阶段，每阶段独立可验收、可中止）

### 阶段 0 —— ✅ 已完成：R1 冻结（纯文档）
改动：本文件 + R0 标注 + 矩阵 + 健康基线 + README。**测试总数不变：202/202/0/0。**

### 阶段 1 —— ✅ 已完成：FLOW-D28（最小、与 D27 无耦合）
```text
新建 lib/workflow/errorStatus.js            零依赖，statusFor + STATUS_BY_CODE
改   lib/routes/flow.js                     改为从新模块引入；re-export 已删除
改   lib/workflow/runtime.node.test.js      直接 require 新模块 + 2 条回归守卫
```
**验收不是「全绿」**：必须在**移除 `node_modules`** 的环境下确认
`runtime.node.test.js` 不再整套件红灯。**仅在 flow.js 保留 re-export 而测试不改
= 未修复**（测试仍会经 `routes/flow` 触发 `require('express')`）。

实测：`191/161/1/29` → **`204/175/0/29`**；期望总数由 **202 改为 204**。
两条守卫经反例验证。**re-export 选择删除而非保留**，理由见矩阵 §4.1。
**D27 本身未被触碰** —— 阶段 1 与 D27 语义零耦合，这正是它被排在前面的原因。

### 阶段 2 —— D27 通道 ①（承重项，单独一轮）
`executor.js`：输出值进内存 sidecar，Journal 写 `outputSnapshot()`。
**前置三条，任一不满足即停止**：

```text
1. 同进程 Gate approve → resume 仍然通过
2. 跨进程 resume 仍然是 FLOW_RUN_PLAN_UNAVAILABLE（不得变成新错误码）
3. 「Journal 持久化并 replay 到同一状态」那条测试仍绿
```

### 阶段 3 —— D27 通道 ②③（与 D26 纠缠，**必须同一次提交**）
`adapters/legacySynthesis.js` 停写 + `fingerprint_version`；
`humanGate.js` 的 `input_artifacts` 改为身份摘要。
**预期主动打红**至少 3 条既有断言（钉住 gap 那条 + D26 两条）——
**这是设计意图，不是回归**。

**阶段 3 允许永远不做**：通道 ②③ 无消费者，将其记为 `deferred`
并保留本文件的声明，是站得住的工程决策（同 D22–D25）。

### 明确不做
```text
通道 ④ meta.json          实测承重，动它等于移除 Rerun/Reload
通道 ⑤ 客户端             FLOW-D29 单独排期
Run Plan 持久化 / Store 写入侧 / Canvas
任何 drive-by fix         含 meta.json 中的绝对路径泄露（另记，不在本条）
```

---

## 5. 已提前预告的后果（避免被当成回归）

- 阶段 3 会让钉住 D27 的集成断言变红 —— **设计意图**。
- 采纳 Q4+Q5 后，**legacy 产物 fingerprint 会变**，跨版本恢复时 D10a 应明确拒绝比对。
- 若启用 C 开关：跨进程 resume 必须以 `WORKFLOW_INPUT_REBIND_REQUIRED` 显式失败，
  **不得静默降级**。
- 测试总数会变。**每一轮交付必须明写期望总数**；「全绿」不构成验收。

---

## 6. 验证深度声明

```text
已实测（沙箱 Linux 无依赖 + 本地 Windows 完整依赖，两套环境结果逐字节一致）：
    通道 ①②③；脱敏对 D26 指纹的影响（两个不同 sha256）；artifact_id 不随之变化
已实测（本地真实 server + WebUI）：
    通道 ④ 承重 —— 清空 text/recipe.text 后 Rerun/Reload 失能
已实测（localStorage 实物）：
    通道 ⑤ 仅为编辑器缓冲区；generate.result 不含原文
已实测：D10a 输入快照脱敏在同一条 run 上仍成立
已实测：完整依赖环境 202 tests / 202 pass / 0 fail / 0 skipped

未实测：真实 GPT-SoVITS 引擎下的 split 分支（本地缺 torch，本轮未排期）
        —— stub 形状逐字取自 synthesisService.js:226/278，但「抄的」不等于「测的」
未实测：§3.1 中「通道 ① 可平移 D21 模式」的判断（属代码阅读，阶段 2 必须先测）
未实测：localStorage 的 generate.hanReadings / hanForced 是否间接暴露原文结构
        —— 归入 FLOW-D29 待确认项，不在本文件作任何断言
```

**本轮零行为改动，无「已修复」可供声称。**
