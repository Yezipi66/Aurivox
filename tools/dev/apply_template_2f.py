#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 2f 的文档改动打到真机上 —— 按锚点改，不整文件覆盖。

⛔⛔ 为什么不给整文件：助手的沙箱树停在 2026-08-23，而真机 HEAD 比它多 7 笔，
   其中 fe59bea 给 docs/ENGINE_CONTRACT.md 加了 196 行、给
   engines/_TEMPLATE/README.md 加了 69 行。整文件覆盖过去，那两笔会**静默消失**
   —— 测试全绿、git 只报「M」，谁都看不出少了什么。

所以这里逐处按锚点插入：
  · 锚点找不到 / 找到多个  ⇒ 一处都不写，非零退出，并说清是哪一处
  · 改动已经在文件里       ⇒ 跳过并报告（可重复运行，不会插两遍）

manifest.json 不在这里 —— 那是整文件替换，它的基线单独核 sha256。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONTRACT = os.path.join(ROOT, "docs", "ENGINE_CONTRACT.md")
README = os.path.join(ROOT, "engines", "_TEMPLATE", "README.md")

# --- 要插入的内容 -----------------------------------------------------------

REV_ROWS = (
    "| 2026-08-25 | 2（修订 2） | **【待建】的名片字段一律不再出现在 "
    "`engines\\_TEMPLATE\\manifest.json` 里**，只留在本文档。条款一个字没改 | "
    "⛔ 实测（`tools\\dev\\measure_manifest_reads.cjs`）：模板 45 个键里平台只读 23 个。"
    "`call`（11 键）、`smoke`（6 键）、`params.load_time/call_time` 全部**读取 0 次**。"
    "模板同时摆着 `call` 和 `runtime.entry` 两条路，作者当然选看起来更省事的 `call` "
    "—— 填完什么都不发生，也不报错。**模板的职责是\"照抄能跑\"，不是\"了解规划\"** |\n"
    "| 2026-08-25 | 2（修订 2） | §7 补记：模板里那行写成了 `_escape_hatch`，"
    "**与本节的 `escape_hatch` 不一致**，且下划线写法结构上永不生效 | 见 §7 末尾 |"
)

S5_NOTE = """> ⚠ **2026-08-25：本节描述的 `call` 一节，已从 `engines\\_TEMPLATE\\manifest.json` 里移除。**
> 它今天**没有任何代码读它**（实测：`tools\\dev\\measure_manifest_reads.cjs`，读取 0 次）。
> 今天真正管用的是 `runtime.entry` —— 引擎自带一个 `shim.py`，平台去跑它。
> 两条路同时摆在模板里，作者会选看起来更省事的那条，然后发现什么都不发生。
> **条款没有作废**，等通用宿主落地、本节改成【现状】那天，`call` 再回到模板里。
"""

S6_NOTE = """> ⚠ **2026-08-25：本节的 `smoke` 一节，已从 `engines\\_TEMPLATE\\manifest.json` 里移除**（同 §5，实测读取 0 次）。
> ⛔ 这一条尤其危险：模板里的注释白纸黑字写着"**强制，不可跳过**"，
> 而代码里没有任何东西会跑它。作者备齐了两段参考音频、按 §6 的三条判据
> 认真填完 `smoke`，然后**冒烟一次都没跑过** —— 他却以为引擎已经验过了。
> 「写着强制、实际不跑」比「没写」更坏：后者是空白，前者是**假的保证**。
> 等第三道门落地、本节改成【现状】，`smoke` 再回模板。
"""

S7_NOTE = """
### ⛔⛔ 补记 2026-08-25：键名只能是 `escape_hatch`，不能带下划线

模板里那一行原本写的是 `"_escape_hatch": "driver.js"` —— 比本节多一个下划线。
这不是笔误级别的小事，是**结构上永远不可能生效**：

```
lib/engines/registry.js:32     if (k.startsWith('_')) continue      // 注释键，剥掉
lib/engines/registry.js:55     const manifest = stripComments(parsed)
```

注册表读名片的**第一步**就是把所有 `_` 开头的键当注释扔掉。也就是说，
就算将来把逃生门实现出来，按模板那个写法写的名片，这个键也到不了运行时对象。
上面第 2 条"注册表要显示这个引擎用了逃生门"**永远不会触发**，
而且不报错 —— 表现为"我明明写了逃生门，平台当没看见"。

⭐ 所以本节的 `escape_hatch`（无下划线）是对的，模板抄错了。已随修订 2 一并移除。
⛔ 同一个坑对任何真键都成立：**别拿下划线给名片上的真键起名。**
"""

README_HEAD_NOTE = """>
> ⭐ **2026-08-25：`manifest.json` 里现在只剩今天真的通电的键。**
> `call`（通用宿主）、`smoke`（强制冒烟）、`escape_hatch`（逃生门）这三块
> 已经挪回契约文档 —— 它们**读取 0 次**，填了不会有任何事发生，也不会报错。
> 量法：`tools\\dev\\measure_manifest_reads.cjs`（把名片包一层 Proxy，
> 记录平台每一次取值）。
>
> ⭐ 名片写完之后，用 `tools\\dev\\probe_new_engine.cjs` 验一遍：
> 它会造一台只有名片的假引擎，推着平台走完 5 关，告诉你还差什么。
"""

README_STEPS_OLD = """1. 复制本目录，改名为引擎 id（小写、连字符，如 indextts2）
2. 克隆上游 + 按上游文档装好它自己的环境   ← 不进 git（C10）
3. 生成草稿名片：平台扫一遍，八成字段自动填好
4. 确认映射：平台给候选，你点确认       ← 唯一需要人的地方
5. 三道校验：名字对得上 → 名片自检 → 冒烟出声（含绑定判别）
6. 出声 = 装上了
```"""

README_STEPS_NEW = """1. 复制本目录，改名为引擎 id（小写、连字符，如 indextts2）      【现状】
2. 克隆上游 + 按上游文档装好它自己的环境   ← 不进 git（C10）      【现状】
3. 生成草稿名片：平台扫一遍，八成字段自动填好                    【待建】
4. 确认映射：平台给候选，你点确认       ← 唯一需要人的地方        【待建】
5. 三道校验：名字对得上 → 名片自检 → 冒烟出声（含绑定判别）      【待建】
6. 出声 = 装上了
```

⚠ **第 3、4、5 步今天还没有。**别等平台来问你 —— 名片要**手写**，
参考 `engines/indextts2/manifest.json` 那张真名片。写完跑
`tools\\dev\\probe_new_engine.cjs` 自检，那是今天唯一存在的那道校验。"""

README_TREE_OLD = """├── smoke/ref_a.wav   冒烟用的固定参考音频（⭐ 这个要进 git）
├── smoke/ref_b.wav   另一个人的音色，绑定判别用（⭐ 同样要进 git）
├── driver.js         可选。逃生门，只在 manifest 明写时启用"""

README_TREE_NEW = """├── shim.py           平台按 manifest 的 runtime.entry 去跑它  ← 今天真正的接入点
├── smoke/ref_a.wav   【待建】冒烟用的固定参考音频（⭐ 落地后要进 git）
├── smoke/ref_b.wav   【待建】另一个人的音色，绑定判别用（⭐ 同样要进 git）
├── driver.js         【待建】逃生门，只在 manifest 明写 escape_hatch 时启用"""

README_CALL_NOTE = """## 三种调用形态 【待建】

⚠ 下面这张表描述的是**通用宿主落地之后**的样子。今天平台只有一种做法：
名片写 `runtime.entry`，你自己在引擎目录里放一个脚本，平台去跑它。
`engines/indextts2/shim.py` 就是这么一个脚本，可以直接照着改。
"""

README_GATES_NOTE = """## 三道校验 【待建】

⛔ **这三道今天一道都没有跑起来。**写在这里是因为契约冻结了它们，
不是因为平台在执行它们 —— 别把"我按第三道填了 smoke"当成"我验过了"。
今天能跑的只有 `tools\\dev\\probe_new_engine.cjs`（大致相当于第二道的雏形）。
"""

# --- 机械部分 ---------------------------------------------------------------

edits = []      # (文件, 描述, 函数)
problems = []
skipped = []


def read(p):
    if not os.path.exists(p):
        problems.append("文件不存在：%s" % p)
        return None
    return io.open(p, encoding="utf-8").read()


def once(text, anchor, where):
    n = text.count(anchor)
    if n != 1:
        problems.append("%s：锚点命中 %d 次（要求恰好 1 次）\n        锚点：%s"
                        % (where, n, anchor.splitlines()[0][:70]))
        return False
    return True


def plan_contract(text):
    out = text
    done = []

    # 1) §0 修订记录：插在表格最后一行之后
    if "2026-08-25 | 2（修订 2）" in out:
        skipped.append("契约 §0 修订记录（已经在了）")
    else:
        sec = re.search(r"## §0 修订记录.*?(?=\n## )", out, re.S)
        if not sec:
            problems.append("契约：找不到「## §0 修订记录」这一节")
            return None, done
        block = sec.group(0)
        rows = list(re.finditer(r"^\| 20\d\d-\d\d-\d\d \|.*$", block, re.M))
        if not rows:
            problems.append("契约 §0：修订记录表里一行数据都没有，不敢往里插")
            return None, done
        last = rows[-1]
        newblock = block[:last.end()] + "\n" + REV_ROWS + block[last.end():]
        out = out.replace(block, newblock, 1)
        done.append("契约 §0 修订记录 +2 行")

    # 2) §5 / §6 抬头说明
    for title, note, name in (
        ("## §5 名片：怎么调这个引擎 【待建】\n", S5_NOTE, "契约 §5 抬头说明"),
        ("## §6 三道校验：装不上，好过装上了一调就炸 【待建】\n", S6_NOTE, "契约 §6 抬头说明"),
    ):
        if note.splitlines()[0] in out:
            skipped.append(name + "（已经在了）")
            continue
        if not once(out, title, name):
            return None, done
        out = out.replace(title, title + "\n" + note, 1)
        done.append(name)

    # 3) §7 末尾补记
    if "键名只能是 `escape_hatch`" in out:
        skipped.append("契约 §7 补记（已经在了）")
    else:
        anchor = "改平台是不可逆的伤害，用逃生门是局部的、看得见的、可以以后收回的。"
        if not once(out, anchor, "契约 §7 补记"):
            return None, done
        out = out.replace(anchor, anchor + "\n" + S7_NOTE, 1)
        done.append("契约 §7 补记")

    return out, done


def plan_readme(text):
    out = text
    done = []

    # 1) 抬头提示
    if "现在只剩今天真的通电的键" in out:
        skipped.append("README 抬头提示（已经在了）")
    else:
        anchor = "> 【待建】的章节，照做会发现平台还不支持。标【现状】的可以直接照做。\n"
        if not once(out, anchor, "README 抬头提示"):
            return None, done
        out = out.replace(anchor, anchor + README_HEAD_NOTE, 1)
        done.append("README 抬头提示")

    # 2) 六步 / 目录形状 / 两节抬头，都是整块替换
    for old, new, name in (
        (README_STEPS_OLD, README_STEPS_NEW, "README 六步标【现状/待建】"),
        (README_TREE_OLD, README_TREE_NEW, "README 目录形状标【待建】+ 补 shim.py"),
        ("## 三种调用形态\n", README_CALL_NOTE, "README「三种调用形态」标【待建】"),
        ("## 三道校验\n", README_GATES_NOTE, "README「三道校验」标【待建】"),
    ):
        if new.strip().splitlines()[0] in out and old not in out:
            skipped.append(name + "（已经在了）")
            continue
        if not once(out, old, name):
            return None, done
        out = out.replace(old, new, 1)
        done.append(name)

    return out, done


print("apply_template_2f —— 按锚点打文档改动（锚点对不上就一处都不写）")
print("项目根：" + ROOT)
print("=" * 74)
print("")

ctext = read(CONTRACT)
rtext = read(README)
if problems:
    for p in problems:
        print("  ⛔ " + p)
    sys.exit(1)

cnew, cdone = plan_contract(ctext)
rnew, rdone = plan_readme(rtext)

if problems:
    print("⛔⛔ 锚点对不上，**一个字都没写**：")
    print("")
    for p in problems:
        print("  ⛔ " + p)
    print("")
    print("多半是真机上的文件比助手手里的版本新。把这两个文件发回去重算，")
    print("别手工凑锚点 —— 凑出来的位置对不对没人验得了。")
    sys.exit(1)

for path, new, done in ((CONTRACT, cnew, cdone), (README, rnew, rdone)):
    if done:
        io.open(path, "w", encoding="utf-8", newline="").write(new)
    print("  %s" % os.path.relpath(path, ROOT))
    for d in done:
        print("     ✅ " + d)
    if not done:
        print("     （无改动）")

if skipped:
    print("")
    print("  跳过（已经在文件里，重复运行不会插两遍）：")
    for s in skipped:
        print("     ◻ " + s)

print("")
print("=" * 74)
print("改完请跑：git --no-pager diff --stat -- docs/ engines/_TEMPLATE/")
sys.exit(0)
