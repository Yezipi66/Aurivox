# HANDOFF — TTS Broker 推理自包含改造

> 对应方案: `docs/SELF_CONTAINED_INFERENCE_PLAN.md`
> 目标: 本项目不再依赖外部 `D:\AI\GPT-SoVITS-v2pro-20250604` 引擎即可完成推理。
> 本文逐条对照方案 §4 验收标准给出**实测结果**。

---

## 1. 改造结果总览

推理能力已搬入本仓库 `lib/inference/`,由本项目自带的 `infer_server.py` 在
`127.0.0.1:9880` 提供与原 `api_v2.py` 1:1 兼容的 HTTP 服务。`server.js`
默认连 `http://127.0.0.1:9880`,无需改接口逻辑即命中我们自己的进程。
启动脚本不再启动外部引擎。

| Task | 内容 | 状态 |
|---|---|---|
| 1 | vendor 推理编排代码到 `lib/inference/` | ✅ |
| 2 | 实现本地推理 HTTP 服务 `infer_server.py` | ✅ |
| 3 | 推理配置本地化 `tts_infer.yaml` | ✅ |
| 4 | server.js 解除外部依赖 | ✅ (无需改代码, `.env.example` 更新注释) |
| 5 | 启动脚本改造 `start.ps1`/`start.bat` | ✅ |
| 6 | 训练产物与推理 ckpt 格式对齐 | ✅ (新增格式校验 + 检查脚本) |
| 7 | 依赖核对 `requirements.txt` | ✅ (补 fastapi/uvicorn/pydantic/starlette) |

---

## 2. 逐条对照验收标准 (方案 §4)

### §4.1 完全断开外部引擎
- `start.ps1` / `start.bat` 已删除 `$ENGINE_DIR = "D:\AI\GPT-SoVITS-v2pro-20250604"`
  及启动其 `api_v2.py` 的逻辑,改为:
  ```
  venv\Scripts\python.exe lib\inference\infer_server.py -a 127.0.0.1 -p 9880 -c lib\inference\tts_infer.yaml
  ```
- 保留原有"等待 :9880 ready (max 120s)"探活逻辑。
- **实测**: 运行 `run_start.bat`, 弹出 "TTS Inference Server" 窗口, 自动加载
  4 个模型 → `Uvicorn running on http://127.0.0.1:9880`; 主窗口打印
  `[1/3] ... Inference server is ready [OK]`。✅

### §4.2 健康检查
- `infer_server.py` 新增 `GET /` 路由 (原 api_v2.py 没有, 但 server.js:722 需要)。
- **实测**: `curl http://127.0.0.1:9880/` → `{"message":"infer_server online","version":"v2Pro"}` (200)。
- 前端右上角显示绿色 **"GPT-SoVITS Connected"**。✅

### §4.3 权重切换
- `GET /set_gpt_weights?weights_path=` 与 `GET /set_sovits_weights?weights_path=` 已实现。
- **实测**: 前端切换音色 (Raiden, GPT=Raiden-e20.ckpt, SoVITS=Raiden_e12_s732.pth)
  触发 `switchModels()` → 两接口 200, 推理正常。✅

### §4.4 端到端合成
- **实测**: 前端选 Raiden 音色 + 日语参考音频 → 输入日语长句 (64 字, 切成 3 段)
  → Generate → 合成 11 秒音频, 可正常播放、可下载 WAV, 音色正确。
- 后端日志无 `/tts failed`。✅

### §4.5 训练→推理闭环 (无 KeyError: 'config')
- `init_t2s_weights` 加载 GPT ckpt 时读 `dict_s1["config"]`。已新增**格式校验**:
  检测到 PyTorch-Lightning 原生 ckpt (有 `state_dict` 无 `config`) 时抛出
  清晰中文报错 (指引用 finalize 的 `-e<N>.ckpt` 或重训), 而非裸 `KeyError`。
- 提供 `lib/inference/check_ckpt.py` 自动扫描 `assets/*/gpt_checkpoints/*-e*.ckpt`。
- **实测**: 已发布音色 (Platinum-e20, Raiden-e20, LaPlama-e0) 均为
  `{weight, config, info}` 格式, 可被直接加载并合成。✅
- 备注: 扫描发现 2 个旧的 Lightning 原生 ckpt (LaPlama-e2, Shamare_ja-e2),
  为 finalize 修复前/绕过流程的产物, 由用户删除后重训。新格式校验确保此类
  文件若被加载会给出友好报错而非崩溃。

### §4.6 可分发性
- `tts_infer.yaml` 全部使用相对路径 (`./lib/training/gsv-tools/pretrained/...`),
  零 `D:\AI\...` 绝对路径。
- SV 底模路径 (`sv.py`) 改为基于项目相对解析, 支持 `SV_CKPT_PATH` 覆盖。
- `requirements.txt` 已补齐 HTTP 服务依赖。
- 底模与训练共用, 已在 `lib/training/gsv-tools/pretrained/` 下, 无需额外分发。
- **状态**: 目录可整体拷贝, 目标机仅需 Python venv + 底模 + SV 底模即可推理。✅
  (注: SV 底模 `pretrained_eres2netv2w24s4ep4.ckpt` 因 `.gitignore` 排除 `*.ckpt`,
   需随底模一起分发, 不进 git。)

---

## 3. 关键技术决策与坑 (供后续维护)

1. **sys.path 模型**: `infer_server.py` 注入两条路径 —— `lib/training`
   (使 `gsv_code` 可作为包 import) 与 `lib/inference` (TTS/sv/BigVGAN/sr/
   TTS_infer_pack), 再 `os.chdir(PROJECT_ROOT)` 使 yaml 相对路径生效。

2. **import 本地化**: vendored 的 `TTS.py` / `TextPreprocessor.py` 原用
   `from GPT_SoVITS.xxx` / 裸 `from text.xxx`, 已全部改为 `gsv_code.` 前缀,
   复用训练侧已有模型代码, 不重复 vendor。

3. **BigVGAN 完整复制**: V3+ 声码器依赖 `activations/utils0/env/meldataset/
   alias_free_activation` 等, 需整目录 vendored。

4. **Windows OpenMP/MKL DLL 冲突 (重要)**: numpy/soundfile/sklearn 各自捆绑
   OpenMP 运行时, 若在 torch 之前 import, 会与 torch 的 OpenMP 重复, 导致首次
   torch 重运算时**静默 access violation 崩溃 (无 Python traceback)**。
   解决: `infer_server.py` 顶部 (numpy 等之前) 先 `import torch` 并设
   `KMP_DUPLICATE_LIB_OK=TRUE`。

5. **NUMBA_CACHE_DIR**: librosa→numba 默认往只读的 site-packages 写缓存,
   Windows 上报 PermissionError。`infer_server.py` 自动设为项目内 `.numba_cache`。

6. **SV (v2Pro 必需)**: 加载 VITS 权重时若 model_version 含 "Pro" 会触发
   SV 模型加载, 需 `pretrained_eres2netv2w24s4ep4.ckpt`。`sv.py` 已改为
   项目相对路径 + 文件缺失时友好报错。

7. **speed_factor**: 默认 1.0 为中性 (模型内置保音调变速, 直接传入 vits decode)。
   `speed_change(np.interp)` 为死代码 (调用处注释)。若未来启用 np.interp 路径,
   会改变音调 (resample), 建议改用 `librosa.effects.time_stretch`。

---

## 4. 本次改动文件清单

新增 (`lib/inference/`):
- `infer_server.py` — FastAPI 推理服务 (本地化自 api_v2.py)
- `tts_infer.yaml` — 本地配置 (v2Pro, 相对路径)
- `sv.py` — SV 接口 (路径本地化)
- `TTS.py` / `TextPreprocessor.py` — import 本地化 + ckpt 格式校验
- `check_ckpt.py` — 训练产物 ckpt 格式自检工具
- 及 vendored: `TTS_infer_pack/`, `BigVGAN/`, `sr/`, `ERes2Net*.py`, `kaldi.py` 等
- `lib/training/gsv_code/tools/i18n/` — 国际化支持

修改 (项目根):
- `start.ps1` / `start.bat` — 启动自包含推理服务, 不再启动外部引擎
- `.env.example` — 更新注释 (去掉 "start api_v2.py separately")
- `requirements.txt` — 补 fastapi==0.137.2 / uvicorn==0.49.0 / pydantic==2.13.4 / starlette==1.3.1
- `web/src/App.jsx` — 修复 GenerateTab 缺失 12 个高级推理参数 state 声明
  (`batchSize is not defined` 运行时错误); 需 `npm run build` 重建前端

---

## 5. 已知遗留 (非本次推理改造范围, 待后续)

1. **音色首启需手动 scan**: 校验红叉 (GPT/SoVITS Model ✗) 与首次推理
   "voice not found" 同源 —— 每音色的 `meta.json` (含 checkpoint 索引) 仅在
   扫描时生成。建议: server.js 启动时自动跑一次 `assetScanner.fullScan()`,
   或检测到音色目录缺 `meta.json` 时自动补扫。属 server.js 既有行为, 与引擎无关。

2. **f5_tts / gradio 等推理特有依赖**: 当前 infer_server.py 未实际用到,
   保留在 requirements.txt 以兼容其它流程。
