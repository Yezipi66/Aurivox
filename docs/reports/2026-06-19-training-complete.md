# 2026-06-19 Training Pipeline 完整实现报告

## 完成内容

### 1. 去除外部依赖
- 复制 GPT-SoVITS 训练工具到项目 `lib/training/gsv-tools/`
- 代码文件（.py 脚本）→ git track
- 模型文件（.pth, .ckpt）→ 加入 .gitignore（4.1GB，不入库）
- 配置文件 `lib/training/model_paths.json` 指向项目内路径
- 步骤脚本重写，调用项目内的 Python 脚本

### 2. 复制的代码文件
- `gsv-tools/uvr5/` — 去人声工具（webui.py, bsroformer.py, mdxnet.py, vr.py + 子目录）
- `gsv-tools/slicer2.py` — 语音切片
- `gsv-tools/slice_audio.py` — 音频切片辅助
- `gsv-tools/asr/fasterwhisper_asr.py` — 语音识别
- `gsv-tools/asr/config.py` — ASR 配置
- `gsv-tools/s1_train.py` — GPT 训练脚本
- `gsv-tools/s2_train.py` — SoVITS 训练脚本

### 3. 复制的模型文件（.gitignore）
- `gsv-tools/pretrained/v2Pro/` — V2 Pro 模型（s2Gv2Pro.pth, s2Gv2ProPlus.pth, s2Dv2Pro.pth, s2Dv2ProPlus.pth）
- `gsv-tools/pretrained/gsv-v2final/` — S1 预训练模型
- `gsv-tools/pretrained/chinese-hubert-base/` — BERT 特征
- `gsv-tools/pretrained/chinese-roberta-wwm-ext-large/` — BERT 特征
- `gsv-tools/pretrained/fast_langdetect/` — 语言检测
- `gsv-tools/pretrained/bigvgan/` — 声码器
- `gsv-tools/uvr5/uvr5_weights/` — UVR5 模型权重
- `gsv-tools/asr/faster-whisper-large-v3-turbo/` — ASR 模型

### 4. 重写的步骤脚本
- `steps/denoise.js` — 调用 UVR5 webui.py
- `steps/slice.js` — 调用 slicer2.py（逐文件处理）
- `steps/asr.js` — 调用 fasterwhisper_asr.py（逐文件识别）
- `steps/preprocess.js` — 生成 meta.json
- `steps/train.js` — 调用 s1_train.py + s2_train.py（占位）

### 5. 配置文件
- `training_defaults.json` — 默认训练参数
- `model_paths.json` — 模型文件路径配置
- `.gitignore` — 排除大模型文件

## 已知问题
- 步骤脚本中的 Python 调用尚未实际测试（需要 Python 环境 + 依赖）
- 训练步骤（s1, s2）仍是占位实现
- 需要验证 UVR5 webui.py 的命令行参数是否正确
- 需要验证 fasterwhisper_asr.py 的命令行参数是否正确

## 下一步
- 测试 Python 环境是否可用
- 验证 UVR5 命令行调用
- 验证 slicer2.py 命令行调用
- 验证 fasterwhisper_asr.py 命令行调用
- 实现 s1_train.py + s2_train.py 的实际调用
- 实现训练完成后的 autoRegisterVoice
