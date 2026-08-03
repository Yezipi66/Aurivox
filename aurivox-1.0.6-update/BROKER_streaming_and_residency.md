# Broker：流式传输 与 模型留驻（说明 + 本次改动）

本文档说明两件 broker 已有/新增的能力，方便使用方（curl / SDK / 上层服务）知道怎么用。

---

## 一、流式传输（已有能力，此前未文档化）

入口：`POST /v1/audio/speech`（OpenAI 兼容端点，`lib/routes/synthesis.js`）。
默认是**一次性返回整段音频**（buffer 完再发）。要边合成边下发，加 `stream: true`。

### 请求字段

| 字段 | 说明 |
|---|---|
| `voice` | `role`（整音色，自动选最优 ckpt）或 `role/name`（recipe，锁定权重+参考音频+参数，分发推荐） |
| `input` | 文本，≤ 5000 字符 |
| `stream` | `true` 开启流式；也接受引擎侧 `streaming_mode`（非 0/false 即视为流式） |
| `response_format` | **流式只支持 `wav` 或 `ogg`**（引擎原生容器，不需要 ffmpeg）。`ogg` 浏览器 `<audio>` 可边下边播 |
| `persist` | **默认 `false` = 流式不落盘**（见下）。传 `true` 才归档到磁盘 |
| `overlap_length` / `min_chunk_length` | 可选，透传给引擎调节分块粒度/首包延迟 |
| `speed`、`language` | 同非流式 |

非 `wav`/`ogg` 的流式请求（mp3/opus/aac/flac）会被 **400** 拒绝（`code: stream_format_unsupported`），并提示「去掉 stream 改要转码文件，或用 ogg」——不会静默降级容器。

### 落盘行为（重点：默认不落盘）

- **默认 `persist:false`**：流式请求**不会**在 broker 输出目录留文件，也不写 `meta.json`。
  原因：流式是「边算边发」，服务端手里没有一份「完成的文件」可供 `meta.json` 指向，
  硬要落盘需要把 live 流 tee 到磁盘并等它 flush 完才补写 meta——这属于额外成本，默认关闭。
- **`persist:true`**：把 live 流 **tee** 一份到 `/outputs/broker/<genId>/audio.<ext>`，
  流结束 flush 后补写 `meta.json`（含 voice/recipe/权重/seed/`streamed:true` 等）。
  归档失败**绝不影响**正在进行的下发（best-effort）。返回头会带 `X-Output-Url`。

### 响应

- 状态 200，`Transfer-Encoding: chunked`（无 `Content-Length`），`Content-Disposition: inline`。
- 响应头：`X-Streaming: true`、`X-Voice-Id`、`X-Audio-Format`、`X-Text-Lang`、
  `X-Recipe-Id`（recipe 时）、`X-Output-Url`（persist 时）、`X-Language-Warning`（如有）。
- 首字节在引擎产出第一块时即刻 flush；`wav` 会先发一个 WAV 头再连续发 raw PCM。
- **上游错误**（如引擎 `check_params` 400）在 headers 未发出前，会被 broker 收敛成 **502** JSON。
- **客户端中途挂断**：broker 立即 abort 对引擎的拉取，并丢弃未完成的归档分片（不写半截 meta）。

### 例子

```bash
# 流式播放（不落盘，ogg 便于浏览器边下边播）
curl -N -X POST http://127.0.0.1:PORT/v1/audio/speech \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"voice":"Raiden/JA","input":"こんにちは。","stream":true,"response_format":"ogg"}' \
  --output out.ogg

# 流式 + 归档（persist:true → 服务端留档 + meta.json，返回头带 X-Output-Url）
curl -N -X POST http://127.0.0.1:PORT/v1/audio/speech \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"voice":"Raiden/JA","input":"...","stream":true,"response_format":"wav","persist":true}' \
  --output out.wav
```

> 并发注意：整段流式中继期间，broker 的**全局生成锁**一直被这一个请求持有
> （`withGenerationLock` 直到 pipe 结束才释放），所以流式期间不会有并发的模型切换来抢。
> 也就是说——**流式不改变「全链路串行」这个前提**（见第三节）。

---

## 二、模型留驻（本次新增：参考音频 prompt LRU）

「模型是加载的大头」——分两层，权重和参考音频。

### 2.1 权重留驻（已有，未改）

`lib/gsv/modelState.js` 的 `ModelSwitcher` 缓存「上次成功加载的 GPT/SoVITS 路径」，
每次合成前的 `switchModels(cfg)` 比对，**路径相同就跳过** `/set_gpt_weights` /
`/set_sovits_weights` 的重加载（同音色连续跑不重载权重）。引擎重启/迁移经
`noteEngineHealth` 的 offline→online 翻转自动失效缓存。**这一层无需改动。**

### 2.2 参考音频留驻（本次改动，文件：`lib/inference/TTS.py`）

**问题**：换参考音频（不换权重）本来就不重载权重，只重抽 prompt——
但引擎 `prompt_cache` 只有**单槽**，只记住*最后一个* ref。多 recipe / 多音色来回切时，
每次切都要重新跑 `cnhubert → vits.extract_latent`（prompt_semantic）+ 频谱（refer_spec）。

**改动**：给引擎加一个**带戳的参考音频 LRU**（`self._ref_lru`），缓存最近 N 个 ref 的
`prompt_semantic / refer_spec[0] / raw_audio / raw_sr`。命中即**原样恢复、零重抽、零权重重载**。

关键设计（保证正确性）：

1. **每条缓存戳上它计算时所用的 SoVITS 权重路径 + is_v2pro**。因为 `prompt_semantic`
   来自 `vits_model.extract_latent`，**依赖 SoVITS 码本**——换了 SoVITS 后旧的语义就失效。
   查表时戳不匹配 = 视为 miss 并丢弃，重抽。
2. **切 SoVITS 权重时不清空整个 LRU**——正因为有戳，属于**不同常驻音色**的 ref 可以
   同时留在缓存里各自有效。这正是「recipe 复杂多变、在多个音色间轮转」想要的：
   A/B 两个音色的参考音频都能同时保持热，来回切不重抽。
3. 修掉一个**既有潜在 bug**：`init_vits_weights` 原本不重置 `prompt_cache`，若切完
   SoVITS 后下一次请求复用**同一个 ref 路径**，`run()` 会因路径相同而跳过重抽、用到
   旧权重下的陈旧 `prompt_semantic`。现在切 SoVITS 会把 live 主槽 `ref_audio_path`
   置空，强制下一次重抽（LRU 也会因戳不符而正确重算）。

**容量**：默认 8 条，环境变量 `AURIVOX_REF_CACHE` 可调（`0` 关闭）。
显存开销很小（每条 ≈ 一段 3–10s 波形张量 + 频谱 + 语义码，约几 MB），8 条量级 ~十几 MB。

**兼容性**：纯引擎侧改动，**API 与调用方零变化**；broker 仍按请求传 `ref_audio_path`，
`run()` 内部惰性命中 LRU。已通过 LRU 逻辑单测（命中不重算/驻留/淘汰/换 SoVITS 失效/
v2pro 翻转失效 全部通过）。

---

## 三、并发：方案 A 再对齐

现状是**刻意的全链路串行**：broker 一把全局锁（`_generationMutex`）+ 引擎一把
`_model_lock`（整段推理持锁）+ `uvicorn workers=1` + 单例 `tts_pipeline` 单卡。
根因：**一份模型、一张卡、权重是共享可变全局**，同进程内没法真并行跑两个 forward。

**方案 A = 不追求「多请求真并行」，而是把单卡上真正有效的并行度吃满 + 让串行行为可控。**
它有两个独立的小动作，别把它和「双引擎」混为一谈：

- **A-1「请求内并行」**：GPT-SoVITS 自带 `batch_size` / `parallel_infer` / `split_bucket`，
  会把**一个请求里的多个文本分段**打包并行推理。这是单卡上唯一真正有效的并行——
  它压的是「一段长文本」的总时延，而不是「两个不同请求」。确认这些参数在 recipe/
  默认参数里开着、`batch_size` 给到合适值，就等于免费拿到了这份并行。
- **A-2「有界排队」**：现在那把全局锁背后是一条**无上限**的 promise 链——并发请求越多，
  排队越长且不可见，最终表现为「都在转圈」。给它加一个**队列上限 + 排队即返回 503 /
  `Retry-After`**（外加单请求超时），负载高时**明确拒绝**而不是无限堆积。

一句话对比：
- **方案 A**：一张卡、一份模型不变；**A-1** 让「单个请求」更快，**A-2** 让「高并发」时
  行为可预测（拒绝而非假死）。**零/极小改动，不加显存。**
- **方案 B（双引擎/多引擎）**：起 N 个 infer_server 进程按音色粘性路由，才是「多请求真并行 +
  多音色同时常驻」。但要 **N 份显存**，单张消费级卡通常放不下 2 份;收益线性只在多卡。

所以 A 不是「并发方案」，而是「**在不上多引擎的前提下，把单引擎的性能和稳定性榨干**」。
要真并发多请求/多音色，才需要走 B，且前提是显存/多卡撑得住。

—— 你决定：先上 A-2（有界排队，最小改动、马上能防雪崩），还是连 A-1 一起把默认
`batch_size`/`parallel_infer` 也调好？B 需要你先给：几张卡 / 单卡显存 / 预计同时几个音色。
