# VoxCPM / CosyVoice 接入可行性实测报告

> 实测日期：2026-10-11
> 结论先行：**两台引擎都能接入，卡点不在抽象层，在「向导的自动匹配」层。**

---

## 1. 核心判断：问题出在哪一层

平台分三层：

| 层 | 是什么 | cosyvoice2 / VoxCPM 在这层有问题吗 |
|---|---|---|
| **抽象层** | manifest 结构 + `call.kind=python/cli` + host.py 宿主 | ❌ 没问题 |
| **接入辅助层** | 向导扫描 argparse + 自动填三槽位 | ✅ **问题全在这层** |
| **引擎自身** | 上游用什么形式暴露接口 | ⚠️ 各自有各自的形态，但都能适配 |

**抽象层是好的**：`call.kind=python`（调类）和 `call.kind=cli`（跑命令）两种形态，host.py 都实现。cosyvoice2 用 python 形态、VoxCPM 用 cli 形态，**都能被宿主拉起**。

---

## 2. CosyVoice2：已经接入成功，不是「接不进」

### 实测证据

- 盘上 `engines/cosyvoice2/manifest.json` **存在且完整可用**：
  - `call.kind = python`
  - `module/class = cosyvoice.cli.cosyvoice / CosyVoice2`
  - `bind = {text: "tts_text", ref_audio: "prompt_wav"}`
- `registry` 认它：`cosyvoice-300m-sft, cosyvoice2, gpt-sovits, index-tts, indextts2`
- `validate` 0 error

### 结论

**它已经接入了。** 当年是**手工写名片**（python 形态）接的，没有走 cli 扫描。

### 为什么「新建」时看起来接不进

向导第 4 步的**扫描线只认 argparse CLI**。cosyvoice2 没有 argparse CLI（是 gradio 库 + `webui.py`）：
- 扫描按钮点了 → `cliHelp` 返回 `ok:false, note: "no CLI source"` → 区 3 空、区 1 无候选
- 用户只能**手工填** `call.kind=python / module / class / method / bind`

**不是不能接，是向导不帮忙自动接。** 手工接完全可行（当年就是这么接的）。

---

## 3. VoxCPM：有 argparse CLI，扫描器能抓到，但三槽位自动匹配全挂

### 实测证据（完整链路实测）

| 环节 | 结果 |
|---|---|
| 扫描器找 CLI | ✅ 命中 `src/voxcpm/cli.py`（在候选清单里） |
| 解析 argparse | ✅ 抓到 50 个 flag，help/required/default 全对 |
| 子命令识别 | ✅ 5 个：root/design/clone/batch/validate |
| **三槽位匹配** | ❌ **text / ref_audio / output_path 全部 null** |
| 生成 call 段 | ⚠️ 骨架能出（argv 含子命令），但 bind 全空 |

### 三个具体坑（都能修）

1. **`--reference-audio` 匹配不上**：VoxCPM 的 dest 是 `reference_audio`，我们的候选词表是
   `ref_audio / voice / prompt_wav / ref_wav / spk / speaker`——**漏了 `reference_audio`**。
   一行改动。
2. **子命令参数分组错**：VoxCPM 参数挂 root（`subcommand: null`），design/clone 子命令参数是 0。
   用户得选 `(root)` 子命令才看得到参数。
3. **`--text` 是 root 级**：text/output 都在 root 层，不选 root 看不到。

### 但注意：用户仍然能手工接

区 1 是 combobox（可手输），区 3 参数表能显示 50 个 flag。即使自动匹配全 null，
用户手工绑 `text→--text / ref_audio→--reference-audio / output→--output` 完全可行。

---

## 4. 本质原因：自动匹配靠「猜名字」，猜名字必然有漏网

两台引擎的卡点，根子是同一个：

> **向导的自动匹配 = 用一个写死的候选词表去猜上游 flag 名。**

- 词表里有 `ref_audio`，VoxCPM 叫 `reference_audio` → 漏了
- 词表里有 `voice`，cosyvoice2 叫 `prompt_wav`（这个有）但有的引擎叫别的 → 漏
- **每次接新引擎都可能冒出一个没见过的命名，词表永远补不完**

这正是当初**反射线**想解决的问题：读上游**自己声明的**映射（`infer_kwargs` 赋值、help 里的 "mapped to X"），
而不是平台猜。反射线删除后（上一轮整条删了），这条路没了，只剩猜名字。

---

## 5. 结论

| 引擎 | 能接入吗 | 卡在哪 | 是抽象层问题吗 |
|---|---|---|---|
| cosyvoice2 | ✅ 已接入（手工 python 形态） | 向导扫描线对 python 引擎无辅助 | 否，辅助层缺 python 扫描 |
| VoxCPM | ✅ 能接（手工绑三槽位） | 自动匹配词表漏 reference_audio、子命令分组偏 | 否，辅助层词表不全 |

**抽象层不是问题。** 问题是接入辅助层的两条路都不完整：
- python 引擎的自动辅助（反射线）被删了 → cosyvoice2 只能手工
- cli 引擎的自动匹配靠猜名字 → VoxCPM 词表漏了

---

## 6. 下一步可选方向（供 Owner 决策，未拍板）

1. **补词表**：加 `reference_audio` 等命名 → 治标，一次补一个
2. **恢复「读上游自带映射声明」**：cli 的 `infer_kwargs` / help 里的 "mapped to X"、
   python 的函数签名 → 上游自己说，平台不猜（反射线的初衷）
3. **改区 1 交互**：不自动匹配，让用户从候选列表里选（combobox 已支持）→
   不依赖猜名字，用户多一步确认
