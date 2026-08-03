# Aurivox 1.0.6 — 更新说明（补丁式 / git apply）

**交付形式**：整个 1.0.6 大版本**只有一个补丁**（patch，unified diff），后端 + 前端 + 文档一起，
方便你作为一个更新包分发。用 `git apply` 打到你现有仓库上，只改动下面 8 个文件的对应行；其余一律不动。

> **应用时会分两组独立打**（脚本自动做，你无需拆分）：
> **代码组**（`.js`/`.py`/`.json`/`.jsx`，6 文件）是**硬性要求**——对不上就**中止、什么都不改**；
> **文档组**（`README.md` / `GUIDANCE.md`）是**尽力而为**——如果你本地手改过（哪怕只敲了个空格回车）导致对不上，
> **只跳过文档、代码照常更新**，绝不会因为文档小差异而拦住整个更新。两组各自还会识别「已打过」。

- 版本：`package.json` `1.0.5 → 1.0.6`
- **单一补丁**：`aurivox-1.0.6.patch`（11 文件，+349/−14）
- 应用：双击 `应用更新_apply.bat`（或 `apply_patch.ps1`）；回滚：双击 `回滚更新_rollback.bat`（或 `rollback_patch.ps1`）
- **打完必须重建前端**（因为含 `web/` 改动）：`npm run build`（在 `web\` 下）或 `tools\build\01_build_frontend`，然后重启。脚本在应用成功后也会提示这一步。

> **如果你之前已单独打过后端那 5 个文件（`package.json` 已是 1.0.6）**：请先把这 5 个文件
> `git restore` 回 1.0.5 干净状态（`git restore package.json lib/http/http.js lib/util/mutex.js server.js lib/inference/TTS.py`），
> 再用本合并补丁一次性套上（前端 `Fields.jsx` 未被动过，无需 restore）。这样版本里就只有一个包。

---

## 一、怎么用（对齐版本 → check → 应用 → 备份/可回滚）

**最省事（Windows 双击）**：把本更新包整个文件夹放进 Aurivox 项目目录内（放哪层都行，
脚本会自动向上找到含 `package.json` 的仓库根），然后**双击 `应用更新_apply.bat`** 即可。
回滚就双击 `回滚更新_rollback.bat`。

命令行等价（在**仓库根目录**，有 `package.json` 那层）：

```powershell
powershell -ExecutionPolicy Bypass -File apply_patch.ps1
```

> `.bat` 只是免去手敲 PowerShell、绕过执行策略；实际逻辑全在 `apply_patch.ps1` / `rollback_patch.ps1`。
> 脚本会自动定位仓库根，无需你先 `cd`。

**交互行为**：`--check` 通过后会**先打印本次更新内容（What's new，中英双语），再按「代码组 / 文档组」
列出两组各自会 APPLY 还是 SKIP，然后停下来问 `Proceed? (Y/N)`**，确认才应用
（想无人值守可加 `-Yes`：`apply_patch.ps1 -Yes`）。若某组**已经打过**，脚本会用反向 `git apply -R --check`
识别出来并跳过；两组都无事可做时提示「ALREADY APPLIED — nothing to do」正常退出，而不是报错。

脚本按顺序做：
1. 确认在仓库根、`git` 可用，并打印当前 `package.json` 版本（应为 1.0.5）；
2. 把补丁**拆成代码组 / 文档组**，各自 **`git apply --check`**（干跑）：
   代码组对不上→**中止且不改任何文件**（这是关键部分，必须一致）；
   文档组对不上→**仅跳过文档**，代码更新照常；
3. 打印更新内容 + 两组应用计划，停下来确认；
4. 把**将要改动**的文件**物理备份**到 `.patch-backup\<时间戳>\`（并记录当前 commit）；
5. **分两次 `git apply`**（代码组、文档组各一次）正式打补丁；
6. 列出改动文件，并提示**需重建前端**；文档组若被跳过也会明确告知。

**回滚**（随时）：
```powershell
# 方式 A：git 反向撤销（干净，首选）
powershell -ExecutionPolicy Bypass -File tools\rollback_patch.ps1
# 方式 B：从物理备份还原（git 不可用/文件被再次改动时用）
powershell -ExecutionPolicy Bypass -File tools\rollback_patch.ps1 -From .patch-backup\<时间戳>
```

手动核对（不想用脚本时）：
```powershell
git apply --check aurivox-1.0.6.patch   # 通过则可应用
git apply         aurivox-1.0.6.patch
git apply -R      aurivox-1.0.6.patch   # 撤销
```

> 打补丁后：后端 5 文件是纯 Python/Node 改动无需构建；但**前端 `Fields.jsx` 改了，必须重建 `web/dist`**
> （`npm run build` 或 `tools\build\01_build_frontend`）UI 文本才会出现。之后重启 `node server.js` 和 infer_server。
> 若 `--check` 失败：说明你的工作树和补丁基线不一致（这些文件有未提交改动，或已被改过）——
> 先 `git stash`/`git restore` 回干净状态再打，或据报错定位冲突行。

---

## 二、改动文件与内容（+349 / −14，11 文件）

| 文件 | +/− | 内容 |
|---|---|---|
| `package.json` | +1/−1 | 版本 1.0.5 → 1.0.6 |
| `lib/inference/TTS.py` | +90/−0 | ①模型留驻：参考音频带戳 LRU；②修既有 SoVITS 切换后陈旧语义 bug |
| `server.js` | +44/−4 | A-1 请求内并行默认；A-2 有界排队 + 503/Retry-After 接线 |
| `lib/util/mutex.js` | +25/−2 | A-2：Mutex 支持有界队列，满则同步抛 `GENERATION_QUEUE_FULL` |
| `lib/http/http.js` | +6/−1 | A-2：`HttpError` 支持可选响应头；`asyncHandler` 落地（用于 `Retry-After`） |
| `lib/routes/synthesis.js` | +17/−3 | **（后端）** `/api/generate` 新增 `engine_batch` 开关：整段单次 `/tts`、引擎并行批量，出单音频（无分段文件） |

| `web/src/components/common/Fields.jsx` | +23/−0 | **（前端，需重建 `web/dist`）** Broker「兼容 OpenAI 的语音 API」说明卡新增**中英双语**：`stream`（默认不落盘 / `persist:true` 存档 / 仅 wav·ogg）、「性能与并发」段（请求内并行 `batch_size`、模型留驻、503+`Retry-After` 过载保护及四个环境变量）、以及一个**流式调用 curl 示例**。已过 esbuild 语法校验。 |
| `web/src/components/generate/GenerateTab.jsx` | +12/−2 | **（前端，需重建）** Generate 页 Advanced Settings 新增 **Engine Batch（引擎批量并行）** 勾选框（中英双语 tooltip），随 `/api/advanced-params` 持久化。 |
| `web/src/components/compare/ReferenceCompareTab.jsx` | +25/−1 | **（前端，需重建）** Compare Refs 页 **总开关** + 每行**三态**（继承/开/关，默认继承）覆盖，随行状态持久化。 |
| `README.md` | +56/−0 | 新增「Broker 并发 / 流式 / 模型留驻」章节与 v1.0.6 changelog（含并行发生在哪一层、前端 `engine_batch` 用法、四个环境变量）。 |
| `GUIDANCE.md` | +49/−0 | 新增终端用户 Q14：请求内并行、**前端引擎批量开关**、流式（默认不落盘）与模型留驻。 |

> **A-1 前端引擎批量并行（`engine_batch`）**：`/api/generate`（Generate 与 Compare Refs 共用）默认「broker 切段 + 逐段串行」，几段之间不并行。勾选后走**整段单次 `/tts`**，由引擎按 `text_split_method` 切分并按 `batch_size` 并行批量——即 `/v1/audio/speech` 同款机制。**代价**：引擎内部拼接，**只出一个 `audio.wav`、无分段文件**，Node 侧 `concat`/`silence_ms` 失效（由引擎 `fragment_interval` 控制间隔）。**不并入 recipe 契约**（它是生成时的性能开关，不影响音色/文本可复现的字段）。为什么不用并发调用同一引擎：单实例引擎 `run()` 有共享状态（含本版留驻 LRU），并发会竞争污染 → 只能用引擎内 batch。

### ① 模型留驻（`TTS.py`，引擎侧，API/broker 零变化）
- 新增**带戳参考音频 LRU**（`self._ref_lru`）：缓存最近 N 个参考音频的
  `prompt_semantic / refer_spec[0] / raw_audio / raw_sr`，命中即恢复，**零重抽、零权重重载**。
- 每条缓存**戳上计算时的 SoVITS 权重路径 + is_v2pro**（`prompt_semantic` 依赖 SoVITS 码本）；
  戳不符=失效重算。**切 SoVITS 不清空整个 LRU**——不同常驻音色的参考音频可同时保持热，
  这正是「recipe 复杂多变、多音色轮转」想要的。
- 顺手修既有潜在 bug：`init_vits_weights` 切完 SoVITS 后置空 live 主槽 `ref_audio_path`，
  防止复用同一 ref 路径时 `run()` 跳过重抽、用到旧权重下的陈旧语义。

### ② A-1 请求内并行（`server.js`）
- 默认 `batch_size` **1 → 4**（`_DEFAULT_TTS_BATCH_SIZE`，同时改 `DEFAULT_ADVANCED_PARAMS`
  与 `buildTtsPayload` 兜底）。`parallel_infer` / `split_bucket` 本就默认 true。
- 效果：把**单个请求**里被 split 出的多段文本打包并行推，压单请求时延。
- **VRAM 逃生口**：低显存机器长文本可能 OOM → 设环境变量 `AURIVOX_TTS_BATCH_SIZE=1` 关掉。
  recipe / 高级参数仍可逐次覆盖。

### ③ A-2 有界排队（`mutex.js` + `http.js` + `server.js`）
- `Mutex` 新增 `maxPending`：**排队等待**的请求数（不含正在跑的那个）超过上限时，
  `runExclusive()` **同步抛** `GENERATION_QUEUE_FULL`，不再无限堆积。
- `withGenerationLock` 把它翻译成 **HTTP 503**，body `code: generation_queue_full`，
  并带 **`Retry-After`** 响应头（`asyncHandler` 现支持 `HttpError` 自定义头）。
- 两个合成入口（`/api/generate`、`/v1/audio/speech`）自动受益。

---

## 三、新增环境变量（都有安全默认，可不设）

| 变量 | 默认 | 作用 |
|---|---|---|
| `AURIVOX_TTS_BATCH_SIZE` | 4 | A-1 请求内并行度 / 显存旋钮（1 关闭批处理；范围 1–16） |
| `AURIVOX_MAX_QUEUE` | 32 | A-2 最多允许排队的请求数（0 = 不限，退回旧行为） |
| `AURIVOX_RETRY_AFTER` | 3 | A-2 返回 503 时的 `Retry-After` 秒数 |
| `AURIVOX_REF_CACHE` | 8 | 参考音频 LRU 容量（0 关闭）|

---

## 四、验证（沙箱内已做）
- `node --check` 通过：`server.js` / `lib/util/mutex.js` / `lib/http/http.js`；`package.json` 合法 JSON。
- `python -m py_compile` 通过：`lib/inference/TTS.py`（含 BOM，读取用 utf-8-sig）。
- LRU 逻辑单测全过：命中不重算 / 多 ref 驻留 / LRU 淘汰 / 换 SoVITS 戳失效 / v2pro 翻转失效。
- 补丁经**独立 unified-diff 应用器**逐 hunk 校验：以纯净基线重放后**逐字节复现**目标文件
  （含 CRLF 的 `http.js`）——等价于 `git apply --check` 通过。

> 局限：沙箱无 GPU，未做真实合成/高负载 E2E。A-2 的雪崩行为、A-1 的实际时延收益，
> 需在你本地带引擎冒烟；不放心 A-1 就先 `AURIVOX_TTS_BATCH_SIZE=1` 起步再往上调。

功能用法（流式默认不落盘等）详见随附 `BROKER_streaming_and_residency.md`。
