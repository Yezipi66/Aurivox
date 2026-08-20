# Aurivox

> Aurivox 是一个面向 **Windows + NVIDIA CUDA 本地环境** 的 GPT-SoVITS 训练、资产管理与推理工作台，**采用MIT开源协议**。本项目是 local-first 工具，对外的接口采用OpenAI-compatible 接口，用于兼容其他客户端。

## 亮点速览

- **中日粤混排**：中文、日语、粤语同段混合编排，按语言就近切分；韩语 / 英语独立发音，互不干扰。
- **逐字读音校对**：拼音 / 真实粤拼 / kana 多级校对，框选 / 点选即可批量指定汉字语言与读音，可持久化到词典。
- **全链路训练管线**：人声提取 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS)，带断点续训与失败恢复。
- **OpenAI 兼容推理**：内置自包含推理服务，`/v1/audio/speech` 可直接被标准 OpenAI 客户端调用。
- **解压即用分发包**：内嵌可重定位 Python + 一键部署向导（自动建 venv、装依赖、下载模型并自检）。

> 📖 **最终用户请先读 [`GUIDANCE.md`](./GUIDANCE.md)**（部署 / 启动 / 停止 + 常见问题 FAQ）。
> 本文件现在同时面向最终用户、开发者和二次开发者：部署、启动、训练管线、推理、API 和开发说明都集中在这里。历史变更单独记录在 [`CHANGELOG.md`](./CHANGELOG.md)。

## 支持范围与不支持范围

- 支持：Windows 10/11 x64、NVIDIA CUDA、GPT-SoVITS v2/v2Pro/v2ProPlus。
- CPU：可用于部分推理，但速度明显较慢；不作为微调和 UVR5 的目标环境。
- 暂不支持：Linux、macOS、Apple Silicon、AMD GPU、Intel GPU。

基于开源项目 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（RVC-Boss，v2 / v2Pro / v2ProPlus）
打造的 TTS 训练与推理一体化工作流：在其之上做工程化封装，自包含、可独立部署。
面向内部使用者提供「解压即用」的分发包：内嵌可重定位 Python，
一键部署脚本自动建 venv、装依赖、下载模型并自检。

- **训练**：人声提取 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS) 全链路管线，带失败恢复。
- **推理**：内置 OpenAI 兼容的自包含推理服务（`lib/inference/infer_server.py`，引擎本体在 `engines/gpt-sovits/infer/`），完整 S1+S2 串联。
- **分发**：`deploy.bat`（首次部署向导）+ `start.ps1`（启动），无需手工配环境。


## 顶层目录导览

> 仅列稳定的顶层职责，避免随业务频繁变动而过时；细节以代码为准。

| 路径 | 职责 |
| --- | --- |
| `server.js` | Express 后端主入口（REST + 推理编排 + 资产/训练接口） |
| `web/` | 前端（Vite + React；`src/` 已模块化为 `lib/` + `components/{generate,train,compare,assets,broker}`） |
| `lib/training/` | 训练管线：`pipeline.js` 状态机 + `steps/`（denoise/slice/asr/preprocess/train_s1/train_s2）；第三方代码与权重不在此处 |
| `lib/inference/` | 自包含推理服务的进程入口（`infer_server.py`，OpenAI 兼容）；推理运行时本体在 `engines/gpt-sovits/infer/` |
| `vendor/` | 第三方代码，第一层按工作流环节划分：`uvr5/`（人声分离）、`asr/`（语音识别）、`slicer/`（音频切分）、`tts/<引擎>/`（合成引擎）。GPT-SoVITS 一支含 `gsv_code/`（上游源码，目录名同时是 Python 包名，不可改）、`infer/`（推理运行时）、`train/`（上游训练脚本）。本项目对推理运行时的改动记于 `engines/gpt-sovits/infer/LOCAL-CHANGES.md`，升级上游时须逐条比对 |
| `vendor/gsv-tools/` | 权重暂存处，代码已迁走，下一轮全部迁入顶层 `models/` |
| `assets/{voiceId}/` | 已发布角色资产（`meta.json` + 训练产物 + `logs_s1` / `logs_s2`） |
| `.staging/{taskId}/` | 训练任务工作区（`task.json` 运行日志 + 中间产物；发布成功后按需清理） |
| `tools/` | 开发与运维脚本：`run_tests.cjs`（测试入口，即 `npm test`）、`checks/`（环境体检）、`scripts/`（启停与打包 PowerShell）、`build/`（发行版构建）、`tests/`（需单独运行的集成测试） |
| `docs/` | 项目文档；`docs/internal/` 存放内部阶段性记录 |
| `data/` | 运行期数据，全部集中于此：音色注册表 `voices.json` 及其轮转备份 `backups/`、配方 `recipes/`、画布的图与运行状态 `flowgraph/`、参考音频导入暂存区 `voices/`、读音词典 `pron_lexicon/`、本地配置 `app-config.json`，以及可被覆盖的默认值 `advanced_params.json` / `training_defaults.json`。该目录不进版本库 |
| `outputs/` | 推理产物，按来源分为 `generate/` · `comparerefs/` · `broker/` · `flowgraph/`，互不混淆 |

> **路径权威**：上述所有目录与运行期文件的位置，统一定义在 `lib/paths.js`，其它模块
> 一律从该文件取常量，不得自行拼接目录名。要调整某个目录的位置，只需改动该文件；
> 守卫测试 `lib/paths.node.test.js` 会拦截绕过该约定的写法。

## 快速开始

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11(64 位) |
| 显卡(推理) | 推荐 NVIDIA(**CUDA 12.1+**);**无 NVIDIA GPU 卡也可用** —— 自动回退 CPU 运行,可用但明显更慢 |
| 显卡(微调 / 训练) | **必须 NVIDIA GPU**;CPU 训练慢到基本不可用,且人声分离(UVR5)不支持 CPU |
| 显存 | 微调建议 ≥ 8 GB;**≤4 GB 也能微调**,但有 OOM 风险 |
| 网络 | 首次部署需联网,下载 PyTorch 与模型,约 **10 GB** 流量 |
| Python / Node | ✅ 无需自行安装,已内置 |

> 🟢 **CUDA 状态灯**:界面右上角有一颗状态徽章 —— `CUDA <显存>`(绿=检测到 N 卡)/ `CPU only`(红=未检测到)/ `GPU: detecting…`(灰=检测中)。鼠标悬停可看设备名与显存。
> - **非NVIDIA GPU / 无独显**:不在支持范围内(仅测试过 NVIDIA);推理可在 CPU 模式下使用,但**不建议**用于微调和UVR5。

---

### 首次部署

> 双击 **`deploy.bat`**

脚本会自动完成以下步骤:

1. 用内置 Python 3.11 创建虚拟环境 `venv\`
2. 安装依赖(离线轮子 + 联网 PyPI,不含 torch)
3. 安装 PyTorch(CUDA 12.1)
4. 弹出**模型下载向导**,引导你下载模型(约 9 GB)
   - 选 `1` 下载全部;若在国内,菜单里可切换 **hf-mirror** 镜像加速
5. 自检

**提示**

- ⏳ 全程耐心等待,首次可能 **20~60 分钟**(取决于网速)。
- 🔁 若中途失败,重跑本脚本即可(支持续跑,已装的会跳过)。
- 🎵 **如需对外提供 OpenAI 兼容接口的 MP3(或 opus / aac / flac)输出,请一并安装 ffmpeg**(引擎只出 WAV,MP3 转码依赖 ffmpeg,项目未内置其它编码器)。安装方式见 [FAQ · Q7](./GUIDANCE.md#q7-需要-ffmpeg-吗)。

---

### 启动

> 双击 **`start.bat`**

- 浏览器会自动打开 <http://127.0.0.1:9886>
- 后端与推理引擎在后台运行,**关闭黑窗口不影响它们**。
- 日志位于 `logs\` 下(`startup` / `backend` / `inference`)。

---

### 停止

> 双击 **`stop.bat`**

---

## 开发与二次开发

### 开发模式

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

> 注：早前那套 `requirements.in`（意图）+ `lock_requirements.py`（生成器）的 pip-tools 风格双文件已**退役**。

- **安装**：`deploy.bat` / `bootstrap.ps1` 用 `uv pip install --no-deps -r requirements.txt`（失败回退 `pip --no-deps`）——**不跑求解器**，逐包按 pin 精确装,避免复现时被解析器悄悄升/降级,也避免纸面假冲突（如 `accelerate 1.14` 声明要 `torch>2.2` vs 锁死的 `torch==2.2.0+cu121`）。`torch/torchaudio/torchvision` **与 `onnxruntime`** 体积大且 GPU 专属，一并由 `install_torch.ps1` 单独 `--no-deps` 安装（同一套 NVIDIA 探测:有 N 卡→cu121+`onnxruntime-gpu`,无→CPU 版+`onnxruntime`;只支持 N 卡，不支持 AMD/DirectML）。
- **改依赖**：在**开发机**上直接 `pip install ...` 把 venv 调到能跑 → 重新冻结覆盖：

  ```bat
  venv\Scripts\python.exe -m pip freeze > requirements.txt
  ```

  然后**手动处理 `pip freeze` 会顺手带进来、但不该进锁的东西**：
  1. 把 freeze 出来的 `torch` / `torchaudio` / `torchvision` **与 `onnxruntime-gpu`** 这几行**重新注释掉**——它们体积大、GPU 专属，由 `install_torch.ps1` 单独 `--no-deps` 安装（同一套 NVIDIA 探测:有 N 卡→cu121+`onnxruntime-gpu`,无→CPU 版+`onnxruntime`）。写死进锁会架空这个判断,把没显卡的机器硬塞进 GPU 包。因此锁里也**不需要** `--extra-index-url .../cu121`（那是 torch 唯一的用途，已随 torch 一起移出）；
  2. `onnxruntime` 的版本 pin（`==1.18.0`,cuDNN 8;尽量别漂到 1.19+，那会改用 cuDNN 9 并静默关掉 CUDA ExecutionProvider）现由 `install_torch.ps1` 的 `-Ort` 参数默认值持有；requirements.txt 顶部保留一条注释说明即可。
  - freeze 忠实反映当前 venv:传递依赖一个不少（否则 `--no-deps` 安装会缺包）。**提交这份 `requirements.txt`**。

> ⚠️ 因为安装用 `--no-deps`，`requirements.txt` **必须**是完整 freeze——否则传递依赖会缺失。改依赖 = 在开发机装好后 `pip freeze` 重新覆盖，**不要手工逐行编辑** pin。
> ⚠️ 别再往 `requirements.txt` 里加 `--no-binary=...` 这类会触发源码编译的选项。需要编译的包（`jieba_fast` / `pyopenjtalk` 等）一律预编译成 wheel 放 `tools\wheels`,让交付机零编译器也能装。

## 训练 Pipeline

### 数据流

```
原始音频 → [人声提取] → [切片] → [ASR] → [预处理] → [S1训练] → [S2训练] → 模型
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
  "batch_size": "auto",
  "learning_rate": "default"
}
```

> 保存间隔取 S1=4 / S2=5，保证最终 epoch（8%4=0、25%5=0）必落 checkpoint。
> `batch_size:"auto"` 按显存自适应、`learning_rate:"default"` 用引擎内置 LR；二者与其余 `training.*`/`steps.*.params` 键均可经 `customParams` 逐次覆盖（透传给 `s1_train.py` yaml / `s2_train.py` json）。
> 若存在外部 `data/training_defaults.json`，其值覆盖内置默认；仅影响变更后新建的任务，已有 recipe/历史任务不追溯改写。

> **可调参数面**：S1 侧 `gpt_epochs / batch_size / s1_save_every_n_epoch / precision / gradient_clip / seed / lr / lr_init / lr_end / warmup_steps / decay_steps / max_eval_sample / max_sec / num_workers`，S2 侧 `sovits_epochs / s2_save_every_n_epoch / batch_size / versions[]`（一次多版本），另有**编排级**能力：UVR5 多级链（每级 `model/agg/tta/postprocess/precision`）、按语种 ASR 引擎路由、从第 X 步续跑 / 断点续训。默认对外只暴露上面的简化子集，高级项走 `customParams` 透传。

> **v1.0.7 变更**：`pauseAfterDenoise`（人声提取后暂停试听闸门）后端默认由 `true` 改为 **`false`**——仅影响**直接调 API/CLI 且不带该字段**的调用方。

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

无需先微调即可直接用预训练底模推理。项目内置一个**虚拟音色 `Base model`（即底模）**
（id `__base__`，内存态、不落 `voices.json`、无资产目录）：**出现在 Generate 的 Voice
下拉里并默认选中，但不出现在 Assets 管理页**。GPT 固定 `Base model_s1`，SoVITS 三选
`Base model_v2 / _v2Pro(默认) / _v2ProPlus`（磁盘缺失的版本自动从下拉剔除）。语言为
Auto（自动多语言）。底模自身无参考音频，勾选「Use reference from another voice」即可
借用其它资产的切片 / raw 作参考。**Compare Refs** 每行的 VOICE ID 下拉也可选 `Base model`。

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
  - **参考音频留驻**：`TTS.py` 内置**带戳参考音频 LRU**，缓存最近 N 个参考音频的
    `prompt_semantic / refer_spec`，命中即恢复、**零重抽零权重重载**。每条缓存戳上当时的
    SoVITS 权重路径 + `is_v2pro`（语义依赖 SoVITS 码本），**切 SoVITS 不清空整表**——不同常驻
    音色的参考音频可同时保持热，正是多音色 recipe 轮转想要的。容量 `AURIVOX_REF_CACHE`（默认 8，`0`=关）。

> 环境变量小抄：`AURIVOX_TTS_BATCH_SIZE=4` · `AURIVOX_MAX_QUEUE=32` · `AURIVOX_RETRY_AFTER=3` · `AURIVOX_REF_CACHE=8`。
> 详见 `BROKER_streaming_and_residency.md` 与最终用户向的 [FAQ · Q14](./GUIDANCE.md#faq)。

### 本地 Broker / 可信内网接口加固（v1.0.7）

面向对外/无人值守部署的一组**加性、向后兼容**的 broker 能力（引擎 Python 未动，Web UI 行为不变）：

- **OpenAI 兼容模型列表**：`GET /v1/models`（列出所有 recipe + `__base__`）与 `GET /v1/models/<id>`（单个，未知 → 404）。列出的 `id` 现可**直接**当作 `POST /v1/audio/speech` 的 `model` 字段用（`model` 缺省回退到 broker 原有的 `voice`，两者同时给时 `voice` 优先）。
- **优雅停机**：`SIGINT`/`SIGTERM` 停止收新请求、等 in-flight 生成结束再退出；上限 `AURIVOX_SHUTDOWN_GRACE_MS`（默认 120000）。请求体带 `interrupted:true` 时主动**中止正在进行的引擎请求**（非流式经 `AbortController` 取消上游、流式经 socket 断开），不再干等上游结束。
- **可配置 CORS**：`AURIVOX_CORS_ORIGIN`（默认 `http://127.0.0.1:5173`；逗号分隔多域，或 `*`）。
- **`/api/health` 版本字段**：新增 `version`（取自 `package.json`，如 `"1.0.7"`）。
- **全局 JSON 错误中间件**：坏 JSON / 未捕获错误统一返回 `application/json` 错误体，不再吐 HTML 错误页。
- **文件日志**：`console.*` 同时 tee 到 `logs/aurivox-<日期>.log`（按天滚动）。`AURIVOX_LOG_DIR`（默认 `logs/`）、`AURIVOX_LOG_FILE=0` 关闭。

> 环境变量小抄（v1.0.7 新增）：`AURIVOX_CORS_ORIGIN=http://127.0.0.1:5173` · `AURIVOX_SHUTDOWN_GRACE_MS=120000` · `AURIVOX_LOG_DIR=logs` · `AURIVOX_LOG_FILE=1`。
> 详见 `CHANGES-1.0.7.md` 与最终用户向的 [FAQ · Q15](./GUIDANCE.md#faq)。

## 模型文件

| 文件 | 大小 | 说明 |
|------|------|------|
路径均相对项目根目录，与 `lib/paths.js` 中的常量一致。底模按版本分目录存放：
`v1/` `v2/` `v2Pro/` `v2ProPlus/`。GPT（S1）底模上游只有两份，v2 / v2Pro / v2ProPlus
共用 v2 的那一份，因此它位于 `v2/` 下，两个 Pro 目录只放 SoVITS 权重。

| 文件 | 大小 | 说明 |
|------|------|------|
| `models/tts/gpt-sovits/v2/s1bert25hz-5kh-*.ckpt` | ~150MB | S1 预训练（v2 / v2Pro / v2ProPlus 共用） |
| `models/tts/gpt-sovits/v1/s1bert25hz-2kh-*.ckpt` | ~150MB | S1 预训练（v1） |
| `models/tts/gpt-sovits/v2Pro/s2Gv2Pro.pth` | ~680MB | S2 Generator 预训练 |
| `models/tts/gpt-sovits/v2Pro/s2Dv2Pro.pth` | ~550MB | S2 Discriminator 预训练 |
| `models/tts/gpt-sovits/chinese-hubert-base/` | ~300MB | Hubert 特征提取 |
| `models/tts/gpt-sovits/chinese-roberta-wwm-ext-large/` | ~1.3GB | 文本 BERT 特征 |
| `models/asr/faster-whisper/large-v3-turbo/` | ~1.6GB | ASR 模型 |
| `models/separation/uvr5/vr\|mdx\|roformer/` | 按需 | 人声分离权重，按架构分目录 |

若本机仍是旧的 `gsv-v2final/` + `v2Pro/` 混放布局，运行
`tools/scripts/Move-BaseModels.ps1` 迁移（默认只预演，加 `-Apply` 才实际移动）。

## 已知限制

1. **S2 训练数据格式**: 需要 `2-name2text-0.txt`（tab 分隔 4 列）
2. **安装路径**: 必须解压到纯英文、无空格路径；中文/特殊字符路径会导致嵌入式 Python 无法定位
3. **原生库加载顺序**: 部分 Windows 机器上 `torch` 先于 `librosa` 导入会触发原生崩溃
   （0xC0000005 / 退出码 3221225477，日志为空）；已在所有入口强制 librosa 先行修复
4. **音频格式与声道**: 训练素材优先用 **wav（单声道最佳）**。加载层已统一把多声道自动下混为单声道（Python
   `soundfile` + `mean(axis=1)`，**不依赖 ffmpeg**），避免立体声导致 HuBERT 特征提取崩溃；无法读取的压缩格式
   （mp3/m4a/aac）由 ffmpeg 兜底解码。每次预处理结束会打印一行
   `[load_audio] total=.. loaded=.. (downmixed=.. resampled=.. via_ffmpeg=..) failed=..` 统计，便于核对有效条数。
   部署时下载的 `vendor/ffmpeg`，**v1.0.7 起**会对所有 Python 子进程可见（见「环境要求」与 [`CHANGELOG.md`](./CHANGELOG.md)）；仅当自带
   与系统 ffmpeg 均缺失时，这类格式才会被跳过并计入 `failed`。
5. **UVR5 MDX-Net 显存**: MDX-Net 是 UVR5 里最吃显存的模型，长音频 + 大 batch 极易 OOM
   （`cudaErrorMemoryAllocation`）。**默认参数按 4 GB 小显存设计（逐窗 batch=1）**；大显存显卡可自行调大分段/批。
   仍 OOM 时把 MDX 段切到 CPU（`UVR5_MDX_DEVICE=cpu`）。详见 [FAQ · Q10](./GUIDANCE.md#faq)。
6. **Roformer 权重与配置配套**: Mel-Band / BS-Roformer 需 `.ckpt` 与其**配套 `.yaml`** 同名成对放入
   `uvr5_weights\`；缺配置时 loader 退回默认配置，会因结构不符报「missing params」而加载失败。见 [FAQ · Q11](./GUIDANCE.md#faq)。
7. **FunASR 无置信度**: FunASR/Paraformer 为非自回归结构，默认不输出逐词后验，校对页置信度**如实留空、不着色**
   （非错误）；需置信度高亮请用 Faster Whisper。见 [FAQ · Q8](./GUIDANCE.md#faq)。

## FAQ
详情请查看[`GUIDANCE.md`](./GUIDANCE.md)。

## 变更历史
README 不再内嵌逐版本 changelog。请查看 [`CHANGELOG.md`](./CHANGELOG.md)。
