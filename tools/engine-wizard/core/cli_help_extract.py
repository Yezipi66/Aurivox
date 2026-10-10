#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
CLI 官方原话提取器 —— Python 侧。

从上游引擎的 argparse CLI 源码里抓出**每一个** `add_argument` 的：
    flag / dest / help= 原话 / required= / default= / choices= / action= / type= / metavar=
以及它挂在哪个子命令下（add_parser 的名字）。

stdout: 一行 JSON
    {"ok": true, "sources": [{file, ok, error, count}], "flags": [...]}
    {"ok": false, "error": "..."}

⛔⛔ 三条纪律（违反即返工）
————————————————————————————————————————————————————————————
1. **不猜哪个 CLI 参数对应哪个函数签名参数。**
   [实测] 签名 `emo_vector` ⇔ CLI `--emotion-vector`、`spk_audio_prompt` ⇔ `--voice`、
   `emo_alpha` ⇔ `--emotion-weight`。直接同名只对上 3/14，归一化后仍是 3/14 ——
   差异是整个词不同，不是连字符。⇒ 对应关系由**上游自己声明**（infer_kwargs 赋值
   或 help 里的 "mapped to X"）才算，平台一律不猜。
   ⇒ 本脚本只负责「整份摊开」，**不做任何配对**。配对那一半在 Node 侧
     （exactMatchFor：仅直接同名，归一化后逐字相同）。

2. **help= 原话逐字递出，⛔ 不翻译、不改写、不缩写、不补标点。**

3. **一条 flag 都不删。** 工具层的 `--batch-file` / `--concat` / `--dry-run`
   照实列出（带 subcommand 名），让用户自己判断。⛔ 不许平台替他删。

⭐ 为什么用 Python 的 ast 而不是正则或 JS 的 AST（2026-10-09 实测）
    `help=` 常常换行写到 `add_argument(` 的下一行，单行正则只会看到第一个参数；
    而 @babel/parser 是 **JavaScript** 解析器，Python 的 `import argparse`
    它当成 ESM 语句，报 "Unexpected token, expected \"from\""。
    ⇒ Python 源码必须用 Python 自己的 ast 模块读。这与 lib/engines/reflect_params.py
      是同一条架构纪律。
"""

from __future__ import print_function

import argparse
import ast
import json
import os
import sys

# ⛔ 与 reflect_params.py 同一条：退出码永远是 0。
#   「抓不到」是一个**答案**（ok=false），不是探针出事 —— 调用方要能区分
#   「这台引擎的 CLI 解析不了」和「探针自己没跑起来」。
BANNER = "[clihelp]"


# ---------------------------------------------------------------------------
#  静态字面量求值 —— ⛔ 只求值，不猜测
# ---------------------------------------------------------------------------
def _literal(node):
    """把一个 AST 节点求成 Python 字面量；求不出来返回 None（不猜）。"""
    if node is None:
        return None
    if isinstance(node, ast.Constant):          # py3.8+
        return node.value
    if hasattr(ast, "Str") and isinstance(node, ast.Str):     # 老版本兼容
        return node.s
    if hasattr(ast, "Num") and isinstance(node, ast.Num):
        return node.n
    if hasattr(ast, "NameConstant") and isinstance(node, ast.NameConstant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _literal(node.operand)
        if v is None:
            return None
        return -v if isinstance(node.op, ast.USub) else +v
    if isinstance(node, (ast.List, ast.Tuple)):
        out = []
        for el in node.elts:
            v = _literal(el)
            if v is None:
                return None
            out.append(v)
        return out
    # ⛔ f-string（JoinedStr）/ Name / BinOp / 函数调用 ⇒ 一律不求值。
    #    求不出来的东西填一个「看着合理」的值 = 平台替上游编内容。
    return None


def _kw(call, name):
    """取 add_argument(...) 上某个关键字参数的 AST 节点。"""
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def _kw_str(call, name):
    node = _kw(call, name)
    if node is None:
        return None
    v = _literal(node)
    return None if v is None else str(v)


def _callee_name(call):
    """取被调用函数的名字（add_argument / add_parser / add_subparsers）。"""
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return ""


# ---------------------------------------------------------------------------
#  dest —— 官方 argparse 的 dest 推导规则（⛔ 逐字照搬，不是平台发明）
# ---------------------------------------------------------------------------
def _dest_from(flags, is_option):
    """
    argparse 的 dest 规则：
      有 long option（--xxx）⇒ 取第一个 long option 去前缀、**连字符转下划线**
      只有 short option（-x） ⇒ 取短字母（argparse 就是这么干的）
      positional              ⇒ 名字本身，连字符转下划线
    显式 dest= 优先（在调用处处理）。

    ⚠⚠ 连字符转下划线这一步**必须做**（2026-10-09 实测踩过，两处都要）：
       `--emotion-vector` 的 dest 是 `emotion_vector`，不是 `emotion-vector`。
       漏了它的后果不是报错，而是**静默错配** —— 反射出来的签名参数
       `emo_vector` 与 `emotion-vector` 归一化后对不上，于是「直接同名」那条
       唯一允许的自动贴永远不生效，而看输出又像是「上游没给同名的」。
       两道分支（long option 与 positional）都要转，⛔ 只转一道照样漏。
    ⚠ `--no-foo`（BooleanOptionalAction）的 dest 仍是 `foo`，`--no-` 是动作
       生成的反向开关，⛔ 不是另一个 dest。
    """
    if is_option:
        longs = [f for f in flags if f.startswith("--")]
        if longs:
            bare = longs[0][2:]
            if bare.startswith("no-"):
                bare = bare[3:]
            return bare.replace("-", "_")
        shorts = [f for f in flags if f.startswith("-")]
        if shorts:
            return shorts[0][1:]
    first = flags[0] if flags else None
    return None if first is None else first.replace("-", "_")


def _one(call):
    """把一个 add_argument(...) 调用转成一条记录。⛔ 求不出来的字段留 null。"""
    args = []
    for a in call.args:
        if isinstance(a, ast.Starred):
            return None                      # ⛔ 摊开的参数列表不猜
        v = _literal(a)
        if v is None:
            return None                      # 变量名 / f-string ⇒ 整条跳过
        args.append(v)
    if not args:
        return None

    flags = [str(a) for a in args]
    is_option = flags[0].startswith("-")

    dest = _kw_str(call, "dest")
    if not dest:
        dest = _dest_from(flags, is_option)
    if not dest:
        return None
    help_node = _kw(call, "help")
    help_text = _literal(help_node) if help_node is not None else None
    if help_text is not None:
        help_text = str(help_text)

    required = _literal(_kw(call, "required")) if _kw(call, "required") is not None else None
    default = _literal(_kw(call, "default")) if _kw(call, "default") is not None else None

    choices = _literal(_kw(call, "choices")) if _kw(call, "choices") is not None else None
    if not isinstance(choices, (list, tuple)):
        choices = None

    # action= / type= 常是 Identifier（argparse.BooleanOptionalAction）或 Attribute，
    # 但**最常见的是字符串常量**（action="store_true"）—— 漏了它，开关型 flag
    # 会被当成带值型，拼出来的命令行把 store_true 变成 "--force True"，上游报错。
    action_node = _kw(call, "action")
    action = None
    if action_node is not None:
        if isinstance(action_node, ast.Name):
            action = action_node.id
        elif isinstance(action_node, ast.Attribute):
            action = action_node.attr
        elif isinstance(action_node, ast.Constant) and isinstance(action_node.value, str):
            action = action_node.value

    type_node = _kw(call, "type")
    type_name = None
    if type_node is not None:
        if isinstance(type_node, ast.Name):
            type_name = type_node.id
        elif isinstance(type_node, ast.Attribute):
            type_name = type_node.attr

    metavar = _kw_str(call, "metavar")

    return {
        "dest": dest,
        "flags": flags,
        "is_option": is_option,
        # ⭐ 官方原话：逐字递出，⛔ 不改写不翻译
        "help": help_text,
        "required": required is True,
        "default": default,
        "choices": list(choices) if choices else None,
        "action": action,
        "type": type_name,
        "metavar": metavar,
    }


# ---------------------------------------------------------------------------
#  遍历 AST
# ---------------------------------------------------------------------------
class _Collector(ast.NodeVisitor):
    """
    ⭐ 为什么要维护 subcommand 栈：上游 CLI 一个入口底下挂着好几个子命令
       （init / config / download / check / batch / concat / synth…），同一个
       `--device` 在不同子命令里的 help 可能不同。摊开给用户时不带子命令名，
       用户不知道照哪条敲。⛔ 上游有几个就列几个，不合并去重。

    ⚠ 两种写法都要认（2026-10-09 实测两种上游都有）：
       · `synth = subparsers.add_parser("synth", help=...)` 之后
         `synth.add_argument("--text", help="...")`          ← 最常见
       · `subparsers.add_parser("synth").add_argument(...)`  ← 链式，少见
       第一种的两个语句**在同一层**，按 AST 访问顺序会让 add_parser 的
       栈在第二条语句之前就 pop 掉了。⇒ 必须先扫一遍赋值，建立
       「变量名 → 子命令名」的表（parser_vars），再按 base 名认子命令。
    ⚠ `add_subparsers(...)` 自己不产生子命令名 ⇒ 不进栈，只继续下潜。
    """

    def __init__(self, parser_vars=None):
        self.flags = []
        self.stack = []
        # var name → subcommand name。由 main() 在遍历前扫一遍赋值得到。
        self.parser_vars = parser_vars or {}

    def visit_Call(self, node):
        name = _callee_name(node)
        if name == "add_argument" and node.args:
            row = _one(node)
            if row:
                row["subcommand"] = self._subcommand_of(node)
                self.flags.append(row)
            self.generic_visit(node)
            return
        if name == "add_parser":
            # 链式写法（add_parser(...).add_argument(...)）：栈带着下潜
            first = node.args[0] if node.args else None
            nm = _literal(first)
            pushed = None if nm is None else str(nm)
            if pushed:
                self.stack.append(pushed)
            self.generic_visit(node)
            if pushed:
                self.stack.pop()
            return
        # add_subparsers / ArgumentParser / 其它调用 ⇒ 只是继续下潜，不进栈
        self.generic_visit(node)

    def _subcommand_of(self, call):
        """这条 add_argument 挂在哪个子命令下（认不出就返回 null，⛔ 不猜）。"""
        # ① 变量名认：`synth.add_argument(...)` ⇒ synth → 'synth'
        base = call.func
        if isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name):
            v = self.parser_vars.get(base.value.id)
            if v:
                return v
        # ② 链式栈：`subparsers.add_parser('synth').add_argument(...)`
        if self.stack:
            return " ".join(self.stack)
        # ③ 挂在根 parser 上（顶层级 flag）⇒ null，那是事实不是猜
        return None


def _scan_parser_vars(tree):
    """
    ⭐ 预扫一遍：建立「变量名 → 子命令名」的表。

    为什么需要（2026-10-09 实测）：上游最常这么写
        synth = subparsers.add_parser("synth", help="Synthesize one text input")
        synth.add_argument("--text", help="Text to synthesize")
    这两条语句**在同一层**，靠栈跟踪根本接不上 —— add_parser 的栈在第二条
    语句开始之前就 pop 了。⇒ 先把所有 `X = *.add_parser("name", ...)` 扫成表。

    ⛔ 只认**字面量子命令名**。`add_parser(name_var)` 这种 ⇒ 不进表，
       那条 flag 的 subcommand 就是 null（如实说认不出，⛔ 不猜）。
    """
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        call = node.value
        if not isinstance(call, ast.Call) or _callee_name(call) != "add_parser":
            continue
        if not call.args:
            continue
        nm = _literal(call.args[0])
        if nm is None:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                out[target.id] = str(nm)
    return out


def _parse_file(path):
    """
    解析一份 Python 源码。
    ⚠ 读不到 / 语法不认（py3.10+ 的 match / walrus、上游用了老语法）⇒
       如实报 ok:false，⛔ 不许正则硬抓出半份结果（那会把「抓全了」说成真的）。
    """
    try:
        # ⚠ errors='replace'：上游源码里可能有 GBK 编码的中文注释，
        #   硬解会 UnicodeDecodeError 整份丢掉。替换掉的那些字符不在 flag 里。
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    except Exception as exc:                                  # noqa: BLE001
        return {"flags": [], "ok": False, "error": "读不到文件：%s" % exc}
    try:
        tree = ast.parse(src, filename=path)
    except SyntaxError as exc:
        return {"flags": [], "ok": False,
                "error": "解析失败（%s，第 %s 行）" % (exc.msg, exc.lineno)}
    except Exception as exc:                                  # noqa: BLE001
        return {"flags": [], "ok": False, "error": "解析失败：%s" % exc}
    col = _Collector(_scan_parser_vars(tree))
    col.visit(tree)
    return {"flags": col.flags, "ok": True, "error": None}


# ---------------------------------------------------------------------------
#  候选 CLI 文件名（与 Node 侧 cliHelp.js 的 CLI_CANDIDATES 保持一致）
# ---------------------------------------------------------------------------
DEFAULT_CANDIDATES = [
    "cli.py", "cli_v2.py", "cli2.py", "main.py",
    "infer.py", "inference.py",
]

SKIP_DIRS = {
    "node_modules", "__pycache__", ".venv", "venv", "env",
    "build", "dist", "docs", "doc", "tests", "test", "testing",
    "examples", "notebooks", "assets", "static", "wheels",
    ".git", ".github", ".idea", ".vscode",
}
MAX_DEPTH = 4
MAX_FILES = 4000


def _find_cli_files(root, candidates):
    """① 固定清单（根目录 + 一层子目录）② 清单没命中时浅层递归兜底。"""
    found = []
    seen = set()

    def add(rel):
        full = os.path.join(root, rel)
        if not os.path.isfile(full):
            return
        key = os.path.normcase(os.path.abspath(full))
        if key in seen:
            return
        seen.add(key)
        found.append(rel)

    for c in candidates:
        add(c)
        sub = os.path.join(root, c)
        if os.path.isdir(sub):
            try:
                for f in sorted(os.listdir(sub)):
                    if f == c + ".py" or f == "cli.py":
                        add(os.path.join(c, f))
            except OSError:
                pass

    if found:
        return found

    # ② 兜底：只在浅层找，且只读文件头 4KB 判「像不像 argparse CLI」
    counter = [0]

    def rec(rel, depth):
        if depth > MAX_DEPTH or counter[0] > MAX_FILES:
            return
        full = os.path.join(root, rel) if rel else root
        try:
            entries = sorted(os.listdir(full))
        except OSError:
            return
        for name in entries:
            if counter[0] > MAX_FILES:
                return
            child = os.path.join(rel, name) if rel else name
            child_full = os.path.join(root, child)
            if os.path.isdir(child_full):
                if name in SKIP_DIRS or name.startswith("."):
                    continue
                counter[0] += 1
                rec(child, depth + 1)
            elif name.endswith(".py"):
                counter[0] += 1
                try:
                    with open(child_full, "r", encoding="utf-8", errors="replace") as fh:
                        head = fh.read(4096)
                except OSError:
                    continue
                if "add_argument(" in head:
                    add(child)

    rec("", 0)
    return found


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def main(argv):
    ap = argparse.ArgumentParser(description="Extract argparse help text from an engine CLI")
    ap.add_argument("--spec-file", required=True,
                    help="JSON spec file: {dir, candidates}")
    args = ap.parse_args(argv)

    try:
        with open(args.spec_file, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except Exception as exc:                                  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "读不到 spec：%s" % exc},
                         ensure_ascii=False))
        return

    root = spec.get("dir")
    candidates = spec.get("candidates") or DEFAULT_CANDIDATES
    if not root or not os.path.isdir(root):
        print(json.dumps({"ok": False, "error": "目录不存在：%r" % root},
                         ensure_ascii=False))
        return

    rels = _find_cli_files(root, candidates)
    if not rels:
        # ⭐ 「没找到 CLI」是一个**答案**，不是错误 ⇒ ok:true + 空 flags
        print(json.dumps({
            "ok": True,
            "sources": [],
            "flags": [],
            "note": "This engine directory has no CLI source "
                    "(no argparse add_argument found).",
        }, ensure_ascii=False))
        return

    sources = []
    flags = []
    for rel in rels:
        parsed = _parse_file(os.path.join(root, rel))
        sources.append({
            "file": rel.replace(os.sep, "/"),
            "ok": parsed["ok"],
            "error": parsed["error"],
            "count": len(parsed["flags"]),
        })
        for f in parsed["flags"]:
            f["source_file"] = rel.replace(os.sep, "/")
            flags.append(f)

    print(json.dumps({"ok": True, "sources": sources, "flags": flags},
                     ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])
