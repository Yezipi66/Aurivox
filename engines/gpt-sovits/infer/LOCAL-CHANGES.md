# 本目录相对上游的改动

本目录是 GPT-SoVITS 推理运行时的**移植副本**，不是原封不动的上游快照。
升级上游前请先读完本文，逐条判断每处改动是否需要重新施加。

`vendor/` 的含义是「上游在别处，我们的改动是打在它上面的补丁」，
不是「一个字都没改」。改动集中在下列文件，其余文件保持上游原样。

---

## 一、被修改的文件

### `TTS.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| 参考音频缓存 | `_ref_cache_cap` | 缓存已编码的参考音频，避免同一音色连续合成时重复编码。上限由环境变量 `AURIVOX_REF_CACHE` 控制，默认 8，设为 0 关闭 |
| 包名改为 `gsv_code` | 文件头部 import 段 | 上游的 `GPT_SoVITS.*` 在本项目里是 `gsv_code.*`（见 `engines/gpt-sovits/gsv_code/`） |
| import 顺序保护 | 文件头部注释 | 与 `lib/inference/infer_server.py` 中的 librosa/torch 顺序约束配套，详见该文件注释 |
| 失败诊断提示 | 异常分支中的长字符串 | 例如 fp16 数值不稳定时提示改 `tts_infer.yaml` 的 `is_half`，替代上游的裸异常 |
| 配置写回只倒原有段 | `save_configs` / `_file_sections` | 上游把 `default_configs` 全表倒进 `tts_infer.yaml`，其中 v3/v4 写死上游布局 `GPT_SoVITS/pretrained_models/`（本项目无此目录）。每次热切模型都会把死路径写回配置，下次启动被 `start.ps1` 的 `Repair-EngineConfig` 判 stale 整份重置，用户选的模型丢失。改为只写回文件里原有的段；`default_configs` 全表保留不动（`init_vits_weights` 要用它查 LoRA 底模） |
| 配置里不写绝对路径 | `_aurivox_relativise_paths` | 项目根之下的路径写成相对路径，基准取 `os.getcwd()`（`infer_server.py:62` 已 chdir 到项目根）。绝对路径会把本机盘符钉进配置，换机器即失效 |
| 配置写回显式 utf-8 | `save_configs` 的 `open(...)` | 上游裸 `open(path, "w")` 用本地编码（中文 Windows 为 GBK），而 `_load_configs` 用 utf-8 读 |

### `TTS_infer_pack/TextPreprocessor.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| 接入个人读音词典 | `from gsv_code.text import pron_correction` | 三处。词典本体在 `data/pron_lexicon/`，由前端「读音校对」写入 |
| 逐位置读音覆盖 | `lang_overrides` / `position_offset` / `set_segment_base` | 上游没有「按字符位置覆盖读音」的概念，整套参数是本项目新增 |
| Auto Han 语言路由 | `_resolve_auto_segment_language` / `_norm_base_lang` | 中日粤共用汉字时的判定，含保守加权的粤语识别 |
| 短句补逗号只在整行时生效 | `allow_short_pad=(len(textlist) == 1)` | r12b-fix5。上游对不足 4 个音素的片段无条件在前面补一个逗号；中英混排时每个英文短词都是一个片段，句子中间会被塞满停顿。⛔ 只改这个调用点，**不要改 `gsv_code/text/cleaner.py` 里的默认值**——训练集预处理走同一个函数，默认值一改，已训练的音色全部作废 |
| `@N` 覆盖必须落在汉字上 | `_apply_lang_overrides` 里的 `not _HAN_RE.match(seg_text[i])` | r12b-fix6。覆盖是按**绝对字符下标**存的，正文一改就会落到别的字符上（典型是假名）。汉字语言覆盖落在非汉字上按定义无意义，此处直接丢弃。前端也会剪一遍，但 payload 也可能来自修复之前保存的 recipe，所以引擎侧必须自己兜底 |
| `_HAN_RE` 补 U+F900–U+FAFF | `_HAN_RE = re.compile(...)` | r12b-fix6。此前比前端 `web/src/lib/hanLanguage.js` 的 `HAN_RE` 少了「CJK 兼容汉字」一段：挑选器把这些字当汉字给用户选，引擎却当非汉字丢掉，**两边都不报错**。⛔ 两个正则必须逐字符相同，`lib/han_override_contract.node.test.js` 会断言这一点 |

### `TTS_infer_pack/text_segmentation_method.py`

切分策略的本地调整。

### `requirements.txt`

依赖版本按本项目实测可用的组合钉住。

### `sr/AP_BWE_main/24kto48k/readme.txt`

补了中文说明。

---

## 二、我们新增的文件

| 文件 | 用途 |
|---|---|
| `TTS_infer_pack/auto_language_test.py` | Auto Han 路由的回归测试。用 `ast` 只抽取两个纯函数，因此无需装 torch 即可运行 |
| `TTS_infer_pack/context_language.node.test.js` | 前端 `web/src/lib/autoLanguage.js` 与本目录判定逻辑的一致性测试，属 `npm test` 套件 |
| 本文件 | —— |

跨目录守卫（不在本目录，但约束本目录）：

| 文件 | 约束的内容 |
|---|---|
| `lib/han_override_contract.node.test.js` | `_apply_lang_overrides` 必须丢弃落在非汉字上的 `@N`；`_HAN_RE` 必须与前端 `HAN_RE` 逐字符相同 |
| `lib/training/g2pw_ort.node.test.js` | `allow_short_pad` 的默认值与调用点；`chinese2.py` 与 `pipeline/uvr5/mdxnet.py` 两份 CUDA DLL 注册代码必须逐字节相同 |

---

## 三、权重不在本目录管辖之内

`sr/AP_BWE_main/24kto48k/g_24kto48k.zip`（音频超分权重）由 `sr/audio_sr.py`
**按自身位置**查找，无环境变量兜底。若日后把权重集中到顶层 `models/`，
必须同时改 `sr/audio_sr.py`，否则超分功能会在运行期报 `FileNotFoundError`。
`lib/paths.js` 的 `LEGACY_LOCATIONS.superRes` 已登记此事。

其余底模、ASR、UVR5 权重不在本目录，见 `vendor/gsv-tools/`。

---

## 四、本文并非逐字节完备

上表按「本项目特有的标识」（`AURIVOX_*`、`gsv_code`、`pron_correction`、
中文注释）梳理而成，覆盖了全部有实质功能的改动，但不保证连每一处空白与
措辞调整都记录在案。升级上游时的权威做法仍是**与上游对应版本做一次完整
diff**，本文用于快速判断「哪些差异是有意为之，不能丢」。
