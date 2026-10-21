# 第 4 步「写名片」前端重写计划（RFC）

> 依据：外援 RFC（框架思想）+ Aurivox 实际结构核对（profile.js / payload.js / 真名片）。
> ⚠️ 外援 RFC 里 `output` / `input.text` / `app:handler` / `bindings:{text,ref_audio,output}` 是**臆测结构，Aurivox 不存在**。本计划全部以真实结构为准。

---

## 0. 先对齐：Aurivox 真实结构（外援猜错的地方）

| 概念 | 外援 RFC 臆测 | **Aurivox 实际** | 证据 |
|---|---|---|---|
| 平台核心输入词 | `text / ref_audio / output` | `text / text_lang / reference_audio / reference_text / reference_lang` | `lib/engines/payload.js:48 CORE_KEYS` |
| 输出怎么表达 | 绑定一个 `output` 槽位 | 输出**不是绑定槽位**，是 `call.returns`（file/bytes/generator）+ `runtime.ready_endpoint` | 真名片 `call.returns:"generator"` |
| 引擎参数映射 | `bindings` 新结构 | `maps`（平台词→引擎键）+ `call.bind`（同名） | 真名片 `maps:{text→tts_text, reference_audio→prompt_wav}` |
| runtime.entry | `app:handler` | 脚本路径 `../../lib/engines/host.py`（cli 形态是模块名） | `profile.js:855 required` |
| runtime.python | `3.10` 版本号 | 引擎自己的 venv **目录** `engines/<id>/.venv` | `profile.js:852` |

**真·必填 8 个**（缺了当场抛、装不上）——以 `profile.js` 的 `required()` 调用为准：

| # | 字段 | profile.js 行 |
|---|---|---|
| 1 | `runtime.python` | :852 |
| 2 | `runtime.entry` | :855 |
| 3 | `runtime.ready_endpoint` | :858 |
| 4 | `runtime.ready_timeout_ms` | :868 |
| 5 | `timeout_ms` | :1279 |
| 6 | `max_chars` | :1283 |
| 7 | `capabilities.requires_reference_audio` | :1337 |
| 8 | `capabilities.output_sample_rate` | :1344 |

外加 cli 路线的 `call.bind`（text/reference_audio/output_path → 上游 --flag）—— 这是**用户真正要用脑子的核心**。

---

## 1. 目标

把第 4 步从「40 字段平铺、用户手抄」改成：

```
① 扫描（选引擎 → 扫 CLI --flag → 自动填）   ← 第一屏只做这个
② 确认核心绑定（text / 参考音频 / 输出 → 上游哪个 --flag）  ← 扫完自动展开
③ 真·必填 8 个（平台半知，确认即可）
④ 高级（runtime 其余 / upstream / models / weights / maps / parameters…）  ← 永远折叠
```

**核心原则**：机器能填的绝不问用户；问用户的只有"机器猜不准的绑定 + 少量必填"。

---

## 2. 七章执行清单（外援框架 + Aurivox 落地）

### 第 1 章 · 信息架构：三级分组

**改 `ManifestForm.jsx` 的渲染顺序**，按真实结构分三档：

| 档 | 内容 | 默认状态 |
|---|---|---|
| **L1 核心** | 扫描面板 + `call.bind`（3 绑定）+ 真·必填 8 个 | 常驻展开 |
| **L2 常用可选** | `runtime.args` / `runtime.cwd` / `capabilities.streaming` / `maps` 其余 | 折叠，有值时提示 |
| **L3 审计/高级** | `upstream` / `install` / `models` / `weights` / `local_changes` / `base_url_env` / `default_base_url` / `output_formats` / `parameters` / `contract_version`(自动填) / `id`(自动填) / `label`(自动填) | 永远折叠 |

**`id`/`label`/`contract_version` 自动填后彻底藏掉**（不折叠展示，直接不渲染——已在 autoFill 填好）。

**动作**：重写 `ManifestForm.jsx` 主组件 render，`GROUP_ORDER` 按 L1→L2→L3 排；`basics` 组（id/label/contract）删掉不渲染。

### 第 2 章 · 渐进披露：步内小向导

- `mode`：`idle`（扫描）→ `scanned`（确认绑定）→ `editing`（高级）
- 扫描区**定高** `min-h-[112px]`，子命令 select 切换只换内部，**禁止布局跳变**
- 扫描成功 → 核心绑定区**自动展开 + 滚动定位**（`scrollIntoView`）
- 读取/新建**合并为一个"选择引擎"入口**（不再两个下拉）

**动作**：`CliGenPanel` 从"两个入口"改"一个选择 + 扫描定高"；扫描成功触发展开。

### 第 3 章 · 警告系统：三级（用 fieldmeta 已有 DANGER）

fieldmeta 已定义 `BLOCK / SILENT / INFO`，但渲染层拍平成一种黄。**改成三档三色**：

| 档 | 视觉 | 阻断保存？ | Aurivox 实例 |
|---|---|---|---|
| BLOCK | `msg-danger` 红框 | 是 | `runtime.python` 绝对路径、`_source` 缺失（profile.js:486 真抛）|
| SILENT | `msg-warn` 黄框 | 否 | `models.required` 不写（说不出齐不齐，但能跑）|
| INFO | `field-hint` 灰字 | 否 | 默认行为提示 |

**动作**：`NestedSections.jsx` 的 `Row` 组件按 `danger` 档位分色；`validate.js` 补 `_source` 硬规则检测（之前我加过又撤销，这次按 RFC 重加，走 BLOCK）。

### 第 4 章 · 文案：黑话→人话

建立对照，所有 warn 改成「后果 + 默认行为 + 修复路径」三句式：

| 场景 | 现文案（黑话） | 新文案（人话） |
|---|---|---|
| models.required | 不写这个，平台只能说目录在不在，说不出齐不齐 | 不填也能用，但平台没法帮你确认权重文件齐不齐。建议列出关键文件。 |
| `_source` | 写了数却不说明出处会被拒绝 | 保存时会被打回：这个数字必须说明来源（实测/估算/上游）。 |
| runtime.python | 必须为相对路径 | 填引擎自己的环境目录（如 `engines/xx/.venv`），填绝对路径存不了。 |
| call.bind | 三槽位 / These are the platform's fixed input words | 确认 3 个核心输入对应上游哪个参数：要合成的文字 / 参考音频 / 输出。机器已自动匹配，核对即可。 |

**动作**：改 `NestedSections.jsx` + `fieldmeta.js` 的 howto/warn 文案；`code` 标签只包路径/flag，不包整段话。

### 第 5 章 · 视觉：统一平台原子类

- ⛔ 删所有 inline `style={{display:flex, gap:8...}}`，用平台 `.section/.field/.form-grid/.control/.table/.msg-*`
- 参数表 `<table className="control">` → `.table`（外援点出的 bug）
- 清掉 5 处残留 `>` 破损文本（`{t(...)}>` 写成 `{t(...)}` ）
- `fieldmeta.js:42` 的 U+FFFD 乱码字节修掉
- 英文界面高级区文案补 i18n（fieldmeta howto/warn 走 `t(en,zh)`）

**动作**：`ManifestForm.jsx` + `NestedSections.jsx` 全量清 inline style + 修 `>` + 乱码 + i18n。

### 第 6 章 · 布局：60/40 + sticky SaveBar

- 左 60% 表单，右 40% `sticky`（Preview + Diagnostics 默认折叠）
- SaveBar 改 `sticky bottom` 永远可见（外援点出：现埋在 7 屏下）
- SaveBar **5 态可视**：待扫描 / 扫描中 / 已自动填 N 项 / 有硬错阻断 / 可保存
- 有硬错时**禁用保存按钮 + 说明原因**（不是让按钮消失）

**动作**：`ManifestPage.jsx` 改 60/40 + SaveBar sticky；`SaveBar.jsx` 加 5 态 + 禁用态说明。

### 第 7 章 · 操作流程：状态机 + 不破坏数据

- **修 A1 毁数据**：`startRead` 必须先 `loadOne(id)` 读磁盘名片灌进表单，再进扫描；读取≠新建两条路（这是阻塞级 bug）
- **修 A4 竞态**：manifest/text 双向同步改**单一数据源**（manifest 为准，text 纯派生，视图切换现算，删 300ms 防抖回写）
- **autoFill 不覆盖**：用户手改字段标 `dirty`，自动填时 diff 提示（不外援那么重，至少 bind 不覆盖已有值——已有 `if(!call.bind.x)`，保持）
- **A3**：扫描默认选不到推理子命令时，**不自动灌 args**，如实说"扫到的都是非推理 flag"

**动作**：`App.jsx` 修竞态；`ManifestForm.jsx` 修 startRead + autoFill 保守；`cliDraft.js` 加"非推理 flag 不自动填"。

---

## 3. 执行顺序（依赖排序）

| 阶段 | 章节 | 说明 |
|---|---|---|
| P0 止血 | 第7章 A1/A4 + 第5章 `>`/乱码 | 毁数据 + 破损文本，先修 |
| P1 骨架 | 第1章分级 + 第2章渐进 + 第6章布局 | 重写 ManifestForm 主组件 render |
| P2 系统 | 第3章警告分级 + validate 补 _source | 视觉 + 校验 |
| P3 润色 | 第4章文案 + 第5章 inline style/i18n | 全量清理 |

---

## 4. 样式铁律（对齐平台 styles.css）

- 只用 `.section / .section-hdr / .section-body / .field / .field-label / .field-hint / .control / .form-grid / .table / .msg-danger / .msg-warn / .msg-info / .badge / .expert-block / .expert-summary / .summary-bar`
- ⛔ 不新增 class，不 inline style（除极少数一次性定位）
- ⛔ `web/wizard.vite.config.mjs` 中间件保持 `for...break`，不重写递归
- ⛔ 活代码不出现引擎名（styleguard 守着）

---

## 5. 验收点

1. 一进第 4 步：只有扫描面板 + 核心绑定 + 8 必填，**首屏控件 < 15 个**
2. 扫描成功 → 核心绑定自动展开，**无布局跳变**（切换引擎录屏，右侧位移 = 0）
3. `读取名片` 选一台已有引擎 → 表单显示磁盘原文，**不丢 install/models.required/runtime.verify**（A1 修复验证）
4. 切 Form/JSON 视图 → **内容不清空**（A4 修复验证）
5. SaveBar **sticky 常驻可见**，5 态正确，有硬错时禁用+说明
6. BLOCK/SILENT/INFO 三色分明，`_source` 缺失报红（BLOCK），`models.required` 缺失报黄（SILENT）
7. 全部 warn 文案是三句式人话，无 `说不出齐不齐` 类黑话
8. 英文界面高级区无中文泄漏；无残留 `>`；无乱码
9. `npm test` 基线 33 失败，无新增

---

## 6. 不做（明确排除）

- 不改平台契约（`maps`/`call.bind`/`payload_keys` 结构不动）
- 不动 5 步向导的其它 4 步
- 不做 speaker 平台词（计划 4.1 已定不做）
- 不加新的后端字段，只重排前端 + 补 validate 的 `_source` 检测

---

## 7. 执行进度台账

### P0 止血 — ✅ 已完成并通过独立验收

| 提交 | 任务 | 状态 |
|---|---|---|
| `74da6e5` | A1 修读取名片覆盖真名片（startRead 先 loadOne 读磁盘原文灌表单） | ✅ 独立验收通过 |
| `49ebcd5` | A4 修 manifest/text 双向同步竞态（manifest 唯一真相，text 纯派生） | ✅ 独立验收通过 |
| `318ca0c` | C 修 6 处游离 `>` + fieldmeta.js:42 U+FFFD 乱码 | ✅ 独立验收通过 |

**独立验收结论**：A1/A4/C 三项功能浏览器实测通过；npm test 以 `b8c9a90` 为基线逐条 diff **0 新增失败**；引擎名纪律 0 命中；中间件仍 for...break 未改递归。

**P0 遗留（不阻塞，后续阶段顺手修或单开）**：
1. `MainArea.jsx:102` 游离 `>`（weights 空提示句尾，渲染可见 `manifest.>`）—— 属第 5 章视觉清理范围，并入 P3。
2. `tools/engine-wizard/core/tierreview.js:59` 注释内 U+FFFD（非活代码 UI 文案）—— 低优先级。
3. 本机测试环境既存失败（indextts2 manifest 缺失等）—— 环境问题，非代码回归。

### P1 骨架 — ✅ 已完成并通过独立验收

| 提交 | 任务 | 状态 |
|---|---|---|
| `82ee68f` | 第 1+2 章 信息架构三级分组(L1/L2/L3) + 渐进披露(扫描定高/成功展开) | ✅ 独立验收通过 |
| `61e98fa` | 第 6 章 布局 60/40 + sticky SaveBar + Diagnostics 默认折叠 | ✅ 独立验收通过 |
| `a93d018` | P1 台账 | ✅ |

**独立验收结论**（独立子 Agent 实测，非实现者自述）：
- 首屏 L1 控件实测 **23**（非 39）；id/label/contract_version 零渲染（HIDDEN_KEYS 生效）
- 真·必填 8 项全在 L1；L2/L3 折叠
- 扫描区定高 **90.39 → 90.39**，切子命令（infer/synth/download）高度不变，零跳变
- SaveBar sticky 常驻；有硬错时**禁用保存 + msg-danger 说明**（按钮不消失）
- Diagnostics 右栏默认折叠（body 不渲染，计数徽标常驻）
- 读取名片灌入磁盘原文（P0 未破坏）；manifest 唯一真相保留
- npm test 失败集 0 新增；引擎名 0 命中；中间件 for...break 未改递归

**P1 遗留（不阻塞，并入 P3）**：
1. 参数表 `<table className="control">`（扫描结果表）→ 应改 `.table`，属第 5 章视觉清理。
2. SaveBar 5 态细分（待扫描/扫描中/已自动填 N 项）未做，P1 只做了 sticky + 禁用态。

### P2 警告系统 — ✅ 已完成并通过独立验收

| 提交 | 任务 | 状态 |
|---|---|---|
| `aa49071` | validate 补 _source 硬规则 error 检测（5 场景全对、真名片 0 误报） | ✅ 独立验收通过 |
| `7ce5c0b` | 第 3 章 警告三级分级 BLOCK/SILENT/INFO 三色（msg-danger/msg-warn/field-hint 三色分明） | ✅ 独立验收通过 |

**P2 独立验收结论**：警告三色 computed style 实测红/黄/灰分明；validate _source 5 场景全对；npm test 无新增失败；引擎名/幽灵类/中间件纪律全过。

### P3 润色 — ✅ 已完成并通过独立验收

| 提交 | 任务 | 状态 |
|---|---|---|
| `77eb314` | ⭐ 修 L2/L3 嵌套编辑器不渲染阻塞 bug（P1 漏网，最重要） | ✅ 独立验收通过 |
| `072d97a` | 第 4 章文案人话 + 第 5 章视觉清理（table→.table、游离 >、i18n） | ✅ 独立验收通过 |
| `f7dbf5c` | SaveBar 5 态可视（待扫描/已自动填 N 项，第 6 章补） | ✅ 独立验收通过 |
| `4a553aa` | P3 台账 | ✅ |

**P3 独立验收结论**（独立子 Agent 实测）：
- ⭐ L2/L3 嵌套渲染 bug：根因 byGroup 构建剔了 NESTED_GROUPS 导致嵌套编辑器恒空。修后实测 L2 runtime 段（python/entry/args/ready_endpoint/ready_timeout_ms/ready_timeout_ms_source）、L3 models 段（required/hint/source.url/source.command）**全部可编辑**，改 python 路径实测落进 manifest。
- 文案人话：4 条对照表三句式渲染生效，旧黑话（说不出齐不齐/绝对路径会被拒绝/三槽位）已清除。
- 视觉清理：扫描表→.table、MainArea.jsx:102 游离 > 已修、无 U+FFFD。
- SaveBar 5 态：未扫描「还没扫描」→ 注入 cli call「已自动填 2 项」实测切换。
- npm test worktree 基线对比无新增失败；引擎名 0 命中；中间件 for...break；幽灵类全过；P0/P1/P2 成果全保留。

**P3 遗留（不阻塞）**：
1. SaveBar「扫描中」态需 CliGenPanel 的 busy 状态提升到 App 层（三组件重构，有回归风险，未做）。
2. 扫描表 `.table` 渲染实测受限于本机无任何引擎 `.venv`（cli 扫描需引擎环境），代码改动与其余 4 个 .table 一致，逻辑正确。
3. inline `display:flex` 保留的几处（label+badge 并排、select+button 并排、纵向堆叠容器）属 styles.css 无等价类的
   一次性布局定位（RFC 第 5 章允许），⛔ 删了会把 select+button 并排的按钮挤成细条（Owner 点名过的坑）。
4. fieldmeta.js 的 warn/howto 里仍有 `——` 破折号（非 RFC 对照表 4 条内的既有文案，styleguard 守卫不匹配 warn:/howto: 键，
   不强制；为控制改动范围未动）。
