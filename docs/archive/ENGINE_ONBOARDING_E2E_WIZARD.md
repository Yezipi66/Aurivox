# 第 3 步端到端验证：用 Wizard 走一遍「反射 → 草稿 → 三块分区 → 映射」

> 分支：`research/engine-onboarding-complexity` ｜ 日期：2026-10-10
> **本文验的是 Wizard 的能力，⛔ 不是把 index-tts 接完美。** index-tts 只是样本。
> 口径：`[实测]` = 本机跑出来并贴了输出。⛔ 全文不含「应该能」「跑了 = 验过了」。
> 关联：第 1-2 步产物（`paramsFromReflect.js` / `cliHelp.js` / `ManifestForm.jsx` / `reflect_params.py`），
> 上一份 index-tts 接入记录 [`ENGINE_ONBOARDING_E2E_INDEX-TTS.md`](./ENGINE_ONBOARDING_E2E_INDEX-TTS.md)。

---

## 0. 一句话结论

**Wizard 这条链能从头跑到尾，但落在「草稿」这一层就停了 —— 它交付的是一份需要人工补齐的半成品，不是可用的名片。**

`[实测]` 浏览器真点「反射」跑完：`Reflected 24 named parameters: 20 for the form, 5 excluded (each says why), 2 platform-word candidates.`
三块分区、映射候选、追加到表单**都真的工作**。但：

- **必填参数对不上真实 CLI**：真实 `infer()` 必填是 `spk_audio_prompt / text / output_path`，Wizard 只认出 `spk_audio_prompt` 一个；`text` / `output_path` **从头到尾没出现过**（它们在 `call.bind` 里，反射器根本不看）。
- **反射的是错模块**：名片 `call.module` 写的是 `infer_v2_5`，上游 CLI（`cli_v2.py:1508`）用的是 `infer_v2`。Wizard **照着错的 module 反射出了 `lang` / `duration_factor` / `text_normalization`** 三个 v2_5 独有参数，⛔ 全程没有任何提醒。
- **上游官方原话抓到了，但摊错了对象**：`--voice` / `--emotion-vector` 等 51 条 index-tts 官方 help 确实被抓到，⛔ 但按「直接同名」规则一条都没贴到签名参数上（`spk_audio_prompt` ⇔ `--voice` 词根本不同）。而唯一贴上的两条（`--emo_alpha` / `--emo_vector`）来自 `backends/trt/infer.py`，不是官方主 CLI。
- **映射候选的默认勾选是错的**：`reference_audio` 的两个候选同分 100，勾选时自动选中**字母序在前的 `emo_audio_prompt`（情绪参考音频）**，而不是 `spk_audio_prompt`（音色参考音频）。`[实测]` 浏览器复现。
- **校验这一环在本次会话里是死的**：`/wizard/validate` 返回 **404**，「Save manifest」按钮恒 `disabled`，满屏 `REPLACE_ME` 的草稿**一条红框都不报**。根因已定位（§5 卡点 1）。

**自动填写率实测**：参数名 `name` 20/20、归属期 `phase` 20/20 **100% 自动**；类型 `type` 自动给了值但 8/20 标了「类型按名字猜的」；**界面外观字段（中英文标签 / min / max / choices / 上游原话配对）0% 自动**，全挂 `REPLACE_ME`。

---

## 1. 怎么跑的（真实环境与命令）

### 1.1 起 Wizard

```
cd web && npx vite --config wizard.vite.config.mjs     # 端口 5199，绑 127.0.0.1
```

`[实测]` `curl http://127.0.0.1:5199/` → `HTTP 200`，`<title>名片面板预览 · Aurivox engine wizard</title>`。
浏览器开 `http://127.0.0.1:5199/`，左侧五步轨道（Clone / Install deps / Download models / **Write manifest** / Verify）渲染正常。

> ⚠ **一个环境坑，先记下来**：本次会话**第一个** 5199 服务器上，`POST /wizard/params` 稳定返回
> `{"ok":false,"stage":"crash","error":"反射器非零退出（code=3221225794）…"}`（`0xC0000142` = STATUS_DLL_INIT_FAILED），
> **同一个 spec 用裸 `node` spawn 同一个 venv python 完全正常（status 0）**。
> ⇒ 不是 Wizard 逻辑问题，是那个 vite 进程的子进程崩了。**杀掉重启后一切正常**（见 §1.2，11.8s 出结果）。
> ⛔ 别把这个记成 Wizard 缺陷 —— 但它确实是个「重启才复现」的排查成本。

### 1.2 走的两条路

| 路 | 怎么跑 | 结果 |
|---|---|---|
| **A. 浏览器真点** | 第 4 步 → Reflect panel → engine id 填 `index-tts` → 点「Reflect」 | `[实测]` 三块分区 + 映射候选 + 追加表单全部跑通（§3） |
| **B. 命令行打后端** | `curl -X POST 127.0.0.1:5199/wizard/params -d '{"id":"index-tts","methods":["infer"]}'` | `[实测]` `HTTP 200`，`11.84s`，`ok:true`，24 参数（重启后的新服务器） |

B 的真实输出（节选，完整存 scratch）：

```json
{
  "ok": true,
  "counts": { "parameters": 20, "excluded": 5, "map_candidates": 2, "reflected": 24 },
  "partial": false, "partial_reason": null,
  "organized": { "ok": true, "counts": { "auto": 0, "must": 1, "may": 19 } },
  "caveat": "这是草稿：min / max / choices / 中英文标签反射拿不到，需要人逐条核对。"
}
```

> `[实测]` 反射用的是名片里写的 `call.module`。盘上 `engines/index-tts/manifest.json` 的 call 段是
> `"module": "indextts.infer_v2_5"` ⇒ **Wizard 照抄，反射的是 infer_v2_5**。这直接导致 §5 卡点 2。

---

## 2. 反射 → 草稿：Wizard 真的产出了什么

`[实测]` 20 条进草稿 + 5 条排除，24 个具名参数一条不丢（`must 1 + may 19 = 20 = parameters.length`）。

### 2.1 草稿参数（20 条）

| 名字 | type | phase | tier | 自动/待确认 |
|---|---|---|---|---|
| use_bf16 / use_deepspeed / use_accel / use_torch_compile / use_qwen_emo | boolean | load | advanced | 自动（strong） |
| use_cuda_kernel | boolean | load | advanced | ⚠ `_needs_review`（weak） |
| **spk_audio_prompt** | **text** | call | common | ⚠ `_needs_review` + **`required:true`**（唯一进「必须你填」的） |
| emo_audio_prompt / emo_vector / emo_text | text/number/text | call | common | ⚠ `_needs_review`（weak） |
| emo_alpha / interval_silence / max_text_tokens_per_segment / more_segment_before / duration_factor | number/integer | call | common | 自动（medium） |
| use_emo_text / use_random / verbose / stream_return / text_normalization | boolean | call | common | 自动（strong） |

### 2.2 排除清单（5 条，每条都有理由）

| 名字 | phase | 理由（原话） |
|---|---|---|
| cfg_path / model_dir | load | 路径类 —— 归 `call.init_args` / `{checkpoints}` |
| device | load | 平台自己已经管的事（设备探测等） |
| **lang** | call | **`needs a human`：必填参数，但平台看不出它是什么类型** —— 这条是 v2_5 独有，真实 CLI 没有（§5 卡点 2） |
| generation_kwargs | call | 变长参数（`**kwargs`）—— 平台不替你猜 |

### 2.3 草稿的「骨架」长这样（`[实测]` 原文）

```json
{
  "name": "spk_audio_prompt",
  "type": "text", "phase": "call", "tier": "common", "group": "generate", "order": 10,
  "label": { "en": "Spk audio prompt", "zh": "REPLACE_ME" },
  "help":  { "en": "REPLACE_ME (inferred: 必填参数，没有默认值；按名字猜的（名字像音频输入（值是文件路径））—— ⛔ 请人工确认)", "zh": "REPLACE_ME" },
  "_confidence": "weak", "_needs_review": true, "required": true
}
```

`[实测]` 20 条草稿**全部** `label.zh` / `help.zh` = `REPLACE_ME`，`label.en` 是参数名空格分词（`Use cuda kernel`）。**0 条有 min / max / choices。**

---

## 3. 三块分区 + 映射：浏览器里真的长这样

`[实测]` DOM 抓出来的第 4 步 Reflect 面板（点「Reflect」后）：

```
Reflected 24 named parameters: 20 for the form, 5 excluded (each says why), 2 platform-word candidates.

Already handled for you
  None yet. Tick rows in the platform word candidates below to map them.

You must fill these (1)
  spk_audio_prompt   text   call   [you must fill this] [type guessed from name]
    必填参数，没有默认值；按名字猜的（名字像音频输入（值是文件路径））—— ⛔ 请人工确认
    [Upstream official wording]  ← 展开是空的（没抓到直接同名，见 §4）

Optional knobs you can ignore (19)
  …（use_bf16 … text_normalization，3 条带 --flag，其余无）

Platform word candidates (maps)
  text_lang         lang — 名字像「语言」
  reference_audio   emo_audio_prompt / spk_audio_prompt — 名字像「参考音频」

Excluded (5)   cfg_path / model_dir / device / lang(需要人定) / generation_kwargs
```

**三块分区的口径**（`cliHelp.js:organizeDraft`）：① auto = 已映射的平台词；② must = `required===true`；③ may = 其余。**一条不丢**（代码里有 `must+may === parameters.length` 的守卫，显示侧 `ManifestForm.jsx:510` 还有第二道）。

### 3.1 追加到表单：真的能用

`[实测]` 点「+ Append to form」→ 切到 JSON tab 读回内存里的 manifest：

```json
{ "params": 20, "names": ["use_bf16","use_cuda_kernel","use_deepspeed","use_accel","use_torch_compile","use_qwen_emo","spk_audio_prompt","emo_audio_prompt","emo_alpha","emo_vector","use_emo_text","emo_text","use_random","interval_silence","verbose","max_text_tokens_per_segment","stream_return","more_segment_before","duration_factor","text_normalization"], "has_maps": false }
```

✅ 20 条确实进了表单对象。⛔ **但只是内存里的表单 —— 没有写 `manifest.json`**（对，这正是设计：落盘是 Save 的事）。

---

## 4. 上游 CLI 官方原话：抓到了，但摊错了对象

### 4.1 抓取范围跑偏（跨引擎污染）

`[实测]` `collectCliHelp` 报了 **22 个 source 文件、244 个 flag**，但 sources 里混进了：

```
engines/cosyvoice2/...            (11 个文件)
engines/indextts2/indextts/cli*.py (2 个文件)   ← 另一台引擎的克隆
lib/engines/env_probe.py
tools/dev/_scratch/probe_indextts2_move.py
tools/engine-wizard/core/cli_help_extract.py
tools/runtime/python/Lib/argparse.py
```

根因（`[实测]` 读代码）：`wizardbridge.js:705` 把 CLI 扫描目录算成 `path.dirname(spec.value.sys_path[0]) + '/..'`，而 `sys_path` 是 `engines/index-tts` ⇒ 扫描的是**项目根**，于是把 `engines/` 下所有引擎、`tools/`、`lib/` 全扫了。index-tts 的 `cli_v2.py`（51 flag）确实在里面，⛔ 但和别的引擎混成 244 条摊给用户。

### 4.2 「直接同名」唯一允许的自动贴：对 IndexTTS2 几乎全不生效

`[实测]` index-tts 的官方 CLI（`indextts/cli_v2.py`，51 flag）真实原话：

```
['--voice']           Path to the speaker reference audio
['--emotion-audio']   Path to the emotion reference audio
['--emotion-text']    Emotion description text
['--emotion-vector']  Comma-separated 8-dimensional emotion vector
['--emotion-weight']  Emotion weight mapped to IndexTTS2 emo_alpha   ← 上游自己写明了映射到 emo_alpha
['--text']            Text to synthesize
```

签名参数 `spk_audio_prompt / emo_vector / emo_alpha` 与 CLI dest `voice / emotion_vector / emotion_weight` **逐字都不同** ⇒ 按「只贴直接同名」的纪律，**一条都不贴**。`[实测]` UI 里 `spk_audio_prompt` 那条的「Upstream official wording」展开是空的。

⛔ **Wizard 没帮上这一环**：用户得自己对 20 条签名参数 × 51 条 CLI flag。上游其实在 `--emotion-weight` 的 help 里写明了「mapped to IndexTTS2 emo_alpha」，Wizard 不读这句话。

### 4.3 唯一贴上的两条，来自非官方主 CLI

`[实测]` 最终 `_cli` 贴上的是：

```
emo_alpha  → --emo_alpha   "Emotion blend weight"        ← 来自 engines/index-tts/backends/trt/infer.py
emo_vector → --emo_vector  "8-D emotion vector"          ← 同上
verbose    → --verbose     "Show verbose inference output" ← 来自 cli_v2.py（这条对）
```

`--emo_alpha` / `--emo_vector` 来自 `backends/trt/`（TensorRT 后端脚本），⛔ 不是用户会敲的官方主 CLI。而官方主 CLI 的对应 flag 叫 `--emotion-weight` / `--emotion-vector`，反而不贴。

---

## 5. 卡点清单（Wizard 暴露的问题，⛔ 本次一个都没修）

### 卡点 1 —— `/wizard/validate` 404，校验环整个不可用

`[实测]` `curl -X POST 127.0.0.1:5199/wizard/validate` → **HTTP 404**（`/wizard/params` 同法 → 400，说明端点本身可达）。
UI 里满屏 `REPLACE_ME` 的草稿，`.msg-danger` / `.msg-warning` 计数 = **0 / 0**，「Save manifest」按钮恒 `disabled`。

根因（`[实测]` 读 `web/wizard.vite.config.mjs:62-98` + `wizardbridge.js`）：
HANDLERS 顺序里 `handleParams`（**async**）排在 `handleValidate`（sync）**之前**。中间件循环遇到第一个返回 Promise 的 handler 就 `break` 并走 `.then(ok => ok || next())` ⇒ 对 `/wizard/validate`，前面所有 sync handler 返回 `false`，到 `handleParams` 返回 Promise ⇒ 直接 break + next() ⇒ **`handleValidate` 永远轮不到**。这是 async/sync handler 混排的路由缺陷，⛔ 不是配置写错。

### 卡点 2 —— 反射的是 `infer_v2_5`，但上游 CLI 用的是 `infer_v2`

`[实测]` 名片 `call.module = "indextts.infer_v2_5"`；`cli_v2.py:1508` 是 `from indextts.infer_v2 import IndexTTS2`；`cli.py:96` 调 `tts.infer(audio_prompt=..., text=..., output_path=...)`。
Wizard 照 `call.module` 反射 ⇒ 多出 `lang / duration_factor / text_normalization`（v2_5 独有），且 `lang` 还是**必填**（在 v2_5 签名里无默认值）⇒ 被顶进「必须你填」，实际真实 CLI 根本没有 `lang`。
⛔ **Wizard 没有任何「这个 module 跟 CLI 用的不是同一个」的交叉检查。**

### 卡点 3 —— 真实必填 `text` / `output_path` 从头到尾没出现

真实 `infer()` 必填三件套是 `spk_audio_prompt / text / output_path`（`infer_v2.py:371` / `infer_v2_5.py:506`，`[实测]` 已核）。`[实测]` 反射 `infer_v2` 的 call 参数里也**没有** `text` / `output_path`（它们只在 `call.bind` 里出现：`text→text, ref_audio→spk_audio_prompt, output_path→output_path`）。
⇒ 反射器只读方法签名、⛔ 不读 `call.bind` ⇒ 这两个**必填**参数对 Wizard 完全隐形。`spk_audio_prompt` 能出现是因为它同时在签名里。

### 卡点 4 —— 映射候选的默认勾选会选错（同分并列 + 字母序）

`[实测]` `reference_audio` 的两个候选**同分 100**：`emo_audio_prompt`（情绪参考）和 `spk_audio_prompt`（音色参考）。
`ManifestForm.jsx:775` 勾选时 `next[row.platform_key] = row.candidates[0].engine_param`，而 `candidates` 按 `score desc, 再按名字字母序` 排 ⇒ `[实测]` 浏览器里勾 `reference_audio`，下拉框自动停在 **`emo_audio_prompt`**：

```json
{ "val": "emo_audio_prompt", "opts": ["emo_audio_prompt (call, 100)", "spk_audio_prompt (call, 100)"] }
```

⇒ 用户若不手动改，写进 maps 的是**情绪参考音频**，音色参考音频反而没映射上。⛔ 静默错配，不报错。

### 卡点 5 —— `text` 这个平台核心词没有映射候选

`[实测]` `map_candidates` 只有 2 组：`text_lang`、`reference_audio`。**没有 `text`**。
原因：`candidatesFor('text')` 的规则 `/^(tts_)?text$/` 要求参数名**就是** `text` 或 `tts_text`，而签名里没有裸 `text`（它藏在 bind 里，见卡点 3）⇒ 平台最核心的「要合成的文本」这个词，Wizard 一个候选都没给。

### 卡点 6 —— CLI 扫描目录算错，跨引擎污染（§4.1）

### 卡点 7 —— 环境坑：旧 vite 进程 spawn 崩 0xC0000142（§1.1）

---

## 6. Wizard 帮上了什么 / 没帮上什么

### ✅ 帮上了（`[实测]` 真的工作）

1. **参数名 + 归属期 100% 自动**：24 个具名参数全部列出，`name` / `phase`（load vs call）无一错。
2. **三块分区真的分出来了**：`auto 0 / must 1 / may 19`，必填的 `spk_audio_prompt` 被高亮「you must fill this + type guessed from name」，排最前。
3. **「必须你填」的判据是对的**：认不出类型的必填参数（`lang`、`spk_audio_prompt`）确实被拎出来并给了「必须由你来定，它决定界面长出哪种控件」的行动指引。
4. **排除清单每条都有理由**：`cfg_path`/`model_dir`（归 init_args）、`device`（平台自己管）、`**kwargs`（不猜怎么展开）—— 排除不是静默丢弃。
5. **映射候选给出了**：`spk_audio_prompt→reference_audio`、`lang→text_lang` 都被识别出来（名字启发式命中）。
6. **「不自动落盘」的纪律守住了**：映射候选默认全不勾，勾了才写 maps；追加表单也只进内存。`[实测]` JSON tab 确认 `manifest.json` 未被碰。
7. **追加到表单真的能用**：20 条一键进表单（§3.1）。
8. **一条不丢的守卫在工作**：`must + may === parameters.length`，数据侧 + 显示侧双保险。

### ❌ 没帮上（要人手工补或本身就是缺口）

1. **不交叉校验 module**：名片写 `infer_v2_5`、CLI 用 `infer_v2`，Wizard 反射错的还顶出个假必填 `lang`（卡点 2）。
2. **看不见 `call.bind`**：真实必填 `text` / `output_path` 完全不出现在任何输出里（卡点 3）。
3. **上游官方原话对不上签名参数**：`--voice` / `--emotion-vector` 一条没贴，贴上的 `--emo_alpha` 还来自 trt 后端脚本（§4.2/4.3）。
4. **CLI 扫描跑偏到项目根**：244 flag 混了 cosyvoice2 / indextts2 / tools（卡点 6）。
5. **同分候选默认勾错**：`reference_audio` 自动选 `emo_audio_prompt`（卡点 4）。
6. **平台核心词 `text` 无候选**（卡点 5）。
7. **界面外观 0% 自动**：20 条全 `REPLACE_ME` 中文标签，0 条 min/max/choices —— 中英标签、取值范围、下拉项全部要人写。
8. **`/wizard/validate` 404**：校验环不可用，红框/保存门槛都失效（卡点 1）。
9. **不补必填参数的默认值契约（C11）**：草稿里 `spk_audio_prompt` 是 `required:true` 但**没有 `default` 字段**，`emo_alpha` 的 `default` 是 `1`（float `1.0` 被 JSON 成了 `1`）。平台「必填就得有默认值或明确无」这条契约，Wizard 不管。

---

## 7. 用户还要手工补什么（接一台新引擎的真实工作量）

跑完 Wizard 反射之后，人还得做：

| # | 要补的 | 为什么 Wizard 给不了 | 量级（index-tts 实测） |
|---|---|---|---|
| 1 | 改 `call.module` 到 CLI 真正 import 的那个 | 不交叉校验（卡点 2） | 1 处 |
| 2 | 手工补 `text` / `output_path` 的绑定/参数 | 反射器不读 bind（卡点 3） | 2 个 |
| 3 | 20 条参数的中文标签 `label.zh` | 全 `REPLACE_ME` | 20 条 |
| 4 | 20 条参数的 `help.zh` | 全 `REPLACE_ME` | 20 条 |
| 5 | 有范围的参数写 `min`/`max`/`step`（如 `emo_alpha` 0-1、`interval_silence`） | 反射拿不到 | ~6 个 |
| 6 | 下拉参数写 `choices`（如 `lang` 的取值表） | 反射拿不到 | 1 个 |
| 7 | 8 条 `_needs_review` 参数人工定 `type` | 类型是猜的 | 8 条 |
| 8 | 勾映射候选时**逐个核对别选错**（尤其 `reference_audio`） | 同分默认勾错（卡点 4） | 2 组 |
| 9 | 对上游 CLI flag 人工配对官方原话 | 只贴直接同名（§4.2） | 20 × 51 |
| 10 | 补 `text` 的映射候选 | Wizard 没给（卡点 5） | 1 条 |
| 11 | 修 `/wizard/validate` 才能用校验/保存 | 路由缺陷（卡点 1） | —— |

**结论**：Wizard 把「有哪些参数、属于哪一期、哪些必填、哪些排除」这一层**事实收集**干得不错（name/phase 100%、排除有理有据），但把「参数长什么样、什么意思、怎么映射」这一层**语义/外观**几乎全留给人。对一台 20+ 参数的新引擎，人真正要动脑的是 ~11 类、几十条逐条核对 —— Wizard 省掉的是「读源码数参数」，没省掉「读懂并配好」。

---

## 8. 与第 1-2 步预期对照

| 第 1-2 步的设计意图 | `[实测]` 结果 |
|---|---|
| 反射 → 草稿（`paramsFromReflect.js`） | ✅ 24 参数 / 20 草稿 / 5 排除，一条不丢 |
| 上游 CLI 官方原话摊开（`cliHelp.js`） | ⚠ 抓到了但摊错对象（跨引擎污染 + 只贴直接同名） |
| 三块分区（`organizeDraft`） | ✅ auto/must/may 正确，必填高亮 |
| 映射候选只给候选不自动写（`ReflectPanel`） | ⚠ 纪律守住，但同分默认勾错（卡点 4） |
| 校验红框（`bridge.js` / `validate.js`） | ❌ `/wizard/validate` 404，本次不可用（卡点 1） |
| 落盘靠人点保存 | ⛔ 本次没走到（save 恒 disabled），⛔ 未验落盘本身 |

---

## 9. 附：复现命令

```bash
# 起 Wizard（5199）
cd web && npx vite --config wizard.vite.config.mjs

# 后端直接验反射（重启后的服务器，~12s）
curl -X POST 127.0.0.1:5199/wizard/params \
  -H 'content-type: application/json' \
  -d '{"id":"index-tts","methods":["infer"]}'

# 校验环（[实测] 404 —— 卡点 1）
curl -X POST 127.0.0.1:5199/wizard/validate -d '{}'

# 裸跑反射器对照（绕过 vite，[实测] 正常）
engines/index-tts/.venv/Scripts/python.exe \
  lib/engines/reflect_params.py --spec-file <spec.json>
```

spec.json（反射器要的那份，`[实测]` 用过）：

```json
{ "python": "engines/index-tts/.venv/Scripts/python.exe",
  "cwd": ".",
  "module": "indextts.infer_v2_5",
  "class": "IndexTTS2",
  "method": "infer",
  "sys_path": ["engines/index-tts"] }
```

---

## 10. 本次改动范围

- ⛔ 未改 `lib/`、未改第 1-2 步任何工具、未改 `engines/index-tts/manifest.json` 一个字节。
- ⛔ 未 commit、未 push、未建分支。
- ✅ 仅新增本记录 `docs/ENGINE_ONBOARDING_E2E_WIZARD.md`。
- 7 个卡点（§5）全部记给下一轮，⛔ 本文一个都没修 —— 本文的任务是验 Wizard，不是修 Wizard。
