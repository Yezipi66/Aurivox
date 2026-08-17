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
| 包名改为 `gsv_code` | 文件头部 import 段 | 上游的 `GPT_SoVITS.*` 在本项目里是 `gsv_code.*`（见 `vendor/tts/gpt-sovits/gsv_code/`） |
| import 顺序保护 | 文件头部注释 | 与 `lib/inference/infer_server.py` 中的 librosa/torch 顺序约束配套，详见该文件注释 |
| 失败诊断提示 | 异常分支中的长字符串 | 例如 fp16 数值不稳定时提示改 `tts_infer.yaml` 的 `is_half`，替代上游的裸异常 |

### `TTS_infer_pack/TextPreprocessor.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| 接入个人读音词典 | `from gsv_code.text import pron_correction` | 三处。词典本体在 `data/pron_lexicon/`，由前端「读音校对」写入 |
| 逐位置读音覆盖 | `lang_overrides` / `position_offset` / `set_segment_base` | 上游没有「按字符位置覆盖读音」的概念，整套参数是本项目新增 |
| Auto Han 语言路由 | `_resolve_auto_segment_language` / `_norm_base_lang` | 中日粤共用汉字时的判定，含保守加权的粤语识别 |

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
