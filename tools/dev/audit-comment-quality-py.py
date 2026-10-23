#!/usr/bin/env python
"""Python 版的注释质量验收：查 token 比对查不出的东西。

与 tools/dev/audit-comment-quality.cjs 同口径：
  ① docstring 存在且不是空话
  ② 装饰性分隔线横幅
  ③ 中文双破折号
  ④ markdown 加粗
  ⑤ emoji / 装饰符号
  ⑥ 行号引用
  ⑦ 日期体
  ⑧ 纪律宣告句式
  ⑨ 口语动词

用法：
    python tools/dev/audit-comment-quality-py.py <文件...>
退出码 0 = 全过；1 = 有未清的
"""
from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# ① 文件头：第一条 docstring 或前 8 行内的 # 注释
VAGUE = re.compile(r"^(这|那)?(个|些)?(文件|模块|脚本|工具)$")

# 横幅的形态有两种：
#   「# ------」      注释符号后直接是横线
#   「# ------ #」    尾部还带一个 #
# tokenize 给的 text 保留开头的 #，所以两种都要认。
RE_BANNER = re.compile(r"^\s*#?\s*[-─═=]{8,}\s*#?\s*$")
RE_DASH = re.compile("——")
RE_BOLD = re.compile(r"\*\*[^*\n]+\*\*")
RE_EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF☀-➿⬀-⯿️]"
)
RE_LINENO = re.compile(
    r"[a-zA-Z_][a-zA-Z0-9_./-]*\.(js|jsx|py|cjs|mjs):[0-9]+"
    r"|第\s*[0-9]+\s*[-–—]?\s*[0-9]*\s*行"
)
RE_DATE = re.compile(r"\b(19|20)\d{2}-\d{2}-\d{2}\b")
RE_DECREE = re.compile(
    r"(文件|代码|注释|活代码|源码|这一带|这里)[^。；\n]{0,10}(里|中|内)?[^。；\n]{0,8}"
    r"(不许|不允许|不得|禁止|只许|严禁)[^。；\n]{0,12}(出现|写|写死|写上|加|引入|留|用)"
    r"[^。；\n]{0,16}(引擎|引擎名|引擎 id|位名|权重位|键名|参数名|名字|具体)"
)
RE_COLLOQ = re.compile(r"(看着办|指路|跑完|栽过|一眼看出|扛下来)")

TEXT_RULES = [
    ("中文双破折号", RE_DASH),
    ("markdown加粗", RE_BOLD),
    ("emoji符号", RE_EMOJI),
    ("行号引用", RE_LINENO),
    ("日期体", RE_DATE),
    ("纪律宣告", RE_DECREE),
    ("口语动词", RE_COLLOQ),
]


def docstring_of(node) -> str | None:
    body = getattr(node, "body", None)
    if not body:
        return None
    first = body[0]
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant):
        if isinstance(first.value.value, str):
            return first.value.value
    return None


def collect_comments(src: str):
    """返回 (位置, 文本) 列表。位置是 1 起的行号。"""
    out = []
    for tok in tokenize.generate_tokens(io.StringIO(src).readline):
        if tok.type == tokenize.COMMENT:
            out.append((tok.start[0], tok.string))
    return out


def main() -> int:
    bad = 0
    for rel in sys.argv[1:]:
        p = ROOT / rel
        if not p.exists():
            print(f"{rel}\t读不到")
            bad += 1
            continue
        src = p.read_text(encoding="utf-8")

        try:
            tree = ast.parse(src)
        except SyntaxError as e:
            print(f"{rel}\t解析失败\t{e}")
            bad += 1
            continue

        comments = collect_comments(src)
        hits = []

        # ① 文件头：模块 docstring 或前 8 行内的 # 注释
        mod_doc = docstring_of(tree)
        head_line = None
        if mod_doc:
            head_line = tree.body[0].lineno if tree.body else 1
            first = mod_doc.strip().split("\n")[0].strip()
            if len(first) < 12 and not VAGUE.match(first):
                hits.append((head_line, "文件头过短", first))
        else:
            early = [c for c in comments if c[0] <= 8]
            if not early:
                hits.append((1, "缺文件头", ""))
            else:
                line, text = early[0]
                first = text.lstrip("# ").strip()
                if len(first) < 12 and not VAGUE.match(first):
                    hits.append((line, "文件头过短", first))

        for line, text in comments:
            body = text.lstrip("#").strip()
            for name, rx in TEXT_RULES:
                if rx.search(body):
                    hits.append((line, name, body[:70]))
                    break
            if RE_BANNER.match(text):
                hits.append((line, "装饰横幅", text.strip()[:70]))

        if hits:
            bad += 1
            print(f"{rel}\t{len(hits)} 处未清")
            for h in hits[:8]:
                print(f"    {h[0]}  [{h[1]}]  {h[2]}")
        else:
            print(f"{rel}\tOK")

    print("\n全部文件：机械可判的禁项清零" if not bad else f"\n{bad} 个文件还有未清的地方")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
