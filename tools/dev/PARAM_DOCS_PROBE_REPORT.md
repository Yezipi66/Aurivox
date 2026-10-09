# TTS 引擎参数「说明文本」自动提取 —— 原型验证报告

> 目标：验证平台能不能**自动**拿到每个参数的「人话解释」（用户看到一个参数名，
> 知道它是干什么的）。
>
> 全部数字都是**真跑出来的**（脚本 `tools/dev/probe_param_docs.py`，
> 结果落盘 `tools/dev/PARAM_DOCS_PROBE_RESULT.json`，终端输出
> `tools/dev/PARAM_DOCS_PROBE_OUTPUT.txt`）。
> 覆盖率的**分母 = 平台今天真实看到的参数个数**（由 `lib/engines/reflect_params.py`
> 反射得到），不是脚本自己编的集合。

---

## 0. 一句话结论（先说结果）

| 引擎 | 参数集合 | 自动拿到说明 | 覆盖率 | 主要来源 |
|---|---|---|---|---|
| **index-tts** | 25（9 加载 + 16 调用） | 15 | **60.0%** | docstring 9 / argparse 6 |
| **cosyvoice2** | 13（6 加载 + 7 调用） | 1 | **7.7%** | argparse 1 |
| **gpt-sovits** | 2（1 加载 + 1 调用） | 1 | 50.0% | docstring 1 |
| gpt-sovits **（dict 参数）** | 24（上游 docstring 里） | 24 | **100%** | docstring(dict 注释) |

**关键事实**：三台引擎的覆盖率差了近一个数量级（7.7% → 60%），
而**参数集合本身一个字节都没变** —— 差别全在「上游把说明写在哪」。
⇒ 「自动解释字段」**能做，但不是通用魔法**：它能不能成，取决于上游怎么写注释，
而不是取决于平台有多聪明。详见 §4。

---

## 1. 方法：三个源，都在原型里真跑过

脚本 `tools/dev/probe_param_docs.py` 从三个源提取（实现细节见脚本头注释）：

**(a) docstring**
- Google 风格 `Args:` 段 + `name (type): desc`（续行会拼回去）；
- Sphinx 风格 `:param name: desc`；
- 中文段落头（`参数:`）同样识别 —— 只认**结构**不认语言；
- gpt-sovits 特例：`"key": default,   # 注释` 这种「dict 里每个 key 的注释」。

**(b) argparse `help=`**
- 对每个 CLI 文件做 **AST 静态解析**（`add_argument` 调用），**不 import**：
  import CLI 会执行顶层代码（可能拉 gradio / 模型），且各引擎解释器不同。
- `--voice` 这类开关名 → Python 参数名，走**显式别名表 `ALIASES`**（§3.3）。
- index-tts 的两个 CLI（`cli.py` + `cli_v2.py`）都扫。

**(c) `Literal[...]` 选项**
- 从签名注解里摘 `Literal['a','b']` 的取值集合。
- **实测结果：三台引擎的相关参数上，一个 `Literal` 都没有** ⇒
  三个引擎的 `with_literal_choices` 全是 `[]`。这条源本次**零产出**（见 §4 障碍 4）。

⭐ 纪律：脚本只报「拿到什么」，拿不到就报 `null`；别名映射是**人写的显式表**，
命中就命中、不命中就报「未映射」，**绝不猜**。每条说明都带 `source_detail`
（指回 `文件 :: 类.方法 docstring` 或 `文件 :: --开关名`），可核对。

---

## 2. 逐参数明细表

### 2.1 index-tts（`indextts.infer_v2_5.IndexTTS2`，加载 9 + 调用 16 = 25）

**加载期参数（9 个，全部来自 `IndexTTS2.__init__` 的 docstring）**

| 参数名 | 有说明 | 来源 | 说明原文 |
|---|---|---|---|
| cfg_path | ✅ | docstring(__init__) | path to the config file. |
| model_dir | ✅ | docstring(__init__) | path to the model directory. |
| use_bf16 | ✅ | docstring(__init__) | whether to use bf16. |
| device | ✅ | docstring(__init__) | device to use (e.g., 'cuda:0', 'cpu'). If None, it will be set automatically based on the availability of CUDA or MPS. |
| use_cuda_kernel | ✅ | docstring(__init__) | whether to use BigVGan custom fused activation CUDA kernel, only for CUDA device. |
| use_deepspeed | ✅ | docstring(__init__) | whether to use DeepSpeed or not. |
| use_accel | ✅ | docstring(__init__) | whether to use acceleration engine for GPT2 or not. |
| use_torch_compile | ✅ | docstring(__init__) | whether to use torch.compile for optimization or not. |
| use_qwen_emo | ✅ | docstring(__init__) | if True, load the QwenEmotion text-to-emotion model. Required for ``infer(..., use_emo_text=True)``. Attempting to use emotion-text guidance when this is disabled will raise a RuntimeError. |

**调用期参数（16 个，来自 `infer()` 签名；`infer()` 本身无 docstring，说明靠 argparse 别名映射）**

| 参数名 | 有说明 | 来源 | 说明原文 |
|---|---|---|---|
| spk_audio_prompt | ✅ | argparse(alias: `--voice`) | Path to the audio prompt file |
| lang | ❌ | —— | （无） |
| emo_audio_prompt | ✅ | argparse(alias: `--emotion-audio`) | Default emotion reference audio for every batch task |
| emo_alpha | ✅ | argparse(alias: `--emotion-weight`) | Default emotion weight mapped to IndexTTS2 emo_alpha |
| emo_vector | ✅ | argparse(alias: `--emotion-vector`) | Default comma-separated 8-dimensional emotion vector |
| use_emo_text | ❌ | —— | （无） |
| emo_text | ✅ | argparse(alias: `--emotion-text`) | Default emotion description text for every batch task |
| use_random | ❌ | —— | （无） |
| interval_silence | ❌ | —— | （无） |
| verbose | ✅ | argparse(同名 `--verbose`) | Show verbose inference output |
| max_text_tokens_per_segment | ❌ | —— | （无） |
| stream_return | ❌ | —— | （无） |
| more_segment_before | ❌ | —— | （无） |
| duration_factor | ❌ | —— | （无） |
| text_normalization | ❌ | —— | （无） |
| generation_kwargs | ❌ | —— | （无，且是 `**kwargs`，平台本来就跳过） |

**小结**：15/25 = **60.0%**；来源 docstring 9 / argparse 6 / 无 10。

---

### 2.2 cosyvoice2（`cosyvoice.cli.cosyvoice.CosyVoice2`，加载 6 + 调用 7 = 13）

| 参数名 | 有说明 | 来源 | 说明原文 |
|---|---|---|---|
| model_dir | ✅ | argparse(同名 `--model_dir`) | local path or modelscope repo id |
| load_jit | ❌ | —— | （无） |
| load_trt | ❌ | —— | （无） |
| load_vllm | ❌ | —— | （无） |
| fp16 | ❌ | —— | （无） |
| trt_concurrent | ❌ | —— | （无） |
| tts_text | ❌ | —— | （无） |
| prompt_text | ❌ | —— | （无） |
| prompt_wav | ❌ | —— | （无） |
| zero_shot_spk_id | ❌ | —— | （无） |
| stream | ❌ | —— | （无） |
| speed | ❌ | —— | （无） |
| text_frontend | ❌ | —— | （无） |

**小结**：1/13 = **7.7%**；来源 argparse 1 / 无 12。

**为什么这么低（实测，非推测）**：
- cosyvoice2 的 `CosyVoice` / `CosyVoice2` / `CosyVoice3` **类和方法全都没有 docstring**
  （用 `ast.get_docstring` 逐节点扫过：`CosyVoice.__init__`、`inference_zero_shot` 均为 `NO`）。
- 它的**推理方法本身没有 CLI**。带 argparse 的是 runtime 示例
  （`runtime/python/fastapi/client.py`、`webui.py`）。这 11 条 argparse 记录里
  **只有 2 条带 `help=`**（`--mode`、`--model_dir`）；`--tts_text`、`--prompt_text`、
  `--prompt_wav`、`--spk_id` 都**没写 help**。
- ⇒ 唯一的产出是 `model_dir` 从 `webui.py` 的 `--model_dir` 撞上的。

**⭐ 关于「方法名 ↔ CLI 开关名映射」这条特别要求**：
- 好消息：cosyvoice2 的 CLI 开关名（`tts_text`/`prompt_text`/`prompt_wav`/`spk_id`）
  与 Python 参数名**字面完全一致**，映射**不需要别名表**（同名即可对上）。
- 坏消息：**对上了也没用** —— 因为那几个开关根本没写 `help=`，映射过去是空的。
- 真正的鸿沟不在「名字对不上」，而在**「CLI 压根没写说明」**。
- 另外：7 个调用期参数里，CLI **只覆盖 4 个**，`zero_shot_spk_id` / `stream` /
  `speed` / `text_frontend` 在任何 CLI 里都**没有对应开关** ⇒ 就算有 help 也拿不到。

---

### 2.3 gpt-sovits（`TTS.TTS`，加载 1 + 调用 1 = 2）

**签名层（平台今天看到的 2 个）**

| 参数名 | 有说明 | 来源 | 说明原文 |
|---|---|---|---|
| configs | ❌ | —— | （无） |
| inputs | ✅ | docstring(method) | 一整段 dict 注释（见下） |

**⭐ dict 参数（签名看不到，从 `TTS.run` 的 docstring `Args:` 段摘出，24 个）**

这是本次最反直觉的发现：**签名只有 2 个参数，docstring 里却完整写着 24 个真参数的说明。**

| dict key | 说明原文 |
|---|---|
| text | str.(required) text to be synthesized |
| ref_audio_path | str.(required) reference audio path |
| aux_ref_audio_paths | list.(optional) auxiliary reference audio paths for multi-speaker tone fusion |
| prompt_text | str.(optional) prompt text for the reference audio |
| prompt_lang | str.(required) language of the prompt text for the reference audio |
| top_k | int. top k sampling |
| top_p | float. top p sampling |
| temperature | float. temperature for sampling |
| text_split_method | str. text split method, see text_segmentation_method.py for details. |
| batch_size | int. batch size for inference |
| batch_threshold | float. threshold for batch splitting. |
| split_bucket | bool. whether to split the batch into multiple buckets. |
| speed_factor | float. control the speed of the synthesized audio. |
| fragment_interval | float. to control the interval of the audio fragment. |
| seed | int. random seed for reproducibility. |
| parallel_infer | bool. whether to use parallel inference. |
| repetition_penalty | float. repetition penalty for T2S model. |
| sample_steps | int. number of sampling steps for VITS model V3. |
| super_sampling | bool. whether to use super-sampling for audio when using VITS model V3. |
| return_fragment | bool. step by step return the audio fragment. (Best Quality, Slowest response speed. old version of streaming mode) |
| streaming_mode | bool. return audio chunk by chunk. (Medium quality, Slow response speed) |
| overlap_length | int. overlap length of semantic tokens for streaming mode. |
| min_chunk_length | int. The minimum chunk length of semantic tokens for streaming mode. (affects audio chunk size) |
| fixed_length_chunk | bool. When turned on, it can achieve faster streaming response, but with lower quality. (lower quality, faster response speed) |

**小结**：
- 签名层 1/2 = **50.0%**（`inputs` 那句其实只是整段 dict 的「容器说明」）；
- **dict 层 24/24 = 100.0%** —— 24 个真参数**每一个都有说明**。

**⭐ 实测发现的「上游 typo」**：上游本来写了 **25** 个 key，其中一行写坏了 ——

```
"text_lang: "",               # str.(required) language of the text to be synthesized
```

`text_lang` 的**右引号丢了**（成了 `"text_lang: ""`）。任何「引号必须配平」的
正则都抓不到它 ⇒ 原型只摘到 24 个，**漏掉 `text_lang`**。
这是一个**真实、可复现**的提取漏洞，不是脚本 bug：源文本本身不合法。
（按「读源码的人」算，上游实际写了 25 条说明；按「结构化提取」算，24 条。）

**⭐ 与平台今天的口径对比（顺带发现的对不齐）**：
- `engines/gpt-sovits/manifest.json` 的 `param_keys` 有 **34** 个；
- 上游 docstring 记了 **25** 个 dict key；
- 两者交集只有 **19** 个。
- 名片有、上游没记的 **15** 个：`auto_base_lang, concat, engine_batch, format, gpt_model,
  if_sr, lang_overrides, max_chars, media_type, pron_overrides, reference_text, silence_ms,
  sovits_model, split, voice_label`（其中 `gpt_model/sovits_model/format/max_chars/…` 是
  **平台自己的概念**，不在引擎 dict 里）。
- 上游记了、名片没列的 **6** 个：`fixed_length_chunk, prompt_text, ref_audio_path,
  return_fragment, seed, text`（多为「宿主 bind 槽位」或平台未暴露项）。
- ⇒ 「自动提取」若直接对着引擎 docstring 建参数表，会**和名片现有的 34 项对不齐**，
  必须有人工对齐这一步。

---

## 3. 覆盖率汇总

### 3.1 数字（真实跑出）

```
index-tts    15/25 =  60.0%   来源 {'docstring': 9, 'argparse': 6}
cosyvoice2    1/13 =   7.7%   来源 {'argparse': 1}
gpt-sovits    1/ 2 =  50.0%   来源 {'docstring': 1}   +dict 24/24
```

### 3.2 三源产出统计

| 源 | 产出（有说明的参数条数） | 备注 |
|---|---|---|
| docstring | index 9 + sovits 1(+24 dict) = **34** | 三源里最值钱的一个 |
| argparse | index 6 + cosy 1 = **7** | 依赖 CLI 有没有写 `help=` |
| Literal | **0** | 三台引擎的相关参数上**一个 Literal 都没有** |

### 3.3 别名表（唯一需要人写的东西）

`--voice → spk_audio_prompt`、`--emotion-weight → emo_alpha`、
`--emotion-audio → emo_audio_prompt`、`--emotion-text → emo_text`、
`--emotion-vector → emo_vector`、`--output → output_path`、`--config → cfg_path`。
（index-tts 的调用期 6 条说明**全部**靠这张表才拿到。）

**⚠ 反例（证明「自动映射」会错）**：index-tts 的 `cli_v2.py --fp16` 是给
`infer_v2` 的 `use_fp16` 用的，而 `infer_v2_5` 把它**改名成了 `use_bf16`**。
名字上 `--fp16` 看着像能映到 `use_bf16`，但**语义未必等价**（一个是 fp16、
一个是 bf16）。原型按纪律**只映到字面同名的 `use_fp16`**，于是 `use_bf16`
落在「未映射」。⇒ 这类映射必须人确认，机器猜会**静默出错**。

---

## 4. 哪些参数拿不到说明，为什么（分类）

把「拿不到」的 22 条（index 10 + cosy 12）按原因分类：

### A 类：上游压根没写（占绝大多数）
- **cosyvoice2 的 12 条全部属于此类**：类和方法**都没有 docstring**，
  CLI 也基本没写 `help=`。不是提取方法不行，是**源里就没有这段文字**。
- index-tts 的 `lang`、`use_emo_text`、`use_random`、`interval_silence`、
  `max_text_tokens_per_segment`、`stream_return`、`more_segment_before`、
  `duration_factor`、`text_normalization`：`infer()` 方法**没有 docstring**
  （实测 `ast.get_docstring(infer)` = `NO`，`infer_generator` 也是 `NO`），
  这些参数既不在 `__init__` 的 docstring 里，也没有对应的 CLI 开关。
  （注：`lang` 在 `infer_v2_5.py` 的 `__main__` argparse 里有 `--lang`，
  但**没有任何 help**；CLI 层 `cli.py`/`cli_v2.py` 里根本没有 `--lang` 开关。）

### B 类：写在别处（源码里没有，但在文档 / 示例里）
- index-tts 的 `emo_alpha`、`use_emo_text`、`use_random` 等在
  `engines/index-tts/docs/cli_v2_usage.md` 有中文表格，在 `docs/README_*.md`
  的示例代码里也有用法 —— 但那是 **Markdown 散文**，不是结构化字段，
  自动提取要额外做「文档解析 + 参数名对齐」，且**不通用**（每台引擎的文档结构都不同）。
- ⛔ 结论：这类**不该算进「自动提取」**。要么人工搬运，要么放弃。

### C 类：提取方法做不到
- **gpt-sovits 的 `text_lang`**：上游写了，但那行引号写坏了
  （`"text_lang: ""`），结构化正则抓不到 ⇒ **上游 typo 造成的漏检**。
  修法是「放宽引号匹配」或「对不上的行报警给人看」，但放宽又会引入误报。
- **`**kwargs` / `**generation_kwargs`**（index-tts 的 `generation_kwargs`）：
  变长参数，签名里没有它自己，平台本来就跳过 —— 不算真「缺」。
- **`Literal` 选项零产出**：不是方法错，是**三台引擎都没用 `Literal` 注解**，
  所以「顺手带 choices」这条对这三台**没活干**（gpt-sovits 的 `text_split_method`
  取值 `cut0..cut5` 只写在**平台名片** `manifest.json` 的 `params.schema` 里，
  不在引擎源码里）。

### D 类：dict 参数（签名看不到）
- gpt-sovits 的 24 个真参数**不在签名里**，`reflect_params.py` 只反射到 2 个。
  它们能拿到说明，**完全靠 `run()` 的 docstring 恰好把整个 dict 注释了一遍**。
  ⇒ 这是一个「上游碰巧写全了」的**运气**，不是可依赖的规律：
  换个引擎，dict 参数可能既不在签名、也不在 docstring（那就彻底拿不到）。

---

## 5. ⭐ 关键结论：做进平台的可行性

### 5.1 可行性判断：**能做，但只能做「辅助 + 半自动」，不能做「全自动」**

**理由（全部有实测支撑）**：
1. **能拿到的那部分，质量很高**：gpt-sovits 的 24 条 dict 说明、index-tts 的
   9 条 `__init__` 说明，都是可直接展示的人话，覆盖了「加载期开关」和
   「采样/切分类旋钮」这两个最需要解释的类别。
2. **但覆盖率不可控**：同样是三台引擎，7.7% / 60% / 100%（dict 层）。
   差异的**唯一来源是上游怎么写注释**，平台无法改变。
3. **参数集合本身就已经对不齐**：gpt-sovits 名片 34 项 vs 上游 docstring 25 项，
   交集只有 19 —— 「自动提取」不能替代人工建表，只能给人**提供草稿**。

### 5.2 主要障碍（按严重程度）

| # | 障碍 | 实测证据 | 后果 |
|---|---|---|---|
| 1 | **说明文本不在标准位置** | 同一台引擎里，说明散在 类 docstring / 方法 docstring / CLI help / dict 注释 四处；index 的加载期在 `__init__`、调用期在 CLI；sovits 的在 `run()` 的 dict 注释 | 平台**不知道去哪读** ⇒ 每接一台引擎都要人**指路**（本次原型就是靠一张手写的 `PROFILES` 表才跑起来） |
| 2 | **上游普遍不写** | cosyvoice2 类/方法**零 docstring**，CLI 11 条里只有 2 条有 help | 覆盖率的**天花板由上游决定**，平台再努力也提不上去 |
| 3 | **名字对不上 / 语义会错** | `--voice ↔ spk_audio_prompt` 要别名表；`--fp16 ↔ use_bf16` 近义非等价 | 必须维护**人写的别名表**，且机器自动映射会**静默出错** |
| 4 | **选项枚举不在源码里** | 三台引擎 `Literal` 零命中；`text_split_method` 的 `cut0..cut5` 只在平台名片里 | 「顺手带 choices」对这批引擎无产出，选项仍要人工补 |
| 5 | **上游文本本身可能有 bug** | gpt-sovits `"text_lang: ""` 引号不配平，结构化提取漏掉 1/25 | 结构化提取**必然漏检**，且漏检**不报错**（表现为「界面少了一个说明」） |
| 6 | **dict 参数是运气** | sovits 24 个 dict 参数靠 docstring 恰好写全 | 换个引擎可能「签名看不到 + docstring 也没写」⇒ 彻底拿不到 |

### 5.3 建议的落地形态

1. **定位为「草稿生成器」，不是「真相来源」**：跟 `reflect_params.py` 同一个位置 ——
   平台用它生成一份 `parameters[]` **草稿**（含 `doc` + `source_detail` 出处），
   由名片作者**核对/补全**后落盘。⛔ 不要直接信任。
2. **每条说明必须带出处**（原型已实现 `source_detail`）：
   `文件 :: 类.方法 docstring` 或 `文件 :: --开关名`。没有出处的说明，跟拍脑袋写的
   没区别，出错了无从核对。
3. **别名表是必须的人工输入**，且要跟 `manifest` 一起版本化。
   把它做成名片里的一段声明（`param_aliases: {"--voice": "spk_audio_prompt"}`），
   而不是藏在脚本里。
4. **「读不到」要显式区分原因**（上游没写 / 写在别处 / 提取不到），
   照 `reflect_params.py` 的 `ok:false` 纪律，让界面能显示
   「此参数上游未提供说明」，而不是留一个空白格让人以为忘了填。
5. **别碰 Markdown 文档**：那是每台引擎一套的散文，自动解析不通用，
   投入产出比极低（§4 B 类）。

### 5.4 一句话
> 自动提取能**显著减轻**接入时「逐参数写解释」的工作量（gpt-sovits 的 24 条
> 直接白捡），但它**不能替代人工** —— 覆盖率由上游决定（7.7%~100%），
> 而且每接一台新引擎都要人先告诉它「说明写在哪」。
> 正确的做法是「**自动出草稿 + 人工核对 + 每条带出处**」，不是「全自动」。

---

## 6. 交付物与复现

| 文件 | 说明 |
|---|---|
| `tools/dev/probe_param_docs.py` | 原型脚本（纯 stdlib + AST，三个源） |
| `tools/dev/PARAM_DOCS_PROBE_RESULT.json` | 完整结果（逐参数 + 出处 + 覆盖率） |
| `tools/dev/PARAM_DOCS_PROBE_OUTPUT.txt` | 终端输出原文 |
| `tools/dev/PARAM_DOCS_PROBE_REPORT.md` | 本报告 |

**复现命令**（项目根，git-bash）：
```bash
python tools/dev/probe_param_docs.py                # 跑全部三台，打印明细
python tools/dev/probe_param_docs.py --engine index-tts
python tools/dev/probe_param_docs.py --json out.json
```

**约束遵守**：⛔ 未改 `lib/` 下任何文件（`reflect_params.py` 原样调用）；
⛔ 未改任何测试；✅ 新文件全部在 `tools/dev/`。
