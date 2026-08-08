# Aurivox 内部 1.0.8 Stabilization Plan

> 本文件是内部工作计划，不代表已发布版本。
>
> 目标：在“基本可用、关键流程可验收、可回滚、可维护”的门槛达到之前，不合并到 `main`，不 push，不 release，不重新创建正式 `v1.0.8` tag。

## 1. 分支纪律

```text
main
  = 最近一个公开稳定基线

work/1.0.8-stabilization
  = 当前全部修复、文档整理和债务偿还的集成分支

task/<scope>
  = 一个有限范围的内部任务
```

规则：

- `main` 不承载未完成工作。
- task 分支可以有内部 commit，但不能直接 push 到 `main`。
- 一个 task 只解决一个边界问题，不顺手扩大范围。
- 每个 task 必须有验收命令和回滚方式。
- 只有集成分支完成 release gate 后，才允许合并 main。
- tag 只在最终验收完成后创建。

## 2. “基本可用”门槛

这里的“完成”不等于没有任何 bug，而是满足：

- 没有已知 P0 功能缺陷；
- Generate、Compare Refs、Assets、Tune 的主路径可完成；
- Base model 和已训练模型都能在目标 Windows/NVIDIA 机器上推理；
- 训练失败、暂停、恢复、取消不会破坏已发布资产；
- Reading Proofing、Han language、ASR review 有浏览器级回归验证；
- 生成 metadata 能说明输入、模型、seed、segment offset 和覆盖参数；
- README、CHANGELOG、部署说明互相一致；
- `npm test`、前端 build、Python 静态检查通过；
- 分发包可以由源码重新构建；
- 已知限制被明确记录，而不是假装功能已支持。

## 3. Task 列表

### T00：分支和基线清理

**目标**：让 main 回到公开基线，所有修复进入 `work/1.0.8-stabilization`。

范围：

- 保存现有工作；
- 保留本地 backup branch；
- main 指向原始 `49244e7` 基线；
- 删除旧的错误 `v1.0.8` tag；
- 暂不创建新 tag。

验收：

```powershell
git status --short
git log --oneline --decorate -6
```

### T01：文档统一

**目标**：合并 README 和 Guidance，README 不记录历史 changelog。

范围：

- README 合并最终用户、开发者、FAQ、部署说明；
- 新增 CHANGELOG.md；
- 删除独立 GUIDANCE.md；
- 统一 Windows/NVIDIA/local-first 支持边界；
- 修正文档中 FFmpeg、Auto、Broker 的矛盾描述。

不包含：

- 不改运行代码；
- 不添加新的产品功能。

验收：

- 新用户只看 README 可以完成部署、启动和 FAQ 排错；
- README 中没有逐版本 changelog；
- 所有内部链接有效。

### T02：Text Override Contract

**目标**：固定 Han language、pronunciation、Recipe 和推理 payload 的数据契约。

范围：

- `lang_overrides`；
- `pron_overrides`；
- `han_readings`；
- 绝对位置与 segment 局部位置；
- Recipe 序列化/回载；
- Generate/Compare 共用 serializer。

验收：

- 重复汉字按位置独立；
- 中文、粤语、日语位置覆盖均可复现；
- 文本修改后旧位置状态清除；
- Recipe 保存/回载后 payload 一致。

### T03：Inference Segment Position

**目标**：解决全文位置覆盖泄漏到后续 segment 的问题。

范围：

- Broker segment remap；
- Python 内部切句 offset；
- streaming/engine-batch 路径；
- segment metadata `source_start`；
- 回归测试。

验收：

```text
全文 @0:yue、@1:yue
第一 segment：只影响第一段开头
后续 segment：不得再次收到局部 @0/@1
```

### T04：Reading/ASR 浏览器回归

**目标**：覆盖之前依赖人工发现的 UI 交互缺陷。

范围：

- Han drag selection；
- 增量选择/子范围取消；
- modal pointerup 不关闭；
- Reading Proofing 灰态；
- Korean Show all；
- ASR 行式校对；
- Auto 显示与内部值。

验收：

- 浏览器测试覆盖用户真实操作；
- 不只测试 helper 函数；
- 测试失败时能指出具体 DOM/状态变化。

### T05：server.js 第一阶段拆分

**目标**：先降低入口文件的管理债，不改变 API 行为。

拆分顺序：

1. `configRuntime`：端口、环境变量、路径；
2. `localSecurity`：loopback、Host、local API key；
3. `logging`：文件日志；
4. `filesystem`：安全静态目录、迁移、路径 helper；
5. `runtimeContext`：替代巨型 ctx 的分域 context。

约束：

- 不移动业务逻辑和 API 路径；
- 每次只拆一层；
- 先保留兼容 wrapper；
- 每次拆分后运行全套测试。

### T06：资产和 Recipe Service 边界

**目标**：明确 assets、voices、recipes、outputs 的 source of truth。

范围：

- AssetService；
- RecipeService；
- OutputService；
- schema/version；
- 原子写入和备份；
- 错误码。

验收：

- route 层只负责 HTTP 适配；
- service 可在没有 Express 的情况下测试；
- 文件损坏、缺失、迁移失败都有明确错误。

### T07：Training Service 边界

**目标**：把训练编排从 server.js/context 中进一步隔离。

范围：

- TaskJournal；
- PipelineRunner；
- StepRunner；
- subprocess 生命周期；
- cancel/resume/recover；
- review gate。

不包含：

- 不马上把 pipeline 改成图；
- 不修改 GPT-SoVITS 训练算法。

### T08：Workflow Foundation 预备层

**目标**：为未来 Flow 形态准备共享内核，但暂不做画布。

只建立最小接口：

```text
Artifact
Node
Workflow
Run
Gate
Executor
```

第一张工作流是当前线性训练管线的等价表达：

```text
Input → Denoise → Slice → ASR → Preprocess → S1 → S2 → Promote
```

验收：

- 旧 WebUI 仍然走原有主路径；
- 新 executor 能执行一张固定工作流；
- 结果与旧 pipeline 对齐；
- 失败、暂停、恢复有 journal。

### T09：Release Gate

**目标**：判断是否可以合并 main 和重新发布 v1.0.8。

验收清单：

- Windows/NVIDIA 真实验收；
- Base model 生成；
- 微调资产生成；
- 混合语言生成；
- Reading Proofing；
- ASR review；
- 训练暂停/恢复/取消；
- npm test；
- web build；
- Python 静态检查；
- 分发包重建；
- README/CHANGELOG 检查；
- `git diff --check`；
- 无未解决冲突；
- 无不应提交的本机配置。

## 4. Commit 规则

推荐提交格式：

```text
fix(inference): preserve text override positions across segments
fix(ui): stabilize multilingual proofing and Korean review layout
test: make test discovery shell-independent on Windows
docs: consolidate user guide into README
refactor(runtime): extract server configuration boundary
```

每个 commit 应满足：

- 有单一主题；
- 可以独立阅读；
- 有测试或明确说明为什么无法自动测试；
- 不包含 `advanced_params.json` 等机器私有状态；
- 不混入无关格式化；
- 可以回滚。

## 5. 当前推荐顺序

```text
T00 分支基线
  ↓
T01 README / CHANGELOG
  ↓
T02 Text Override Contract
  ↓
T03 Segment Position Regression
  ↓
T04 Browser UI Regression
  ↓
T05 server.js configuration/runtime boundary
  ↓
T06 Asset/Recipe services
  ↓
T07 Training service
  ↓
T08 Workflow foundation
  ↓
T09 Windows release gate
```

在 T09 通过以前：

```text
不合并 main
不 push main
不创建正式 v1.0.8 tag
不发布 release
```
