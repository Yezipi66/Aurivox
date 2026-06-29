# TTS Broker 推理自包含改造方案（给本地 agent）

> 文档对象：本地代码编辑 agent
> 角色分工：代码拥有者（审阅 / 决策）→ 本文档 → 本地 agent（实现 + GPU 实测）
> 目标：**让本项目不再依赖外部 `D:\AI\GPT-SoVITS-v2pro-20250604` 引擎即可完成推理（语音合成）**，使整个项目可独立分发。

---

## 0. 背景与问题

当前架构里，**推理 100% 依赖外部引擎**：

```
前端 :5173 / 后端 server.js :9886
        │
        │  HTTP 调用（POST /tts, GET /set_gpt_weights ...）
        ▼
  外部引擎  D:\AI\GPT-SoVITS-v2pro-20250604\api_v2.py  :9880   ← 真正合成语音的代码，不在本仓库
```

证据：
- `server.js:16` `GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880"`
- `server.js` 通过 `gsvPost("/tts")` / `gsvGet("/set_gpt_weights")` 把请求转发给外部引擎
- `start.ps1` / `start.bat` 硬编码 `$ENGINE_DIR = "D:\AI\GPT-SoVITS-v2pro-20250604"` 并启动它的 `api_v2.py`
- 本仓库 `grep -i infer|api_v2|TTS_infer` → **零命中**，确认没有任何推理代码

**后果**：
1. 换台机器、对外分发时，外部引擎路径失效，推理整体不可用。
2. 训练产出的模型要靠外部引擎加载，一旦格式不符就报错（见近期 `KeyError: 'config'`）。

---

## 1. 改造目标（必须达成）

把推理能力**搬进本仓库**，由本项目自己提供一个本地推理服务，使 `server.js` 调用 `http://127.0.0.1:9880` 时命中的是**我们自己的进程**，而不是外部 `D:\AI\...`。

完成后：
- 删除/解除对 `D:\AI\GPT-SoVITS-v2pro-20250604` 的依赖（启动脚本不再启动它）。
- 项目可整体打包分发，目标机器只需准备 Python 环境 + 底模（已有训练底模即可复用）。

---

## 2. 关键发现（降低工作量，务必先读）

### 2.1 推理所需的"模型架构代码"本仓库**已经有了**
训练时 vendored 的 `lib/training/gsv_code/` 已包含推理需要的全部模型定义：

| 推理需要的组件 | 本仓库现成位置 |
|---|---|
| GPT (Text2Semantic / T2S) 模型 | `lib/training/gsv_code/AR/models/` |
| VITS (SoVITS) 生成器 `SynthesizerTrn` | `lib/training/gsv_code/module/models.py` |
| HuBERT 特征提取 | `lib/training/gsv_code/feature_extractor/cnhubert.py` |
| 文本前端（清洗 / 分词 / g2p / 多语言） | `lib/training/gsv_code/text/` |
| 量化 / core_vq / commons 等 | `lib/training/gsv_code/module/` |

> ⚠️ 这意味着 **不需要重新 vendor 模型架构**，推理编排代码可直接 import 这些模块。但要注意 import 路径（见 §3.1）。

### 2.2 底模与训练**共用**，已在用户机器上，**不需再塞进包**
`lib/training/model_paths.json` 已声明底模路径（运行时存在于 `lib/training/gsv-tools/pretrained/`）：
- `chinese-hubert-base`（推理也用）
- `chinese-roberta-wwm-ext-large`（BERT，推理也用）
- `v2Pro/s2Gv2Pro.pth`、`bigvgan/` 等

推理直接复用这批路径即可，**自包含不需要额外分发 GB 级模型**。

### 2.3 后端依赖的引擎接口契约（必须 1:1 复刻）
本地推理服务必须实现以下 HTTP 接口，保持与现 `server.js` 调用完全兼容：

| 方法 | 路径 | 用途 | 调用点 |
|---|---|---|---|
| `GET`  | `/` | 健康检查（返回 200 即视为 online） | `server.js:722` |
| `POST` | `/tts` | 主推理，入参见 §2.4，返回 WAV 字节流 | `server.js:702, 1471` |
| `GET`  | `/set_gpt_weights?weights_path=` | 切换 GPT 权重 | `switchModels()` |
| `GET`  | `/set_sovits_weights?weights_path=` | 切换 SoVITS 权重 | `switchModels()` |

> 这正是标准 GPT-SoVITS `api_v2.py` 的接口集；复刻它即可，server.js **无需改接口**。

### 2.4 `/tts` 入参（来自 `buildTtsPayload`，server.js:621）
本地推理服务必须接受这些字段（多余字段忽略即可）：
```
text, text_lang, ref_audio_path, aux_ref_audio_paths, prompt_text, prompt_lang,
top_k, top_p, temperature, repetition_penalty, seed,
speed_factor, text_split_method, batch_size, batch_threshold, split_bucket,
fragment_interval, parallel_infer, sample_steps, if_sr, super_sampling,
media_type, streaming_mode, overlap_length, min_chunk_length
```
默认值兜底已在 server.js 处理，推理端按这些语义实现即可。

---

## 3. 任务分解

### Task 1 — vendor 推理编排代码到 `lib/inference/`【P0】
从标准 GPT-SoVITS（与训练同版本 v2pro）取**推理编排层**代码，放入新目录 `lib/inference/`：

需要的核心文件（来自 GPT-SoVITS 的 `GPT_SoVITS/TTS_infer_pack/`）：
- `TTS.py`（核心推理类 `TTS`，加载权重 + GPT→VITS 流水线）
- `text_segmentation_method.py`（`text_split_method` / `cut5` 等）
- `TextPreprocessor.py`（文本前端编排）
- 以及一个 HTTP 服务入口（对应 `api_v2.py`）→ 建议命名 `lib/inference/infer_server.py`

**关键约束**：
- 这些文件原本 `from GPT_SoVITS.xxx import ...`。改造为 import 本仓库已有的 `gsv_code` 模块（§2.1），**不要再 vendor 一份重复的模型代码**。
  - 例如 `module.models` → `lib/training/gsv_code/module/models.py`
  - `feature_extractor.cnhubert` → `lib/training/gsv_code/feature_extractor/cnhubert.py`
  - `text.*` → `lib/training/gsv_code/text/`
- 统一通过 `sys.path` 或一个 import shim 解决路径，避免散落的相对 import 失效。
- 若模型定义在训练版与推理版有细微差异（如 `models.py` 的 forward 分支），**以能正确加载推理权重为准**，必要时在推理侧做适配，不要破坏训练用到的同一文件。

### Task 2 — 实现本地推理 HTTP 服务【P0】
`lib/inference/infer_server.py`：
- 用 FastAPI/uvicorn（`api_v2.py` 即此栈）或 Flask，监听 `127.0.0.1:9880`。
- 实现 §2.3 的 4 个接口；`/tts` 接受 §2.4 入参，返回 `audio/wav` 字节流。
- 启动参数对齐现状：`-a 127.0.0.1 -p 9880 -c <tts_infer.yaml>`。
- **底模路径**：读取本仓库的 `lib/training/model_paths.json`（cnhubert_base、bert）或新建 `lib/inference/infer_config.json`，指向**已有底模**，不要硬编码 `D:\AI\...`。

### Task 3 — 推理配置文件本地化【P0】
现引擎用 `D:\AI\...\GPT_SoVITS\configs\tts_infer.yaml`。新建本仓库内的等价配置 `lib/inference/tts_infer.yaml`：
- `bert_base_path` → 指向 `lib/training/gsv-tools/pretrained/chinese-roberta-wwm-ext-large`
- `cnhubert_base_path` → 指向 `.../chinese-hubert-base`
- `t2s_weights_path` / `vits_weights_path` → 留空或指向某个默认音色，由 `switchModels()` 运行时通过 `/set_*_weights` 覆盖
- 路径一律相对仓库根，禁止绝对盘符路径。

### Task 4 — server.js 解除外部依赖【P1】
- `GPT_SOVITS_BASE_URL` 默认保持 `http://127.0.0.1:9880` 即可（我们自己的服务也监听这里），**无需改后端接口逻辑**。
- 确认 `.env` / 配置不再要求外部引擎路径。
- 健康检查、`/set_*_weights`、`/tts` 调用维持不变。

### Task 5 — 启动脚本改造【P1】
`start.ps1` / `start.bat` / `run_start.bat`：
- 删除 `$ENGINE_DIR = "D:\AI\GPT-SoVITS-v2pro-20250604"` 及启动其 `api_v2.py` 的逻辑。
- 改为启动**本仓库**的推理服务：
  ```
  <项目venv>\python.exe lib\inference\infer_server.py -a 127.0.0.1 -p 9880 -c lib\inference\tts_infer.yaml
  ```
- 保留"等待 :9880 ready"的探活逻辑（已有）。
- 前端仍走已修好的生产构建方案（由后端 :9886 托管，见此前改动）。

### Task 6 — 训练产物与推理对齐（已部分修复，需复核）【P1】
近期 `KeyError: 'config'` 根因：finalize 把缺 `config` 的 Lightning 原生 ckpt 误发布。
- 已在 `lib/training/steps/finalize.js` 修复（只发布 `/-e(\d+)\.ckpt$/` 的推理权重，跳过原生 ckpt）。
- **本地 agent 复核**：自建推理服务 `init_t2s_weights` 加载 GPT ckpt 时按 `dict_s1["config"]` 取配置 —— 确认我们训练产出的 `<voiceId>-e<N>.ckpt` 确实含 `{weight, config, info}`（`s1_train.py:62-69` 的 `my_save` 写入），二者格式必须吻合。
- 建议在推理侧对缺 `config` 的旧 ckpt 给出**明确报错信息**（指引重训），而非裸 KeyError。

### Task 7 — 依赖核对【P2】
- `requirements.txt` 已含推理依赖（transformers、pyopenjtalk、g2p、edge-tts 等）。核对推理服务实际 import 是否都覆盖，补齐缺失项（如 `fastapi`、`uvicorn`、`pydantic` 若未列）。
- 确认 `torch`/`torchaudio` 版本与训练一致（cu121, 2.2.0）。

---

## 4. 验收标准

1. **完全断开外部引擎**：删除/重命名 `D:\AI\GPT-SoVITS-v2pro-20250604` 后，运行 `start.ps1`，引擎步骤仍能在 :9880 起来（起的是我们自己的 `infer_server.py`），探活通过。
2. **健康检查**：`GET http://127.0.0.1:9880/` 返回 200。
3. **权重切换**：`GET /set_gpt_weights?weights_path=<某音色 ckpt>` 和 `/set_sovits_weights` 返回 200，无异常。
4. **端到端合成**：前端选一个已训练音色 → 输入文本 → 合成 → 听到正确音色语音；后端日志无 `/tts failed`。
5. **训练→推理闭环**：用修复后的 finalize 重新训练（或重跑收尾）产出的音色，能被自建推理服务直接加载并合成，**不再出现 `KeyError: 'config'`**。
6. **可分发性**：把整个项目目录拷到一台干净机器（仅装 Python venv + 放好底模），不接触任何 `D:\AI\...`，推理可用。

---

## 5. 风险与注意事项

- **import 地狱**：GPT-SoVITS 推理代码大量使用包内绝对 import（`from GPT_SoVITS...`）。务必统一用一个 path shim（在 `infer_server.py` 顶部把 `lib/training/gsv_code` 和 `lib/inference` 注入 `sys.path`），逐个修正，否则会连环 `ModuleNotFoundError`。
- **训练版 vs 推理版模型代码差异**：`gsv_code/module/models.py` 是训练用的 `SynthesizerTrn`，推理用的 forward / infer 方法可能略有不同。优先复用，差异处在推理侧适配；**禁止破坏训练已依赖的同一文件的训练路径**（改动需保证 `s2_train.py` 仍可用）。
- **v2pro 特性**：当前底模是 v2Pro（`s2Gv2Pro.pth` / `bigvgan`）。推理编排代码必须取**支持 v2Pro 的版本**，否则声码器对不上。以外部引擎 `GPT-SoVITS-v2pro-20250604` 的 `TTS_infer_pack` 为基准移植最稳妥。
- **设备/精度**：保留 `device: cuda` / `is_half: True` 配置项，对齐外部引擎行为。
- **无法在审阅环境实测**：模型架构改动 + GPU 推理必须在本地 GPU 机器验证，按 §4 逐条过。
- **不要重复 vendor**：模型/文本/特征代码已在 `gsv_code`，只 vendor"编排层 + HTTP 服务"，避免双份代码漂移。

---

## 6. 交付物（本地 agent 完成后请提供）

- 新增目录 `lib/inference/`（编排代码 + `infer_server.py` + `tts_infer.yaml` + 必要的 import shim）
- 改动文件清单：`start.ps1`、`start.bat`、`run_start.bat`、`requirements.txt`（如有补充）、`server.js`（若需）
- 一份简短的 `HANDOFF.md`，**逐条对照 §4 验收标准说明实测结果**（务必真实，避免只改文档不改代码 / 谎报修复）。
