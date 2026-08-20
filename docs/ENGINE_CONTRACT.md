# 引擎契约（Engine Contract）

> 冻结于 r12c。这份文档回答一个问题：**再接一个 TTS 引擎，要动哪些地方。**
>
> 目标（可验收，不是口号）：
>
> > 加一个新引擎 = 新建 `engines\<id>\` 一个目录 + 写一个 `manifest.json`。
> > `lib\`、`server.js`、`web\` 一个字都不用改。
>
> 反面表述同样重要：**如果接第二个引擎时你不得不打开 `lib\` 或 `server.js`，
> 那不是你做错了，是契约漏了一处抽象，应该回来补这份文档。**

---

## §1 为什么会有这份文档

r12c 之前，"GPT-SoVITS" 这个名字散落在项目的十几处：参数白名单硬编码在
`lib\flowgraph\adapter.js`、引擎判断是 `if (engineId !== 'gpt-sovits') throw`、
源码躺在 `vendor\tts\gpt-sovits\` 而 `vendor\` 名义上是"第三方成品"。

结果是：**接第二个引擎需要通读并修改五个互不相邻的地方**，而且没有任何东西
会提醒你漏了哪一个。

r12c 把这些收敛到两处：`engines\<id>\manifest.json`（引擎自己描述自己）和
`lib\engines\registry.js`（按目录发现引擎，不认识任何具体引擎名）。

---

## §2 顶层目录的角色

判据不是"这东西是什么"，而是**"换 TTS 引擎的时候，它跟不跟着换"**。

| 目录 | 判据 | 例子 |
|---|---|---|
| `engines\` | 换引擎时**跟着换**。一个目录一个引擎 | `engines\gpt-sovits\` |
| `pipeline\` | 换引擎时**不换**，但属于第三方代码 | `pipeline\asr\` `pipeline\uvr5\` `pipeline\slicer\` |
| `vendor\` | 第三方**成品**，我们一行没改过 | `vendor\ffmpeg\` `vendor\micromamba\` |
| `models\` | 全部权重。删了能重新下载 | `models\tts\` `models\asr\` |
| `data\` | 用户编辑过的东西。**删了要不回来** | `data\pron_lexicon\zh.json` |
| `lib\` `server.js` `web\` | 我们自己写的。上游根本不知道它存在 | — |

### 三条辅助判据

1. **`LOCAL-CHANGES.md` 在哪，哪就不是 `vendor\`。**
   这个文件是"我们改过上游"的物证。它出现在 `vendor\` 下，说明那棵树需要
   我们维护，该归 `engines\` 或 `pipeline\`。
   *由 `lib\engines\registry.node.test.js` 守卫。*

2. **`engines\` 下的目录数 == 这台机器支持的引擎数。**
   这个数字必须有意义。所以 asr / uvr5 / slicer 这些工具**不能**放进去 ——
   放进去会让"支持几个引擎"变成一个需要人工甄别的问题，也会让加引擎的人
   误以为自己也得弄一个 asr。

3. **`pipeline\` 里的代码不许提到任何具体引擎名。**
   一旦提到了，说明"换引擎时不换"这条判据破了，该重新归类。
   *由守卫测试扫描代码行（注释里说明来历是允许的）。*

### 为什么 asr / uvr5 / slicer 归 `pipeline\` 而不是 `engines\`

因为**训练任何引擎都要用它们**：whisper 打标、uvr5 去伴奏、slicer 切片。
换成 IndexTTS2，这三样一模一样。它们由 `lib\training\steps\*` 和
`lib\routes\*` 直接调用，与引擎选择无关。

---

## §3 加一个引擎，具体做什么

### 第一步：建目录

```
engines\<你的引擎id>\
```

目录名就是引擎 id，必须与 `manifest.json` 里的 `id` 字段**完全一致**
（不一致会抛 `ENGINE_MANIFEST_ID_MISMATCH` —— 否则"按目录找"和"按 id 找"
会得到不同答案，这种不一致极难查）。

抄 `engines\_TEMPLATE\` 起步。`_` 开头的目录**不会**被当成引擎。

### 第二步：写 `manifest.json`

```json
{
  "id": "你的引擎id",
  "label": "界面上显示的名字",
  "default_base_url": "http://127.0.0.1:端口",
  "param_keys": ["...", "..."]
}
```

`_` 开头的键是注释，注册表会剥掉。

#### ⚠ `param_keys` 为什么必须逐个列全

这是白名单，不是黑名单。**不列白名单直接转发参数，参数名拼错时不会报错** ——
服务端默默忽略不认识的键，于是"我明明设了 `temerature`"表现为
"设了但没效果"。这类问题查起来极其痛苦。

宁可多列几个键，也不要放开转发。

### 第三步：放推理代码，写 `LOCAL-CHANGES.md`

改了上游什么，逐条记下来。下次上游升级时，这个文件决定你能不能升。

### 第四步：确认注册表看见了它

没有 `manifest.json` 的目录 = **没装**，而不是"装了一半"。
半接上的引擎必须表现为"没装"，否则会变成"能选中，一调就炸"。

（`engines\indextts2\` 现在就是这个状态：只有 `setup.bat`，没有 manifest，
所以注册表看不见它。这是刻意的。）

---

## §4 契约条款

### C7 — 不许数目录层数

不许用 `os.path.dirname` 连着套若干层来找项目根，也不许用
`path.join(__dirname, '..', '..')` 这类相对跳转定位跨目录资源。
搬一次家就会全错，而且**错得很安静**。

**正确做法**：向上找锚点文件。锚点是 **`server.js`**，不是 `package.json`
—— `node_modules\` 里遍地都是 `package.json`。找不到就显式抛错，别退回猜测。

### C8 — 层级规则

`lib\paths.js` 是**全项目唯一的位置权威**。任何模块要知道某个目录在哪，
一律 `require('lib/paths')` 取常量。

*由 `lib\paths.node.test.js` 守卫，有 EXEMPT 登记清单。*

#### ⚠ C8 的盲区：分段拼接

路径权威守卫和批量字符串替换都只看**字符串字面量**。下面这种写法躲得过去：

把目录名拆成一个个独立的字符串参数传给 `os.path.join` / `path.join`。

源码里根本不存在 `vendor/tts` 这个子串，替换扫不到，于是搬家后它静静地
指向一个空位置。r12c 期间 `lib\inference\infer_server.py`、
`tools\deploy\download_models.py`、`lib\paths.node.test.js` 三处都中过招 ——
其中 `infer_server.py` 那处**不在任何 JS 测试的覆盖面内**，表现为
"测试 407 全绿，但服务起不来"。

*现由 `lib\engines\registry.node.test.js` 的专门断言守卫。*

### C8.1 — 目录名不得携带语义

目录名就是标识符，不许从中解析版本、能力、后端类型。
需要表达什么，写进 `manifest.json`。

### C9 — 错误里要带上下文

要一个没装的引擎，报错必须列出**这台机器上已装的引擎**。
光说 "unsupported engine" 会让排查再花一轮问答。

```
FG_ENGINE_UNSUPPORTED: 这台服务器上没有装引擎 xxx；已装的是：gpt-sovits
```

---

## §5 反向索引：曾经硬编码引擎名的地方

搬家/改造时如果这些地方又出现具体引擎名，说明契约在退化。

| 位置 | r12c 之前 | 现在 |
|---|---|---|
| `lib\flowgraph\adapter.js` | `GPT_SOVITS_KEYS` 常量（34 个参数名） | 从 manifest 读 |
| `lib\flowgraph\adapter.js` | `if (engineId !== 'gpt-sovits') throw` | `registry.requireEngine(id)` |
| `lib\paths.js` | `TTS_VENDOR_DIR` | `ENGINES_DIR` + `GSV_DIR` |
| `tools\run_tests.cjs` | 只扫 `vendor\` | 加扫 `engines\` `pipeline\` |
| `lib\__testsupport__\brokerHarness.js` | 链接清单缺新目录 | 已补 |
| `tools\build\04_pack_release.py` | 分段形式的 `vendor\tts\...` 排除项 | 已更新为 `engines\` |
| `lib\inference\infer_server.py` | 分段形式的 `GSV_DIR` | 已更新为 `engines\` |

### ⚠ 一个必须记住的读数陷阱

r12c 搬家后测试数从 **396 掉到 369**。那不是 27 个测试失败了 ——
是 `tools\run_tests.cjs` 只 `collect(vendor)`，搬到 `engines\`、`pipeline\`
的测试文件**根本没被收集**。

> **先确认 tests 总数，再看 pass/fail 分配。**
> "全部通过"和"根本没运行"在读数上长得一模一样。

同理，守卫测试如果扫描一个不存在的目录（比如助手侧没有 `models\`），
遍历结果为空，断言会"恒真通过"。这种情况必须显式 `skip` 并说明，
让读数如实反映"没测"。

---

## §6 完成判据

1. `node tools\run_tests.cjs` —— tests 总数不降，0 fail
2. `engines\` 下目录数 == 支持的引擎数
3. `lib\engines\registry.js` 里搜不到任何具体引擎名
4. `vendor\` 下搜不到 `LOCAL-CHANGES.md`
5. **真机能起服务、能合成一段音频** —— 测试全绿不等于能出声
