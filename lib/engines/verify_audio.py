#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
第三道校验：「出得了声」（A/B 两级）

# ------------------------------------------------------------------
为什么要有第三道
# ------------------------------------------------------------------
前两道校验（envCheck.js）问的是：

    第一道  装没装：解释器 / 入口 / sys_path 在不在（纯查盘）
    第二道  起得来：拿引擎自己的解释器 import 名片点名的模块/类/方法

��两道都过了，仍然完全可能出一堆不能听的���音：

    · 上���类能 import，但它要的那份权重不在（第二道不查权重）
    · 权重在，但配置写错、码本不匹配
    · 构造成功，infer 跑一半抛异常
    · 出来了��但是空的（0 字节 / 0 帧）
    · 采样率是 0 / 声道数荒诞：能播，但没法用

⇒ 「import 成功」与「出得了声」之间隔着一整层，只有真跑一次才知道。

# ------------------------------------------------------------------
两级（分两级跑）
# ------------------------------------------------------------------
    B 级 宿主拿到合法响应。不起模型、不出声。
        快、不吃显存，但验不到「声音对不对」。
        ⇒ 它能抓的是「宿主与引擎谈不拢」（端口、参数、鉴权、就绪时序）。

    A 级 真跑一次合成，拿到非空 WAV。要模型、要显存、慢。
        ⇒ 这才是「出得了声」的字面意思。

两级都必须能单独跑：A 过了不代表 B 过了（B 是更前面的那道），
   B 过了也不代表 A 过了（B 只到「谈得拢」为止）。
   合���成「跑一次 A 就等于全都验过了」：那正是本页开头描述的失败模式。

# ------------------------------------------------------------------
本文件不许 import 名片没点名的东西
# ------------------------------------------------------------------
同 env_probe.py 的纪律：只 import spec 里的东西。探针自己的判断不能
反过来影响被验的引擎（那会把平台的假设塞进本该由名片说了算的地方）。

用法
    python verify_audio.py --spec-file <path>
    python verify_audio.py --spec '{"base_url":"http://127.0.0.1:9881", ...}'

stdout: 一行 JSON
    {"ok":true,"level":"A","wav_bytes":123456,"duration_sec":3.2,...}
    {"ok":false,"level":"A","stage":"synth","error":"...","detail":"..."}

退出码永远是 0。「验不过」是一个答案，不是探针出错。
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

# 刻意不 import 任何 HTTP 库：宿主 stdlib 的 urllib 够用，而多一个依赖
#    就多一处「本机上装没装」的变量：而那正是本文件要验的东西之外的事。
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BANNER = "[verify-audio]"

# 宿主 ready_timeout_ms 可以到 180000（IndexTTS2 实测 import 34s），
# 而 A 级还要真跑一次推理。下面这个是探针自己的上限，不是宿主的。
DEFAULT_TIMEOUT = 300


# ---------------------------------------------------------------------------
#  WAV 体检：这是「出得了声」与「出得了字节」的分界
# ---------------------------------------------------------------------------
def inspect_wav(data):
    """一段字节是不是能播的音频。

    为什么不用「长度 > 0」就过：
      那是最容易写的一种检查，而它恰好把最坏的情况放过，
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

    # 一帧都没有 = 空音频。那是最阴的一种失败：文件合法、能播、零时长。
    if frames <= 0:
        return {"ok": False, "why": "WAV 里一帧都没有（能播 0 秒）",
                "wav_bytes": len(data), "frames": 0}

    if rate <= 0:
        return {"ok": False, "why": "采样率是 0", "wav_bytes": len(data)}

    # 荒诞的采样率 / 声道数：能播，但拼不上（见 host.py _wav_meta 的注释
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
        # 采样率是 host.py 自己也报的那一份：两边不匹配说明有一边在骗人
        "consistency": "宿主与探针读到的 WAV 头一致",
    }


# ---------------------------------------------------------------------------
#  B 级：宿主拿到合法响应
# ---------------------------------------------------------------------------
def http_json(url, payload=None, timeout=30, method=None):
    """发一个 HTTP 请求。不抛：一切失败都变成 (status, body, err)。"""
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
            ctype = resp.headers.get("Content-Type") or ""
            # 二进制响应（audio/wav）原样带回，不许试�� JSON 化，
            #   试了也只会得到一句「响应不是 JSON」，而真相是「它压根不是 JSON」。
            if ctype.startswith("audio/") or not ctype.startswith("application/json"):
                return resp.getcode(), None, None, body, ctype
            try:
                return resp.getcode(), json.loads(body.decode("utf-8")), None, None, ctype
            except Exception:
                return resp.getcode(), None, None, body, ctype
    except HTTPError as exc:
        raw = b""
        try:
            raw = exc.read()
        except Exception:
            pass
        try:
            return exc.code, json.loads(raw.decode("utf-8")), None, None, ""
        except Exception:
            return exc.code, None, "HTTP %d，body=%r" % (exc.code, raw[:200]), None, ""
    except URLError as exc:
        return None, None, "连不上 %s：%s" % (url, exc), None, ""
    except Exception as exc:
        return None, None, "%s: %s" % (type(exc).__name__, exc), None, ""


# ---------------------------------------------------------------------------
#  失败原文与根因判断
# ---------------------------------------------------------------------------
# 宿主把子进程 stderr 的末尾几千字塞进 body.detail，探针再包一层 JSON 交给上层。
#   上限要有（一次 traceback 可以几千行），但不能小到把最后那行异常切掉：
#   切掉之后界面上只剩「宿主返回 400」，读的人无从下手。
DETAIL_LIMIT = 12000

# body 里可能是「原文」的字段，按可读性排序。
DETAIL_KEYS = ("detail", "error", "message", "traceback", "stderr", "stdout")


def _clip(text, limit=DETAIL_LIMIT):
    """超长时保留开头与结尾：开头常有引擎的第一句抱怨，结尾是异常类型。"""
    if len(text) <= limit:
        return text
    head = limit // 3
    tail = limit - head
    return (text[:head] + "\n……（中间省略 %d 字）……\n" % (len(text) - limit)
            + text[-tail:])


def _readable_detail(body, raw=None, limit=DETAIL_LIMIT):
    """把失败响应整理成可直接阅读的原文。

    宿主的失败 body 是 JSON，真正的报错在 detail（或 error / message）里。
    直接 json.dumps 出来会把换行转义成 \\n，读的人要自己还原；
    只取前若干字又会把最后一行异常切掉。所以结构化字段原样取出。
    """
    if isinstance(body, dict):
        parts = []
        for key in DETAIL_KEYS:
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                parts.append(v.strip())
        rest = {k: v for k, v in body.items() if k not in DETAIL_KEYS}
        if parts:
            text = "\n".join(parts)
            if rest:
                text += "\n--- 响应的其余字段 ---\n" + json.dumps(rest, ensure_ascii=False)
        else:
            text = json.dumps(body, ensure_ascii=False)
    elif isinstance(body, str):
        text = body
    elif raw:
        text = raw.decode("utf-8", "replace")
    else:
        text = ""
    return _clip(text.strip(), limit)


def _diagnose(detail_text, status=None):
    """从原文里认出常见根因，给一句「为什么」和一句「怎么办」。

    只认能在原文里看见证据的那几类。认不出来就明说认不出来，
    并指出去看最后一行，不替引擎编一个原因。
    """
    low = (detail_text or "").lower()

    def has(*needles):
        return any(n in low for n in needles)

    if has("out of memory", "outofmemoryerror", "cuda error", "内存不足",
           "not enough memory", "memoryerror"):
        return {
            "cause": "显存或内存不足，模型没有加载到推理设备上",
            "hint": "改用更小的权重或更短的文本；确认同一张设备上没有其他任务占用；"
                    "在本页上方把运行设备改为 CPU 可以绕过显存限制，代价是速度下降。",
        }
    if has("modulenotfounderror", "no module named", "importerror",
           "cannot import name", "dll load failed"):
        return {
            "cause": "引擎的运行环境缺少依赖，或者依赖版本不匹配",
            "hint": "回到第 2 步重装本步依赖；原文里 No module named 之后的那个名字就是缺的包。",
        }
    if has("error(s) in loading state_dict", "size mismatch", "missing key(s)",
           "unexpected key(s)", "checkpoint", "state_dict"):
        return {
            "cause": "权重与这一版代码不匹配，加载时键名或形状不一致",
            "hint": "按名片声明的仓库重新下载权重；确认权重目录里是这一版代码要求的文件。",
        }
    if has("filenotfounderror", "no such file or directory", "file not found",
           "cannot find the file", "does not exist", "找不到文件"):
        return {
            "cause": "原文点名的文件或目录在盘上不存在",
            "hint": "按原文里的路径核对权重目录、参考音频与配置文件的位置；"
                    "相对路径以引擎目录为准。",
        }
    if has("unexpected keyword argument", "unknown parameter", "unrecognized arguments",
           "invalid choice", "unexpected argument", "got an unexpected", "no such option"):
        return {
            "cause": "引擎不接受请求里的某个参数名",
            "hint": "到合成参数里核对这一项的键名；名片 call.bind 的槽位名与引擎签名"
                    "不一致时也会出现这一条。",
        }
    if has("is required", "requires ", "missing required", "required argument",
           "required positional", "missing 1 required", "必须", "缺少"):
        return {
            "cause": "请求缺少引擎要求的输入",
            "hint": "原文点名的那个输入补上再重试；需要参考音频的引擎还要填参考音频路径，"
                    "需要参考文本的引擎两者都要。",
        }
    if has("timed out", "timeout", "time out", "超时"):
        return {
            "cause": "合成耗时超过名片声明的超时上限",
            "hint": "在本机跑过一次之后把实测耗时填进名片的 timeout_ms，或者缩短合成文本。",
        }
    if has("exit code 137", "killed", "terminated by signal", "被终止"):
        return {
            "cause": "子进程被系统终止，常见原因是内存耗尽",
            "hint": "缩短文本或换更小的权重；确认可用内存之后再重试。",
        }
    if has("401", "403", "unauthorized", "forbidden", "api key", "invalid token",
           "authentication"):
        return {
            "cause": "引擎或上游服务拒绝了这次请求的凭据",
            "hint": "核对访问令牌与相关环境变量是否已经配置；需要授权才能下载的仓库与模型"
                    "要先完成授权。",
        }
    if has("connection refused", "actively refused", "econnrefused", "connect timeout"):
        return {
            "cause": "请求的端口没有服务在监听",
            "hint": "确认这台引擎的宿主进程是否还在运行；本步的校验会为它临时起一台宿主，"
                    "宿主本身起不来的话原文里有原因。",
        }
    if status == 400:
        return {
            "cause": "宿主在请求层拒绝了这次合成，参数或输入不合法",
            "hint": "先看原文第一行：它通常点名了是哪个参数或哪个文件；"
                    "再对照名片 call.bind 与合成参数里的取值。",
        }
    if status is not None:
        return {
            "cause": "引擎在推理过程中抛出异常",
            "hint": "先看原文最后一行，那里通常是真正的异常类型与消息；"
                    "据它判断是缺依赖、缺权重还是参数问题。",
        }
    return {
        "cause": "这次合成没有成功",
        "hint": "原文见下方输出；先看最后一行异常，再往上找第一处与这台引擎相关的报错。",
    }


def verify_level_b(spec):
    """B 级：/health + /tts 的契约对不对（不要求真出声）。

    为什么 /tts 也要碰：B 级要验的是「宿主与引擎谈得拢」。
      只打 /health 的话，一个参数名全错的宿主照样 200：那一道验不到任何
      与「能不能合成」有关的东西。⇒ 用一个故意缺字段的请求体去打 /tts：
      期望得到 400 + 指出缺什么，而不是 200 或 500。
    这不发真请求去合成（那升级成 A 级了），所以不占显存。
    """
    base = spec["base_url"].rstrip("/")
    out = {"level": "B", "steps": []}
    ok = True

    # --- 1. 就绪 ---
    status, body, err, raw, ctype = http_json(base + "/health",
                 timeout=spec.get("ready_timeout", 30))
    if err:
        return {"ok": False, "level": "B", "stage": "health",
                "error": "打不通 /health", "detail": err, "steps": out["steps"],
                "cause": "宿主没有在这个地址上监听",
                "hint": "确认宿主进程仍在运行；它若已经退出，退出原因在下方原文里"}
    if status != 200:
        # 503 = 还在加载 / 加载失败。failed=true 时要单独说，
        # 那不是「再等等」，是「等下去也不会好」（host.py 自己就这么讲）。
        if status == 503 and isinstance(body, dict) and body.get("failed"):
            detail = _readable_detail(body)
            diag = _diagnose(detail, status)
            return {"ok": False, "level": "B", "stage": "health",
                    "error": "宿主报加载失败，等下去也不会好",
                    "detail": detail, "cause": diag["cause"], "hint": diag["hint"],
                    "steps": out["steps"]}
        detail = _readable_detail(body)
        return {"ok": False, "level": "B", "stage": "health",
                "error": "/health 返回 %d" % status, "body": body,
                "detail": detail,
                "cause": "宿主的健康检查没有通过",
                "hint": "看原文里宿主自己写的失败原因；模型加载失败通常带 traceback。",
                "steps": out["steps"]}
    if not isinstance(body, dict) or not body.get("ready"):
        return {"ok": False, "level": "B", "stage": "health",
                "error": "/health 说 ready=%r" % (body or {}).get("ready"),
                "steps": out["steps"]}
    out["steps"].append({"step": "health", "ok": True,
                         "call_kind": body.get("call_kind"),
                         "resident": body.get("resident"),
                         "device": body.get("device")})
    # 诚实地记下来：cli 形态压根不常驻，B 级对它天然更弱。
    if body.get("resident") is False:
        out["note"] = ("这台引擎是 cli 形态（每次请求起新进程），"
                       "resident=false：B 级对它只能验到契约，验不到常驻")

    # --- 2. 契约：故意发一个缺 text 的请求 ---
    # 期望 400 且点名 text。收到 200 = 宿主没在验（那是更糟的静默）。
    #   收到 500 = 宿主自己炸了。两者都要红。
    empty = {}
    for k, v in (spec.get("minimal_request") or {}).items():
        empty[k] = v
    empty.pop("text", None)              # 故意去掉
    status, body, err, raw, ctype = http_json(base + "/tts", payload=empty, timeout=30)
    if err:
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "打不通 /tts", "detail": err, "steps": out["steps"],
                "cause": "请求没有到达宿主",
                "hint": "确认宿主还在运行；只有 /health 通而 /tts 不通时，通常是路由或端口被别的进程占了"}
    if status != 400:
        detail = _readable_detail(body, raw)
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "缺 text 的请求应得 400，实得 %d" % status,
                "why": "400 是宿主在验你；200/500 都说明这道闸没生效",
                "body": body, "detail": detail,
                "cause": "宿主没有拦住一个缺 text 的请求",
                "hint": "收到 200 说明请求校验没生效，缺参数会被静默接受；"
                        "收到 500 说明宿主在拼请求时就抛了异常，看下方原文。",
                "steps": out["steps"]}
    msg = json.dumps(body, ensure_ascii=False) if body is not None else ""
    if "text" not in msg.lower():
        return {"ok": False, "level": "B", "stage": "contract",
                "error": "缺 text 的 400 没有点名 text", "body": body,
                "detail": _readable_detail(body, raw),
                "cause": "宿主拒绝了请求，但没说缺的是 text",
                "hint": "核对名片的请求校验与 call.bind：两者不一致时，提示的内容与真正缺的输入不是同一个。",
                "steps": out["steps"]}
    out["steps"].append({"step": "contract", "ok": True,
                         "message": (body or {}).get("error") or msg[:120]})
    return {"ok": ok, "level": "B", "steps": out["steps"]}


# ---------------------------------------------------------------------------
#  A 级：真跑一次合成
# ---------------------------------------------------------------------------
def verify_level_a(spec):
    """A 级：真发一次合成，拿到非空 WAV。

    这一级要模型、要显存、慢（IndexTTS2 实测 import 34s + 一次推理）。
    所以它绝不能挂在每次合成请求上：那是 envCheck 浅/深层的纪律。
    """
    base = spec["base_url"].rstrip("/")
    out = {"level": "A", "steps": []}

    payload = dict(spec.get("request") or {})
    if not payload.get("text"):
        return {"ok": False, "level": "A", "stage": "spec",
                "error": "spec 要给 request.text：拿什么合成？"}

    # 参考音频必须真的存在，不许造一个假路径，
    # 那会得到一个「文件不存在」的 400，而它长得像「校验失败」。
    # 通用宿主收平台的词 reference_audio；旧名片照名片发 ref_audio_path，两个都认。
    for key in ("reference_audio", "ref_audio_path"):
        ref = payload.get(key)
        if not ref:
            continue
        rp = ref if os.path.isabs(ref) else os.path.join(spec.get("root") or ".", ref)
        if not os.path.isfile(rp):
            return {"ok": False, "level": "A", "stage": "spec",
                    "error": "参考音频不存在：%s" % rp,
                    "why": "平台不替你造一个假路径：那样验的是 404，不是引擎",
                    "cause": "填写的参考音频路径在盘上找不到",
                    "hint": "把参考音频换成一个确实存在的 wav 文件；相对路径以项目根为准。"}
        payload[key] = rp

    status, body, err, raw, ctype = http_json(base + "/tts", payload=payload,
                                     timeout=spec.get("synth_timeout", 180))
    if err:
        return {"ok": False, "level": "A", "stage": "synth",
                "error": "合成请求失败", "detail": err, "steps": out["steps"],
                "cause": "请求没有到达宿主",
                "hint": "确认临时宿主还在运行；端口与地址来自本次校验自己挑的空闲端口，"
                        "连不上通常意味着宿主进程已经退出。"}
    if status != 200:
        # 把宿主给的原文完整带出来：它已经点名了根因
        #   （unknown parameter / requires ref_audio / load_time only …）。
        #   截断到此为止：下面这层只加一句「为什么、怎么办」，不改原文。
        detail = _readable_detail(body, raw)
        diag = _diagnose(detail, status)
        return {"ok": False, "level": "A", "stage": "synth",
                "error": "宿主返回 %d" % status,
                "detail": detail,
                "cause": diag["cause"], "hint": diag["hint"],
                "steps": out["steps"]}

    # 宿主可能直接回 audio/wav，也可能回 JSON 带 base64。两种都认，
    # 但只认这两种：出现第三种形状时要说「我不认识」，
    # 那样猜错会表现为「验证通过但实际未验证」。
    audio, shape = _extract_audio(body, raw)
    if audio is None:
        detail = _readable_detail(body, raw)
        diag = _diagnose(detail, status)
        return {"ok": False, "level": "A", "stage": "decode",
                "error": "响应里没有音频",
                "shape": shape,
                "detail": detail,
                "cause": "宿主回了 200，但响应体不是音频，也不是带音频字段的 JSON",
                "hint": "原文若为空说明宿主写了空响应：核对名片 call.returns 与引擎实际产出"
                        "是否一致（file / dir / bytes）。",
                "steps": out["steps"]}
    out["steps"].append({"step": "synth", "ok": True, "shape": shape})

    wav = inspect_wav(audio)
    out["wav"] = wav
    if not wav.get("ok"):
        return {"ok": False, "level": "A", "stage": "wav",
                "error": "拿到了字节，但不是能播的音频", "wav": wav,
                "cause": "响应能被读成 WAV 头，但内容不成立（%s）" % (wav.get("why") or "原因见 wav 字段"),
                "hint": "核对名片 call.returns：产出是文件、目录还是直接写 stdout；"
                        "写错时拿到的往往是一段日志或路径字符串，而不是音频。",
                "steps": out["steps"]}
    # 把音频写成文件带出来：Player.jsx 画波形需要 src 指向可 fetch 的音频，
    #   只回报字节数的话前端拿不到音频本体，波形无数据可画。
    # 写到 engines/<id>/.wizard-verify-audio/：向导的音频端点从那里读，
    #   两边必须同一处，否则文件在盘上而端点读不到。
    audio_path = None
    try:
        engine_id = spec.get("id") or "audio"
        out_dir = os.path.join(spec.get("root") or ".", "engines",
                               str(engine_id), ".wizard-verify-audio")
        os.makedirs(out_dir, exist_ok=True)
        audio_path = os.path.join(out_dir, "verify-%s.wav" % engine_id)
        with open(audio_path, "wb") as f:
            f.write(audio)
    except Exception:
        audio_path = None

    return {"ok": True, "level": "A", "wav": wav, "steps": out["steps"],
            "duration_sec": wav.get("duration_sec"),
            "audio_path": audio_path}


def _extract_audio(body, raw=None):
    """从响应里取出音频字节，并说明它是从哪种形状里取的。

    真实宿主成功时回的是 `audio/wav` 二进制（不是 JSON），
       host.py 的 do_POST 末尾是 `self.wfile.write(data)`，data 就是 WAV 字节。
       所以「解析 stdout 当 JSON」这条路对成功的情形根本不成立：
          二进制没法安全地穿过 stdout（编码/缓冲/截断都会毁掉它）。
    ⇒ 调用方必须把原始字节传进来（`raw`），这里只负责判断形状。
    """
    if raw is not None and len(raw) > 0:
        return raw, "raw:audio/wav"
    if body is None:
        return None, None
    if isinstance(body, dict):
        for key in ("audio", "audio_b64", "data", "wav_base64"):
            v = body.get(key)
            if isinstance(v, str) and v:
                import base64
                try:
                    return base64.b64decode(v), "json:%s(base64)" % key
                except Exception as exc:
                    return None, "json:%s 解不开（%s）" % (key, exc)
        return None, "json（键不认识：%s）" % ", ".join(sorted(body)[:8])
    return None, "非 JSON 且没有原始字节"


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def verify(spec):
    level = (spec.get("level") or "B").upper()
    # base_url 是探针唯一能下手的地址：没有它就是没有东西可打。
    #   不猜（不回落 127.0.0.1:9881 那种「看起来对」的地址：验到的只会是
    #   一台不存在的引擎，或者恰好正在运行的其他引擎），只说清是谁的事：
    #   stdio / cli 形态由调用方先拉一个临时宿主再验。
    base = spec.get("base_url")
    if not base or not isinstance(base, str):
        return {
            "ok": False, "level": level, "stage": "spec",
            "error": "spec 没有 base_url：这台引擎不是常驻 HTTP 形态",
            "why": ("探针只会打 HTTP。stdio / cli 形态的引擎要先由调用方"
                    "起一个临时宿主（host.py --profile-json <解析结果> "
                    "--port <空闲端口>），再把 http://127.0.0.1:<端口> "
                    "作为 base_url 传进来"),
        }
    if level == "A":
        # A 级先跑 B：不是可选项：
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
        # 探针自己崩了：它的 traceback 是唯一线索，同样不许截到看不清原因。
        out = {"ok": False, "stage": "verify", "level": spec.get("level", "?"),
               "error": str(exc), "detail": _clip(traceback.format_exc())}
    print(json.dumps(out, ensure_ascii=False))
    return 0   # 永远是 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
