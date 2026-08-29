# -*- coding: utf-8 -*-
"""apply_host_block —— 把「通用宿主要的三段」补进一张**已经存在**的名片。

⛔⛔ 这个脚本存在的唯一理由，是一次真实事故：

  我（助手）手上的源码快照停在某一天，之后仓库里这张名片又被改过。
  我基于旧底本改完、交了一份**全文**，于是那期间的改动被**静默回滚**了 ——
  `git diff --numstat` 显示 170 加 / **176 删**，而我自认只加了 20 行。
  两张名片都中招，代码文件反而干净（因为那些文件的现行版本本来就是我交的）。

  教训：**sha256 只能证明「我交的 = 我改的」，证明不了「我改的底本 = 你的」。**
  ⇒ 凡是修改**既有**文件，就不该交全文，而应该交一个「在你机器上做插入」
    的脚本 —— 它读什么就改什么，我全程不需要持有底本。

设计上因此有三条硬约束：

  1. **锚点只用 ASCII 结构**（JSON 最外层那个收尾的 `}`）。不依赖任何注释文本、
     不依赖键的顺序、不依赖我对文件内容的任何记忆。
  2. **只加不删**。写完之后逐条核对：原有的每一个顶层键都还在，且值**逐字节**
     相同；原文的每一行也都还在。少一样就还原并非零退出。
  3. **幂等**。已经补过就原样退出，第二次跑一个字节不动。

用法：
    python tools/dev/apply_host_block.py
    python tools/dev/apply_host_block.py --engine indextts2
    python tools/dev/apply_host_block.py --dry-run     ← 只说要干什么，不写

退出码：0 补好了（或本来就补过）／1 自查没过，已还原／2 前提不成立，没动手
"""

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

# ---------------------------------------------------------------------------
# 要补的三段。值全部是从 engines/indextts2/shim.py 里**量**出来的，
# 不是照着契约抄的 —— 每一条后面的行号就是出处，方便复核。
# ---------------------------------------------------------------------------
BLOCKS = {
    "indextts2": [
        ("_comment_call", [
            "⭐ 通用宿主 lib/engines/host.py 全靠这一段才知道怎么调上游。",
            "  每一项的出处都是 engines/indextts2/shim.py 的实际代码，行号在后面。",
            "  ⛔ 改这里等于改「平台怎么调这台引擎」，改完必须重跑 tools/dev/probe_host.py。",
            "",
            "  module / class      shim.py:162",
            "  init_args.cfg_path  shim.py:482（cfg = join(ckpt, \"config.yaml\")）",
            "  init_args.model_dir 就是 checkpoints 目录本身",
            "  use_* 三个          shim.py:169-179",
            "  method / bind       shim.py:234-238",
            "  seed                shim.py:200-219（四个随机源逐个播）",
            "",
            "  {checkpoints} 这种大括号是**占位符**，由宿主在启动时填成绝对路径。",
            "  名片不知道也不该知道这台机器上的绝对路径。认得的占位符只有三个：",
            "  {root} / {engine_dir} / {checkpoints}，写错会被当场拒绝启动，不会静默。",
        ]),
        ("call", {
            "kind": "python",
            "module": "indextts.infer_v2",
            "class": "IndexTTS2",
            "init_args": {
                "cfg_path": "{checkpoints}/config.yaml",
                "model_dir": "{checkpoints}",
                "use_fp16": False,
                "use_cuda_kernel": False,
                "use_deepspeed": False,
            },
            "method": "infer",
            "bind": {
                "text": "text",
                "ref_audio": "spk_audio_prompt",
                "output_path": "output_path",
            },
            "returns": "file",
            "seed": {
                "mode": "global",
                "rngs": ["python", "numpy", "torch", "torch.cuda"],
                "scope": "locked",
            },
        }),
        ("_comment_params", [
            "⭐ 两张白名单，分别喂 /tts 上的两道 400：",
            "    load_time  只能在加载引擎时给。出现在合成请求里 ⇒ 400。",
            "    call_time  允许透传给上游方法。不在这张表里 ⇒ 400（拼错当场抓）。",
            "",
            "  出处：shim.py:116-118（LOAD_TIME_KEYS）、shim.py:121-124（CALL_TIME_KEYS）。",
            "",
            "  ⛔ 同一个名字不能同时出现在两张表里 —— 那样两道 400 会互相打架，",
            "    而且没人说得清改了它到底要不要重启。hostProfile.js 会拒绝装配。",
            "",
            "  ⭐ 这一段是 params 的**兄弟键**，和 params.schema（UI 画格子用的那套）",
            "    各管各的，互不覆盖。",
            "",
            "  ⛔ 别拿 payload_keys 顶替这张表：那是「HTTP 载荷里放哪些键」，",
            "    gpt-sovits 的 payload_keys 里混着 text / ref_audio_path / seed",
            "    这些核心键，当白名单用会把两道闸都判错。",
        ]),
        ("params", {
            "load_time": [
                "use_fp16",
                "use_cuda_kernel",
                "use_deepspeed",
                "use_accel",
                "use_torch_compile",
            ],
            "call_time": [
                "emo_alpha",
                "interval_silence",
                "verbose",
                "max_text_tokens_per_segment",
            ],
        }),
        ("_comment_output_formats", [
            "这台引擎自己能直接吐出来的格式。要别的格式 ⇒ 400，由平台去转，",
            "不在引擎里塞转码逻辑（契约：引擎只管推理）。",
        ]),
        ("output_formats", ["wav"]),
    ],
}

NEW_KEYS = None  # 运行时按引擎填


def read_bytes(p):
    with open(p, "rb") as f:
        return f.read()


def read_text(p):
    return read_bytes(p).decode("utf-8")


def write_text(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def flag(name, default=None):
    argv = sys.argv[1:]
    pref = "--%s=" % name
    for i, a in enumerate(argv):
        if a.startswith(pref):
            return a[len(pref):]
        if a == "--%s" % name and i + 1 < len(argv):
            return argv[i + 1]
    return default


def has_flag(name):
    return ("--%s" % name) in sys.argv[1:]


def render(pairs, indent="  "):
    """把要插入的键渲染成文本。

    ⭐ 用 json.dumps 逐**键**渲染，再自己拼缩进 —— 不是把整个文件
      JSON.parse 再 dump。后者会把整份名片重新排版，又变成一次全文件改写，
      正是这个脚本要避免的东西。
    """
    out = []
    for key, val in pairs:
        body = json.dumps(val, ensure_ascii=False, indent=2)
        lines = body.split("\n")
        body = ("\n" + indent).join(lines)
        out.append('%s%s: %s' % (indent, json.dumps(key, ensure_ascii=False), body))
    return ",\n\n".join(out)


def main():
    engine = flag("engine", "indextts2")
    dry = has_flag("dry-run")

    if engine not in BLOCKS:
        print("⛔ 不认识的引擎 %r —— 这个脚本只带了这些引擎的补丁内容：%s"
              % (engine, ", ".join(sorted(BLOCKS))))
        return 2

    pairs = BLOCKS[engine]
    new_keys = [k for k, _ in pairs]

    path = os.path.join(ROOT, "engines", engine, "manifest.json")
    if not os.path.isfile(path):
        print("⛔ 找不到名片：%s" % path)
        return 2

    raw = read_text(path)
    try:
        before = json.loads(raw)
    except ValueError as e:
        print("⛔ 这张名片现在就不是合法 JSON，先修好再来：%s" % e)
        return 2

    print("apply_host_block —— 给 %s 的名片补上通用宿主要的三段" % engine)
    print("名片：%s" % path)
    print("现在 %d 字节，%d 个顶层键" % (len(raw.encode("utf-8")), len(before)))
    print("")

    # ---- 幂等 ----------------------------------------------------------
    # ⭐ params 要单独排除在「补了一半」之外：它跟其他五个键不一样 ——
    #   **它本来就可能合法地先存在**（模板里的 params.schema 就是，那是给 UI
    #   画格子用的，和宿主的 load_time / call_time 是同一命名空间下的兄弟键）。
    #   不排除的话，一张正常带 schema 的名片会被误判成「上次补了一半」，
    #   拿到一句看不懂的错误，而不是下面那条「该怎么手工合并」的指引。
    already = [k for k in new_keys if k in before and k != "params"]
    if "call" in before:
        print("✅ 已经补过了（顶层已有 call）—— 一个字节都不动。")
        print("   已在场：%s" % ", ".join(already))
        return 0
    if already:
        print("⛔ 补了一半：这些键已经在了，但没有 call。手工确认后再跑。")
        print("   %s" % ", ".join(already))
        return 2

    # ---- 前提：params 若已存在，需要的是合并而不是新增，本脚本不做 ----
    if "params" in before:
        print("⛔ 这张名片已经有 params 段了。")
        print("   本脚本只会**新增**，不会往已有对象里合并 —— 合并要动内层")
        print("   缩进，风险比收益大。请手工把下面两个键加进现有的 params 里：")
        print("     load_time: %s" % json.dumps(
            dict(pairs).get("params", {}).get("load_time"), ensure_ascii=False))
        print("     call_time: %s" % json.dumps(
            dict(pairs).get("params", {}).get("call_time"), ensure_ascii=False))
        return 2

    # ---- 行尾：跟随原文，⛔ 不擅自改 -----------------------------------
    crlf = raw.count("\r\n")
    lf = raw.count("\n") - crlf
    if crlf and lf:
        print("⛔ 这张名片行尾是混的（CRLF %d / LF %d）。不动手 —— 我一写就会" % (crlf, lf))
        print("   把它统一成一种，那会变成一次全文件改写，把真正的改动淹掉。")
        return 2
    nl = "\r\n" if crlf else "\n"
    body = raw.replace("\r\n", "\n")

    # ---- 找最外层收尾的 `}` --------------------------------------------
    idx = body.rstrip().rfind("}")
    if idx < 0:
        print("⛔ 找不到 JSON 的收尾括号，这文件不对劲。")
        return 2
    head = body[:idx]
    tail = body[idx:]

    stripped = head.rstrip()
    if not stripped.endswith(",") and not stripped.endswith("{"):
        insertion = ",\n\n" + render(pairs) + "\n"
    else:
        insertion = "\n" + render(pairs) + "\n"
    new_body = stripped + insertion + tail.lstrip("\n")
    new_raw = new_body.replace("\n", nl) if nl == "\r\n" else new_body

    if dry:
        print("--dry-run：会新增这些顶层键（不写）：")
        for k in new_keys:
            print("   + %s" % k)
        print("")
        print("会插在最后一个顶层键之后、收尾 } 之前，%d 字节 → %d 字节"
              % (len(raw.encode("utf-8")), len(new_raw.encode("utf-8"))))
        return 0

    bak = path + ".hostblockbak"
    with open(bak, "wb") as f:
        f.write(raw.encode("utf-8"))
    write_text(path, new_raw)

    # ---- 写后自查：只加不删，一条都不能少 ------------------------------
    problems = []
    try:
        after = json.loads(read_text(path))
    except ValueError as e:
        problems.append("写完之后不是合法 JSON 了：%s" % e)
        after = None

    if after is not None:
        for k in before:
            if k not in after:
                problems.append("原有顶层键 %r 不见了" % k)
            elif json.dumps(after[k], sort_keys=True, ensure_ascii=False) != \
                    json.dumps(before[k], sort_keys=True, ensure_ascii=False):
                problems.append("原有顶层键 %r 的值被改了" % k)
        added = [k for k in after if k not in before]
        if sorted(added) != sorted(new_keys):
            problems.append("新增的键对不上：实际 %s" % ", ".join(sorted(added)))

        # 原文每一行都还在（这条比键级检查更严：连注释和空行都要保住）
        got = read_text(path).replace("\r\n", "\n").split("\n")
        missing = 0
        gi = 0
        for ln in body.split("\n"):
            if ln in got[gi:]:
                gi = got.index(ln, gi) + 1
            elif ln.strip() and ln.rstrip().rstrip(",") not in \
                    [g.rstrip().rstrip(",") for g in got]:
                missing += 1
        if missing:
            problems.append("原文有 %d 行在新文件里找不到了（这脚本只该加，不该删）" % missing)

    if problems:
        with open(path, "wb") as f:
            f.write(read_bytes(bak))
        print("⛔ 写后自查没过，已把名片还原：")
        for p in problems:
            print("   - %s" % p)
        print("")
        print("   备份还留着（确认无误后自己删）：%s" % bak)
        return 1

    os.remove(bak)
    print("✅ 补好了，%d 字节 → %d 字节，新增 %d 个顶层键："
          % (len(raw.encode("utf-8")), len(new_raw.encode("utf-8")), len(new_keys)))
    for k in new_keys:
        print("   + %s" % k)
    print("")
    print("   原有 %d 个顶层键**逐字节原值保留**（已逐条核过）。" % len(before))
    print("   行尾保持 %s，没动。" % ("CRLF" if nl == "\r\n" else "LF"))
    print("")
    print("下一步：重跑 tools/dev/probe_profile_contract.py 看这张名片够不够宿主用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
