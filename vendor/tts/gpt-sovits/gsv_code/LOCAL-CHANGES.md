# 本目录相对上游的改动

本目录是 GPT-SoVITS 模型与文本前端代码的**移植副本**，不是原封不动的上游快照。
升级上游前请先读完本文，逐条判断每处改动是否需要重新施加。

`vendor/` 的含义是「上游在别处，我们的改动是打在它上面的补丁」，
不是「一个字都没改」。改动集中在下列文件，其余文件保持上游原样。

姊妹文件：`vendor/tts/gpt-sovits/infer/LOCAL-CHANGES.md`（推理运行时那一半）。

---

## 零、全目录范围的改名

上游的顶层包名是 `GPT_SoVITS`，本项目里是 `gsv_code`；上游 `text` 子包在
本项目里是 `gsv_code.text`。所有 import 语句相应改写。

⚠ **升级时最容易踩的坑**：上游 g2pw 的部分模块内部写的是绝对导入
`import text.xxx`，即把 `text` 当顶层包名。改名之后，仅把
`vendor/tts/gpt-sovits` 和 `.../infer` 加进 `sys.path` 是不够的，**还必须把
`gsv_code` 目录本身也加进去**，否则 `No module named 'text'`。而
`text/chinese2.py` 里那处 import 外面套着 try/except，会把这个错误吞掉并
**静默退回 pypinyin** —— 表现为「能出声、多音字全错」，不报任何错。

---

## 一、被修改的文件

### `text/pron_correction.py`

**整个文件都是本项目新增的**，上游没有对应物。个人读音校对层：按词、按出现
次序（`occ`）、按绝对字符位置（`position`）三种粒度覆盖读音，中/粤/日/英通用。
词典本体在 `data/pron_lexicon/{lang}.json`，属用户运行时资产，不入 git，
由前端「读音校对」界面写入。

对上游的约束：`zh`/`yue` 的覆盖**只在长度与原拼音一致时才生效**（否则
`word2ph` 与音素数量会对不上）；`ja`/`en` 读音单元非逐字，不做长度约束。

### `text/chinese2.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| CUDA DLL 目录注册 | `_register_torch_cuda_dlls()`，紧接其后的调用 | Windows 上 onnxruntime-gpu 找不到 torch 自带的 CUDA DLL，会**静默退回 CPU**（error 126）。必须在 `if is_g2pw:` **之前**执行。与 `vendor/uvr5/mdxnet.py` 中的同名函数是**同一段代码的两份副本**——两棵树分进程运行、无法互相 import，靠 `lib/training/g2pw_ort.node.test.js` 断言两份逐字节相同来防漂移。**改一处必须改另一处。** |
| 接入读音校对 | `from gsv_code.text import pron_correction as _pron`，`_pron.apply(...)` 三处 | 见上 |
| **g2pW 输入标点还原** | `to_g2pw_input()` / `from_g2pw_result()`，调用点在 `_g2p()` 与 `get_word_pinyins()` | r12b-fix7。`replace_punctuation()` 把「。，！？」压成半角送进 g2pW，而 g2pW 的预训练语料是全角中文，半角句点不构成句末信号，句末多音字判错：`g2pW('了一半。')→le5` 正确、`g2pW('了一半.')→liao3` 错误。修法是**只在送模型的那一份上还原全角**，拿回结果立刻换回半角。⛔ 两条硬约束：①映射必须逐字符 1:1、**长度不变**（下游 `pinyins[pre_word_length:now_word_length]` 按字符下标切）；②**必须换回半角**，否则 `chinese2.py` 的 `assert c in punctuation` 当场抛 AssertionError（`punctuation` 只有半角）。⛔ **两个调用点必须同时改**：`get_word_pinyins()` 是同一条流水线的第二份实现，注释里承诺「预览读音 == 实际合成读音」，只改一处读音校对界面就会开始骗人 |
| 静默降级 | `except` 分支里的 `print` | ⚠ 已知缺陷：g2pw 加载失败时退回 pypinyin 只打印一行，没有任何可被自检读取的状态位 |

### `text/english.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| 接入读音校对 | `_pron.next_occ("en", ...)` / `_pron.resolve(..., lang="en", ...)` | 英文按**出现次序**覆盖，同一个词在一段话里的不同次出现可以给不同读音 |
| 读音候选枚举 | `_pron.current_overrides("en")` / `load_lexicon("en")` | 供前端校对界面列出可选读音 |

⚠ **不要为连字符词加通用规则。** 2026-08-17 实测十个连字符词（`e-mail` /
`co-op` / `t-shirt` / `x-ray` / `well-known` / `state-of-the-art` /
`add-on` / `built-in` / `kubectl-plugin` / `re-run`），**九个上游行为就是对的**，
只有 `re-run` 错。「去掉连字符整体查词典」会把 `co-op` 变成 `coop`
（K UW1 P，鸡窝）——一个读音完全不同的另一个词。单词级缺陷请加词典条目，
不要动算法。

### `text/japanese.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| 接入读音校对 | `_pron.overrides_view("ja")` / `current_segment_base()` | 日语按整词假名覆盖，配合 `position_base` 定位到原文中的绝对位置 |
| 读音候选枚举 | `_pron.current_overrides("ja")` / `load_lexicon("ja")` | 同上 |

### `text/cantonese.py`

接入读音校对：`pron_correction.apply(word, readings, "yue", position=...)`，两处。

### `text/cleaner.py`

| 改动 | 位置线索 | 说明 |
|---|---|---|
| `allow_short_pad` 关键字参数 | `def clean_text(text, language, version=None, allow_short_pad=True)` | 上游对不足 4 个音素的短句无条件在前面补一个逗号（停顿）。中英混排时每个英文短词都是一个独立片段，于是句子中间被塞满停顿 |

⛔ **默认值 `True` 不能改**，改动只允许发生在调用点。训练集预处理
（`prepare_datasets/1-get-text.py`）走的是同一个函数，默认值一改，训练时与
推理时的音素序列就不一致，**已训练的音色全部作废**。

---

## 二、已知未修的上游行为（不是我们改坏的，登记备查）

* ~~g2pW 拿到**半角句点**时会把「了」判成 `liao3`~~ → ✅ 已在 r12b-fix7 修复，
  见上表「g2pW 输入标点还原」。上游行为本身没变，我们绕开了它。
* `_g2p()` 的 pypinyin 分支在覆盖长度不匹配时静默丢弃，只打印，不上报。
* `_g2p()` 的 pypinyin 回退分支**没有**经过 `to_g2pw_input()`——那条路走的是
  pypinyin 词典而不是模型，不受标点形态影响，所以不需要，也不该加。


---

## 三、r12c-fix01：`pron_correction.py` 的项目根定位（2026-08-19）

`_find_project_root()` 的兜底分支原为 `dirname×3`，自 `gsv_code/text` 只上溯到
`vendor/tts` —— 既不是项目根，也不报错，词典会整体失效而无任何提示；
`for _ in range(8)` 的层数上限在部署路径较深时还会提前放弃。

改为与同目录 `chinese2.py` 的 `_find_project_root()` 同构：一路上溯到文件系统根
寻找 `server.js`，找不到则退回 `start` 自身，让调用方拿到不存在的路径并显式报错。

依据：引擎契约 C7「定位项目根绝不数目录层数」。
