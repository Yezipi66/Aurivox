#!/usr/bin/env python
"""证明一批 Python 文件只改了注释：去掉注释后的 token 序列必须逐个一致。

口径与 tools/dev/verify-comment-only.cjs 相同（JS 侧用 @babel/parser，
这里用 tokenize + ast），但 Python 有一处语言差异必须处理：

    Python 的 docstring 在语法上是**字符串表达式**（STRING token），
    不是注释 token。而它承担的正是注释职责（模块说明、函数说明）。

⇒ 比对时必须把 docstring 也算作「注释」剥掉，否则改一句模块说明
   就会报 DIFF，而那不是代码改动。

    「注释」= tokenize 的 COMMENT token + ast 找出的所有 docstring。

用法：
    python tools/dev/verify-comment-only-py.py <baseRef> <file...>

    <baseRef> 是改前那个 commit。文件读当前工作区。
"""
from __future__ import annotations

import ast
import io
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# tokenize 里不算代码的那些
SKIP_TYPES = {
    tokenize.COMMENT,
    tokenize.NL,
    tokenize.NEWLINE,
    tokenize.INDENT,
    tokenize.DEDENT,
    tokenize.ENDMARKER,
    tokenize.ENCODING,
}


def docstring_spans(src: str) -> set[tuple]:
    """找出所有 docstring 的位置区间（行号从 1 起）。

    位置取自模块/类/函数体的第一条语句（它必须是字符串常量）。
    """
    spans: set[tuple] = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return spans

    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            continue
        body = getattr(node, "body", None)
        if not body:
            continue
        first = body[0]
        if not isinstance(first, ast.Expr):
            continue
        val = first.value
        if not isinstance(val, ast.Constant) or not isinstance(val.value, str):
            continue
        spans.add((first.lineno, first.col_offset, first.end_lineno, first.end_col_offset))
    return spans


def in_docstring(tok, spans) -> bool:
    """这个 token 是否落在某个 docstring 区间里。"""
    if not spans:
        return False
    for (srow, scol, erow, ecol) in spans:
        if tok.start[0] < srow or tok.end[0] > erow:
            continue
        if tok.start[0] == srow and tok.start[1] < scol:
            continue
        if tok.end[0] == erow and tok.end[1] > ecol:
            continue
        return True
    return False


def code_tokens(src: str) -> list[tuple]:
    """取源码里所有非注释 token（跳过 COMMENT 与 docstring）。"""
    spans = docstring_spans(src)
    out = []
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type in SKIP_TYPES:
            continue
        if tok.type == tokenize.STRING and in_docstring(tok, spans):
            continue
        out.append((tok.type, tok.string))
    return out


def read_at(ref: str, rel: str) -> str:
    r = subprocess.run(
        ["git", "show", f"{ref}:{rel}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if r.returncode != 0:
        raise FileNotFoundError(rel)
    return r.stdout


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    base_ref = sys.argv[1]
    files = sys.argv[2:]

    bad = 0
    for rel in files:
        p = ROOT / rel
        if not p.exists():
            print(f"{rel}\t读不到")
            bad += 1
            continue
        try:
            before = code_tokens(read_at(base_ref, rel))
        except FileNotFoundError:
            print(f"{rel}\t基线里没有这个文件（新增文件，跳过比对）")
            continue
        try:
            after = code_tokens(p.read_text(encoding="utf-8"))
        except (tokenize.TokenError, SyntaxError) as e:
            print(f"{rel}\t解析失败\t{e}")
            bad += 1
            continue

        if before == after:
            print(f"{rel}\tsame\t只改了注释")
            continue

        bad += 1
        for i in range(max(len(before), len(after))):
            b = before[i] if i < len(before) else None
            a = after[i] if i < len(after) else None
            if b != a:
                print(f"{rel}\tDIFF\t第 {i} 个 token 不同：{b} => {a}")
                break

    if bad:
        print(f"\n有 {bad} 个文件没能证明只改了注释")
        return 1
    print("\n全部文件：去掉注释后的 token 序列逐个一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
