#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从上游引擎的 argparse CLI 源码里提取官方原话。

逐个 add_argument 取出 flag、dest、help 原话、required、default、choices、action、
type、metavar，以及它挂在哪个子命令下（add_parser 的名字）。help 原话逐字递出，
不翻译、不改写、不缩写、不补标点；工具层自己的 flag（--batch-file、--concat、
--dry-run）也照实列出，不替用户删。

输出是一行 JSON：
    {"ok": true, "sources": [{file, ok, error, count}], "flags": [...]}
    {"ok": false, "error": "..."}

本脚本只负责把整份摊开，不做任何配对：哪个 CLI 参数对应哪个函数签名参数，必须由
上游自己声明（infer_kwargs 赋值，或 help 里写明 mapped to X），平台一律不猜。
配对那一半在 Node 侧（cliHelp.js 的 exactMatchFor，只认直接同名）。

用 Python 的 ast 而不是正则或 JavaScript 的解析器：help= 常常换行写到
add_argument( 的下一行，单行正则只会看到第一个参数；而 @babel/parser 是
JavaScript 解析器，Python 的 import argparse 它当成 ESM 语句就报解析错误。
⇒ Python 源码必须用 Python 自己的 ast 模块读。这与 lib/engines/reflect_params.py
是同一条架构纪律。
"""

from __future__ import print_function

import argparse
import ast
import json
import os
import sys

# 与 reflect_params.py 同一条：退出码永远是 0。
# 「抓不到」是一个答案（ok=false），不是探针出事：调用方要能区分
# 「这台引擎的 CLI 解析不了」和「探针自己没跑起来」。
BANNER = "[clihelp]"


# 静态字面量求值：只求值，不猜测
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
    # f-string（JoinedStr）、Name、BinOp 与函数调用一律不求值。
    # 求不出来的东西填一个「看着合理」的值，等于平台替上游编内容。
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


# dest：官方 argparse 的 dest 推导规则（逐字照搬，不是平台发明）
def _dest_from(flags, is_option):
    """
    argparse 的 dest 规则：
      有 long option（--xxx）：取第一个 long option 去前缀，连字符转下划线
      只有 short option（-x）：取短字母（argparse 就是这么干的）
      positional：名字本身，连字符转下划线
    显式 dest= 优先（在调用处处理）。

    连字符转下划线这一步必须做，两道分支都要做：
       `--emotion-vector` 的 dest 是 `emotion_vector`，不是 `emotion-vector`。
       漏了它的后果不是报错，而是静默错配：反射出来的签名参数
       `emo_vector` 与 `emotion-vector` 归一化后不匹配，于是「直接同名」那条
       唯一允许的自动贴永远不生效，而看输出又像是「上游没给同名的」。
       只转一道分支照样漏。
    `--no-foo`（BooleanOptionalAction）的 dest 仍是 `foo`，`--no-` 是动作
       生成的反向开关，不是另一个 dest。
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
    """把一个 add_argument(...) 调用转成一条记录。求不出来的字段留 null。"""
    args = []
    for a in call.args:
        if isinstance(a, ast.Starred):
            return None                      # 摊开的参数列表不猜
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

    # action= 与 type= 常是 Identifier（argparse.BooleanOptionalAction）或 Attribute，
    # 但最常见的是字符串常量（action="store_true"）。漏了它，开关型 flag
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
        # 官方原话：逐字递出，不改写不翻译
        "help": help_text,
        "required": required is True,
        "default": default,
        "choices": list(choices) if choices else None,
        "action": action,
        "type": type_name,
        "metavar": metavar,
    }


# 遍历 AST
class _Collector(ast.NodeVisitor):
    """
    为什么要维护 subcommand 栈：上游 CLI 一个入口底下挂着好几个子命令
       （init / config / download / check / batch / concat / synth 等），同一个
       `--device` 在不同子命令里的 help 可能不同。摊开给用户时不带子命令名，
       用户不知道照哪条敲。上游有几个就列几个，不合并去重。

    两种写法都要认：
       · `synth = subparsers.add_parser("synth", help=...)` 之后
         `synth.add_argument("--text", help="...")`          最常见
       · `subparsers.add_parser("synth").add_argument(...)`  链式，少见
       第一种的两个语句在同一层，按 AST 访问顺序会让 add_parser 的
       栈在第二条语句之前就 pop 掉了。⇒ 必须先扫一遍赋值，建立
       「变量名 → 子命令名」的表（parser_vars），再按 base 名认子命令。
    `add_subparsers(...)` 自己不产生子命令名，不进栈，只继续下潜。
    """

    def __init__(self, parser_vars=None):
        self.flags = []
        self.stack = []
        # 变量名 → 子命令名。由 main() 在遍历前扫一遍赋值得到。
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
        # add_subparsers、ArgumentParser 与其它调用只是继续下潜，不进栈。
        self.generic_visit(node)

    def _subcommand_of(self, call):
        """这条 add_argument 挂在哪个子命令下（认不出就返回 null，不猜）。"""
        # ① 变量名认：`synth.add_argument(...)` ⇒ synth → 'synth'
        base = call.func
        if isinstance(base, ast.Attribute) and isinstance(base.value, ast.Name):
            v = self.parser_vars.get(base.value.id)
            if v:
                return v
        # ② 链式栈：`subparsers.add_parser('synth').add_argument(...)`
        if self.stack:
            return " ".join(self.stack)
        # ③ 挂在根 parser 上（顶层级 flag）：null，那是事实不是猜
        return None


def _scan_parser_vars(tree):
    """
    预扫一遍：建立「变量名 → 子命令名」的表。

    为什么需要：上游最常这么写
        synth = subparsers.add_parser("synth", help="Synthesize one text input")
        synth.add_argument("--text", help="Text to synthesize")
    这两条语句在同一层，靠栈跟踪根本接不上：add_parser 的栈在第二条
    语句开始之前就 pop 了。⇒ 先把所有 `X = *.add_parser("name", ...)` 扫成表。

    只认字面量子命令名。`add_parser(name_var)` 这种不进表，
       那条 flag 的 subcommand 就是 null（如实说认不出，不猜）。
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


# ---- 非 argparse 的命令行框架 ---------------------------------------------
# 有的上游用 click / typer / fire 声明命令行。它们的参数不在 add_argument 里，
# 静态扫描一条都读不到，结果是「文件找到了、参数一个没有」，入口判定拿不到证据。
# 这里按各自的声明方式把开关读出来，产出的记录与 argparse 那条同形，
# 下游（cliDraft / entryPick）不需要知道来源。

def _tail_name(node):
    """调用或属性表达式的尾名：click.option -> option，typer.Option -> Option。"""
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return None


def _str_args(call):
    out = []
    for a in call.args:
        v = _literal(a)
        if isinstance(v, str):
            out.append(v)
    return out


def _flag_list(strings):
    return [s for s in strings if s.startswith("-")]


def _type_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_ellipsis(node):
    return isinstance(node, ast.Constant) and node.value is Ellipsis


def _record(flags, help_text=None, required=False, default=None, type_name=None, is_flag=False,
            action=None, negative=None, choices=None):
    """与 _one 同形的一条记录；某个字段求不出来时留 None，不猜。

    action 显式给了就用它：click 的 --x/--no-x 与 argparse 的 BooleanOptionalAction
      是同一件事，都靠这个词让下游写成 boolean_optional。
    negative 是上游自己写的否定式开关（--no-x）。界面把它显示出来给人核对，
      不在这里替上游拼。
    """
    if not flags:
        return None
    is_option = flags[0].startswith("-")
    dest = _dest_from(flags, is_option)
    if not dest:
        return None
    return {
        "dest": dest,
        "flags": flags,
        "is_option": is_option,
        "help": str(help_text) if help_text is not None else None,
        "required": bool(required),
        "default": default,
        "choices": list(choices) if choices else None,
        "action": action if action else ("store_true" if is_flag else None),
        "type": type_name,
        "metavar": None,
        "negative": negative,
    }


def _dual_flag(flags):
    """--x/--no-x 是同一个开关的两种拼法，拆成 (主开关, 否定式)；其余形状返回 None。

    click 的斜杠还有另一种含义（--upper/-U 那种是别名），所以只认
      「一边是 --x、另一边是 --no-x」这一种形状。认不出就原样留着，不猜。
    """
    if len(flags) != 1:
        return None
    parts = [p for p in str(flags[0]).split("/") if p]
    if len(parts) != 2 or not all(p.startswith("-") for p in parts):
        return None
    neg = [p for p in parts if p.startswith("--no-")]
    pos = [p for p in parts if not p.startswith("--no-")]
    if len(neg) != 1 or len(pos) != 1 or not pos[0].startswith("--"):
        return None
    return pos[0], neg[0]


def _click_choices(node):
    """click.Choice(["a", "b"]) 里的候选值。认不出返回 None。"""
    if not isinstance(node, ast.Call) or _tail_name(node) != "Choice" or not node.args:
        return None
    vals = _literal(node.args[0])
    if not isinstance(vals, (list, tuple)):
        return None
    out = [v for v in vals if isinstance(v, (str, int, float))]
    return out or None


def _click_records(tree):
    """@click.option("--text", "-t", required=True, help=...) 这种声明。"""
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if not isinstance(dec, ast.Call) or _tail_name(dec) != "option":
                continue
            flags = _flag_list(_str_args(dec))
            if not flags:
                continue
            kw = {k.arg: k.value for k in dec.keywords if k.arg}
            dual = _dual_flag(flags)
            if dual:
                flags = [dual[0]]
            rec = _record(
                flags,
                help_text=_literal(kw["help"]) if "help" in kw else None,
                required=(_literal(kw["required"]) is True) if "required" in kw else False,
                default=_literal(kw["default"]) if "default" in kw else None,
                type_name=_type_name(kw.get("type")),
                is_flag=(_literal(kw["is_flag"]) is True) if "is_flag" in kw else False,
                action="BooleanOptionalAction" if dual else None,
                negative=dual[1] if dual else None,
                choices=_click_choices(kw.get("type")),
            )
            if rec:
                out.append(rec)
    return out


def _typer_option_of(default_node):
    """默认值是 typer.Option(...) 或 typer.Argument(...) 时取那个调用。"""
    if isinstance(default_node, ast.Call) and _tail_name(default_node) in ("Option", "Argument"):
        return default_node
    return None


def _typer_annotated_of(annotation):
    """Annotated[str, typer.Option("--text")] 里的那个调用。"""
    if not isinstance(annotation, ast.Subscript):
        return None
    sl = annotation.slice
    items = sl.elts if isinstance(sl, ast.Tuple) else [sl]
    for it in items:
        if isinstance(it, ast.Call) and _tail_name(it) in ("Option", "Argument"):
            return it
    return None


def _typer_records(tree):
    """函数签名里的 typer.Option / typer.Argument（默认值形式与 Annotated 形式）。"""
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        a = node.args
        defs = list(a.defaults or [])
        offset = len(a.args) - len(defs)
        for i, arg in enumerate(a.args):
            default = defs[i - offset] if i >= offset else None
            call = _typer_option_of(default) or _typer_annotated_of(arg.annotation)
            if call is None:
                continue
            flags = _flag_list(_str_args(call))
            if not flags:
                continue
            # typer 用 ... 作默认值表示必填；写成别的常量就是可选。
            required = bool(call.args) and _is_ellipsis(call.args[0])
            kw = {k.arg: k.value for k in call.keywords if k.arg}
            dual = _dual_flag(flags)
            if dual:
                flags = [dual[0]]
            rec = _record(
                flags,
                help_text=_literal(kw["help"]) if "help" in kw else None,
                required=required,
                default=None if required else _literal(default) if default is not None else None,
                type_name=_type_name(arg.annotation),
                is_flag=(_type_name(arg.annotation) == "bool"),
                action="BooleanOptionalAction" if dual else None,
                negative=dual[1] if dual else None,
                choices=_click_choices(kw.get("type")),
            )
            if rec:
                out.append(rec)
    return out


def _fire_records(tree):
    """fire.Fire(main) 指向的函数：签名里的参数就是命令行参数。"""
    targets = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and _tail_name(node) == "Fire" and node.args:
            first = node.args[0]
            if isinstance(first, ast.Name):
                targets.add(first.id)
    if not targets:
        return []
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) or node.name not in targets:
            continue
        a = node.args
        defs = list(a.defaults or [])
        offset = len(a.args) - len(defs)
        for i, arg in enumerate(a.args):
            if arg.arg in ("self", "cls"):
                continue
            default = defs[i - offset] if i >= offset else None
            rec = _record(
                ["--" + arg.arg.replace("_", "-")],
                required=(i < offset),
                default=None if default is None else _literal(default),
                type_name=_type_name(arg.annotation),
                is_flag=(_type_name(arg.annotation) == "bool"),
            )
            if rec:
                out.append(rec)
    return out


def _framework_flags(tree):
    """三种框架各试一遍，按 dest 去重；同名的先到先得（click 最规整，排在最前）。"""
    seen = set()
    out = []
    for rec in (_click_records(tree) + _typer_records(tree) + _fire_records(tree)):
        if rec["dest"] in seen:
            continue
        seen.add(rec["dest"])
        out.append(rec)
    return out


def _parse_file(path):
    """
    解析一份 Python 源码。
    读不到或语法不认（py3.10+ 的 match、walrus 与上游的老语法都有）时，
       如实报 ok:false，不许用正则硬抓出半份结果（那会把「抓全了」说成真的）。
    """
    try:
        # errors='replace'：上游源码里可能有 GBK 编码的中文注释，
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
    flags = col.flags
    # argparse 一条都没读到：换三种声明式框架再试一遍。
    #   只有在这份文件里确实出现那些声明时才会产出，不会把普通脚本的参数认成命令行。
    if not flags:
        flags = _framework_flags(tree)
    return {"flags": flags, "ok": True, "error": None}


# 候选 CLI 文件名（与 Node 侧 cliHelp.js 的 CLI_CANDIDATES 保持一致）
DEFAULT_CANDIDATES = [
    "cli.py", "cli_v2.py", "cli2.py", "main.py",
    "infer.py", "inference.py",
]

SKIP_DIRS = {
    "node_modules", "__pycache__", ".venv", "venv", "env", "site-packages",
    "build", "dist", "docs", "doc", "tests", "test", "testing",
    "examples", "notebooks", "assets", "static", "wheels",
    ".git", ".github", ".idea", ".vscode", ".tox", ".eggs",
    ".mypy_cache", ".pytest_cache", ".ruff_cache",
}
# 判「像不像命令行声明」读多少字节：与 cliHelp.js 的 SNIFF_BYTES 同值。
# 只读 4KB 会漏掉 parser 写在文件后半段的 CLI。
SNIFF_BYTES = 256 * 1024
CLI_MARKERS = (
    "add_argument(", "ArgumentParser(", "click.", "typer.", "fire.Fire",
    "@app.command", "@cli.command",
)


def _find_cli_files(root, candidates, files=None):
    """文件清单由 Node 侧给出时直接采用；否则自行遍历 .py 文件，不设深度上限。"""
    if files:
        out = []
        for rel in files:
            rel = str(rel).replace("\\", "/")
            if rel not in out and os.path.isfile(os.path.join(root, rel)):
                out.append(rel)
        return out

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

    # 兜底：遍历全部 .py 文件，不设深度上限；只读文件头判断有没有命令行声明。
    def rec(rel):
        full = os.path.join(root, rel) if rel else root
        try:
            entries = sorted(os.listdir(full))
        except OSError:
            return
        for name in entries:
            child = os.path.join(rel, name) if rel else name
            child_full = os.path.join(root, child)
            if os.path.isdir(child_full):
                if name in SKIP_DIRS or name.startswith("."):
                    continue
                rec(child)
            elif name.endswith(".py"):
                try:
                    with open(child_full, "r", encoding="utf-8", errors="replace") as fh:
                        head = fh.read(SNIFF_BYTES)
                except OSError:
                    continue
                if any(mark in head for mark in CLI_MARKERS):
                    add(child)

    rec("")
    return found


# 主流程
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

    rels = _find_cli_files(root, candidates, spec.get("files"))
    if not rels:
        # 「没找到 CLI」是一个答案，不是错误：ok:true + 空 flags
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
