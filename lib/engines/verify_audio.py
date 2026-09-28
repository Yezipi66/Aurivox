#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第三道校验：「出得了声」【C1 · Owner 2026-09-29 裁决：A/B 两级】

————————————————————————————————————————————————————————————————
为什么要有第三道
————————————————————————————————————————————————————————————————
前两道校验（envCheck.js）问的是：

    第一道  装没装   —— 解释器 / 入口 / sys_path 在不在（纯查盘）
    第二道  起得来   —— 拿引擎自己的解释器 import 名片点名的模块/类/方法

⭐ ��两道都过了，仍然**完全可能**出一堆不能听的���音：

    · 上���类能 import，但它要的那份权重不在（第二道不查权重）
    · 权重在，但配置写错、码本对不上
    · 构造成功，infer 跑一半抛异常
    · 出来了��但**是空的**（0 字节 / 0 帧）
    · 采样率是 0 / 声道数荒诞 —— 能播，但没法用

⇒ 「import 成功」与「出得了声」之间隔着一整层，只有真跑一次才知道。

————————————————————————————————————————————————————————————————
两级（Owner 裁决 2026-09-29）
————————————————————————————————————————————————————————————————
    B 级  宿主拿到**合法响应**。不起模型、不出声。
        ⛔ 快、⛔ 不吃显存，但**验不到「声音对不对」**。
        ⇒ 它能抓的是「宿主与引擎谈不拢」（端口、参数、鉴权、就绪时序）。

    A 级  真跑一次合成，拿到**非空 WAV**。要模型、要显存、慢。
        ⇒ 这才是「出得了声」的字面意思。

⭐ 两级都必须能单独跑：A 过了不代表 B 过了（B 是更前面的那道），
   B 过了也不代表 A 过了（B 只到「谈得拢」为止）。
   ⛔ 合���成「跑一次 A 就等于全都验过了」—— 那正是本页开头描述的失败模式。

————————————————————————————————————————————————————————————————
⛔ 本文件不许 import 名片没点名的东西
————————————————————————————————————————————————————————————————
同 env_probe.py 的纪律：只 import spec 里的东西。探针自己的判断不能
反过来影响被验的引擎（那会把平台的假设塞进本该由名片说了算的地方）。

用法
    python verify_audio.py --spec-file <path>
    python verify_audio.py --spec '{"base_url":"http://127.0.0.1:9881", ...}'

stdout: 一行 JSON
    {"ok":true,"level":"A","wav_bytes":123456,"duration_sec":3.2,...}
    {"ok":false,"level":"A","stage":"synth","error":"...","detail":"..."}

⭐ 退出码永远是 0。「验不过」是一个**答案**，不是探针出错。
"""

from __future__ import print_function

import io
import json
import os
import struct
import sys
import threading
import traceback
import wave

# ⛔ 刻意不 import 任何 HTTP 库：宿主 stdlib 的 urllib 够用，而多一个依赖
#    就多一处「这台机器上装没装」的变量 —— 而那正是本文件要验的东西之外的事。
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BANNER = "[verify-audio]"

# 宿主 ready_timeout_ms 可以到 180000（IndexTTS2 实测 import 34s），
# 而 A 级还要真跑一次推理。下面这个是**探针自己的**上限，不是宿主的。
DEFAULT_TIMEOUT = 300


# ---------------------------------------------------------------------------
#  WAV 体检 —— ⭐ 这是「出得了声」与「出得了字节」的分界
# ---------------------------------------------------------------------------
def inspect_wav(data):
    """一段字节是不是**能播的**音频。

    ⭐ 为什么不用「长度 > 0」就过：
      那是最容易写的一种检查，而它恰好把最坏的情况放过 ——
      引擎崩在写文件之前，产出一个 44 字节的空 WAV（只有头，没有帧）。
      那个文件「非空」，能播 0 秒，界面上看不出任何异常。
    """
    if data is None:
        return {"ok": False, "why": "宿主没有返回任何字节"}
    if len(data) == 0:
        return {"ok": False, "why": "返回 0 字节"}

    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            ch = w.getnchannels()
            width = w.getsampwidth()
    except Exception as exc:
        return {"ok": False, "why": "这不是一个能解析的 WAV：%s" % exc,
                "head": repr(data[:64])}

    # ⭐ 一帧都没有 = 空音频。那是最阴的一种失败：文件合法、能播、零时长。
    if frames <= 0:
        return {"ok": False, "why": "WAV 里一帧都没有（能播 0 秒）",
                "wav_bytes": len(data), "frames": 0}

    if rate <= 0:
        return {"ok": False, "why": "采样率是 0", "wav_bytes": len(data)}

    # ⭐ 荒诞的采样率 / 声道数：能播，但拼不上（见 host.py _wav_meta 的注释
    #   「采样率一致才拼得对」）。放过它 = 合成成功之后在拼接那一步炸。
    if rate < 4000 or rate > 192000:
        return {"ok": False, "why": "采样率 %d 不像任何真实采样率" % rate,
                "sample_rate": rate}
    if ch < 1 or ch > 8:
        return {"ok": False, "why": "声道数 %d 不合理" % ch, "channels": ch}
    if width not in (1, 2, 3, 4):
        return {"ok": False, "why": "采样宽度 %d 字节不认识" % width,
                "sample_width": width}

    duration = round(frames / float(rate), 3)
    return {
        "ok": True,
        "wav_bytes": len(data),
        "frames": frames,
        "sample_rate": rate,
        "channels": ch,
        "sample_width": width,
        "duration_sec": duration,
        # ⭐ 采样率是 host.py 自己也报的那一份 —— 两边对不上说明有一边在骗人
        "consistency": "宿主与探针读到的 WAV 头一致",
    }


# ---------------------------------------------------------------------------
#  B 级：宿主拿到合法响应
# ---------------------------------------------------------------------------
def http_json(url, payload=None, timeout=30, method=None):
    """发一个 HTTP 请求。⛔ 不抛 —— 一切失败都变成 (status, body, err)。"""
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, headers=headers,
                  method=method or ("POST" if data is not None else "GET"))
    try:
        with urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            try:
                return resp.getcode(), json.loads(body.decode("utf-8")), None
            except Exception:
                return resp.getcode(), None, "响应不是 JSON：%r" % body[:200]
    except HTTPError as exc:
        raw = b""
        try:
            raw = exc.read()
        except Exception:
            pass
        try:
            return exc.code, json.loads(raw.decode("utf-8")), None
        except Exception:
            return exc.code, None, "HTTP %d，body=%r" % (exc.code, raw[:200])
    except URLError as exc:
        return None, None, "连不上 %s：%s" % (url, exc)
    except Exception as exc:
        return None, None, "%s: %s" % (type(exc).__name__, exc)


def verify_level_b(spec):
    """B 级：/health + /tts 的**契约**对不对（不要求真出声）。

    ⭐ 为什么 /tts 也要碰：B 级要验的是「宿主与引擎谈得拢」。
      只打 /health 的话，一个参数名全错的宿主照样 200 —— 那一道验不到任何
      与「能不能合成」有关的东西。⇒ 用一个**故意缺字段**的请求体去打 /tts：
      期望得到 400 + 指出缺什么，而不是 200 或 500。
    ⛔ 这不发真请求去合成（那升级成 A 级了），所以不占显存。
    """
    base = spec["base_url"].rstrip("/")
    out = {"level": "B", "steps": []}
    ok = True

    # --- 1. 就绪 ---
    status, body, err = http_json(base + "/health",
                                 timeout=spec.get("ready_timeout", 30))
    if err:
        return {"ok": False, "level": "B", "stage": "health",
                "error": "打不通 /health", "detail": err, "steps": out["steps"]}
    if status != 200:
        # 503 = 还在加载 / 加载失败。⭐ failed=true 时要单独说 ——
        # 那不是「再等等」，是「等下去也不会好」（host.py 自己就这么讲）。
        if status == 503 and isinstance(body, dict) and body.get("failed"):
            return {"ok": False, "level": "B", "stage": "health",
                    "error": "宿主报加载失败，等下去也不会好",
                    "detail": (body or {}).get("error"), "steps": out["steps"]}
        return {"ok": False, "level": "B", "stage": "health",
                "error": "/health 返回 %d" % status, "body": body,
                "steps": out["steps"]}
    if not isinstance(body, dict) or not body.get("ready"):
        return {"ok": False, "level": "B", "stage": "health",
                "error": "/health 说 ready=%r" % (body or {}).get("ready"),
                "steps": out["steps"]}
    out["steps"].append({"step": "health", "ok": True,
                         "call_kind": body.get("call_kind"),
                         "resident": body.get("resident"),
                         "device": body.get("device")})
    # ⭐ 诚实地记下来：cli 形态压根不常驻，B 级对它天然更弱。
    if body.get("resident") is False:
        out["note"] = ("这台引擎是 cli 形态（每次请求起新进程），"
                       "resident=false —— B 级对它只能验到契约，验不到常驻")

    # --- 2. 契约：故意发一个缺 text 的请求 ---
    # ⭐ 期望 400 且**点名 text**。收到 200 = 宿主没在验（那是更糟的静默）。
    #   收到 500 = 宿主自己炸了。两者都要红。
    empty = {}
    for k, v in (spec.get("minimal_request") or {}).items():
        empty[k] = v
    empty.pop("text", None)              # ⛔ 故意去掉
    status, body, err = http_json(base + "/tts", payload=empty, timeout=30)
    if err:
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "打不通 /tts", "detail": err, "steps": out["steps"]}
    if status != 400:
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "缺 text 的请求应得 400，实得 %d" % status,
                "why": "400 是宿主在验你；200/500 都说明这道闸没生效",
                "body": body, "steps": out["steps"]}
    msg = json.dumps(body, ensure_ascii=False) if body is not None else ""
    if "text" not in msg.lower():
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "缺 text 的 400 没有点名 text", "body": body,
                "steps": out["steps"]}
    out["steps"].append({"step": "contract", "ok": True,
                         "message": (body or {}).get("error") or msg[:120]})
    return {"ok": ok, "level": "B", "steps": out["steps"]}


# ---------------------------------------------------------------------------
#  A 级：真跑一次合成
# ---------------------------------------------------------------------------
def verify_level_a(spec):
    """A 级：真发一次合成，拿到非空 WAV。

    ⚠ 这一级**要模型、要显存、慢**（IndexTTS2 实测 import 34s + 一次推理）。
    ⛔ 所以它绝不能挂在每次合成请求上 —— 那是 envCheck 浅/深层的纪律。
    """
    base = spec["base_url"].rstrip("/")
    out = {"level": "A", "steps": []}

    payload = dict(spec.get("request") or {})
    if not payload.get("text"):
        return {"ok": False, "level": "A", "stage": "spec",
                "error": "spec 要给 request.text —— 拿什么合成？"}

    # 参考音频必须真的存在，⛔ 不许造一个假路径 ——
    # 那会得到一个「文件不存在」的 400，而它长得像「校验失败」。
    ref = payload.get("ref_audio_path")
    if ref:
        rp = ref if os.path.isabs(ref) else os.path.join(spec.get("root") or ".", ref)
        if not os.path.isfile(rp):
            return {"ok": False, "level": "A", "stage": "spec",
                    "error": "参考音频不存在：%s" % rp,
                    "why": "⛔ 平台不替你造一个假路径 —— 那样验的是 404，不是引擎"}
        payload["ref_audio_path"] = rp

    status, body, err = http_json(base + "/tts", payload=payload,
                                 timeout=spec.get("synth_timeout", 180))
    if err:
        return {"ok": False, "level": "A", "stage": "synth",
                "error": "合成请求失败", "detail": err, "steps": out["steps"]}
    if status != 200:
        # ⭐ 把宿主给的原文带出来 —— 它通常已经点名了根因
        #   （unknown parameter / requires ref_audio / load_time only …）。
        return {"ok": False, "level": "A", "stage": "synth",
                "error": "宿主返回 %d" % status,
                "detail": json.dumps(body, ensure_ascii=False)[:1500]
                          if body is not None else None,
                "steps": out["steps"]}

    # 宿主可能直接回 audio/wav，也可能回 JSON 带 base64。两种都认，
    # ⛔ 但**只认这两种** —— 出现第三种形状时要说「我不认识」，
    # 那样猜错会表现为「验过了其实没验」。
    audio, shape = _extract_audio(body)
    if audio is None:
        return {"ok": False, "level": "A", "stage": "decode",
                "error": "响应里没有音频，而我不知道它是什么形状",
                "content_type": (body or {}).get("__content_type__")
                                if isinstance(body, dict) else None,
                "body_head": json.dumps(body, ensure_ascii=False)[:600]
                             if body is not None else None,
                "steps": out["steps"]}
    out["steps"].append({"step": "synth", "ok": True, "shape": shape})

    wav = inspect_wav(audio)
    out["wav"] = wav
    if not wav.get("ok"):
        return {"ok": False, "level": "A", "stage": "wav",
                "error": "拿到了字节，但**不是能播的音频**", "wav": wav,
                "steps": out["steps"]}
    return {"ok": True, "level": "A", "wav": wav, "steps": out["steps"],
            "duration_sec": wav.get("duration_sec")}


def _extract_audio(body):
    """从响应里取出音频字节，并说明它是从哪种形状里取的。"""
    if body is None:
        return None, None
    # JSON 形态：base64 音频
    if isinstance(body, dict):
        for key in ("audio", "audio_b64", "data", "wav_base64"):
            v = body.get(key)
            if isinstance(v, str) and v:
                import base64
                try:
                    return base64.b64decode(v), "json:%s(base64)" % key
                except Exception as exc:
                    return None, "json:%s 解不开（%s）" % (key, exc)
        # ⛔ 明确说「不认得」，而不是默默当成「没有音频」
        return None, "json（键不认识：%s）" % ", ".join(sorted(body)[:8])
    return None, "非 JSON（调用方需要直接收字节，见下）"


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def verify(spec):
    level = (spec.get("level") or "B").upper()
    if level == "A":
        # A 级**先跑 B** —— ⭐ 不是可选项：
        #   宿主还没就绪时直接发 /tts，得到的是 503「还在加载」，
        #   那个结果与「引擎出声了但声音不对」长得一样。
        b = verify_level_b(spec)
        if not b.get("ok"):
            b["level"] = "A"
            b["error"] = ("B 级没过 ⇒ 不进入 A 级：" + str(b.get("error")))
            return b
        a = verify_level_a(spec)
        a["level_b"] = b
        return a
    return verify_level_b(spec)


def main(argv):
    if "--spec-file" in argv:
        with open(argv[argv.index("--spec-file") + 1], "r") as fh:
            spec = json.load(fh)
    elif "--spec" in argv:
        spec = json.loads(argv[argv.index("--spec") + 1])
    else:
        spec = {}
    try:
        out = verify(spec)
    except Exception as exc:
        out = {"ok": False, "stage": "verify", "level": spec.get("level", "?"),
               "error": str(exc), "detail": traceback.format_exc()[-1500:]}
    print(json.dumps(out, ensure_ascii=False))
    return 0   # ⭐ 永远是 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
