# TTS Broker

基于 GPT-SoVITS (v2 / v2Pro / v2ProPlus) 的 TTS 训练与推理一体化工作流，解耦自 GPT-SoVITS 项目，
自包含、可独立部署。面向内部使用者提供「解压即用」的分发包：内嵌可重定位 Python，
一键部署脚本自动建 venv、装依赖、下载模型并自检。

- **训练**：去人声 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS) 全链路管线，带失败恢复。
- **推理**：内置 OpenAI 兼容的自包含推理服务（`lib/inference/infer_server.py`），完整 S1+S2 串联。
- **分发**：`deploy.bat`（首次部署向导）+ `start.ps1`（启动），无需手工配环境。

## 项目结构

```
tts_broker_openai_compat/
├── server.js              # Express 后端 (端口 9886)
├── start.bat              # 一键启动（后端 + 前端）
├── requirements.txt       # Python 依赖
├── package.json           # Node.js 依赖
├── .env.example           # 环境变量模板
├── .gitignore
│
├── web/                   # 前端 (Vite + React, 端口 5173)
│
├── lib/training/          # 训练核心代码
│   ├── gsv_code/          # 从 GPT-SoVITS 解耦的训练代码
│   │   ├── s1_train.py    # S1 (GPT) 训练入口
│   │   ├── s2_train.py    # S2 (SoVITS) 训练入口
│   │   ├── configs/       # 训练配置模板
│   │   │   ├── s1longer.yaml
│   │   │   └── s2.json
│   │   ├── module/        # S2 模型定义
│   │   ├── AR/            # S1 模型定义
│   │   ├── text/          # 文本处理 / phoneme
│   │   └── utils.py       # 工具函数
│   │
│   ├── gsv-tools/         # 预训练模型 & 工具
│   │   ├── pretrained/    # 预训练权重
│   │   │   ├── gsv-v2final/       # S1 预训练
│   │   │   ├── v2Pro/             # S2 预训练 (G + D)
│   │   │   ├── cnhubert/          # Hubert 特征提取
│   │   │   ├── chinese-roberta-wwm-ext-large/  # BERT
│   │   │   └── bigvgan/           # 声码器
│   │   └── asr/           # ASR 模型
│   │       └── models/faster-whisper-large-v3/
│   │
│   ├── steps/             # Pipeline 步骤脚本 (Node.js)
│   │   ├── train.js        # S1 + S2 训练编排
│   │   ├── train_s1.js     # S1 训练封装
│   │   ├── train_s2.js     # S2 训练封装
│   │   ├── preprocess.js   # 预处理
│   │   ├── asr.js          # 语音识别
│   │   ├── slice.js        # 语音切片
│   │   └── denoise.js      # 去人声
│   │
│   ├── pipeline.js         # Pipeline 编排器（状态机）
│   ├── config.js           # 训练配置加载
│   └── python_helper.js    # Python 路径解析
│
├── assets/                # 角色资产
│   └── {voiceId}/         # 每个角色一个目录
│       ├── meta.json      # 角色元数据
│       ├── segments.json  # ASR 结果
│       ├── 4-cnhubert/    # Hubert 特征 (.pt)
│       ├── 5-wav32k/      # 32kHz 音频
│       ├── 6-name2semantic.tsv  # Semantic tokens
│       ├── logs_s1/       # S1 训练输出
│       └── logs_s2/       # S2 训练输出
│
├── docs/                  # 文档
│   ├── TRAINING_PIPELINE.md
│   └── reports/
│
├── scripts/               # 归档的开发脚本（不参与运行）
│   ├── dev/               # 调试脚本
│   ├── test/              # 测试脚本
│   └── pipeline/          # Pipeline 运行脚本
│
├── logs/                  # 归档日志
└── output/                # 归档输出
```

## 环境要求

- **OS**: Windows 10/11
- **GPU**: NVIDIA RTX 3070 (8GB VRAM) 或更高
- **Python**: 3.11 (uv 管理)
- **Node.js**: 18+
- **CUDA**: 12.1+

## 快速开始

有两种使用方式：**分发包部署**（推荐给使用者）和 **开发模式**（改代码用）。

### A. 分发包部署（解压即用）

1. 解压分发包到**纯英文、无空格**的路径（如 `D:\TTS-Broker-1`；避免中文/特殊字符路径）。
2. 双击 `deploy.bat` 运行首次部署向导：自动用内嵌 Python 建 `venv\`、装依赖、装 PyTorch(CUDA12.1)、
   引导下载模型（约 9GB，需联网）并自检。
3. 部署完成后，双击 `start.ps1`（或 `启动.bat`）启动。

> 说明：模型不随分发包内置，由部署向导下载。首次部署需要联网。

### B. 开发模式

```bash
# Python 依赖（推荐 uv，回退 pip）
uv pip install -r requirements.txt

# Node.js 依赖
npm install

# 配置环境变量
cp .env.example .env    # 编辑 .env 设置 API keys 等

# 启动
start.bat
```

后端运行在 `http://127.0.0.1:9886`，前端 `http://127.0.0.1:5173`，
推理服务 `http://127.0.0.1:9880`（由 `start.ps1` 拉起，日志见 `logs/inference.log`）。

## 训练 Pipeline

### 数据流

```
原始音频 → [去人声] → [切片] → [ASR] → [预处理] → [S1训练] → [S2训练] → 模型
```

### 目录约定

每个角色在 `assets/{voiceId}/` 下有以下结构：

| 文件/目录 | 说明 | 来源 |
|-----------|------|------|
| `segments.json` | ASR 结果 | step3 asr.js |
| `2-name2text.txt` | 音素序列 | step4 preprocess.js |
| `4-cnhubert/` | Hubert 特征 (.pt) | step4 preprocess.js |
| `5-wav32k/` | 32kHz 音频 | step4 preprocess.js |
| `6-name2semantic.tsv` | Semantic tokens | step4 preprocess.js |
| `logs_s1/{voiceId}/` | S1 训练输出 | step5 train.js |
| `logs_s2/{voiceId}/` | S2 训练输出 | step5 train.js |

### 训练配置

训练参数在 `training_defaults.json` 中配置：

```json
{
  "gpt_epochs": 10,
  "sovits_epochs": 10,
  "batch_size": 4
}
```

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/train/start` | 启动训练 |
| GET | `/api/train/status/:id` | 查询状态 |
| POST | `/api/train/cancel/:id` | 取消训练 |
| GET | `/api/train/logs/:id` | 获取日志 |
| GET | `/api/train/tasks` | 获取所有任务 |

## 推理

### 完整推理链路（已实现）

自包含推理服务 `lib/inference/infer_server.py`（FastAPI，端口 9880，OpenAI 兼容）：

```
文本 → S1 (GPT) → semantic tokens → S2 (SoVITS) → 音频
```

由 `start.ps1` 随主服务一起拉起；前端「Generate」/「Compare Refs」页直接调用。
支持切换 GPT / SoVITS 权重、参考音频、逐词读音校准（`pron_overrides`）。

### S2 独立推理（调试用）

用预处理好的数据做 S2 独立推理：

```bash
python scripts/pipeline/infer_s2.py \
  --s2_ckpt assets/{voiceId}/logs_s2/{voiceId}/44k/logs_s2_v3/G_*.pth \
  --work_dir assets/{voiceId}/ \
  --output output.wav \
  --idx 0
```

## 模型文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `pretrained/gsv-v2final/s1bert25hz-5kh-*.ckpt` | ~150MB | S1 预训练 |
| `pretrained/v2Pro/s2Gv2Pro.pth` | ~680MB | S2 Generator 预训练 |
| `pretrained/v2Pro/s2Dv2Pro.pth` | ~550MB | S2 Discriminator 预训练 |
| `pretrained/cnhubert/` | ~300MB | Hubert 特征提取 |
| `asr/models/faster-whisper-large-v3-turbo/` | ~1.6GB | ASR 模型 |

## 已知限制

1. **GPU 内存**: RTX 3070 8GB 下 S2 batch_size 最大为 4
2. **S2 训练数据格式**: 需要 `2-name2text-0.txt`（tab 分隔 4 列）
3. **安装路径**: 必须解压到纯英文、无空格路径；中文/特殊字符路径会导致嵌入式 Python 无法定位
4. **原生库加载顺序**: 部分 Windows 机器上 `torch` 先于 `librosa` 导入会触发原生崩溃
   （0xC0000005 / 退出码 3221225477，日志为空）；已在所有入口强制 librosa 先行修复

## 更新日志

### 2026-07-14 —— 分发化大更新
- ✅ 完整 S1+S2 推理链路上线（自包含 `infer_server.py`，OpenAI 兼容，端口 9880）
- ✅ 解压即用分发包：内嵌可重定位 Python + `deploy.bat` 首次部署向导（venv/依赖/PyTorch/模型/自检）
- ✅ 项目相对路径解析 + venv 自愈重建；纯英文路径守卫；`.ps1` UTF-8 BOM、`.bat` ASCII 化
- ✅ 系统性修复 torch-before-librosa 原生崩溃：s2_train、2-get-hubert、uvr5/webui、
  infer_server、TTS 五处入口统一 librosa 先行（附静态审计工具 `import_order_audit.py`）
- ✅ 支持 uv 并行安装加速依赖部署；离线 wheel 优先
- ✅ 读音校准（pron_overrides）逐词覆盖 + 推理透传

### 2026-06-20
- ✅ S1 训练跑通（6 epochs）
- ✅ S2 训练跑通（2/10 epochs）
- ✅ S2 推理跑通（生成 5.12s 音频）
- ✅ 修复 train.js S2 配置缺失字段
- ✅ 整理根目录临时文件（141 个文件归档）
