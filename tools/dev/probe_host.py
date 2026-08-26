# -*- coding: utf-8 -*-
"""probe_host —— 让通用宿主带一台**假引擎**真的跑起来

为什么要假引擎
--------------
宿主的验收不能依赖「装了 IndexTTS2 的那台机器」。假引擎只用标准库写一个
真的 WAV 文件，于是这份宿主在**任何**机器上都能被完整跑一遍：起进程、
绑端口、探活、四类 400、真出音频、播种、收尾。

⭐ 这也顺带证明了一件事：宿主对「上游是谁」一无所知 —— 它连 torch 都不需要。
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOST_PY = os.path.join(ROOT, "lib", "engines", "host.py")
PY = sys.executable

ROWS = []


def row(name, ok, note=""):
    ROWS.append((name, ok, note))
    print("   %-6s %s%s" % ("ok" if ok else "FAIL", name,
                            ("   %s" % note) if note else ""))


def detail_of(raw):
    """⛔ 绝不能让「被测对象返回了意料之外的东西」把这支探针自己搞崩。

    2026-08-26 验红实测：宿主一旦把该拒的请求放行，它回的是 **WAV 字节**；
    这里原本直接 json.loads(raw.decode("utf-8")) ⇒ UnicodeDecodeError ⇒
    整支探针崩掉 ⇒ **一条 FAIL 都没打印**，验红把它读成了「红 0 条」。
    闸自己崩掉比闸没抓到更糟：它让读数看起来是绿的。
    """
    try:
        return json.loads(raw.decode("utf-8")).get("detail", "")
    except Exception:
        return "<非 JSON 响应，%d 字节：%r…>" % (len(raw), raw[:16])


def guarded(section):
    """把一节里的意外异常变成一条 FAIL，而不是让整支探针退场。"""
    def deco(fn):
        def run(*a, **kw):
            try:
                return fn(*a, **kw)
            except Exception as exc:
                row("⛔ [%s] 这一节自己抛异常了（探针缺陷，不是结论）" % section,
                    False, "%s: %s" % (type(exc).__name__, exc))
        return run
    return deco


# --------------------------------------------------------------- 假引擎
FAKE_ENGINE = '''# -*- coding: utf-8 -*-
"""一台只用标准库的假引擎。它不认识 Aurivox，Aurivox 也不认识它。"""
import random, struct, wave

class FakeTTS(object):
    def __init__(self, cfg_path, model_dir, use_fp16=False):
        self.cfg_path = cfg_path
        self.model_dir = model_dir
        self.use_fp16 = use_fp16

    def speak(self, sentence, prompt_wav, out_file, loudness=0.5, pace=1.0):
        # 用当前全局 random 状态生成 —— 于是「播种有没有生效」
        # 可以靠「同 seed 两次字节是否相同」来判定。
        n = int(8000 * 0.25 * pace)
        frames = b"".join(
            struct.pack("<h", int(random.uniform(-1, 1) * 32767 * loudness))
            for _ in range(n))
        with wave.open(out_file, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(frames)
        return out_file
'''


def make_profile(engine_dir, ckpt_dir, seed_spec):
    return {
        "id": "faketts",
        "label": {"zh": "假引擎", "en": "Fake TTS"},
        "runtime": {"sys_path": [engine_dir], "cwd": engine_dir},
        "call": {
            "kind": "python",
            "module": "fake_engine",
            "class": "FakeTTS",
            "init_args": {"cfg_path": os.path.join(ckpt_dir, "config.yaml"),
                          "model_dir": ckpt_dir},
            "method": "speak",
            "bind": {"text": "sentence", "ref_audio": "prompt_wav",
                     "output_path": "out_file"},
            "returns": "file",
            "seed": seed_spec,
        },
        "params": {"load_time": ["use_fp16"], "call_time": ["loudness", "pace"]},
        "capabilities": {"requires_reference_audio": True},
        "output_formats": ["wav"],
    }


def http(method, url, body=None, timeout=15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def wait_ready(base, proc, limit=20.0):
    t0 = time.time()
    while time.time() - t0 < limit:
        if proc.poll() is not None:
            return None
        try:
            code, raw, _ = http("GET", base + "/health", timeout=2)
            j = json.loads(raw.decode("utf-8"))
            if j.get("ready") or j.get("failed"):
                return j
        except Exception:
            pass
        time.sleep(0.2)
    return None


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    print("probe_host —— 通用宿主带一台假引擎跑通全程")
    print("项目根：%s" % ROOT)
    print("=" * 74)
    print()

    if not os.path.isfile(HOST_PY):
        print("⛔ 找不到宿主：%s" % HOST_PY)
        return 2

    work = tempfile.mkdtemp(prefix="probe_host_")
    procs = []
    try:
        eng_dir = os.path.join(work, "engine")
        ckpt = os.path.join(eng_dir, "checkpoints")
        os.makedirs(ckpt)
        with open(os.path.join(eng_dir, "fake_engine.py"), "w") as f:
            f.write(FAKE_ENGINE)
        with open(os.path.join(ckpt, "config.yaml"), "w") as f:
            f.write("fake: true\n")
        ref = os.path.join(work, "ref.wav")
        with wave.open(ref, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
            w.writeframes(b"\x00\x00" * 800)

        # ---------------- 1) 起宿主 ----------------
        prof_path = os.path.join(work, "profile.json")
        prof = make_profile(eng_dir, ckpt,
                            {"mode": "global", "rngs": ["python"],
                             "when": "before_call", "scope": "locked"})
        with open(prof_path, "w") as f:
            json.dump(prof, f)

        port = free_port()
        base = "http://127.0.0.1:%d" % port
        p = subprocess.Popen(
            [PY, HOST_PY, "--profile-json", prof_path, "--port", str(port)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        procs.append(p)

        print("[1] 宿主能不能带着一份「解析好的名片」起来")
        h = wait_ready(base, p)
        row("进程起来了并且 /health 有回答", h is not None,
            "" if h else "（20 秒内没起来）")
        if h is None:
            out, err = p.communicate(timeout=5)
            print(err.decode("utf-8", "replace")[-2000:])
            return 1
        row("加载成功（ready=true, failed=false）",
            h.get("ready") is True and h.get("failed") is False,
            "load=%ss device=%s" % (h.get("load_seconds"), h.get("device")))
        row("⭐ /health 报出了播种计划（可取证，不用猜）",
            h.get("seed_mode") == "global" and h.get("seed_rngs") == ["python"],
            "%s %s" % (h.get("seed_mode"), h.get("seed_rngs")))
        row("引擎身份来自名片，不是写死的", h.get("engine") == "faketts",
            h.get("engine"))
        print()

        # ---------------- 2) 真的出音频 ----------------
        print("[2] 真的能出一段音频")
        code, raw, hdr = http("POST", base + "/tts",
                              {"text": "你好", "ref_audio_path": ref,
                               "seed": 12345, "loudness": 0.4})
        row("POST /tts 返回 200", code == 200, "code=%d" % code)
        ok_wav = False
        if code == 200:
            try:
                with wave.open(io.BytesIO(raw), "rb") as w:
                    ok_wav = w.getframerate() == 8000 and w.getnchannels() == 1
            except Exception:
                pass
        row("返回的是能解析的 WAV", ok_wav, "%d 字节" % len(raw))
        row("Content-Type 是 audio/wav",
            hdr.get("Content-Type") == "audio/wav", hdr.get("Content-Type"))
        row("⭐ X-Seed-Applied 报出实际生效的随机源",
            hdr.get("X-Seed-Applied") == "python", hdr.get("X-Seed-Applied"))
        row("X-Engine 是名片里的 id", hdr.get("X-Engine") == "faketts")
        print()

        # ---------------- 3) 播种是不是真的生效 ----------------
        print("[3] 播种到底生效没有（判据是字节，不是自述）")
        _, a, _ = http("POST", base + "/tts",
                       {"text": "你好", "ref_audio_path": ref, "seed": 999})
        _, b, _ = http("POST", base + "/tts",
                       {"text": "你好", "ref_audio_path": ref, "seed": 999})
        _, c, _ = http("POST", base + "/tts",
                       {"text": "你好", "ref_audio_path": ref, "seed": 1000})
        row("⭐⭐ 同 seed 两次 ⇒ 字节完全相同", a == b, "%d vs %d 字节" % (len(a), len(b)))
        row("⭐⭐ 换 seed ⇒ 字节不同（不然上一条是假绿）", a != c)
        print()

        # ---------------- 4) 四类 400 ----------------
        print("[4] 四类 400 —— 名片错了要当场喊，不许静默")
        cases = [
            ("空 text", {"text": "  ", "ref_audio_path": ref}, "text"),
            ("缺参考音频", {"text": "x"}, "ref_audio_path"),
            ("参考音频不存在", {"text": "x", "ref_audio_path": ref + ".nope"},
             "not found"),
            ("不认识的参数（拼错）",
             {"text": "x", "ref_audio_path": ref, "loudnes": 1}, "loudnes"),
            ("加载期参数出现在调用里",
             {"text": "x", "ref_audio_path": ref, "use_fp16": True}, "use_fp16"),
            ("要 mp3", {"text": "x", "ref_audio_path": ref, "format": "mp3"},
             "mp3"),
            ("seed 是负数", {"text": "x", "ref_audio_path": ref, "seed": -1},
             ">= 0"),
            ("seed 不是整数", {"text": "x", "ref_audio_path": ref, "seed": "abc"},
             "integer"),
        ]
        for name, body, needle in cases:
            code, raw, _ = http("POST", base + "/tts", body)
            detail = detail_of(raw)
            row("400 %s" % name, code == 400 and needle in detail,
                "code=%d" % code)
        code, _, _ = http("GET", base + "/nope")
        row("未知路径 404", code == 404, "code=%d" % code)
        print()

        p.terminate()
        p.wait(timeout=10)

        # ---------------- 5) seed = "none" 必须显式拒收 ----------------
        print('[5] call.seed = "none" ⇒ **拒收** seed（契约 §5.2.1）')
        prof2 = make_profile(eng_dir, ckpt, "none")
        p2_path = os.path.join(work, "profile_none.json")
        with open(p2_path, "w") as f:
            json.dump(prof2, f)
        port2 = free_port()
        base2 = "http://127.0.0.1:%d" % port2
        p2 = subprocess.Popen(
            [PY, HOST_PY, "--profile-json", p2_path, "--port", str(port2)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        procs.append(p2)
        h2 = wait_ready(base2, p2)
        row("起得来", h2 is not None and h2.get("ready"))
        if h2:
            code, raw, _ = http("POST", base2 + "/tts",
                                {"text": "x", "ref_audio_path": ref, "seed": 1})
            detail = detail_of(raw)
            row("⭐⭐ 带 seed 的请求被 400 拒收，不是收下扔掉",
                code == 400 and "cannot" in detail,
                "code=%d detail=%.60s" % (code, detail))
            code, _, _ = http("POST", base2 + "/tts",
                              {"text": "x", "ref_audio_path": ref})
            row("不带 seed 的请求照常 200", code == 200, "code=%d" % code)
        p2.terminate(); p2.wait(timeout=10)
        print()

        # ---------------- 6) 名片不全就别启动 ----------------
        print("[6] 解析结果不完整 ⇒ 拒绝启动（不装出一副能跑的样子）")
        bad_cases = [
            ("没写 call.seed", lambda d: d["call"].pop("seed"), "§5.2.1"),
            ("seed 写 global 却没列 rngs",
             lambda d: d["call"].__setitem__("seed", {"mode": "global", "scope": "locked"}),
             "没列 rngs"),
            ("seed 的 scope 不是 locked",
             lambda d: d["call"].__setitem__(
                 "seed", {"mode": "global", "rngs": ["python"], "scope": "free"}),
             "locked"),
            ("rngs 里有不认识的随机源",
             lambda d: d["call"].__setitem__(
                 "seed", {"mode": "global", "rngs": ["jax"], "scope": "locked"}),
             "不认识"),
            ("缺 call.bind.text", lambda d: d["call"]["bind"].pop("text"), "bind.text"),
            ("returns=file 却没有 output_path",
             lambda d: d["call"]["bind"].pop("output_path"), "output_path"),
        ]
        for name, hurt, needle in bad_cases:
            d = make_profile(eng_dir, ckpt,
                             {"mode": "global", "rngs": ["python"],
                              "when": "before_call", "scope": "locked"})
            hurt(d)
            bp = os.path.join(work, "bad.json")
            with open(bp, "w") as f:
                json.dump(d, f)
            # ⛔ 名片不全时宿主**可能真的起来并一直服务** —— 那正是要抓的失败，
            #   但 subprocess.run(timeout=) 会抛 TimeoutExpired 把探针自己带走。
            #   超时 = 「它没拒绝启动」= 一条 FAIL，不是探针退场的理由。
            try:
                r = subprocess.run([PY, HOST_PY, "--profile-json", bp,
                                    "--port", str(free_port())],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=30)
                rc, err = r.returncode, r.stderr.decode("utf-8", "replace")
            except subprocess.TimeoutExpired:
                rc, err = None, ""
            # ⭐ 判据是 rc==2（契约里「名片不合格」的专用退出码），不是「非零」：
            #   裸 traceback 也是非零，但那是崩了，不是**拒绝**。
            row("拒绝启动：%s" % name, rc == 2 and needle in err,
                "起来了没拒绝（超时）" if rc is None else "rc=%d" % rc)
        print()

        print("=" * 74)
        bad = [n for n, ok, _ in ROWS if not ok]
        print("结账：%d 条，%d 过，%d 没过" % (len(ROWS), len(ROWS) - len(bad), len(bad)))
        for n in bad:
            print("   FAIL  %s" % n)
        return 0 if not bad else 1
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except Exception:
                    p.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
