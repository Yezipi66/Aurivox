# Training Pipeline 实现任务清单

## Phase 1: 后端 Pipeline API

### 1.1 目录结构
```
lib/training/
├── pipeline.js          # Pipeline 编排器（状态机 + 步骤调度）
├── steps/
│   ├── denoise.js       # Step 1: 去人声（调用 UVR5）
│   ├── slice.js         # Step 2: 切片（调用 slicer2.py）
│   ├── asr.js           # Step 3: 语音识别（调用 faster-whisper）
│   ├── preprocess.js    # Step 4: 预处理（BERT 特征、音高）
│   └── train.js         # Step 5: 训练（s1 + s2）
├── config.js            # 训练配置加载器（training_defaults.json）
└── statusStore.js       # 训练状态存储（内存，后续可换 Redis）
```

### 1.2 Pipeline 编排器设计
- 状态机：pending → running → completed / failed
- 每个步骤独立执行，支持取消
- 实时日志输出（SSE 或轮询）
- 步骤依赖：必须按顺序执行

### 1.3 步骤实现
- denoise: 调用 UVR5 Python 脚本，输入音频目录，输出纯人声目录
- slice: 调用 slicer2.py，输入纯人声目录，输出切片目录
- asr: 调用 faster-whisper，输入切片目录，输出文本列表
- preprocess: 提取 BERT 特征、音高特征，生成训练数据
- train: 调用 s1_train.py + s2_train.py

### 1.4 server.js 路由
- POST /api/train/start — 启动训练
- GET /api/train/status/:id — 查询状态
- POST /api/train/cancel/:id — 取消训练
- GET /api/train/logs/:id — 获取日志

## Phase 2: 前端训练页面

### 2.1 TrainingTab 组件
- 音频文件夹选择（路径输入 + 浏览按钮）
- 语言选择（下拉框）
- 预处理选项（勾选框：去人声、切片、ASR）
- 开始训练按钮
- Pipeline 进度条（实时显示当前步骤）
- 日志面板（实时滚动）

### 2.2 导航栏新增 "Train" 按钮

## Phase 3: 模型文件

### 3.1 需要复制的文件
- GPT_SoVITS/pretrained_models/v2Pro/ → models/pretrained/gsv-v2pro/
- GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/ → models/pretrained/gsv-v2final/
- GPT_SoVITS/pretrained_models/chinese-hubert-base/ → models/pretrained/chinese-hubert-base/
- GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/ → models/pretrained/chinese-roberta-wwm-ext-large/
- GPT_SoVITS/pretrained_models/fast_langdetect/ → models/pretrained/fast_langdetect/
- GPT_SoVITS/pretrained_models/models--nvidia--bigvgan_v2_24khz_100band_256x/ → models/pretrained/bigvgan/
- tools/uvr5/uvr5_weights/ → models/uvr5/
- tools/asr/models/faster-whisper-large-v3-turbo/ → models/asr/faster-whisper-large-v3-turbo/

### 3.2 配置文件
- training_defaults.json — 默认训练参数
