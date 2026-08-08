# Aurivox Workflow Architecture

> Task 1：定义 WebUI 与未来 Flow 共用的工作流基础，不实现画布，不替换当前 WebUI。
>
> 状态：Draft / internal design
> 版本：Workflow Contract v1

## 1. 产品形态

Aurivox 维护两种前端形态：

```text
Aurivox WebUI
  面向初学者和日常个人工作流
  使用固定、强引导的页面流程

Aurivox Flow
  面向专业用户和实验工作流
  使用节点、分支、质量门、暂停和批量对比

两者共享 Aurivox Core
  Artifact Store
  Asset/Recipe Service
  Workflow Executor
  Inference Service
  Training Service
  Resource Manager
  Run Journal
```

Flow 是第二种产品形态，不是当前 WebUI 的替代品。WebUI 的页面可以被视为一组经过设计的预设工作流。

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

## 5. 当前线性管线的兼容方式

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

## 6. 核心设计原则

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

## 7. 第一阶段交付物

- 本文件；
- `WORKFLOW_CONTRACT.md`；
- `ARTIFACT_AND_RUN_CONTRACT.md`；
- `NODE_AND_GATE_CONTRACT.md`；
- JSON schema 或等价 validator；
- 一个不改变现有 WebUI 的 Legacy Workflow Adapter；
- Workflow/Artifact/Run 的纯 Node 单元测试。
