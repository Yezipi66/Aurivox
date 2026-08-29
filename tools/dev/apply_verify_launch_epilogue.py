# -*- coding: utf-8 -*-
r"""apply_verify_launch_epilogue —— 把 verify_launch.py 的收尾文案改成结账后的现实

    python tools\dev\apply_verify_launch_epilogue.py --check
    python tools\dev\apply_verify_launch_epilogue.py

⚠ 这不是功能改动，14 条判据一条没动。改的是**全过之后打印的那段话**。

为什么非改不可：那段话是**删 shim.py 之前**写的，现在字字过期，而且是
会把人带沟里的那种过期 ——

    「下一刀：grep -rln shim 那 24 个文件逐个过」
        ⇒ 那一刀 2026-08-27 已经做完了。而且实测是 **47 个**不是 24。
    「⛔ 别动 _TEMPLATE」
        ⇒ ⭐ **正好相反**。_TEMPLATE 恰恰是那一刀的**重头戏**：它原本
          缺 call 段、缺 params.load_time / call_time、缺 output_formats，
          照它接的引擎起宿主会直接 FATAL。不动它，「只写一张名片就能接
          引擎」就是句空话。
    「删 shim.py 的两个前置就都齐了」
        ⇒ 前置这个说法本身作废了：shim.py 已经删了。

⭐⭐ 这是同一个坑的**第三次**（前两次是 own_process_mark 和 gpt-sovits 那条
   `../../` 注释）：**一段话的论据被后续动作抽掉了，但话还留在原地。**
   绿色输出里的过期指路比红色报错更危险 —— 它出现在你刚确认「全过」的那
   一秒，可信度是拉满的。

新文案说三件今天成立的事：
   ① 判据 8 已结账（523 → 0），靠的是三份取证，缺一不可、顺序不能倒
   ② ⛔ 其中 run_ab.py 那份**永久不可复现**了（shim 侧没了）⇒ 本脚本从此
     是唯一还能验全链路的东西，它的身份从「放行条件」变成「回归判据」
   ③ ⛔⛔ 契约 §12 第 2 步**只做完第一半**，别读成整件事
"""
import argparse
import hashlib
import io
import json
import os
import sys

if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DATA = json.loads(r"""
{
 "patches": [
  {
   "path": "tools/dev/verify_launch.py",
   "hunks": [
    {
     "old": "    if PASSED == TOTAL and ok_all:\n        say(\"判决：**平台照新名片起得来，而且出得了声**。\")\n        say(\"\")\n        say(\"⭐ 到这里，删 shim.py 的两个前置就都齐了：\")\n        say(\"     A/B 判据      host.py 出的音频 == shim.py 出的音频\")\n        say(\"     本次          平台照新名片起得来、出得了声\")\n        say(\"   下一刀：grep -rln shim 那 24 个文件逐个过。\")\n        say(\"   ⛔ 别动 _TEMPLATE 和 gpt-sovits 的 shim 字样 —— 前者是模板，\")\n        say(\"     后者压根不由通用宿主托管（它自带服务端，名片没有 call 段）。\")\n        return 0\n    say(\"判决：**先别删 shim.py**。上面没过的那几条得先弄清楚。\")\n    return 1",
     "new": "    if PASSED == TOTAL and ok_all:\n        say(\"判决：**平台照新名片起得来，而且出得了声**。\")\n        say(\"\")\n        say(\"⭐⭐ 契约 §11 判据 8 **已于 2026-08-27 结账**：\")\n        say(\"     engines/indextts2/shim.py   523 行 → 0（文件已删）\")\n        say(\"   当时靠的是三份取证，缺一不可、顺序不能倒：\")\n        say(\"     ① run_ab.py       host.py 出的音频 == shim.py 出的音频（5/5）\")\n        say(\"     ② 本脚本          平台照新名片起得来、出得了声（14/14）\")\n        say(\"     ③ probe_host.py   宿主自身的契约自检（29/29）\")\n        say(\"   ⛔ ① 已经**不可复现**了 —— shim 那一侧永久消失。那是这一刀的\")\n        say(\"     必然代价，不是缺陷。今天起，本脚本是唯一还能验全链路的东西。\")\n        say(\"\")\n        say(\"   ⭐ 所以这 14 条的意义变了：从「删 shim 之前的放行条件」变成\")\n        say(\"     **「改完引擎相关的任何东西之后的回归判据」**。\")\n        say(\"     判据 5 写死了：测试全绿不等于能出声，静态检查代替不了这一跑。\")\n        say(\"\")\n        say(\"   ⛔⛔ 契约 §12 第 2 步**只做完了第一半**，别读成整件事：\")\n        say(\"     ① 启动路径走通用宿主                     ✅ 就是本脚本验的\")\n        say(\"     ② 合成路径带 engine_id 而不是写死默认引擎  ⛔ 还没做\")\n        say(\"     硬证据：start.ps1:57-58 靠环境变量兜底、legacyDefault.js、\")\n        say(\"     以及 server.js 里 indextts2 出现 **0 次**。\")\n        return 0\n    say(\"判决：**先别删 shim.py**。上面没过的那几条得先弄清楚。\")\n    return 1"
    }
   ]
  }
 ],
 "deletes": []
}
""")


def read(p):
    """读成 \\n 文本，同时记住它原来的换行形态。"""
    b = open(p, 'rb').read()
    crlf = b.count(b'\r\n')
    lf = b.count(b'\n') - crlf
    return b.decode('utf-8').replace('\r\n', '\n'), ('\r\n' if crlf > lf else '\n')


def write(p, text, nl):
    if nl == '\r\n':
        text = text.replace('\n', '\r\n')
    with open(p, 'wb') as f:
        f.write(text.encode('utf-8'))


def main(argv=None):
    ap = argparse.ArgumentParser(prog='apply_verify_launch_epilogue')
    ap.add_argument('--check', action='store_true', help='只看不写')
    args = ap.parse_args(argv)

    print('apply_shim_removal —— 删掉 shim.py 并结掉判据 8')
    print('  仓库根 %s' % ROOT)
    print('  模式   %s' % ('只看不写（--check）' if args.check else '真写'))
    print('=' * 74)

    problems = []
    staged = []          # (abs_path, new_text, nl, path, applied, already)
    del_plan = []        # (path, action, note)

    # ---- 一、正文 hunk ----------------------------------------------------
    for entry in DATA['patches']:
        rel = entry['path']
        p = os.path.join(ROOT, *rel.split('/'))
        if not os.path.isfile(p):
            problems.append('%s —— 文件不在。补丁是对着 2026-08-27 的树写的，'
                            '对不上就别硬打' % rel)
            continue
        text, nl = read(p)
        applied = already = 0
        bad = False
        for i, h in enumerate(entry['hunks']):
            old, new = h['old'], h['new']
            # ⛔⛔ 顺序很要紧：**先问「打过没有」，再问「锚点在不在」**。
            #   很多 hunk 是纯插入 —— new 里**整段包含** old。要是先按
            #   old 命中就打，第二次跑会再插一遍，把文件插烂。
            #   试打时这条真的翻车了（第二次跑又「写了 1 处」），才改成这样。
            if text.count(new) >= 1:
                already += 1
                continue
            c = text.count(old)
            if c == 1:
                text = text.replace(old, new, 1)
                applied += 1
            else:
                head = old.split('\n')[0].strip()[:64]
                problems.append('%s 第 %d 处 —— 锚点命中 %d 次（要 1 次），'
                                '也不像已经打过。锚点首行：%s'
                                % (rel, i + 1, c, head))
                bad = True
        if not bad:
            staged.append((p, text, nl, rel, applied, already))

    # ---- 二、删文件 --------------------------------------------------------
    for d in DATA['deletes']:
        rel = d['path']
        p = os.path.join(ROOT, *rel.split('/'))
        if not os.path.exists(p):
            del_plan.append((rel, 'skip', '已经删过了'))
            continue
        sha = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        if sha != d['sha']:
            problems.append('%s —— 内容和我手里的快照对不上（sha %s… vs %s…）。'
                            '有人改过它 ⇒ 我不替你删，你先看一眼'
                            % (rel, sha[:12], d['sha'][:12]))
            continue
        del_plan.append((rel, 'delete', '%d 字节 · %s' % (d['bytes'], d['why'])))

    # ---- 三、全有或全无 ----------------------------------------------------
    if problems:
        print()
        print('⛔ 对不上，一个字都没写：')
        print()
        for m in problems:
            print('   - %s' % m)
        print()
        print('   多半是这棵树和补丁写的时候不是同一版。')
        print('   处置：把这几个文件当前的样子发出来，我按你的版本重出锚点。')
        print('   ⛔ 别用整文件覆盖顶上去 —— 那会把上一刀的接线静默回滚掉。')
        return 1

    n_new = sum(s[4] for s in staged)
    n_old = sum(s[5] for s in staged)
    for p, text, nl, rel, applied, already in staged:
        tag = '打了 %d 处' % applied if applied else ''
        if already:
            tag += ('，' if tag else '') + '%d 处早就打过了' % already
        print('  %-46s %s' % (rel, tag or '没什么可打的'))
        if not args.check and applied:
            write(p, text, nl)

    print('-' * 74)
    for rel, action, note in del_plan:
        if action == 'delete':
            print('  删 %-44s %s' % (rel, note))
            if not args.check:
                os.remove(os.path.join(ROOT, *rel.split('/')))
        else:
            print('  － %-44s %s' % (rel, note))

    n_del = sum(1 for _, a, _ in del_plan if a == 'delete')
    print('=' * 74)
    if args.check:
        print('结账：%d 处待打、%d 个文件待删（--check 没写盘）。'
              '去掉 --check 再跑一次。' % (n_new, n_del))
        if n_old:
            print('      另有 %d 处早就是目标形态了 —— 幂等，不会重复插入。' % n_old)
        return 0

    print('结账：写了 %d 处，删了 %d 个文件' % (n_new, n_del))
    if n_old:
        print('      另有 %d 处早就是目标形态，跳过了。' % n_old)
    print()
    print()
    print('改的是文案，判据一条没动。验一条就够：')
    print()
    print('    python tools\\dev\\verify_launch.py --plan-only')
    print()
    print('  ⭐ --plan-only 只走前 3 节、不起引擎、不占显存，几秒就回来 ——')
    print('    足够确认脚本没被我改坏。7 条应当全过。')
    print('  ⚠ 完整的 14 条（含真出声那一跑）不必现在重跑：你 2026-08-27')
    print('    刚跑过，14/14，sha=ecd8e28d5401a3de。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
