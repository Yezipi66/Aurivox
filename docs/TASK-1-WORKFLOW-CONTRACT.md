# Task 1：Workflow Framework and Contract

## 目标

在不改变当前 WebUI 和已有训练/推理行为的前提下，确定未来 Flow 模式共用的：

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

- [ ] `WORKFLOW_ARCHITECTURE.md`
- [ ] `WORKFLOW_CONTRACT.md`
- [ ] `ARTIFACT_AND_RUN_CONTRACT.md`
- [ ] `NODE_AND_GATE_CONTRACT.md`

### T1.2 纯函数 validator

- [ ] Workflow 顶层 schema 校验
- [ ] Node ID / type / version 校验
- [ ] Edge port 校验
- [ ] DAG 环检测
- [ ] 参数 schema 校验
- [ ] Artifact type compatibility 校验

### T1.3 最小 Workflow model

- [ ] `WorkflowDocument`
- [ ] `NodeDefinition`
- [ ] `EdgeDefinition`
- [ ] `ArtifactRef`
- [ ] `RunState`
- [ ] `NodeRunState`

### T1.4 Legacy adapter

- [ ] 将现有线性训练 pipeline 描述为固定 Workflow
- [ ] 不改变现有 `trainingPipeline` 行为
- [ ] 能从 Workflow 执行入口调用 legacy pipeline
- [ ] 失败状态映射回 Run Journal

### T1.5 测试

- [ ] 合法 Workflow 通过
- [ ] 缺字段失败
- [ ] 端口类型不匹配失败
- [ ] DAG 环失败
- [ ] disabled node 行为正确
- [ ] pause/resume 状态正确
- [ ] legacy adapter 的输入输出正确

## 完成标准

Task 1 完成不以“有一个画布”为标准，而以以下结果为标准：

```text
可以保存一份版本化 Workflow JSON
可以验证这份 JSON
可以识别节点和端口错误
可以表达当前线性训练流程
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
