# 第 4 步三区重排实现计划

> 依据：`docs/step4-three-zones-mockup.html`（已确认的三区视觉稿）+ 真实结构核对。
> 目标：把 `ManifestForm.jsx` 的「平铺分组 + 混排编辑器」改成三区结构，让用户一眼分清：
> 区 1 平台需要的输入（需确认）、区 2 平台已定义语义的字段（缺失会阻止加载）、区 3 引擎其余参数（原样透传）。

---

## 0. 真实结构核对（实现前先对齐，不做无法兑现的承诺）

| 概念 | 视觉稿里的说法 | 真实结构 | 影响 |
|---|---|---|---|
| 三槽位 | `text / reference_audio / output_path` | `call.bind.text` / `call.bind.ref_audio` / `call.bind.output_path`（indextts2 实测） | 徽标文字用真实键名 |
| 平台词 vs 绑定槽位 | 混用 | `CORE_KEYS = text/text_lang/reference_audio/...`（payload.js:48）是平台词；`call.bind` 是槽位名（text/ref_audio/output_path） | 区 1 标签用平台词，徽标标槽位 |
| 区 3 按子命令分组 | synth/infer/batch 按钮 | `scan.args[].subcommand`（cliDraft.js:45 `'(root)'` 兜底） | 数据已有，直接分组 |
| 官方说明 | 表格列 | `scan.args[].help`（cli_help_extract.py 抓 `help=` 原话） | 原样显示，不翻译 |
| 扫描只认 argparse | 区 3 可能为空 | cliHelp.js:262 `ok:false, note:'no CLI source'` | 空态如实显示，不假装 |
| python 引擎 | 区 3 空 | cosyvoice2 无 argparse | 区 3 对 python 引擎不显示/显示空态 |

**结论**：视觉稿的三区结构数据都撑得住。`scan.args` 有 subcommand 和 help，`call.bind` 有真实槽位名。

---

## 1. 文件改动清单

### 1.1 新建 `tools/engine-wizard/editor/CliGenPanel.jsx`

把 `ManifestForm.jsx` 里的 `CliGenPanel` 整体拆出（约 300-545 行），只负责：
- 选引擎（读取 / 新建 两入口）
- 扫描（定高、子命令选择）
- 触发 `autoFill` 并把**扫描结果 + 匹配状态**交给主组件

**为什么拆**：`ManifestForm` 现在 778 行，`CliGenPanel` 占 250 行且状态独立（mode/busy/scan/subcmd），混在一个文件里，区 1/区 3 的渲染逻辑没有归属。拆开后：
- `CliGenPanel` = 扫描入口
- `ManifestForm` = 三区布局 + 数据流

**关键改动**：`autoFill` 从闭包改成纯函数，返回 `{ call, diff }` 而不是直接 `onChange(next)`：
```js
// 现在（闭包陷阱）：autoFill 读闭包里的 manifest.call，scan 是旧值
const autoFill = (j, sub) => { ... onChange(next) }

// 改成：纯函数，入参显式，返回建议值 + 匹配记录
function computeAutoFill (scanArgs, sub, currentCall) {
  // 返回 { call: {...建议的 call 段}, matched: {text: '--text', ref_audio: null, output_path: '--output_path'}, args: [...], unmatched: [...] }
}
```
主组件拿到 `matched`，区 1 才能渲染"扫描已匹配 / 未匹配需指定"。

### 1.2 重写 `ManifestForm.jsx` 主 render（三区）

```
L1 核心映射区（常驻展开）
  ├─ CliGenPanel（扫描入口）
  └─ call.bind 三槽位编辑器（combobox）
      · 扫描猜中 → 绿框 + 「扫描已匹配」徽标 + 值已写
      · 没猜中   → 黄框 + 「未匹配，需指定」徽标 + 候选 datalist，确认后写

L2 平台已知区（必填 8 项常驻 + 其余折叠）
  ├─ RequiredEight（现有组件，标题文案去重）
  ├─ runtime 全量编辑器（折叠）
  ├─ models 全量编辑器（折叠）
  └─ fieldmeta 平铺字段（折叠）
      · SILENT → 黄框（msg-warn），INFO → 灰字（field-hint），BLOCK → 红框（msg-danger）

L3 引擎透传区（折叠，仅 cli 引擎显示）
  ├─ 子命令分组按钮（synth / infer / batch…，来自 scan.subcommands）
  └─ 参数表（flag / 类型 / 必填 / 官方说明）
      · 必填列显示「必填」（红字）或留空
      · 官方说明 = scan.args[].help 原样显示
      · 无 argparse → 空态说明，不假装
```

### 1.3 `RequiredEight.jsx` 文案去重

- 保留标题 `必填字段（8 项）`
- 删除正文「以下是平台必填的 8 项，缺一项名片就装不上」——标题已说清

### 1.4 `NestedSections.jsx` 警告三色统一

`WARN_BOX` 字典（:34）和 `Field` 组件（ManifestForm :106）的分色逻辑不一致：
- `WARN_BOX`：block→msg-danger / silent→field-hint / info→field-hint（**silent 和 info 一样灰**）
- `Field`：block→msg-danger / silent→msg-warn / info→field-hint（对）

**统一成 Field 的逻辑**：silent 用 `msg-warn`（黄框），info 用 `field-hint`（灰字）。注意——这与用户上一轮的"字号突兀"诉求冲突过，当时的解法是 silent 用 field-hint + 左边框。**实现时按视觉稿：SILENT 黄框（区别于 INFO），但字号与其他说明一致**。这个细节实现时对照 styles.css 确定具体类组合。

### 1.5 顺手修的外援点名 bug（P0 级）

| bug | 位置 | 修法 |
|---|---|---|
| Req 列永远空 | ManifestForm :523 `{a.required ? '' : ''}` | 改成 `{a.required ? '必填' : ''}` |
| autoFill 闭包陷阱 | :471 切子命令时 scan 旧值 | 随 1.1 的纯函数一起解决 |
| SaveBar confirmOverwrite 死锁 | SaveBar.jsx :107 点取消仍显示覆盖 | `confirmOverwrite` 三态（null/true/false） |
| i18n 模板字符串 | `t(\`${n} auto-filled\`)` | 拆成 `t('N auto-filled')` + 数字拼接 |

---

## 2. 执行顺序

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | `computeAutoFill` 纯函数 + `CliGenPanel.jsx` 拆文件 | 无 |
| 2 | 区 1 核心映射（combobox + 匹配状态） | 步骤 1 |
| 3 | 区 2 平台已知（RequiredEight 文案去重 + 警告三色统一） | 无 |
| 4 | 区 3 引擎透传（子命令分组 + 必填列 + 空态） | 步骤 1 |
| 5 | 修 4 个外援 bug | 无 |
| 6 | 独立验收（新流程：实现 → 独立验收 → 修正计划 → 提交推送） | 全部 |

---

## 3. 验收点

1. 一进第 4 步：扫描入口 + 区 1 三槽位 + 区 2 必填 8 项，**三个区标题清晰，用户一眼知道该在哪确认**
2. 扫描猜中的槽位绿框 + 徽标，没猜中的黄框 + 候选下拉
3. SILENT 黄框 ≠ INFO 灰字（三色分明）
4. 区 3 按子命令分组，必填列显示"必填"，官方说明原样
5. 无 argparse 引擎（如 cosyvoice2 的 cli 路径）区 3 如实空态
6. `npm test` 无新增失败（对比基线）
7. 全文案无"上游"、无破折号、无 emoji、无口语
8. 4 个外援 bug 修复验证

---

## 4. 不做（明确排除）

- 不改平台契约（maps / call.bind / call.args 结构不动）
- 不做 python 引擎的区 3（函数签名参数区）——那是另一条线，本次只做 cli
- 不改 5 步向导的其它 4 步
- 不重写 SaveBar 布局（sticky 现状保留，只修死锁）
