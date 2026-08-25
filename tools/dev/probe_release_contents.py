#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
probe_release_contents.py   [2026-08-20]   READ-ONLY PROBE

回答一个 `04_pack_release.py --dry-run` 不肯回答的问题：

    r12c 搬过去的 engines\\ 和 pipeline\\ 到底进没进发行包？

`--dry-run` 只打 26 行汇总（files / layers / 根目录文件），**没有逐文件明细**，
所以对 packdry.txt 做 grep 找不到 "engines/" —— 那是「文件里没写」，
不是「包里没有」。⛔ 这两件事必须分开，本探针就是来分开它们的。

做法：直接 import 打包器本体，调用它的 `collect_included()`（就是产出真包用的
那个函数），拿到**真实的应发文件清单**，再按顶层目录聚合。
⇒ 判据来自打包器自己，不是来自我对它的复述。

本脚本**只读**：不写任何文件、不建目录、不改环境。
`collect_included()` 内部只有 os.walk / os.path.getsize。

用法（PowerShell 或 cmd 均可，在项目根跑）：
    python probe_release_contents.py
    python probe_release_contents.py --selftest
    python probe_release_contents.py --list cache/      逐条列出某前缀下进包的文件
"""

import os
import sys
import importlib.util

MUST_SHIP = [
    ("server.js", "文件", "broker 主程序"),
    ("lib/", "目录", "我们自己的服务端代码"),
    ("web/dist/", "目录", "构建好的前端"),
    ("engines/gpt-sovits/", "目录", "⭐ r12c 搬家落点：活着的 TTS 引擎"),
    ("pipeline/uvr5/", "目录", "⭐ r12c 搬家落点：人声分离"),
    ("pipeline/asr/", "目录", "⭐ r12c 搬家落点：语音识别"),
    ("pipeline/slicer/", "目录", "⭐ r12c 搬家落点：切片"),
    ("tools/runtime/python/", "目录", "内嵌 Python"),
    ("tools/runtime/node/", "目录", "内嵌 Node"),
    ("data/training_defaults.json", "文件", "出厂默认参数（训练页）"),
    ("deploy.bat", "文件", "部署入口"),
]
# ⛔⛔ 2026-08-25：data/advanced_params.json 从 MUST_SHIP 挪到了 MUST_NOT_SHIP。
#    它不是出厂默认值，是**一台机器上界面最后拧到哪**的记忆（见
#    lib/advancedParams.js 2026-08-23 划的界）。发出去等于把某台开发机的
#    状态当成所有人的默认值。见下方 MUST_NOT_SHIP 里那一条。

# 每项 = (前缀, 说明, 豁免前缀元组)
#
# ⚠ 2026-08-20 自我更正：models/ 那一条我原本写成整棵禁运，据此报了「6 个泄漏」，
#   是我判错了。04_pack_release.py:139-141 的注释明写 models/ 刻意不整棵排除，
#   因为 models/tts/gpt-sovits/G2PWModel/ 里的多音字词典 download_models.py
#   不会重新下载（它只从官方 zip 里抽 g2pW.onnx），必须随包发。实测那 6 个
#   6/6 全在 G2PWModel/ 下、零个权重文件 ⇒ 打包器是对的。
#   改成带豁免的规则而不是整条删掉：这样将来真有 .pth 漏进 models/，照样报红。
MUST_NOT_SHIP = [
    ("vendor/gsv-tools/", "batch14 已归档到 ..\\junk\\", ()),
    ("vendor/gsv_code/", "batch14 已归档到 ..\\junk\\", ()),
    ("vendor/gsv-infer/", "batch14 已归档到 ..\\junk\\", ()),
    ("vendor/tts/", "r12c 已搬去 engines\\", ()),
    ("vendor/asr/", "r12c 已搬去 pipeline\\", ()),
    ("vendor/uvr5/", "r12c 已搬去 pipeline\\", ()),
    ("vendor/slicer/", "r12c 已搬去 pipeline\\", ()),
    ("GPT_SoVITS/", "顶层遗留权重树，batch14 已归档", ()),
    ("node_modules/", "部署时 npm ci，不进包", ()),
    ("models/", "权重不进包（G2PW 词典除外，见上方注释）",
     ("models/tts/gpt-sovits/G2PWModel/",)),
    ("cache/", "缓存与补丁备份（batch15 收口）", ()),
    ("tools/dev/", "助手产出的开发工具（batch15 收口）", ()),
    (".hermes/", "开发期工具状态（batch15 收口）", ()),
    ("tools/checks/", "孤儿检查脚本（batch15 已归档）", ()),
    # ⭐⭐ 反向断言（2026-08-25）：这条不是"清理垃圾"，是**防止一个已经发生过的
    #    bug 复发**。advanced_params.json 曾经在 MUST_SHIP 和打包器的 DATA_KEEP
    #    里，于是发行包里带着某台开发机 2026-08-20 的界面状态，当所有新装机器的
    #    出厂默认值 —— 实测盖掉了 6 个名片默认值（batch_size 名片 4 → 盘上 1，
    #    seed → 2769901998，version v2Pro → v2，is_half true → false）。
    #    ⇒ 光把它从 MUST_SHIP 删掉是不够的：那样谁把 DATA_KEEP 那行加回去，
    #      不会有任何东西报红。必须**翻成反向断言**。
    #    ⭐ 不发它是对的：盘上没有这个文件时，每个键都退回名片（契约 C11），
    #      lib/advancedParams.node.test.js 有一条测试钉着这件事。
    ("data/advanced_params.json",
     "界面记忆而非出厂默认值 —— 发出去会把一台机器的状态变成所有人的默认值", ()),
    ("outputs/", "产物", ()),
    ("logs/", "日志", ()),
    ("venv/", "开发机虚拟环境", ()),
    (".git/", "版本库", ()),
]


def find_root(start):
    """C7 上溯找 server.js。与 apply-r12c-batch* 同一套定位法。"""
    cur = os.path.abspath(start)
    for _ in range(7):
        if os.path.isfile(os.path.join(cur, "server.js")):
            return cur
        nxt = os.path.dirname(cur)
        if nxt == cur:
            break
        cur = nxt
    return None


def load_packer(root):
    """import 打包器本体。__name__ 不是 __main__，所以它的 main() 不会跑。"""
    build_dir = os.path.join(root, "tools", "build")
    packer = os.path.join(build_dir, "04_pack_release.py")
    if not os.path.isfile(packer):
        return None, "找不到 %s" % packer
    if build_dir not in sys.path:
        sys.path.insert(0, build_dir)     # 它要 import pack_common
    spec = importlib.util.spec_from_file_location("_pack_release_probe", packer)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:                # noqa: BLE001
        return None, "import 打包器失败：%s: %s" % (type(e).__name__, e)
    if not hasattr(mod, "collect_included"):
        return None, "打包器里没有 collect_included() —— 它改过了，本探针的判据失效"
    return mod, None


def norm(p):
    return p.replace("\\", "/")


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f%s" % (n, unit) if unit != "B" else "%dB" % n
        n /= 1024.0
    return "%.1fGB" % n


def hits(included, prefix):
    """prefix 以 / 结尾按目录前缀匹配，否则按整路径相等匹配。"""
    p = norm(prefix)
    if p.endswith("/"):
        return [r for r, _, _ in included if norm(r).startswith(p)]
    return [r for r, _, _ in included if norm(r) == p]


def selftest(included):
    """探针必须先证明自己会失败。⛔ 没有反例守卫的探针不算探针。"""
    ok = fail = 0

    def check(name, cond, why=""):
        nonlocal ok, fail
        if cond:
            ok += 1
            print("   ok    %s" % name)
        else:
            fail += 1
            print("   FAIL  %s   %s" % (name, why))

    check("清单非空", len(included) > 0, "collect_included 返回空 —— 后面所有判据都会假通过")

    # 反例：一个绝不可能存在的路径必须命中 0
    bogus = "engines/__this_must_not_exist__/"
    check("反例守卫：不存在的目录命中 0", len(hits(included, bogus)) == 0,
          "探针对不存在的路径也报命中 ⇒ 匹配逻辑坏了")

    # 正对照：server.js 一定在（否则不是这个项目）
    check("正对照：server.js 命中 1", len(hits(included, "server.js")) == 1,
          "连 server.js 都匹配不到 ⇒ 匹配逻辑坏了，此时「engines 没进包」是假警报")

    # 前缀匹配不能退化成子串匹配
    check("前缀匹配不是子串匹配",
          all(norm(r).startswith("lib/") for r in hits(included, "lib/")),
          "把路径中间含 lib/ 的也算进来了")

    # 目录前缀与文件路径两种模式必须表现不同
    check("目录模式与文件模式可区分",
          len(hits(included, "lib/")) > 1 and len(hits(included, "lib")) == 0,
          "'lib' 不带斜杠时应按整路径相等匹配，命中应为 0")

    # 聚合不丢件
    agg = {}
    for r, _, sz in included:
        agg[norm(r).split("/")[0]] = agg.get(norm(r).split("/")[0], 0) + 1
    check("按顶层聚合不丢件", sum(agg.values()) == len(included),
          "聚合后总数对不上")

    # ---- 豁免逻辑的反例守卫 ------------------------------------------------
    # models/ 那条带豁免。豁免最容易退化成「整条禁运形同虚设」，所以这里用
    # 两条假数据正反各验一次：豁免路径必须被放行，非豁免路径必须仍然报红。
    fake_ok = [("models/tts/gpt-sovits/G2PWModel/x.json", "", 1)]
    fake_bad = [("models/tts/gpt-sovits/v2Pro/s2G.pth", "", 1)]
    exempt = None
    for pfx, _why, ex in MUST_NOT_SHIP:
        if pfx == "models/":
            exempt = ex
    check("豁免规则存在且非空", bool(exempt), "models/ 的豁免元组丢了")
    if exempt:
        def leaked_under(sample):
            got = hits(sample, "models/")
            return [r for r in got if not any(norm(r).startswith(e) for e in exempt)]
        check("豁免正向：G2PWModel 词典被放行", len(leaked_under(fake_ok)) == 0,
              "该放行的没放行")
        check("豁免反向：models/ 下的 .pth 仍然报红", len(leaked_under(fake_bad)) == 1,
              "⛔ 豁免写太宽 ⇒ 整条 models/ 禁运形同虚设，权重泄漏将不再被发现")

    # ---- advanced_params.json 反向断言的验红 --------------------------------
    # ⛔⛔ 这条守卫拦的是**已经发生过**的 bug：那个文件曾经既在 MUST_SHIP 里、
    # 又在打包器的 DATA_KEEP 里，于是一台开发机 2026-08-20 的界面状态被当成
    # 出厂默认值发给所有人。守卫不验红就是摆设，所以这里用假数据正反各验一次。
    AP = "data/advanced_params.json"
    check("advanced_params 已不在 MUST_SHIP",
          not any(norm(p) == AP for p, _k, _w in MUST_SHIP),
          "⛔ 它又被当成「必须进包」了 —— 界面记忆不是出厂默认值")
    check("advanced_params 在 MUST_NOT_SHIP 里",
          any(norm(p) == AP for p, _w, _e in MUST_NOT_SHIP),
          "⛔ 反向断言没了 ⇒ 谁把打包器 DATA_KEEP 那行加回去都不会报红")
    ap_exempt = None
    for pfx, _why, ex in MUST_NOT_SHIP:
        if norm(pfx) == AP:
            ap_exempt = ex
    check("advanced_params 这条不带豁免", ap_exempt == (),
          "⛔ 加了豁免等于给它开后门")
    # 反向：假装它进了包，必须被判为泄漏
    check("验红：包里出现 advanced_params 就报泄漏",
          len(hits([(AP, "", 1)], AP)) == 1,
          "⛔ 它真进了包也不会被发现 —— 这条守卫是摆设")
    # 正对照：同目录下真正的出厂默认值不许被这条误伤
    check("正对照：training_defaults 不被这条误伤",
          len(hits([("data/training_defaults.json", "", 1)], AP)) == 0,
          "⛔ 匹配退化成了前缀/子串 ⇒ 会把真正该发的默认值也拦掉")

    print("\n   自检：%d ok / %d FAIL" % (ok, fail))
    return fail == 0


def main():
    print("probe_release_contents   [2026-08-20]   READ-ONLY PROBE")

    root = find_root(os.getcwd()) or find_root(os.path.dirname(os.path.abspath(__file__)))
    if not root:
        print("⛔ 从当前目录一路上溯都没看见 server.js。请在项目根目录运行。")
        return 2
    print("项目根：%s" % root)
    print("=" * 74)

    mod, err = load_packer(root)
    if err:
        print("⛔ %s" % err)
        return 2

    try:
        included = mod.collect_included(root)
    except Exception as e:                # noqa: BLE001
        print("⛔ collect_included() 抛异常：%s: %s" % (type(e).__name__, e))
        print("   这本身就是结论：打包器在当前盘面上跑不完。")
        return 2

    if "--selftest" in sys.argv:
        print("\n[自检]")
        return 0 if selftest(included) else 1

    if "--list" in sys.argv:
        i = sys.argv.index("--list")
        if i + 1 >= len(sys.argv):
            print("⛔ --list 后面要跟一个前缀，例如  --list cache/")
            return 2
        pref = norm(sys.argv[i + 1])
        rows = [(norm(r), sz) for r, _, sz in included
                if norm(r).startswith(pref) or norm(r) == pref]
        print("\n[--list %s] 命中 %d 个" % (pref, len(rows)))
        if not rows:
            print("   （零命中。⚠ 这可能是「确实没有」，也可能是前缀写错了——")
            print("     用一个你确定存在的前缀先自证一次，例如  --list lib/ ）")
        for r, sz in sorted(rows, key=lambda x: -x[1]):
            print("   %10s  %s" % (human(sz), r))
        print("\n本脚本没有写过任何文件。")
        return 0

    total = sum(sz for _, _, sz in included)
    print("\n[0] 打包器自报应发清单：%d 个文件 / %s" % (len(included), human(total)))
    print("    （这与 --dry-run 的 files/uncompressed 两个数应当一致；不一致说明盘面变了）")

    # ---- 1. 按顶层目录聚合 -------------------------------------------------
    agg = {}
    for r, _, sz in included:
        top = norm(r).split("/")[0] if "/" in norm(r) else "(根目录文件)"
        c, s = agg.get(top, (0, 0))
        agg[top] = (c + 1, s + sz)
    print("\n[1] 按顶层目录聚合")
    for top in sorted(agg, key=lambda k: -agg[k][1]):
        c, s = agg[top]
        print("   %-28s %6d 个  %10s" % (top, c, human(s)))

    # ---- 2. 必须进包 -------------------------------------------------------
    print("\n[2] 必须进包的东西（⭐ 是 r12c 搬家落点，这次要验的就是它们）")
    missing = []
    for prefix, kind, why in MUST_SHIP:
        n = len(hits(included, prefix))
        mark = "✅" if n > 0 else "⛔"
        if n == 0:
            missing.append(prefix)
        print("   %s %-30s %6d 个   %s" % (mark, prefix, n, why))

    # ---- 3. 不许进包 -------------------------------------------------------
    print("\n[3] 不许进包的东西")
    leaked = []
    for prefix, why, exempt in MUST_NOT_SHIP:
        got = hits(included, prefix)
        kept = [r for r in got
                if not any(norm(r).startswith(e) for e in exempt)]
        n, n_ex = len(kept), len(got) - len(kept)
        mark = "✅" if n == 0 else "⛔"
        note = why if not n_ex else ("%s  [豁免 %d 个]" % (why, n_ex))
        if n > 0:
            leaked.append((prefix, n))
        print("   %s %-30s %6d 个   %s" % (mark, prefix, n, note))

    # ---- 4. 分发层 ---------------------------------------------------------
    print("\n[4] 分发层（pack_common.classify_layer）")
    try:
        import pack_common
        lay = {}
        laysz = {}
        for r, _, sz in included:
            L = pack_common.classify_layer(r)
            lay[L] = lay.get(L, 0) + 1
            laysz[L] = laysz.get(L, 0) + sz
        for L in "ARWNM":
            if L in lay:
                print("   %s : %6d 个  %10s" % (L, lay[L], human(laysz[L])))
        # engines/ 与 pipeline/ 落在哪层
        for pref in ("engines/", "pipeline/"):
            sub = {}
            for r, _, _ in included:
                if norm(r).startswith(pref):
                    sub[pack_common.classify_layer(r)] = sub.get(pack_common.classify_layer(r), 0) + 1
            if sub:
                print("   %-12s -> %s" % (pref, ", ".join("%s:%d" % kv for kv in sorted(sub.items()))))
            else:
                print("   %-12s -> （零文件）" % pref)
    except Exception as e:                # noqa: BLE001
        print("   （pack_common 读不到：%s: %s）" % (type(e).__name__, e))

    # ---- 5. engines/ 逐引擎 ------------------------------------------------
    print("\n[5] engines\\ 逐引擎（判据：目录数 = 支持的引擎数）")
    eng = {}
    for r, _, sz in included:
        n = norm(r)
        if n.startswith("engines/"):
            parts = n.split("/")
            if len(parts) > 2:
                c, s = eng.get(parts[1], (0, 0))
                eng[parts[1]] = (c + 1, s + sz)
    if eng:
        for k in sorted(eng):
            print("   %-20s %6d 个  %10s" % (k, eng[k][0], human(eng[k][1])))
    else:
        print("   ⛔ engines\\ 下零文件进包")

    # ---- 6. 最大的 15 个 ---------------------------------------------------
    print("\n[6] 进包文件里最大的 15 个（人工扫一眼有没有不该在的）")
    for r, _, sz in sorted(included, key=lambda x: -x[2])[:15]:
        print("   %10s  %s" % (human(sz), norm(r)))

    # ---- 结论 --------------------------------------------------------------
    print("\n" + "=" * 74)
    if missing:
        print("⛔ 有 %d 项该进包却没进：%s" % (len(missing), "、".join(missing)))
    if leaked:
        print("⛔ 有 %d 项不该进包却进了：%s"
              % (len(leaked), "、".join("%s(%d)" % x for x in leaked)))
    if not missing and not leaked:
        print("✅ 必须进包的都在，不许进包的都不在。")
    print("本脚本没有写过任何文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
