# 2026-06-19 Training Pipeline 实现报告

## 上下文理解

### 项目状态
- TTS Broker 项目是一个 TTS 工作台（React + Vite + Express）
- 已完成 voices.json 解耦（Step 1-4）
- 已完成 shared ref selection（VoiceSidebar ↔ GenerateTab）
- 已归档快照：docs/snapshots/pre-training-pipeline.zip

### 设计决策
- 用户最小操作：导入音频文件夹 + 选择语言
- 可选项：去人声（默认关闭）、切片（默认开启）、ASR（默认开启）
- 默认参数存储在 training_defaults.json
- 参考 GPT-SoVITS v2pro 项目，但只关注 V2 Pro / V2 Pro Plus 新模型

### 参考项目分析（GPT-SoVITS-v2pro-20250604）

#### 训练流程
1. 去人声：tools/uvr5/ (bs_roformer + mdxnet)
2. 切片：tools/slicer2.py (静音检测切分)
3. ASR：tools/asr/ (faster-whisper / funasr)
4. 预处理：GPT_SoVITS/ 中的特征提取（BERT、音高等）
5. s1 训练：GPT_SoVITS/s1_train.py (Text2Semantic, PyTorch Lightning)
6. s2 训练：GPT_SoVITS/s2_train.py (SoVITS Generator + Discriminator, DDP)

#### 需要的预训练模型文件（V2 Pro / V2 Pro Plus）
| 文件 | 大小 | 用途 |
|------|------|------|
| v2Pro/s2Gv2Pro.pth | 155MB | SoVITS V2 Pro 生成器初始权重 |
| v2Pro/s2Gv2ProPlus.pth | 190MB | SoVITS V2 Pro Plus 生成器初始权重 |
| v2Pro/s2Dv2Pro.pth | 120MB | SoVITS V2 Pro 判别器初始权重 |
| v2Pro/s2Dv2ProPlus.pth | 120MB | SoVITS V2 Pro Plus 判别器初始权重 |
| gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt | 148MB | GPT S1 初始权重 |
| chinese-hubert-base/ | 180MB | BERT 特征提取 |
| chinese-roberta-wwm-ext-large/ | 620MB | BERT 特征提取 |
| fast_langdetect/ | 125MB | 语言检测 |
| models--nvidia--bigvgan_v2_24khz_100band_256x/ | 214MB | 声码器 |
| gsv-v4-pretrained/ | - | V4 预训练模型 |

#### 去人声模型（UVR5）
| 文件 | 大小 | 用途 |
|------|------|------|
| HP2_all_vocals.pth | - | 人声分离 |
| HP5_only_main_vocal.pth | - | 仅主人声 |
| model_bs_roformer_ep_317_sdr_12.9755.ckpt | - | BS Roformer |

#### ASR 模型
| 文件 | 大小 | 用途 |
|------|------|------|
| faster-whisper-large-v3-turbo/ | - | 语音识别 |

### 实现计划

#### Phase 1: 后端 Pipeline API
1. lib/training/pipeline.js — Pipeline 编排器（状态机 + 步骤调度）
2. lib/training/step1_denoise.js — 去人声（调用 UVR5 Python）
3. lib/training/step2_slice.js — 切片（调用 slicer2.py）
4. lib/training/step3_asr.js — ASR（调用 faster-whisper）
5. lib/training/step4_preprocess.js — 预处理（BERT 特征、音高）
6. lib/training/step5_train.js — 训练（s1 + s2）
7. server.js 新增路由：POST /api/train/start, GET /api/train/status/:id, POST /api/train/cancel/:id

#### Phase 2: 前端训练页面
1. 导航栏新增 "Train" 按钮
2. TrainingTab 组件：音频文件夹选择 + 语言选择 + 预处理选项
3. Pipeline 进度条：实时显示当前步骤和进度
4. 日志面板：实时展示训练日志

#### Phase 3: 模型文件准备
1. 复制 V2 Pro / V2 Pro Plus 预训练模型到项目
2. 复制 UVR5 去人声模型
3. 复制 ASR 模型
4. 更新 config 指向正确的模型路径
