#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""measure_shim_split —— shim.py 里有多少是「样板」，多少是「这台引擎」。

为什么要这把尺子
----------------
契约 §12 第 2 步「通用引擎宿主」的验收判据只有一句话：
「IndexTTS2 的 523 行缩到零」。

砍之前得先知道：那 523 行里，有多少是**每台引擎逐字一样**的（这部分搬进
lib/ 一份就完），有多少是**这台引擎特有**的（这部分要变成名片上的字段），
以及最要紧的 —— 特有的那部分里，**有没有 §5.2 的 call.* 表达不了的**。
表达不了的那些就是契约的缺口，得先补契约再动手。

判据（⛔ 不是数关键字，是解析）
------------------------------
用 ast 解析，**判定单位是语句不是行**。一条语句被判「引擎特有」当且仅当
它的子树里引用了「上游名字」：

  上游名字 = 本文件 import 进来的、不属于标准库的模块及其绑定名
             （标准库清单取自 sys.stdlib_module_names，不是我列的）
           + 由 `X = <上游名字>(...)` 直接构造出来的属性（一轮定点传播）

三个桶（⛔ 不是二分 —— 二分会把「样板里印着引擎名」误判成引擎逻辑）：
  ENGINE  引擎逻辑    语句引用了上游名字
  NAMED   样板带名字  没引用上游名字，但字面量里有引擎 id / 类名
  GENERIC 纯样板      两者都不是

已知边界（老实写在这，别当它没有）：
  - 污点传播只认「直接构造」这一种形态（`self.tts = IndexTTS2(...)`）。
    `str(getattr(self.tts, 'device'))` 不传播 —— 否则日志行会被算成引擎逻辑。
  - 注释与空行不进任何桶，单列。分母是**代码行**。
  - NAMED 桶是「宿主接一个参数就能吃掉」的量，不是「必须重写」的量。

退出码：0 正常 / 1 自检失败 / 2 解析失败
"""

import ast
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

ENGINES_DIR = os.path.join(ROOT, "engines")

# ---------------------------------------------------------------------------
#  标准库清单 —— 优先用解释器自己的，拿不到才退回硬清单并明说
# ---------------------------------------------------------------------------
_STDLIB_FALLBACK = frozenset("""
abc argparse ast asyncio base64 binascii bisect builtins bz2 calendar collections
concurrent configparser contextlib copy csv ctypes datetime decimal difflib dis
enum errno faulthandler filecmp fnmatch fractions functools gc getopt getpass glob
gzip hashlib heapq hmac html http imaplib importlib inspect io ipaddress itertools
json keyword linecache locale logging lzma marshal math mimetypes mmap multiprocessing
numbers operator os pathlib pickle pkgutil platform plistlib pprint queue quopri
random re reprlib runpy sched secrets select selectors shelve shlex shutil signal
site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep
struct subprocess symtable sys sysconfig tarfile tempfile textwrap threading time
timeit token tokenize traceback types typing unicodedata unittest urllib uuid
warnings wave weakref webbrowser xml zipfile zlib
""".split())


def stdlib_names():
    names = getattr(sys, "stdlib_module_names", None)
    if names:
        return set(names), "sys.stdlib_module_names（解释器自带）"
    return set(_STDLIB_FALLBACK), "内置硬清单（解释器太老，没有 stdlib_module_names）"


# ---------------------------------------------------------------------------
#  §5.2 / §5.4 / §5.6 契约里给引擎特有事实准备的落点
#  ⭐ 这张表是「契约写了什么」，不是「我觉得应该有什么」。改契约才改它。
# ---------------------------------------------------------------------------
CONTRACT_HOMES = [
    ("call.module", "从哪个模块拿类", "§5.2"),
    ("call.class", "拿哪个类", "§5.2"),
    ("call.init_args", "构造它的时候给什么", "§5.2"),
    ("call.method", "合成方法叫什么", "§5.2"),
    ("call.bind", "文本/参考音频/输出路径在这台引擎里叫什么", "§5.2"),
    ("call.returns", "结果是写文件还是返回字节", "§5.2"),
    ("call.argv", "cli 形态的命令行", "§5.3"),
    ("call.cwd", "在哪个目录下跑", "§5.3"),
    ("params.load_time", "开机时给、改了要重启的参数", "§5.4"),
    ("params.call_time", "每次合成给的参数", "§5.4"),
    ("params.schema", "每个参数长什么样", "§5.4"),
]

HOME_KEYS = frozenset(k for k, _, _ in CONTRACT_HOMES)


def home_of(*keys):
    """把一条事实安置到契约的落点上。

    ⛔ 落点名必须在 CONTRACT_HOMES 里真的存在 —— 否则返回 None（＝无家）。
    这一条让 CONTRACT_HOMES 变成**带电的**：契约里删掉一个字段，这里立刻
    有事实掉进「没家」。不这么写，那张表就是摆设（我刚在名片模板上清过一遍
    这种死数据，不该在自己的工具里再长一份）。
    """
    missing = [k for k in keys if k not in HOME_KEYS]
    if missing:
        return None
    return " + ".join(keys)

# 平台自己认领、名片没资格声明的（§5.6）—— 落到这里也算「有家」
PLATFORM_OWNED = [
    ("§5.6-1 音频格式", "平台内部一律 16 位 PCM WAV，引擎给别的平台负责转"),
    ("§5.6-2 并发", "同一块显卡上的推理由平台排队，引擎不用自己加锁"),
    ("§5.6-3 重试与超时", "名片只声明 timeout_ms，怎么重试是平台的事"),
]


# ---------------------------------------------------------------------------
#  解析
# ---------------------------------------------------------------------------
def attr_root(node):
    """取 a.b.c 的最左名字；取不到返回 None。"""
    while isinstance(node, ast.Attribute):
        node = node.value
    if isinstance(node, ast.Name):
        return node.id
    return None


def dotted(node):
    """把 a.b.c 还原成字符串；还原不了返回 None。"""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def collect_upstream_names(tree, stdlib):
    """本文件 import 进来的非标准库名字（模块名 + 绑定名）。"""
    upstream = set()
    modules = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                top = a.name.split(".")[0]
                if top in stdlib:
                    continue
                bound = a.asname or top
                upstream.add(bound)
                modules.setdefault(a.name, []).append(bound)
        elif isinstance(node, ast.ImportFrom):
            if node.level:          # 相对 import：本项目自己的，不算上游
                continue
            top = (node.module or "").split(".")[0]
            if not top or top in stdlib:
                continue
            for a in node.names:
                bound = a.asname or a.name
                upstream.add(bound)
                modules.setdefault("%s.%s" % (node.module, a.name), []).append(bound)
    return upstream, modules


BODY_FIELDS = ("body", "orelse", "finalbody", "handlers")


def header_nodes(stmt):
    """只要这条语句的「抬头」，不要它的子语句体。

    ⛔ 不这么做的话，`class Handler:` 这一行会因为类体里有上游调用而被判成
    引擎逻辑 —— 一个 class 头就能把整个文件染红。
    """
    out = []
    for field, value in ast.iter_fields(stmt):
        if field in BODY_FIELDS:
            continue
        if isinstance(value, list):
            out.extend(v for v in value if isinstance(v, ast.AST))
        elif isinstance(value, ast.AST):
            out.append(value)
    return out


def longest_upstream_prefix(dotted_name, names):
    """a.b.c 里最长的、在 names 里的前缀。没有则 None。"""
    if not dotted_name:
        return None
    parts = dotted_name.split(".")
    for i in range(len(parts), 0, -1):
        cand = ".".join(parts[:i])
        if cand in names:
            return cand
    return None


def stmt_refs(stmt, names):
    """这条语句的**抬头**里有没有引用 names 里的名字。"""
    for top in header_nodes(stmt):
        for node in ast.walk(top):
            if isinstance(node, ast.Name) and node.id in names:
                return True
            if isinstance(node, ast.Attribute):
                if longest_upstream_prefix(dotted(node), names):
                    return True
    return False


def propagate_taint(tree, upstream):
    """`X = <上游名>(...)` ⇒ X 也算上游。只认直接构造，跑到不动为止。"""
    changed = True
    rounds = 0
    while changed and rounds < 10:
        changed = False
        rounds += 1
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not isinstance(node.value, ast.Call):
                continue
            root = attr_root(node.value.func) or dotted(node.value.func)
            if root not in upstream:
                continue
            for tgt in node.targets:
                d = dotted(tgt) if isinstance(tgt, ast.Attribute) else (
                    tgt.id if isinstance(tgt, ast.Name) else None)
                if d and d not in upstream:
                    upstream.add(d)
                    changed = True
    return upstream


def code_lines_of(stmt):
    """这条语句自己占的行 —— ⛔ 不含它的子语句体（否则 class/def 会吞掉全文件）。"""
    body_starts = []
    for field in ("body", "orelse", "finalbody", "handlers"):
        for sub in getattr(stmt, field, []) or []:
            if hasattr(sub, "lineno"):
                body_starts.append(sub.lineno)
    end = getattr(stmt, "end_lineno", stmt.lineno) or stmt.lineno
    if body_starts:
        end = min(min(body_starts) - 1, end)
    return list(range(stmt.lineno, max(stmt.lineno, end) + 1))


def iter_stmts(node):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.stmt):
            yield child
            for sub in iter_stmts(child):
                yield sub


def is_docstring(stmt):
    return (isinstance(stmt, ast.Expr)
            and isinstance(stmt.value, ast.Constant)
            and isinstance(stmt.value.value, str))


def literal_has(stmt, needles):
    for top in header_nodes(stmt):
        for node in ast.walk(top):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                low = node.value.lower()
                if any(n in low for n in needles):
                    return True
    return False


# ---------------------------------------------------------------------------
#  一台引擎
# ---------------------------------------------------------------------------
def analyse(shim_path, engine_id, manifest, stdlib):
    src = io.open(shim_path, encoding="utf-8").read()
    tree = ast.parse(src, filename=shim_path)
    total_lines = src.count("\n") + (0 if src.endswith("\n") else 1)

    upstream, modules = collect_upstream_names(tree, stdlib)
    upstream = propagate_taint(tree, set(upstream))

    needles = {engine_id.lower()}
    if manifest.get("id"):
        needles.add(str(manifest["id"]).lower())

    buckets = {"ENGINE": set(), "NAMED": set(), "GENERIC": set()}
    docstring_lines = set()
    engine_stmts = []

    for stmt in iter_stmts(tree):
        lines = code_lines_of(stmt)
        if is_docstring(stmt):
            docstring_lines.update(lines)
            continue
        if stmt_refs(stmt, upstream):
            buckets["ENGINE"].update(lines)
            engine_stmts.append(stmt)
        elif literal_has(stmt, needles):
            buckets["NAMED"].update(lines)
        else:
            buckets["GENERIC"].update(lines)

    # 一行可能同时落多个桶（一行多语句）；按 ENGINE > NAMED > GENERIC 定级
    buckets["NAMED"] -= buckets["ENGINE"]
    buckets["GENERIC"] -= buckets["ENGINE"] | buckets["NAMED"]
    covered = buckets["ENGINE"] | buckets["NAMED"] | buckets["GENERIC"]

    return {
        "path": shim_path,
        "engine_id": engine_id,
        "total_lines": total_lines,
        "buckets": {k: sorted(v) for k, v in buckets.items()},
        "docstring_lines": len(docstring_lines),
        "noncode_lines": total_lines - len(covered) - len(docstring_lines),
        "upstream_names": sorted(upstream),
        "modules": modules,
        "engine_stmts": engine_stmts,
        "src_lines": src.splitlines(),
    }


# ---------------------------------------------------------------------------
#  引擎事实 → 契约有没有家
# ---------------------------------------------------------------------------
def extract_facts(res):
    """从「引擎特有」的语句里，机械地抽出一条条事实，并问契约要不要得起。"""
    facts = []
    upstream = set(res["upstream_names"])
    seen = set()

    for stmt in res["engine_stmts"]:
        for top in header_nodes(stmt):
            for node in ast.walk(top):
                if not isinstance(node, ast.Call):
                    continue
                fname = dotted(node.func)
                if not fname:
                    continue
                owner = longest_upstream_prefix(fname, upstream)
                if not owner:
                    continue
                key = (fname, node.lineno)
                if key in seen:
                    continue
                seen.add(key)
                kwargs = sorted(k.arg for k in node.keywords if k.arg)

                if owner == fname and "." not in fname:
                    # 直接构造上游的类 —— §5.2 有 call.class / call.init_args
                    home = home_of("call.class", "call.init_args")
                else:
                    # 在上游对象上调方法：只有「合成方法」那一个有家，
                    # 是哪一个由 guess_synth_call 挑，别的一律没家。
                    home = None

                facts.append({
                    "what": "%s(%s)" % (fname, ", ".join(kwargs) if kwargs else ""),
                    "home": home,
                    "line": node.lineno,
                    "kwargs": kwargs,
                    "owner": owner,
                })

    # ⭐ import 有没有家，取决于它有没有被用来构造那个类。
    #   只为了「顺手调个全局函数」而 import 进来的（典型：torch / numpy），
    #   名片上没有任何字段能表达 —— 它们必须和用它们的那几行一起算无家。
    constructed = {f["owner"] for f in facts
                   if f["home"] and "call.class" in f["home"]}
    used_by = {}
    for f in facts:
        if not f["home"]:
            used_by.setdefault(f["owner"], []).append(f["line"])

    imports = []
    for full, bounds in sorted(res["modules"].items()):
        housed = any(b in constructed for b in bounds)
        prefix_of_class = any(
            full.split(".")[0] == c.split(".")[0] for c in constructed
        ) if constructed else False
        lines = sorted({ln for b in bounds for ln in used_by.get(b, [])})
        if housed:
            home = home_of("call.class")
        elif prefix_of_class and not lines:
            home = home_of("call.module")
        else:
            home = None
        if lines:
            tail = "   ⇒ 只被 L%s 用到" % ", L".join(str(x) for x in lines)
        elif home is None:
            tail = "   ⇒ 没有上游调用用到它（多半是诊断/取证行）"
        else:
            tail = ""
        imports.append({
            "what": "import %s%s" % (full, tail),
            "home": home,
            "line": None,
            "kwargs": [],
            "owner": bounds[0] if bounds else full,
        })
    return imports + facts


def guess_synth_call(facts):
    """挑出「合成方法」。

    ⭐ 判据不是「kwargs 最多」，而是**它挂在一个被构造出来的实例上**
      （owner 里带点 = 由 `self.x = 上游类(...)` 传播出来的）。
      拿 kwargs 数量当判据会被一个恰好参数多的全局函数骗过去。
    """
    best = None
    for f in facts:
        if f["home"] is not None:
            continue
        if "." not in (f.get("owner") or ""):
            continue
        if best is None or len(f["kwargs"]) > len(best["kwargs"]):
            best = f
    return best


# ---------------------------------------------------------------------------
#  自检
# ---------------------------------------------------------------------------
FIXTURE = '''\
import os
import mypkg
from mypkg.deep import Thing

BANNER = "[mything-shim]"

class Holder:
    def load(self):
        self.obj = Thing(a=1, b=2)

    def go(self, text):
        return self.obj.run(prompt=text)

def helper(x):
    return os.path.basename(x)
'''


def selftest(stdlib):
    rows = []

    def ok(cond, label, extra=""):
        rows.append((bool(cond), label, extra))

    tmp = os.path.join(HERE, "_selftest_shim.py")
    io.open(tmp, "w", encoding="utf-8").write(FIXTURE)
    try:
        res = analyse(tmp, "mything", {"id": "mything"}, stdlib)
        b = res["buckets"]
        ok("mypkg" in res["upstream_names"], "非标准库 import 被认成上游名字")
        ok("os" not in res["upstream_names"], "标准库 import 不算上游名字")
        ok("self.obj" in res["upstream_names"],
           "污点传播：self.obj = Thing(...) ⇒ self.obj 也算上游")
        ok(9 in b["ENGINE"], "构造上游类那行进 ENGINE 桶")
        ok(12 in b["ENGINE"], "在上游对象上调方法那行进 ENGINE 桶")
        ok(5 in b["NAMED"], "只是字面量带引擎名的行进 NAMED 桶，不进 ENGINE")
        ok(15 in b["GENERIC"], "只用标准库的行进 GENERIC 桶")
        ok(7 not in b["ENGINE"] and 7 not in b["NAMED"],
           "class 头不吞掉整个类体（否则全文件都会变成一个桶）")
        facts = extract_facts(res)
        homeless = [f for f in facts if f["home"] is None]
        ok(any("run" in f["what"] for f in homeless),
           "上游对象上的方法调用会被列成待判事实")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    ok(not os.path.exists(tmp), "自检夹具已清理", tmp)
    return rows


# ---------------------------------------------------------------------------
def find_shims():
    out = []
    if not os.path.isdir(ENGINES_DIR):
        return out
    for name in sorted(os.listdir(ENGINES_DIR)):
        if name.startswith("_") or name.startswith("."):
            continue
        d = os.path.join(ENGINES_DIR, name)
        if not os.path.isdir(d):
            continue
        shim = os.path.join(d, "shim.py")
        if os.path.isfile(shim):
            mf = os.path.join(d, "manifest.json")
            man = {}
            if os.path.isfile(mf):
                try:
                    man = json.loads(io.open(mf, encoding="utf-8").read())
                except ValueError:
                    man = {}
            out.append((name, shim, man))
    return out


def bar(n, total, width=44):
    if total <= 0:
        return ""
    filled = int(round(width * n / float(total)))
    return "█" * filled + "·" * (width - filled)


def main():
    print("measure_shim_split —— shim.py 有多少是样板，多少是这台引擎")
    print("项目根：%s" % ROOT)
    print("=" * 74)

    stdlib, stdlib_src = stdlib_names()
    print("\n标准库清单来源：%s（%d 个）" % (stdlib_src, len(stdlib)))

    print("\n[自检]")
    rows = selftest(stdlib)
    bad = 0
    for good, label, extra in rows:
        print("   %-5s %s%s" % ("ok" if good else "FAIL", label,
                                ("   " + extra) if extra else ""))
        if not good:
            bad += 1
    print("\n   自检：%d ok / %d FAIL" % (len(rows) - bad, bad))
    if bad:
        print("\n⛔ 自检没过，下面的数一个都别信。")
        return 1

    shims = find_shims()
    if not shims:
        print("\n⚠ engines/ 下没有任何 shim.py —— 要么宿主已经建好了（那就是好消息），")
        print("  要么这不是项目根。没有可量的东西，退出。")
        return 0

    grand = {"ENGINE": 0, "NAMED": 0, "GENERIC": 0}
    for engine_id, shim, man in shims:
        res = analyse(shim, engine_id, man, stdlib)
        b = res["buckets"]
        code_total = sum(len(v) for v in b.values())
        print("\n" + "=" * 74)
        print("[1] %s   %s" % (engine_id, os.path.relpath(shim, ROOT)))
        print("    全文 %d 行 = 代码 %d + 文档字符串 %d + 注释/空行 %d"
              % (res["total_lines"], code_total,
                 res["docstring_lines"], res["noncode_lines"]))
        print()
        for key, label in (("GENERIC", "纯样板    每台引擎逐字一样"),
                           ("NAMED", "样板带名字 宿主接个参数就能吃掉"),
                           ("ENGINE", "引擎逻辑  只有这些是这台引擎的")):
            n = len(b[key])
            grand[key] += n
            pct = (100.0 * n / code_total) if code_total else 0
            print("    %-9s %4d 行  %5.1f%%  %s" % (key, n, pct, bar(n, code_total)))
            print("              %s" % label)

        print("\n    上游名字（判据的源头，可复核）：%s"
              % ", ".join(res["upstream_names"]))

        print("\n[2] 引擎特有的事实，契约 §5 有没有地方放")
        facts = extract_facts(res)
        synth = guess_synth_call(facts)
        if synth:
            synth["home"] = home_of("call.method", "call.bind")
        housed = [f for f in facts if f["home"]]
        homeless = [f for f in facts if not f["home"]]

        print("\n    ✅ 有家的（宿主读名片就能复现）：%d 条" % len(housed))
        for f in housed:
            where = ("  L%s" % f["line"]) if f["line"] else ""
            print("       %-46s → %s%s" % (f["what"][:46], f["home"], where))

        print("\n    ⛔ 没家的（§5.2/§5.3/§5.4 都放不下）：%d 条" % len(homeless))
        if not homeless:
            print("       （没有 —— 这台引擎能被名片完整表达）")
        for f in homeless:
            src = res["src_lines"][f["line"] - 1].strip() if f["line"] else ""
            tag = ("L%-5s" % f["line"]) if f["line"] else "      "
            print("       %s %s" % (tag, f["what"][:60]))
            if src:
                print("              %s" % src[:66])

        print("\n    平台自己认领、名片无权声明的（§5.6）：")
        for name, why in PLATFORM_OWNED:
            print("       %-16s %s" % (name, why))

    print("\n" + "=" * 74)
    print("[3] 结账")
    tot = sum(grand.values())
    if tot:
        print("    宿主建好后能删掉的：GENERIC %d + NAMED %d = %d 行（占代码 %.1f%%）"
              % (grand["GENERIC"], grand["NAMED"],
                 grand["GENERIC"] + grand["NAMED"],
                 100.0 * (grand["GENERIC"] + grand["NAMED"]) / tot))
        print("    要变成名片字段的：ENGINE %d 行（占代码 %.1f%%）"
              % (grand["ENGINE"], 100.0 * grand["ENGINE"] / tot))
    print()
    print("⚠ 这把尺子量的是「引不引用上游名字」，不是「难不难搬」。")
    print("  GENERIC 里也可能有极难搬的（比如洗 sys.path 的时机）。")
    print("⚠ 没家的那几条才是要拿去改契约的 —— 那是本脚本唯一的产出，别只看行数。")
    print("本脚本没有改过任何产品代码，也没有在 engines/ 下留任何东西。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SyntaxError as exc:
        sys.stderr.write("⛔ 解析失败：%s\n" % exc)
        sys.exit(2)
