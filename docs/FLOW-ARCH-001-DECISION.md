# FLOW-ARCH-001：Aurivox Workbench / Aurivox Flow 架构决策

> 状态：Architecture decision accepted / internal design only
>
> 本文件确认产品形态和执行语义，不实现代码、不实现画布、不引入新的运行时依赖。

## 1. 决策摘要

### 1.1 产品名称

Aurivox 保留两种产品形态：

```text
Aurivox Workbench
  当前 WebUI 的产品名称
  面向固定工作流、快速操作和明确的任务页面

Aurivox Flow
  专业工作流和实验系统
  面向节点编排、分支、对比、人工审核、质量门和可恢复运行
```

`WebUI` 作为实现层/代码层称呼可以继续存在，但产品层使用 `Aurivox Workbench`。

两者共享 Aurivox Core：

```text
Workflow Document / Validator
Workflow Executor
Artifact Store
Run Journal
Human Review / Quality Gate
Resource Manager
Asset / Recipe Service
Inference / Training Service
Legacy Pipeline Adapter
```

Workbench 不是 Flow 的简化画布；Flow 也不是 Workbench 的替代页面。两者共享契约和运行内核，但交互理念不同。

### 1.2 人工等待是执行器原语

人工审核不是一个只在前端显示的特殊按钮，也不是普通的 `if` 节点。它是 Workflow Executor 必须原生支持的运行状态：

```text
running
  ↓
awaiting_human_review
  ↓
resuming
  ↓
succeeded / failed / cancelled
```

人工等待节点必须能展示推理或数据处理产物，让用户确认、拒绝或修改后继续运行。

### 1.3 Artifact 不原地修改

审核和编辑不会覆盖原始 Artifact。用户修改后生成新 Artifact 或新 Revision，并保留父产物关系。

```text
推理产物 v1
    ↓ 人工审核
读音/文本/参数修改
    ↓
审核产物 v2
```

### 1.4 第一阶段仍然只支持 DAG

第一阶段使用有向无环图。暂停、恢复、重试由执行器和 Run Journal 实现，不通过任意回边、无限循环或隐式递归实现。

## 2. 目标架构

```text
┌─────────────────────┐      ┌─────────────────────┐
│ Aurivox Workbench   │      │ Aurivox Flow        │
│ fixed task UI       │      │ professional graph  │
└──────────┬──────────┘      └──────────┬──────────┘
           └──────────────┬─────────────┘
                          ▼
                   ┌─────────────┐
                   │ Aurivox Core│
                   ├─────────────┤
                   │ Validator   │
                   │ Executor    │
                   │ Artifacts   │
                   │ Run Journal │
                   │ Human Gates │
                   │ Quality Gate│
                   │ Resources   │
                   │ Adapters    │
                   └──────┬──────┘
                          ▼
              Existing inference / training
              GPT-SoVITS / assets / outputs
```

Workbench 的页面流程可以看作预先设计好的 Workflow，但 Workbench 不需要暴露完整节点图；Flow 则直接操作 Workflow、Artifact 和 Run。

## 3. Human Review Gate 契约方向

第一版的规范节点名建议为：

```text
review.human_gate
```

它是通用人工等待节点。具体的审核界面由 `review_schema` 决定，而不是让每个业务节点自行实现一套暂停逻辑。

典型实例：

```json
{
  "type": "review.human_gate",
  "type_version": 1,
  "params": {
    "review_schema": "pronunciation.v1",
    "decisions": [
      "approve",
      "submit_revision",
      "reject",
      "cancel"
    ]
  }
}
```

### 3.1 输入

```text
review_target: ArtifactRef[]
review_schema: string
review_policy: object
```

`review_target` 可以是：

```text
AudioArtifact
Transcript
PronunciationRecipe
SegmentManifest
TrainingPreview
QualityReport
```

### 3.2 输出

```text
GateDecision
ApprovedArtifactRef (可选)
ReviewRecord
```

- `approve`：保留输入 Artifact，并通过明确的 `approved` 输出端口生成批准记录；
- `submit_revision`：用户已经提交编辑后的内容，生成新 Artifact，再继续下游；
- `reject`：沿显式 `rejected` 分支继续；没有该出口时 Run 进入 `rejected` 终态；
- `cancel`：结束当前 Run。

### 3.3 等待时的执行语义

进入人工等待时，Executor 必须：

1. 持久化 `run_id`、`node_id`、gate instance 和输入 Artifact；
2. 将 Run 状态改为 `awaiting_human_review`；
3. 写入一条 Journal event；
4. 保存预览所需的 ArtifactRef 和 review schema；
5. 释放 GPU、模型锁和其他可释放资源；
6. 不启动任何下游节点；
7. 允许进程重启后继续等待；
8. 用户决策后重新申请资源并从该 Gate 恢复。

人工等待页面关闭、浏览器刷新或后端重启，都不能丢失这条等待中的 Run。

## 4. Review Schema 与产品形态

审核节点本身只提供生命周期和输入输出契约，具体 UI 通过 schema 注册：

```text
pronunciation.v1
  Han 字符语言 / 读音审核

transcript.v1
  ASR 文本审核

audio_audition.v1
  音频成品试听与选择

quality_report.v1
  自动质量报告人工确认
```

Workbench 可以把这些 schema 渲染成强引导的固定页面；Flow 则在右侧 Inspector 或 Artifact Preview 中以更紧凑的专业方式展示。

## 5. Flow 与 Workbench 的交互区别

### Workbench

- 固定页面和固定流程；
- 使用安全默认值；
- 提供较多操作提示；
- 适合一次完成一个明确任务；
- 不要求用户理解 DAG、Artifact 或 Node Contract。

### Flow

- 图、节点、端口和 Artifact 是主要界面；
- 文案保持简洁，不重复解释基础概念；
- 重点展示状态、指标、输入输出和版本；
- 支持分支、对比、回看和恢复；
- 专业用户可以直接检查运行计划和失败节点。

## 6. 明确不做

在本架构决策下，以下内容仍然不是第一阶段目标：

- 不 fork 或依赖 ComfyUI Runtime；
- 不立即实现画布；
- 不替换 Aurivox Workbench；
- 不重写 GPT-SoVITS；
- 不把 `server.js` 一次性拆成大量服务；
- 不执行未知社区插件或任意 Python/Node 代码；
- 不支持任意循环和无界并发；
- 不把公网多人协作作为当前目标；
- 不以“画布能连线”作为 Task 1 完成标准。

未来可以增加 Comfy-like JSON 导入/导出或适配层，但不能让外部画布格式反过来决定 Aurivox Core 的 Artifact 和 Run 语义。

## 7. 待在实现前继续确认的契约问题

以下问题必须在进入 Executor 实现前写入正式契约：

1. `review_schema` 的注册、版本和迁移规则；
2. Gate 超时、过期和用户取消语义；
3. 本地单用户 `operator` 记录格式；
4. Workbench 与 Flow 共享的 Artifact Preview API；
5. Quality Gate 与 Human Review Gate 的组合关系；
6. R1 契约在实际 Workflow 示例中的一致性和迁移边界。

`submit_revision`、`rejected` 终态、Gate 状态、Artifact lineage、Workflow Revision、gate_revision 和幂等恢复已经写入 R1 草案：[`FLOW-ARCH-002-HUMAN-GATE-DECISION.md`](./FLOW-ARCH-002-HUMAN-GATE-DECISION.md)。R1 仍需用户评审后才能 Accepted。

本文件只确认方向，不替尚未评审的细节假装已经实现。

## 8. 下一步

下一步仍然是文档评审和冻结，而不是代码任务：

```text
Review / freeze FLOW-ARCH-002 R1
```

完成该契约后，才进入：

```text
FLOW-CORE-001  Workflow Validator / Run Plan
FLOW-CORE-002  Executor / Run Journal / Human Wait
FLOW-CORE-003  Legacy Synthesis Adapter
FLOW-UI-001    Aurivox Flow Canvas
```
