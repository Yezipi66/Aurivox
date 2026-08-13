# Task 1：Workflow Framework and Contract

## 目标

在不改变当前 Aurivox Workbench（现有 WebUI）和已有训练/推理行为的前提下，确定未来 Aurivox Flow 共用的：

- Workflow 文档；
- Node；
- Edge；
- Artifact；
- Run Journal；
- Quality Gate；
- 资源调度；
- Legacy pipeline adapter。

## 非目标

- 不实现节点画布；
- 不重写 `server.js`；
- 不拆 GPT-SoVITS 训练算法；
- 不迁移已有资产目录；
- 不改变现有 API；
- 不引入社区插件运行时；
- 不做 Linux/macOS/AMD/Intel 支持。

## 交付顺序

### T1.1 文档契约

- [x] `FLOW-ARCH-001-DECISION.md`：Workbench / Flow 边界与 Human Gate 架构决策
- [ ] `WORKFLOW_ARCHITECTURE.md`：根据决策记录完成一致性审阅
- [ ] `WORKFLOW_CONTRACT.md`
- [ ] `ARTIFACT_AND_RUN_CONTRACT.md`
- [ ] `NODE_AND_GATE_CONTRACT.md`

> T1.1 的文档仍未宣告全部完成。当前只确认了产品命名、Artifact 不可变方向，以及人工等待作为 Executor 原语；review schema、revision、Gate 幂等恢复等细节仍需在 FLOW-ARCH-002 中冻结。

### T1.2 FLOW-ARCH-002：Human Gate / Revision / Resume 契约

- [x] `review.human_gate` 输入输出初稿
- [x] Gate instance 和等待状态初稿
- [x] Artifact revision / lineage 初稿
- [x] approve / submit_revision / reject / cancel 初稿
- [x] 资源释放与恢复幂等初稿
- [x] Workbench / Flow 共享的 Artifact Preview API 方向
- [ ] 用户评审并冻结最终字段和迁移规则

文档：[`FLOW-ARCH-002-HUMAN-GATE-DECISION.md`](./FLOW-ARCH-002-HUMAN-GATE-DECISION.md)

当前 R1 选择：

```text
reject       → rejected 终态（或显式 rejected 分支）
编辑提交     → submit_revision
Artifact     → 同一 lineage 允许分支，artifact_id 保持不透明
```

> T1.1 / T1.2 仍未宣告全部完成。当前是架构草案和决策记录，不能视为已经实现的 Executor 或 API。

### T1.3 FLOW-CORE-001：Workflow Validator / Immutable Run Plan

- [x] Workflow 顶层 schema 校验
- [x] Node ID / type / version 校验
- [x] Edge port 校验
- [x] DAG 环检测
- [ ] 完整参数 schema 校验（当前只覆盖 Human Gate decisions、source binding 和资源字段）
- [x] Artifact type compatibility 校验
- [x] Workflow input binding 校验
- [x] execution fingerprint（忽略 UI-only position / label）
- [x] immutable Run Plan 生成
- [x] Human Gate R1 decision vocabulary 校验

实现文件：

```text
lib/workflow/nodeRegistry.js
lib/workflow/validator.js
lib/workflow/index.js
lib/workflow/validator.node.test.js
```

### T1.4 FLOW-CORE-002A：Run State / Journal / Human Gate model

- [x] Run 状态转换表
- [x] Gate 状态转换表
- [x] Human Gate create / approve / submit_revision / reject / cancel
- [x] `gate_revision` 乐观并发校验
- [x] Gate invalidation
- [x] append-only Journal model
- [x] Journal replay 到 Run projection
- [ ] 文件 / 数据库持久化 adapter
- [ ] Executor 调度和资源释放实现

实现文件：

```text
lib/workflow/runState.js
lib/workflow/humanGate.js
lib/workflow/runJournal.js
lib/workflow/runLifecycle.node.test.js
```

### T1.5 最小 Workflow model

- [ ] `WorkflowDocument`
- [ ] `NodeDefinition`
- [ ] `EdgeDefinition`
- [ ] `ArtifactRef`
- [ ] `RunState`
- [ ] `NodeRunState`

### T1.6 Legacy adapter

- [ ] 将现有线性训练 pipeline 描述为固定 Workflow
- [ ] 不改变现有 `trainingPipeline` 行为
- [ ] 能从 Workflow 执行入口调用 legacy pipeline
- [ ] 失败状态映射回 Run Journal

### T1.7 测试

- [x] 合法 Workflow 通过
- [x] 缺字段 / required input 失败
- [x] 端口类型不匹配失败
- [x] DAG 环失败
- [x] Human Gate decision vocabulary 失败/通过
- [x] Run Plan fingerprint 和深度不可变
- [ ] disabled node 执行语义
- [ ] pause/resume 状态执行
- [ ] legacy adapter 的输入输出

## 完成标准

Task 1 完成不以“有一个画布”为标准，而以以下结果为标准：

```text
可以保存一份版本化 Workflow JSON
可以验证这份 JSON
可以识别节点和端口错误
可以表达当前线性训练流程
可以表达一个持久化的 Human Review Gate
可以记录 awaiting_human_review 和 resuming 状态
可以记录一次 Run 的节点状态
可以在不破坏旧 pipeline 的情况下从新入口调用旧 pipeline
```

## 后续任务

Task 1 完成后，再进入：

```text
Task 2：server.js runtime/config boundary
Task 3：Asset/Recipe/Output services
Task 4：Training service boundary
Task 5：Workflow executor
Task 6：Quality gate runner
Task 7：Flow UI prototype
```
