# 2026-06-19 Training Pipeline MVP 实现报告

## 完成内容

### 后端
- `lib/training/pipeline.js` — Pipeline 编排器（状态机 + 步骤调度）
- `lib/training/config.js` — 训练配置加载器（training_defaults.json）
- `lib/training/steps/denoise.js` — 去人声（占位实现）
- `lib/training/steps/slice.js` — 语音切片（占位实现）
- `lib/training/steps/asr.js` — 语音识别（占位实现）
- `lib/training/steps/preprocess.js` — 预处理（占位实现）
- `lib/training/steps/train.js` — 训练（占位实现）
- `server.js` 新增路由：
  - POST /api/train/start — 启动训练
  - GET /api/train/status/:id — 查询状态
  - POST /api/train/cancel/:id — 取消训练
  - GET /api/train/logs/:id — 获取日志
  - GET /api/train/tasks — 获取所有任务

### 前端
- `web/src/App.jsx` 新增 TrainingTab 组件：
  - 角色名称输入
  - 音频文件夹路径输入
  - 语言选择（ja/zh/en/ko/yue）
  - 预处理选项勾选（去人声、语音切片、语音识别）
  - 开始训练按钮
  - Pipeline 进度条（5 步骤可视化）
  - 实时日志面板
  - 训练完成后返回
- 导航栏新增 "Train" 按钮

### 文档
- `docs/TRAINING_PIPELINE.md` — 训练 Pipeline 设计文档（已修正）
- `docs/WORKFLOW.md` — 项目工作流纪律
- `training_defaults.json` — 默认训练参数配置

## 已知问题
- 所有步骤都是占位实现（直接复制文件），需要接入实际的 GPT-SoVITS Python 脚本
- MSYS/Windows 环境下 Vite 有缓存问题，需要 `rm -rf dist node_modules/.vite` + `usePolling: true`
- server 进程重启在 MSYS 下有问题（taskkill 不工作）

## 下一步
- 接入实际的 Python 脚本调用（UVR5、Slicer、Whisper、s1/s2_train）
- 复制预训练模型文件到项目
- 实现训练完成后的 autoRegisterVoice
- 测试端到端流程
