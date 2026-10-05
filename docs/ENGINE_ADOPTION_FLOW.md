# 引擎接入流程 —— 当前设计

> **2026-10-04 会话产出。取代 `ENGINE_WIZARD_PLAN_v2.md`（v1 已删）。**
> 进度与欠账看 [`ONBOARDING_PLAN.md`](./ONBOARDING_PLAN.md) —— **那才是状态的唯一真相**。
> 本文件只回答「流程长什么样、为什么这么定」，**不记进度**。
>
> ⚠️ 口径沿用项目纪律：`[实测]` = 本机跑出来的 · `[读码]` = 读代码得出的 ·
> `[决定]` = Owner 2026-10-04 定的 · `[待裁]` = **还没定，别当结论用**。

## 为什么有这份文件

2026-10-04 那一轮把接入流程推翻重推了一遍（clone-first、`installPlan.js` 退役、
权重不再集中管理、第五步降级）。推翻产生的新结论散在对话里，
**而「记录在别处、代价自己付」正是这个项目反复付学费的同一种缺陷**
（`ONBOARDING_PLAN.md` §5 第 1 条）。⇒ 落到仓库里。

⚠️ **本文件不取代任何契约**。`ENGINE_ONBOARDING_CONTRACT.md` 讲「已实现行为为什么是这样」，
本文件讲「流程该长什么样」。两者会冲突时，**契约赢**（那是已经在跑的代码）。

---

## 一、五步，不是六步

```
1 克隆         git clone <url> engines/<id>/     ← 目录必须空
2 建环境       照名片的 install.env_command；⚠ 注意 torch
3 下模型       底模落到自己的目录 + 下完对一次名
4 写名片       落盘 manifest.json
5 校验         三块独立显示，缺哪块写哪块
```

⚠️ **相对现行实现（`editor/steps.js` 六步）的四处变化：**

| 变化 | 理由 |
|---|---|
| **「6 · Ready 平台什么都不做」删掉** | [决定] 它不是步骤，是一句状态提示。平台确实什么都不做（`engines/` 目录即注册） |
| **probe（探测上游）从第 1 步挪到第 2 步** | [决定] 探测的产物是「依赖清单 + torch 三态判定」，**消费者就是建环境**。挂在克隆那一步是错位的 |
| **第 3 步从「只打印命令」改成「真下载」** | [决定] 见 §三 |
| **第 5 步从「四道校验」改成「三块独立结果」** | [决定] 见 §四 |

⚠️ `[待裁]` **第 3 步和第 4 步的关系**：

```
3 下模型  ← 要知道「放哪」+「拿哪条命令」，两者都在名片里
4 写名片  ← runtime.checkpoints / models.source.command 是名片的键
```

| | 做法 | 代价 |
|---|---|---|
| **甲** | 3 ∥ 4 **保持并发**（现行 `steps.js` 就是 `parallelWith`） | 轨道上不是一条直线 |
| **乙** | 3 先按**约定路径**下载，第 4 步的 `runtime.checkpoints` 追认那个约定 | 命令从上游 README / 仓库卡片来 ⇒ **破「名片是唯一权威」** |

### ⭐ 顺序的因果链，以及那个 bootstrapping 悖论

```
知道要装哪个仓库（repo URL）
   ↓ clone                      有源码了：入口 / 依赖清单 / 它推荐怎么装
   ↓ 读它
   ↓ 建环境  ← ⚠ 但 env_command 只能来自名片
   ↓ 反射出 parameters[] → 补完名片 → 落盘
   ↓ ⛔ 钉版本 + 删 .git（今天缺，A4''）
   ↓ 校验
   ↓ 平台扫目录 → 前端按名片长出面板
```

⚠️ **「名片必然是两阶段的」—— 这条设计事实从来没被写下来过，直到今天。**

- 建环境要在名片之前（否则第 1 步就卡住）
- 而 `install.env_command` 只能来自名片

⇒ **`install` 段 + `upstream.url` 必须在 clone 之后立刻就有**（用户凭上游 README 填）；
**`call.*` / `parameters[]` / `commit` 要等源码和解释器都在了才写得出来。**

[读码] `tools/engine-wizard/core/env.js:110-111` **已经隐式承认了**这件事
（「上游仓库是第 2 步刚克隆的，manifest.json 还不存在 ⇒ 这一步的命令只能来自
『用户填好的那张名片』，不是读盘」），**但它没出现在任何文档或计划里**。
⇒ 谁照着旧文档走都会撞墙。

---

## 二、第 1 步：clone-first 已经取代「先有名片」

[决定] **Owner 裁定：先克隆。** 完整论证见 `ONBOARDING_PLAN.md` §2.6（三条独立证据：
`scaffold-params.cjs` 的循环依赖 · `commit: null` 不可得 · init+fetch 是纯 workaround）。

⭐ **它不只是内部逻辑自相矛盾 —— 上游自己的 README 就是 clone-first。**
`IndexTTS-2.5` 官方 README 第一句：

```bash
git clone https://github.com/index-tts/index-tts.git && cd index-tts
git lfs pull          # ← 这就是「必须 clone 而不是下 zip」的理由
```

⚠️ **为什么 zip 不行**（三条，各有东西撑）：

| | |
|---|---|
| **git-lfs** | 权重以 LFS 指针躺在仓库里，zip 拿到的是指针文本（IndexTTS-2.5 是 5.49GB） |
| **submodule** | CosyVoice2 带 `third_party/Matcha-TTS`，漏了它第一次 import 就报 `No module named matcha` |
| **锁文件** | `uv sync` 靠 `uv.lock` 精确复现。这几个项目的 `transformers` 版本是雷（GSV 4.43 / CosyVoice2 4.51.3 / IndexTTS2 4.52.1，装错立刻报 `cannot import name 'OffloadedCache'`） |

⚠️ **`.gitignore` 要逐条决策**：`engines/*/` 是整棵排除的（`.gitignore:258`）。
克隆完要么逐条列出要保留的文件（`indextts2` 就是这么做的，5 个文件），
要么明确接受不跟踪。**两者都可以，但不能不清楚选了哪个。**

---

## 三、第 3 步：从「只打印」改成「真下载」

### ⭐ 现行规则并不禁止 —— 它禁的是另一件事

> 「HF、ModelScope、直链、网盘，各家不同；**平台一旦替谁生成命令，就等于把那一家写进 lib/**」

**禁的是「平台生成」，不是「平台执行」。** 而 `models.source.command`
**已经是名片声明的 argv 数组**，平台已经会做占位符替换（`{checkpoints}` → 绝对路径）、
已经知道 `license_gate`（有些模型要先去网站点同意）。

⇒ [决定] **执行它不违反「只验不建」**：平台依然不需要认识任何下载器。

⚠️ **记一笔规则没被写全**：「不替你下载」的准确含义是「**不替你决定从哪儿下**」。
决定已经在名片里了。这条要回写进 `engines/_TEMPLATE/README.md`。

### 真下载必须有的三件

| | 为什么 |
|---|---|
| **断点续传** | 5.49GB 断一次很难受 |
| **并发** | 单文件 2GB（`llm.pt`）是串行瓶颈 |
| **进度显示** | 前端要能显示「3/8 完成」 |

### ⭐ 校验：别指望 hash，靠「下完对一次名」

⚠️ [实测] 上游不一定给 hash，而 **config 的名字都不可信**（见 §五）。

```
盘上实际有的  vs  名片 models.required
  缺：      qwen0.6bemo4-merge/ 不见了
  多：      .cache/  hf_cache/        ← 运行期产物，不是权重
  后缀不符：gpt.pth ≠ gpt.pt          ← 这个真的发生过
```

**三态如实列出来让人看，而不是猜。零成本，只列两个目录。**

⚠️ `[待裁]` 是否给 `models` schema 加一个可选的 SHA 字段。⚠️ **别顺手做** ——
那是磁盘上的既有格式，动它要走 C11 豁免那套论证。

---

## 四、第 5 步：三块独立显示，缺哪块写哪块

[决定] **不是「四道校验」，是三块互不依赖的结果。** ⛔ 不绑成一个必须全过的门。

```
① 引擎起没起 + 状态码/退出码      ← 平台起引擎（supervisor + launchPlan + host.py）
② 音频 → 复用 Generate 的 Player   ← 降级掉 ffmpeg/ffprobe
③ ASR 回读                       ← 延后，缺了就显示「这一块没有」
```

### ⭐ ② 复用 `web/src/components/common/Player.jsx`，比 ffmpeg 强

[读码] 它的接口是 `Player({ src, size, bounds, duration })`，内部
`fetch(src)` → `decodeAudioData` → 波形峰值 + 时长 + 播放/暂停 + 进度。

⇒ **「浏览器能解码并出声」本身就是一道校验**（比 ffprobe 强的地方是**给人看波形图**）：

| 判据 | 能抓什么 | 抓不到什么 |
|---|---|---|
| ffprobe 数字 | 采样率 / 时长 / 声道 / 有没有帧 | 静音占比、复读、听感 |
| **Player 波形图** | **静音塞满**（一段一段的）· 噪声 · 削顶 | 采样率是否等于名片声明 |

[实测] 那段 FunASR 相似度 **0.216** 的音频，人耳听感「怪怪的」，
`diagnose_audio.py` 量出**静音占比 68%、最长静音 3.90s、有声段 10 段散乱**
—— ⛔ **所有「非空类」判据全绿，包括 ffprobe**。
**而它的波形图会立刻显示「一段一段的」。**

⚠️ 落地两个细节：

| | |
|---|---|
| **产物必须落盘到可服务的位置** | `Player` 吃 **URL** 不是 blob。`server.js:344` 挂了 `/outputs` 静态 ⇒ 落 `outputs/_verify/<id>/<ts>.wav` |
| **⚠️ wizard 的 vite config 只 proxy 了 `/api`** | 没 proxy `/outputs` ⇒ **这是复用路上的唯一真障碍** |
| **浏览器 autoplay 策略** | 「实时播放」实际是「点一下播」，别指望自动出声 |

### ③ ASR 回读：**延后，但已经有可用实现**

⚠️ [实测] 它**不是新想法，已经在这台机器上跑过一次**：

| 音频 | 输入文本 | FunASR 反查 | 相似度 | 判定 |
|---|---|---|---|---|
| `cv2-matched.wav` | 今天的天气不错，适合出去走走。 | 今天的天气不错，适合出去走走。 | **1.000** | ✅ |
| `cv2-zeroshot.wav` | 这是一段在英特尔核显上做的语音合成测试。 | 这啊拮抗一些相却学，且像五常结成。 | **0.216** | ⛔ 乱码 |

实现已在 `C:\Aurivox\verify_tts.py`（合成 → 调项目自己的 FunASR → 与输入逐字比对，阈值 0.95），
**而且那次就是在 XPU 上跑的** ⇒ [决定] 延后的不是可行性，是优先级。

⚠️ 但真要放进平台，有两笔账：

| | |
|---|---|
| **ASR 模型住在 `models/asr/`（5.9G）** | ⚠️ **不是任何一台引擎的** ⇒ §六 拆 `models/tts` 时**不动它**。而它同时是**训练线**的依赖 |
| **Arc vs NVIDIA 的 ASR 差异** | [决定] 一会儿再做。真正待验的是「ASR 引擎本身在非 N 卡上的表现」，不是「回读判据可不可行」 |

### ⛔ 第 5 步在 Arc 上今天跑不通 —— 环境问题，不是设计问题

[实测] `venv/` · `engines/gpt-sovits/.venv` · `engines/indextts2/.venv` 的
`pyvenv.cfg` 都指向旧机（`C:\Users\MECHREVO X10 Pro\...`），起 interpreter 报
`uv trampoline failed to spawn Python child process`。
⇒ **要真跑第 5 步，得先解「外部环境接进平台」那笔账**（junction vs `runtime.python_env`）。
**验证器自己跑不起来的时候，第 5 步没有意义。**

---

## 五、权重清单怎么自动发现 —— 三源都不完全可靠

[决定] **认可「自动发现」，但先看清每一条源能到什么程度。** [实测] 拿三台真引擎的
权重目录验过：

### ✅ IndexTTS2：钩子存在，但不准

```
models/tts/indextts2/checkpoints/config.yaml 自己点名：
  feat1.pt  feat2.pt  gpt.pt  s2mel.pt  wav2vec2bert_stats.pt
```

⛔ **两处不准**：

| | |
|---|---|
| **后缀错** | config 写 `gpt.pt` / `s2mel.pt`，盘上是 **`gpt.pth` / `s2mel.pth`** |
| **漏了** | `bpe.model` · `pinyin.vocab` · `configuration.json` · 整个 `qwen0.6bemo4-merge/` |

### ⛔ CosyVoice2：钩子完全失效

`cosyvoice2.yaml`（7.3KB）里**一个权重文件名都没有**（grep `.pt/.onnx` 全空）。
它只有配置项，不点名文件。

### ⇒ 三类来源各有各的失效方式

| 来源 | 长什么样 | 失效方式 |
|---|---|---|
| 引擎自带 config | IndexTTS2 的 `config.yaml` | 后缀错、漏项 |
| 代码里的下载调用 | `snapshot_download("pengzhendong/wetext")` | 只覆盖第三方包拉的 —— `models.external[]` 就是为它留的形状（键刻意很少：`name`/`label`/`via`/`needed_by`，它回答「这东西是什么」，不是「怎么装」） |
| 上游下载脚本 / README | `hf download …` | 非结构化 |

### ⭐ 结论：多源交叉 + 全部标置信度 + 全部要人确认

**这条路已经被验证过** —— 就是 A1 的 `reflect_params.py`，实测战绩：
拿 IndexTTS2（人已手写 14 条）当标准答案，**漏 0、误排 0、类型 13/14 一致**。

```
扫出来的候选  →  _confidence: high / medium / low  +  _why（从哪扫到的）
             →  _needs_review: true（默认值是 None、类型是猜的那些）
人确认后      →  进 models.required
```

⛔ **`models.required`（哪几个算齐）永远要人确认。** 理由就是上面那个
`gpt.pt` vs `gpt.pth`：**自动判定会把一台好好的引擎报成「缺文件」**
—— 而那正是「糊成 false 会让一台好好的引擎永远挂红灯」的场景。

⭐ **所以维护的应该是「探针」，不是「清单」。** 探针写一次，之后每台引擎自动出草稿；
清单仍然是人确认一次的事实。

---

## 六、权重不再集中管理：`models/tts/` 拆掉

[决定] **拆掉 `models/tts/` 那 20G，引擎权重落到自己的目录。** 论证：
**我们管理的是引擎，不是模型；TTS 生态太零散，不适合集中式管理。**

[实测] `models/` 各支的归属：

| 目录 | 大小 | 归属 | 拆不拆 |
|---|---|---|---|
| `models/tts/` | **20G** | **四台引擎各自** | ✅ **拆** |
| `models/asr/` | 5.9G | 训练线 + 校验线共用 | ⛔ 不动 |
| `models/separation/` | 1.7G | 训练线（UVR5） | ⛔ 不动 |
| `models/vocoder/` · `sr/` · `lang/` | 215M · 114M · 126M | 训练线 | ⛔ 不动 |

### 目标路径：`engines/<id>/checkpoints/`

| | |
|---|---|
| ✅ **`.gitignore` 不用改** | `.gitignore:213-221` **已经有 `engines/*/checkpoints/`** —— 2026-09-04 就为「名片 `runtime.checkpoints` 声明的底模目录」加过了 |
| ✅ **C3 契约不破** | `profile.js:503` 的 `relPath` 禁的是**绝对路径**；`engines/<id>/checkpoints` 仍是相对项目根 ⇒ 名片**只改一个字符串** |
| ✅ **顺带闭环一个悬挂问题** | [实测] `engines/cosyvoice2/` 现在有个**嵌套 `.git`**（C10 明令禁止那种）。权重进引擎目录后上游仓库不可能含 4.4GB 权重 ⇒ `.git` **必须删** |
| ✅ **搬迁是同盘** | `models/` 与 `engines/` 都在 D: ⇒ 秒级完成。`.staging` 那条「rename 不能跨盘」的坑这次不适用 |
| ✅ **「引擎自己下载」变自足** | 目录就在引擎旁边，下载目标不用问平台 |

### ⛔ 分两步 —— 代价只出在 GSV 那一台

[读码] `lib/paths.js` 里 GSV 的 base model 不是一个常量，是**一套带兼容层的小系统**：

```
GSV_PRETRAINED_DIR                        (301)
BASE_DIRS.v2final / v2pro                 (343-344)
BASE_DIRS.v1/v2/v2Pro/v2ProPlus           (348-351)
S1_V2_FILE                                (362)
BASE_WEIGHTS_CANONICAL / _LEGACY / _WEIGHTS  (376-393)  ← 两个里取第一个存在的
```

⚠️ 而 **`lib/training/` 训练线读的就是它** —— C3 裁决「训练链绑死 GSV，暂不做」，
**没有第二台可微调引擎顶得上**。⇒ **一次全搬 = 立刻弄坏训练。**

| | 搬什么 | 代价 |
|---|---|---|
| **第一步** | **三台非训练线引擎**（cosyvoice2 4.4G + cv-300m-sft 2.2G + indextts2 11G = **17.6G**） | 改三张名片的 `runtime.checkpoints` 一个字符串 |
| **第二步** | GSV 那 2.8G | ⚠️ 要同时改 `paths.js` 那 5 处 + 训练线 ⇒ **建议等 C3 解掉再动** |

⚠️ **过渡期会留下不一致**：三台在 `engines/<id>/checkpoints`，GSV 还在 `models/tts/`。
**这不违反任何契约**（`runtime.checkpoints` 本来就逐台声明），而且是**过渡期唯一安全的形态**。

⇒ `models/tts/` 定义成「**只读，等迁移**」，一台一台上线，每上一台改一行名片 + 记一笔台账。

---

## 七、名片表单：三件套 + 三段分组

[决定] **不能用原生 json 字段名。** ⛔ 也不接受「只换一个中文 label」。

### 每个字段三件套

```
Checkpoint 放哪                                        ← 术语英文（平台权威用词）
相对项目根的目录。例：engines/cosyvoice2/checkpoints
⛔ 不能写绝对路径（如 D:\models）—— 平台会当场抛 ENGINE_MANIFEST_INVALID_VALUE
```

| 件 | 内容 |
|---|---|
| **白话标题** | 说人话，不是 `runtime.checkpoints` |
| **一句话说填什么** | 加上「相对谁」 |
| **格式 + 例子 + 填错报什么** | 第三件最要紧 |

### ⭐ 第三件可以几乎零成本自动生成

[读码] `profile.js` 里**每个键的抛错消息本身就写了「应该写什么」**：

```js
throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
  `…写成了绝对路径（${value}）—— manifest.json 要能跟着项目复制到别的机器，路径必须是相对的…`)
```

⇒ **把已有的错误消息提到字段下面显示**，不是新写文案，
是**把散在代码里的说明搬到用户眼前**。

### 三段分组 = 「简化心智」的可验收定义

| 段 | 谁填 | 界面 |
|---|---|---|
| **必须人填**（`id` · `runtime.entry/python/ready_endpoint` · `call.module/class` · `upstream.url` …） | ⛔ 人 | 顶在前面，不填不许下一步 |
| **能反射**（`parameters[]` 及其派生的 5 份视图） | ✅ `reflect_params.py` | 自动填 + 标「这是反射的」 |
| **有先例/有默认**（`contract_version` · `capabilities.output_sample_rate`（从模型自带 yaml 读）· `weights[]`） | ✅ 自动 | 自动填 + 标来源 |

⭐ **顺序上正好成立**：反射必须在**引擎自己的解释器里**跑
⇒ 第 2 步建好环境 → 反射 → 第 4 步落盘。**这正是现在的步骤顺序。**
（唯一的障碍是 §一 那个 bootstrapping：草稿只需先有 `install` + `upstream` 两段就够反射。）

---

## 八、术语裁决

| 对象 | 裁决 | 依据 |
|---|---|---|
| 「权重」/ `Weights` | → **`Checkpoint`**（中英两位都写英文） | [决定] ① 词义：中文「权重」= 模型内部参数（wx+b），而这一步是**训练产出的文件/目录**；`models/tts/gpt-sovits/` 里 `chinese-hubert-base/` 和 `chinese-roberta-wwm-ext-large/` **根本不是权重** ② 平台自己的权威用词就是 checkpoint（`runtime.checkpoints` / `checkpoints.js` / `checkpointStatus()` / README 通篇「底模」） ③ `i18n.jsx:4-7` 明文点名 Checkpoint 必须保持英文 |
| 「名片」/ `Manifest 名片` | → **`Manifest`**（中英两位都写英文） | [决定] ① `i18n.jsx:29` **默认语言是 `en`** ⇒ 英文是主语言、中文是翻译 ② **界面上叫「名片」，用户会去找一个叫「名片.json」的文件** —— 磁盘上是 `manifest.json`，他下一步就要 `cat` 它 ③ 受众是接入者/AI ④ 现在 `['Manifest','Manifest 名片']` 是**两样都写 = 没选** |

### ⛔ 不改的两处

| | |
|---|---|
| **名片键** `models.required` / `models.source` / `runtime.checkpoints` | 那是**磁盘上的既有格式**，改名等于让存量名片全部读错（C11 豁免表同一道理） |
| **代码注释里的「名片」** | [实测] 全树 `名片` 247 处，**其中只有 16 处是用户可见文案**，其余 231 处全是注释。而注释用中文「名片」是**对的** —— 它是给读代码的人看的内部比喻。i18n 规则只管 UI 字符串 |

⚠️ **残留不一致要显式承认**：步骤叫 `Checkpoint`、端点仍叫 `/wizard/models`、
名片键仍叫 `models.*`。**端点改名单独一刀**（会牵动 `wizardbridge` 的路由前缀），别混进 UI 改名。

---

## 九、⛔ 本文件里还没定的

| | |
|---|---|
| **第 3 步与第 4 步** | 并发（甲）vs 约定路径顺序（乙） |
| **是否加 SHA 校验字段** | 会动 `models` schema ⇒ 要走 C11 论证 |
| **第 5 步的参考音频** | ⚠️ **「自带一段音频」是「自带一段逐字配对的音频，且要按语种各备一份」** —— 0.216 的根因 #1 就是参考音频与 `prompt_text` 不配对。中文那一对喂给英文引擎就是废的。**这不是一句话，是一份要维护的资产** |
| **产品前端那处「名片」** | `web/src/components/compare/ReferenceCompareTab.jsx:1363` 是唯一一处「名片」出现在给最终用户看的界面上。改它等于定「产品术语进不进产品界面」这条规矩 |
| **ASR 在 Arc vs NVIDIA 的差异** | 一会儿再做 |
