# -*- coding: utf-8 -*-
"""mutate_probe_host —— probe_host 的验红

⛔ 一律二进制 I/O（2026-08-25 事故：文本模式往返会把 LF 文件写成 CRLF）
⛔ 收尾挂进程级 finally；删备份前必须字节比对
"""

import hashlib
import os
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOST = os.path.join(ROOT, "lib", "engines", "host.py")
PROBE = os.path.join(HERE, "probe_host.py")
PY = sys.executable

ROWS = []
BACKUPS = {}


def rb(p):
    with open(p, "rb") as f:
        return f.read()


def wb(p, b):
    with open(p, "wb") as f:
        f.write(b)


def sha(b):
    return hashlib.sha256(b).hexdigest()


def row(name, ok, note=""):
    ROWS.append((name, ok, note))
    print("  %-8s %s%s" % ("RED-OK" if ok else "FAIL", name,
                           ("   [%s]" % note) if note else ""))


def backup(p):
    BACKUPS[p] = rb(p)


def restore_all():
    for p, data in list(BACKUPS.items()):
        wb(p, data)
        if sha(rb(p)) != sha(data):
            print("⛔ %s 没还原成功 —— 内容已在内存里，请手工核对" % p)
        else:
            BACKUPS.pop(p, None)


def patch(p, old, new):
    """⛔ 锚点必须带整行缩进：8 个空格是 12 个空格的后缀，
    「命中 1 次」不等于「命中的是那一行」。"""
    d = rb(p).decode("utf-8")
    n = d.count(old)
    if n != 1:
        raise SystemExit("⛔ 锚点命中 %d 次（要求 1 次）于 %s：\n%s" % (n, p, old[:80]))
    wb(p, d.replace(old, new, 1).encode("utf-8"))


def run_probe():
    r = subprocess.run([PY, PROBE], cwd=ROOT, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=600)
    return r.returncode, r.stdout.decode("utf-8", "replace")


def fails_of(out):
    """⛔ 只数**实时表格**里的 FAIL，不数结账清单里的。

    2026-08-26：probe_host 每条 FAIL 会打印两次（跑到时一次、结账复述一次），
    照单全收 ⇒ 每个计数都翻倍（M4 报「12 条」其实是 6×2），断言全部落空。
    基线之所以没暴露，是因为 0 × 2 还是 0 —— ⭐ 计数型断言必须拿**非零**的
    突变去校准，全绿的基线校准不出乘法错误。
    """
    body = out.split("=== 结账")[0].split("结账：")[0]
    return [l.strip()[6:].strip() for l in body.splitlines()
            if l.strip().startswith("FAIL")]


def crashed(out):
    """⭐⭐ 探针**没跑到结账**就退场了 = 它自己崩了。

    2026-08-26 实测过一次真的：宿主被突变成「放行该拒的请求」后回的是
    WAV 字节，探针拿去 json.loads ⇒ UnicodeDecodeError ⇒ 整支退场 ⇒
    一条 FAIL 都没打印 ⇒ 验红把它读成「红 0 条」，看上去像**没抓到**，
    其实是**读数被吞了**。这两种情况必须能分开，否则验红本身不可信。
    """
    return "=== 结账" not in out and "结账：" not in out


def main():
    print("=== probe_host 验红 ===")
    print()

    backup(HOST)
    HOST_SHA = sha(rb(HOST))

    # ---------------- 基线 ----------------
    rc, out = run_probe()
    base_fails = fails_of(out)
    row("基线：退出码 0", rc == 0, "rc=%d" % rc)
    row("基线：29 条全过", not base_fails and "29 过" in out,
        "%d 条没过" % len(base_fails))

    # ---------------- M1：把播种整个拆掉 ----------------
    patch(HOST,
          "                    seed_info = self.seed_plan.apply(seed)",
          "                    seed_info = None  # mutated: 不播种")
    rc, out = run_probe()
    f = fails_of(out)
    row("⭐⭐ M1：宿主不播种了 ⇒「同 seed 两次字节相同」立刻红",
        rc != 0 and any("同 seed 两次" in x for x in f), "红 %d 条" % len(f))
    row("⭐ M1 连带：X-Seed-Applied 也跟着红（两条判据各管各的）",
        any("X-Seed-Applied" in x for x in f))
    row("⭐⭐ M1 反证：「换 seed 字节不同」**仍然绿** —— "
        "说明假引擎本来就是随机的，上一条不是假绿",
        not any("换 seed" in x for x in f))
    restore_all()
    backup(HOST)

    # ---------------- M2：seed="none" 收下扔掉 ----------------
    patch(HOST,
          '        if seed_plan.mode == "none":',
          '        if False:  # mutated: 收下扔掉')
    rc, out = run_probe()
    f = fails_of(out)
    row("⭐⭐ M2 前提：探针自己没崩（否则下面读的是被吞掉的读数）",
        not crashed(out))
    row('⭐⭐ M2：seed="none" 改成收下扔掉 ⇒ 拒收那条红',
        rc != 0 and any("拒收" in x for x in f), "红 %d 条" % len(f))
    row("⭐ M2 连带：只红这一条（判别力，没牵连别的）",
        len(f) == 1, "；".join(f)[:70])
    row("⭐⭐ M2 连带：放行后宿主回的是 WAV 字节，探针照样报出 FAIL 而不是退场",
        any("非 JSON 响应" in x for x in f) or len(f) == 1)
    restore_all()
    backup(HOST)

    # ---------------- M3：不认识的参数放行 ----------------
    patch(HOST,
          "    unknown = sorted(k for k in body if k not in known)",
          "    unknown = []  # mutated: 拼错的参数名静默放行")
    rc, out = run_probe()
    f = fails_of(out)
    row("⭐ M3：拼错的参数名静默放行 ⇒ 那条 400 红",
        rc != 0 and any("拼错" in x for x in f), "红 %d 条" % len(f))
    restore_all()
    backup(HOST)

    # ---------------- M4：名片不全也照样启动 ----------------
    patch(HOST,
          "    problems = validate_profile(profile)",
          "    problems = []  # mutated: 名片不全也硬起")
    rc, out = run_probe()
    f = fails_of(out)
    row("⭐⭐ M4 前提：探针自己没崩", not crashed(out))
    row("⭐⭐ M4：名片不全也硬起 ⇒ [6] 六条**全部**红",
        rc != 0 and len([x for x in f if "拒绝启动" in x]) == 6,
        "拒绝启动红 %d 条" % len([x for x in f if "拒绝启动" in x]))
    # ⭐ 六条红的**理由不一样**，这个差别本身就是结论：
    #   seed 那 4 条被 SeedPlan 在 Engine.__init__ 里二次拦下（rc=1，裸 traceback）
    #     ⇒ 有第二道防线，但退的不是「拒绝」而是「崩了」
    #   bind 那 2 条**一道防线都没有** ⇒ 宿主真的起来并一直服务（超时）
    row("⭐⭐ M4：seed 有第二道防线（rc=1 崩掉），bind **一道都没有**（起来了没拒绝）",
        len([x for x in f if "rc=1" in x]) == 4
        and len([x for x in f if "起来了没拒绝" in x]) == 2,
        "rc=1 有 %d 条，超时有 %d 条"
        % (len([x for x in f if "rc=1" in x]),
           len([x for x in f if "起来了没拒绝" in x])))
    restore_all()
    backup(HOST)

    # ---------------- M5：引擎身份写死 ----------------
    patch(HOST,
          '                "engine": prof["id"],',
          '                "engine": "indextts2",  # mutated: 写死身份')
    rc, out = run_probe()
    f = fails_of(out)
    row("⭐ M5：把引擎身份写死 ⇒「身份来自名片」红（宿主必须是通用的）",
        rc != 0 and any("身份" in x for x in f), "红 %d 条" % len(f))
    restore_all()

    # ---------------- 收尾 ----------------
    row("⭐ 还原后宿主字节级回到基线",
        sha(rb(HOST)) == HOST_SHA, "%s" % sha(rb(HOST))[:12])
    rc, out = run_probe()
    row("⭐ 还原后重跑回到基线（29 条全过）",
        rc == 0 and not fails_of(out), "rc=%d" % rc)
    row("没有残骸（备份都已核对并释放）", not BACKUPS)

    print()
    print("=== 结账 ===")
    bad = [n for n, ok, _ in ROWS if not ok]
    print("  %d 条，全过 = %s" % (len(ROWS), not bad))
    for n in bad:
        print("    FAIL  %s" % n)
    return 0 if not bad else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        # ⛔ 任何退法都要还原 —— 2026-08-25 教训：守卫只守成功路径等于没守
        if BACKUPS:
            print("⛔ 异常退出，正在还原被改过的文件…")
            restore_all()
