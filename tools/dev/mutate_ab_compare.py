# -*- coding: utf-8 -*-
"""mutate_ab_compare —— 给 ab_compare.py 验红。

⭐ 判据这种东西，「跑出来是绿的」什么都不说明 —— 一个永远返回绿的比对器
  也是绿的。所以这一支不看它绿不绿，只看它**该红的时候红不红**：
  换了内容红没红、时长差太多红没红、采样率接错线红没红，
  以及最要紧的那条 —— **天花板不显著时它拒不拒绝出绿灯**。

⛔ 不需要 GPU、不需要模型、不需要引擎。音频是现场合成的。
  这是故意的：**比对器的对错不该依赖你有没有显卡**，
  否则每验一次判据都要占用真机。
"""

import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "ab_compare.py")

RATE = 22050
SECONDS = 1.5

RESULTS = []


def check(name, ok, note=""):
    RESULTS.append((name, ok, note))
    print("  %-8s %s   [%s]" % ("RED-OK" if ok else "RED-FAIL", name, note))


# ---------------------------------------------------------------------------
# 合成音频 —— 要像人声：有基频有谐波有包络，而不是一根纯正弦
# ---------------------------------------------------------------------------

def _rng(seed):
    """自带的确定性伪随机 —— 不用 random 模块，免得受全局 seed 干扰。"""
    state = [seed & 0xFFFFFFFF]

    def nxt():
        state[0] = (1103515245 * state[0] + 12345) & 0x7FFFFFFF
        return state[0] / float(0x7FFFFFFF) * 2.0 - 1.0
    return nxt


BREATH = 0.02      # 气声底噪的幅度（约 −34 dB）
BREATH_SEED = 999  # ⭐ 固定，于是它在每一段里**逐样本完全相同**


def synth(f0=140.0, noise=0.0, seed=1, seconds=SECONDS, rate=RATE,
          breath=BREATH):
    """基频 + 谐波 + 慢包络 + 宽带气声 + 可控抖动。

    ⭐ 用谐波而不是单根正弦：单根正弦除了那一格全是静音。
    ⭐⭐ 还必须有**宽带气声**，否则夹具是假的：只有 8 次谐波的话信号只到
      1.1 kHz，上面九成的梅尔格里除了噪声什么都没有，量出来的就是静音段的
      浮点垃圾 —— 真实的 TTS 输出没有这种空谱。气声用**固定 seed**，所以
      它在每一段里逐样本相同，不会自己变成差异来源；真正的「两次推理不一样」
      由 noise 参数单独承担。
    """
    n = int(rate * seconds)
    rnd = _rng(seed)
    brnd = _rng(BREATH_SEED)
    out = []
    for i in range(n):
        t = i / float(rate)
        env = 0.5 + 0.5 * math.sin(2.0 * math.pi * 2.0 * t)
        v = 0.0
        for h in range(1, 9):
            v += math.sin(2.0 * math.pi * f0 * h * t) / float(h)
        v = v * env * 0.25 + brnd() * breath
        if noise:
            v += rnd() * noise
        out.append(max(-1.0, min(1.0, v)))
    return out


def write_wav(path, samples, rate=RATE, channels=1, sampwidth=2):
    w = wave.open(path, "wb")
    try:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        data = []
        for v in samples:
            iv = int(max(-1.0, min(1.0, v)) * 32767)
            for _ in range(channels):
                data.append(struct.pack("<h", iv))
        w.writeframes(b"".join(data))
    finally:
        w.close()


def run(args):
    r = subprocess.run([sys.executable, TOOL] + args,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       timeout=900)
    return r.returncode, r.stdout.decode("utf-8", "replace")


def verdict(out, keyword):
    """某一条判决是绿还是红。返回 True/False/None(没这条)。

    ⛔ 别去字面匹配 "ok     " / "⛔     " 那几个空格 —— `%-6s` 对
      「⛔」这种宽字符是**按字符数**补齐的，肉眼数出来的空格数会错一个。
      这次就错了一个，白跑一轮。按行解析，不数空格。
    """
    for ln in out.split("\n"):
        if keyword in ln:
            head = ln.strip()
            if head.startswith("ok"):
                return True
            if head.startswith("⛔"):
                return False
    return None


def pct(out, label):
    """从输出里捞某一行的梅尔百分比。"""
    for ln in out.split("\n"):
        if ln.strip().startswith(label) and "梅尔相对差" in ln:
            head = ln.split("梅尔相对差", 1)[1]
            return float(head.split("%", 1)[0].strip())
    return None


def main():
    print("=== ab_compare 验红 ===")
    print("")
    d = tempfile.mkdtemp(prefix="abgate_")
    try:
        # 参照，以及同一条路径跑第二次（只差一点点浮点噪声）
        base = synth(seed=1)
        write_wav(os.path.join(d, "a1.wav"), base)
        write_wav(os.path.join(d, "a2.wav"), synth(noise=0.0004, seed=2))
        write_wav(os.path.join(d, "host.wav"), synth(noise=0.0004, seed=7))
        # 天花板：故意「改了个参数」—— 基频挪一截，听得出来的那种
        write_wav(os.path.join(d, "alt.wav"), synth(f0=185.0, seed=1))
        # 其它夹具
        write_wav(os.path.join(d, "same.wav"), base)
        write_wav(os.path.join(d, "short.wav"),
                  synth(noise=0.0004, seed=2, seconds=SECONDS * 0.90))
        write_wav(os.path.join(d, "sr44.wav"), synth(seed=1), rate=44100)
        write_wav(os.path.join(d, "stereo.wav"), base, channels=2)

        def p(name):
            return os.path.join(d, name)

        four = ["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                "--host", p("host.wav"), "--altered", p("alt.wav")]

        # ---- 前提：夹具本身站得住 ---------------------------------------
        rc, out = run(["--pair", p("a1.wav"), p("same.wav")])
        v_same = pct(out, "这一对")
        check("⭐⭐ 前提：同一段音频跟自己比 = 0%（不是 0 就说明指标本身坏了）",
              rc == 0 and v_same is not None and v_same < 0.001,
              "实测 %s%%" % v_same)

        rc, out = run(four)
        floor = pct(out, "地板")
        cross = pct(out, "跨路径")
        ceiling = pct(out, "天花板")
        check("⭐⭐ 前提：三个数都量出来了", None not in (floor, cross, ceiling),
              "地板 %s / 跨路径 %s / 天花板 %s" % (floor, cross, ceiling))
        check("⭐⭐ 前提：天花板 ≫ 地板（夹具真的造出了「听得出的差别」）",
              ceiling > floor * 5, "%.2f%% vs %.2f%%" % (ceiling, floor))
        check("基线：四段齐全 ⇒ 判决通过", rc == 0, "rc=%d" % rc)
        check("基线：判决里写了结论", "可以替代" in out)

        # ---- 确定性：判据不能每跑一次给一个数 ---------------------------
        rc2, out2 = run(four)
        check("⭐⭐ 确定性：同样输入跑两次，数字逐字一致（判据不能自己抖）",
              pct(out2, "跨路径") == cross and pct(out2, "地板") == floor,
              "%.4f%%" % cross)

        # ---- M1：天花板不显著 ⇒ 必须拒绝出绿灯 --------------------------
        rc, out = run(["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                       "--host", p("host.wav"), "--altered", p("same.wav")])
        check("⭐⭐ M1：天花板拿同一段冒充 ⇒ 阈值没有分辨力 ⇒ 判决必须红",
              rc == 1, "rc=%d" % rc)
        check("⭐⭐ M1：红的理由点到了「分辨力」，不是别的",
              "分辨力" in out and "天花板" in out)

        # ---- M2：跨路径其实是另一段音频 ⇒ 必须红 -------------------------
        rc, out = run(["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                       "--host", p("alt.wav"), "--altered", p("alt.wav")])
        check("⭐⭐ M2：host 那条换成明显不同的音频 ⇒ 跨路径闸必须红",
              rc == 1, "rc=%d" % rc)
        check("⭐ M2：红在梅尔那条上", "跨路径梅尔差" in out)

        # ---- M3：时长差 10% ⇒ 时长闸必须红（且不被梅尔的截齐糊弄过去）----
        rc, out = run(["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                       "--host", p("short.wav"), "--altered", p("alt.wav")])
        check("⭐⭐ M3：跨路径时长差 10% ⇒ 时长闸必须红",
              rc == 1, "rc=%d" % rc)
        v_dur = verdict(out, "跨路径时长差")
        v_mel = verdict(out, "跨路径梅尔差")
        check("⭐⭐ M3：**梅尔那条是绿的** ⇒ 证明时长是独立一道闸，"
              "没被「按短的截齐」偷偷放过",
              v_dur is False and v_mel is True,
              "时长=%s 梅尔=%s" % (v_dur, v_mel))

        # ---- M4/M5：硬闸 —— 采样率、声道，不给容差 ----------------------
        rc, out = run(["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                       "--host", p("sr44.wav"), "--altered", p("alt.wav")])
        check("⭐⭐ M4：采样率不同 ⇒ 硬闸红（这不是精度问题，是接错线）",
              rc == 1 and "采样率不同" in out, "rc=%d" % rc)
        rc, out = run(["--shim-a", p("a1.wav"), "--shim-b", p("a2.wav"),
                       "--host", p("stereo.wav"), "--altered", p("alt.wav")])
        check("⭐⭐ M5：声道数不同 ⇒ 硬闸红",
              rc == 1 and "声道数不同" in out, "rc=%d" % rc)

        # ---- M6：非预设参数 ⇒ 明说不作为判据 -----------------------------
        rc, out = run(four + ["--mel-threshold", "0.9"])
        check("⭐⭐ M6：把阈值拧松 ⇒ 抬头必须写明「不作为验收判据」",
              "不作为验收判据" in out, "rc=%d" % rc)
        check("⭐⭐ M6：结尾**再说一次**（抬头容易被滚上去看不见）",
              "再说一次" in out)
        check("⭐ M6：报文点名了改的是哪个键", "mel_threshold" in out)
        check("⭐⭐ M6：非预设时不打印「可以替代」这种验收结论",
              "可以替代" not in out)

        # ---- M7：预设模式下，实际取值必须印在报告上 -----------------------
        rc, out = run(four)
        check("⭐⭐ M7：预设模式把每个实际取值都印出来（锁是靠可见锁的）",
              all(k in out for k in ("n_fft=1024", "hop=256", "n_mels=80",
                                     "eps=1e-10")),
              "判据模式" if "判据模式" in out else "抬头没写模式")

        # ---- M8：缺参数 ⇒ 不许静默降级成「比两段」------------------------
        rc, out = run(["--shim-a", p("a1.wav"), "--host", p("host.wav")])
        check("⭐⭐ M8：只给两段 ⇒ 拒绝出判决（不降级成「差不多也行」）",
              rc == 2, "rc=%d" % rc)
        check("⭐ M8：报文说清了为什么四段都要",
              "--shim-b" in out and "--altered" in out and "地板" in out)

        # ---- M9：分析模式不出判决 ----------------------------------------
        rc, out = run(["--pair", p("a1.wav"), p("alt.wav")])
        check("⭐ M9：--pair 只报数不出判决（差很大也不该 rc=1）",
              rc == 0 and "可以替代" not in out and "结账" not in out,
              "rc=%d" % rc)

        # ---- M10：文件不在 ⇒ 说清是哪个，不抛栈 --------------------------
        rc, out = run(["--pair", p("a1.wav"), p("没有这个.wav")])
        check("⭐ M10：文件不在 ⇒ rc=2 且点名，不甩 Traceback",
              rc == 2 and "文件不在" in out and "Traceback" not in out,
              "rc=%d" % rc)

        # ---- M11：地板闸 —— 地板超阈值时，必须说清红的是阈值不是 host ----
        # ⭐⭐ 这条替代了原来的「top_db 承重」。原来那条量出来是 1.00~1.07 倍
        #   （甚至 0.66 倍，夹完反而更敏感）⇒ 那一刀的理由是错的，已删。
        #   兜住「静音格过敏」这件事的其实是地板闸：地板从真音频量出来，
        #   过敏真咬人时它会先超阈值，并且**指向阈值而不是 host.py**。
        write_wav(p("q1.wav"), synth(noise=0.0004, seed=11, breath=0.0))
        write_wav(p("q2.wav"), synth(noise=0.0004, seed=12, breath=0.0))
        rc, out = run(["--shim-a", p("q1.wav"), "--shim-b", p("q2.wav"),
                       "--host", p("q2.wav"), "--altered", p("alt.wav")])
        fl = pct(out, "地板")
        check("⭐⭐ M11 前提：这份带限夹具的地板真的超了 5%（不然下面是空转）",
              fl is not None and fl > 5.0, "地板 %.2f%%" % fl)
        check("⭐⭐ M11：地板超阈值 ⇒ 判决红", rc == 1, "rc=%d" % rc)
        check("⭐⭐ M11：而且明说**红的是阈值不是 host** —— 两种红要查的地方相反",
              "红的是阈值不是 host" in out or "要改的是阈值" in out)
        check("⭐⭐ M11：⛔ 不许顺手教人调到绿",
              "别一路调到跨路径正好过" in out)

    finally:
        shutil.rmtree(d, ignore_errors=True)

    print("")
    print("=== 结账 ===")
    ok = sum(1 for _, o, _ in RESULTS if o)
    print("  %d 条，%d 过，全过 = %s" % (len(RESULTS), ok, ok == len(RESULTS)))
    return 0 if ok == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
