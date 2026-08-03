# Aurivox

基于开源项目 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（RVC-Boss，v2 / v2Pro / v2ProPlus）
打造的 TTS 训练与推理一体化工作流：在其之上做工程化封装，自包含、可独立部署。
面向内部使用者提供「解压即用」的分发包：内嵌可重定位 Python，
一键部署脚本自动建 venv、装依赖、下载模型并自检。

- **训练**：去人声 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS) 全链路管线，带失败恢复。
- **推理**：内置 OpenAI 兼容的自包含推理服务（`lib/inference/infer_server.py`），完整 S1+S2 串联。
- **分发**：`deploy.bat`（首次部署向导）+ `start.ps1`（启动），无需手工配环境。

> 📖 **最终用户请先读 [`GUIDANCE.md`](./GUIDANCE.md)**（部署 / 启动 / 停止 + 常见问题 FAQ）。
> 本 README 面向开发与二次开发，收录目录导览、管线细节、API 与更新日志；
> 使用类疑问（ffmpeg、onnxruntime、CUDA 状态、FunASR 置信度、MDX-Net 爆显存、人声分离预设等）统一整理在 GUIDANCE 的 FAQ。

## 顶层目录导览

> 仅列稳定的顶层职责，避免随业务频繁变动而过时；细节以代码为准。

| 路径 | 职责 |
| --- | --- |
| `server.js` | Express 后端主入口（REST + 推理编排 + 资产/训练接口） |
| `web/` | 前端（Vite + React；`src/` 已模块化为 `lib/` + `components/{generate,train,compare,assets,broker}`） |
| `lib/training/` | 训练管线：`pipeline.js` 状态机 + `steps/`（denoise/slice/asr/preprocess/train_s1/train_s2）+ 解耦的 `gsv_code/` + `gsv-tools/`（预训练权重与 ASR 模型） |
| `lib/inference/` | 自包含推理服务（`infer_server.py` OpenAI 兼容 + `TTS.py` 引擎） |
| `assets/{voiceId}/` | 已发布角色资产（`meta.json` + 训练产物 + `logs_s1` / `logs_s2`） |
| `.staging/{taskId}/` | 训练任务工作区（`task.json` 运行日志 + 中间产物；发布成功后按需清理） |
| `docs/` · `scripts/` · `logs/` · `output/` | 文档 / 归档开发脚本（不参与运行）/ 归档日志与输出 |

## 环境要求

- **OS**: Windows 10/11
- **Python**: 3.11 (uv 管理)
- **Node.js**: 18+
- **CUDA**: 12.1+
- **GPU**: 支持 CUDA 的 NVIDIA 显卡即可（RTX 3050 / 3060 / 3070 均实测可部署，显存越大可用的 batch_size 越高）
- **ffmpeg**（可选，推荐）: 训练/推理默认用 soundfile 读音频（覆盖 wav/flac/ogg 等）；装了 ffmpeg 后作为兜底可解码 mp3/m4a/aac 等 soundfile 读不了的格式，能 best-effort 吃下更多素材。不装也能跑，只是这类格式会被跳过并计入统计。
- **onnxruntime**（由 `install_torch.ps1` 随 torch 一并安装）: **g2pW**（中文多音字消歧）与 **UVR5 MDX-Net**（`onnx_dereverb`）依赖它。安装脚本按**同一套 NVIDIA GPU 探测**选择:有 N 卡装 `onnxruntime-gpu`（CUDA EP），无 N 卡装 CPU 版 `onnxruntime`（只支持 N 卡,不支持 AMD/DirectML）。缺失时 MDX-Net 段会因 `No module named 'onnxruntime'` 直接失败，g2pW 则回退 pypinyin。
  > ⚠️ **版本必须与 torch 的 CUDA/cuDNN 对齐**：GPU 版**锁定 `onnxruntime-gpu==1.18.0`**（CUDA 12 + cuDNN 8，匹配随包 torch cu121）。`1.19+` 改用 cuDNN 9，会让 `CUDAExecutionProvider` **静默失效**、MDX-Net 悄悄退回 CPU（不报错、只是极慢）。因 `mdxnet.py` 先 `import torch` 再 `import onnxruntime`，torch 会把自带 cuDNN 8 目录注册进 DLL 搜索路径，onnxruntime 得以复用——无需额外配置 CUDA。验证：`python -c "import torch; import onnxruntime as ort; print(ort.get_available_providers())"` 应包含 `CUDAExecutionProvider`。

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
# Python 依赖：直接按冻结锁精确复现（torch + onnxruntime 见 install_torch.ps1）
pip install --no-deps -r requirements.txt
# 改完依赖后，在这台开发机重新冻结并提交 requirements.txt：
#   pip freeze > requirements.txt
#   然后把 freeze 出来的 torch / torchaudio / torchvision 与 onnxruntime-gpu 这几行重新注释掉
#   （由 install_torch.ps1 单独装，会自动判断有无 NVIDIA GPU：有→cu121+onnxruntime-gpu，无→CPU 版+onnxruntime）

# Node.js 依赖
npm install

# 配置环境变量
cp .env.example .env    # 编辑 .env 设置 API keys 等

# 启动
start.bat
```

后端运行在 `http://127.0.0.1:9886`，前端 `http://127.0.0.1:5173`，
推理服务 `http://127.0.0.1:9880`（由 `start.ps1` 拉起，日志见 `logs/inference.log`）。

## 依赖锁定（完全可复现环境）

Python 依赖只有**一个** `requirements.txt` —— 一份**逐包精确 `==` pin 的完整 `pip freeze` 快照**（含全部传递依赖）。交付即开发机环境：在开发机上把 venv 调到能跑，`pip freeze` 出来什么，所有机器就用 `--no-deps` 装出**完全一致**的什么。**freeze 就是锁,没有第二个文件、没有生成器。**

> 注：早前那套 `requirements.in`（意图）+ `lock_requirements.py`（生成器）的 pip-tools 风格双文件已**退役**。它把上游官方 repo 的 `--no-binary=opencc` 抄了进来，强制 OpenCC 源码编译，在没有 C/C++ 工具链的纯净交付机上直接失败（我们交付给最终小白用户，环境必须写死、零编译）。

- **安装**：`deploy.bat` / `bootstrap.ps1` 用 `uv pip install --no-deps -r requirements.txt`（失败回退 `pip --no-deps`）——**不跑求解器**，逐包按 pin 精确装,避免复现时被解析器悄悄升/降级,也避免纸面假冲突（如 `accelerate 1.14` 声明要 `torch>2.2` vs 锁死的 `torch==2.2.0+cu121`）。`torch/torchaudio/torchvision` **与 `onnxruntime`** 体积大且 GPU 专属，一并由 `install_torch.ps1` 单独 `--no-deps` 安装（同一套 NVIDIA 探测:有 N 卡→cu121+`onnxruntime-gpu`,无→CPU 版+`onnxruntime`;只支持 N 卡，不支持 AMD/DirectML）。
- **改依赖**：在**开发机**上直接 `pip install ...` 把 venv 调到能跑 → 重新冻结覆盖：

  ```bat
  venv\Scripts\python.exe -m pip freeze > requirements.txt
  ```

  然后**手动处理 `pip freeze` 会顺手带进来、但不该进锁的东西**：
  1. 把 freeze 出来的 `torch` / `torchaudio` / `torchvision` **与 `onnxruntime-gpu`** 这几行**重新注释掉**——它们体积大、GPU 专属，由 `install_torch.ps1` 单独 `--no-deps` 安装（同一套 NVIDIA 探测:有 N 卡→cu121+`onnxruntime-gpu`,无→CPU 版+`onnxruntime`）。写死进锁会架空这个判断,把没显卡的机器硬塞进 GPU 包。因此锁里也**不需要** `--extra-index-url .../cu121`（那是 torch 唯一的用途，已随 torch 一起移出）；
  2. `onnxruntime` 的版本 pin（`==1.18.0`,cuDNN 8;别漂到 1.19+，那会改用 cuDNN 9 并静默关掉 CUDA ExecutionProvider）现由 `install_torch.ps1` 的 `-Ort` 参数默认值持有；requirements.txt 顶部保留一条注释说明即可。
  - freeze 忠实反映当前 venv:传递依赖一个不少（否则 `--no-deps` 安装会缺包）。**提交这份 `requirements.txt`**。

> ⚠️ 因为安装用 `--no-deps`，`requirements.txt` **必须**是完整 freeze——否则传递依赖会缺失。改依赖 = 在开发机装好后 `pip freeze` 重新覆盖，**不要手工逐行编辑** pin。
> ⚠️ 别再往 `requirements.txt` 里加 `--no-binary=...` 这类会触发源码编译的选项。需要编译的包（`jieba_fast` / `pyopenjtalk` 等）一律预编译成 wheel 放 `tools\wheels`,让交付机零编译器也能装。

## 训练 Pipeline

### 数据流

```
原始音频 → [去人声] → [切片] → [ASR] → [预处理] → [S1训练] → [S2训练] → 模型
```

### 目录约定

发布（入库）后每个角色在 `assets/{voiceId}/` 下有以下结构：

| 文件/目录 | 说明 |
|-----------|------|
| `meta.json` | 资产元数据（`display_name` / 不可变 id / 语言 / assets 索引）|
| `segments.json` | 参考片段索引 |
| `raw/` | 训练用 raw 音频（启用人声提取时=**分离后的人声**；否则=原始输入）|
| `raw_b4_extraction/` | 提取前的原始混音（仅启用人声提取且保留原始时生成，供审计/重构）|
| `slicer_opt/` | 切片音频 |
| `asr_opt/` | ASR 结果 |
| `gpt_checkpoints/` | GPT (S1) 模型 |
| `sovits_models/` | SoVITS (S2) 模型 |
| `references/` | 参考音频 |

> 注：`2-name2text.txt`、`4-cnhubert/`、`5-wav32k/`、`6-name2semantic.tsv`、`logs_s1/`、`logs_s2/`
> 等是**训练过程中的中间产物**，位于训练工作区（staging），发布后即被清理，不属于入库约定。

> 🎙️ **人声提取的 raw 语义**：启用人声分离后，**分离出的人声**才是喂给切片 → ASR → 训练的「训练用 raw」，
> 因此发布到资产时 **`raw/` = 分离后的人声**，而**提取前的原始混音**归档到 **`raw_b4_extraction/`**（便于审计/
> 重构/换参重跑）。未启用人声分离时 `raw/` 仍是原始输入（行为不变）。提取前原始的保留由「人声提取」面板的
> **「保留提取前的原始音频」**复选框控制（默认开），命令行也可用 `UVR5_KEEP_RAW=0` 跳过。工作区侧先在
> `.staging/{taskId}/raw_b4_extraction/` 快照，收尾时随 `raw/` 转入资产；改人声参数重跑该快照随 `denoise/` 一并重建。

### 训练配置

新建任务的内置默认值在 `lib/training/config.js`（**非对称**：S1 早停防过拟合、S2 更久收敛）：

```json
{
  "gpt_epochs": 8,
  "sovits_epochs": 25,
  "s1_save_every_n_epoch": 4,
  "s2_save_every_n_epoch": 5,
  "batch_size": 4
}
```

> 保存间隔取 S1=4 / S2=5，保证最终 epoch（8%4=0、25%5=0）必落 checkpoint。
> 若存在外部 `training_defaults.json`，其值覆盖内置默认；仅影响变更后新建的任务，已有 recipe/历史任务不追溯改写。

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

### 原生底模零样本推理（免微调）

无需先微调即可直接用预训练底模推理。项目内置一个**保留的虚拟音色 `Base model`**
（id `__base__`，内存态、不落 `voices.json`、无资产目录）：**出现在 Generate 的 Voice
下拉里并默认选中，但不出现在 Assets 管理页**。GPT 固定 `Base model_s1`，SoVITS 三选
`Base model_v2 / _v2Pro(默认) / _v2ProPlus`（磁盘缺失的版本自动从下拉剔除）。语言为
Auto（自动多语言）。底模自身无参考音频，勾选「Use reference from another voice」即可
借用其它资产的切片 / raw 作参考。**Compare Refs** 每行的 VOICE ID 下拉也可选 `Base model`。

### S2 独立推理（调试用）

用预处理好的数据做 S2 独立推理：

```bash
python scripts/pipeline/infer_s2.py \
  --s2_ckpt assets/{voiceId}/logs_s2/{voiceId}/44k/logs_s2_v3/G_*.pth \
  --work_dir assets/{voiceId}/ \
  --output output.wav \
  --idx 0
```

### Broker 并发 / 流式 / 模型留驻（v1.0.6）

面向 recipe 分发场景的三项 broker 能力。**引擎推理仍是单卡串行**（`_generationMutex` +
引擎 `_model_lock`，`uvicorn workers=1`），本组改造是在此约束下把「单请求更快 + 过载不雪崩 +
换参考音频免重载」做到位，而**不引入双引擎**（终端用户硬件不一，双份显存不现实）。

- **流式传输（OpenAI 兼容）**：`POST /v1/audio/speech`，`"stream": true`。分块边合边回，
  **默认不落盘**（`persist` 缺省 false）；需归档时显式传 `"persist": true`，broker 会一边回流
  一边 tee 存档并写 meta。**流式仅支持 `wav` / `ogg`**（`mp3` 等需整段转码，不走流式）。
  上游错误收敛为 502；客户端断开即 abort 上游。
  ```bash
  curl -N http://127.0.0.1:9886/v1/audio/speech \
    -H "Content-Type: application/json" \
    -d '{"model":"<recipe>","input":"你好，这是一段流式示例。","response_format":"wav","stream":true}' \
    --output out.wav
  ```

- **请求内并行（A-1）**：单个请求里被 split 出的多段文本**打包并行推理**（引擎的
  `parallel_infer` / `split_bucket` 默认已开），只压**单请求时延**、不加显存基线。
  由 `batch_size` 控制，**默认 4**（原为 1）。旋钮 `AURIVOX_TTS_BATCH_SIZE`（范围 1–16）：
  低显存长文本 OOM → 设 `1` 关闭；大显存可上调。recipe / 高级参数仍可逐次覆盖。

  > **并行发生在哪一层（重要）**：真正的批量并行发生在**单次 `/tts` 调用内**——引擎拿到
  > 整段文本后自己按 `text_split_method` 切成多 chunk、一次前向按 `batch_size` 并行。
  > `POST /v1/audio/speech`（Broker/OpenAI 端点）**整段一次性喂**给引擎，天然吃到这个并行。
  > 但前端 **Generate / Compare Refs** 走 `POST /api/generate`，**默认是 broker 先切段、逐段串行**
  > 发给引擎（保留分段文件），这几段之间**不并行**。若想让它们也并行，勾选
  > **Advanced Settings → `Engine Batch (parallel)` / 引擎批量并行**（`engine_batch:true`）：
  > 整段一次性交给引擎并行批量合成。**代价**：引擎内部拼接，**输出为单个音频、无分段文件**，
  > 且 Node 侧 `concat` / `silence_ms` 不再生效（由引擎 `fragment_interval` 控制间隔）。
  > 单实例引擎串行的本质不变——不要用并发调用去打同一个引擎（会污染模型内部状态）。
  > Compare Refs 有**总开关**（全部行），每行可三态覆盖（继承 / 开 / 关，默认继承）。

- **有界排队 / 过载保护（A-2）**：生成锁改为**有界队列**，排队请求超过上限时立即返回
  **HTTP 503**（body `code: generation_queue_full`）并带 **`Retry-After`** 头，避免无限堆积拖垮。
  `AURIVOX_MAX_QUEUE`（默认 32，`0`=不限＝旧行为）、`AURIVOX_RETRY_AFTER`（默认 3 秒）。

- **模型留驻（同模型换参考音频免重载）**：
  - **权重留驻**：`ModelSwitcher` 对**连续同音色**跳过 `/set_*_weights` 冗余重载（v1.0.4 起）。
  - **参考音频留驻（本版新增）**：`TTS.py` 内置**带戳参考音频 LRU**，缓存最近 N 个参考音频的
    `prompt_semantic / refer_spec`，命中即恢复、**零重抽零权重重载**。每条缓存戳上当时的
    SoVITS 权重路径 + `is_v2pro`（语义依赖 SoVITS 码本），**切 SoVITS 不清空整表**——不同常驻
    音色的参考音频可同时保持热，正是多音色 recipe 轮转想要的。容量 `AURIVOX_REF_CACHE`（默认 8，`0`=关）。

> 环境变量小抄：`AURIVOX_TTS_BATCH_SIZE=4` · `AURIVOX_MAX_QUEUE=32` · `AURIVOX_RETRY_AFTER=3` · `AURIVOX_REF_CACHE=8`。
> 详见 `BROKER_streaming_and_residency.md` 与最终用户向的 [`GUIDANCE.md` Q14](./GUIDANCE.md)。

## 模型文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `pretrained/gsv-v2final/s1bert25hz-5kh-*.ckpt` | ~150MB | S1 预训练 |
| `pretrained/v2Pro/s2Gv2Pro.pth` | ~680MB | S2 Generator 预训练 |
| `pretrained/v2Pro/s2Dv2Pro.pth` | ~550MB | S2 Discriminator 预训练 |
| `pretrained/cnhubert/` | ~300MB | Hubert 特征提取 |
| `asr/models/faster-whisper-large-v3-turbo/` | ~1.6GB | ASR 模型 |

## 已知限制

1. **S2 训练数据格式**: 需要 `2-name2text-0.txt`（tab 分隔 4 列）
2. **安装路径**: 必须解压到纯英文、无空格路径；中文/特殊字符路径会导致嵌入式 Python 无法定位
3. **原生库加载顺序**: 部分 Windows 机器上 `torch` 先于 `librosa` 导入会触发原生崩溃
   （0xC0000005 / 退出码 3221225477，日志为空）；已在所有入口强制 librosa 先行修复
4. **音频格式与声道**: 训练素材优先用 **wav（单声道最佳）**。加载层已统一把多声道自动下混为单声道，
   避免立体声导致 HuBERT 特征提取崩溃；无法读取的格式（视 libsndfile 版本，如部分 mp3/m4a/aac）会被跳过。
   每次预处理结束会打印一行 `[load_audio] total=.. loaded=.. (downmixed=.. resampled=.. via_ffmpeg=..) failed=..`
   统计，便于核对有效条数。装 ffmpeg 可兜底更多格式（见「环境要求」）。
5. **UVR5 MDX-Net 显存**: MDX-Net 是 UVR5 里最吃显存的模型，长音频 + 大 batch 极易 OOM
   （`cudaErrorMemoryAllocation`）。**默认参数按 4 GB 小显存设计（逐窗 batch=1）**；大显存显卡可自行调大分段/批。
   仍 OOM 时把 MDX 段切到 CPU（`UVR5_MDX_DEVICE=cpu`）。详见 [`GUIDANCE.md` Q10](./GUIDANCE.md)。
6. **Roformer 权重与配置配套**: Mel-Band / BS-Roformer 需 `.ckpt` 与其**配套 `.yaml`** 同名成对放入
   `uvr5_weights\`；缺配置时 loader 退回默认配置，会因结构不符报「missing params」而加载失败。见 [`GUIDANCE.md` Q11](./GUIDANCE.md)。
7. **FunASR 无置信度**: FunASR/Paraformer 为非自回归结构，默认不输出逐词后验，校对页置信度**如实留空、不着色**
   （非错误）；需置信度高亮请用 Faster Whisper。见 [`GUIDANCE.md` Q8](./GUIDANCE.md)。

## 更新日志

### 2026-08-03 —— v1.0.6：Broker 请求内并行（A-1）+ 有界排队过载保护（A-2）+ 参考音频留驻 LRU +（前端）引擎批量并行开关
> 以**补丁式（unified diff / `git apply`）**交付，见 `CHANGES-1.0.6.md`、`apply_patch.ps1` / `rollback_patch.ps1`（双击 `.bat` 可跑）。**单一合并补丁**共改 11 文件 +349/−14，`package.json 1.0.5→1.0.6`。**含 `web/` 前端改动，应用后必须重建前端**（`npm run build` 或 `tools\build\01_build_frontend`）再重启 `server.js` 与 infer_server。真正的多引擎并行（方案 B）**不做**——终端用户硬件不一、双份显存不现实。

- ✅ **A-1 请求内并行**：默认 `batch_size` **1→4**（`_DEFAULT_TTS_BATCH_SIZE`，同步改 `DEFAULT_ADVANCED_PARAMS` 与 `buildTtsPayload` 兜底）。把单请求内 split 出的多段文本打包并行推，压**单请求时延**、不加显存基线（`parallel_infer`/`split_bucket` 本就默认开）。旋钮 `AURIVOX_TTS_BATCH_SIZE`（1–16）；低显存长文本 OOM 逃生口设 `1`。
- ✅ **（前端）引擎批量并行开关 `engine_batch`**：**Generate** 与 **Compare Refs** 页 Advanced Settings 新增 **Engine Batch（引擎批量并行）** 勾选框。默认关＝旧行为（broker 切段、逐段串行、保留分段文件）；开＝整段一次性交给引擎并行批量合成（`lib/routes/synthesis.js` 走单次 `/tts`），**输出单个音频、无分段文件**。**Compare Refs 为总开关**，每行三态覆盖（继承/开/关，默认继承）。不用并发调用打同一引擎（会污染模型内部状态）。
- ✅ **A-2 有界排队 + 过载保护**：`lib/util/mutex.js` 的 `Mutex` 新增 `maxPending`，排队超上限即**同步抛** `GENERATION_QUEUE_FULL`；`withGenerationLock` 翻译成 **HTTP 503**（`code: generation_queue_full`）并带 **`Retry-After`** 头（`lib/http/http.js` 的 `HttpError` 支持自定义响应头）。两个合成入口自动受益。`AURIVOX_MAX_QUEUE`（默认 32，0=不限）、`AURIVOX_RETRY_AFTER`（默认 3）。
- ✅ **参考音频留驻 LRU（模型留驻补全）**：`lib/inference/TTS.py` 内置**带戳参考音频 LRU**（`self._ref_lru`），缓存 `prompt_semantic / refer_spec[0] / raw_audio / raw_sr`，命中零重抽零权重重载。每条缓存戳 `vits_weights_path + is_v2pro`（语义依赖 SoVITS 码本，戳不符即失效）；**切 SoVITS 不清空整表**，多常驻音色的参考音频可共存——针对多音色 recipe 轮转。容量 `AURIVOX_REF_CACHE`（默认 8，0=关，约数十 MB 显存）。顺修既有 bug：`init_vits_weights` 切完 SoVITS 后置空 live 主槽 `ref_audio_path`，防复用同一 ref 路径时用到旧权重下的陈旧语义。
- ✅ **文档**：README 新增「推理 · Broker 并发/流式/模型留驻」小节（含并行发生在哪一层的说明与前端 `engine_batch` 用法）并互链；`GUIDANCE.md` 增补 **Q14**（最终用户向：流式默认不落盘、请求内并行、前端引擎批量开关、模型留驻、四个环境变量小抄）；随包附 `BROKER_streaming_and_residency.md`。
- 📝 **流式补充说明（既有能力，本次补文档）**：`/v1/audio/speech` `stream:true` 端到端已实现，**默认不落盘**，`persist:true` 才 tee 存档；流式仅 `wav`/`ogg`；上游错收敛 502、客户端挂断即 abort。此前只是没在文档里讲清楚。

### 2026-08-02 —— 依赖工作流回归纯 freeze：退役 requirements.in + lock_requirements.py，移除 --no-binary=opencc
- 🐞 **根因**：交付机（纯净嵌入式 Python，无 VS Build Tools / Windows SDK）部署失败——`requirements.txt` 顶部的
  `--no-binary=opencc` 强制 OpenCC 源码编译，CMake 找不到 `rc.exe`（`RC: 0`）→ Configure failed。该行原本不在项目最初的
  纯 `pip freeze` 锁里,是后来引入 `requirements.in` 时**照抄上游官方 GPT-SoVITS repo** 带进来的（上游在有 gcc 的 Linux 上无害）。
- ✅ **退役自动化**：删除 `tools/deploy/lock_requirements.py` 与 `requirements.in`。Python 依赖回归**单一 `requirements.txt` = `pip freeze` 快照**，
  「开发机装好 → freeze → 所有机 `--no-deps` 精确复现」。交付最终小白用户,环境**写死、零编译**。
- ✅ **移除 `--no-binary=opencc`**：OpenCC 恢复走 PyPI 预编译 wheel,交付机不再需要 C/C++ 工具链。需编译的 `jieba_fast`/`pyopenjtalk`
  仍走 `tools\wheels` 预编译 wheel。
- ✅ **bootstrap.ps1**：移除「检测松散→提示跑 lock」软校验(不再引用已删的生成器)；移除 `--no-deps` 失败后**带 resolver 重试**那段
  （它只会暴露 `accelerate 1.14` 要 `torch>2.2` vs 锁死 `torch==2.2.0+cu121` 之类的纸面假冲突,误导排查）——改为直接报错并指向
  「最后失败的那个包」（多半是缺预编译 wheel）。
- 📝 **torch 三件套移出锁**：`torch` / `torchaudio` / `torchvision` 在 `requirements.txt` 里保持**注释**状态,由 `install_torch.ps1` 单独安装
  ——它会自动探测有无 NVIDIA GPU（`nvidia-smi` → WMI），有则装 cu121、无则回退 CPU 版。写死进锁会架空判断,把无显卡机器硬塞 cu121。
  故锁里也移除了 `--extra-index-url .../cu121`（torch 唯一用途）。
- 📝 **onnxruntime 也移出锁（同理）**：`onnxruntime-gpu==1.18.0` 之前按 CPU 架构（x86_64）无条件安装,导致**没有 N 卡 / 用 AMD 卡**的 x86 机器
  也被装上 GPU 版(白占体积、跑起来悄悄退回 CPU 且报 cuDNN DLL 警告)。现改为由 `install_torch.ps1` 用**同一套 GPU 探测**选择:有 N 卡→`onnxruntime-gpu==1.18.0`(CUDA EP,cuDNN 8),无→`onnxruntime==1.18.0`(CPU)。安装前先卸掉两个变体保证只留一个(两者提供同一 `onnxruntime` import,共存会冲突)。只支持 N 卡,**不支持 AMD/DirectML**。版本 pin 由脚本 `-Ort` 参数默认值(`1.18.0`)持有。
- 📌 freeze 后需重新注释掉的行:`torch` / `torchaudio` / `torchvision` / `onnxruntime-gpu`（共 4 行,均由 install_torch.ps1 装）。

### 2026-08-01 —— 修正 onnxruntime-gpu 锁版 1.18.1→1.18.0
- ✅ **onnxruntime-gpu 版本更正**：全项目（`requirements.in/.txt`、`lib/inference/requirements.txt`、`mdxnet.py`
  报错提示、README、GUIDANCE）统一由 `==1.18.1` 更正为 **`==1.18.0`**（匹配随包 torch cu121 的 cuDNN 8）。
- 📝 **依赖闭包排查结论**：`google-auth`/`google-cloud-storage`/`googleapis-common-protos`/`proto-plus` 一族并非
  tensorboard 孤儿，而是 **`f5-tts → cached_path → google-cloud-storage`** 的真实依赖链（`tensorboardX` 由
  `funasr`/`modelscope` 引入）。故 lock 工具**不做**闭包剔除，freeze 忠实保留全部传递依赖。是否精简取决于后续
  是否保留 f5-tts（待评估其词组/语言支持是否与本项目对齐）。

### 2026-08-02 —— 修正资产 raw 语义：提取后人声=raw，提取前原始→raw_b4_extraction（含 UI 开关）
- 🐞 **修复**：此前 `finalize` 无条件把**外部原始输入**拷成资产 `raw/`，即便跑过人声提取——与「分离后人声才是训练 raw」
  的约定相悖。现在 `finalize` 判断是否跑过提取（`workDir/denoise` 有音频）：**跑过→`raw/`=分离后人声**，并把提取前原始
  混音归档到资产 **`raw_b4_extraction/`**；未跑过→`raw/`=原始输入（行为不变）。
- ✅ **UI 开关**：「人声提取」面板新增 **「保留提取前的原始音频（raw_b4_extraction/）」** 复选框（默认开），贯通
  `stepOptions.keepRawB4Extraction` → `denoise`（是否快照）+ `finalize`（是否发布）。取消勾选可省磁盘；`UVR5_KEEP_RAW=0` 仍生效。
- ✅ **重跑安全**：`raw_b4_extraction` 加入 finalize 的 carry-forward 继承清单，局部重建/换参重跑时不会误删旧资产里的该目录。

### 2026-08-01 —— 人声提取保留原始混音（raw_b4_extraction）：工作区自包含、便于重构
- ✅ **快照原始输入**：denoise 运行前把**原始混音**从外部 `inputDir` 拷入 `.staging/{taskId}/raw_b4_extraction/`。
  语义上分离出的人声（`denoise/`）才是喂给切片/ASR/训练的「训练用 raw」；原始此前只在用户目录（可能被改/删），
  工作区并不自包含。现在两者都在，便于审计/重构。
- ✅ **幂等 + 可关**：resume/fork 已存在则跳过重拷；`raw_b4_extraction` 登记进 denoise 步产物清单，改人声参数重跑时
  随 `denoise/` 一并清理并重新快照。设 `UVR5_KEEP_RAW=0` 可跳过快照以省磁盘。未启用人声分离时不产生此目录。

### 2026-08-01 —— 依赖锁定：requirements.in（意图）+ requirements.txt（冻结锁）双文件 + lock 生成器
- ✅ **`.in` / `.txt` 双文件**：`requirements.in` 为人工维护的声明式意图（范围/marker/pip 选项/注释）；
  `requirements.txt` 改为**完整 `pip freeze` 冻结锁**（逐包 `==`，含全部传递依赖），由部署脚本 `--no-deps` 精确复现。
- ✅ **锁生成器 `tools/deploy/lock_requirements.py`**：冻结当前可用 venv → 排除 torch 三件套与构建工具、
  保留 `.in` 里带平台 marker 的行（onnxruntime cuDNN-8 锁 / arm CPU 回退 / `--no-binary=opencc`）→ 覆盖写 `requirements.txt`；
  `--check` 可校验是否已完全冻结。
- ✅ **bootstrap 软校验**：`bootstrap.ps1` 部署时若发现 `requirements.txt` 仍是松散（含范围/无 pin）会告警提示跑 lock（不阻断）。
  安装侧本就是 `uv pip install --no-deps`（失败回退 `pip --no-deps`），torch 由 `install_torch.ps1` 单独 `--no-deps` 装。
- ✅ **文档**：README 新增「依赖锁定（完全可复现环境）」小节，开发模式改为从 `requirements.in` 安装。

### 2026-08-01 —— 人声分离/训练预设管理 + 试听闸门 + FunASR 置信度诚实化 + 语言告知门（UI/UX 打磨）
- ✅ **人声分离预设 = 可管理的微资产**：自定义人声分离链条支持「另存为预设 / 选中后继续调参 / 显式 **Update preset** 写回 /
  删除」，采用**草稿缓冲**模型——改动不再每次自动保存，必须点更新才落库；删除走**二级确认**防手抖误删。
- ✅ **训练预设合并 + 同样可管理**：Tune 页去掉「Input Type」，把自定义训练参数并入「Training Preset」，同样支持
  保存/更新/删除（保存示例名 `my-tune-pipeline`）；删除同样二级确认。
- ✅ **试听闸门体验**：「人声分离后暂停试听」页文案去机翻（取消 / 继续），并新增**波形 ↔ 电平条**预览样式微开关。
- ✅ **FunASR 置信度诚实化**：`funasr_asr.py` 现产出与 Whisper 同架构的 `<name>.conf.json` 侧车文件，且**只做防御式提取、
  绝不伪造**——Paraformer 拿不到可用后验时置信度即为空。校对页在**整份无置信度**时显示一行说明（引擎不提供置信度、
  本次不着色，需着色请改用 Faster Whisper），避免空列被误读为故障。
- ✅ **FunASR 语言告知门**：选 FunASR 却把语言设为非中文/粤语（且非 auto）时，开始训练前弹**告知**对话框（仅提醒不阻断）：
  继续 / 切换到 Whisper / 取消；坚持继续时后端仍会在失败时自动兜底回退 Whisper。
- ✅ **文档**：`GUIDANCE.md` FAQ 增补 Q8–Q12（FunASR 置信度、语言不匹配、MDX-Net OOM、Roformer 配置配套、人声/训练预设管理与试听）；
  README 顶部显式引导最终用户先读 GUIDANCE，「已知限制」补充 MDX 显存 / Roformer 配套 / FunASR 无置信度三条并互链。

### 2026-08-01 —— UVR5 人声分离全套 + FunASR ASR + 流式合成 + 部署向导许可 UX + 去 tensorboard/谷歌 OAuth 依赖
- ✅ **UVR5 人声分离全套接入**：把上游整套 UVR5 模型（HP / DeEcho / MDX-Net / BS-Roformer / Mel-Band Roformer）
  接为可选的训练预处理去伴奏/去混响/去回声步骤，支持多段链式（如 `MDX-Net → DeEcho`）与逐模型专家参数。
- ✅ **FunASR 中文/粤语 ASR**：在 faster-whisper 之外新增可选的 FunASR 引擎（Paraformer + FSMN-VAD + CT-Punc + UniASR），
  中文更准且自带标点。
- ✅ **流式合成**：流式响应默认不落盘，可在请求体按需开启落盘持久化。
- ✅ **部署向导许可 UX 重构**：三层结构（本软件许可 / 随包与部署时获取的运行时依赖 / 下游模型权重按下载组列出）；
  下游权重不再由我们断言许可，仅列出各自仓库供用户自行阅读后输入 `READ`；新增 `tools/build/gen_node_licenses.py`
  在 `npm ci` 后生成 `node_packages.json`；`start.bat` / `deploy.bat` 更名对齐。
- ✅ **onnxruntime 依赖显式化 + 版本锁定**：g2pW 与 UVR5 MDX-Net 依赖 onnxruntime，`requirements.txt` 显式声明
  （x86_64 用 `onnxruntime-gpu`，arm 用 CPU 版），避免 MDX-Net 段因缺包直接失败。**GPU 版锁定 `==1.18.0`**：
  它用 cuDNN 8、匹配随包 torch cu121；`1.19+` 改用 cuDNN 9 会让 CUDA ExecutionProvider 静默失效、MDX 退回 CPU。
  无需改动任何 import 顺序——全项目仅 `mdxnet.py` 直接 import onnxruntime，且其本就先 import torch。
- ✅ **移除 tensorboard / 谷歌 OAuth 依赖闭包**：`tensorboard` 是 `google-auth`/`google-auth-oauthlib`/`grpcio` 等
  整族依赖的唯一来源。S1 训练 `TensorBoardLogger → CSVLogger`（指标仍写 `metrics.csv`）、S2 训练把 `SummaryWriter`
  导入改为 no-op 空实现守卫，并从 `requirements.txt` 删除 `tensorboard`。训练进度本就由后端解析 stdout，无功能损失。
  （注：`protobuf` 可能仍由 `onnxruntime` 合法引入，属正常序列化库。）

### 2026-07-31 —— v1.0.4：端口占用保护（自己人残留 vs 陌生占用 / 探测下一个空闲端口 / 全链路对齐）+ 同模型请求合并（省冗余权重重载）

> 起因：`start.ps1` 直接抢占固定端口（推理 `9880` / 后端 `9886`），一旦被别的程序占用就启动失败；且即便换端口，后端与健康检查里仍有写死的 `9880`，换了也对不上。同时每次合成前无条件调 `/set_gpt_weights` + `/set_sovits_weights`，对**连续同音色**的批量/多段/重复请求是纯浪费——引擎会白白重载同一套权重。本次加**端口预检与顺延 + 全链路环境变量对齐**，并做**同模型请求合并**。**引擎 Python 完全未动**，合成结果与既有行为等价（同权重驻留）。

- ✅ **端口占用保护（区分自己人 vs 陌生程序）**：`start.ps1` 启动前对推理端口 `9880` / 后端端口 `9886` 做预检——若占用者是**本项目自己的残留进程**则复用/接管；若是**陌生程序**则**探测下一个空闲端口顺延**（`9880→9881…`、`9886→9887…`），不再直接失败（`tools/scripts/start.ps1` 新增 `Get-ListenerPid`/`Get-ProcInfoById`/`Test-IsOwnProcess`/`Get-FreePort`/`Resolve-Port`）。
- ✅ **顺延后的全链路对齐**：解析出的端口经环境变量注入下游——`start.ps1` 设 `$env:GPT_SOVITS_BASE_URL`（推理实际地址）与 `$env:BROKER_PORT`（后端实际端口）；后端 `server.js` 已读这两个变量，**不再写死**。前端**同源**（`API_BASE=''` 相对请求，随后端端口走），无需注入端口，浏览器直接开解析后的后端地址即可。
- ✅ **健康聚合去写死**：`/api/health` 的「引擎在线」判定改读 `ctx.GPT_SOVITS_BASE_URL`，移除两处硬编码 `http://127.0.0.1:9880`；避免端口顺延后健康检查**永远误报**引擎离线（`lib/routes/system.js`）。
- ✅ **同模型请求合并（same-model coalescing）**：新增 `lib/gsv/modelState.js`（`ModelSwitcher`），记住**上次成功加载**的 GPT/SoVITS 权重路径；当下一次请求要的是**已驻留的同一套权重**时，跳过 `/set_gpt_weights` + `/set_sovits_weights` 的冗余 HTTP 往返（常见场景：一个音色的批量/多段/重复调用）。合成全程在单一全局生成锁（`withGenerationLock`）下**串行**，缓存镜像引擎驻留状态、串行安全；切换**失败即清对应槽**（绝不在失败后误跳过）。`server.js` 的 `switchModels` 委托给它，正确性不变、仅省去冗余重载。
- ✅ **引擎重启后缓存自动失效（搬家防呆闭环）**：`/api/health` 探测把引擎在线状态喂给 `ModelSwitcher.noteEngineHealth()`；一旦检测到**离线→在线**翻转（引擎重启，驻留权重已丢），自动 `reset()` 整体失效缓存，下次合成强制重切，避免误跳过导致用错/无模型。此前 `reset()` 已存在却无人调用——本次接线补齐。典型触发：**项目被移动到别的机器/路径**时 `start.ps1` 的 `Repair-EngineConfig` 会把 `tts_infer.yaml` 打回底模并重启引擎，缓存现在能随之自动作废。
- ✅ **并发策略（本轮）**：以「同模型请求合并」处理连续同音色请求；真正的多模型并行推理需引擎侧改造，暂缓。
- ✅ **`/v1/audio/speech` 新增可选 `language` 字段（Aurivox 扩展）**：允许单次请求指定朗读语言，优先级最高——`请求 language → recipe.language → 资产语言 → auto`。纯**可选、向后兼容**：OpenAI 客户端不传时行为与旧版完全一致（官方 SDK 经 `extra_body` 传）。接受裸码 `zh/ja/en/auto` 与规范引擎模式 `all_zh/all_ja/auto_zh_ja/en/auto` 两种写法并归一（`zh→all_zh`、`ja→all_ja`，与 UI/`recipe.language` 存储一致，故 recipe 卡片 curl 可干净往返）；其它值（含暂未维护的 `yue/ko`）不报错，回落 `auto` 并带 `X-Language-Warning`。显式合法语言时不再发兜底警告。`prompt_lang`（参考音频语种）保持解耦。改动在 `lib/routes/synthesis.js` + Broker 页 API 指南卡（`web/src/components/common/Fields.jsx`）+ 每个 recipe 卡片的「调用示例」curl（`web/src/components/broker/BrokerTab.jsx`，示例中显式带上该 recipe 自己的语言，便于复现）。
- ✅ **版本号** `package.json` / `web/package.json` `1.0.3 → 1.0.4`。**本次改了前端指南卡（`Fields.jsx`），需 `npm run build` 重建 `web/dist/`。**

### 2026-07-30 —— v1.0.3：语言解析防线栈（去写死 ja / prompt_lang 解耦 / 母模可入 recipe / auto 兜底）+ Broker OpenAI 接口说明窗口

> 起因：Broker 曾把合成语言按音色**写死**（默认 `ja`）。当上游把**纯汉字**文本发给一个日语音色时，引擎的 `get_phones_and_bert()` 会把汉字当日语（音读）念出来。根因是「无法区分中日韩汉字，以传入 language 为准」的兜底分支 + Broker 侧对 `text_lang` 的硬编码。本次建立**多层语言解析防线栈**，并把 OpenAI 兼容接口的「特殊之处」在前端讲清楚。**引擎 Python 完全未动**，**未 bump recipe `schema_version`**（免迁移，老资产零回归）。

- ✅ **语言解析防线栈（优先级从高到低）**：① 请求 `text_lang`（下游显式） → ② `recipe.language`（导出时用户选，可留空） → ③ 资产 `meta.language`（微调管线已必填、默认 `auto`） → ④ 兜底 `auto`（**不再假装 `ja`**） → ⑤ `auto` 档内交由引擎逐段判定（现有假名/标点规则） → ⑥ 最末兜底 `auto`。落到 `auto` 时后端 `console.warn` 并在响应头回传 `X-Language-Warning`，绝不静默多语种朗读（`lib/routes/synthesis.js`）。
- ✅ **`prompt_lang` 与 `text_lang` 解耦**：参考音频的语言是资产的**第一真相**（微调结束即确定），只影响参考文本切词，与目标文本的语言模式无关；不再被 `recipe.language` 牵连（`lib/routes/synthesis.js`）。
- ✅ **母模（`__base__`，language=auto）可入 recipe 并被下游正常调用**：修复 recipe 路径未注入 `baseVoiceReg()` 导致母模 recipe 下游 404 的问题（镜像整声路径的内存态解析）（`lib/routes/synthesis.js`）。
- ✅ **诚实默认 `auto`**：`DEFAULT_LANGUAGE` `"ja"`→`"auto"`（`lib/assetScanner.js`）；promote 兜底 `ja`→`auto`（`lib/training/steps/promote.js`）；手动注册 voice 的三处 `"ja"`→`"auto"`（`lib/routes/voices.js`）。`meta.language` 仍是第一真相，现有 `voices.json`（8 个音色均显式 `ja`）**不受影响**，仅将来无 meta 的资产会落到 `auto`。
- ✅ **`auto_zh_ja` 的 `auto_base_lang` 强制归一**到具体语种（`zh`/`ja`/`yue`/`ko`/`en`，缺省 `zh`），防止资产语言的 `"auto"` 泄漏成非法 base_lang（`lib/routes/synthesis.js`）。
- ✅ **`recipe.language` 放开**：留空=**跟随资产**（不写死值）、更新时保留 existing、接受 `auto` 档；不再默认 mint `"ja"`（`lib/recipeStore.js`）。
- ✅ **Save-as-recipe 强制选语言**：新增**必选**语言下拉，默认预选资产当前语言；取不到（非本管线入库）则留 `auto` 并给出**强提醒**（i18n 中/英）；未选禁止保存（`web/src/components/common/Dialogs.jsx`）。
- ✅ **Broker recipe 卡片语言可编辑**：由只读改为可编辑下拉（含「留空=跟随资产→auto」档），即时 `PUT` 保存（`web/src/components/broker/BrokerTab.jsx`）。
- ✅ **Broker OpenAI 接口说明窗口（i18n、确认一次）**：复刻 Assets「模型命名与元数据重建」那种**确认过一次**的折叠说明卡片，讲清兼容 OpenAI 的 `POST /v1/audio/speech` **请求格式与每个字段**及 Aurivox 特有的「特殊之处」——`voice`（必填，是 **recipe id `role/name`**，非 `alloy`/`nova`；也可只填 `role`）、`input`（必填，≤5000 字符）、`model`（接受但**忽略**，权重由 recipe 固定）、`response_format`（默认 `wav`；`mp3`/`opus`/`aac`/`flac` 需服务器 `ffmpeg`）、`speed`，以及**语言不是请求字段**（服务端防线栈解析，经 `X-Text-Lang`/`X-Language-Warning` 回传）；附常见 `curl` / OpenAI Python SDK 命令。持久化 ack key `broker.apiNoteAck`（`web/src/components/common/Fields.jsx` 新增 `BrokerApiNotePill`/`BrokerApiNoteCard` + `web/src/components/broker/BrokerTab.jsx` + `web/src/styles.css`）。
- ✅ **示例命令 `input` 随界面语言联动**：中 `你好，这是一段示例文本。` / 英 `Hello! This is a sample line.`（`curl` 与 Python 示例共用）。
- ✅ **版本号** `package.json` / `web/package.json` `1.0.2 → 1.0.3`。前端改动需 `npm run build` 重建 `web/dist/` 后生效。


### 2026-07-30 —— v1.0.2：Broker 示例调用 i18n + recipe 卡片默认折叠 + Reading proofing 可视化重整（等宽网格 / 加宽 / 谐音互斥）
- ✅ **Broker 示例调用去日文硬编码**：Example call 的 curl `input` 原为写死的 `こんにちは`，改为随界面语言联动的中立示例句 `t('Hello! This is a sample line.', '你好，这是一段示例文本。')`；复制命令（单行 / 多行）同步取该值，行为不变（`web/src/components/broker/BrokerTab.jsx`）。
- ✅ **Broker recipe 卡片默认折叠**：整张 recipe 卡片默认收起，仅显示卡头（显示名 + `role/name` + Delete），点击卡头 ▶/▼ 展开详情 / 示例 / Change models；折叠态点 Delete 会先自动展开再弹二次确认（确认框在卡体内），避免误删无提示。原「Example call」内层折叠保留。
- ✅ **Reading proofing 可视化重整**：读音校对面板（`web/src/components/pron/PronProofing.jsx`）由 `flex-wrap` 改为 **CSS Grid 等宽对齐**（`repeat(auto-fill, minmax(132px,1fr))`），混合语言整齐成行；纯标点 token（`^[\s\p{P}\p{S}]+$`）不再各自成卡，改为淡色内联字形去噪；每卡的大写语言标签（`JAPANESE`/`ENGLISH`）改为**彩色小圆点 + 短码**（JA/EN/ZH…，仅多语混合时显示，hover 显示全称）；已覆盖读音的卡片以 `--accent` 边框强调。
- ✅ **英文读音详情默认收起**：英文 token 的「词典候选下拉 + 谐音改写」默认隐藏，标题旁 `✎` 开关按需展开，读音输入框常显，消除纵向拥挤。
- ✅ **sounds-like 与音标框互斥（消歧）**：一旦「谐音改写（sounds like）」输入框有内容，本词读音即以该谐音为准 —— 上方 ARPABET 音标输入框 + 候选下拉**置灰并禁用**，hover 给出书面提示（i18n：中「此音标输入当前不生效。该词读音以下方"谐音"单词为准；清空该谐音后即可恢复手动编辑音标。」）。消费逻辑不变：谐音在回车 / 失焦时经 `/api/pron/preview` 反查 ARPABET 写入同一 override 桶，推理引擎始终只收到单一 ARPABET 数组，二者不会同时送达。
- ✅ **Reading proofing 页面加宽**：`Text preparation` 弹窗 `max-width` 780→**1180**（`width` 94%）；`.pron-panel-wide .pron-grid` 列由 `1fr 1fr` 改为 **`minmax(280px,340px) 1fr`**（左侧编辑区定宽、右侧读音区吃满剩余宽度），一行约可放 5 个读音卡；新增 `@media(max-width:720px)` 单列回退（`web/src/styles.css`）。
- ✅ **版本号** `package.json` / `web/package.json` `1.0.1 → 1.0.2`。前端改动需 `npm run build` 重建 `web/dist/` 后生效。

### 2026-07-28 —— v1.0.1：发行合并 + 跨资产混搭纳入底模 + refine 复用修复 + Compare Refs 白屏修复 + 训练日志英文化
- ✅ **发行合并（v1.0.0 → v1.0.1）**：两份源码快照已分叉（非线性新旧），做三方合并 —— 以较新前端/路由的基线为主，仅挑拣另一份**确为超集**的 3 个训练-python 文件（`pipeline.js`、`gsv_code/tools/my_utils.py`、`gsv_code/prepare_datasets/2-get-hubert-wav32k.py`）叠加，任一方向直接覆盖都会丢功能。`package.json` / `web/package.json` 版本 `1.0.0 → 1.0.1`。
- ✅ **跨资产混搭纳入底模（虚拟资产）**：「Mix models across assets」原先只列已微调资产，漏了内置 `Base model` —— 因混搭列表接口只枚举 `voices.json` + 磁盘目录，而底模两者皆无。现 `GET /api/assets/voices-with-models` 置顶注入合成的 `__base__` 条目（取自 `baseVoiceMeta()` 的 checkpoints，与 Generate 下拉同源），底模 GPT / SoVITS 可与任意资产独立混搭；前端 `assetIdFromCkptPath()` 也能把底模的预训练权重路径（`gsv-v2final/*`、`v2Pro/*`、`s1bert25hz-*`、`s2G{2333k,488k,v2Pro,v2ProPlus}`）识别为 `__base__`，使「底模 + 资产」正确判定为跨资产（⚠混搭提示）、reload / rerun 时自动恢复混搭态。
- ✅ **修复 refine「复用」误等缺转写**：复用模式的 S2 精炼会把父资产冻结的 `segments.json` 播种进派生资产目录（`inputDir`），`preprocess.js` 也会从 `workDir` 或 `inputDir` 两处读取；但预处理前的宽限门原先只查 `workDir/segments.json`，导致每次复用 refine 都白等 `asrGraceSec` 并打印误导性的「将报缺转写错误」。宽限门现同时识别 `inputDir/segments.json`，复用 refine 直接进入预处理；真正无转写（两处皆无）仍保留宽限/投放窗口。
- ✅ **修复 Compare Refs 编辑区白屏**：`CompareRow` 子组件渲染跨资产混搭开关时用了 `t(...)` 却未绑定翻译器，展开某行的模型/编辑区即抛 `ReferenceError: t is not defined` 并整页白屏。已在 `CompareRow` 顶部补 `const { t } = useT()`（同文件的 `ReferenceCompareTab` / `CompareBatchCard` 早已具备）。**注意：前端改动需 `npm run build` 重建 `web/dist/` 后方生效。**
- ✅ **训练日志英文化**：此前 pipeline 引入了中英双语日志，冗余；现训练日志输出统一为**英文**，插值内容（含中文文件名/路径）原样透传，代码注释保持不动（非用户可见输出）。范围：`pipeline.js`、`steps/{asr,denoise,slice}.js`、两个 `load_audio` 的 Python `print`。后端 `stepDefs` 标签仅用于日志，Web UI 用自己的 `TRAIN_STEPS` + `t()`，故不影响界面。

### 2026-07-26 —— 统一音频加载兼容层（单声道下混 + 可选 ffmpeg 兜底 + 加载统计）
- ✅ **修复立体声导致 HuBERT 崩溃**：`2-get-hubert-wav32k.py` 内联的 `load_audio` 用
  `torchaudio.load().squeeze(0)`，对立体声 `[2, N]` 压不掉声道维，二维数组直接喂进 conv1d 触发
  `RuntimeError: Expected 2D/3D input to conv1d, but got input of size [1,1,2,N]`。虽被外层
  try/except 跳过、训练不中断，但该条素材会被**静默丢弃**。现统一改为 soundfile 读取并强制
  `mean(axis=1)` 下混单声道。
- ✅ **兼容层双后端**：默认走 **soundfile**（无需 ffmpeg，覆盖 wav/flac/ogg 等）；读不了的格式在
  **检测到 ffmpeg 时**用官方原版方式（`ffmpeg -ac 1 -ar sr` 强制单声道）兜底，**不强制安装 ffmpeg**。
- ✅ **加载统计**：每次运行统计 `total/loaded/downmixed/resampled/via_ffmpeg/failed`，预处理结束打印
  一行汇总，便于核对「几条有效、几条被跳过」。`lib/training/gsv_code/tools/my_utils.py` 同步升级为
  规范实现（soundfile 优先 + 可选 ffmpeg + 统计），与 hubert 内联版保持一致。

### 2026-07-17 —— 发布打包修复/分发瘦身 + MDX-Net→HP2 显示名 + 原生底模零样本推理 + Compare Refs 可选底模 + 参考文本本次编辑 + 训练默认非对称（#10）/ S2 声学精炼（#12）/ 参考文本手动校对（#13）
- ✅ **发布打包修复 + 分发瘦身**：修复 `04_pack_release.py` 因文件时间戳早于 1980 触发
  `ValueError: ZIP does not support timestamps before 1980` 导致写 zip 崩溃 —— 现自动把这类
  mtime 钳制到 1980-01-01，打包不再中断。发布包不再打进两套深度学习运行时（`venv_idx*` 引擎虚拟环境
  + `vendor/micromamba` 的 CUDA torch 栈，约 14GB）与全部**应用** `node_modules`（后端 + web），
  改由部署时 `npm ci` 从随包 `package-lock.json` 还原（`bootstrap.ps1` 新增步骤）；**保留** node
  运行时自带的 npm（`tools/runtime/node/node_modules`）。顺带排除杂物 `nul` / `try_indextts2*.ps1` /
  `setup_indextts_env_v2.bat` / `server.js.txt`。发布体积从 14.1GB 降到 ~300MB。这样既缩小分发包，
  也避免物理再分发第三方 npm 包（对齐 models/torch/ffmpeg 的「部署时按需获取」模型）。
- ✅ **MDX-Net → HP2 显示名**：UVR5 人声分离模型的显示名由 `MDX-Net` 统一改为 `HP2`（仅显示层改名，
  权重文件与后端标识不变）。
- ✅ **原生底模（`__base__`）零样本推理**：开放预训练底模直接推理，免走一遍微调。引入内存态
  虚拟音色 `Base model`（不落 `voices.json`、无资产目录）——**只进 Generate 的 Voice 下拉且默认
  选中，不进 Assets 管理页**。GPT = `Base model_s1`；SoVITS = `Base model_v2 / _v2Pro(默认) /
  _v2ProPlus`（从 `pretrained/` 解析，缺失版本自动剔除）；命名沿用 `<id>_<lang>_<version>` 风格、
  去掉 epoch/step 尾巴。语言 Auto（自动多语言）。底模自身无参考，借「Use reference from another
  voice」用其它资产的切片 / raw 作参考——零新增借用逻辑。后端新增自包含 BASE MODEL 块
  （`baseCheckpoints()` / `baseVoiceMeta()` / `baseVoiceReg()` + 6 处 `isBaseVoice` 特判：
  `/api/generate` voiceReg 回退、`/api/voices` 置顶、`GET /api/assets/:id` 合成 meta、
  `/segments`·`/raw-list` 空、`/api/voices/:id/validate` 模型存在/参考缺失）；删除·扫描·重建·精炼·
  转写等 mutation 接口本就有 `fs.existsSync` / `voices[id]` 前置判断，无目录/未注册的 `__base__`
  自然 404，无需额外护栏。
- ✅ **Compare Refs 可选底模**：每行 VOICE ID 下拉注入底模（前端把 `GET /api/assets/__base__` 的
  gpt×sovits 组合置顶），选中自动落到 `Base model_s1` / `Base model_v2Pro` 并把参考源切到 cross
  （借用其它音色），因底模自身无切片。
- ✅ **参考文本本次编辑（不改文件）**：Generate 侧栏参考文本块改为可编辑 textarea，
  载荷 `reference_text` 用编辑后的值，切换音色 / 换参考音频自动复位；**全程不写 `.list` / `segments.json`**，
  仅本次推理生效，附带 raw 无对齐文本时可临时补一段引导。后端 `/api/generate` 早已接收
  `reference_text` → 零后端改动。
- ✅ **训练默认非对称（#10）**：废弃对称 20/20，新建任务内置 **S1(GPT)=8 / S2(SoVITS)=25**（S1 重文本-语音
  对齐、易过拟合；S2 重音质、需更久收敛；佐证 RVC-Boss issue #176 "overtraining GPT can cause missing text"）。
  保存间隔 `s1_save_every_n_epoch=4` / `s2_save_every_n_epoch=5`，保证最终 epoch（8%4=0、25%5=0）必落
  checkpoint；legacy 回退 `?? save_every_n_epoch ?? 4`。仅影响变更后新任务，已有 recipe 不受影响
  （`lib/training/config.js` + `steps/train.js`）。
- ✅ **S2 声学精炼（#12）**：从已训练资产的 S2 checkpoint 低学习率续训、复用父 S1，**派生为全新 Voice**
  （`allocateVoiceId()` + `reserve()`，父资产绝不被修改/覆盖）；仅重训 S2（`train_s1:false, train_s2:true`）。
  血统元数据 `parent_voice_id` / `root_voice_id` / `generation` / `base_s1_checkpoint` / `base_s2_checkpoint` /
  `additional_epochs` / `learning_rate`；训练数据冻结快照 `transcript.content_hash` + `frozen_at`；失败回滚
  `release(id)` + 删新目录。默认命名 `"<parent> · S2 Refined <n>"`（无 v2 后缀）。支持链式精炼。
- ✅ **参考文本手动校对（#13）**：资产页 `Proofread Reference Transcript` 入口，默认只编辑现有 transcript、
  **绝不默认重跑 ASR**（`GET/POST /api/assets/:id/transcript` 读写 `.list` + 重建 `segments.json`）；
  `Re-run ASR` 为独立次级操作（`POST /api/assets/:id/transcribe`），执行前把旧文本备份为 `*.bak.<ts>`。
  新增 transcript 来源/验证 provenance：`machine_generated` / `human_edited` / `human_verified`；不触碰已训练 checkpoint。
- ✅ CR：PATCH 可合并（#10 数学正确、#12 血统+回滚+命名无歧义、#13 读写分离+备份安全+provenance 完整）。

### 2026-07-16 —— 中文资产命名（身份/显示解耦）+ Recipe v3 路径可移植性
- ✅ **中文资产命名（Option A）**：`display_name`（允许中文/任意 Unicode、允许重名）与不可变 ASCII
  canonical id 解耦。文件夹名为权威 id，`meta.id` 仅镜像；id 由服务器在建任务时**原子分配一次**
  （`lib/assetId.js`：`slugify` / `allocateVoiceId` 碰撞检查 / `proposeVoiceId` 预览 / 保留占位跨重启持久化），
  永不再从显示名派生。**改名 = 仅改 `display_name`**（不移动文件夹、不改 id、不拒重名，UI 显示非阻塞重名提示）。
- ✅ **Recipe v3 路径可移植性 + 安全**：managed 路径（`reference_audio` / `aux_ref_audio_paths` /
  `gpt_ckpt` / `sovits_pth`）改结构化 `{ base: "asset"|"external", path }`；asset→`ASSETS_ROOT` 相对（可移植），
  external→绝对（不可移植）。**版本感知解析**（legacy v≤2 字符串仍按 APP_DIR，v3 对象按 ASSETS_ROOT，无静默回退）；
  **字段级外部权限**（GPT/SoVITS 需 `allow_external_models`，参考音频另需 `allow_external_audio`，模型权限绝不授权音频）；
  **双层 containment**（词法 + realpath 挡 symlink/junction 逃逸）。`lib/pathResolver.js`。
- ✅ **Legacy 迁移 API（显式/辅助）**：`lib/recipeMigration.js` + 3 端点（preview 只读分类 /
  apply 先备份再改写 v3 / revert 逐字节还原），保守 `ambiguous` 分类须用户裁决，**绝无启动/扫描时静默改写**。
- ✅ 测试：`pathResolver.assetId.test.js` 24/24 + `recipeV3Migration.test.js` 12/12。

### 2026-07-16 —— 多语种混合 + UX 整改 + 全量模块化 + 可复现性
- ✅ **多语种混合输入（#4）**：假名消歧（有假名判日、无假名 CJK 回退角色元数据语言）、逐字汉字语言
  覆盖（`lang_overrides`，共享汉字按需强制中/日）、校对面板与逐字语言互斥、Compare Refs 同步支持。
- ✅ **推理间歇性 500 修复（#5）**：`infer_server.py` 改用 `asyncio.Lock` + `call_soon_threadsafe`
  跨线程加/解锁，消除并发请求下的竞态 500。
- ✅ **Compare Refs P0 整改（#6，6 项）**：🎭 参考角色动态标注、参考音频 3–10s 黄色警告、编辑区
  生成后默认折叠、Model 三级级联下拉、Items 三级联、结果卡管理按钮（Reveal / Rerun / Delete）。
- ✅ **Broker 页面改进（#7）**：GPT/SoVITS 一行三下拉、Example call 默认折叠为单行、
  「Save models」手点才落盘（明确对未来 API 调用的影响）。
- ✅ **资产健康状态全面修复（#8，A~F 六子项）**：健康来源优先聚合、Complete 与 Ready 严格区分、
  转写状态持久化、Rebuild / Restore TASK 通用化（`lib/assetScanner.js`）。
- ✅ **恢复 / 分叉正确性回归（#3 v2）**：进入 Resume 快照各步参数并实时 diff；改动映射到步骤后
  **自动前移重启点**触发 fork（新任务），banner 明确提示"将创建新任务、只复制上游产物、预留磁盘"；
  后端新增 `copyWorkDirUpstream` 只复制上游产物（不再整目录翻倍复制），`clearFromStep` 防御性保留。
- ✅ **推理可复现性（seed）**：`server.js` 上移 `resolveSeed` helper，在调用引擎前把 `seed=-1/空`
  解析成 `[0, 2^32-1]` 的具体值，写入 `meta.recipe` 与顶层审计字段 → Recent 的 Rerun 现可逐字节
  复现（seed + `pron_overrides` 读音 + `lang_overrides` 逐字语言 + 全部采样参数）；默认随机行为不变。
- ✅ **UX 文案微调（5 项）**：删除 Compare Refs 冗余 Back；红色 × 明确为 "Remove from comparison"
  tooltip；发布后清理说明"仅清理任务 workspace，不删除已发布模型资产"；Broker「Change models」
  说明对未来 API 调用的影响；训练音频目录提示"仅支持文件夹，单文件请先放入文件夹"。
- ✅ **全量模块化**：`App.jsx` 6520 → 141 行，拆分为 `lib/api.js` + `pron` + `common` +
  `generate` / `train` / `compare` / `assets` / `broker` 模块树。
- ✅ **ASR 切换** `faster-whisper-large-v3-turbo`（1.6GB）。
- ✅ **中文注释全面英文化**（代码库注释统一英文）。

### 2026-07-14 —— UI 大改版 & 资产健康修复（patch #6 / #7 / #8）
- ✅ **Compare Refs 页面重构（#6）**：Model 输入拆分为三级级联下拉 [Voice ID][GPT][SoVITS]；
  Target Language 上移为顶部窄下拉节省空间；主参考音频支持在大框内直接框选（本角色 slices / raw 双标签页，
  可选其他角色）；参考角色 🎭 标注随所选参考音频动态解析；参考音频不符合 3–10s 时黄色警告；
  生成后编辑区收起为纯音频；结果卡新增 Show in Explorer / Rerun / Delete。
- ✅ **Broker 页面重构（#7）**：GPT/SoVITS 权重选择拆为 [Voice ID][GPT][SoVITS] 三级联动（保留自选 ckpt/pth 逃生通道）；
  「Save models」时才落盘；Example call 折叠为单行可展开。
- ✅ **共享对比文案 & 读音校对**：「Default Test Text」更名「Comparison Text」，附共享 Reading proofing
  （逐词读音覆盖，应用到留空行）。
- ✅ **资产健康指示灯修复（#8）**：去掉 slice 步骤后残留的空 `slicer_opt.list` 不再把 text 健康灯误判为红色
  `invalid`；空/无文本列表现按 `none` 处理，`invalid` 仅保留给「有文本但路径失效」的列表，
  使 text 灯与整体健康灯一致（`lib/assetScanner.js`）。
- ✅ **顺手修复（drive-by）**：推理服务锁释放 `RuntimeError` 兜底路径补注释（`infer_server.py`）；
  recipe 命名占位符英文化；全部新增 UI 文案统一英文。

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
