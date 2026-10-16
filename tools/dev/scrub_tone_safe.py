#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理 Python 文件注释/docstring 里的符号语气、破折号与变更历史标记。

口径（与 docs/COPY_TONE_GUIDELINE.md 一致）：
  - ⛔ / ⭐ / ✅  → 删除符号，保留文字
  - ⚠ / ★        → **保留**（警告前缀 / 推荐标记）
  - ——           → 解释关系改冒号；行尾装饰改逗号；单个 — 伴随中文改逗号
  - 历史标记      → 日期 / 刀 A1 / Patch #12 / r12c-batchNN / 这一刀 / 过去这里是…

只处理注释与 docstring，不碰代码与字符串字面量。

用法：python scrub_tone_safe.py [--apply] <file> [...]
      不带 --apply 时只 dry-run 统计。
"""
import argparse
import io
import os
import re
import sys

DEL_SYM = re.compile(r'[⛔⭐✅]\ufe0f?[ \t]?')
DASH2 = re.compile(r'[ \t]*——[ \t]*')
DASH2_EOL = re.compile(r'[ \t]*——[ \t]*(?=\n|$)')
DASH1_CN = re.compile(r'(?<=[\u4e00-\u9fff])[ \t]*—[ \t]*(?=[\u4e00-\u9fff])')

# 历史标记：日期 / 变更编号 / 历史叙述
HIST_PATTERNS = [
#  后接标点或行尾
    re.compile(r'[ \t]*刀[ \t]*[A-Z0-9]+(?![A-Za-z0-9])'),
    re.compile(r'[ \t]*Patch[ \t]*#\d+'),
    re.compile(r'[ \t]*r12c-batch\d+'),
    re.compile(r'[ \t]*batch1[0-9]'),
    re.compile(r'[ \t]*事\d+(?:/\d+)?'),
    re.compile(r'[ \t]*(?:这一刀|上一刀|下一刀)'),
]
HIST_PHRASES = [
    re.compile(r'[ \t]*(?:过去|之前|以前|原来)这里(?:是|写死|用|走|印|返回|没有|只)', re.I),
]


def scrub(text):
    s = DEL_SYM.sub('', text)
    s = DASH2_EOL.sub('，', s)
    s = DASH2.sub('：', s)
    s = DASH1_CN.sub('，', s)
    for p in HIST_PATTERNS:
        s = p.sub('', s)
    for p in HIST_PHRASES:
        s = p.sub('', s)
    return s


def split_comment(line):
    """返回 (前缀, 注释部分)；注释部分为 None 表示这行没有注释。"""
    s = line.lstrip()
    indent = line[:len(line) - len(s)]
    if s.startswith('#'):
        return indent, s
    return None, None


def process(path, apply_changes):
    with io.open(path, 'r', encoding='utf-8', errors='replace') as f:
        src = f.read()
    lines = src.split('\n')
    out = []
    in_doc = None          # 记录正在哪个 docstring 里
    changed = 0
    for line in lines:
        stripped = line.strip()

        # docstring 边界
        if in_doc is not None:
            new = scrub(line)
            if new != line:
                changed += 1
            out.append(new)
            q = in_doc
            if q in line:
                # 同行闭合，或本行以 q 结尾
                if line.count(q) >= 2 or stripped.endswith(q) or stripped.startswith(q):
                    in_doc = None
            continue
        for q in ('"""', "'''"):
            if q in line:
                # 可能 docstring 开始（前面是 r/f 或行首/冒号后）
                before = line[:line.index(q)]
                if before.strip() == '' or before.rstrip().endswith((': r"', ': f"', ":r'", ":f'", '= """', "= '''")):
                    in_doc = q
                    new = scrub(line)
                    if new != line:
                        changed += 1
                    out.append(new)
                    # 单行 docstring
                    rest = line[line.index(q) + 3:]
                    if q in rest:
                        in_doc = None
                    break
        else:
            pre, comment = split_comment(line)
            if comment is None:
                out.append(line)
                continue
            # 行尾注释：# 前面若在字符串里则不处理（简单判断：' 不成对）
            idx = line.find('#')
            prefix = line[:idx]
            if prefix.count("'") % 2 == 1 or prefix.count('"') % 2 == 1:
                out.append(line)
                continue
            new = scrub(line)
            if new != line:
                changed += 1
            out.append(new)
            continue
        continue

    if changed and apply_changes:
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write('\n'.join(out))
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('files', nargs='+')
    args = ap.parse_args()

    tf = tc = 0
    for path in args.files:
        if not os.path.exists(path):
            print('缺文件:', path)
            continue
        try:
            n = process(path, args.apply)
        except Exception as e:
            print('处理失败 %s: %s' % (path, e))
            continue
        if n:
            tf += 1
            tc += n
            print('%s %s: %d 行' % ('已改' if args.apply else '将改', os.path.basename(path), n))
    print('\n合计: %d 文件 / %d 行%s' % (tf, tc, '（已写盘）' if args.apply else '（dry-run）'))


if __name__ == '__main__':
    main()
