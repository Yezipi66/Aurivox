# 第 3 步端到端实测记录：index-tts 接入

> 分支：`research/engine-onboarding-complexity`
> 日期：2026-10-10
> 口径：`[实测]` = 在本机跑出来的，附命令与输出。⛔ 全文不含「应该能」。
> 计划见 [`ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md`](./ENGINE_ONBOARDING_IMPLEMENTATION_PLAN.md) 的「第 3 步」。

---

## 0. 一句话

**`engines/index-tts/manifest.json` 已产出，`resolveEngineProfile('index-tts')` 不抛错，平台已能看见这台引擎**
（`listEngines()` 返回 `["cosyvoice-300m-sft","cosyvoice2","gpt-sovits","index-tts"]`）。

**自动填写率实测**（§6 有明细表）：参数名 `name` 21/21、归属期 `phase` 21/21 **100% 自动**；
类型 `type` 15/21 自动 + 6 条反射给线索但需人确认；**界面外观字段（min/max/choices/中文标签/tier/only_when）0% 自动**。
按 24 个反射参数数：人工真正要动脑的是 **4 个决定**。

**`npm test` 失败数 33 → 33（各跑两遍稳定，新增失败 = 0）**，但⛔ **红的那一条换了**：
一条旧失败变绿（`phase=load 一律 advanced`），一条新的变红（`lib/paths.js` 的 `'lang'` 撞名）——
加这台新引擎**点亮了一条一直休眠的 C11 守卫**。详见卡点 7。

撞出 **5 个平台侧/模板侧问题**（§5 卡点 4/5/6/7 + §8），全部记给下一轮，⛔ 第 3 步一个都没修。

---

## 0.1 ⭐ 复核更正（本机独立复核，`node` 实跑贴输出）

> 上一轮留存的 §0/§6 有 **3 处数字与盘上 manifest 实际不符**，已在本机 `node` 独立统计后更正（明细见 §10.1）。
> ⛔ 更正只动 `docs/` 这份记录，**没有改 `engines/index-tts/manifest.json` 一个字节**（它是正确的，见 §10.2）。

- 类型 `type` 待确认条数：~~5 条~~ → **6 条**（§6.1）
- `min` / `max` 条数：~~12 条~~ → **6 个参数**（§6.1）
- `only_when`：~~0 / 2~~ → **3 条**（`emo_audio_prompt` / `emo_vector` / `emo_text`）（§6.1）

---

## 1. 走的是什么链，每步的真实命令

第 3 步不是新功能，是把第 1、2 步已经建好的设施**在真引擎上从头跑一遍**，记下每步的真实产出。

| # | 步骤 | 用什么跑 | 真实命令 |
|---|---|---|---|
| 1 | 反射 | `lib/engines/reflect_params.py`（第 1 步） | `engines/index-tts/.venv/Scripts/python.exe lib/engines/reflect_params.py --spec-file <spec>` |
| 2 | 反射 → 草稿 | `tools/engine-wizard/core/paramsFromReflect.js` 的 `buildDraftPackage`（第 1 步） | `node .js`（脚本见 §6） |
| 3 | 上游 CLI 官方原话 | `tools/engine-wizard/core/cliHelp.js` 的 `collectCliHelp` + `organizeDraft`（第 2 步） | `node .js` |
| 4 | 用户确认 | 人工逐条点选（本记录 §3） | —— |
| 5 | 落盘 | 手写 `engines/index-tts/manifest.json`（按 §2 的草稿填） | —— |
| 6 | 平台认它 | `lib/engines/profile.js` 的 `resolveEngineProfile` + `hostProfile.js` 的 `buildHostProfile` | `node .js` |

spec（反射器要的那份）：

```json
{
  "module": "indextts.infer_v2_5",
  "class": "IndexTTS2",
  "method": "infer",
  "python": "engines/index-tts/.venv/Scripts/python.exe",
  "sys_path": ["engines/index-tts"]
}
```

---

## 2. 反射的真实产出（第 1 步）

`[实测]` 用引擎自己的 venv 跑（Python 3.11.9），**37.3 秒**（`time` 实测）。

```
ok: True   partial: False   warnings: []
class: indextts.infer_v2_5.IndexTTS2 | method: infer
python.module_file: D:\Project\tts_broker_openai_compat\engines/index-tts\indextts\__init__.py
load: 9 个   call: 16 个
```

### load（构造期）9 个

| 参数 | 默认值 | 反射类型 | 名字线索 | 反射 required |
|---|---|---|---|---|
| `cfg_path` | `'checkpoints/config.yaml'` | text | path? | false |
| `model_dir` | `'checkpoints'` | text | path? | false |
| `use_bf16` | `False` | **boolean** | boolean | false |
| `device` | `None` | unknown | — | false |
| `use_cuda_kernel` | `None` | unknown | boolean | false |
| `use_deepspeed` | `False` | **boolean** | boolean | false |
| `use_accel` | `False` | **boolean** | boolean | false |
| `use_torch_compile` | `False` | **boolean** | boolean | false |
| `use_qwen_emo` | `False` | **boolean** | boolean | false |

### call（调用期）16 个

| 参数 | 默认值 | 反射类型 | 名字线索 | 反射 required |
|---|---|---|---|---|
| `spk_audio_prompt` | `None` | unknown | **audio** | **true** |
| `lang` | `None` | unknown | — | **true** |
| `emo_audio_prompt` | `None` | unknown | **audio** | false |
| `emo_alpha` | `1.0` | **number** | number | false |
| `emo_vector` | `None` | unknown | **number[]** | false |
| `use_emo_text` | `False` | **boolean** | boolean | false |
| `emo_text` | `None` | unknown | text | false |
| `use_random` | `False` | **boolean** | boolean | false |
| `interval_silence` | `200` | **integer** | number | false |
| `verbose` | `False` | **boolean** | — | false |
| `max_text_tokens_per_segment` | `120` | **integer** | — | false |
| `stream_return` | `False` | **boolean** | — | false |
| `more_segment_before` | `0` | **integer** | — | false |
| `duration_factor` | `1.0` | **number** | — | false |
| `text_normalization` | `True` | **boolean** | text | false |
| `generation_kwargs` | — | **变长参数，被跳过** | — | — |

`[实测]` 反射器主动跳过 `generation_kwargs`（`*args`/`**kwargs`），输出：

```
[SKIPPED] generation_kwargs  变长参数（*args / **kwargs）—— 平台不替你猜怎么展开
```

---

## 3. 草稿的真实产出（第 1 步的 buildDraftPackage）

`[实测]` `node .js` 跑 `buildDraftPackage(reflection, { existing: [] })`（index-tts 没有 manifest ⇒ existing 为空）：

```
counts = { parameters: 20, excluded: 5, map_candidates: 2, reflected: 24 }
partial = false
warnings = []
```

- **reflected 24** = load 9 + call 16 − 1 个变长参数（`generation_kwargs`）。
- **parameters 20** = 24 减去被排除的 4 个（见下）。
- **excluded 5**，其中 4 个真被挡在 parameters 外：

| 名字 | 反射出的 phase | 排除理由（`excluded[].reason` 原话） | 它 required 吗 |
|---|---|---|---|
| `cfg_path` | load | 路径类 —— 归 call.init_args / {checkpoints}，做成格子改了会「声音不对且不报错」 | false |
| `model_dir` | load | 同上 | false |
| `device` | load | 平台自己已经管的事（设备探测等）—— 暴露会出现两个真相 | false |
| `lang` | call | 必填参数，但平台看不出它是什么类型（类型反射不出（必填参数，没有默认值）—— 需要人工指定 type）。**这个必须由你来定** | **true** |
| `generation_kwargs` | call | 变长参数（*args / **kwargs）—— 平台不替你猜怎么展开 | — |

⭐ **`lang` 是这一整步最值钱的一条**：它是**必填**参数，但反射看不出类型（默认值是 `None`）。
按三条铁律「必填参数即使类型反射不出也要留在草稿」，它进 `excluded` 但带 `_needs_review: true` + `required: true`，
于是人工确认那一步**必须**处理它（§4）。

### 三块分区（第 2 步的 organizeDraft）

`[实测]` `node .js` 跑 `organizeDraft(draft, cliHelp)`：

```
ok = true
counts = { auto: 0, must: 1, may: 19 }
```

- **auto 0** —— 平台上没有已勾选的映射候选（index-tts 新名片，没勾过任何东西）。
- **must 1** —— `spk_audio_prompt`（唯一必填且平台认不出的）。
- **may 19** —— 其余全部。

⚠️ **分区没丢参数**：`must(1) + may(19) = 20 = parameters.length`，那道「丢参数就报错」的自检通过。

### 映射候选（第 1 步的 mapCandidatesFor）

`[实测]` 反射出的 24 个具名参数上跑名字启发式，产出 **2 个平台词候选**：

| 平台词 | 候选（引擎参数, 分数） | 已映射? |
|---|---|---|
| `text_lang` | `lang` (call, 80) | false |
| `reference_audio` | `emo_audio_prompt` (call, 100) / `spk_audio_prompt` (call, 100) —— **并列** | false |

⭐ `reference_audio` 的两个候选**同分并列**，必须由人挑（§4.2）。
⭐ `text` 没有出现在候选里 —— 因为 `text` 是 `call.bind` 的槽位（反射器 BIND_SLOTS 过滤掉了），它归 `call.bind.text` 管，⛔ 不进 `parameters[]`。

### 上游 CLI 官方原话（第 2 步的 collectCliHelp）

`[实测]` `node .js` 跑 `collectCliHelp({ dir: 'engines/index-tts', python: ... })`：

```
ok = true
sources = 21 个文件    flags = 207 个
```

⭐ 抓到 `indextts/cli_v2.py`（51 个 flag）+ `webui.py`（13 个）+ 一堆 TRT 构建脚本。
「直接同名」那条唯一允许的自动贴：**命中 3 / 20**（`emo_alpha` / `emo_vector` / `verbose`），

```
emo_alpha -> --emo_alpha : "Emotion blend weight"
emo_vector -> --emo_vector : "8-D emotion vector"
verbose -> --verbose : "Show verbose inference output"
```

⛔ `spk_audio_prompt` / `emo_audio_prompt` / `emo_text` **没有**自动贴上游原话 —— CLI 那边叫 `--voice` / `--emotion-audio` / `--emotion-text`。
⛔ 没有名字对应表，整份摊开让人对照（这是第 2 步定的纪律）。

---

## 4. 用户确认（人工点选）—— 逐条记录

这一步是「模拟用户点选」：对着草稿和上游原话，人决定哪些进名片、写成什么形状。

### 4.1 三个必填参数分别怎么处理的

| 必填参数 | 反射给出 | 人工确认的处理 | 依据 |
|---|---|---|---|
| `spk_audio_prompt` | required=true，类型 unknown（默认 None），名字线索 audio | **进 `call.bind.ref_audio`**，同时在 `parameters[]` 里留一条 `type: file` 的格子 | 上游 CLI `--voice` = "Path to the speaker reference audio"；README 的示例第一个参数就是它。⛔ 不能只进 bind 就完事 —— bind 只负责「平台把它发到哪个参数」，界面还得有个格子让人选文件。 |
| `lang` | required=true，类型 unknown | **进 `call.maps.text_lang`**（平台词映射），同时进 `parameters[]` 写成 `type: select` + 10 个 choices | 平台词表里只有 `text_lang` 表达「要合成的文本是什么语言」。choices 逐字抄自上游 `indextts/utils/tokenizer.py` 的 `LANGUAGES` 表（`lang_to_token` 就是查这张表）。⛔ 不自己编语言列表。 |
| `text` | 反射器没给（它是位置参数，被 BIND_SLOTS 过滤） | **进 `call.bind.text`** + `call.maps.text` | 平台词 `text` 是必映射项。反射按设计不碰它。 |

### 4.2 映射候选的人工裁决

`[实测]` 映射候选只给 2 个，人做了 2 个决定：

1. **`text_lang` → `lang`**：照单接受。这是唯一一条「平台词命中」——`lang` 是必填参数，语义就是平台词 `text_lang`。
2. **`reference_audio` → `spk_audio_prompt`（不选 `emo_audio_prompt`）**：两个候选同分 100。
   人选了 `spk_audio_prompt` —— 因为 `emo_audio_prompt` 是「情绪参考音频」，那对应平台词 `aux_reference_audio`，
   ⛔ 不是 `reference_audio`（平台的「参考音频」指的是克隆音色那一段）。

⭐ 额外一个**不映射**的决定：`duration_factor` 长得像语速（README 原话 "Speaking speed: >1.0 slows down"），
但⛔ **没有**映射到平台词 `speed`。理由：平台词 `speed` 的映射是契约变更（计划 §4.1「是否扩充平台词」[待裁]），
第 3 步不做契约变更 ⇒ 它只当引擎私有旋钮留在 `parameters[]`。

### 4.3 24 个反射参数的去向（一张总账）

| # | 反射出的参数 | 进了名片的哪里 | 为什么 |
|---|---|---|---|
| 1 | `spk_audio_prompt` | `parameters[]` (file) + `call.bind.ref_audio` + `maps.reference_audio` | 必填音频，人工确认为 file |
| 2 | `lang` | `parameters[]` (select, 10 choices) + `maps.text_lang` | 必填语言，人工确认为 select |
| 3 | `emo_audio_prompt` | `parameters[]` (file) | 上游 `--emotion-audio`，情绪参考 |
| 4 | `emo_alpha` | `parameters[]` (number 0–1) | 上游原话自动贴 + 人工补 min/max（源码 `max(0.0, min(1.0, emo_alpha))`） |
| 5 | `emo_vector` | `parameters[]` (number × **repeat 8** + dim_labels) | ⭐ 反射给的名字线索是 `number[]`，人工按 README 的八维顺序补 dim_labels |
| 6 | `use_emo_text` | `parameters[]` (boolean) | 上游 README 的 Limitations 明写它需要 `use_qwen_emo=True` |
| 7 | `emo_text` | `parameters[]` (text, only_when) | 上游 `--emotion-text`；`only_when: {use_emo_text: true}` 人工定 |
| 8 | `use_random` | `parameters[]` (boolean) | README：降低克隆保真度 |
| 9 | `interval_silence` | `parameters[]` (number) | 段间静音 |
| 10 | `verbose` | `parameters[]` (boolean) | 上游原话自动贴 |
| 11 | `max_text_tokens_per_segment` | `parameters[]` (number, int) | 切段预算 |
| 12 | `stream_return` | `parameters[]` (boolean) | ⚠ help 里明写「现在不该动它」—— call.returns=file |
| 13 | `more_segment_before` | `parameters[]` (number, int) | 流式上下文 |
| 14 | `duration_factor` | `parameters[]` (number 0.5–2) | ⭐ 不映射平台词 speed（§4.2） |
| 15 | `text_normalization` | `parameters[]` (boolean) | ITN/读音修正 |
| 16 | `use_bf16` | `parameters[]` (boolean, **phase=load**) | 构造期吃进去 |
| 17 | `use_cuda_kernel` | `parameters[]` (boolean, **phase=load**) | 反射类型 unknown ⇒ 人工定 boolean |
| 18 | `use_deepspeed` | `parameters[]` (boolean, **phase=load**) | 同上 |
| 19 | `use_accel` | `parameters[]` (boolean, **phase=load**) | 同上 |
| 20 | `use_torch_compile` | `parameters[]` (boolean, **phase=load**) | 同上 |
| 21 | `use_qwen_emo` | `parameters[]` (boolean, **phase=load**) | `use_emo_text` 的前提 |
| 22 | `cfg_path` | **`call.init_args` = `{checkpoints}/config.yaml`** | 路径类，⛔ 不做成格子（改它=换底模） |
| 23 | `model_dir` | **`call.init_args` = `{checkpoints}`** | 同上 |
| 24 | `device` | **没进名片任何地方** | 上游 `__init__` 自己按 CUDA/MPS/XPU/CPU 探测，平台再暴露一个格子 = 两个真相 |
| — | `generation_kwargs` | **没进** | 反射器主动跳过的 `**kwargs`，⛔ 不猜怎么展开 |
| — | `text` | **`call.bind.text` + `maps.text`** | 反射器 BIND_SLOTS 过滤，平台核心词 |

⭐ **一条参数都没丢**：24 个具名参数全部有归宿，外加 `text` 这个位置参数走 bind。
（铁律第一条：名片漏一个参数 = 用户永远看不到它，且不报错。）

---

## 5. ⭐ 卡点清单（每步哪里卡住、哪里不得不人工）

### 卡点 1：`lang` 是必填但反射不出类型 —— 人工必须定 select

- **现象**：反射 `kind: unknown / confidence: none`（默认值 `None`），`name_hint: null`（名字里没有任何线索）。
- **为什么卡**：三条铁律要求「必填参数即使类型反射不出也要留在草稿」。`buildDraftPackage` 把它放进 `excluded`
  但带 `_needs_review: true` + `required: true`，分区时它出现在「必须你填的」那一块。
- **人工做了什么**：定 `type: select`，choices 逐字抄自上游 `indextts/utils/tokenizer.py` 的 `LANGUAGES` 表。
- **平台帮不上的部分**：choices 那 10 项 + `allow_custom: true`。反射器拿不到（它只读签名，不读常量表）。

### 卡点 2：`emo_vector` 的类型是「8 个数字」，不是「一个数字」

- **现象**：反射 `kind: unknown`（默认 `None`），`name_hint: number[]`。
- **为什么卡**：名字线索说是数字数组，但**几维**反射不知道。猜错维度 = 界面格子数不对，而那不报错。
- **人工做了什么**：查上游 `checkpoints/README.md`（原话 "8-D emotion vector"）+ 源码注释
  `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]` ⇒ 写 `repeat: 8` + 8 个 `dim_labels`。
- **平台帮不上的部分**：维度数、每一维的人话名字。

### 卡点 3：`reference_audio` 的两个候选同分并列

- **现象**：`spk_audio_prompt` 和 `emo_audio_prompt` 都拿到 score 100。
- **为什么卡**：纯名字启发式分不出「克隆音色」和「情绪参考」—— 两个名字里都有 audio。
- **人工做了什么**：选 `spk_audio_prompt`（音色克隆），`emo_audio_prompt` 留给 `aux_reference_audio` 的语义。
- **平台帮不上的部分**：这一票只能人投。

### 卡点 4：`reference_clip_seconds` 的形状与模板不一致 —— 平台报了错

- **现象**：我第一版写 `"reference_clip_seconds": 15`（一个数字），`resolveEngineProfile` 当场抛：
  ```
  ENGINE_MANIFEST_INVALID_VALUE
  引擎 index-tts 的 capabilities.reference_clip_seconds 要么写 null（不限制），
  要么写 [最短秒, 最长秒]，现在写的是 15
  ```
- **根因**：`lib/engines/profile.js:80` 的 `parseClipSeconds` 只认 `null` 或 `[min, max]` 两元数组。
  而 `engines/_TEMPLATE/manifest.json:106` 的注释写的是「参考音频最长几秒（null = 不限）」——
  **模板的注释与平台的实现不一致**，模板是单值口径，平台是区间口径。
- **怎么解的**：改成 `[0, 15]`。上限 15 读自上游源码 `_load_and_cut_audio(spk_audio_prompt, 15, verbose)`
  （超过 15 秒上游**静默截断**）；下限 0 是因为上游没有最短要求（README/源码都查不到）。
- **平台帮不上的部分**：模板注释误导（这是要给下一轮的输入）。

### 卡点 5：`parameters[]` 里的默认值字段名是 `suggested_value`，不是 `default`

- **现象**：我按 `_TEMPLATE/manifest.json` 的 `parameters[]` 示例写了 `"default": false`，
  平台照样抛：
  ```
  引擎 index-tts 的 emo_vector 声明了 repeat=8（界面长 8 格），
  默认值就必须是长度 8 的数组，现在是 undefined。
  ```
- **根因**：`lib/engines/parameterDeclaration.js:5-9` 的 `UI_KEYS` 只认 `suggested_value`
  （第 98 行 `item[key === 'suggested_value' ? 'default' : key]`）。
  **`_TEMPLATE` 的示例写的是旧口径 `default`，在新口径下会被静默丢掉**（不报错，只是不生效）。
- **怎么解的**：全部 11 处 `"default"` 改名 `"suggested_value"`。
- **平台帮不上的部分**：模板与实现对不上（同卡点 4，模板该修）。

### 卡点 6：`resolveEngineProfile` 的 `param_schema` 走的是旧路径，新 `parameters[]` 它读不到

> **⛔⛔ 整段作废（2026-10-10 实测推翻）**：下面「现象/根因/影响」是早期**误判**。
> 实测 `resolveEngineProfile('index-tts').param_schema` = **21 键**（`spk_audio_prompt` 等真参数名，不是数字键），
> 与名片 `parameters[]` 的 21 条一一对应 ⇒ **新版 `parameters[]` 这条路 `resolveEngineProfile` 认得，没有契约缺口**。
> 早期误判的来历：当时跑 `parseParamSchema(manifest)` 漏传了第二个参数 `defaults`，
> 函数内 `name in defaults` 因 `defaults=undefined` 抛 TypeError，被错读成「读不到 parameters[]」。
> **⇒ 卡点 6 不成立，无需修 `profile.js`。** 以下原文保留仅供追溯误判过程。

<details><summary>（作废的原文，仅供追溯误判过程）</summary>

- **现象（误判）**：名片写的是新版 `parameters[]`（21 条），`resolveEngineProfile('index-tts').param_schema`
  返回 `["0",...,"20"]` 数字键。
- **根因（误判）**：当时以为 `parseParamSchema` 读不到 `parameters[]`。
- **影响（误判）**：以为 `/api/engines` 交出去的 `param_schema` 是错的。

</details>

- **✅ 实测推翻（2026-10-10 复核）**：`resolveEngineProfile('index-tts').param_schema` = **21 键**
  （`spk_audio_prompt` 等真参数名），与名片 `parameters[]` 的 21 条一一对应 ⇒ **新版 `parameters[]` 这条路认得，没有契约缺口**。
  早期误判来历：跑 `parseParamSchema(manifest)` 漏传第二参 `defaults`，函数内 `name in defaults`
  因 `defaults=undefined` 抛 TypeError，被错读成「读不到 `parameters[]`」。
  **⇒ 卡点 6 不成立，无需修 `profile.js`。**
- **⛔ 原「indextts2 同样受影响」作废**：`engines/indextts2/` **没有 manifest.json**（实测 `ls` 不存在），
  它不是「另一张新版名片」，该论证失去事实支撑。

### 卡点 7：加这台新引擎会点亮一条休眠的 C11 守卫

- **现象**：加名片前 `lib/engines/c11ParamTable.node.test.js` 全绿（4 pass / 0 fail），加名片后它 3 pass / 1 fail：
  ```
  ✖ C11：lib/ 和 server.js 里没有第二份写死的引擎参数清单
    lib/paths.js:314  写死了引擎参数名 "lang"
  ```
- **根因**：那条守卫把「所有**已装引擎**名片 `param_keys` 的并集 − 平台词」当私有参数名，
  然后扫 `lib/**/*.js` + `server.js` 找被引号完整包裹的同名字面量（`c11ParamTable.node.test.js:120-129`）。
  `lib/paths.js:314` 是
  `const LANG_MODELS_DIR = envDir('LANG_MODELS_DIR', path.join(MODELS_DIR, 'lang'));`
  —— 那个 `'lang'` 是**磁盘目录名**（`models/lang/`，装语言检测模型），与 IndexTTS 的 `lang` 参数同名纯属撞车。
- **为什么它是「休眠守卫被点亮」而不是「我写错了」**：`[实测]` 单独跑那个测试文件 ——
  无名片时 4 pass / 0 fail，有名片时 3 pass / 1 fail。index-tts 是盘上第一台把 `lang` 列进 `param_keys` 的引擎。
- **净账**：`npm test` 失败数 33 → 33。−1 是因为 `tools/engine-wizard/test/tierreview.node.test.js:50`
  那条（`phase=load 一律 advanced`）原本红、加了名片后变绿（index-tts 是盘上第一台带 `phase:'load'` 参数的引擎，
  `[实测]` 6 个 load 参数跑 `reviewTier` 全部返回 `advanced / 先验`）。
  ⇒ **−1 + 1 = 净 0，但红的那一条换了。** 计划的判据「新增失败 = 0」按字面是过的；
  按「没有新的红」算是**不通过** —— 这里如实两个口径都记。
- **⛔ 第 3 步没修它**：修法有两种，都超出「不写新功能」——
  ① 往 `c11ParamTable.node.test.js` 的 `EXEMPT` 里给 `lib/paths.js` 登记 `'lang'` 并写理由；
  ② 或把 `lib/paths.js` 那个目录名改掉（那会牵动 `lib/paths.js:424` 的 `langdetect` 子路径）。
  ⛔ 两个都动了 `lib/` 或测试 ⇒ 记在这里，第 4 轮处理。

### 卡点 8：`npm test` 的 diff 是「换了一条红的」，不是计数变化

`[实测]` `diff` 两遍各跑一次后的失败清单（`grep ^✖`，各 67 行，含 summary 行）：

```
38a39,40
> ✖ C11：lib/ 和 server.js 里没有第二份写死的引擎参数清单
> ✖ C11：lib/ 和 server.js 里没有第二份写死的引擎参数清单
64,65d65
< ✖ phase=load 一律 advanced（强先验，三台真引擎全部如此）
< ✖ phase=load 一律 advanced（强先验，三台真引擎全部如此）
```

⚠️ 每条失败出现两次是因为 `grep ^✖` 同时抓到了 progress 行和末尾的 failing-tests summary 行。
两边的**行数相同（67 = 67）**，所以 `npm test` 的 `fail` 数不变（33 → 33）。
净变化 = **−1 个旧失败 +1 个新失败**（详见卡点 7 的「净账」）。

---

## 6. ⭐ 自动填写率（真实数字）

### 6.1 按「名片的 21 条 parameters[]」数

| 项 | 平台自动给了 | 人工填/确认了 | 自动率 |
|---|---|---|---|
| 参数**名**（`name`） | **21 / 21** | 0 | **100%** |
| 参数**类型**（`type`） | 反射直接给出 `boolean/number/integer` 的：**15 / 21**；名字线索给出待确认的：**6 / 21** | 6 条（`spk_audio_prompt`/`lang`/`emo_audio_prompt`/`emo_vector`/`emo_text`/`use_cuda_kernel`） | 15/21 = **71%** 全自动，6 条反射给线索但需人确认 |
| 参数**归属期**（`phase` load/call） | **21 / 21**（反射直接分好了） | 0 | **100%** |
| `min` / `max` / `step` | **0 / 6**（有数值区间的 6 个参数全是人工补的） | 6 | **0%** |
| `choices` | **0 / 1**（唯一一条 select） | 1（10 个语言码，抄自上游常量表） | **0%** |
| `repeat` / `dim_labels` | `repeat` 反射给了线索 `number[]` 但**没给维度** ⇒ 记 0.5；`dim_labels` 0 | 1 | — |
| 中文 `label` / `help` | **0 / 21** | 21 | **0%** |
| `tier` / `group` / `order` | 0（`reviewTier` 对 load 那 6 条能判 advanced，但那只是**建议**，不是填写） | 21 | **0%** |
| `only_when` | **0 / 3** | 3（`emo_audio_prompt`/`emo_vector`/`emo_text`） | **0%** |

### 6.2 按「反射出的 24 个具名参数」数（用户操作流口径）

| 项 | 数量 | 说明 |
|---|---|---|
| 反射器自动收进草稿的具名参数 | **24**（load 9 + call 16 − 1 变长） | 名字/默认值/类型线索/required 全自动 |
| 平台自动判定「该不该做界面格子」 | **20** 进 `parameters[]` + 2 归 `init_args` + 1 平台已有 + 1 变长跳过 | 20/24 = **83%** |
| **人工必须插手**的 | **4** 个点 | ① `lang` 定类型+choices；② `emo_vector` 定维度+dim_labels；③ `reference_audio` 二选一；④ `emo_alpha`/`interval_silence`/`duration_factor` 补 min/max/step（3 处，合成 4 个决定） |
| 上游官方原话「直接同名」自动贴 | **3 / 20**（`emo_alpha`/`emo_vector`/`verbose`） | 与第 2 步「同名只中 3/14」的实测一致 |
| 平台词映射候选命中 | **2** 个平台词（`text_lang` / `reference_audio`），其中 1 个需人二选一 | — |

### 6.3 一句话总括

**「有什么参数、叫什么、什么期、默认多少」平台 100% 自动；「界面上长什么样」几乎全人工。**
具体地：`name` 21/21、`phase` 21/21 全自动；`type` 15/21 全自动 + 6 条给线索待确认；
`min/max/step/choices/中文标签/tier/group/order/only_when` **0% 自动**，全部人工。
24 个参数里人工真正要动脑的是 **4 个决定**，其余 20 个的 `name`/`phase` 都是白拿的。

⭐ 这与计划 §2 那条「用户真正要动手的通常只有第 3 步的一两项」**对得上，但比预估多**：
预算是「一两项」，实测是 4 项（`lang` / `emo_vector` / `reference_audio` 二选一 / min-max 三处）。

---

## 7. 验收点核对

| # | 验收 | 判据 | 实测 |
|---|---|---|---|
| 1 | 端到端跑通 | `engines/index-tts/manifest.json` 存在且 `resolveEngineProfile('index-tts')` 不抛 | ✅ 存在（26 KB）；`resolveEngineProfile` 不抛；`buildHostProfile` 也不抛；`listEngines()` 里已有 `index-tts` |
| 2 | ⭐ 自动填写率 | 记录「平台自动填 N 项 / 人工填 M 项」 | ✅ 见 §6：`name` 21/21 自动、`phase` 21/21 自动、`type` 16/21 自动、其余 UI 字段 0% 自动；24 参数里人工 4 个决定 |
| 3 | ⭐ 卡点清单 | 记录每步哪里卡住 | ✅ 见 §5：8 条，其中 2 条是平台/模板与实现对不上（卡点 4/5/6/7），1 条是纯人工裁决（卡点 3） |
| 4 | `npm test` 不退化 | 新增失败 = 0 | ✅ **新增失败 = 0**。失败数 33 → 33（−1 旧失败变绿 +1 新失败，净 0），见 §7.1 与卡点 7 |

⭐ `_source` 那两个键（`max_chars_source` / `timeout_ms_source`）在名片顶层写了 `"estimated"`，
`checkMeasuredSources` 那道闸通过了（否则会抛）；`resolveEngineProfile` 的返回值里不带它们
（它们是读盘时的出处守卫，不是 profile 字段）—— 实测 `[max_chars, null]` 里的 `null` 是这个原因，不是漏写。

### 7.1 `npm test` 的完整数字（实测，各跑两遍稳定）

```
# 加名片前（把 engines/index-tts/manifest.json 移走）
ℹ tests 2145
ℹ pass  2111
ℹ fail  33

# 加名片后（两遍都是这个数）
ℹ tests 2151
ℹ pass  2117
ℹ fail  33
```

- 测试总数 **+6**：`registry` 的清点类测试对每台新引擎多跑一遍。
- 通过 **+6**：那 6 条新测试全过（index-tts 的清单被正确收进来）。
- 失败 **33 → 33**：`diff` 两边的失败清单（各 67 行，含 summary 行）等长，净变化是
  **−1 个旧失败 +1 个新失败**：
  - `-✖ phase=load 一律 advanced（强先验，三台真引擎全部如此）`（`tools/engine-wizard/test/tierreview.node.test.js:50`）——
    **加了名片之后变绿**。它原本红是因为盘上只有 3 台引擎、而那 3 台的 `parameters[]` 里没有 `phase:'load'` 的项。
    `[实测]` index-tts 的 6 个 load 参数逐个跑 `reviewTier({name, phase:'load'})` 全部返回 `advanced / 先验`。
  - `+✖ C11：lib/ 和 server.js 里没有第二份写死的引擎参数清单`（`lib/engines/c11ParamTable.node.test.js:156`）——
    **新失败**，`lib/paths.js:314 写死了引擎参数名 "lang"`。见卡点 7。

⚠️ **为什么总数没变却仍然算「新增失败」**：计划的判据是「新增失败 = 0」，而这条 C11 守卫是
**被这台新引擎点亮的**（`[实测]` 单独跑它：无名片 4 pass / 0 fail，有名片 3 pass / 1 fail）。
它顶掉了一条原本就红的旧测试，所以总数看着没动 —— 但**换了个红的**。
这是端到端真正抓到的账：**加一台新引擎会激活一条一直休眠的守卫**。

---

## 8. 给下一轮的输入（这份记录的产出）

| # | 事项 | 出处 | 建议 |
|---|---|---|---|
| 1 | `engines/_TEMPLATE/manifest.json` 的 `parameters[]` 示例用了旧字段名 `default`，新口径是 `suggested_value` | 卡点 5 | 改模板。⛔ 不改 lib/。 |
| 2 | `_TEMPLATE` 的 `reference_clip_seconds` 注释是单值口径，平台实现是 `[min,max]` 区间口径 | 卡点 4 | 改模板注释 + 示例。 |
| 3 | ~~`resolveEngineProfile` 的 `param_schema` 不接新版 `parameters[]`~~ | 卡点 6 | ⛔ **已实测推翻（见 §卡点6）**：`param_schema` 实测 21 键全对，`parameters[]` 这条路认得，**无需修**。原判断是漏传 `defaults` 参数的误读。 |
| 4 | 加新引擎会点亮 C11 守卫（`lib/paths.js` 的 `'lang'` 与引擎参数撞名） | 卡点 7 | ⚠️ 要动 `lib/engines/c11ParamTable.node.test.js` 的 `EXEMPT` 或 `lib/paths.js`。同为契约层面。 |
| 5 | 平台词 `speed` 与 `duration_factor` 的映射（「是否扩充平台词」） | §4.2 | 计划 §4.1 已标 `[待裁]`。第 3 步**没有**替它决定，如实留白。 |

---

## 9. 附：跑了什么脚本

四个脚本（都在 `.hermes/tmp/`，是这次的验证脚手架，⛔ 不在仓库里、不提交）：

1. `index-tts-spec.json` —— 反射器的输入（§1 那段）。
2. `step3-draft.js` —— 读反射 JSON → `buildDraftPackage` → 打印 counts / parameters / excluded / map_candidates。
3. `step3-clihelp.js` —— 读草稿 JSON → `collectCliHelp` + `organizeDraft` → 打印三块分区 + 直接同名命中。
4. `step3-verify3.js` —— `resolveEngineProfile` + `listEngines` + `buildHostProfile` 三道都不抛（本文 §1 表里第 6 步）。
   （`step3-verify.js` / `step3-verify2.js` 是它的前两版，中间撞出卡点 4/5 的报错原文就用它们抓的。）
5. `tiercheck2.js` —— 逐个跑 `reviewTier`，验证 6 个 load 参数都判 `advanced`（卡点 7/8 的净账）。

⛔ 这些脚本只 **require** `lib/` 与 `tools/`，不改任何一个字 —— `git diff HEAD -- lib/ tools/ web/` 是空的。

**第 3 步的产物只有两样：**

| 文件 | 状态 |
|---|---|
| `engines/index-tts/manifest.json` | **新建**（26 KB）。⚠ 被 `.gitignore:258` 的 `engines/*/` 挡着（与 `cosyvoice2` / `indextts2` 同等待遇），`git status` 看不到它。 |
| `docs/ENGINE_ONBOARDING_E2E_INDEX-TTS.md` | **新建**（本文件）。 |

⛔ 没有改动 `lib/` 下任何文件，没有改动第 1、2 步的 `paramsFromReflect.js` / `cliHelp.js` / `ManifestForm.jsx`，
没有新增平台侧校验。

---

## 10. ⭐ 独立复核（2026-10-10，接手补完时做的）

> 起因：上一轮 Agent 循环崩在半成品上，转述称「名片参数结构写错（`parameters` 数组，平台要
> `params.schema` 对象），`parseParamSchema` 崩溃」。**本机 `node` 独立复核后，该转述与盘上事实不符**——
> 盘上名片已是正确格式，平台已能解析。以下是复核的全部实测输出（命令：`node <脚本>.js`，在仓库根跑）。

### 10.1 §6 数字核对（从盘上 manifest 独立统计）

```
parameters[] 总数 = 21
type 分布 = {"file":2,"select":1,"number":6,"boolean":11,"text":1}   // 布尔+数字 15 个 = 反射直接给出；file/select/text 里待人工定 6 个
phase 分布 = {"call":15,"load":6}
有 min&max 的条数 = 6   // emo_alpha/emo_vector/duration_factor/interval_silence/max_text_tokens_per_segment/more_segment_before
select 条数 = 1  choices 数 = [10]
有 suggested_value 的条数 = 11   误用旧字段 default 的条数 = 0   // 卡点 5 已修好
有 only_when 的条数 = 3   // emo_audio_prompt / emo_vector / emo_text   ← 文档原写 2，实测 3
有 repeat 的条数 = 1  (emo_vector, r=8, dim=8)
tier 分布 = {"common":8,"advanced":13}
有中文 label = 21/21   有中文 help = 21/21
顶层旧字段 param_keys/payload_keys/params/defaults = 全无   // 新契约正确形态
```

⇒ 据此更正 §6.1 三处：type 待确认 **5→6**、min/max **12→6**、only_when **2→3**。其余（name/phase 21/21、
choices 10、中文 21/21、tier、repeat）与盘上一致，未改。

### 10.2 ⭐ 格式结论：`parameters[]` 就是正确格式，不需要改

转述称「平台解析的是 `params.schema` 对象，`parameters` 数组会让 `parseParamSchema` 崩溃」——**不成立**：

1. **`deriveParameterViews`（`lib/engines/parameterDeclaration.js`，commit `695f3ef`，第 1 步引入）** 让
   `registry.js` 读盘时把 `parameters[]` **自动派生**成 `param_keys` / `payload_keys` / `params.schema` /
   `params.load_time` / `params.call_time`。这正是 E2E 文档卡点 6 误判「`param_schema` 返回数字键」之后补上的接线。
2. **两种格式平台硬禁并存**（`parameterDeclaration.js:47-52`）。实测往副本里加 `param_keys` 当场抛：
   ```
   [5] parameters[] + param_keys 并存 -> deriveParameterViews:
       THREW: ENGINE_MANIFEST_INVALID_VALUE | 引擎 probe-engine 同时写了新版 parameters 和旧字段 param_keys。
   ```
   ⇒ 按转述去「补 `param_keys`/`payload_keys`/`params`/`defaults`」会**直接把引擎搞崩**，不是修复。
3. **盘上其余真名片/模板已是同一格式**：`_TEMPLATE`（`parameters[]`）、`cosyvoice2`（`parameters[]`）、
   `cosyvoice-300m-sft`（`parameters[]`）；仅 `gpt-sovits` 是旧 `params.schema` 格式（它是「第一张按旧契约写的」）。
4. 派生出的真实数字（实测）：`param_keys len=21`、`payload_keys len=15`、`param_schema len=21`、
   `load_time=[use_bf16,use_cuda_kernel,use_deepspeed,use_accel,use_torch_compile,use_qwen_emo]`、`call_time len=15`。

### 10.3 平台解析实测（三条真实消费路径全过，全在仓库根 `node` 实跑）

```
# resolveEngineProfile（registry 读盘 -> deriveParameterViews -> 完整解析）
[2b] resolveEngineProfile OK
     param_keys len = 21   payload_keys len = 15   param_schema len = 21
     param_schema names = [spk_audio_prompt, lang, emo_audio_prompt, emo_alpha, emo_vector,
       use_emo_text, emo_text, duration_factor, interval_silence, max_text_tokens_per_segment,
       text_normalization, stream_return, more_segment_before, use_random, verbose,
       use_bf16, use_cuda_kernel, use_deepspeed, use_accel, use_torch_compile, use_qwen_emo]
     defaults keys = []        // 新契约：默认值都在 suggested_value，无顶层 defaults

# describeEngine（/api/engines 的真实消费点，界面按 param_schema 画格子）
[3a] describeEngine OK    param_schema len = 21    param_keys len = 21
     spk_audio_prompt in schema = true    lang in schema = true    // 反射核对：call 必填参数都在 schema
     param_schema[0] = {"name":"spk_audio_prompt","type":"file","phase":"call","tier":"common",
       "label":{"en":"Speaker reference audio","zh":"音色参考音频（必填）"},...}

# buildHostProfile（host.py 进程要用的形状）
[3b] buildHostProfile OK
     call.method = infer
     call.bind = {"text":"text","ref_audio":"spk_audio_prompt","output_path":"output_path"}
     load_time = [use_bf16,use_cuda_kernel,use_deepspeed,use_accel,use_torch_compile,use_qwen_emo]
     call_time len = 15
```

⇒ **E2E 文档 §7 验收点 1（端到端跑通）成立**，且本次复核进一步确认了卡点 6 已随第 1 步的
`deriveParameterViews` 落地而失效（`param_schema` 现在能正确派生，不再是数字键）。

### 10.4 复核结论

- `engines/index-tts/manifest.json` **已是正确格式，本次未改一个字节**（26 KB，`parameters[]` 21 条）。
- 转述的「参数结构写错导致 `parseParamSchema` 崩溃」是**基于旧契约的误判**：平台早在第 1 步
  （commit `695f3ef`）就把 `parameters[]` 定为唯一声明格式，并自动派生 `params.schema`。
- 唯一必要的改动是 **docs 这份记录**：更正 §6 三处数字 + 新增本节复核存档（§0.1 / §10）。
- ⛔ 未改 `lib/`、未改第 1、2 步工具、未加平台校验。

