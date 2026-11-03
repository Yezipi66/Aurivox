# 多语混说的路由：为什么能混、边界在哪

> **2026-11-03 写。** 页内所有行号按那天的代码核对过一遍；改动第 6 节列出的任何一处时，这页要跟着改。

这一页的存在理由：这套判据此前只在 `TextPreprocessor.py` 的 docstring 和两个测试文件里，`docs/` 没有任何一页面向人地讲「混说为什么成立」。`docs/CHANGELOG.md` 只记过两条实现细节（`:154` 的基底语言强制归一）。所有结论标 `[读码]`（对着代码读出来的）或 `[实测]`（跑出来/跑红过的）。

引用写法：这一页每条都先给**符号名**（函数、常量或分支条件），行号只作为入口附在后面，因为它的用途是让人逐条对着代码复核。`docs/COMMENT_GUIDELINE.md` 第③条「不引用行号」管的是**代码注释**（那份文件的适用范围写在开头：读者手里只有代码），本目录的决策文档按现状仍带行号；行号会随改动漂，所以页头标核对日期，改 §6 那张表里的任何一处时这页要跟着改。

术语：**语种** = 一次请求要求的朗读语言写法；**基底语言**（`auto_base_lang`）= 歧义汉字片段默认按哪门语言读；**片段** = 引擎按脚本切出来的最小同质单位；**混说** = 一次请求里正文跨多种语言。

---

## 1. 原理：混说不是模型懂多语，是文本先被切开

[读码] 四步，全部发生在模型之前：

| 步 | 做什么 | 位置 |
|---|---|---|
| 1 切片 | 按脚本把正文切成语言同质的片段（拉丁→`en`、谚文→`ko`、假名→`ja`、汉字→歧义） | `engines/gpt-sovits/infer/TTS_infer_pack/TextPreprocessor.py` 的 `segment_lossless`（`:254`），底层是 `gsv_code/text/LangSegmenter` |
| 2 分片各自 g2p | 每个片段按**它自己的语言**走各自的音素化与 BERT 特征：`chinese.py` / `chinese2.py`（G2PW）、`cantonese.py`、`japanese.py`、`english.py`、`korean.py` | `TextPreprocessor.py:539-549`（`clean_text_inf` + `get_bert_inf` 逐片段调用） |
| 3 拼成一条 | `phones = sum(phones_list, [])`、`bert = torch.cat(bert_list, dim=1)` —— 语言差异只存在于音素与特征里，交给模型时就是一条序列 | `TextPreprocessor.py:553-555` |
| 4 一次推理 | 参考音频的音素垫在正文音素前面，t2s(GPT) 自回归生成，s2s(SoVITS) 出声学 | `engines/gpt-sovits/infer/TTS.py:1082`：`prompt_data["phones"] + item["phones"]` |

**音色来自参考音频，不来自语种** [读码]：第 4 步那条序列里唯一决定音色的是参考音频片段，所以第 3 步换语言不会换音色。这是混说「同一个人念中日英」的根据，也是为什么语种参数从来不参与选权重。

## 2. 歧义只在汉字，所以必须有基底语言

[读码] `zh` / `ja` / `yue` 共用大量汉字码点，脚本本身给不出答案。`auto` 与 `auto_zh_ja*` 的差别就在这一点上：

| 语种写法 | 引擎分支（都在 `get_phones_and_bert` 的分支表里） | 行为 |
|---|---|---|
| `auto` | `TextPreprocessor.py:489` 的 `language == "auto"` | 全盘接受检测器的判定，歧义 CJK 走检测器自己的默认 |
| `auto_yue` | `:493` 的 `language == "auto_yue"` | 检测器判 `zh` 的片段一律改判 `yue` |
| `auto_zh_ja` / `auto_zh_ja_yue` | `:499-506` | 走 `resolve_auto_multilingual(text, auto_base_lang)`，替检测器把歧义 CJK 收口 |
| `all_zh` / `all_ja` / `all_yue` / `all_ko` 与裸码 | `:460` 起、末尾 `else` 分支 `:507-517` | 不检测歧义位：`「因无法区别中日韩文汉字,以用户输入为准」`（`:516` 的注释） |

[读码] `resolve_auto_multilingual` 的规则，按 docstring `:279-289` 的顺序：

1. **先切小句**（`_split_clauses` `:200`，句末标点、逗号、成对引号处断开）。作用是把每个信号限制在短跨度里 —— 整篇判一次会把一篇里两种写法都判错。
2. **每小句定一个默认读法** `cjk_default`（`:293`）：含假名 → `ja`；粤语加权分 > 1.5 → `yue`；否则 → **这台音色的基底语言**。
3. **片段级只保留无歧义脚本**（`_resolve_auto_segment_language` `:67-78`）：检测器标 `zh` 或 `x` 的送进 `cjk_default`；标 `ja` 但片段里没有假名的也送回去（假名才是日语的强信号）；`en` / `ko` 保留检测值。

[读码] 粤语是加权而非「见一个词就判」：`_yue_score` 里强标记（`_YUE_STRONG_RE`：喺嘅佢哋咩冇唔啲嚟咗噉俾畀）每个 +2，弱标记（`_YUE_WEAK_RE`：嘢啱係既咁啦喇咪嘥攞揾餸攰瞓）每个 +1，**每个通用汉字 −0.05**（`_YUE_GENERAL_HAN_PENALTY`），阈值 1.5（`_YUE_THRESHOLD`，判据在 `_is_yue_clause`）。繁体字单独出现不算粤语证据：`_has_strong_yue_marker` 的注释写明是刻意的保守。

## 3. 基底语言为什么必须由平台算

[读码] 引擎不知道这个音色登记的是什么语言，平台知道。所以这一族多语请求要带一个 `auto_base_lang`：

- `/v1/audio/speech`：`lib/routes/synthesis.js:352-356` —— 只在多语写法时带，值取请求的 `auto_base_lang`，没有就用资产登记语言。
- `/api/generate`（界面与 Flow 走的那条）：`lib/services/synthesisService.js:136-137` —— 同一份判据，同一个 `resolveBaseLang`。
- 解析器：`lib/langCodes.js:21-24`，白名单是 `BASE_LANGUAGES`（`:18`，= 平台语种码里去掉 `auto*`），认不出来就 `zh`。
- 引擎侧再收一次口：`_norm_base_lang`（`TextPreprocessor.py:56-60`）剥掉 `all_` / `auto_` 前缀，白名单 `_ML_BASE_LANGS`（`:53`），不在就 `zh`。

**两份白名单目前是集合相等的**（`{zh, yue, ja, en, ko}`）[实测：`lib/langCodes.node.test.js` 里「基底语言：词表里的具体语种，多语写法不在内」那条用例钉住平台那份，`engines/gpt-sovits/infer/TTS_infer_pack/auto_language_test.py` 钉住引擎那份]。**但没有任何一处断言两边相等** —— 而同一个文件里的 `_HAN_RE` 有跨目录守卫（`lib/han_override_contract.node.test.js`），因为那里不一致是静默漏洞。这里的后果同型：谁改了单边白名单，另一边的 `zh` 兜底会静默接管，请求不报错、读出来的音变了。

## 4. 边界：能混到多细

- **[读码] 路由是片段级，不是字符级**：一个片段整体只能按一种语言音素化。要在中文句里把「大丈夫」读成日语，走的是**逐位强制**：`lang_overrides` 按绝对字符下标指定（`_apply_lang_overrides` `:135-197`），且只对 `_HAN_RE` 匹配的汉字位有效，落在非汉字上直接丢弃（`:186`）。
- **[读码] 两侧汉字定义必须逐字符相同**：前端挑选器（`web/src/lib/hanLanguage.js` 的 `HAN_RE`）与引擎侧 `_HAN_RE`（`TextPreprocessor.py:95`）不一致时，用户会选到一个引擎默默不理的位置，两边都不报错。这条已有守卫。
- **[读码] 分段器会丢字符**（逗号、小句首空格实测丢过），`segment_lossless`（`:254-264`）做「拼回来必须等于原文」的对账并记状态位；补回的片段并入左邻，不重新判语言。不对账的话，屏幕上的正文和念出来的正文就是两个字符串。
- **[读码] 读音层面另有两份**：个人读音词典与逐次覆盖（`pron_overrides`，按第 N 次出现选读法；`TextPreprocessor.py:432-456` 带出现计数快照，防止重试时错位）。

## 5. 三处已知不齐（本页写下来时才确认的）

1. **[读码] 多语请求的预览读音恒按 `zh` 打底，与实际合成读音可以不一致。**
   `lib/inference/infer_server.py:297` 的 `_normalize_pron_lang` 做的是字符串剥离：`auto_zh_ja_yue` 经 `.replace("auto_","")` 变成 `zh_ja_yue`，没有白名单兜底；`engines/gpt-sovits/gsv_code/text/pron_correction.py:631` 再 `base = lang if lang in ("zh","yue","ja") else "zh"`，于是基底语言就是 `zh`。
   而第 3 节的合成路径用的是音色登记的基底语言。**音色基底语言不是 `zh`、正文里有歧义汉字片段时，预览给的是普通话读法，合成给的是另一门语言的读法。**
   这与两处文档相反：`pron_correction.py:616` 的 docstring 写着「保证『预览读音 == 实际合成读音』」，`engines/gpt-sovits/manifest.json:195-196` 也这么声明。修哪一侧（预览按 `auto_base_lang` 打底，还是把声明改成「单语种请求下相等」）没定，已登记在 `issue #26` 的待做清单。
2. **[读码] 引擎有 `auto_yue` 分支，平台语种码里没有它**（`PLATFORM_LANGUAGES` 见 `lib/langCodes.js:6`）。想「自动识别但歧义汉字默认粤语」目前只能靠 `all_yue`（不检测）达成，两种写法的差别暴露不出去。要不要收进平台词表也是产品决定。
3. **[实测] 两个入口过名片 `languages` 表的范围不一样**，多语码只在 `/v1` 那侧被换算。`lib/routes/synthesis.js:284` 对请求值用 `mapLanguage`（查表），`lib/services/synthesisService.js:106` 用 `legacyLangToEngine`（只有值是 `LEGACY_LANG_ALIAS` 那四个历史写法时才查表，其余原值发出）。实测：同一份 `{auto_zh_ja: 'mix_all'}` 的表，`legacyLangToEngine` 返回 `auto_zh_ja`，`mapLanguage` 返回 `mix_all`。今天不出问题，因为 GSV 把这两个码换成 `auto_zh_ja_yue`，与平台码逐字相同；**一致来自写法同名，不是来自声明**。`lib/han_override_contract.node.test.js` 那种守卫也没有：没有一条用例把多语码映射成第三种写法。登记与两个修法在 `issue #26` §13。

## 6. 改这一族要同时过的地方

动语种词表或基底语言判据时，这几处是一套，不是各自独立 [读码]：

| 层 | 文件 |
|---|---|
| 平台词表与归一 | `lib/langCodes.js`（`PLATFORM_LANGUAGES` / `LEGACY_LANG_ALIAS` / `BASE_LANGUAGES` / `resolveBaseLang`） |
| 平台→引擎写法 | 名片的 `languages` 表：`engines/gpt-sovits/manifest.json:135-144`；解析与换算在 `lib/engines/profile/languages.js` |
| 两个入口的基底语言 | `lib/routes/synthesis.js:352-356`、`lib/services/synthesisService.js:136-137` |
| 引擎侧路由 | `TextPreprocessor.py`：`_norm_base_lang` / `_resolve_auto_segment_language` / `resolve_auto_multilingual` / `get_phones_and_bert` 的分支表 |
| 契约文档 | `docs/ENGINE_ONBOARDING_CONTRACT.md` 的「语种取值由 `languages` 决定」一节 |
| 测试 | `lib/langCodes.node.test.js`、`lib/routes/synthesis.enginePayload.node.test.js`、`lib/services/synthesisService.nails.node.test.js`、`engines/gpt-sovits/infer/TTS_infer_pack/auto_language_test.py` |

「混说」这个词在界面上不出现：界面说的是「多语（中日粤）自动识别」。两者指同一件事，以本页为准。
