#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_webui_baseline —— 给 webui 那条合成路径拍一张「动手之前」的照片

  为什么需要它
  ------------
  契约 §12 第 2 步的第二半（合成路径带 engine_id）要动的是 broker 与 flow。
  Owner 2026-08-27 定：**web 前端是一条独立的更新线，这一刀一个前端文件都不碰**，
  webui 继续绑着 GPT-SoVITS 照常用。

  于是就有了一条必须被证明、而不是被声称的事：

      「webui 那条路径的行为，一个字节都没变。」

  ⛔ 「我改的时候很小心，所以它没变」不是判据，那是自述。判据得是**对照**：
     动手之前录一段音频的 sha256，动手之后用**一模一样的请求**再录一段，两个
     sha 对得上才算数。所以这个脚本必须在**主补丁落地之前**跑一次。

  ⭐⭐ 它自己先证明「sha 能不能当判据」
  --------------------------------------
  逐字节比对有一个前提：**同样的输入，这条路径本来就会给出同样的输出**。
  这个前提在 indextts2 上被验过（2026-08-27 A/B：同 seed 两次 sha 相同），
  但**在 GPT-SoVITS 上没有人验过**。若它其实是不确定的（采样带随机、算子非
  确定性、cuDNN autotune……），那"sha 不同"就永远会亮红 —— 那不是回归，
  是判据本身选错了，而这种红最容易把人逼去"调阈值调到变绿"。

  所以 --baseline 会**连采两次**：
      两次相同  ⇒ 判据形态 = 逐字节 sha（最强）
      两次不同  ⇒ 自动降级为「时长 + 响应形状 + 请求回执」，并**明说**降级了
  两种情形都会写进基线文件，--compare 照着它判，不给人临场改判据的机会。

  ⚠ 缓存必须绕开
  --------------
  平台有合成结果复用缓存（lib/cache/segmentCache.js）。命中缓存时返回的是
  **上一次的字节**，那样比出来的"相同"什么也没证明 —— 它只证明了缓存还在。
  所以每一次请求都带 force_resynth=true，走真推理。

用法（在仓库根跑）：

    动手之前：  python tools\\dev\\verify_webui_baseline.py --baseline
    动手之后：  python tools\\dev\\verify_webui_baseline.py --compare

前置：平台正常起着（start.bat），引擎在线。这个脚本**不启动任何东西**，
      它只是个客户端 —— 它要量的就是"用户点生成"那条路。
"""

import argparse
import array
import hashlib
import json
import os
import sys
import time
import wave
from urllib import request as urlrequest
from urllib import error as urlerror

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, "outputs", "ab")
BASELINE_JSON = os.path.join(OUT_DIR, "webui-baseline.json")


# ---------------------------------------------------------------------------
#  判据阈值 —— 这个数是**量出来的**，不是挑出来的
# ---------------------------------------------------------------------------
#  出处：tools/dev/probe_webui_sensitivity.py，2026-08-28 真机（后端 9886，
#  音色 Akafuyu，基线取于 2026-08-28T04:05:31）：
#
#      地板 A vs B          SNR 106.7 dB（0.03% 采样有差，最大 1 LSB）
#      地板 A vs 基线       SNR 107.7 dB（0.02% 采样有差，最大 1 LSB）  ← 跨重启
#      天花板 换音色 Leizi  SNR  -3.0 dB（91.95% 采样有差，最大 31227 LSB）
#      余量                 109.7 dB
#
#  取 实测地板 −12 dB ≈ 94.7，**向下取整到 94**。取整的理由：地板每跑会在
#  ±1 dB 内晃（106.8 / 106.7 两跑），94.7 那种一位小数是假精度；余量有 109.7 dB，
#  少那 0.7 dB 一点不影响分辨力。
#
#  ⛔ 将来这条红了，要查的是改动，不是这个数字。想调它之前先重跑 probe：
#     若地板真的掉到 94 dB 附近，那是**这条路径变了**，调阈值只会把它盖住。
SNR_JUDGE_DB = 94.0

# start.ps1:79 —— $BACKEND_PORT = 9886
DEFAULT_BACKEND = "http://127.0.0.1:9886"

# 这段文本和 seed 与 2026-08-27 的 A/B 判据用的是同一组，纯粹为了将来对得上。
DEFAULT_TEXT = "今天风很大，我们把窗户关上吧。"
DEFAULT_SEED = 12345


def line(ch="=", n=74):
    print(ch * n)


def ok(label, detail=""):
    print("   ok     %s   %s" % (label, detail))


def bad(label, detail=""):
    print("   FAIL   %s   %s" % (label, detail))


def die(msg, *extra):
    print("")
    print("[verify_webui_baseline] %s" % msg)
    for e in extra:
        print("   %s" % e)
    sys.exit(2)


# ---------------------------------------------------------------------------
#  HTTP —— 只用标准库，装不装 requests 都能跑
# ---------------------------------------------------------------------------
def http_json(method, url, payload=None, api_key=None, timeout=900):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if api_key:
        headers["x-api-key"] = api_key
    req = urlrequest.Request(url, data=data, headers=headers, method=method)
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        return resp.status, json.loads(body.decode("utf-8"))


def http_bytes(url, api_key=None, timeout=900):
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    req = urlrequest.Request(url, headers=headers, method="GET")
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def wav_info(path_or_bytes):
    """返回 (采样率, 声道, 位深, 秒数)。解析不开就返回 None —— 解析不开本身是个结论。"""
    import io
    try:
        if isinstance(path_or_bytes, bytes):
            fh = wave.open(io.BytesIO(path_or_bytes), "rb")
        else:
            fh = wave.open(path_or_bytes, "rb")
        with fh as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return {
                "sample_rate": rate,
                "channels": w.getnchannels(),
                "sample_width_bits": w.getsampwidth() * 8,
                "frames": frames,
                "duration_sec": round(frames / float(rate), 6) if rate else 0.0,
            }
    except Exception:
        return None


# ---------------------------------------------------------------------------
#  取样：发一次 /api/generate，把音频字节取回来
# ---------------------------------------------------------------------------
def pcm_samples(raw):
    """WAV 字节 → 16bit 单声道采样 array。不是 16bit PCM 就返回 None。"""
    import io as _io
    try:
        with wave.open(_io.BytesIO(raw), "rb") as w:
            if w.getsampwidth() != 2:
                return None
            n = w.getnframes()
            data = w.readframes(n)
            a = array.array("h")
            a.frombytes(data[: (len(data) // 2) * 2])
            if sys.byteorder == "big":
                a.byteswap()
            if w.getnchannels() == 2:
                a = array.array("h", a[0::2])
            return a
    except Exception:
        return None


def snr_vs(a, b):
    """两段采样的 SNR（dB）。

    ⛔ **不截齐**：长度不同就返回 None，调用方必须把它当**红**。
    判据要拦的正是「音频变短/变长了」这种回归，截齐会把它藏起来。
    """
    if a is None or b is None or not len(a) or len(a) != len(b):
        return None
    ndiff = 0
    maxd = 0
    sq = 0.0
    ss = 0.0
    for i in range(len(a)):
        d = a[i] - b[i]
        if d:
            ndiff += 1
            ad = -d if d < 0 else d
            if ad > maxd:
                maxd = ad
        sq += float(d) * float(d)
        ss += float(a[i]) * float(a[i])
    if sq == 0:
        return {"snr_db": None, "identical": True, "n": len(a),
                "diff_frac": 0.0, "max_abs_diff": 0}
    rms_d = (sq / len(a)) ** 0.5
    rms_s = (ss / len(a)) ** 0.5
    snr = 20.0 * (0.0 if rms_d == 0 else __import__("math").log10(rms_s / rms_d)) \
        if rms_s > 0 else 0.0
    return {"snr_db": round(snr, 2), "identical": False, "n": len(a),
            "diff_frac": ndiff / float(len(a)), "max_abs_diff": maxd}


def build_body(voice, text, seed, ref_audio, reference_text):
    """
    ⚠ 这个请求体的形状照抄 web/src/components/generate/GenerateTab.jsx:427-452，
      只做两处**刻意的**改动，都写在这里，免得将来有人以为是抄漏了：

        split = False       只出一段。分段 + 拼接会把 ffmpeg / 拼接算法也卷进
                            判据里，而这一刀根本不碰它们；一段最干净。
        force_resynth = True 绕开复用缓存 —— 命中缓存时拿回的是上一次的字节，
                            那样比出来的"相同"只证明缓存还在（见文件头说明）。

      其余的值一律**不传**，让服务端用它自己的默认值。理由：这一刀要证明的是
      「服务端行为没变」，那就该让服务端自己说了算的部分保持自己说了算。
      在这里把 20 个参数写死，等于把"我以为的默认值"钉进判据 —— 服务端改了
      默认值反而看不出来。
    """
    body = {
        "voice": voice,
        "text": text,
        "format": "wav",
        "split": False,
        "seed": seed,
        "source": "generate",
        "force_resynth": True,
    }
    if ref_audio:
        body["ref_audio"] = ref_audio
    if reference_text:
        body["reference_text"] = reference_text
    return body


def take_one(backend, body, api_key, label):
    t0 = time.time()
    try:
        status, res = http_json("POST", backend + "/api/generate", body, api_key)
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        die("POST /api/generate 返回 %d —— 基线没取成。" % e.code,
            "服务端说：%s" % detail,
            "⛔ 别跳过这一步去动主补丁：没有基线，'webui 行为没变' 就只能靠嘴说。")
    except Exception as e:
        die("连不上 %s/api/generate：%s" % (backend, e),
            "平台起着吗？start.bat 起的后端默认在 9886（start.ps1:79）。")

    if not res.get("ok"):
        die("服务端返回 ok=false：%s" % json.dumps(res, ensure_ascii=False)[:600])

    audio_url = res.get("audio_url")
    if not audio_url:
        die("响应里没有 audio_url，形状不对：%s" % json.dumps(res, ensure_ascii=False)[:400])

    url = audio_url if audio_url.startswith("http") else backend + audio_url
    try:
        _, audio = http_bytes(url, api_key)
    except Exception as e:
        die("音频取不回来（%s）：%s" % (url, e))

    sha = hashlib.sha256(audio).hexdigest()
    info = wav_info(audio)
    elapsed = time.time() - t0
    print("  采 %-9s ...  %d 字节  sha=%s  %.2fs%s"
          % (label, len(audio), sha[:16], elapsed,
             ("  %.3fs 音频" % info["duration_sec"]) if info else "  ⚠ 解析不开的 WAV"))
    return {
        "bytes": len(audio),
        "sha256": sha,
        "wav": info,
        "elapsed_sec": round(elapsed, 3),
        "response": res,
        "audio": audio,
    }


# ---------------------------------------------------------------------------
#  前置：平台在不在、引擎在不在、拿哪个音色
# ---------------------------------------------------------------------------
def preflight(backend, api_key, voice_arg):
    try:
        _, health = http_json("GET", backend + "/api/health", None, api_key, timeout=30)
    except Exception as e:
        die("连不上 %s/api/health：%s" % (backend, e),
            "先用 start.bat 把平台起起来，再跑这个脚本。",
            "（它是个纯客户端，不会替你启动任何东西 —— 它要量的就是'用户点生成'那条路。）")

    print("  平台 ok   version=%s" % health.get("version"))
    if not health.get("engine_online"):
        die("引擎不在线（/api/health 说 engine_online=false）。",
            "引擎地址：%s" % health.get("gpt_sovits_url"),
            "⛔ 这时候取到的基线是废的 —— 请求会直接失败，比不出任何东西。")
    ok("引擎在线", str(health.get("gpt_sovits_url")))

    if voice_arg:
        voice = voice_arg
    else:
        try:
            _, vs = http_json("GET", backend + "/api/voices", None, api_key, timeout=30)
        except Exception as e:
            die("取不到音色列表：%s" % e)
        cands = [v for v in vs.get("voices", []) if not v.get("builtin")]
        if not cands:
            die("一个可用音色都没有（除了内置 Base）。",
                "用 --voice 指定一个，或者先在界面里建一个音色。")
        voice = cands[0]["id"]
        print("  自动选了音色：%s（要换用 --voice）" % voice)
    return health, voice


# ---------------------------------------------------------------------------
#  --baseline
# ---------------------------------------------------------------------------
def do_baseline(args):
    print("[verify_webui_baseline] 给 webui 那条路径拍一张**动手之前**的照片")
    print("  仓库根 %s" % ROOT)
    print("  后端   %s" % args.backend)
    line()
    print("")
    print("[1] 前置")
    health, voice = preflight(args.backend, args.api_key, args.voice)

    if os.path.exists(BASELINE_JSON) and not args.force:
        die("已经有一份基线了：%s" % BASELINE_JSON,
            "⛔ 覆盖它意味着**用改动之后的行为当基线** —— 那之后的比对就永远是绿的，",
            "   而那种绿什么也没证明。真要重取，加 --force，并且明白你在做什么。")

    body = build_body(voice, args.text, args.seed, args.ref, args.reference_text)
    print("")
    print("[2] 连采两次 —— 先验「sha 能不能当判据」")
    print("    ⭐ 逐字节比对的前提是这条路径本来就确定；这一点在 GPT-SoVITS 上")
    print("      从来没有人验过。验不过不是失败，是判据要换一种形态。")
    a = take_one(args.backend, body, args.api_key, "第一次")
    b = take_one(args.backend, body, args.api_key, "第二次")

    deterministic = (a["sha256"] == b["sha256"])
    print("")
    if deterministic:
        ok("⭐⭐ 同输入两次 ⇒ 字节完全相同", "sha=%s" % a["sha256"][:16])
        print("       ⇒ 判据形态定为 **逐字节 sha**（最强的那种）")
        mode = "bytes"
    else:
        print("   ℹ  同输入两次 ⇒ 字节**不同**（%s vs %s）"
              % (a["sha256"][:16], b["sha256"][:16]))
        print("      这不是故障：说明这条路径本身带随机性（采样/非确定性算子）。")
        print("      ⇒ 判据形态降级为 **时长 ±%.1f%% + 响应形状 + 请求回执**。" % (args.duration_tolerance * 100))
        print("      ⛔ 降级是记在基线文件里的事实，不是 --compare 时可以临时挑的选项。")
        mode = "shape"
        if a["wav"] and b["wav"]:
            d1, d2 = a["wav"]["duration_sec"], b["wav"]["duration_sec"]
            spread = abs(d1 - d2) / max(d1, d2) if max(d1, d2) else 0
            print("      两次时长 %.3fs vs %.3fs（自身抖动 %.2f%%）" % (d1, d2, spread * 100))
            if spread > args.duration_tolerance:
                print("      ⚠⚠ 自身抖动已经超过容差 —— 那么时长也当不了判据。")
                print("         这种情况下这个脚本给不出有意义的回归判据，**请告诉我**，")
                print("         别让它继续跑出一片没有分辨力的绿。")

    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    wav_path = os.path.join(OUT_DIR, "webui-baseline.wav")
    with open(wav_path, "wb") as f:
        f.write(a["audio"])

    record = {
        "kind": "webui-baseline",
        "taken_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "why": "契约 §12 第 2 步第二半：broker/flow 改造期间证明 webui 那条路径没被碰过",
        "backend": args.backend,
        "judge_mode": mode,
        "duration_tolerance": args.duration_tolerance,
        "request_body": body,
        "health": {k: health.get(k) for k in
                   ("version", "engine_online", "gpt_sovits_url", "ffmpeg_available")},
        "sample_a": {k: a[k] for k in ("bytes", "sha256", "wav", "elapsed_sec")},
        "sample_b": {k: b[k] for k in ("bytes", "sha256", "wav", "elapsed_sec")},
        "response_keys": sorted(list(a["response"].keys())),
        "audio_file": os.path.relpath(wav_path, ROOT),
    }
    with open(BASELINE_JSON, "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=2)

    print("")
    line()
    print("[verify_webui_baseline] ✅ 基线取好了")
    print("   %s" % os.path.relpath(BASELINE_JSON, ROOT))
    print("   %s（自己听一下，确认它真的是一段正常的话）" % os.path.relpath(wav_path, ROOT))
    print("   判据形态：%s" % ("逐字节 sha" if mode == "bytes" else "时长 + 形状（已降级）"))
    print("")
    print("   ⛔ 这份文件在主补丁落地之前**别删也别重取** —— 它是这一刀里唯一")
    print("     能证明「webui 没被碰过」的东西。重取一次，证明力就归零。")
    print("")
    print("   下一步：把这段输出贴回来，我据此出主补丁。改完之后跑")
    print("       python tools\\dev\\verify_webui_baseline.py --compare")
    line()
    return 0


# ---------------------------------------------------------------------------
#  --compare
# ---------------------------------------------------------------------------
def do_compare(args):
    print("[verify_webui_baseline] 拿**动手之后**的行为跟基线对")
    print("  仓库根 %s" % ROOT)
    line()
    if not os.path.exists(BASELINE_JSON):
        die("没有基线（%s 不在）。" % os.path.relpath(BASELINE_JSON, ROOT),
            "基线必须在**动手之前**取。现在补取一份，量到的是改动之后的行为，",
            "拿它当基线，之后的比对永远是绿的 —— 那种绿什么也没证明。")
    with open(BASELINE_JSON, "r", encoding="utf-8") as f:
        base = json.load(f)

    backend = args.backend or base["backend"]
    print("  后端   %s" % backend)
    print("  基线   取于 %s，判据形态 %s" % (base["taken_at"], base["judge_mode"]))
    print("")
    print("[1] 前置")
    health, _ = preflight(backend, args.api_key, base["request_body"]["voice"])

    print("")
    print("[2] 用**基线记下的那一份**请求体重放（不是重新拼一个）")
    now = take_one(backend, base["request_body"], args.api_key, "改动后")

    print("")
    print("[3] 判")
    passed = failed = 0

    def check(cond, label, detail=""):
        nonlocal passed, failed
        if cond:
            ok(label, detail)
            passed += 1
        else:
            bad(label, detail)
            failed += 1

    base_a = base["sample_a"]
    if base["judge_mode"] == "bytes":
        check(now["sha256"] == base_a["sha256"],
              "⭐⭐ 音频字节与基线完全相同",
              "%s vs %s" % (now["sha256"][:16], base_a["sha256"][:16]))
    else:
        bd = (base_a.get("wav") or {}).get("duration_sec") or 0
        nd = (now.get("wav") or {}).get("duration_sec") or 0
        drift = abs(nd - bd) / bd if bd else 1.0
        check(drift <= base["duration_tolerance"],
              "⭐⭐ 时长与基线的差 ≤ %.1f%%" % (base["duration_tolerance"] * 100),
              "%.3fs vs %.3fs（差 %.2f%%）" % (nd, bd, drift * 100))
        print("       ℹ 时长这条拦不住字节级的变化，下面那条 SNR 才拦得住。")

        # --- SNR：与基线那一段逐采样比 -------------------------------------
        base_wav_rel = (base.get("audio_file") or "").replace("\\", os.sep)
        base_wav_path = os.path.join(ROOT, base_wav_rel) if base_wav_rel else None
        if not base_wav_path or not os.path.exists(base_wav_path):
            check(False, "⭐⭐ 与基线那一段的 SNR ≥ %.0f dB" % SNR_JUDGE_DB,
                  "⛔ 基线的 wav 不在盘上（%s）—— 判据没了出处，这不算过"
                  % (base_wav_rel or "基线里没记 audio_file"))
        else:
            with open(base_wav_path, "rb") as _f:
                base_raw = _f.read()
            s_base = pcm_samples(base_raw)
            s_now = pcm_samples(now["audio"])
            if s_base is None or s_now is None:
                check(False, "⭐⭐ 与基线那一段的 SNR ≥ %.0f dB" % SNR_JUDGE_DB,
                      "⛔ 有一边不是 16bit PCM WAV，量不了")
            elif len(s_base) != len(s_now):
                check(False, "⭐⭐ 与基线那一段的 SNR ≥ %.0f dB" % SNR_JUDGE_DB,
                      "⛔ 采样数不同（%d vs %d）—— ⛔ 不截齐：长度变了本身就是回归"
                      % (len(s_now), len(s_base)))
            else:
                r = snr_vs(s_now, s_base)
                if r["identical"]:
                    check(True, "⭐⭐ 与基线那一段的 SNR ≥ %.0f dB" % SNR_JUDGE_DB,
                          "采样**逐个相同**（%d 个）" % r["n"])
                else:
                    check(r["snr_db"] >= SNR_JUDGE_DB,
                          "⭐⭐ 与基线那一段的 SNR ≥ %.0f dB" % SNR_JUDGE_DB,
                          "实测 %.1f dB（%.2f%% 的采样有差，最大 %d LSB）"
                          % (r["snr_db"], r["diff_frac"] * 100, r["max_abs_diff"]))
                    print("       ℹ 实测地板 106.7/107.7 dB、天花板 -3.0 dB，余量 109.7 dB。")
                    print("         这条红了 = 音频**真的变了**，不是抖动。")

    bw = base_a.get("wav") or {}
    nw = now.get("wav") or {}
    for key, label in (("sample_rate", "采样率"), ("channels", "声道"),
                       ("sample_width_bits", "位深")):
        check(bw.get(key) == nw.get(key), "%s 没变" % label,
              "%s vs %s" % (nw.get(key), bw.get(key)))

    check(sorted(list(now["response"].keys())) == base["response_keys"],
          "响应字段没多也没少",
          "%d 个" % len(base["response_keys"]))

    check(bool(health.get("engine_online")), "引擎仍在线")

    print("")
    line()
    print("结账：%d 条，%d 过，%d 没过" % (passed + failed, passed, failed))
    if failed == 0:
        print("判决：**webui 那条路径的行为没变**（对照基线得出，不是自述）")
        line()
        return 0
    print("判决：⛔ webui 那条路径**被碰到了**")
    print("   这一刀说好了不动前端、也不动 webui 的行为。红了就是改超范围了 ——")
    print("   ⛔ 别调容差、别重取基线。回去看 broker/flow 那几处改动是不是顺手")
    print("     动了 synthesisService / payload / gsv client 这些两条路共用的东西。")
    line()
    return 1


def main():
    ap = argparse.ArgumentParser(prog="verify_webui_baseline")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--baseline", action="store_true", help="动手之前：拍照")
    g.add_argument("--compare", action="store_true", help="动手之后：对照")
    ap.add_argument("--backend", default=None, help="后端地址（默认 %s）" % DEFAULT_BACKEND)
    ap.add_argument("--voice", default=None, help="用哪个音色（默认自动选第一个）")
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--ref", default=None, help="参考音频绝对路径（不给就让服务端按音色自己解析）")
    ap.add_argument("--reference-text", default=None)
    ap.add_argument("--api-key", default=os.environ.get("API_KEY") or os.environ.get("BROKER_API_KEY"))
    ap.add_argument("--duration-tolerance", type=float, default=0.02,
                    help="降级形态下的时长容差，默认 2%%")
    ap.add_argument("--force", action="store_true", help="覆盖已有基线（⛔ 想清楚再用）")
    args = ap.parse_args()
    if not args.backend:
        args.backend = DEFAULT_BACKEND
    args.backend = args.backend.rstrip("/")
    return do_baseline(args) if args.baseline else do_compare(args)


if __name__ == "__main__":
    sys.exit(main())
