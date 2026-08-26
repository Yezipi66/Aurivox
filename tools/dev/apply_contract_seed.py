# -*- coding: utf-8 -*-
"""
apply_contract_seed —— 给引擎契约补上 call.seed（§5.2.1）

为什么要这个脚本而不是直接给你一份新 ENGINE_CONTRACT.md：
  真机上这份文档已经被 apply_template_2f.py 改过（+32 行），我沙箱里的副本
  停在 8-23。整文件覆盖会把那 32 行抹掉。所以只按锚点打补丁。

纪律（都是踩过的坑）：
  ⛔ 全部锚点先核一遍，**任何一处对不上就一处都不写**（不留半截文档）
  ⛔ 一律二进制 I/O —— 2026-08-25 真机事故：文本模式 open() 会把 LF 文件
     整体重写成 CRLF，内容一字未改但 git 报 M，523 行全变
  ⛔ 幂等：已经打过的锚点跳过，重复运行不会插两遍
  ⛔ 写之前备份，写之后字节比对；对不上就保留备份并点名
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE)) if os.path.basename(
    os.path.dirname(HERE)) == "tools" else os.path.dirname(HERE)
# tools/dev/x.py -> ROOT = 上上级
ROOT = os.path.dirname(os.path.dirname(HERE))

DOC = os.path.join(ROOT, "docs", "ENGINE_CONTRACT.md")


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def write_bytes(p, b):
    with open(p, "wb") as f:
        f.write(b)


def sha(b):
    import hashlib
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------- 补丁定义
# 每条：(名字, 幂等标记, 锚点, 替换成什么)
#   幂等标记出现在文档里 = 这条已经打过
#   锚点必须在全文里**恰好出现一次**，否则拒绝动手

A_RETURNS = """  // 结果怎么拿："file" = 它写文件，平台去读；"bytes" = 方法直接返回字节
  "returns": "file"
}
```
"""

B_RETURNS = """  // 结果怎么拿："file" = 它写文件，平台去读；"bytes" = 方法直接返回字节
  "returns": "file",

  // ⭐ 种子怎么生效 —— 见 §5.2.1
  //    IndexTTS2 的 infer() 根本没有 seed 参数，所以只能让宿主
  //    在调用之前、同一把锁内，把种子打到这几个全局 RNG 上
  "seed": {
    "mode":  "global",
    "rngs":  ["python", "numpy", "torch", "torch.cuda"],
    "when":  "before_call",
    "scope": "locked"
  }
}
```
"""

A_S53_HEAD = "### §5.3 `cli` 形态要说清什么\n"

B_S53_HEAD = """### ⭐ §5.2.1 `call.seed`：种子是副作用，不是实参 【待建】

**这一节是 2026-08-25 量 `engines/indextts2/shim.py` 时发现的契约缺口。**

§1 早就点名过这个坑 —— 原话是「收下 `seed` 却不用，导致"重跑声音不一样"
而 `meta.json` 里白纸黑字记着一个没生效的种子」，并把它列为版本 2 的动机之一。
但 §5.2 的 `bind` 只有 `text` / `ref_audio` / `output_path`，
**契约至今没给种子留任何落点**。

#### 为什么不能用 `bind` 或 `{seed}` 槽位解决

槽位只能填进**参数**。而 `IndexTTS2.infer()` 的签名里根本没有 seed ——
它靠的是「在调用之前，把进程里的全局随机源全部播一遍」。
这是**副作用**，不是实参，`bind` 表达不了。

#### `call.seed` 三态

| 写法 | 什么意思 | 谁来做 |
|---|---|---|
| `{"arg": "seed"}` | 引擎自己的合成方法/命令行收 seed | 引擎 |
| `{"mode": "global", ...}` | 引擎不收，宿主播全局 RNG | **平台** |
| `"none"` | 这台引擎不可复现 | 谁都不做，但**必须写出来** |

⛔ **`"none"` 不是可以省略的。** 省略 = 今天的行为 = 静默忽略，
而静默忽略正是 §1 点名的那个坑。写了 `"none"`，平台就**显式拒收**
带 seed 的请求（返回 400），用户当场知道；不写，用户拿到的是一个
声音对不上的 `meta.json`。**"不支持" 和 "没写" 必须能区分开。**

#### `mode: "global"` 的两条 MUST

```jsonc
"seed": {
  "mode":  "global",
  "rngs":  ["python", "numpy", "torch", "torch.cuda"],
  "when":  "before_call",
  "scope": "locked"
}
```

1. ⭐ **`rngs` 必须由名片列，平台不得写死。**
   IndexTTS2 要播四个（`random` / `numpy` / `torch` / `torch.cuda`）；
   换一台纯 ONNX 或纯 JAX 的引擎，`torch` 根本没装。
   平台无条件去播一个不存在的 RNG，只能靠 `try/except: pass` 吞掉 ——
   **那等于播种失败是静默的**，又回到同一个坑里。
   ⚠ 名片列了但环境里没有 ⇒ 这是 §6 第一道校验该拦的事（注册时就拦），
   不是运行时吞异常。

2. ⭐ **`scope: "locked"` 是正确性要求，不是优化。**
   播种改的是**进程级**全局状态。两个并发请求如果不在同一把锁内，
   会互相冲掉对方刚播下的种子 —— 两边的 `meta.json` 都记着自己的 seed，
   两边的声音都不对。
   ⚠ 而 §5.6 第 2 条已经把「排队」判给了平台：既然锁在平台手里，
   **名片就没有能力自己保证这件事** ⇒ 播种必须由平台在它自己的锁内做。

#### 取证：播了什么要记下来

宿主播完种要把**实际生效的 RNG 列表**写进 `meta.json`
（今天 `shim.py` 的 `apply_seed()` 返回 `"numpy+torch+cuda"` 就是干这个的）。
理由同上：只播不记，用户没法区分"播了"和"以为播了"。

⚠ 即使四个 RNG 全播到，CUDA 上部分 kernel 本身非确定性，
跨 GPU 型号不保证逐字节一致。契约承诺的是**同机同输入可复现**，
不是数学意义上的确定性 —— 这一点要在界面上对用户说清楚。

### §5.3 `cli` 形态要说清什么
"""

A_SLOTS = """`{checkpoints}` `{text}` `{ref_audio}` `{output_path}` `{seed}`
以及名片里声明过的任何参数名。
"""

B_SLOTS = """`{checkpoints}` `{text}` `{ref_audio}` `{output_path}` `{seed}`
以及名片里声明过的任何参数名。

⛔ **`{seed}` 槽位只在 `call.seed` 写成 `{"arg": ...}` 时才可用。**
`cli` 形态每次合成都是一个新进程，`mode: "global"` 在这里无处安放
（平台没法往一个还没起来的进程里播种）—— 所以 `cli` 引擎要么自己收 seed，
要么老老实实写 `"none"`。见 §5.2.1。
"""

A_CONCUR = """2. **并发**。同一块显卡上的推理由平台排队，引擎不需要自己加锁。
"""

B_CONCUR = """2. **并发**。同一块显卡上的推理由平台排队，引擎不需要自己加锁。
   ⭐ 推论：**播种也必须由平台在这把锁内做**（§5.2.1 `scope: "locked"`）——
   名片手里没有这把锁，声明了也保证不了。
"""

PATCHES = [
    ("§5.2 示例补 call.seed",
     '"mode":  "global",', A_RETURNS, B_RETURNS),
    ("新增 §5.2.1 整节",
     "### ⭐ §5.2.1 `call.seed`", A_S53_HEAD, B_S53_HEAD),
    ("§5.3 槽位表补 {seed} 的适用条件",
     "`{seed}` 槽位只在 `call.seed`", A_SLOTS, B_SLOTS),
    ("§5.6 并发那条补播种推论",
     "播种也必须由平台在这把锁内做", A_CONCUR, B_CONCUR),
]


def main():
    print("apply_contract_seed —— 给引擎契约补上 call.seed（§5.2.1）")
    print("项目根：%s" % ROOT)
    print("=" * 74)
    print()

    if not os.path.isfile(DOC):
        print("⛔ 找不到契约文件：%s" % DOC)
        return 1

    raw = read_bytes(DOC)
    before_sha = sha(raw)
    text = raw.decode("utf-8")

    # 行尾侦察：锚点用 \n 写的，文档若是 CRLF 要先归一化再还原
    crlf = text.count("\r\n")
    lf_only = text.count("\n") - crlf
    if crlf and lf_only:
        print("⛔ 文档行尾是混合的（CRLF %d 行 / LF %d 行）—— 拒绝动手。" % (crlf, lf_only))
        print("   先统一行尾再跑，否则补丁会把混乱扩大。")
        return 1
    is_crlf = crlf > 0
    work = text.replace("\r\n", "\n") if is_crlf else text
    print("文档行尾：%s（%d 字节，sha %s）" % (
        "CRLF" if is_crlf else "LF", len(raw), before_sha[:12]))
    print()

    # ---- 第一遍：只核对，不写 -------------------------------------------
    todo, skipped, bad = [], [], []
    for name, marker, anchor, repl in PATCHES:
        if marker in work:
            skipped.append(name)
            continue
        n = work.count(anchor)
        if n == 1:
            todo.append((name, anchor, repl))
        else:
            bad.append((name, n))

    if bad:
        print("⛔ 锚点对不上 —— **一处都不写**：")
        for name, n in bad:
            print("     ✗ %s   命中 %d 次（要求恰好 1 次）" % (name, n))
        print()
        print("   多半是这份文档和我手上的副本不是同一版。")
        print("   把 docs/ENGINE_CONTRACT.md 发我，我按你的真身重出锚点。")
        return 1

    if not todo:
        print("✅ 四处改动都已经在文件里了 —— 这次一个字没动（幂等）。")
        for name in skipped:
            print("     ◻ %s（已经在了）" % name)
        return 0

    # ---- 第二遍：备份 + 写 ----------------------------------------------
    bak = DOC + ".seedbak"
    write_bytes(bak, raw)

    for name, anchor, repl in todo:
        work = work.replace(anchor, repl, 1)

    out = work.replace("\n", "\r\n") if is_crlf else work
    write_bytes(DOC, out.encode("utf-8"))

    # ---- 写后自查：只该多，不该少 ---------------------------------------
    now = read_bytes(DOC)
    grew = len(now) - len(raw)
    all_markers_in = all(m in now.decode("utf-8")
                         for _, m, _, _ in PATCHES)
    # 原文的每一行都还在吗（只加不删）
    old_lines = [l for l in raw.decode("utf-8").replace("\r\n", "\n").split("\n") if l.strip()]
    new_body = now.decode("utf-8").replace("\r\n", "\n")
    missing = [l for l in old_lines if l not in new_body]

    print("  docs/ENGINE_CONTRACT.md")
    for name, _, _ in todo:
        print("     ✅ %s" % name)
    for name in skipped:
        print("     ◻ %s（已经在了，没重复插）" % name)
    print()
    print("  长度 %d → %d 字节（+%d）" % (len(raw), len(now), grew))
    print("  四处标记都在：%s" % ("是" if all_markers_in else "⛔ 否"))
    print("  原文每一行都还在（只加不删）：%s" % (
        "是" if not missing else "⛔ 否，丢了 %d 行" % len(missing)))

    ok = grew > 0 and all_markers_in and not missing
    if not ok:
        print()
        print("⛔ 写后自查没过 —— 已从备份还原。")
        write_bytes(DOC, raw)
        print("   备份保留：%s" % bak)
        for l in missing[:5]:
            print("     丢失行：%s" % l[:70])
        return 1

    # 还原点确认无误才删备份（2026-08-25 教训：删备份前必须有判据）
    os.unlink(bak)
    print()
    print("=" * 74)
    print("改完请跑：git --no-pager diff --stat -- docs/ENGINE_CONTRACT.md")
    print("          git --no-pager diff -- docs/ENGINE_CONTRACT.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
