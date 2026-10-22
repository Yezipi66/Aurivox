#!/usr/bin/env python
"""证明一批 Python 文件只改了注释：去掉注释后的 token 序列必须逐个一致。

口径与 tools/dev/verify-comment-only.cjs 相同（JS 侧用 @babel/parser，
这里用 tokenize）：取源码里所有非注释 token，比较改前改后。

用法：
    python tools/dev/verify-comment-only-py.py <baseRef> <file...>

    <baseRef> 是改前那个 commit。文件读当前工作区。
"""
from __future__ import annotations

import io
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def code_tokens(src: str) -> list[tuple]:
    """取源码里所有非注释 token（跳过 COMMENT、NL、NEWLINE、INDENT、DEDENT、ENDMARKER）。"""
    out = []
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type in (
            tokenize.COMMENT,
            tokenize.NL,
            tokenize.NEWLINE,
            tokenize.INDENT,
            tokenize.DEDENT,
            tokenize.ENDMARKER,
            tokenize.ENCODING,
        ):
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
