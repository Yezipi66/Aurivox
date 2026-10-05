# 接入一台新 TTS 引擎

> ⛔⛔ **本文件的「五步」已被 2026-10-04 那轮讨论推翻，不要照它走。**
> ⛔ **第 3 步整步作废** —— `tools/install-engine.cjs` 与 `lib/engines/installPlan.js`
> 已整体退役（Owner 裁决，理由见本文件顶部第二块 banner）。
>
> **现行流程（5 步）看 [`../../docs/ENGINE_ADOPTION_FLOW.md`](../../docs/ENGINE_ADOPTION_FLOW.md)**：
>
> ```
> 1 克隆    git clone <url> engines/<id>/      ← 目录必须空
> 2 建环境  照名片的 install.env_command；⚠ 注意 torch
> 3 下模型  落到 engines/<id>/checkpoints/ + 下完对一次名
> 4 写名片  落盘 manifest.json
> 5 校验    三块独立显示，缺哪块写哪块
> ```
>
> 与本文件的四处差异：
> ① **名片从第 1 步挪到第 4 步**（为了让 clone 时目录是空的）
> ② **第 3 步从「只打印命令」改成「真下载」** —— ⛔ 而本文件说「平台不替你下载」，
>    那条规则的**准确含义是「不替你决定从哪儿下」**；决定（`models.source.command`）
>    已经在名片里，平台执行它不违反「只验不建」
> ③ **权重不再放 `models/tts/<id>/`**，改放 `engines/<id>/checkpoints/`
>    （`.gitignore` 早已有 `engines/*/checkpoints/` 一行；C3 契约不破）
> ④ **「6 · 前端能用」不再是独立步骤** —— 平台本来什么都不做

> 目标读者：第一次在这个平台上装引擎的人（人或 AI）。
> 进度与欠账看 [`../../docs/ONBOARDING_PLAN.md`](../../docs/ONBOARDING_PLAN.md)。
>
> **一句话**：`engines/<id>/manifest.json` 是唯一权威。平台只验不建 ——
> 它不替你装环境、不改你上游一行代码。照 `manifest.json` 里的注释填，填完用两条命令自检。
> 👉 **「从哪儿下模型」由你决定并写进名片，平台照着执行**（见上面 ②）。

## 目录名就是引擎 id

```
engines/
  gpt-sovits/          ← 目录名 = 引擎 id = manifest.json 里的 id
  indextts2/
  cosyvoice2/          ← 你的引擎放这儿
    manifest.json      ← 照 _TEMPLATE/manifest.json 填
    UPSTREAM.md
    LOCAL-CHANGES.md
    .venv/             ← 这台引擎自己的 Python 环境（不放进 git）
```

⛔ `manifest.json` 里的 `id` 必须和目录名**逐字相同**，否则装不上
（`ENGINE_MANIFEST_ID_MISMATCH`）。

⛔ `engines/` 整棵树是要进 git 的（`manifest.json` / `UPSTREAM.md` /
`LOCAL-CHANGES.md` 都在里面）。所以**别把底模放进源码那一层** ——
⚠ **2026-10-04 起底模归 `engines/<引擎id>/checkpoints/`**（它已被 `.gitignore` 排除），
而**不是** `models/tts/<引擎id>/`（存量四台还在那儿，迁移中）。见下面第 4 步。

## 五步（⚠ 已被推翻 —— 现行 5 步见顶部 banner）

### 1 · 建目录 + 填名片

```bash
mkdir engines\cosyvoice2
copy engines\_TEMPLATE\manifest.json engines\cosyvoice2\manifest.json
```

模板里每个键都带 `_comment_*` 注释，**填完把下划线开头的键删掉**（它们只是注释，
平台会剥掉但留着会碍眼）。所有 `REPLACE_ME` / `REPLACE_*` 都要换成真的。

**最容易填错的四段**（详细说明在模板的注释里）：

| 段 | 填错的后果 |
|---|---|
| `weights[].applies_at` | 填错 ⇒ **不报错**，下拉能选、声音不变 |
| `call.bind` | 槽位名错 ⇒ 宿主 400 列出 unknown parameter |
| `parameters[].phase` | 该 load 当 call ⇒ 改它不生效、不报错 |
| `upstream.commit` | 装出来的版本跟开发时用的不同 ⇒ **声音不对**，不报错 |

### 2 · 生成参数草稿（有 `call` 段之后）

```bash
node tools/scaffold-params.cjs --engine cosyvoice2            # 只打印
node tools/scaffold-params.cjs --engine cosyvoice2 --write    # 写到 parameters.draft.json
```

它在**你这台引擎的解释器**里反射 `__init__` 和目标方法的签名，生成
`parameters[]` 草稿 —— 省掉手抄参数名、类型、默认值这一段。

⛔ **它是草稿，不是成品。** 下面这些反射拿不到，每条都留了 `REPLACE_ME`：

| 拿不到的 | 为什么 |
|---|---|
| `min` / `max` / `step` | 上游签名里没有范围信息 |
| `choices` | 上游没写 `Literal[...]` 时就得自己列 |
| `label` / `help` 的中文 | 平台不替你翻译 |
| `only_when` | 「这个输入框依赖那个开关」是引擎的语义，反射不出来 |
| `tier` / `group` | 界面分组是产品决定，不是引擎事实 |

⚠ **草稿里 `_needs_review: true` 的条目要逐条看**：那些是「默认值是 None、
平台按参数名猜的类型」。猜错的代价是界面上出现一个改了不生效的旋钮。

⚠ 路径类参数（`cfg_path` / `model_dir` / `*_dir`）会被**自动排除**并说明原因
—— 它们归 `call.init_args` 管。做成界面格子的话，用户改了会「声音不对且不报错」。

并进 `manifest.json` 之后，**记得删掉每个条目上的 `_confidence` / `_why` /
`_needs_review` 等下划线开头的键**（它们是给你看的说明，不是名片字段）。

### 3 · 拉源码（可选，但推荐）—— ⛔ **本步已作废，命令不存在了**

```bash
# ⛔ 以下两条命令已于 2026-10-04 随 lib/engines/installPlan.js 一起退役：
node tools/install-engine.cjs cosyvoice2           # 只打印计划，不动盘
node tools/install-engine.cjs cosyvoice2 --yes     # 真装
```

**为什么作废**（Owner 裁决，理由见顶部 banner）：它走的是
`init → remote → fetch → checkout → drop-git`，而这套存在的**唯一理由**
是「`manifest.json` 已经在目录里，`git clone` 拒绝拉进非空目录」。
本文件第 1 步要求先填名片 ⇒ 目录非空 ⇒ 才有那个 workaround。
**而正确顺序是反的**（先克隆，名片第 4 步才写）⇒ workaround 的理由消失
⇒ 连同它一起退役。

⚠️ `upstream.commit` 是 `null` 时它会拒绝执行并说明原因 —— 那条**纪律本身
仍然成立**（平台不替你拉最新版顶上），只是现在**由向导那一侧负责**，
而 ⚠️ **向导今天还缺「钉版本 + 删 `.git`」这一步**（ONBOARDING_PLAN A4'）。

👉 **今天要手工拉源码：照上游 README 的 clone 命令来。**

### 4 · 下底模

底模放 `engines/<引擎id>/checkpoints/`（⚠ **2026-10-04 起**：不再放 `models/tts/<引擎id>/`）。
放哪由你名片的 `runtime.checkpoints` 决定 —— 那是个**相对项目根**的目录。

平台**不替你决定从哪儿下**，但会把你名片里写的那条命令（`models.source.command`）
**填好占位符打印给你**；向导还会替你执行它（那是执行名片，不是平台生成）：

```bash
node tools/engine-checkpoints.cjs cosyvoice2     # 查齐不齐 + 打印这条取回命令
node tools/dev/check-engine-env.cjs --engine cosyvoice2   # 或用这个查
```

想让平台知道「齐了没」，两段都要写：
- `runtime.checkpoints` —— 放哪
- `models.required` —— 哪几个文件算齐

只写前者 ⇒ 平台只能告诉你目录在不在，**说不出齐不齐**（三态里的 `null`）。

### 5 · 自检（三道校验，前两道现成，第三道见下）

```bash
node tools/dev/check-engine-env.cjs --engine cosyvoice2          # 第一道：装没装
node tools/dev/check-engine-env.cjs --engine cosyvoice2 --deep   # 第二道：起得来
```

- **第一道（浅层）**：纯查盘，几毫秒。解释器在不在、入口在不在、`verify.sys_path` 在不在。
- **第二道（深层）**：拿**你这台引擎的解释器**去 import 名片点名的模块/类/方法。
  慢（几十秒，IndexTTS2 实测 34s），只在装完/排障/CI 时跑，**绝不挂在每次合成上**。

⚠️ 两道是**两根轴**，不是一根：`ok` = 装没装，`assets` = 权重在不在。
「环境装好了、权重还没下」是完全正常的中间状态。

⚠️ **第三道「出得了声」已经做出来了**（2026-09-29，本文件这句话当时写的）：

```bash
node tools/verify-engine.cjs --engine cosyvoice2             # B 级（默认）：宿主拿到合法响应
node tools/verify-engine.cjs --engine cosyvoice2 --level A --request req.json   # A 级：真跑一次合成
```

A 级**先跑 B**（宿主没就绪时直接发 `/tts` 得到的 503 与「声音不对」长得一样）；
`req.json` 的键是**引擎方言**，照该引擎名片的 `maps` 写。
⚠️ **A 级查的是「WAV 有没有帧」，查不出内容乱码** —— 同一份 WAV 可以既有波形
又全是乱码（[实测] 2026-10-02 CosyVoice2 zero_shot 在 XPU 上首次合成：
所有「非空类」判据全绿，FunASR 反查相似度只有 **0.216**；换成配对的
参考音频+文本后升到 **1.000**）。要判「说对了没有」得另配 ASR 回读比对。

⚠️ **浅层校验会报假绿灯**（[实测] 2026-10-04）：它只查 `python.exe` 文件在不在。
三台 venv 的 `pyvenv.cfg` 指向另一台机器的 uv 基础解释器（那个路径已不存在），
浅层仍报「装了」，而实际 `uv trampoline failed to spawn Python child process`。
⇒ **判「这台引擎能不能跑」只能用 `--deep`。**

### 6 · 装好了，前端自动长出来

**不需要跑任何脚本，不需要改任何代码。** 重启后端即可。

`engines/` 目录即注册（`lib/engines/registry.js`），没有中心清单要维护。
`GET /api/engines` 会把这台引擎完整吐出来，前端按名片长面板：

- 参数面板 ← `parameters[]`（按 `type` / `min` / `max` / `choices` / `only_when`）
- 模型位下拉 ← `weights[]`（几个位长几个下拉）
- `Tune` 页签 ← `capabilities.supports_finetune`（不是 true 就不显示）
- 右上角引擎徽章 ← `capabilities` / 权重状态

判据：**装一台谁都没见过的引擎，`lib/` / `server.js` / `web/` 一个字都不用改。**
`lib/engines/fakeEngine.node.test.js` 用一台参数叫 `wobble` / `flavour` /
`goose_count` 的假引擎守着这条。

## 平台的立场：只验不建

Owner 2026-08-24 拍板：「我只维护 GPT-SoVITS 兼容这一套，其他一概不负责」。

所以 `lib/engines/envCheck.js` 里**没有一行装包/建 venv 的代码**，将来也不该有。
它只回答一个问题：名片说的那个解释器/脚本/模块/类/方法，**在不在**。

不在 = 这台引擎没装。**平台不代劳，也不背书。**

## 写错了会怎样

**当场抛，不静默忽略。** 这是全项目最一致的一条纪律。

| 你写错什么 | 报什么 |
|---|---|
| JSON 语法（逗号漏了） | `ENGINE_MANIFEST_INVALID` |
| 顶层不认识的键 | `ENGINE_MANIFEST_INVALID_VALUE` + 「是不是想写 X？」（编辑距离猜） |
| `call.kind: "cli"` 却填了 `module` | 注册时喊（两种形态各有各的键表） |
| `bind.output_path` 缺了但 `returns: "file"` | `ENGINE_MANIFEST_INCOMPLETE` |
| 参数名同时在 `parameters` 和 `param_keys` | `ENGINE_MANIFEST_INVALID_VALUE`（两份会漂移的事实） |
| `weights[].applies_at: "call"` 却没写 `param` | 报错（下拉能点、请求体里一个键都没有） |
| **两个 launch 位** | ⛔ **第一次合成时**抛 `ENGINE_TOO_MANY_LAUNCH_SLOTS`（今天只能送一个） |
| 参数字段里有引擎不认识的键 | 宿主 400 列出 `unknown parameter(s)` |

⭐ **坏掉的引擎不会静默消失。** 它单独归到 `GET /api/engines` 的 `errors[]`，
前端在导航栏显红「N 张 manifest.json 读不了」并 hover 出每一条原因。
一台引擎少写一个键，**不会**表现为「所有引擎都不见了」。

## ⭐ 平台保证不了的

契约能保证**平台这一侧不会静默出错**，保证不了**你填的语义对不对**。

举例：把 `maps.reference_audio` 映到 `prompt_text` 上，平台不会知道 ——
它只会忠实把你的错误翻译过去。

**「装上了」= 平台这一侧没毛病。≠「你的映射是对的」。**
后者只能靠第三道 A 级真跑一次合成来验（`tools/verify-engine.cjs --level A`）。
⚠️ 而 A 级也只验到「出声」，**验不到「说得对」** —— 那要靠回读比对，见第 5 步。

## 参考

| 你想知道 | 读哪 |
|---|---|
| 每个字段的完整语义 | `engines/indextts2/manifest.json`（真引擎，595 行，每键带 `_comment_*`） |
| 最小可用样例 | `lib/engines/fakeEngine.node.test.js:40`（60 行） |
| 抽象层怎么工作 | `lib/engines/*.js` 的文件头注释（那里是最新的） |
| 进度 / 下一刀 | `docs/ONBOARDING_PLAN.md` |
