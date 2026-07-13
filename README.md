# TTS Broker

基于 GPT-SoVITS v2Pro 的 TTS 训练与推理工作流，解耦自 GPT-SoVITS 项目，**自包含、解压即用**。
面向最终用户以「GitHub Release 源码包」形式分发：预构建前端、内嵌 Python 3.11 + Node、
预编译轮子，**用户无需安装 Python / Node / C 编译器**。模型与 PyTorch 不随包分发，由部署向导引导下载。

---

## 两种使用方式

### A. 最终用户（拿到 Release 压缩包）

1. 解压到任意目录。
2. 双击 **`首次部署.bat`** —— 自动建 venv → 装依赖 → 装 PyTorch(CUDA 12.1)→ 引导下载模型(~9GB)→ 自检。
3. 双击 **`启动.bat`** —— 浏览器自动打开 `http://127.0.0.1:9886`。
4. 双击 **`停止.bat`** 结束后台服务。

零 Python、零 Node、零编译器。详见随包的 `README_用户版.txt`。

### B. 开发者（从源码运行 / 打包发布）

```bat
:: 拉运行时 → 建前端/根依赖 → 造轮子(需 VS BuildTools) → 打包
tools\build\00_build_all.bat --version 1.0.0
```
产物在 `dist\TTS-Broker-<版本>-win-x64-*.zip`，上传 GitHub Release。
详见 `docs\打包发布指南.md` 与 `docs\分发架构说明.md`。

---

## 项目结构

```
tts_broker_openai_compat/
├── 首次部署.bat / 启动.bat / 停止.bat   # 用户入口（薄封装，转调 tools\scripts）
├── README_用户版.txt                    # 最终用户说明
├── server.js                            # Express 后端 (端口 9886，同时托管前端 web/dist)
├── requirements.txt                     # Python 依赖 (torch/torchvision 已注释，单独装)
├── package.json / package-lock.json     # Node.js 依赖
├── .env.example                         # 环境变量模板
├── *.json                               # 业务配置 (app-config / training_defaults / voices ...)
│
├── web/                    # 前端 (Vite + React)；发布时预构建为 web/dist，由后端托管
│   └── dist/               # 预构建产物（随包分发，用户无需 build）
│
├── lib/
│   ├── training/           # 训练核心
│   │   ├── gsv_code/       # 从 GPT-SoVITS 解耦的训练代码 (s1_train / s2_train / AR / module / text)
│   │   ├── gsv-tools/      # 预训练权重 & 工具 (pretrained / asr / uvr5)  ← 模型不随包，用户下载
│   │   └── steps/          # Pipeline 步骤 (train / preprocess / asr / slice / denoise .js)
│   └── inference/          # 推理服务 (infer_server.py，端口 9880；sr/ 音频超分可选)
│
├── tools/                  # 所有脚本/工具/运行时都在这，保持根目录整洁
│   ├── runtime/
│   │   ├── python/         # 内嵌 CPython 3.11.9 (python-build-standalone，可建 venv)
│   │   └── node/           # 便携 Node 20.17.0 (跑 server.js)
│   ├── wheels/             # 预编译轮子: jieba_fast==0.53, pyopenjtalk==0.4.1 (cp311)
│   ├── deploy/             # 部署/运维脚本
│   │   ├── bootstrap.ps1           # 首次部署主逻辑
│   │   ├── install_torch.ps1 / 安装PyTorch.bat   # 单独装 torch (可重复运行)
│   │   ├── download_models.py      # 模型下载/体检向导 (不含模型本体)
│   │   └── download_ffmpeg.py      # ffmpeg 二进制 (可选，仅人声分离需要)
│   ├── scripts/            # 启停 + 开发者工具
│   │   ├── start.ps1 / stop.ps1
│   │   ├── dump_tree.ps1           # 导出目录结构
│   │   └── 清理根目录.bat          # 清理历史残留
│   └── build/              # 开发者打包 00~04 (用户用不到)
│
├── assets/                 # 角色资产 (每个 voiceId 一个目录，用户数据，不随包)
├── docs/                   # 文档
└── vendor/ffmpeg/          # ffmpeg 二进制 (可选，不随包；download_ffmpeg.py 按需下载)
```

---

## 环境要求

### 最终用户
- **OS**: Windows 10 / 11 (64 位)
- **GPU**: NVIDIA，显存 ≥ 8GB (如 RTX 3070)；驱动需支持 **CUDA 12.1**
- **Python / Node**: 无需自装（已内嵌）
- 首次部署需联网（下载 PyTorch 与模型，约 10GB 流量）

### 开发者（打包发布）
- 上述环境，外加 **Visual Studio Build Tools**（含「使用 C++ 的桌面开发」+ CMake），
  用于把 `jieba_fast` / `pyopenjtalk` 编译成 cp311 轮子。

---

## 依赖与运行时说明

| 项 | 版本 / 来源 | 说明 |
|---|---|---|
| 内嵌 Python | 3.11.9 (python-build-standalone) | 建 venv，与轮子 ABI 对齐 |
| 内嵌 Node | 20.17.0 (portable) | 跑 `server.js` |
| PyTorch | torch/torchaudio 2.2.0 + torchvision 0.17.0，`whl/cu121` | 不进包，`install_torch.ps1` 单独装 |
| 预编译轮子 | jieba_fast==0.53, pyopenjtalk==0.4.1 | 放 `tools\wheels`，用户离线装免编译 |
| ffmpeg 二进制 | 按需 | 仅「人声分离 / UVR5」需要；`download_ffmpeg.py` 下载 |
| `ffmpeg-python` / `ffmpy` | pip 依赖 | Python 封装，随 requirements 安装 |

> torch 单独装：`tools\deploy\安装PyTorch.bat`，或
> `powershell -File tools\deploy\install_torch.ps1 -Cuda cu118`（切 CUDA 版本）/ `-Cpu`（CPU 版）。

---

## 模型下载

模型不随包分发（约 9GB），由向导下载到项目内真实路径：

```bat
venv\Scripts\python.exe tools\deploy\download_models.py --wizard   :: 交互式菜单
venv\Scripts\python.exe tools\deploy\download_models.py --check    :: 只体检
venv\Scripts\python.exe tools\deploy\download_models.py --set core,asr
```

| 组 | 内容 | 目标目录 |
|---|---|---|
| core | gsv / v2Pro / sv / hubert / roberta / bigvgan | `lib\training\gsv-tools\pretrained\` |
| asr | faster-whisper-large-v3 | `...\asr\models\faster-whisper-large-v3\` |
| uvr5 | HP2_all_vocals | `...\uvr5\uvr5_weights\` |
| g2pw | g2pW.onnx | `GPT_SoVITS\text\G2PWModel\`(+ gsv_code 副本) |
| langdetect | lid.176.bin | `...\pretrained\fast_langdetect\`(+ gsv_code 副本) |
| sr | 24k→48k 音频超分 (可选) | `lib\inference\sr\AP_BWE_main\24kto48k\` |

国内网络可在向导里切换 `hf-mirror` 镜像加速。

---

## 训练 Pipeline

### 数据流
```
原始音频 → [去人声(可选)] → [切片] → [ASR] → [预处理] → [S1训练] → [S2训练] → 模型
```
> 若素材本身已是干净人声，通常无需「去人声」，也就无需 ffmpeg。

### 角色目录约定（`assets/{voiceId}/`）

| 文件/目录 | 说明 | 来源 |
|---|---|---|
| `segments.json` | ASR 结果 | asr.js |
| `2-name2text.txt` | 音素序列 | preprocess.js |
| `4-cnhubert/` | Hubert 特征 (.pt) | preprocess.js |
| `5-wav32k/` | 32kHz 音频 | preprocess.js |
| `6-name2semantic.tsv` | Semantic tokens | preprocess.js |
| `logs_s1/{voiceId}/` | S1 训练输出 | train.js |
| `logs_s2/{voiceId}/` | S2 训练输出 | train.js |

### 训练配置（`training_defaults.json`）
```json
{ "gpt_epochs": 10, "sovits_epochs": 10, "batch_size": 4 }
```

### API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/train/start` | 启动训练 |
| GET | `/api/train/status/:id` | 查询状态 |
| POST | `/api/train/cancel/:id` | 取消训练 |
| GET | `/api/train/logs/:id` | 获取日志 |
| GET | `/api/train/tasks` | 获取所有任务 |

---

## 运行期端口 / 进程

- 后端 `server.js` : `127.0.0.1:9886`（UI 与 API 同在此，托管预构建的 `web/dist`）
- 推理引擎 `lib/inference/infer_server.py` : `127.0.0.1:9880`
- venv 布局：`venv\Scripts\python.exe`（启停脚本依赖此路径）

---

## 常见问题

- **`启动.bat` 提示未检测到 venv** → 先运行 `首次部署.bat`。
- **`torch.cuda.is_available()` = False** → 更新 NVIDIA 驱动到支持 CUDA 12.1 的版本，或用
  `install_torch.ps1 -Cuda cu118` 换匹配的 CUDA 构建。
- **UVR5 报 `No module named 'ffmpeg'`** → `ffmpeg-python` 已在 requirements；若报缺 ffmpeg **二进制**，
  跑 `python tools\deploy\download_ffmpeg.py`。
- **端口被占用** → 后端 9886 / 引擎 9880，先运行 `停止.bat` 再启动。
- **根目录混入历史脚本** → 开发者可运行 `tools\scripts\清理根目录.bat`（先列清单、二次确认再删）。

---

## 已知限制

1. **GPU 内存**: RTX 3070 8GB 下 S2 `batch_size` 最大约 4。
2. **S2 训练数据格式**: 需要 `2-name2text-0.txt`（tab 分隔 4 列）。
3. **推理链路**: S1+S2 完整串联的边界场景仍在完善。
4. **模型来源**: `download_models.py` 中部分直链（如 g2pw / sr 镜像）建议发布前用 `--check` 验证。

---

## 更新日志

### 2026-07（分发化）
- ✅ 改造为「解压即用」源码包：内嵌 Python 3.11 + 便携 Node + 预构建 `web/dist`。
- ✅ `jieba_fast` / `pyopenjtalk` 预编译轮子，用户免编译器。
- ✅ 部署/运维脚本收纳进 `tools\deploy`；torch 单独安装脚本；ffmpeg 改为可选。
- ✅ 根目录精简为「3 个入口 .bat + README + 业务源码」。

### 2026-06-20
- ✅ S1 训练跑通（6 epochs）、S2 训练跑通、S2 推理跑通（生成 5.12s 音频）。
- ✅ 修复 train.js S2 配置缺失字段；整理根目录临时文件。
