# Python 引擎参数自动发现 —— 实现计划

> 目标：Python 库类引擎（CosyVoice2 这类，`call.kind = "python"`）获得与 cli 引擎**趋于一致**的接入体验。
> 现状：cli 路线（扫 argparse）是唯一自动路线；Python 路线的反射器还在但 UI 入口被删，用户只能手填 call 段。

---

## 0. 两条路的现状对照（已查证）

| 维度 | cli 路线 | python 路线 |
|---|---|---|
| 扫描对象 | 上游源码的 `add_argument` | 引擎类 `__init__` + 目标方法签名 |
| 扫描方式 | Python `ast` 读 `.py` 文本 | 在引擎 venv 里 `import` 后 `inspect` |
| 拿得到 | flag / help 原话 / required / action / 子命令 | 参数名 / 默认值 / 类型 / 加载期vs调用期 |
| 拿不到 | 类型细节 | **官方说明（不读 docstring）** |
| 输出形状 | `{name, flag, style, help, required, is_tool, subcommand}` | `{name, phase, required, default, kind, annotation, name_hint, upstream_choices}` |
| 分组维度 | **子命令**（synth/infer/batch） | **加载期 / 调用期**（load / call） |
| UI 入口 | CliGenPanel（三区） | **无（已删）** |

**核心差异两条**：
1. python 路**没有官方说明**（不读 docstring）→ 计划第 1 步补
2. 两条路**分组维度不同**（子命令 vs 加载期）→ 计划第 2 步统一

---

## 1. 后端：反射器补 docstring（能拿多少拿多少）

**改 `lib/engines/reflect_params.py`**：

- 对每个参数，从三处按优先级取说明：
  1. `inspect.getdoc(fn)` 里的 `Args:` / `Parameters:` 段（numpy / Google 风格），按参数名匹配
  2. 参数所在函数的 docstring 中 `:param name:` 段（Sphinx 风格）
  3. 取不到 → `help: null`（**如实留空，不编**）
- 每个参数条目加 `help` 字段（与 cli 路的 `help` 同名同义）
- ⛔ 纪律：docstring 原文递出，不翻译、不改写、不缩写（与 cli 路 `help` 一致）

**产出形状**（对齐 cli 路）：
```json
{"name": "spk_id", "phase": "call", "required": false,
 "default": null, "kind": {...}, "help": "Speaker id ...", "annotation": {...}}
```

**验收**：CosyVoice2 的 `inference_sft` 方法参数带 `help`（有 docstring 的）；没有 docstring 的参数 `help: null`。

---

## 2. 后端：两条路统一成一份「参数清单」形状

**新建 `tools/engine-wizard/core/paramDigest.js`**（统一层，两条路都喂它）：

```
输入：cli 路 {name, flag, style, help, required, is_tool, subcommand}
      或 python 路 {name, phase, required, default, kind, help, annotation}
输出：统一形状 {
  source: 'cli' | 'python',
  name,                    // 参数名
  target,                  // cli: flag；python: 参数名
  kind,                    // 值类型：str/number/boolean/array/unknown
  help,                    // 官方说明，可为 null
  required,                // 必填
  group,                   // 分组键（见下）
  is_tool,                 // 装引擎时定一次，不是每次合成要配的
}
```

**分组统一**：
- cli 路 `group = subcommand`（synth / infer / batch / (root)）
- python 路 `group = phase`（load / call）
- 两条路各自用**自己的天然分组**，但都映射到同一个 `group` 字段 → UI 一视同仁

**⛔ 纪律**：这一层**只对齐形状，不做任何判断**（不猜类型、不改 help、不删参数）。

---

## 3. 前端：三区 UI 复用（两条路同一套）

复用已定稿的三区视觉稿 `docs/step4-three-zones-mockup.html`：

| 区 | cli 引擎内容 | python 引擎内容 |
|---|---|---|
| **区 1 核心映射** | `call.bind` 三槽位 → 上游 `--flag` | `call.bind` 三槽位 → 上游参数名 |
| **区 2 平台已知** | 真·必填 8 项 + fieldmeta 字段 | **相同**（runtime/models 与引擎形态无关） |
| **区 3 引擎透传** | `call.args` 按**子命令**分组 | `call.args` 按**加载期/调用期**分组 |

**区 1 的差异处理**：
- cli：扫描器按 flag 名猜（`--text`/`--voice`/`--output`）
- python：按参数名猜（`tts_text`/`prompt_wav`/`output_path`）+ `name_hint` 线索
- 两者都是**猜中高亮 / 未中黄框让用户选**，控件都是 combobox

**区 3 的差异处理**：
- cli：子命令按钮切换（synth / infer / batch）
- python：加载期/调用期按钮切换（load / call）
- 两者都是**按 group 分组的参数表**，列：参数 / 类型 / 必填 / 官方说明

---

## 4. 前端：入口合并（一个入口，两条路自动分流）

**问题**：现在 `CliGenPanel` 只服务 cli。Python 引擎进去扫不出东西。

**改法**：扫描入口根据引擎类型自动分流——
- 用户选引擎 → 后端判断该引擎的形态（有没有 argparse CLI / 是不是 class）
- 有 argparse → 走 cli 扫描
- 是 class → 走反射
- 两者都有 → **都跑**，结果合并（cli 的 flag + 反射的参数，按 `paramDigest` 对齐）
- 都没有 → 如实说"未能发现参数，请手工填写"

**新建端点**：`POST /wizard/discover { id }` → 自动判断形态，返回统一形状的参数清单。

**⛔ 纪律**：平台不假设引擎形态，**先探测再决定**；探不到如实报，不假装。

---

## 5. 后端：反射走 venv（第 2 步已配好）

- 反射器在**引擎自己的 venv** 里跑（`runtime.python`，第 2 步配好的）
- 复用现有 `reflectAndBuild`（`paramsFromReflect.js`）——它已在调用反射器
- 只需把它的输出接进 `paramDigest.js`

**⛔ 边界**：
- venv 没配好 → 反射失败，如实报"引擎环境未就绪，先完成第 2 步"
- 引擎是 dict/函数分发（不是 class）→ 宿主本来就不支持，如实说"该引擎形态不受支持，请走 cli"

---

## 6. 执行顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P1** | 反射器补 docstring（第 1 步） | 无 |
| **P2** | `paramDigest.js` 统一层 + `/wizard/discover` 端点（第 2、5 步） | P1 |
| **P3** | 前端三区复用 + 入口分流（第 3、4 步） | P2 |
| **P4** | 端到端：CosyVoice2（python）+ IndexTTS2（cli）两条路各跑一遍 | P3 |

---

## 7. 验收

1. **CosyVoice2**（python 路）：选引擎 → 自动反射出 `__init__` + `inference_sft` 的参数 → 区 1 三槽位自动匹配（tts_text/prompt_wav）→ 区 3 按加载期/调用期分组 → docstring 有的参数显示官方说明
2. **IndexTTS2**（cli 路）：行为与现在一致（回归不许有）
3. **两条路体验一致**：同样的三区、同样的控件、同样的"猜中高亮/未中黄框"、同样的参数表列
4. **探不到时**：如实报，不假装（dict 引擎 / venv 没配好 / 无 docstring）
5. `npm test` 无新增失败；无引擎名泄漏；无 emoji/破折号（守卫守着）

---

## 8. 不做（明确排除）

- 不恢复旧的 ReflectPanel（重新设计，不是回滚）
- 不做 dict/函数分发引擎（宿主不支持，走 cli）
- 不猜参数类型（拿默认值 + 注解 + 名字线索，最终人定）
- 不改平台契约（`call.bind` / `call.args` / `payload_keys` 结构不动）
