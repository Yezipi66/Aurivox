# TTS Broker — 项目状态

> 最后更新：2026-06-24
> HEAD commit: 6ff0d21

## 项目目标

**TTS Broker** 是一个自包含的 TTS 训练/推理/分发工作台，完全解耦自 GPT-SoVITS。

核心定位：
- **一键式训练**：从原始音频到可部署模型，全流程自动化
- **多语言**：普通话、粤语（用达摩 ASR）、英语、日语、韩语（用 Faster Whisper large-v3）
- **自包含**：独立 venv，不依赖 GPT-SoVITS 运行时，可跨机器部署
- **Windows 优先**：RTX 3070 Laptop (8GB VRAM)，CUDA 13.2

完整链路：
```
原始音频 → 去人声 → 切片 → ASR → 预处理 → S1训练 → S2训练 → finalize → 推理 → 分发
```

## 架构概览

```
tts_broker_openai_compat/
├── server.js              # Express :9886 (API + 静态文件)
├── web/                   # React + Vite :5173
│   └── src/App.jsx        # 训练管理页面
├── lib/training/
│   ├── pipeline.js        # Pipeline 状态机 (Node.js)
│   ├── steps/             # 各步骤 Node.js 封装
│   │   ├── preprocess.js  # 1-get-text + 2-get-hubert + 3-get-semantic
│   │   ├── train.js       # S1 + S2 训练编排
│   │   ├── finalize.js    # 资产整合 + meta.json 生成
│   │   ├── asr.js         # ASR 路由
│   │   └── slice.js       # 语音切片
│   ├── gsv_code/          # 从 GPT-SoVITS 解耦的训练代码
│   └── gsv-tools/         # 预训练模型 & ASR 模型
├── assets/{voiceId}/      # 角色资产
└── .staging/{taskId}/     # 训练暂存目录
```

## 已完成功能

### Pipeline 步骤
| 步骤 | 状态 | 说明 |
|------|------|------|
| 1. 去人声 (denoise) | ✅ | UVR5 |
| 2. 切片 (slice) | ✅ | Silero-VAD（已修复取消+实时输出） |
| 3. ASR | ✅ | 中文→达摩 / 其他→Faster Whisper |
| 4. 预处理 (preprocess) | ✅ | BERT + CNHubert + wav32k + semantic |
| 5. S1 训练 | ✅ | GPT-SoVITS S1 |
| 6. S2 训练 | ✅ | GPT-SoVITS SoVITS v2Pro |
| 7. Finalize | ✅ | 资产整合 + meta.json + 清理 |
| 8. 推理 (infer) | ✅ | S2 独立推理 (S1→S2 串联待完善) |

### 前端
| 页面 | 状态 |
|------|------|
| 训练页面 | ✅ 基础功能完成 |
| 推理页面 | ⏳ 待完善 |

### 基础设施
| 功能 | 状态 |
|------|------|
| 任务状态持久化 | ✅ task.json 每步写入 |
| 断电恢复 | ✅ 从 staging 恢复 |
| 日志流 | ✅ SSE 实时推送 |
| 模型选择 | ✅ pickBestCkpt 按 steps 排序 |

## 当前已知问题

### 🔴 阻塞性
（无当前阻塞项）

### 🟡 待修复
1. **S1→S2 串联推理** — 目前推理只能跑 S2（需预先生成 semantic tokens），完整 "文本→S1→S2→音频" 链路未打通。
2. **粤语 ASR** — 达摩模型尚未接入，目前中文走 FunASR（普通话优化），粤语效果待验证。
3. **前端训练页面** — 基础流程 OK，但高级设置（epochs 调整、语言选择）待完善。
4. **G2PWModel 回退路径（兼容性过渡）** — `preprocess.js` 和 `chinese2.py` 当前优先自包含目录 (`gsv_code/text/G2PWModel`)，但如果该目录无 `g2pW.onnx` 则回退到外部 `GPT_SoVITS/text/G2PWModel/`。这是兼容性过渡逻辑，后续 onnx 权重挪到自包含目录后应删除回退路径，完全自包含。

### 🟢 已知限制
5. **GPU 内存** — RTX 3070 8GB，S2 batch_size 最大 4
6. **S2 训练速度** — ~45s/epoch (S1)，S2 约 2-3min/epoch
7. **Windows mp.spawn** — S2 训练用 DDP，Windows 偶有兼容问题

## 下一步计划

1. **完善推理链路** — S1→S2 串联，支持文本直接输入
2. **粤语 ASR 接入** — 达摩模型集成
3. **前端完善** — 训练结果展示、推理页面
4. **G2PW onnx 权重迁移** — 将 `GPT_SoVITS/text/G2PWModel/g2pW.onnx` 挪到 `gsv_code/text/G2PWModel/`，然后删除回退路径代码，完全自包含
5. **一键打包部署** — 自动化打包脚本

## 已修复问题记录

### 2026-06-24
- **切片卡住 + 取消无响应**：slice.js 循环内无取消检查 + spawn_async 不输出实时日志。已修复：pipeline.js 暴露 isCancelled、slice.js 循环内检查+实时输出、spawn_async 支持 onStdout/onStderr 回调
- **python 路径解析少一层**：`python_helper.js` 从 `lib/training/` 只需 2 层 `..` 回到项目根（之前用了 3 层，超了）。导致 getPythonPath 返回错误路径，fallback 全局 Python
- **zh_normalization import 路径错误**：`from text.zh_normalization` 应为 `from gsv_code.text.zh_normalization`，解耦时遗漏
- **全局环境被污染**：因 python 路径错误导致全局 Python 被调用，所有包安装到全局 site-packages。已设为只读

## 语言支持矩阵

| 语言 | ASR | 预处理 | S1 | S2 | 推理 |
|------|-----|--------|----|----|------|
| 普通话 | ✅ 达摩/FunASR | ✅ | ✅ | ✅ | ✅ |
| 粤语 | ⏳ 达摩待接入 | ✅ | ✅ | ✅ | ✅ |
| 英语 | ✅ Faster Whisper | ✅ | ✅ | ✅ | ✅ |
| 日语 | ✅ Faster Whisper | ✅ | ✅ | ✅ | ✅ |
| 韩语 | ✅ Faster Whisper | ✅ | ✅ | ✅ | ✅ |

## 关键决策记录

- **Tab 分隔**：`2-name2text.txt` 用 Tab（不是 `|`），因为 S2 的 `data_utils.py` 读 Tab
- **路径推导**：所有 Python 脚本用 4 层 `dirname` 回到 project_root，不依赖 cwd
- **load_audio**：librosa 优先（header 检测），ffmpeg 兜底（处理无扩展名 WAV）
- **pickBestCkpt**：按 `steps` 降序选 checkpoint，不用 `list[length-1]`（字母序不对）
- **finalize 独立步骤**：不合并到 train.js，保持单职责
- **spawn_async 实时输出**：子进程 stdout/stderr 通过回调实时推送到日志，不再缓存到 close 才返回
- **取消信号传递**：pipeline.js 向步骤暴露 `isCancelled` 函数，步骤在循环内检查并 throw 中止
