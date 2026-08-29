#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mutate_ab_capture —— 给 ab_capture 验红

采集器的价值全在「拦住假绿」上，所以每一道闸都得**先看见它红**。
一道从来没红过的闸，和没有这道闸是一回事。

这里起一台假服务器，它能按需扮演 shim 或 host，也能按需坏掉
（不发 X-Seed-Applied / 天花板返回同样的字节 / 没 ready / 回错
Content-Type / 回的不是 WAV）。真引擎要 GPU，跑不动验红。

⭐⭐ 最后一组是**全链路**：capture 两侧 → ab_compare 判决 → rc=0。
   两个脚本各自全绿但接不上，是很常见的一种假绿。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mutate_ab_compare as M          # 复用 synth / write_wav / pct

CAPTURE = os.path.join(HERE, "ab_capture.py")
COMPARE = os.path.join(HERE, "ab_compare.py")

PASS = []
FAIL = []


def check(label, ok, note=""):
    (PASS if ok else FAIL).append(label)
    print("  %-8s %s   [%s]" % ("RED-OK" if ok else "RED-FAIL", label, note))


# ---------------------------------------------------------------------------
#  假服务器 —— 写成文件再起进程（内联 -c 的引号地狱不值得）
# ---------------------------------------------------------------------------
# ⛔ 这段模板**不用 % 格式化**。用过，两次都栽在同一个地方：正文里随手写个
#   「100%」或「0.00%」，就变成没配对的格式符，报 "not enough arguments for
#   format string" —— 而且报在 r''' 那一行，指不到真正惹祸的注释上。
#   注入点改成一个不可能自然出现的记号，用 replace 填。
FAKE_SERVER_TMPL = r'''
import json, os, sys, wave, io, struct, math, zlib
sys.path.insert(0, __TOOLS_DIR__)
import mutate_ab_compare as M
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROLE  = os.environ.get("FAKE_ROLE", "shim")
FLAGS = set(filter(None, os.environ.get("FAKE_FLAGS", "").split(",")))
PORT  = int(sys.argv[1])
COUNT = [0]

BANNERS = {"shim": "[indextts2-shim / 2026-08-22]",
           "host": "[engine-host / 2026-08-26]"}

def stable(text, seed):
    # ⛔ 不能用内置 hash()：它每进程随机加盐（PYTHONHASHSEED），
    #    而 shim/host 两台假服务器是两个进程 ⇒ 同样输入会算出不同基频，
    #    跨路径差直接飙到 100 个点以上。这个红是**夹具**的，不是工具的。
    return zlib.crc32(("%s|%s" % (text, seed)).encode("utf-8"))

def make_wav(text, seed, emo):
    # 基频只由 (text, seed) 决定 —— 同样输入 ⇒ 同一段底噪之外完全一样。
    base = 180.0 + (stable(text, seed) % 40)
    if emo is not None:
        base *= 1.5                      # 天花板：听得出的差别
    COUNT[0] += 1
    n = COUNT[0]
    if "alteredsame" in FLAGS and emo is not None:
        base = 180.0 + (stable(text, seed) % 40)         # 改了等于没改
        n = 1
    # ⭐ 抖动的 seed 要把 ROLE 也算进去。不然假 host 的第一发和假 shim 的
    #   第一发**字节完全相同** ⇒ 跨路径恰好 0.00%，那条全链路断言就算
    #   ab_compare 的跨路径算错了也照样绿 —— 夹具比工具还弱，等于没测。
    # ⛔ 别用 len(ROLE) 区分角色 —— "shim" 和 "host" **都是 4 个字符**，
    #    区分不出来，跨路径又会掉回恰好 0。（写过，红过。）
    samples = M.synth(f0=base, noise=0.0004,
                      seed=n * 7 + (0 if ROLE == "shim" else 3))
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(M.RATE)
    w.writeframes(b"".join(struct.pack("<h", max(-32768, min(32767, int(v*32767))))
                           for v in samples))
    w.close()
    return buf.getvalue()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _json(self, code, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers(); self.wfile.write(raw)

    def do_GET(self):
        ready = "notready" not in FLAGS
        body = {"ready": ready, "failed": False, "busy": False,
                "device": "cpu", "load_seconds": 0.01, "served": COUNT[0],
                "engine": "indextts2", "banner": BANNERS[ROLE],
                "error": None, "scrubbed_paths": []}
        if ROLE == "host":
            body["seed_mode"] = "global"
            body["seed_rngs"] = ["python"]
        self._json(200 if ready else 503, body)

    def do_POST(self):
        ln = int(self.headers.get("Content-Length") or 0)
        b = json.loads(self.rfile.read(ln).decode("utf-8"))
        data = make_wav(b.get("text"), b.get("seed"), b.get("emo_alpha"))
        if "notwav" in FLAGS:
            data = b"this is not a wav file at all"
        self.send_response(200)
        ctype = "text/plain" if "badtype" in FLAGS else "audio/wav"
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Engine", "indextts2")
        if "noseed" not in FLAGS:
            self.send_header("X-Seed-Applied", "python")
        self.end_headers(); self.wfile.write(data)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
'''

FAKE_SERVER = FAKE_SERVER_TMPL.replace("__TOOLS_DIR__", repr(HERE))


class Server(object):
    def __init__(self, tmp, port, role, flags=""):
        self.port = port
        path = os.path.join(tmp, "fake_%s_%d.py" % (role, port))
        with open(path, "w", encoding="utf-8") as f:
            f.write(FAKE_SERVER)
        env = dict(os.environ, FAKE_ROLE=role, FAKE_FLAGS=flags)
        self.proc = subprocess.Popen([sys.executable, path, str(port)],
                                     env=env, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def wait(self, timeout=15.0):
        from urllib.request import urlopen
        from urllib.error import HTTPError, URLError
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                urlopen(self.url + "/health", timeout=1).read()
                return True
            except HTTPError:
                return True          # 503 也算起来了
            except URLError:
                time.sleep(0.15)
        return False

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            pass


def cap(*argv):
    p = subprocess.run([sys.executable, CAPTURE] + list(argv),
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def cmp_run(*argv):
    p = subprocess.run([sys.executable, COMPARE] + list(argv),
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    print("=== ab_capture 验红 ===\n")
    tmp = tempfile.mkdtemp(prefix="abcap-")
    servers = []
    try:
        ref = os.path.join(tmp, "ref.wav")
        M.write_wav(ref, M.synth(seed=7))

        def out(tag):
            return os.path.join(tmp, "out-" + tag)

        base = ["--ref", ref, "--text", "今天天气不错", "--seed", "12345"]

        shim = Server(tmp, 18871, "shim"); servers.append(shim)
        host = Server(tmp, 18872, "host"); servers.append(host)
        check("⭐⭐ 前提：两台假服务器都起来了（起不来下面全是空转）",
              shim.wait() and host.wait())

        # ---- 基线 -------------------------------------------------------
        d = out("base")
        rc, o = cap("--role", "shim", "--url", shim.url, "--out", d, *base)
        check("基线：shim 这一侧采完，rc=0", rc == 0, "rc=%d" % rc)
        got = sorted(f for f in os.listdir(d)) if os.path.isdir(d) else []
        check("基线：出了三段 + 一份 sidecar",
              got == ["altered.wav", "capture-shim.json", "shim-a.wav",
                      "shim-b.wav"], ",".join(got))
        check("⭐ 基线：sidecar 记下了这轮到底给了什么",
              json.load(open(os.path.join(d, "capture-shim.json"),
                             encoding="utf-8"))["common"]["seed"] == 12345)

        rc, o = cap("--role", "host", "--url", host.url, "--out", d, *base)
        check("基线：host 这一侧采完，rc=0", rc == 0, "rc=%d" % rc)
        check("基线：第四段也在", os.path.exists(os.path.join(d, "host.wav")))

        # ---- ⭐⭐ 全链路：采完能不能直接判 -------------------------------
        rc, o = cmp_run("--shim-a", os.path.join(d, "shim-a.wav"),
                        "--shim-b", os.path.join(d, "shim-b.wav"),
                        "--host", os.path.join(d, "host.wav"),
                        "--altered", os.path.join(d, "altered.wav"))
        fl, cr, ce = (M.pct(o, "地板"), M.pct(o, "跨路径"), M.pct(o, "天花板"))
        # ⛔ 不许写 `fl or -1` —— 0.0 是 falsy，真值 0.00% 会被打成 -1，
        #    一个「量到了而且是 0」的读数就长得像「没量到」。踩过一次。
        def show(v):
            return "?" if v is None else "%.2f" % v
        check("⭐⭐ 全链路：三个数都真的解析出来了（不是 None 混过去）",
              None not in (fl, cr, ce),
              "地板 %s / 跨路径 %s / 天花板 %s" % (show(fl), show(cr), show(ce)))
        check("⭐⭐ 全链路：capture 采的四段，ab_compare 直接吃得下并给出判决",
              rc == 0, "rc=%d 地板 %s / 跨路径 %s / 天花板 %s"
              % (rc, show(fl), show(cr), show(ce)))
        check("⭐⭐ 全链路：跨路径不是恰好 0（恰好 0 说明两侧字节相同，"
              "夹具没在考验跨路径那条算式）",
              cr is not None and cr > 0.0, "跨路径 %s%%" % show(cr))
        check("⭐⭐ 全链路：天花板 ≫ 地板（假服务器真的造出了分辨力）",
              None not in (ce, fl) and ce > fl * 10,
              "%s%% vs %s%%" % (show(ce), show(fl)))

        # ---- G1：端口认错 ------------------------------------------------
        # ⭐⭐ 这是最贵的一种假绿：两个 --url 指向同一台，跨路径必然 0%，
        #    全绿，什么也没证明。
        d = out("g1a")
        rc, o = cap("--role", "host", "--url", shim.url, "--out", d, *base)
        check("⭐⭐ M1：--role host 却连到 shim ⇒ 拒采",
              rc == 2, "rc=%d" % rc)
        check("⭐⭐ M1：而且明说「它其实是 shim，八成端口敲错了」",
              "端口敲错" in o and "shim" in o)
        check("⭐⭐ M1：一个文件都没写（拒采就是真不采）",
              not os.path.isdir(d) or not os.listdir(d))

        d = out("g1b")
        rc, o = cap("--role", "shim", "--url", host.url, "--out", d, *base)
        check("⭐⭐ M1 反向：--role shim 却连到 host ⇒ 也拒采",
              rc == 2, "rc=%d" % rc)

        # ---- G4：播种没生效 ----------------------------------------------
        s2 = Server(tmp, 18873, "shim", flags="noseed"); servers.append(s2)
        s2.wait()
        d = out("g4")
        rc, o = cap("--role", "shim", "--url", s2.url, "--out", d, *base)
        check("⭐⭐ M2：给了 seed 但响应头 X-Seed-Applied 是空的 ⇒ 拒采",
              rc == 1, "rc=%d" % rc)
        check("⭐⭐ M2：报文说清了为什么这会毁掉地板",
              "播种没生效" in o and "地板" in o)

        # ---- G5：天花板改了等于没改 --------------------------------------
        s3 = Server(tmp, 18874, "shim", flags="alteredsame"); servers.append(s3)
        s3.wait()
        d = out("g5")
        rc, o = cap("--role", "shim", "--url", s3.url, "--out", d, *base)
        check("⭐⭐ M3：天花板那段和 shim-a 逐字节相同 ⇒ 拒采（阈值没分辨力）",
              rc == 1, "rc=%d" % rc)
        check("⭐⭐ M3：⛔ 不许教人把这条关掉，只许换参数",
              "换一个" in o and "别把这条关掉" in o)

        # ---- G6：两侧输入不一样 ------------------------------------------
        d = out("g6")
        cap("--role", "shim", "--url", shim.url, "--out", d, *base)
        rc, o = cap("--role", "host", "--url", host.url, "--out", d,
                    "--ref", ref, "--text", "换了一句话", "--seed", "12345")
        check("⭐⭐ M4：host 那轮换了句子 ⇒ 拒采",
              rc == 2, "rc=%d" % rc)
        check("⭐⭐ M4：报文点名是哪个字段不一样，并把两边的值都打出来",
              "text" in o and "换了一句话" in o and "今天天气不错" in o)
        check("⭐⭐ M4：并说清「这种差长得和 host.py 坏了一模一样」",
              "一模一样" in o)

        rc, o = cap("--role", "host", "--url", host.url, "--out", d,
                    "--ref", ref, "--text", "今天天气不错", "--seed", "999")
        check("⭐⭐ M4 连带：seed 不一样也拦", rc == 2, "rc=%d" % rc)

        # ---- G7：旧文件还躺着 --------------------------------------------
        d = out("g7")
        cap("--role", "shim", "--url", shim.url, "--out", d, *base)
        rc, o = cap("--role", "shim", "--url", shim.url, "--out", d, *base)
        check("⭐⭐ M5：目录里有上一轮的 wav ⇒ 拒采（不然拿两轮对着比）",
              rc == 2, "rc=%d" % rc)
        check("⭐ M5：报文点名了是哪些文件挡路", "shim-a.wav" in o)
        rc, o = cap("--role", "shim", "--url", shim.url, "--out", d,
                    "--force", *base)
        check("⭐⭐ M5：--force 能过，但**必须**顶一句「两侧都重采」",
              rc == 0 and "两侧都重采" in o, "rc=%d" % rc)

        # ---- G6 前置：还没采 shim 就采 host --------------------------------
        d = out("g6pre")
        rc, o = cap("--role", "host", "--url", host.url, "--out", d, *base)
        check("⭐ M6：还没采 shim 就采 host ⇒ 拒采并说清先跑哪个",
              rc == 2 and "--role shim" in o, "rc=%d" % rc)

        # ---- 没 ready / 回错东西 -------------------------------------------
        s4 = Server(tmp, 18875, "shim", flags="notready"); servers.append(s4)
        s4.wait()
        d = out("nr")
        rc, o = cap("--role", "shim", "--url", s4.url, "--out", d, *base)
        check("⭐⭐ M7：模型还在加载就采 ⇒ 拒采（不然采到的是 503 不是音频）",
              rc == 2 and "ready" in o, "rc=%d" % rc)

        s5 = Server(tmp, 18876, "shim", flags="badtype"); servers.append(s5)
        s5.wait()
        d = out("bt")
        rc, o = cap("--role", "shim", "--url", s5.url, "--out", d, *base)
        check("⭐ M8：Content-Type 不是 audio/wav ⇒ 红",
              rc == 1 and "audio/wav" in o, "rc=%d" % rc)

        s6 = Server(tmp, 18877, "shim", flags="notwav"); servers.append(s6)
        s6.wait()
        d = out("nw")
        rc, o = cap("--role", "shim", "--url", s6.url, "--out", d, *base)
        check("⭐⭐ M9：回的字节不是能解析的 WAV ⇒ 红且点名，不甩 Traceback",
              rc == 1 and "WAV" in o and "Traceback" not in o, "rc=%d" % rc)

        # ---- 连不上 -------------------------------------------------------
        d = out("dead")
        rc, o = cap("--role", "shim", "--url", "http://127.0.0.1:18999",
                    "--out", d, *base)
        check("⭐ M10：连不上 ⇒ rc=2 且说人话，不甩 Traceback",
              rc == 2 and "连不上" in o and "Traceback" not in o, "rc=%d" % rc)

        # ---- 空 text ------------------------------------------------------
        d = out("empty")
        rc, o = cap("--role", "shim", "--url", shim.url, "--out", d,
                    "--ref", ref, "--text", "   ", "--seed", "1")
        check("⭐ M11：--text 是空白 ⇒ rc=2", rc == 2, "rc=%d" % rc)

    finally:
        for s in servers:
            s.stop()
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n=== 结账 ===")
    print("  %d 条，%d 过，全过 = %s"
          % (len(PASS) + len(FAIL), len(PASS), not FAIL))
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
