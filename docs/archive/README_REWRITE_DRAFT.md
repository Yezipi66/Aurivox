# Aurivox

> 本地语音合成（TTS）工作台：音色资产管理、微调训练与 OpenAI 兼容推理服务。
> 开源协议：AGPL-3.0。

> 说明：本文档中的 `{{...}}` 均为**待补全的占位符**（命令 / 路径 / 地址），请按实际部署环境填写。仓库内部已存在的脚本与文件按原名引用，未虚构任何不存在的脚本。

## 项目用途

Aurivox 是一个 **local-first** 的语音合成工作台，面向在本地运行 GPT-SoVITS 等引擎的场景，提供三类核心能力：

- **微调训练**：人声提取 → 切片 → ASR → 预处理 → S1(GPT) → S2(SoVITS) 全链路训练管线，带断点续训与失败恢复。
- **音色资产管理**：已发布角色资产的登记、检索与版本管理（注册表为 `data/voices.json`，资产目录为 `assets/{voiceId}/`）。
- **OpenAI 兼容推理**：内置自包含推理服务，对外暴露 `/v1/audio/speech` 等兼容接口，可被标准 OpenAI 客户端直接调用；并支持多引擎（GPT-SoVITS / IndexTTS2 / CosyVoice 等）接入，以及并发 / 流式 / 有界排队等能力。

## 安装步骤

环境要求（请按实际补全）：

- 操作系统：`{{目标操作系统}}`（上游以 Windows 10/11 x64 为主；NVIDIA CUDA 推理 / 训练为正式支持路径）
- 运行时：Node.js `>= 18`；Python 以项目内置可重定位 Python 为主，通常无需自行安装
- GPU：训练 / 微调需 NVIDIA GPU（CUDA 12.1+ 推荐）；推理可回退 CPU（明显更慢）

安装流程：

1. 获取源码 / 分发包：
   ```bash
   {{获取方式 / 安装目录}}
   ```
2. 运行部署向导（自动建虚拟环境、装依赖、下载模型并自检）：
   ```bash
   {{部署命令}}
   ```
   - 该步骤会创建 Python 虚拟环境、安装依赖（含 PyTorch）、下载模型权重与 ffmpeg，并做自检。
3. 如需对外提供 MP3 / Opus / AAC / FLAC 等转码输出，确保 ffmpeg 可用（推理引擎本体只出 WAV）。
4. 验证安装：
   ```bash
   {{安装校验命令}}
   ```

> 依赖锁定：Python 依赖以 `requirements-gpt-sovits.txt`（完整 `pip freeze` 精确 pin）为准；`torch` 等大体量 GPU 专属包由 `tools/cli/install-torch.js` 单独安装。

## 运行方式

启动（前端 + 后端 + 推理引擎一并拉起）：

```bash
{{启动命令}}
```

- 启动后后端默认监听 `{{后端地址}}`（上游默认 `http://127.0.0.1:9886`），前端 `{{前端地址}}`。
- 浏览器打开 `{{前端访问地址}}` 即可使用界面。
- 后台进程由启动器管理，关闭终端窗口不影响已拉起的服务。

仅启动部分引擎（可选）：

```bash
{{仅启动指定引擎的命令（如设置 ENGINE_IDS）}}
```

停止：

```bash
{{停止命令}}
```

开发模式（修改前端 / 后端时）：

```bash
{{Node 依赖安装命令}}   # 例：npm install
{{后端开发启动命令}}     # 例：node server.js
{{前端开发启动命令}}     # 例：cd web && npm run dev
```

## 使用示例

1. **界面操作（推荐）**
   - 打开 `{{前端访问地址}}` → 在「Generate」页选择音色 → 输入文本 → 生成语音。
   - 训练：在「Train」页新建任务，按向导完成人声提取、切片、ASR、预处理与 S1 / S2 训练。

2. **OpenAI 兼容接口（命令行）**

   调用 `/v1/audio/speech` 生成语音：

   ```bash
   curl {{后端地址}}/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"model":"{{recipe 或音色 id}}","input":"{{待合成文本}}","response_format":"wav"}' \
     --output out.wav
   ```

   流式生成：

   ```bash
   curl -N {{后端地址}}/v1/audio/speech \
     -H "Content-Type: application/json" \
     -d '{"model":"{{recipe 或音色 id}}","input":"{{待合成文本}}","response_format":"wav","stream":true}' \
     --output out.wav
   ```

   查询模型列表：

   ```bash
   curl {{后端地址}}/v1/models
   ```

   查询健康状态：

   ```bash
   curl {{后端地址}}/api/health
   ```

## 关键配置说明

运行时配置集中存放在 `data/`（该目录不进版本库，文件在首次运行时生成），主要包括：

- `data/voices.json`：音色注册表
- `data/training_defaults.json`：训练任务的默认参数（覆盖内置默认值）
- `data/advanced_params.json`：可被覆盖的默认高级参数
- `data/app-config.json`：本地配置

路径权威定义集中在 `lib/paths.js`，其它模块统一从此处取常量，不要自行拼接目录。

引擎的端口、底模位置由各引擎自己的名片 `engines/<id>/manifest.json` 声明（字段 `default_base_url` / `runtime.checkpoints`）；新增引擎可参考 `engines/_TEMPLATE/manifest.json`。请以名片为准，不要手抄端口。

常用环境变量（均为可选项，括号内为上游默认）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` / `BROKER_PORT` | 后端监听端口 | `9886` |
| `HOST` / `BROKER_HOST` | 后端监听地址 | `127.0.0.1` |
| `GPT_SOVITS_BASE_URL` | GPT-SoVITS 推理地址 | `http://127.0.0.1:9880` |
| `AURIVOX_TTS_BATCH_SIZE` | 单请求内并行段数 | `4` |
| `AURIVOX_MAX_QUEUE` | 生成排队上限（`0`=不限） | `32` |
| `AURIVOX_RETRY_AFTER` | 过载时 `Retry-After`（秒） | `3` |
| `AURIVOX_REF_CACHE` | 参考音频 LRU 容量（`0`=关） | `8` |
| `AURIVOX_CORS_ORIGIN` | 允许的跨域来源（逗号分隔 / `*`） | `http://127.0.0.1:5173` |
| `AURIVOX_SHUTDOWN_GRACE_MS` | 优雅停机宽限（毫秒） | `120000` |
| `AURIVOX_LOG_DIR` | 文件日志目录 | `logs/` |
| `ENGINE_IDS` | 仅启动指定引擎（逗号分隔） | 全部 |

## 常见问题

> 完整 FAQ 见 `docs/GUIDANCE.md`。以下为按本仓库结构整理的高频项：

1. **首次部署很慢 / 中途失败怎么办？**
   部署向导支持续跑，已安装的组件会被跳过，重跑 `{{部署命令}}` 即可。

2. **需要 ffmpeg 吗？**
   引擎本体只输出 WAV；如需 MP3 / Opus / AAC / FLAC 等转码输出，需要 ffmpeg 可用。

3. **没有 NVIDIA 显卡能用吗？**
   推理可回退 CPU（明显更慢）；训练 / 微调与人声分离（UVR5）需 NVIDIA GPU，不保证 CPU 可用。

4. **多引擎端口冲突 / 想只起部分引擎？**
   用 `ENGINE_IDS` 指定要启动的引擎；具体端口以 `engines/<id>/manifest.json` 的 `default_base_url` 为准。

5. **生成请求过载返回 503？**
   属有界排队保护（队列满）。等待 `Retry-After` 头指示的秒数后重试；可调大 `AURIVOX_MAX_QUEUE`。

6. **训练素材音频格式有要求吗？**
   优先 WAV（单声道最佳）；多声道会被自动下混为单声道；mp3 / m4a / aac 等压缩格式依赖 ffmpeg 兜底解码。

## 已知限制

- **训练数据格式**：S2 训练需要 `2-name2text-*.txt`（tab 分隔 4 列）作为输入。
- **安装路径**：上游曾要求解压到纯英文、无空格路径；当前版本已放宽，但在非 ASCII 路径下仍可能触发警告，建议放在纯英文路径。
- **原生库加载顺序**：部分 Windows 机器上 `torch` 先于 `librosa` 导入可能触发原生崩溃，已在入口强制 `librosa` 先行修复。
- **音频格式与声道**：训练素材优先 WAV 单声道；压缩格式解码依赖 ffmpeg。
- **UVR5 MDX-Net 显存**：人声分离中最吃显存；长音频 + 大 batch 易 OOM，默认参数按 4GB 小显存设计（逐窗 batch=1）。
- **Roformer 权重配套**：Mel-Band / BS-Roformer 需 `.ckpt` 与其配套 `.yaml` 同名成对放置，缺配置会加载失败。
- **FunASR 无置信度**：非自回归结构默认不输出逐词后验，校对页置信度留空（非错误）。
- **引擎串行**：推理仍为单卡串行，不要用并发调用打同一个引擎实例（会污染模型内部状态）。
