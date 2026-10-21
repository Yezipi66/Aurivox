# 引擎接入 · 调研结论（2026-10-09）

> 分支：`research/engine-onboarding-complexity`
> 口径沿用项目纪律：`[实测]` = 在本机跑出来的 · `[读码]` = 读代码得出 · `[调研]` = 外部资料
> ⚠️ 本文件只记**结论与证据**，不含实现方案。进度仍以 `ONBOARDING_PLAN.md` 为准。

---

## 0. 这份文件回答什么

**「怎么写好名片」** —— 在不损害模型能力的前提下，让平台替人承担尽可能多的书写与翻译工作。

拆成三个难点（Owner 定）：

| # | 难点 |
|---|---|
| **一** | 怎么**相对找全**参数（找出来的可以列表给用户对照） |
| **二** | 这些参数**有多少能映射到平台**？能否做到「必传参数都映射到平台」？ |
| **三** | **映射不了的**参数，以什么形式告诉用户、引导用户填对？ |

---

## 1. 前提：平台是传话筒（这条决定了后面所有取舍）

`[读码]` 三处证据：

| 位置 | 原文 |
|---|---|
| `web/src/components/generate/GenerateTab.jsx:571` | 「引擎参数：只发这台引擎名片里有的键，且只有用户动过的才发」 |
| `lib/engines/paramTable.js:145` | 「名片没有这个概念（不在 payload_keys 上）就不发」 |
| `lib/engines/payload.js` 头注 | 平台曾在 `server.js` 里替引擎决定默认值（14 行 `if (payload.x === undefined)`），**已删掉，搬进名片** |

⇒ **平台不校验、不判断、不替引擎兜底。** 名片声明什么就发什么。

⭐ **推论（最重要的一条）**：
**名片漏一个参数 ⇒ 用户界面上永远看不到它，且没有任何地方会报错。**
⇒ 「写全参数」是唯一的战场。

---

## 2. 难点一：参数藏在哪，不读源码能提多少

### 2.1 本机 4 台引擎实测

`[实测]` 三种「不读源码」的方法（AST 静态解析 + markdown 表格解析），对照反射基准：

| 引擎 | 反射基准 | ① CLI argparse | ② README 参数表 | ③ 其他脚本 |
|---|---|---|---|---|
| index-tts | 25 | **31** | 13 | 13 |
| indextts2 | 25 | **31** | 0 | 0 |
| cosyvoice2 | 13 | **0** | 0 | 2 |
| gpt-sovits | 2 | **0** | **0** | 0 |

### 2.2 三条结论

**① CLI 最强，但有前提**
`[实测]` 有 argparse 的引擎能吃满甚至超过反射（31 > 25）。
⛔ 但 **cosyvoice2 / gpt-sovits 是 0** —— 它们没有 argparse CLI（cosyvoice2 只有 webui；GSV 的推理参数走 HTTP body）。

**② README 参数表几乎没用，而且假阳性严重**
`[实测]` **踩到的坑**：第一版正则把**任何 markdown 表格**都当参数表 ⇒
cosyvoice2 提取出 13 个「参数」，全是**模型排行榜**（`Model`/`F5-TTS`/`Seed-TTS`）；
GSV 提取出 8 个，全是**性能对比表**（`LibriTTS`/`BigVGAN`/`GPU`）。
加了表头判定后：**4 台里只有 index-tts 有真参数表（13 个）**。

**③ GSV 三种方法全部为 0 —— 硬骨头**
`[实测]` 它的参数只在 `TTS.run(inputs: dict)` 的**源码里**。
`[实测]` AST 解析源码里的 `inputs['xxx']` 取值点，能挖出 **27 个键**（比 docstring 的 24 个还多 3 个）。

### 2.3 参数位置的分布（`[调研]`，20+ 引擎）

| 位置 | 典型引擎 | 可自动提取？ |
|---|---|---|
| Python 签名 | IndexTTS2、CosyVoice2、F5-TTS | ✅ 反射 |
| **dict 入参** | **GPT-SoVITS**（`inputs: dict`） | ⛔ 需读源码 |
| argparse | IndexTTS、Spark-TTS、Kokoro | ✅ AST |
| README 参数表 | 少数（index-tts 有） | ⚠️ 少且易假阳性 |
| pydantic / dataclass | Fish-Speech（`ServeTTSRequest`）、ChatTTS | ✅ AST |
| 配置文件 yaml/json | 多数（但通常只有模型结构，无推理参数） | ⚠️ 不含推理参数 |
| docstring | GSV（恰好写全） | ⚠️ 靠运气 |

⭐ **难点一结论：没有任何单一方法通吃。必须多源合并；dict 类引擎只有读源码。**

---

## 3. 难点二：多少能映射到平台

### 3.1 平台的 10 个词（映射的目标）

`[读码]` `lib/engines/payload.js`：

```
必发（哪怕值是空字符串）：text / text_lang / reference_audio / reference_text / reference_lang
空值不发              ：aux_reference_audio / speed / seed / media_type / streaming
另 call.bind 三槽位    ：text / ref_audio / output_path
```

### 3.2 必传参数映射结果（`[调研]` 14 引擎 + `[实测]` 抽验）

| 引擎 | 必传参数 | 能映射 |
|---|---|---|
| IndexTTS2 | `spk_audio_prompt` / `text` / `output_path` / `lang`（`[实测]` 4 个） | 4/4 ✅ |
| GPT-SoVITS | `text` / `text_lang` / `ref_audio_path` / `prompt_lang`（`[实测]` 4 个） | 4/4 ✅ |
| F5-TTS | `ref_file` / `ref_text` / `gen_text` | 3/3 ✅ |
| CosyVoice2（zero_shot / cross_lingual） | 全映射 | ✅ |
| CosyVoice2（sft / instruct / vc） | `spk_id` / `instruct_text` / `source_wav` | ❌ |
| Kokoro | `voice` | ❌ |
| MeloTTS | `speaker_id` | ❌ |
| OpenVoice | `speaker` | ❌ |
| 其余（Spark-TTS / Fish-Speech / ChatTTS / XTTS / Dia / Orpheus / Piper） | 只有 `text` | ✅ |

**总体必传映射率 ≈ 81%**（`[调研]`，26/32）

### 3.3 ⭐ 关键结论：只需扩 2~3 个平台词

| 建议新增 | 解决的引擎 | 优先级 |
|---|---|---|
| **`speaker`** | CosyVoice2 `spk_id`、MeloTTS `speaker_id`、OpenVoice `speaker`、Kokoro `voice` | **高（4 台）** |
| `source_audio` | CosyVoice2 VC 的 `source_wav`（语音转换的源，非参考音频） | 中 |
| `instruct_text` | CosyVoice2 Instruct 的 `instruct_text` | 低 |

⇒ **难点二结论：不能 100% 做到，但缺口很小 —— 扩 `speaker` 一词就解决 4 台引擎。**

⚠️ **已知报告误差（本人核实后纠正）**：
子 Agent 报告说 IndexTTS2 必传 3 个、参数名写作 `audio_prompt`。
`[实测]` 实际是 **4 个**（`spk_audio_prompt` / `text` / `output_path` / **`lang`**），且 `audio_prompt` 是 v1 的旧名。
⇒ 再次印证：**调研结论必须本机核实**。

---

## 4. 难点三：映射不上的怎么引导用户

### 4.1 调研对象（`[调研]` 6 个系统）

TTS-Audio-Suite（ComfyUI，19 引擎）· AllTalk V2 · SillyTavern（30+ provider）·
Ollama Modelfile · Home Assistant config flow · RJSF / JSON Schema form

### 4.2 可借鉴的 5 种形式

| # | 形式 | 出处 |
|---|---|---|
| ① | **字段下方说明文字 / tooltip** | HA `data_description`、RJSF `description` |
| ② | **候选下拉**（值可枚举时） | HA `selector`、RJSF `enum` |
| ③ | **默认值预填** | HA `default=`、RJSF `default` |
| ④ | **分组折叠**（高级参数收起） | HA `section(collapsed)`、AllTalk Accordion |
| ⑤ | **填错即时报错** | HA `errors`、RJSF `liveValidate` |

### 4.3 ⛔ 不适合我们的 5 种（因为平台是传话筒）

| 不适合 | 理由 |
|---|---|
| 平台侧 schema 硬校验 | 平台判断「什么值合法」= 越界 |
| 平台替引擎补默认值 | 名片没写就是没写 |
| 平台隐藏「未知参数」 | 名片写了就必须展示 |
| 平台做类型转换 | 平台不该碰值 |
| 每个引擎自己写前端 | 违背「平台自动长名片面板」 |

### 4.4 ⭐ 难点三结论（调研自己总结的原则）

> 平台只做「名片 → UI」的机械翻译 + 名片声明约束的**透传展示**
> （名片写了 `choices` 就画下拉，写了必填就画标记），
> **但不解释、不补全、不校验。**

---

## 5. 同类平台对比（`[实测]` 读源码 + `[调研]`）

| 平台 | 参数怎么来 | 加引擎改多少 | 字段说明从哪来 |
|---|---|---|---|
| **TTS-Audio-Suite**（19 引擎） | 人工手写 | 3 处 / ~1100 行 | **人工写 tooltip** |
| **AllTalk V2** | 人工改模板 | 6 处 | **人工写 `help_content.py`（17KB）** |
| **Speech-AI-Forge** | 人工配置 | — | 人工写 argparse help |
| **TTS-WebUI** | 人工写扩展 | 2 处（整套 UI 自己写） | 人工写 description |
| **SillyTavern**（30+ provider） | 完全硬编码 | 3 处 | ⛔ 无统一机制 |
| **VoiceStudio** | 引擎级声明，**参数级无 schema** | — | 引擎级有，参数级没有 |

⭐ **结论：没有一家是「自动从上游源码提取参数」的 —— 全是人工适配。**

**反面教训**（值得记住）：
`[调研]` **VoiceStudio** 有设计良好的 `TTSBackend` 抽象基类 + 注册表 + 元数据 API，
但**因为不声明参数级 schema，前端仍然无法自动长参数表单**。
⇒ 我们 `manifest.json` 的 `parameters[]` 走的路是对的。

---

## 6. 平台已能自动承担什么（实测汇总）

| 名片内容 | 谁来做 | 实测程度 |
|---|---|---|
| `runtime` 整段（走通用宿主的引擎） | 🟢 平台全自动 | 6 个字段值完全一样 |
| `install.env_command` | 🟢 平台全自动 | `env.js` 已实现（按依赖清单推） |
| `models.source.command` | 🟢 平台全自动 | 向导第 3 步已实现（从 README 提取） |
| `upstream.url` | 🟢 平台全自动 | 第 1 步 clone URL 带入 |
| `parameters[]`（有哪些参数） | 🟡 平台出草稿，人核对 | 反射：IndexTTS2 **25** / CosyVoice2 **13**；dict 类需读源码（GSV **27**） |
| 参数说明文本 | 🟡 平台出草稿，人核对 | 覆盖率 **7.7% ~ 100%**（天花板由上游决定） |
| 必填性 | 🟡 平台能判 | 签名有无默认值（`[实测]` IndexTTS2 判出 4 个必填） |
| `call.bind`（text/ref_audio/output_path） | 🔴 必须人填 | 反射**显式排除**这三个（平台概念，非引擎参数） |
| `maps`（平台词→引擎方言） | 🔴 必须人填 | 机器自动映射会**静默出错**（`--fp16` ↔ `use_bf16` 近义非等价） |

---

## 7. 参数说明文本提取实测（补充证据）

`[实测]` 原型 `tools/dev/probe_param_docs.py`（本人独立重跑复核）：

| 引擎 | 参数数 | 自动拿到说明 | 覆盖率 |
|---|---|---|---|
| index-tts | 25 | 15 | **60.0%** |
| cosyvoice2 | 13 | 1 | **7.7%** |
| gpt-sovits（签名） | 2 | 1 | 50.0% |
| gpt-sovits（dict 层） | 24 | 24 | **100%** |

**六条障碍**（详见 `tools/dev/PARAM_DOCS_PROBE_REPORT.md` §5.2）：
说明不在标准位置 · 上游普遍不写 · 名字对不上 · 选项枚举不在源码 ·
上游文本可能有 bug（GSV `"text_lang: ""` 引号不配平）· dict 参数靠运气。

---

## 8. 顺带修好的环境缺陷（实测，已记录）

详见 [`ENGINE_ENV_DEFECTS_2026-10-09.md`](./ENGINE_ENV_DEFECTS_2026-10-09.md)：

| # | 缺陷 | 状态 |
|---|---|---|
| 1 | **`uv venv` 不复制 `python3.dll`** ⇒ 所有 abi3 轮子加载失败（5 个 venv 全中） | ✅ 已修（补文件），⚠️ 需落成平台侧修复 |
| 2 | **上游 `uv.lock` 硬锁 CUDA 版 torchaudio**，向导只换 torch 的 index | ✅ 已修（升 torch/torchaudio 2.10+xpu） |
| 3 | **进度文件与 venv 状态脱钩** ⇒ 环境重建后永远装不上 | 📝 已记录，未修 |

⭐ 修好环境后，`reflect_params.py` **第一次在真引擎上跑通**（详见 [`REFLECT_FIRST_RUN_2026-10-09.md`](./REFLECT_FIRST_RUN_2026-10-09.md)）。

---

## 9. 三个难点的答案（一句话版）

| # | 难点 | 答案 |
|---|---|---|
| **一** | 找全参数 | **没有单一方法通吃**。CLI 最强（有 CLI 时超反射），README 表几乎没用，**dict 类引擎只有读源码**（GSV 27 个）。必须多源合并 |
| **二** | 映射到平台 | 必传映射率 **≈81%**。**扩 `speaker` 一词解决 4 台**，再加 `source_audio` / `instruct_text` 接近 100% |
| **三** | 引导用户填 | 5 种可借鉴形式（tooltip / 下拉 / 默认值 / 折叠 / 报错）。⛔ **但必须守住「不解释、不补全、不校验」** —— 平台只做「名片 → UI」的机械翻译 |

---

## 10. ⚠️ 本文件的不确定处（不许当结论用）

1. **难点二的映射率 81%** 来自子 Agent 调研，我只抽验了两台（IndexTTS2 / GSV）。
   其余 12 台的必传判定**未逐台核实**。
2. **`speaker` / `source_audio` / `instruct_text` 三个建议词**是调研提出，**未经 Owner 裁决**，
   也未验证加入后对现有四台引擎有无副作用。
3. **难点一的 20+ 引擎分布表**来自调研，本机只实测了 4 台。
4. **说明文本覆盖率**只测了 3 台，且**天花板由上游决定** —— 换引擎可能更差。
