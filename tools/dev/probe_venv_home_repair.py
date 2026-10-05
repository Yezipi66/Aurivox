"""⭐ 探针：uv 建的 venv 能不能**改 home 就救活**，而不是重装几个 GB。

⚠️ 为什么问这个（2026-10-05）：E1（重建引擎 venv）目前的估算是「重装」，
而 GSV 那套是 **206 个包 / 6.9 GB**。如果改一行 `pyvenv.cfg` 的 `home`
就能救活，E1 的成本会从「几十分钟 + 6.9GB 下载」变成「改一行」。

⚠️ 反面也重要：如果**改 home 救不活**（比如 uv 的 trampoline 把路径
焊死在 exe 里），那 E1 就必须老实重装 —— 而那会需要 §5.8b 的裁定。
⇒ 所以这个探针的两种结果都有决策价值。

判据：起一次 `-c "import sys; print(sys.executable)"`，看退出码。
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EMBEDDED = os.path.join(REPO, 'tools', 'runtime', 'python', 'python.exe')
DEAD_HOME = r'C:\Users\MECHREVO X10 Pro\AppData\Roaming\uv\python\cpython-3.11'


def uv_exe():
    """找 uv —— 它不在 PATH 上也得能测。"""
    for c in [shutil.which('uv')]:
        if c:
            return c
    for base in [os.path.expandvars(r'%LOCALAPPDATA%\hermes\tools'),
                 os.path.expanduser(r'~/.local/bin')]:
        if not os.path.isdir(base):
            continue
        for d in sorted(os.listdir(base)):
            if d.startswith('uv-'):
                for leaf in ('uv.exe', 'uv'):
                    p = os.path.join(base, d, leaf)
                    if os.path.exists(p):
                        return p
    return None


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def run(exe, code):
    r = subprocess.run([exe, '-c', code], capture_output=True, text=True, timeout=120)
    return r.returncode, (r.stdout or '').strip(), (r.stderr or '').strip().split('\n')[0]


def main():
    uv = uv_exe()
    print('uv =', uv or '⛔ 找不到')
    if not uv:
        return 2
    print('内嵌解释器 =', EMBEDDED, '存在=', os.path.exists(EMBEDDED))
    if not os.path.exists(EMBEDDED):
        print('⛔ 没有内嵌解释器，本探针跑不了')
        return 2

    tmp = tempfile.mkdtemp(prefix='aurivox-venvprobe-')
    venv = os.path.join(tmp, 'tv')
    exe = os.path.join(venv, 'Scripts', 'python.exe')
    cfg = os.path.join(venv, 'pyvenv.cfg')
    try:
        print('\n=== ① 用 uv 建一个 venv ===')
        r = subprocess.run([uv, 'venv', '--python', '3.11', venv],
                           capture_output=True, text=True, timeout=300)
        print('  ', (r.stdout or r.stderr).strip().split('\n')[0])
        if not os.path.exists(cfg):
            print('  ⛔ 没建出 pyvenv.cfg')
            return 1
        print('  原始 home =', re.search(r'^home = .*$', read(cfg), re.M).group(0))
        code, out, err = run(exe, 'import sys; print("OK", sys.version.split()[0])')
        print('  起它 →', code, out or err)

        print('\n=== ② 把 home 指向一个不存在的路径（模拟项目被搬机器）===')
        write(cfg, re.sub(r'^home = .*$', 'home = ' + DEAD_HOME, read(cfg), flags=re.M))
        code, out, err = run(exe, 'import sys; print("OK", sys.version.split()[0])')
        print('  起它 →', code, (out or err)[:110])
        verdict_dead = (code == 0)

        print('\n=== ③ 把 home 改回本机内嵌解释器（能不能救活）===')
        write(cfg, re.sub(r'^home = .*$', 'home = ' + EMBEDDED, read(cfg), flags=re.M))
        code, out, err = run(exe, 'import sys; print("OK", sys.version.split()[0], sys.prefix)')
        print('  起它 →', code, (out or err)[:160])
        verdict_revived = (code == 0)

        print('\n=== 结论 ===')
        print('  坏 home 会让 venv 失效 :', '✅ 会（与本机那三个 venv 的症状一致）' if not verdict_dead
              else '⚠️ 不会 —— 那本机那三个 venv 失效的原因另有其人，⛔ 别据此下结论')
        print('  改回好 home 能救活     :', '✅ 能 ⇒ E1 对 GSV 可能只要改一行'
              if verdict_revived else '⛔ 不能 ⇒ 改 home 这条路作废，E1 必须老实重装')
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
