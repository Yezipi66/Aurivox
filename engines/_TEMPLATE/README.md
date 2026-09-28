# 接入一台新 TTS 引擎

> 目标读者：第一次在这个平台上装引擎的人（人或 AI）。
> 进度与欠账看 [`../../docs/ONBOARDING_PLAN.md`](../../docs/ONBOARDING_PLAN.md)。
>
> **一句话**：`engines/<id>/manifest.json` 是唯一权威。平台只验不建 ——
> 它不替你装环境、不替你下模型、不改你上游一行代码。照 `manifest.json` 里的
> 注释填，填完用两条命令自检。

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
`LOCAL-CHANGES.md` 都在里面）。所以**别把底模放这儿** —— 底模归
`models/tts/<引擎id>/`，见下面第 3 步。

## 五步

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

### 2 · 拉源码（可选，但推荐）

```bash
node tools/install-engine.cjs cosyvoice2           # 只打印计划，不动盘
node tools/install-engine.cjs cosyvoice2 --yes     # 真装
```

它按名片里钉的 `upstream.commit` 走 `init → remote → fetch → checkout → drop-git`，
然后跑 `install.env_command` 建环境。

⚠️ 用 `init`+`fetch` 而不是 `git clone`，是因为 `manifest.json` 已经在那个目录里了，
`clone` 拒绝拉进非空目录。

⚠️ `upstream.commit` 是 `null` 时它会拒绝执行并说明原因 —— **这是故意的**。
平台不会替你拉最新版顶上。

### 3 · 下底模

底模放 `models/tts/<引擎id>/`（**不是** `engines/<id>/`）。放哪由你名片的
`runtime.checkpoints` 决定。

平台**不替你下载**，但会把你名片里写的那条命令**填好占位符直接打印给你**：

```bash
node tools/install-engine.cjs cosyvoice2     # 收尾会打印这条
node tools/dev/check-engine-env.cjs --engine cosyvoice2   # 或用这个查
```

想让平台知道「齐了没」，两段都要写：
- `runtime.checkpoints` —— 放哪
- `models.required` —— 哪几个文件算齐

只写前者 ⇒ 平台只能告诉你目录在不在，**说不出齐不齐**（三态里的 `null`）。

### 4 · 自检（三道校验，前两道现成，第三道见下）

```bash
node tools/dev/check-engine-env.cjs --engine cosyvoice2          # 第一道：装没装
node tools/dev/check-engine-env.cjs --engine cosyvoice2 --deep   # 第二道：起得来
```

- **第一道（浅层）**：纯查盘，几毫秒。解释器在不在、入口在不在、`verify.sys_path` 在不在。
- **第二道（深层）**：拿**你这台引擎的解释器**去 import 名片点名的模块/类/方法。
  慢（几十秒，IndexTTS2 实测 34s），只在装完/排障/CI 时跑，**绝不挂在每次合成上**。

⚠️ 两道是**两根轴**，不是一根：`ok` = 装没装，`assets` = 权重在不在。
「环境装好了、权重还没下」是完全正常的中间状态。

⚠️ **第三道「出得了声」（真跑一次合成）今天还没有** —— 这是台账上唯一的关键路径
欠账。意思是：前两道过了，你**仍然**只能靠手动试一次来确认它真能出声。

### 5 · 装好了，前端自动长出来

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
后者只能靠第一道真跑一次合成来验（而那道今天还没有，见第 4 步）。

## 参考

| 你想知道 | 读哪 |
|---|---|
| 每个字段的完整语义 | `engines/indextts2/manifest.json`（真引擎，595 行，每键带 `_comment_*`） |
| 最小可用样例 | `lib/engines/fakeEngine.node.test.js:40`（60 行） |
| 抽象层怎么工作 | `lib/engines/*.js` 的文件头注释（那里是最新的） |
| 进度 / 下一刀 | `docs/ONBOARDING_PLAN.md` |
