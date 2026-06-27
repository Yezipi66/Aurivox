# 项目工作流纪律

## 源码修改规范

1. **每次修改代码前**：先 `git add -A && git commit -m "wip: before [description]"`
2. **每次修改代码后**：`git add -A && git commit -m "[type]: [description]"`
3. **Commit 次数越多越好**：即使是小的改动也要 commit，保持细粒度
4. **永远不 revert**：用 stash 或新 commit 回退，不破坏历史

## 项目状态追踪

每完成一个阶段，更新 `docs/PROJECT_STATUS.md`，记录：
- 当前 HEAD commit
- 已完成的步骤
- 下一步计划
- 已知问题/阻塞点

## Report 文档

每完成一个功能或修复，在 `docs/reports/` 目录下生成一份 report：
- `docs/reports/YYYY-MM-DD-[feature-name].md`
- 包含：改动内容、涉及文件、测试结果、已知问题

## 文件结构

```
docs/
├── DECOUPLING_TASKS.md      # 解耦任务追踪
├── TRAINING_PIPELINE.md     # 训练流水线设计文档
├── PROJECT_STATUS.md        # 项目状态（每次更新）
└── reports/                 # 每次功能完成的报告
    └── YYYY-MM-DD-xxx.md
```
