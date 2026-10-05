"""⭐ A19 的安全网：在删掉 venv/ 之前，把包清单快照下来。

⚠️ 为什么需要它：那两个 venv 的 **base 解释器都指向另一台机器**，解释器起不来
⇒ `pip freeze` / `uv pip freeze` 都跑不了（实测返回 0 行）。
⇒ 唯一还能读到版本号的地方是 `site-packages/*.dist-info` 的目录名。

⚠️ 为什么不能用 sed：dist-info 目录名是 `名字-版本.dist-info`，而**版本里也有 `-`**
（`2.2.0+cu121`、`1.0rc1`、`0.9.2.post1`）⇒ 贪婪替换会把版本号吃掉
（实测产出过 `librosa==.9.2.` 这种废数据）。**错的安全网比没有安全网更糟。**

用法：python tools/dev/snapshot-venv-packages.py            # 写 logs/ 下
     python tools/dev/snapshot-venv-packages.py --stdout   # 只打印
"""

import os
import re
import sys
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# `名字-版本`，版本以数字开头。名字部分非贪婪，版本部分允许含 - + .
STEM = re.compile(r'^(?P<name>.+?)-(?P<ver>\d.*)$')


def scan(site_packages):
    """从 site-packages 读出 {name: version}。

    ⭐ 只认 dist-info / egg-info 目录 —— 裸模块目录（numpy/、torch/）没有版本信息，
    硬从它们猜会得到一堆错的东西。
    """
    out = {}
    if not os.path.isdir(site_packages):
        return out
    for entry in os.listdir(site_packages):
        for suffix in ('.dist-info', '.egg-info'):
            if not entry.endswith(suffix):
                continue
            stem = entry[: -len(suffix)]
            m = STEM.match(stem)
            if not m:
                continue
            out[m.group('name')] = m.group('ver')
            break
    return out


def main():
    to_stdout = '--stdout' in sys.argv
    targets = [
        ('venv', '根 venv（平台自己的，7GB —— A19 要清掉的就是它）'),
        ('engines/gpt-sovits/.venv', 'GSV 引擎 venv（与根 venv 是同一套包 + humanize）'),
        ('engines/indextts2/.venv', 'IndexTTS2 引擎 venv'),
        ('engines/cosyvoice2/.venv', 'CosyVoice2 引擎 venv（本机唯一活着的）'),
    ]

    lines = []
    lines.append('# venv 包清单快照')
    lines.append('# 生成: %s' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    lines.append('# 用途: A19（把根 venv 换成瘦版）删盘之前的安全网。')
    lines.append('# 为什么需要: 两个 venv 的 base 解释器都指向另一台机器，')
    lines.append('#            解释器起不来 ⇒ pip freeze / uv pip freeze 都跑不了（实测返回 0 行）。')
    lines.append('# 读法: name==version，与 pip freeze 的格式等价，可直接喂给 pip/uv。')
    lines.append('# ⚠️ 覆盖的是 *.dist-info 目录 —— 裸模块目录不带版本，不猜。')
    lines.append('')

    summary = []
    for rel, desc in targets:
        sp = os.path.join(ROOT, rel, 'Lib', 'site-packages')
        pkgs = scan(sp)
        summary.append((rel, len(pkgs)))
        lines.append('=== %s —— %s' % (rel, desc))
        lines.append('=== 共 %d 个包' % len(pkgs))
        lines.append('')
        for name in sorted(pkgs, key=str.lower):
            lines.append('%s==%s' % (name, pkgs[name]))
        lines.append('')

    text = '\n'.join(lines) + '\n'
    if to_stdout:
        sys.stdout.write(text)
        return 0
    out = os.path.join(ROOT, 'logs', 'venv-snapshot-%s.txt'
                       % datetime.date.today().strftime('%Y-%m-%d'))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(text)
    sys.stdout.write('已写 %s\n' % os.path.relpath(out, ROOT))
    for rel, n in summary:
        sys.stdout.write('  %-32s %d 个包\n' % (rel, n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
