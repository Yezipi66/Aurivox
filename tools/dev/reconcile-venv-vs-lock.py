"""⭐ 对账：盘上那个 venv 与 git 里记录的那份锁是否一致。

⚠️ 2026-10-04：那份锁已由 requirements.txt 更名为
requirements-gpt-sovits.txt（A16 —— 它是 GPT-SoVITS 的依赖，不是平台的）。

⚠️ 为什么这件事决定 A19 能不能删：
如果盘上装的 == 锁里写的，那么删掉之后**按锁重装就能还原**，
A19 就是可逆的；如果不一致，那锁已经**不再描述现状**，删掉就永久丢掉一部分事实。

用法：python tools/dev/reconcile-venv-vs-lock.py
"""

import os
import re
import sys
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PKG = re.compile(r'^([A-Za-z0-9_.\-]+)==(\S+)$')


def norm(n):
    return re.sub(r'[-_.]+', '-', n).lower()


def read_snapshot_section(path, header_prefix):
    """从快照文件里取某一段（以 '=== <header_prefix>' 开头的段）里的 name==version。"""
    text = open(path, encoding='utf-8').read()
    out, inside = {}, False
    for line in text.splitlines():
        # ⚠️ 段头只认「=== <名字> —— <说明>」这一种形状。
        #   快照里还有一行「=== 共 N 个包」，它也以 '=== ' 开头 ——
        #   而它紧跟在段头后面第一行，用 startswith('=== ') 判会把段立刻关掉。
        #   （2026-10-05 实测踩到：因此一度报「盘上 0 个包」。）
        if line.startswith('=== ') and '——' in line:
            inside = line.startswith('=== %s ' % header_prefix)
            continue
        if not inside:
            continue
        m = PKG.match(line.strip())
        if m:
            out[norm(m.group(1))] = (m.group(1), m.group(2))
    return out


def read_lock(path):
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding='utf-8'):
        line = line.split('#')[0].strip()
        if not line or line.startswith('-'):
            continue
        m = PKG.match(line)
        if m:
            out[norm(m.group(1))] = (m.group(1), m.group(2))
    return out


def compare(name, disk, lock):
    print('=== %s' % name)
    print('  盘上 %d 个带版本的包   锁里 %d 条' % (len(disk), len(lock)))
    same = [k for k in lock if k in disk and disk[k][1] == lock[k][1]]
    diff = [(k, lock[k], disk[k]) for k in lock if k in disk and disk[k][1] != lock[k][1]]
    only_disk = [k for k in disk if k not in lock]
    only_lock = [k for k in lock if k not in disk]
    print('  ✅ 版本一致 %d   ⚠️ 版本不同 %d   只在盘上 %d   只在锁里 %d'
          % (len(same), len(diff), len(only_disk), len(only_lock)))
    for k, a, b in diff[:10]:
        print('     ⚠️ %-26s 锁=%-20s 盘上=%s' % (disk[k][0], a[1], b[1]))
    for k in only_disk[:10]:
        print('     ➕ 只在盘上: %s==%s' % disk[k])
    for k in only_lock[:10]:
        print('     ➖ 只在锁里: %s==%s' % lock[k])
    print()
    return len(diff) == 0 and len(only_lock) == 0


def main():
    snaps = sorted(glob.glob(os.path.join(ROOT, 'logs', 'venv-snapshot-*.txt')))
    if not snaps:
        sys.stderr.write('没有快照，先跑 tools/dev/snapshot-venv-packages.py\n')
        return 2
    snap_path = snaps[-1]
    print('快照: %s\n' % os.path.relpath(snap_path, ROOT))

    disk = read_snapshot_section(snap_path, 'venv')
    lock = read_lock(os.path.join(ROOT, 'requirements-gpt-sovits.txt'))
    ok = compare('根 venv  vs  requirements-gpt-sovits.txt', disk, lock)

    if ok:
        print('⇒ ✅ 结论：锁**完整描述**了盘上那个 venv ⇒ 按锁重装可还原 ⇒ 删除可逆。')
    else:
        print('⇒ ⛔ 结论：锁**不再描述**盘上现状（不一致 / 有缺失）')
        print('   ⚠️ 删除之前必须先把差量记进版本库，否则那部分事实会永久丢失。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
