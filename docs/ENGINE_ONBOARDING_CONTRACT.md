# 引擎接入契约（v3 草案）

> **状态：草案。** 这份文件是 2026-09-04 重写的，替代已删除的
> `ENGINE_CONTRACT.md`（3080 行，随「契约退休」在 `c3f0ae8` 删除）。
>
> ⛔ **它不是规范，是「已实现行为的说明书」。** 每一条都标了证据来源：
> `[实测]` = 在开发机上跑出来的；`[读码]` = 从代码读的，**未实机验证**。
> 这不是谦虚 —— 本项目最贵的 bug 全部是「以为跑过了」和「真的跑过」的差。
>
> **要动手接引擎，看 [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md)**
> （那是操作手册）。本文件回答「为什么是这样」。

---

## §0 一句话

**`engines/<id>/manifest.json` 是唯一权威。平台只验不建。**

加一个引擎 = 一个目录 + 一张名片。`lib/` / `server.js` / `web/` **一个字不改**。

### 这个承诺今天兑现了吗

| 部分 | 状态 | 证据 |
|---|---|---|
| **推理链** | ✅ 兑现 | [实测] `fakeEngine.node.test.js` 用一台参数叫 `wobble`/`flavour`/`goose_count` 的假引擎走完整条链路；`synthesisService.params.node.test.js` 与 `adapter.generate.node.test.js` 用参数名与 GSV 无关的假引擎分别走 `/api/generate` 与 Flow 引擎节点 |
| **训练链** | ⛔ **没兑现** | [实测] `lib/training/pipelineIdentity.js:62` 写死 `TRAINING_ENGINE_ID='gpt-sovits'`，位名 `gpt`/`sovits` 是 GSV 方言 |

⚠️ 报「兼容全部 TTS」时这句话必须一起说：**推理侧是真的，训练侧不是。**

---

## §1 平台的立场：只验不建

Owner 2026-08-24 拍板：「我只维护 GPT-SoVITS 兼容这一套，其他一概不负责」。

所以 `lib/engines/envCheck.js` 里**没有一行装包/建 venv 的代码**，将来也不该有。
它只回答一个问题：名片说的那个解释器/脚本/模块/类/方法，**在不在**。

不在 = 这台引擎没装。**平台不代劳，也不背书。**

同理 `lib/engines/checkpoints.js` 只回答「在哪 / 在不在 / 缺哪几个」，
缺的时候**把名片自己写的那条取回命令填好占位符原样打印出来**，自己不下载。

理由不是懒：下模型要联网、要几个 GB、有的还要先去网站点同意，
把它塞进「装源码」这一步，失败之后没人说得清是哪一半没成。

---

## §2 平台词表（加引擎不加词）

`lib/engines/payload.js` 固定这 10 个词。**加引擎只是给它们换一个说法。**

```
必发（哪怕值是空字符串）  text / text_lang / reference_audio / reference_text / reference_lang
空值不发                aux_reference_audio / speed / seed / media_type / streaming
```

⚠️ CORE / OPTIONAL 的区别是**空值含义不同**，不是风格。搬家前
`buildTtsPayload` 的头五行就是无条件写死这五个键的，其中 `prompt_text`
在没有参考文本时就是 `""` 而且确实发了出去。照 OPTIONAL 的规矩丢掉它，
请求体会少一个键 —— **那是改行为**。

翻译靠名片的 `maps`。**没映射的词 = 这台引擎没这个概念，不发。**
不发不等于丢弃：把 `text_lang` 发给一台没有语言概念的引擎，
好一点的当场 400，差一点的静默忽略 —— 后者正是要消灭的那类失败。

### 语种的取值靠 `languages`（键是平台码，值是引擎原话）

`maps` 管**键名**，`languages` 管 `text_lang` / `reference_lang` 这两个位置上的**取值**。
平台的词只有这些：`zh / yue / ja / en / ko / auto / auto_zh_ja / auto_zh_ja_yue`
（`lib/langCodes.js` 的 `PLATFORM_LANGUAGES`，拼错一个键当场装不上）。

```json
"languages": { "zh": "all_zh", "ja": "all_ja", "auto": "auto" }
```

- **不写这张表 = 空表**：平台发给这台引擎的语种就是平台码本身。只认 `zh` / `en` 的引擎不用写。
- 表里没有的语种**原样发**，平台不猜、不补前缀。
- 历史写法 `all_zh / all_yue / all_ja / all_ko` 由平台在读取时归一成平台码（`LEGACY_LANG_ALIAS`），
  双读期老配方、老客户端照旧能到引擎；这张归一表只有平台那一份，名片里不要再写一遍。

---

## §3 一份声明，全部派生

`lib/engines/parameterDeclaration.js`。名片只写 `parameters[]`，
平台派生出五份视图：

```
parameters[]  ──▶  param_keys          全部参数名
                ├▶  payload_keys       调用期白名单（phase=call 的）
                ├▶  params.load_time   加载期白名单（phase=load 的）
                ├▶  params.call_time   调用期白名单
                └▶  params.schema      界面那份格子定义
```

⛔ 新旧字段并存**当场报错**（`ENGINE_MANIFEST_INVALID_VALUE`）——
两份会漂移的事实，本项目已经为此付过学费。

**同一个名字不能既是加载期又是调用期** —— 那两道 400 会互相打架，
而且没人说得清改了它到底要不要重启。

### `input.text` 这条路今天走不通 ⬜ [实测]

`deriveTextBinding()` 实现了「用 `input.text.parameter` 代替 `maps.text`」，
但它的实现是 `{ ...manifest, maps: { text: parameter } }` ——
**`maps` 被整体替换成只有 `text` 一个键**。

⇒ 它只能表达「这台引擎只有一个输入概念」。
⇒ GSV 有 10 个映射、IndexTTS2 有 4 个，**两台真引擎都无法用 `input` 表达**。

⚠️ 要么扩 `input` 语法（让其余词有地方放），要么承认它是个死胡同。
**今天两台都还在用旧 `maps`，这是有原因的，不是遗漏。**

### 参数草稿生成器（A1）[实测]

`tools/scaffold-params.cjs` + `lib/engines/reflect_params.py`。

在**引擎自己的解释器**里反射 `__init__` 和目标方法的签名，生成
`parameters[]` 草稿。⭐ 与 `envCheck.js` 同一个纪律：跑在引擎的 venv 里，
因为平台的 Python 里没有 torch、也没有任何一台引擎的模块。

**实测质量**（拿 IndexTTS2 当标准答案——那 14 条 `parameters[]` 是人手写的）：

| 指标 | 结果 |
|---|---|
| 真参数漏掉 | **0** |
| 误排除 | **0** |
| 类型一致 | **13 / 14** |
| 唯一分歧 | `emo_audio_prompt`：真人写 `select` + `source:"audio"`，生成器给 `text` |

⚠ 那唯一一处**不是缺陷，是人工判断** —— 「这个参数该是音频选择器还是文本框」
取决于引擎怎么用它，反射不出来。

#### 三条设计线（都写在代码注释里）

1. **默认值为 `None` 时用参数名给建议，但标 `_needs_review`。**
   ⭐ 这条是被实测逼出来的：IndexTTS2 的 14 个真参数里 **4 个默认值是 None**
   （`use_cuda_kernel` / `emo_audio_prompt` / `emo_vector` / `emo_text`），
   人是按**名字的语义**定的类型。只看默认值会把这 4 个全漏掉，
   而漏掉的表现是「界面上少了一个真实存在的旋钮」，**没有任何报错**。
   但名字是**弱证据**，所以建议给出、**决定由人下**。

2. **路径类参数必须排除。** `cfg_path` / `model_dir` / `aux_paths` 做成界面格子，
   用户改了 ⇒ 加载的不是那份权重 ⇒ **声音是别人的，且不报错**。
   ⛔ 判据用**显式名单**（`EXCLUDE`）而不是「名字像不像路径」的启发式 ——
   启发式猜错不报错，而名单可以逐条审阅。
   ⚠ 这条名单被测试逼着收窄过一次：初版把 `prompt_path_ratio` 也排了，
   而它是一个正常的数值旋钮。**误排与漏排同样有害。**

3. **生成的是草稿，不是成品。** `min` / `max` / `choices` / 中英文 `label` /
   `help` / `only_when` 反射都拿不到，每条都留 `REPLACE_ME` 提醒人填。

⭐ 变异测试 5 条，全部被测试抓住（`needs_review` 标反 / 排除名单失效 /
bool 掉进 number / 名字线索不发建议 / `_already_in_manifest` 静默失效）。

#### ⚠ 未实现但已实测的相邻路线：`--help` 解析 [实测 · Owner 指示暂缓]

Owner 2026-09-29 提出「解析上游 `--help` 自动填字段」。**实测两台真引擎，
结论是「互补，不是替代」**：

| | 反射 | `--help` |
|---|---|---|
| 默认值 / 必填 / Python 参数名 | ✅ | ❌ |
| **参数说明文本** | ❌ | ✅ |
| **维度**（IndexTTS2: "8-dimensional emotion vector"） | ❌ | ✅ |
| **语义别名**（`--emotion-weight` → `emo_alpha`） | ❌ | ✅ |
| **互斥组**（`--fp16\|--no-fp16` ⇒ `boolean_optional` 的证据） | ❌ | ✅ |
| **覆盖 GSV** | ✅ | ❌ **完全失效** |

**GSV 的 `infer_server.py --help` 只有 3 个服务启动参数，推理参数一个都没有**
——它们走 HTTP request body，不在 argparse 里。

⇒ 两条硬结论（将来做的时候别再测一遍）：
1. **`--help` 方案必须能回落到反射**，不能只做 `--help`。
2. **反射仍必须是主路** —— 它是唯一覆盖全部引擎的那条。

⚠ **起引擎解释器时必须洗 `sys.path`**：实测起 GSV 的解释器，Hermes 注入的
numpy 覆盖了项目 venv 的，报 `ModuleNotFoundError: numpy._core._multiarray_umath`。
`reflect_params.py` 的 `_scrub_sys_path()` 拦住了这一条。

---

## §4 顶层键白名单

`lib/engines/profile/topkeys.js` 的 `TOP_KEYS`，多一个当场抛。
（个数不写在这里：加一个顶层键就得多写一处，写漏了它就变成一个说假话的数。）

判据：`{"max_char": 1}`（少个 s）必须报错。静默忽略它 = 作者调了一个
不存在的旋钮而毫无察觉。报错还带 Levenshtein 猜「是不是想写 `max_chars`」。

⚠️ **故意没有「已退休顶层键」表。** 两条规矩在这里真打架：
「退休路说老名片照装」vs「A1 归零说那个词一个字都不许再出现」。
今天按 **A1 优先**处理 —— 老名片写着退休键 ⇒ **装不上**，
但报错会指名道姓告诉你删哪一行。代价是作者不知道那个键曾经是什么意思。

---

## §5 调用契约

`call` 段回答「怎么调这台引擎」。**通用宿主 `lib/engines/host.py` 靠它反射调用，
不 import 任何改写版。**

两种形态，**键表各自一张**（写错形态的键当场报错，不静默忽略）：

| kind | 键 | 驻留 |
|---|---|---|
| `python` | `module` + `class` + `init_args` + `method` + `bind` | ✅ 进程活着模型在 |
| `cli` | `argv` + `args` + `bind` | ⛔ 每次请求一个新进程，`/health` 诚实报 `resident: false` |

`bind` 三个槽位，`text` 必填。⚠️ **两种形态里写的东西不同**：
`python` 填上游方法参数名，`cli` 填命令行开关（`--text`）。
不检查的话，cli 形态里写 `spk_audio_prompt` 会变成一个孤零零的位置参数。

### `call.seed` 三态 [实测]

```
"none"                            不可复现 —— 宿主显式拒收 seed（400）
{"arg": "<参数名>"}                引擎自己收
{"mode":"global","scope":"locked","rngs":[...]}   宿主播全局 RNG
```

⚠⚠ **这一段的闸在引擎进程启动时（`host.py` 的 `SeedPlan`），不在装引擎时。**
实测：

| 写法 | 装引擎 | 起进程 |
|---|---|---|
| `"none"` | ✅ | ✅ |
| `{"arg":"seed"}` | ✅ | ✅ |
| `{"mode":"global","rngs":["torch"]}` | ✅ | ⛔ **缺 `scope:"locked"`** |
| `{"mode":"global","rngs":[]}` | ✅ | ⛔ 没列 rngs |
| `{"mode":"global","rngs":["瞎写的"]}` | ✅ | ⛔ 不认识的随机源 |
| 不写 | ✅ | ⛔ 「call.seed 没写」 |

⇒ **「装得上」不等于「种子那部分对」。** 这是「装引擎」这道关卡的一个真实盲区。

### 读音预览是可选能力：`pron.preview`

`call` 只描述怎么出声音。「文本 → 读音」的预览是另一件事，名片用顶层的 `pron` 段声明它：

```json
"pron": { "preview": { "endpoint": "/pron/preview", "request": "json" } }
```

| 写法 | 装引擎 | 平台的读音校对入口 |
|---|---|---|
| 不写 `pron` | ✅ | 灰掉，一句话说明这台没声明 |
| 写了 `pron` 没写 `pron.preview` | ⛔ 缺 `pron.preview` | 到不了这一步 |
| `endpoint` 不以 `/` 开头 | ⛔ | 到不了这一步 |
| `request` 不是 `"json"` | ⛔ 平台只会用 JSON 体发预览 | 到不了这一步 |
| `runtime.entry` 是平台通用宿主 | ⛔ 宿主只答 `/tts`，声明了也发不出去 | 到不了这一步 |
| 声明齐了 | ✅ | 可用 |

平台发出去的请求体固定 `{ text, lang }`，`lang` 是**平台语种码**，不经 `languages` 换算：
预览要回答的是「这台引擎会怎么念这段字」，平台把自己那套词原样交过去。
响应体平台原样透传，界面按 token 列表读；对不上不报错，只显示空白 ⇒ 形状不合就别声明。

不写 = 没有这个能力，平台**不拿 404/502 去探测**：探测会把「引擎离线」和「没这个能力」
混成同一句话，而且每次切引擎都要打一次。

---

## §6 三道校验

| # | 问什么 | 怎么问 | 状态 |
|---|---|---|---|
| 1 | 装没装 | 纯查盘（解释器/入口/`verify.sys_path` 在不在），几毫秒 | ✅ `envCheck.js` 浅层 |
| 2 | 起得来 | 拿**引擎自己的解释器**去 import 名片点名的模块/类/方法 | ✅ `envCheck.js` 深层 |
| 3 | **出得了声** | 真跑一次合成 | ⬜ **未实现** |

⚠️ **1 和 2 是两根轴，不是一根**：`ok` = 装没装，`assets` = 权重在不在。
「环境装好了、权重还没下」是完全正常的中间状态；压成一句「没装」会让人
去重装一遍 7.8GB 已经装好的环境。

⚠️ **第 3 道是唯一的关键路径欠账。** 它的判据「第三台引擎上必须能红」
需要第三台引擎才成立（2026-09-04 Owner 裁决：分两级 ——
A 级跑一次真合成出非空 WAV，B 级只验证宿主拿到合法响应）。

**今天的实际含义：前两道过了，你仍然只能靠手动试一次来确认它真能出声。**

---

## §7 进程与内存

### 模型位：两种送法，穷举

`weights[].applies_at`：

| 值 | 含义 | 换模型时 |
|---|---|---|
| `launch` | 开进程那一步就吃进内存 | **重开进程** |
| `call` | 进程活着时一次调用换掉 | 发一次请求即可 |

⚠️ **填错的后果不对称**：该 `launch` 当 `call` ⇒ 发一个引擎不读的键、
声音没变、**不报错**。反过来只是多重开一次，慢但不撒谎。
所以解析时兜底取 `launch`。

#### call 位怎么换：`weights[].switch`

call 位本身只保证「选中的值随请求体送到」。有的引擎还要求先单独发一次换权重请求，
这一步由名片声明：

```json
{ "name": "gpt", "param": "gpt_model", "applies_at": "call",
  "switch": { "endpoint": "/set_gpt_weights", "query": "weights_path" } }
```

平台在每次合成前按声明发 `GET <endpoint>?<query>=<选中的值>`；同一个值已驻留就跳过。

- 不写 `switch` = 平台不发额外请求，值只随请求体送。
- ⛔ 走 stdio 的引擎不许写：值随请求体进宿主，声明了也发不出去（解析期拒绝）。
- ⛔ 写了 `switch` 就必须有地址（`default_base_url` 或 `base_url_env`），否则解析期拒绝。

⭐ 这二分法**不问你**，从名片推：有 launch 位 ⇒ 进程=模型 ⇒ 按需起、空闲放；
只有 call 位 ⇒ 进程是壳 ⇒ 可预热、不释放。

### ⛔ 硬限制：一个进程只能带一个 launch 位 [实测]

`MAX_LAUNCH_SLOTS = 1`（`residency.js:182`）。根因：平台把 launch 模型送进
进程的办法是**重定向底模目录**（`{checkpoints}` 占位符），而**一个进程只有一个
底模目录**。

实测行为（`D:/Project/test_script/probe_max_launch_slots2.cjs`）：

| 场景 | 结果 |
|---|---|
| 两个 launch 位 | ⛔ `ENGINE_TOO_MANY_LAUNCH_SLOTS`，**spawn 0 次** |
| 一个 launch 位 | ✅ |
| **两个 call 位（GSV 形状）** | ✅ **不受影响** |
| launch + call 混合 | ✅ |

⚠️⚠️ **拒绝发生在第一次合成时，不是装引擎时。**
`registry.js` 和 `profile.js` 都不含 `MAX_LAUNCH_SLOTS`。
⇒ 名片装得上、界面全正常、**点合成才炸**。

⚠️ 写这个限制时**零测试覆盖**（`residency.node.test.js` 里没有它）。
上面的表是本次实测补的，不是从代码读出来的。

### 内存判据

`memprobe.js`（量真实占用）+ `memledger.js`（记到 `state/engine_memory.json`）。

⚠️ **`cap` 仍在当法官**（`DEFAULT_CAP = 2`），而 `residency.js` 自己的注释
已经写明它当不了法官：

> 「它是个**代理指标**。我们真正想问的是「内存还够不够」，它却去问
> 「我开了几台」，中间靠两个假设换算……真机实测把两个假设都打穿了。」

正解是直接量起之前还剩多少。`cap` 应降级为「账本全 null 时的兜底」——
**这是 B3，尚未执行**。

### 文件名的读法与底模的清单：引擎目录下的 `scan.json`

扫盘（`lib/assetScanner/`）把 `assets/<角色>/models/<引擎 id>/<权重位>/` 里的文件列出来之后，
还能给条目补三个标签：语种、训练轮数、权重版本。前两个只给人看；权重版本还要拿去查
「这一版的底模在不在盘上」（生成页的底模提示按它说话）。
同一份文件回答的第二件事是：这台引擎的**全局底模目录**里，哪些文件算推理页底模下拉的候选。

⚠️ **这三个标签的读法不写在平台里。** 每个引擎的文件名约定不同，写死在平台代码里
就等于每接一台引擎改一次平台。约定由引擎自己声明，和名片同一个目录、同样的纪律：

`engines/<引擎 id>/scan.json`，顶层只认四个键：

| 键 | 形态 | 平台拿它做什么 |
|---|---|---|
| `language_from_name` | 正则数组，必须带 `(?<lang>...)` | 命中后取那组转小写，用来**找回丢失的 `meta.language`**；已有值永远优先 |
| `steps_from_name` | 正则数组，必须带 `(?<step>...)` | 取训练轮数 |
| `version` | 对象 | 只给 `version.slot` 那个权重位里的文件贴版本 |
| `base_models` | 数组 | 全局底模目录里哪些文件算候选（见下面的「底模有哪些」） |

每一条既可以写正则字符串，也可以写 `{ "pattern": ..., "flags": ... }`；
`flags` 带 `g` 或 `y` 当场报错（同一条正则要逐个试文件名，带状态的匹配会让结果
取决于前面已经试过几个）。

`version` 里三种判定按顺序试：

| 键 | 判据 |
|---|---|
| `header_bytes` | 读文件前几个字节当版本头。不写 = 2 |
| `header_map` | 版本头 → 版本名。键长必须等于 `header_bytes`，且每个字符都在 0–255（按字节读的，写汉字的键是条永远匹配不上的死规则） |
| `from_name` | `[{ pattern, flags?, value }]`，文件名里带版本 token 的写法 |
| `from_size` | `[{ below_bytes?, value }]`，**阈值严格递增，最后一项不许写 `below_bytes`**（要兜住所有尺寸，否则更大的文件读不出版本） |

**缺在哪一层，平台说出来**（这是标签唯一的静默空间）：

| 情况 | 平台行为 |
|---|---|
| 引擎没装（`engines/` 下没这台） | 模型照样列，`meta.assets.scan_conventions_missing` 记一条 `engine_not_installed`，日志一句话 |
| 装了但没写 `scan.json` | 同上，记 `no_scan_file` = 平台不推断 |
| 写了但读不动 | ⛔ 当场抛 `ENGINE_SCAN_INVALID`，消息指名引擎、哪个键、怎么改 |

第三种**不许降级成「跳过」**：一条拼错的规则如果被静默跳过，作者看到的是
「这个角色的版本标签是空的」，而真实原因是那份声明根本没生效。
单角色扫描（`POST /api/assets/:id/scan`）把这条错误原样端给用户（400 + `engine_id` + `key`），
全量扫描只把受影响的那个角色标成 `_scanError`，其它角色照扫。

#### 底模有哪些：`base_models`

底模是引擎自带的那份预训练权重，不住在角色目录里，住在名片说的那个全局位置
（`models.checkpoints_env` 顶掉的变量 > `runtime.checkpoints`，绝对化一律经
`lib/engines/checkpoints.js` 的 `resolveCheckpointsDir`）。推理页的底模下拉和
开训前的底模体检算根目录走的是同一个定义处，所以两处看的必须是同一个目录。
⚠️ 训练那一步（`lib/training/steps/train.js`）还走 `lib/paths.js` 的旧回落链，
把它并过来属于训练通用化那一刀，不在本契约的范围里。

每条声明长这样，认识的键只有这六个：

| 键 | 必填 | 含义 |
|---|---|---|
| `slot` | 是 | 属于名片 `weights` 里的哪个位。写了名片没有的位**当场报错**，指名那个位、名片现有的位、以及两种改法 |
| `name` | 是 | 界面上显示的整串。平台不拿它跟任何常量拼接 |
| `candidates` | 是（非空） | 相对底模目录的路径，按优先顺序，取第一个在盘上的。不许写绝对路径，也不许 `..` 出那个目录 |
| `version` | 否 | 这一份属于哪个版本，给界面分组用 |
| `steps` | 否 | 训练轮数；`null` 是明说「这一份没有轮数这个概念」 |
| `default` | 否 | 界面上的初始选择。一个位上最多一条，两条并列当场报错 |

三条规矩：

- **写了就是白名单。** 声明过的那台，目录里另外躺着的东西不算候选：底模下拉要的是
  「这台引擎认这几份官方权重」，而不是「这个目录里有几个文件」。
- **不写 = 走通用规则。** 底模目录下按权重位分目录，逐位列里面的东西；没有分层且只有一个位时，
  整个目录算那一份模型。这条规则不看引擎是谁，社区自己放的权重一样是候选。
- **`base_models: []` 是错的**，不是「声明没有」。不声明就把这一段删掉，留着空数组
  只会让人以为声明生效了。

同一个位上两条同名条目也当场报错（两条都往 `<位>/<名>` 写，界面只显示一条）。

底模目录在、候选一条都报不出来、而 `scan.json` 又读不出来的那台，
下拉会带一条 `assets.scan_conventions_missing`（形状同上表那两个 reason），
和 `GET /api/voices/<id>/validate` 的 `checks.scan_conventions_missing` 同一份回答。
一台的声明写坏只让它自己说不出，别的引擎照列，报错原文带在 `message` 里。

注释键一律 `_` 开头，任何一层都一样 —— 写给人看的说明不是内容。

---

## §8 端口

⚠️ **这一节是端口的现状，不是建议。**

一个进程一个端口，写在 `host.py:1066` 的 `ThreadingHTTPServer((host, port), ...)`。

`residency.js:69` 那条注释说：

> 「⛔ 也不许拿端口池大小来当上限：端口有 65535 个，不稀缺。」

**这句话在「能不能连得上」的意义上对，在「该不该占」的意义上错。**
代码算了稀缺性，没算存在感（Windows 防火墙弹窗、`netstat` 里一片
`LISTENING`、与动态端口范围 49152–65535 的其它程序撞车）。

Owner 2026-09-04 裁决：**资源占用形态 = C（全常驻 RAM、按需换进显存）**，
面向低延迟 API 服务。⚠️ 该形态假设多卡机器；8GB 单卡上「100 个常驻」
物理上不成立。这是**部署侧**的事，不影响接入新引擎。

**端口归零（管道化）是 B4，卡在第三道校验后面** —— 没有验收手段就改传输层
是本末倒置。

---

## §9 两个前端共用一条路径

- **Workbench**：`web/src/components/{generate,compare,train,assets,broker,engines}`
- **Flow**（ComfyUI 式画布）：`lib/flowgraph/` + `web/src/components/flowgraph/`
  ⛔ **默认关闭**，要 `FLOWGRAPH_ENABLED=1`

画布的 `io.engine` 节点 **`engine_id` 必填**（Owner 2026-08-28 拍板），
画布不替你挑默认引擎（`adapter.js:97` 抛 `FG_ENGINE_ID_MISSING`）。

### 界面按名片长

`web/src/lib/engines.js` 的判据：「**装一台谁都没见过的引擎，
这里的代码一个字都不用改**」。`engines.node.test.js` 全用真函数守着（⛔ 不是文本守卫）。

⚠️ 2026-08-31 取证过一件事：`npm run build` 绿 **不证明接线对**。
React 的 prop 传漏了不是错误，是 `undefined`，打包器一个字都不会说。
E1 的判据是「随便挑一个渲染点删掉 `engineId`，必须有一条测试变红」。

---

## §10 纪律（比任何单点能力都重要）

1. **四个文件里不许出现任何具体引擎名**：`registry.js` / `payload.js` /
   `profile.js` / `web/src/lib/engines.js`。各有守卫测试。
2. **不静默忽略**。每一条「设了它但什么都没发生」都是这个项目反复付的学费。
3. **拒绝时不做副作用**。为一次注定失败的请求顺手关掉别人 = 副作用发生了、
   请求还是失败了。
4. **说不知道，不要编**。走到「需要确认」那一支的全部原因就是平台不知道；
   编一个数出来被信了之后，错会算在平台头上。
5. **坏掉的引擎不静默消失**。单独归到 `errors[]`，前端显红。
6. **文档里的每个路径都要验**。2026-09-04 修 README 时实测发现四处过期
   事实（`vendor/tts/`、`vendor/gsv-tools/`、`tools/checks/`、
   `outputs/flowgraph/`），其中「模型文件」一节把 GSV 写成了平台约定。

---

## §11 与其它文档的关系

| 你想知道 | 读哪 |
|---|---|
| **怎么接一个引擎**（操作） | [`../engines/_TEMPLATE/README.md`](../engines/_TEMPLATE/README.md) |
| **每字段怎么填** | [`../engines/_TEMPLATE/manifest.json`](../engines/_TEMPLATE/manifest.json) 的 `_comment_*` |
| **现在在哪、下一刀** | [`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md) |
| 真引擎的完整参照 | `engines/indextts2/manifest.json`（真引擎，595 行） |
| 抽象层怎么工作 | `lib/engines/*.js` 的文件头注释（那里是最新的） |
