# -*- coding: utf-8 -*-
"""mutate_host_contract —— 给「名片→宿主」这条接缝上的闸验红

被验的两支闸：
  tools/dev/probe_host.py             宿主带假引擎跑通全程（29 条）
  tools/dev/probe_profile_contract.py 名片给不给宿主要的字段（跨语言）

⭐ 这一支存在的唯一理由：上面两支**刚刚新增了判据**（init_args 占位符展开、
  托管模式分辨）。没验过红的判据 = 安慰剂。绿是免费的，红才要钱。
"""

import io
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

HOST = os.path.join(ROOT, "lib", "engines", "host.py")
MANIFEST = os.path.join(ROOT, "engines", "indextts2", "manifest.json")
PROBE_HOST = os.path.join(HERE, "probe_host.py")
PROBE_CONTRACT = os.path.join(HERE, "probe_profile_contract.py")

RESULTS = []


def check(name, ok, note=""):
    RESULTS.append((name, ok, note))
    print("  %-8s %s   [%s]" % ("RED-OK" if ok else "RED-FAIL", name, note))


def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)


def run(script):
    r = subprocess.run([sys.executable, script], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=900)
    return r.returncode, r.stdout.decode("utf-8", "replace")


def fails_of(out):
    """⭐ 第 11 条教训：只数实时表格那一段。结账段是复述，数两遍会翻倍。"""
    head = out.split("=== 结账")[0].split("结账：")[0]
    return re.findall(r"^\s*(?:FAIL|⛔)\s+(.*)$", head, re.M)


def crashed(out):
    """⭐ 第 10 条教训：闸自己崩了 ≠ 闸没抓到。分开报。"""
    return "结账" not in out


def patch(path, old, new, label):
    s = read(path)
    if old not in s:
        raise AssertionError("%s：找不到要替换的串" % label)
    write(path, s.replace(old, new, 1))


# ---------------------------------------------------------------------------
NEW_EXPAND = "init_args = _expand_init_args(self.call.get(\"init_args\"), self.profile)"
OLD_EXPAND = "init_args = dict(self.call.get(\"init_args\") or {})"


def main():
    print("=== 名片→宿主 接缝验红 ===")
    print()

    host_bak = read(HOST)
    mf_bak = read(MANIFEST)

    try:
        # ---------- 基线 ----------
        rc, out = run(PROBE_HOST)
        check("基线：probe_host 29 条全过", rc == 0 and not fails_of(out),
              "rc=%d 红 %d 条" % (rc, len(fails_of(out))))
        rc, out = run(PROBE_CONTRACT)
        check("基线：probe_profile_contract 全过", rc == 0 and not fails_of(out),
              "rc=%d 红 %d 条" % (rc, len(fails_of(out))))
        check("基线前提：indextts2 确实被当成「由通用宿主托管」",
              "由通用宿主托管：indextts2" in out,
              "否则下面全是空转")

        # ---------- M1：宿主不展开 init_args 的占位符 ----------
        patch(HOST, NEW_EXPAND, OLD_EXPAND, "M1")
        rc, out = run(PROBE_HOST)
        f = fails_of(out)
        check("⭐⭐ M1 前提：探针自己没崩", not crashed(out),
              "崩了就说明下面读的是被吞掉的读数")
        check("⭐⭐ M1：init_args 不展开 ⇒ 假引擎当场拒收，加载失败被抓到",
              len(f) >= 1 and not crashed(out), "红 %d 条" % len(f))
        check("⭐ M1：红的理由点到了占位符，不是别的",
              "占位符" in out or "{checkpoints}" in out,
              "报文里能看出是占位符没展开")
        write(HOST, host_bak)

        # ---------- M2：名片里写了一个宿主不认识的占位符 ----------
        # ⛔⛔ 这里原本是「把 raise 改成 pass」——**那条突变是空转的**：
        #   夹具里的占位符全是认得的，missing 永远是空列表，那个 raise
        #   根本没机会执行，改不改都一样绿。
        #   ⇒ 要测「不认识的占位符」，就得真往夹具里塞一个不认识的。
        #   这也是第 11 条教训的同一类：突变必须先证明它真的改变了行为。
        probe_bak = read(PROBE_HOST)
        patch(PROBE_HOST, '"model_dir": "{checkpoints}"',
              '"model_dir": "{no_such_thing}"', "M2")
        rc, out = run(PROBE_HOST)
        f = fails_of(out)
        check("⭐⭐ M2 前提：探针自己没崩", not crashed(out), "")
        check("⭐⭐ M2：名片写了不认识的占位符 ⇒ 拒绝加载（不是原样当字面量传下去）",
              len(f) >= 1, "红 %d 条" % len(f))
        check("⭐ M2：报文点名了是哪个占位符填不出来",
              "no_such_thing" in out, "错误信息里能看见 {no_such_thing}")
        write(PROBE_HOST, probe_bak)

        # ---------- M3：名片丢掉 call 段 ----------
        # ⛔ 这是新判据里最危险的一条：托管模式的判据就是「有没有 call 段」，
        #   所以丢了 call 的引擎会被**跳过**而不是报错。必须确认 `if not hosted`
        #   那道兜底真的兜住了，否则丢 call = 静默全绿。
        mf = json.loads(mf_bak)
        del mf["call"]
        write(MANIFEST, json.dumps(mf, ensure_ascii=False, indent=2) + "\n")
        rc, out = run(PROBE_CONTRACT)
        check("⭐⭐ M3：名片丢掉 call ⇒ 没有任何引擎被托管 ⇒ 非零退出（不是静默全绿）",
              rc != 0, "rc=%d" % rc)
        check("⭐⭐ M3：报文明说了「这轮全绿什么也没证明」",
              "什么也没证明" in out, "兜底文案在")
        write(MANIFEST, mf_bak)

        # ---------- M4：load_time 与 call_time 重名 ----------
        mf = json.loads(mf_bak)
        mf["params"]["call_time"] = mf["params"]["call_time"] + ["use_fp16"]
        write(MANIFEST, json.dumps(mf, ensure_ascii=False, indent=2) + "\n")
        rc, out = run(PROBE_CONTRACT)
        check("⭐⭐ M4：同一个名字既是加载期又是调用期 ⇒ 拒绝装配",
              rc != 0 and "同时出现" in out, "rc=%d" % rc)
        write(MANIFEST, mf_bak)

        # ---------- M5：声明要参考音频却不给 bind 槽位 ----------
        mf = json.loads(mf_bak)
        del mf["call"]["bind"]["ref_audio"]
        write(MANIFEST, json.dumps(mf, ensure_ascii=False, indent=2) + "\n")
        rc, out = run(PROBE_CONTRACT)
        # ⭐ 第 10 条教训：红了要能当场看出**为什么**红。这条判据里有「报文
        #   得点名 ref_audio」一半，只报 rc 的话，报文那一半失败时看不出所以然
        #   —— 真机上就正是这一半红的（node 栈被按字节截尾，消息被截没了）。
        check("⭐⭐ M5：要参考音频却没有 bind.ref_audio ⇒ 拒绝装配"
              "（否则会 400 拦下没给的，再把给了的丢掉）",
              rc != 0 and "ref_audio" in out,
              "rc=%d 报文点名=%s%s" % (
                  rc, "是" if "ref_audio" in out else "否",
                  "" if "ref_audio" in out else " ｜ 实际报文尾部：" +
                  " ".join(out.split())[-160:]))
        write(MANIFEST, mf_bak)

        # ---------- 还原 ----------
        check("还原后 host.py 字节级回到基线", read(HOST) == host_bak, "")
        check("还原后 manifest 字节级回到基线", read(MANIFEST) == mf_bak, "")
        rc, out = run(PROBE_HOST)
        check("还原后 probe_host 回到基线", rc == 0 and not fails_of(out),
              "rc=%d" % rc)
        rc, out = run(PROBE_CONTRACT)
        check("还原后 probe_profile_contract 回到基线", rc == 0, "rc=%d" % rc)

    finally:
        # ⛔ 无论中间怎么炸，被测文件必须回到原样 —— 它们是仓库里的真文件。
        write(HOST, host_bak)
        write(MANIFEST, mf_bak)

    print()
    print("=== 结账 ===")
    ok_all = all(o for _, o, _ in RESULTS)
    print("  %d 条，全过 = %s" % (len(RESULTS), ok_all))
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
