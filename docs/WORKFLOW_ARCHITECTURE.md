# Aurivox Workflow Architecture

> Task 1：定义 Aurivox Workbench 与未来 Aurivox Flow 共用的工作流基础，不实现画布，不替换当前 Workbench。
>
> 状态：Architecture decision accepted / internal design
> 版本：Workflow Contract v1
> 关联决策：[`FLOW-ARCH-001-DECISION.md`](./FLOW-ARCH-001-DECISION.md)

## 1. 产品形态

Aurivox 维护两种前端产品形态：

```text
Aurivox Workbench
  当前 WebUI 的产品名称
  面向固定工作流、快速操作和明确的任务页面

Aurivox Flow
  面向专业用户和实验工作流
  使用节点、分支、质量门、人工等待和批量对比

两者共享 Aurivox Core
  Artifact Store
  Asset/Recipe Service
  Workflow Executor
  Inference Service
  Training Service
  Human Review / Quality Gate
  Resource Manager
  Run Journal
```

`WebUI` 继续作为实现层称呼，但产品层使用 `Aurivox Workbench`。Flow 是另一种专业产品形态，不是 Workbench 的替代品；Workbench 也不需要暴露完整的节点图。

## 2. 核心架构

```text
Frontend
  ↓
Workflow document / feature request
  ↓
Workflow service
  ↓
Executor
  ├── Node registry
  ├── Artifact store
  ├── Run journal
  ├── Resource manager
  └── Gate runner
  ↓
Node adapters
  ├── ASR
  ├── UVR5
  ├── slicing
  ├── preprocessing
  ├── GPT-SoVITS S1
  ├── GPT-SoVITS S2
  ├── inference
  └── evaluation
```

## 3. 第一阶段明确不做的事

- 不立即开发 ComfyUI 风格画布；
- 不重写 GPT-SoVITS 训练算法；
- 不把当前线性 pipeline 一次性拆成几十个新服务；
- 不引入任意 Python/Node 社区代码自动执行；
- 不支持任意环路、无限循环或无界并发；
- 不把公网多租户作为工作流引擎目标；
- 不改变当前 WebUI 的 API 路径和用户数据格式。

## 4. 工作流模型

第一期只支持有向无环图 DAG：

```text
Input → Transform → Gate → Train/Infer → Publish
```

控制节点可以产生条件分支，但第一期不支持任意回边。Retry、Pause、Resume 由执行器实现，不通过让图产生无限环路实现。

## 5. 人工等待节点

人工审核是 Executor 的一等运行语义，不是前端按钮，也不是普通 `if` 节点。

规范节点名：

```text
review.human_gate
```

典型运行状态：

```text
running → awaiting_human_review → resuming → succeeded|failed|cancelled
```

进入等待时，Executor 必须持久化 Run、Gate instance、输入 Artifact 和预览信息，写入 Run Journal，并释放 GPU / 模型锁等可释放资源。用户批准、拒绝、修改后重试或取消后，Run 从该 Gate 恢复，不能通过创建一条无关的新任务来假装恢复。

具体审核界面由 `review_schema` 决定，例如：

```text
pronunciation.v1
transcript.v1
audio_audition.v1
quality_report.v1
```

Artifact 不原地修改。用户修改后生成新 Artifact 或新 Revision，并保留父产物关系。

## 6. 当前线性管线的兼容方式

当前训练管线先作为一个 Legacy Adapter：

```text
workflow node: legacy.training_pipeline.v1
  ↓
lib/training/pipeline.js
```

内部仍然调用现有 `trainingPipeline` 和 `steps/`。等 Artifact、Run Journal 和 Node Contract 稳定后，再逐步把具体步骤替换成独立节点。

当前等价图：

```text
Audio Input
  → Vocal Extraction
  → Slice
  → ASR
  → Preprocess
  → Train S1
  → Train S2
  → Promote Asset
```

## 7. 核心设计原则

### 6.1 产物不可变

节点不能原地修改上游 Artifact。需要修改时生成新的 Artifact，并记录父产物。

### 6.2 路径不是业务契约

节点输入输出使用 `ArtifactRef`，而不是散落的绝对路径字符串。真实路径只在 adapter 边界解析。

### 6.3 每次运行可恢复

所有节点状态、输入 fingerprint、输出 Artifact、日志和错误都写入 Run Journal。进程重启后可以从 journal 恢复。

### 6.4 GPU 是显式资源

当前目标硬件是 Windows + NVIDIA 单卡。需要显式声明：

```text
requires_gpu
exclusive_gpu
estimated_vram_mb
estimated_disk_mb
```

同一时刻只允许一个会修改推理引擎模型状态的节点持有 inference GPU lock。

### 6.5 预览与正式执行共用契约

Plan、Preview、Dry run 和 Execute 必须使用同一个 Node Contract。不能出现“计划页显示能运行，真正执行时才发现输入不满足”的情况。

### 6.6 用户可见的失败必须结构化

每个失败至少包含：

```text
error_code
message
node_id
run_id
retryable
input_artifacts
logs
suggested_action
```

## 8. 第一阶段交付物

- 本文件；
- `WORKFLOW_CONTRACT.md`；
- `ARTIFACT_AND_RUN_CONTRACT.md`；
- `NODE_AND_GATE_CONTRACT.md`；
- JSON schema 或等价 validator；
- 一个不改变现有 WebUI 的 Legacy Workflow Adapter；
- Workflow/Artifact/Run 的纯 Node 单元测试。
