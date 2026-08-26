# -*- coding: utf-8 -*-
"""probe_profile_contract —— 宿主要的字段，profile.js 到底给不给

为什么要有这支
--------------
`probe_host.py` 里那份 profile JSON 是**手写的**。我发明了一个形状，
再拿它去测我自己的发明 —— 于是 29/29 全绿证明的是「host.py 和我的想象一致」，
**不是**「host.py 和平台一致」。

这支探针改成让 **node 真的跑一遍 `resolveEngineProfile()`**，拿真身来对。
⭐ 判据不是我读代码读出来的印象，是两边各跑一次的结果。

它现在**应该是红的** —— 红的那几行就是「profile.js 还要学会给什么」的清单，
是算出来的，不是我列的。等两边都改完，它转绿，就成了防形状漂移的常驻闸。
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

ROWS = []


def row(name, ok, note=""):
    ROWS.append((name, ok, note))
    print("   %-6s %s%s" % ("ok" if ok else "⛔", name,
                            ("   %s" % note) if note else ""))


def find_node():
    """真机用仓库自带的 node，Linux 上用 PATH 里的。"""
    cand = os.path.join(ROOT, "tools", "runtime", "node", "node.exe")
    if os.path.isfile(cand):
        return cand
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, "node")
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def node_err(raw):
    """从 node 的 stderr 里把**错误消息本身**捞出来。

    ⛔⛔ 这里原来写的是 `raw[-800:]` —— **取尾巴**。而 node 的 stderr 长这样：

        D:\\...\\hostProfile.js:107
                throw bad(id, 'call.bind.ref_audio',
                ^
        Error: 引擎 indextts2 的名片 call.bind.ref_audio 缺了 —— ...
            at parseCall (D:\\...)
            at ... （还有十几帧）

    消息在**头部**，后面全是栈帧。取尾巴 = 取到一堆 at 行，把消息本身扔了。

    ⭐⭐ 而且这个 bug **跨平台漂移**：项目路径短的时候，800 字的尾巴刚好还
      包着消息（于是绿）；路径一长（比如
      D:\\Project\\tts_broker_openai_compat\\lib\\engines\\...），每个栈帧长一倍，
      800 字尾巴里**只剩栈帧**，于是同一份代码、同一个退出码，换台机器就红。
      实测：把项目挪进一个 183 字符深的目录，这条判据当场复现红。
      ⇒ 教训：**按字节数截断的东西，截断位置是环境的函数，不是代码的函数。**
        要留信息就按**结构**留（找 Error 行），别按长度赌。
    """
    lines = raw.splitlines()
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith("Error:") or s.startswith("TypeError:") \
                or s.startswith("RangeError:"):
            # 消息可能折行，把紧跟着的非栈帧行也带上
            out = [s]
            for nxt in lines[i + 1:]:
                if nxt.strip().startswith("at "):
                    break
                if nxt.strip():
                    out.append(nxt.strip())
            return "\n".join(out)[:800]
    # 没找到结构 ⇒ 退回取**头部**（消息总在前面），不是尾部
    return raw[:800]


def real_profile(node, engine_id):
    """⭐ 不读源码猜，直接叫 profile.js 出货。"""
    # ⭐⭐ 这里叫的是 buildHostProfile 而**不是** resolveEngineProfile。
    #   量过：resolveEngineProfile 今天有 9 个 JS 消费方，碰 call / params /
    #   output_formats 的是 0 个 —— 这四段只有 host.py 要。所以走加法：
    #   hostProfile.js 在 profile.js 外面套一层，profile.js 一个字节不动。
    script = (
        "const {buildHostProfile} = require('./lib/engines/hostProfile');"
        "process.stdout.write(JSON.stringify("
        "buildHostProfile(process.env.PROBE_ENGINE_ID, {})));"
    )
    env = dict(os.environ)
    env["PROBE_ENGINE_ID"] = engine_id
    r = subprocess.run([node, "-e", script], cwd=ROOT, env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=60)
    if r.returncode != 0:
        raise RuntimeError(node_err(r.stderr.decode("utf-8", "replace")))
    return json.loads(r.stdout.decode("utf-8"))


def raw_manifest(engine_id):
    """直接读名片原文。

    ⭐ 故意**不**走 buildHostProfile —— 「这台引擎该不该由通用宿主托管」
      这个判断，必须在 buildHostProfile 抛异常之前做出来，否则就成了
      「因为它抛了所以它不该托管」的循环论证。
    """
    p = os.path.join(ROOT, "engines", engine_id, "manifest.json")
    with open(p, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def engine_ids(node):
    script = ("const {listEngineIds} = require('./lib/engines/registry');"
              "process.stdout.write(JSON.stringify(listEngineIds()));")
    r = subprocess.run([node, "-e", script], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=60)
    if r.returncode != 0:
        raise RuntimeError(node_err(r.stderr.decode("utf-8", "replace")))
    return json.loads(r.stdout.decode("utf-8"))


# host.py 里每一处读 profile 的地方，逐条列成「路径 → 为什么要它」。
# ⛔ 这张表必须和 host.py 的实际读法一致；下面 [0] 那一节会去核对，
#    免得 host.py 改了而这里没跟着改（那样探针会变成安慰剂）。
NEEDS = [
    ("id", "报 X-Engine / 错误信息里点名是哪台引擎"),
    ("runtime", "sys_path / cwd / 端口"),
    ("call", "宿主全靠它才知道 import 谁、构造什么、调哪个方法"),
    ("params.load_time", "「加载期参数出现在调用里」那条 400"),
    ("params.call_time", "透传给上游方法的参数白名单 + 「不认识的参数」那条 400"),
    ("output_formats", "「要 mp3」那条 400"),
    ("requires_reference_audio", "「必须给参考音频」那条 400"),
]


def dig(obj, path):
    """按 'a.b' 取值。取不到返回 (False, None)。"""
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False, None
        cur = cur[part]
    return True, cur


def main():
    print("probe_profile_contract —— 宿主要的字段，profile.js 到底给不给")
    print("项目根：%s" % ROOT)
    print("=" * 74)
    print()

    node = find_node()
    if not node:
        print("⛔ 找不到 node，跳过（这支探针必须能叫 node 才有意义）")
        return 2
    print("node：%s" % node)
    print()

    # ---------- [0] 先证明这张表没和 host.py 脱节 ----------
    print("[0] 这张需求表和 host.py 的实际读法对得上吗（防安慰剂）")
    host_src = ""
    hp = os.path.join(ROOT, "lib", "engines", "host.py")
    if os.path.isfile(hp):
        with open(hp, "rb") as f:
            host_src = f.read().decode("utf-8", "replace")
    for path, _why in NEEDS:
        leaf = path.split(".")[-1]
        row("host.py 里确实出现了 %s" % path, leaf in host_src)
    print()

    try:
        ids = engine_ids(node)
    except Exception as exc:
        print("⛔ 列不出引擎：%s" % exc)
        return 2
    print("装着的引擎：%s" % ", ".join(ids))
    print()

    missing_all = {}
    hosted, skipped = [], []
    for eid in ids:
        print("[%s] 宿主要的字段在不在" % eid)

        # ⭐⭐ 先分辨托管模式，再决定拿什么判据去核。
        #   不是每台引擎都由通用宿主托管：有的自带服务端（gpt-sovits 的
        #   runtime.entry 指向 lib/inference/infer_server.py，目录下连 shim 都没有）。
        #   对这种引擎要求 call 段是**判据用错了地方**，不是它有缺陷。
        # ⛔ 但跳过必须是**看得见**的 —— 静默跳过会让「不该托管」和
        #   「该托管但名片忘了写 call」长得一模一样。所以这里把 entry 打出来。
        raw = raw_manifest(eid)
        if not isinstance(raw.get("call"), dict):
            entry = ((raw.get("runtime") or {}).get("entry")) or "?"
            row("%s 不由通用宿主托管，跳过（这是合法的）" % eid, True,
                "entry=%s，名片无 call 段" % entry)
            skipped.append(eid)
            print()
            continue
        hosted.append(eid)

        try:
            prof = real_profile(node, eid)
        except Exception as exc:
            row("能解析出名片", False, str(exc)[:120])
            print()
            continue
        for path, why in NEEDS:
            found, val = dig(prof, path)
            note = ""
            if found:
                note = "= %s" % json.dumps(val, ensure_ascii=False)[:52]
            else:
                note = "缺 —— %s" % why
                missing_all.setdefault(path, []).append(eid)
            row("%s" % path, found, note)
        print()

    # ---------- 结账 ----------
    print("=" * 74)
    bad = [n for n, ok, _ in ROWS if not ok]
    print("结账：%d 条，%d 过，%d 没过" % (len(ROWS), len(ROWS) - len(bad), len(bad)))
    print("     由通用宿主托管：%s" % (", ".join(hosted) or "（一台都没有）"))
    print("     自带服务端跳过：%s" % (", ".join(skipped) or "（无）"))
    # ⛔ 一台都没托管 ⇒ 上面全绿是空转出来的，不是真通过。
    if not hosted:
        print()
        print("⛔ 没有任何一台引擎由通用宿主托管 —— 这轮全绿什么也没证明。")
        return 1
    if missing_all:
        print()
        print("⛔ profile.js 还要学会给这些（这份清单是**算出来的**，不是我列的）：")
        for path in sorted(missing_all):
            print("     %-26s 缺的引擎：%s" % (path, ", ".join(missing_all[path])))
        print()
        print("   ⭐ 在它们补齐之前，host.py 换不掉 shim.py —— 不是「大概不行」，")
        print("     是上面每一条都对应 /tts 上一道具体的闸，缺一条少一道。")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
