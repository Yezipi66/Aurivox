# -*- coding: utf-8 -*-
"""
probe_webui_sensitivity（第二版）—— 量降级判据的分辨力，顺便把「地板 = 0.0000」查清楚

  第一版跑出两件事，都得处理：

  ① 地板 = 0.0000，可是 sha 不同。
     这两句话放在一起是**矛盾**的。包络一样只说明"响度曲线一样"，
     它对小幅度的差不敏感 —— 所以真正的问题还没回答：**那些字节到底
     差在哪、差多少**？
     ⇒ 第二版加了一把更细的尺子：直接比 PCM 采样本身。
        差 1 个最低位（抖动/量化噪声）和差半个波形，在包络上都可能是
        0.0000，但在采样上差着 60 dB。这一栏才决定判据能有多严。
     ⭐⭐ 如果差异小到可以忽略，判据应当**往严了升**（回到近似逐字节），
        而不是停在那条宽了两个数量级的 ±2%。降级是当时证据支持的结论，
        证据变细了，结论就该跟着变。

  ② 天花板那一枪打空了：自动挑的第二个音色参考音频只有 2.3s，
     服务端按规矩 400 了（GPT-SoVITS 要 3–10s）。
     ⇒ 第二版换音色时**逐个试**，400 就跳过换下一个；一个能用的都没有，
       就退回用「换一段文本」当天花板 —— 反正天花板只需要是"一个真的
       不一样的请求"，不必非是换音色。
     ⛔ 仍然**不用换 seed 当天花板**：这条路径本来就不确定，换 seed 的差
       和地板是同一类东西，量出来一样高，证明不了任何事。

  ⛔ 这个脚本**只读**基线文件，一个字节都不改它。产物另写
     outputs/ab/webui-sensitivity.json。

用法（平台起着、引擎在线）：
    python tools\\dev\\probe_webui_sensitivity.py
"""

import argparse
import array
import hashlib
import io
import json
import math
import os
import sys
import time
import wave
from urllib import request as urlrequest
from urllib import error as urlerror

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT_DIR = os.path.join(ROOT, "outputs", "ab")
BASELINE_JSON = os.path.join(OUT_DIR, "webui-baseline.json")
PROBE_JSON = os.path.join(OUT_DIR, "webui-sensitivity.json")

CEILING_TEXT = "他把伞收起来，靠在门边，说明天也许会放晴。"


def line(ch="=", n=74):
    print(ch * n)


def ok(label, detail=""):
    print("   ok     %s%s" % (label, ("   " + detail) if detail else ""))


def die(msg, *extra):
    print("")
    print("[probe_webui_sensitivity] \u26d4 %s" % msg)
    for e in extra:
        print("   %s" % e)
    sys.exit(2)


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
        raw = resp.read().decode("utf-8", "replace")
        return resp.getcode(), (json.loads(raw) if raw.strip() else {})


def http_bytes(url, api_key=None, timeout=900):
    headers = {}
    if api_key:
        headers["x-api-key"] = api_key
    req = urlrequest.Request(url, headers=headers, method="GET")
    with urlrequest.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
#  两把尺子
#
#  尺子一：PCM 采样直比（细）
#     一样长的两段，逐采样求差，报三个数：
#       差了几成采样、最大差多少个 LSB、以及 **SNR(dB)**。
#     SNR = 20log10( rms(信号) / rms(差) )。它越大，两段越像：
#       > 90 dB   差在 16bit 的最低几位 —— 肉眼级别的"一样"
#       ~ 40 dB   听不出，但确实是不同的渲染
#       < 10 dB   两段是不同的话
#     ⭐ 这把尺子只有在**两段一样长**时才有意义；不一样长时它 N/A，
#       那时候长度本身已经是判据了（时长那一条会先红）。
#
#  尺子二：响度包络（粗，但长度不同也能比）
#     40ms RMS → 重采样到 200 点 → 除以自身均值。对相位不敏感、
#     对"换了个人说 / 换了句话"很敏感。第一版就是它，留着做对照。
# ---------------------------------------------------------------------------

FRAME_MS = 40.0
CURVE_POINTS = 200
# 包络地板小于这个数就当零：再往下是浮点残渣，拿它当分母算出来的
# 倍率（那个 9093047.3x）是噪声，不是读数。
ENV_RATIO_MIN = 1e-6


def pcm(audio_bytes):
    """取出单声道 16bit 采样序列 + 基本参数。"""
    with wave.open(io.BytesIO(audio_bytes), "rb") as w:
        if w.getsampwidth() != 2:
            return None, None
        ch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    a = array.array("h")
    a.frombytes(raw[: (len(raw) // 2) * 2])
    if sys.byteorder == "big":
        a.byteswap()
    if ch > 1:
        a = array.array("h", [a[i] for i in range(0, len(a) - ch + 1, ch)])
    return a, {"rate": rate, "channels": ch, "samples": len(a)}


def data_chunk_span(raw):
    """在 RIFF 里找 data 块的 [起, 止)。找不到就返回 None。"""
    if len(raw) < 12 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return None
    p = 12
    while p + 8 <= len(raw):
        cid = raw[p:p + 4]
        try:
            sz = int.from_bytes(raw[p + 4:p + 8], "little")
        except Exception:
            return None
        body = p + 8
        if cid == b"data":
            return (body, min(body + sz, len(raw)))
        p = body + sz + (sz & 1)
    return None


def byte_diff_report(x, y, limit=6):
    """整文件层面：字节差在哪。用来回答「采样都一样，那 sha 为什么不同」。"""
    span = data_chunk_span(x)
    n = min(len(x), len(y))
    offs = []
    for i in range(n):
        if x[i] != y[i]:
            offs.append(i)
            if len(offs) >= limit:
                break
    return {"len_x": len(x), "len_y": len(y), "data_span": span,
            "first_diff_offsets": offs,
            "diff_all_outside_data": (span is not None and
                                      all(not (span[0] <= o < span[1]) for o in offs))}


def rms(seq):
    if not len(seq):
        return 0.0
    s = 0
    for v in seq:
        s += float(v) * float(v)
    return math.sqrt(s / len(seq))


def wave_delta(a, b):
    """两段采样的差。长度不同 ⇒ None（那时长度本身就是判据）。"""
    if a is None or b is None or len(a) != len(b) or not len(a):
        return None
    ndiff = 0
    maxd = 0
    sq = 0.0
    for i in range(len(a)):
        d = a[i] - b[i]
        if d:
            ndiff += 1
            ad = -d if d < 0 else d
            if ad > maxd:
                maxd = ad
        sq += float(d) * float(d)
    rms_d = math.sqrt(sq / len(a))
    rms_s = rms(a)
    if rms_d == 0:
        snr = float("inf")
    elif rms_s == 0:
        snr = 0.0
    else:
        snr = 20.0 * math.log10(rms_s / rms_d)
    return {"diff_frac": ndiff / float(len(a)), "max_abs_diff": maxd,
            "rms_diff": round(rms_d, 4), "snr_db": (None if snr == float("inf") else round(snr, 2)),
            "identical": ndiff == 0}


def wave_delta_trunc(a, b):
    """截到共同长度再比 —— **只给天花板用**。

    ⛔ 判据那一侧永远走 wave_delta：时长变了就该是 N/A，截齐会把它藏起来。
    天花板要回答的只有一句「这把尺子看得见真差别吗」，而换音色/换文本
    必然改长度 ⇒ 不截齐的话 usable_snr 那条分支在结构上永远走不到，
    探针每次只能报 envelope_only。
    """
    if a is None or b is None or not len(a) or not len(b):
        return None
    n = min(len(a), len(b))
    d = wave_delta(a[:n], b[:n])
    if d is None:
        return None
    d = dict(d)
    d["truncated"] = True
    d["n_used"] = n
    d["len_a"] = len(a)
    d["len_b"] = len(b)
    return d


def envelope(a, rate):
    if a is None or not len(a) or not rate:
        return None
    step = max(1, int(rate * FRAME_MS / 1000.0))
    frames = []
    for i in range(0, len(a) - step + 1, step):
        s = 0
        for j in range(i, i + step):
            v = a[j]
            s += v * v
        frames.append((s / float(step)) ** 0.5)
    if len(frames) < 4:
        return None
    out = []
    for k in range(CURVE_POINTS):
        pos = k * (len(frames) - 1) / float(CURVE_POINTS - 1)
        lo = int(pos)
        hi = min(lo + 1, len(frames) - 1)
        f = pos - lo
        out.append(frames[lo] * (1 - f) + frames[hi] * f)
    mean = sum(out) / len(out)
    if mean <= 0:
        return None
    return [v / mean for v in out]


def env_distance(e1, e2):
    if not e1 or not e2:
        return None
    return sum(abs(x - y) for x, y in zip(e1, e2)) / float(len(e1))


def fmt_snr(d):
    if d is None:
        return "N/A（两段不一样长）"
    if d["identical"]:
        return "采样**逐个相同**"
    if d["snr_db"] is None:
        return "差为零"
    return "SNR %.1f dB（%.2f%% 的采样有差，最大 %d LSB）" % (
        d["snr_db"], d["diff_frac"] * 100, d["max_abs_diff"])


# ---------------------------------------------------------------------------


def take_one(backend, body, api_key, label, tolerate_400=False):
    t0 = time.time()
    try:
        _, res = http_json("POST", backend + "/api/generate", body, api_key)
    except urlerror.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        if tolerate_400 and 400 <= e.code < 500:
            print("     跳过 %-12s 服务端 %d：%s" % (label, e.code, detail[:150]))
            return None
        die("POST /api/generate 返回 %d（%s）" % (e.code, label),
            "服务端说：%s" % detail)
    except Exception as e:
        die("连不上 %s/api/generate：%s" % (backend, e), "平台起着吗？")
    if not res.get("ok") or not res.get("audio_url"):
        if tolerate_400:
            print("     跳过 %s：响应形状不对" % label)
            return None
        die("响应形状不对（%s）：%s" % (label, json.dumps(res, ensure_ascii=False)[:400]))
    url = res["audio_url"]
    audio = http_bytes(url if url.startswith("http") else backend + url, api_key)
    a, meta = pcm(audio)
    if a is None:
        die("这段音频不是 16bit PCM WAV（%s）" % label)
    dur = meta["samples"] / float(meta["rate"] or 1)
    print("  采 %-12s ...  %d 字节  sha=%s  %.2fs  %.3fs 音频"
          % (label, len(audio), hashlib.sha256(audio).hexdigest()[:12],
             time.time() - t0, dur))
    return {"audio": audio, "pcm": a, "meta": meta, "duration_sec": round(dur, 6),
            "env": envelope(a, meta["rate"]), "bytes": len(audio),
            "sha256": hashlib.sha256(audio).hexdigest()}


def load_baseline_wav():
    with open(BASELINE_JSON, "r", encoding="utf-8") as f:
        base = json.load(f)
    rel = (base.get("audio_file") or "").replace("\\", os.sep)
    p = os.path.join(ROOT, rel) if rel else None
    if not p or not os.path.exists(p):
        return base, None
    with open(p, "rb") as f:
        raw = f.read()
    a, meta = pcm(raw)
    if a is None:
        return base, None
    return base, {"audio": raw, "pcm": a, "meta": meta,
                  "env": envelope(a, meta["rate"]),
                  "sha256": hashlib.sha256(raw).hexdigest()}


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--backend", default=os.environ.get("AURIVOX_BACKEND", "http://127.0.0.1:9886"))
    ap.add_argument("--api-key", default=os.environ.get("AURIVOX_API_KEY") or os.environ.get("API_KEY"))
    ap.add_argument("--ceiling-voice", default=None, help="指定天花板用哪个音色")
    ap.add_argument("--ceiling-text", default=CEILING_TEXT, help="换音色都不行时，用这段文本当天花板")
    ap.add_argument("--max-voice-tries", type=int, default=4)
    args = ap.parse_args()

    print("[probe_webui_sensitivity] 量一量降级判据还剩多少分辨力")
    print("  仓库根 %s" % ROOT)
    print("  后端   %s" % args.backend)
    line()
    print("")

    if not os.path.exists(BASELINE_JSON):
        die("没找到基线 %s" % BASELINE_JSON,
            "先跑 python tools\\dev\\verify_webui_baseline.py --baseline。",
            "这个探针要用基线里记的**那一份**请求体 —— 换一份就量的不是同一条路径了。")
    base, base_wav = load_baseline_wav()

    body = dict(base["request_body"])
    print("[1] 用基线记的那一份请求体")
    ok("基线取于 %s" % base["taken_at"], "判据形态 %s" % base["judge_mode"])
    ok("音色", str(body.get("voice")))
    if base.get("judge_mode") == "bytes":
        print("")
        print("   \u2139 基线是**逐字节**形态，判据已经最强，这个探针没必要跑。")
        return 0

    print("")
    print("[2] 地板 —— 同一个请求体连发两次，这条路径自己跟自己差多少")
    a = take_one(args.backend, body, args.api_key, "地板 A")
    b = take_one(args.backend, body, args.api_key, "地板 B")

    d_ab = wave_delta(a["pcm"], b["pcm"])
    e_ab = env_distance(a["env"], b["env"])
    print("")
    print("   \u2139 A vs B     采样：%s" % fmt_snr(d_ab))
    print("                包络：%.4f" % (e_ab if e_ab is not None else -1))

    d_base = e_base = None
    if base_wav:
        d_base = wave_delta(a["pcm"], base_wav["pcm"])
        e_base = env_distance(a["env"], base_wav["env"])
        print("   \u2139 A vs 基线  采样：%s" % fmt_snr(d_base))
        print("                包络：%.4f" % (e_base if e_base is not None else -1))
        print("      \u2b50 这一对更要紧：--compare 将来比的就是「现在」对「基线那一段」，")
        print("        中间隔着一次重启、可能还隔着一次模型加载。")
    else:
        print("   \u26a0 基线的 wav 读不出来，只能用 A/B 这一对当地板。")

    # 字节不同、采样却相同 ⇒ 差异在头部，那是可以钉死的
    header_only = []
    for tag, other in (("B", b), ("基线", base_wav)):
        if not other:
            continue
        d = d_ab if tag == "B" else d_base
        if d and d["identical"] and other["sha256"] != a["sha256"]:
            header_only.append(tag)
    bdr = None
    if header_only:
        print("")
        print("   \u2b50\u2b50 注意：对 %s，**采样逐个相同但整文件 sha 不同**" % "、".join(header_only))
        print("      ⇒ 那点差异不在声音里，在 WAV 头/附加块里（写文件时带进去的）。")
        print("      ⇒ 判据该比的是 **data 块**，不是整个文件。这比 ±2% 强得多。")
        other = b if "B" in header_only else base_wav
        bdr = byte_diff_report(a["audio"], other["audio"])
        print("      查一下差在哪（不猜，直接报偏移）：")
        print("        文件长 %d vs %d；data 块 %s"
              % (bdr["len_x"], bdr["len_y"],
                 ("[%d, %d)" % bdr["data_span"]) if bdr["data_span"] else "解析不出"))
        print("        头几个不同的字节在偏移 %s"
              % (", ".join(str(o) for o in bdr["first_diff_offsets"]) or "无"))
        if bdr["data_span"] and bdr["first_diff_offsets"]:
            print("        它们%s在 data 块之外"
                  % ("都" if bdr["diff_all_outside_data"] else "**不都**"))
            if not bdr["diff_all_outside_data"]:
                print("        \u26a0 落在 data 块里却又采样相同 —— 那说明有第二个 data 块")
                print("          或者块头写法每次不同，值得当场看一眼再定判据。")

    print("")
    print("[3] 天花板 —— 一个**真的不一样**的请求，尺子必须看得见")
    print("    ⭐ 不用「换 seed」：这条路径本来就不确定，换 seed 的差跟地板同类。")
    ceiling = None
    ceiling_kind = None
    tried = []
    cands = [args.ceiling_voice] if args.ceiling_voice else []
    if not cands:
        try:
            _, vres = http_json("GET", args.backend + "/api/voices", None, args.api_key)
            for v in (vres.get("voices") or []):
                vid = v.get("id") or v.get("name")
                if vid and vid != body.get("voice") and not v.get("builtin"):
                    cands.append(vid)
        except Exception:
            pass
    print("    先试换音色（参考音频不合规的会被服务端 400，那种就跳过换下一个）")
    for vid in cands[: max(1, args.max_voice_tries)]:
        cbody = dict(body)
        cbody["voice"] = vid
        tried.append(vid)
        got = take_one(args.backend, cbody, args.api_key, "天花板 %s" % vid, tolerate_400=True)
        if got:
            ceiling = got
            ceiling_kind = "voice:%s" % vid
            break
    if ceiling is None:
        print("    换音色没成（试过 %s）⇒ 退回用**换一段文本**当天花板。"
              % (("、".join(tried)) if tried else "无候选"))
        print("    ⭐ 这同样成立：天花板只需要是「一个真的不一样的请求」。")
        cbody = dict(body)
        cbody["text"] = args.ceiling_text
        ceiling = take_one(args.backend, cbody, args.api_key, "天花板 文本")
        ceiling_kind = "text"

    d_c = wave_delta(a["pcm"], ceiling["pcm"])
    d_c_trunc = wave_delta_trunc(a["pcm"], ceiling["pcm"])
    e_c = env_distance(a["env"], ceiling["env"])
    print("")
    print("   \u2139 A vs 天花板（%s）  采样：%s" % (ceiling_kind, fmt_snr(d_c)))
    if d_c is None and d_c_trunc is not None:
        print("                        采样(截到共同长度 %d 个采样)：%s"
              % (d_c_trunc["n_used"], fmt_snr(d_c_trunc)))
        print("      \u2b50 换音色/换文本的天花板**必然**不一样长，严格尺子恒为 N/A。")
        print("        截齐只用在天花板这一侧：它只需回答「尺子看得见真差别吗」。")
        print("        判据那一侧仍走严格比对 —— 时长一变就是 N/A，那本身就是红。")
    print("                        包络：%.4f" % (e_c if e_c is not None else -1))

    print("")
    line()
    print("[4] 结论 —— 哪一把尺子能当判据")

    verdict = None
    proposal = None

    floor_identical = bool(d_ab and d_ab["identical"]) and \
        (d_base is None or d_base["identical"])

    if floor_identical:
        verdict = "upgrade_data_sha"
        print("   \u2705\u2705 地板是**零** —— 同一个请求两次、以及对基线那一段，")
        print("      PCM 采样逐个相同。所谓「不确定」只发生在 WAV 头里。")
        print("")
        print("   ⇒ 判据应当**往严了升**：比 **data 块的 sha**（不是整文件 sha，")
        print("     也不是 ±2% 的时长）。地板为零的判据没有容差可调，")
        print("     它红就是真的变了。")
        print("   ⛔ 这不是「重取基线」：基线那段 wav 原封不动躺在盘上，")
        print("     data 块的 sha 是从**同一份文件**上算出来的。证据没换。")
        proposal = {"judge": "data_chunk_sha", "tolerance": 0}
    elif d_ab is None or (d_c is None and d_c_trunc is None):
        verdict = "envelope_only"
        print("   \u26a0 采样尺子用不了（两段不一样长）⇒ 只能看包络。")
    else:
        f_snr = d_ab["snr_db"] if d_ab["snr_db"] is not None else 999.0
        if d_base and d_base["snr_db"] is not None:
            f_snr = min(f_snr, d_base["snr_db"])
        d_ceil = d_c if d_c is not None else d_c_trunc
        c_snr = d_ceil["snr_db"] if d_ceil["snr_db"] is not None else 999.0
        if d_c is None:
            print("   （天花板 SNR 取自截齐后的 %d 个采样）" % d_ceil["n_used"])
        margin = f_snr - c_snr
        print("   地板 SNR   %.1f dB（越大越像）" % f_snr)
        print("   天花板 SNR %.1f dB" % c_snr)
        print("   余量       %.1f dB" % margin)
        print("")
        if margin >= 20:
            thr = round(f_snr - 12.0, 1)
            verdict = "usable_snr"
            proposal = {"judge": "snr_db", "threshold_db": thr}
            print("   \u2705 采样尺子有分辨力：地板比天花板高 %.1f dB。" % margin)
            print("      ⇒ 判据 = 「与基线那一段的 SNR ≥ **%.1f dB**」" % thr)
            print("        （= 实测地板 −12 dB，离天花板还有 %.1f dB）" % (thr - c_snr))
            print("      ⛔ 这个数是量出来的，不是挑出来的。将来它红了，")
            print("        要查的是改动，不是这个数字。")
        else:
            verdict = "marginal"
            print("   \u26a0 余量只有 %.1f dB，太窄 —— 加进去容易变成偶发红，" % margin)
            print("     而偶发红最后一定会被改成「调宽阈值」，那比没有这条判据更糟。")
            print("     ⇒ 建议**不加**，维持时长+形状，并如实写明它拦不住什么。")

    # 包络那把尺子的读数，留着做对照
    if e_ab is not None and e_c is not None:
        worst_e = max([x for x in (e_ab, e_base) if x is not None])
        print("")
        if worst_e < ENV_RATIO_MIN:
            print("   （对照）包络尺子：地板 %.3e（< %.0e，就当零），天花板 %.4f"
                  % (worst_e, ENV_RATIO_MIN, e_c))
            print("      \u26d4 不报倍数：分母是浮点残渣，那种七位数的 x 是噪声不是读数。")
        else:
            ratio = e_c / worst_e
            print("   （对照）包络尺子：地板 %.4f，天花板 %.4f，%.1fx"
                  % (worst_e, e_c, ratio))

    rec = {
        "kind": "webui-sensitivity-probe",
        "version": 3,
        "taken_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "baseline_taken_at": base.get("taken_at"),
        "frame_ms": FRAME_MS, "curve_points": CURVE_POINTS,
        "floor_ab": {"wave": d_ab, "env": (round(e_ab, 6) if e_ab is not None else None),
                     "sha_equal": a["sha256"] == b["sha256"]},
        "floor_vs_baseline": {"wave": d_base,
                              "env": (round(e_base, 6) if e_base is not None else None),
                              "sha_equal": (bool(base_wav) and a["sha256"] == base_wav["sha256"])},
        "ceiling": {"kind": ceiling_kind, "tried_voices": tried, "wave": d_c,
                    "wave_trunc": d_c_trunc,
                    "env": (round(e_c, 6) if e_c is not None else None)},
        "durations": {"floor_a": a["duration_sec"], "floor_b": b["duration_sec"],
                      "ceiling": ceiling["duration_sec"]},
        "verdict": verdict,
        "proposal": proposal,
        "byte_diff_report": bdr,
    }
    if not os.path.isdir(OUT_DIR):
        os.makedirs(OUT_DIR)
    with open(PROBE_JSON, "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    print("")
    print("   写了 %s" % os.path.relpath(PROBE_JSON, ROOT))
    print("   \u26d4 基线文件一个字节没动。")
    line()
    return 0


if __name__ == "__main__":
    sys.exit(main())
