# -*- coding: utf-8 -*-
"""通用引擎宿主 —— 契约 §12 第 2 步

它是什么
--------
`engines/<id>/shim.py` 的替代品，**一份，所有引擎共用**。
把「传话的」那 294 行样板（HTTP 服务、探活、四类 400 校验、wav 头解析、
推理排队、洗 sys.path）从每台引擎的目录里收上来，只留下名片描述的那部分。

它怎么知道要跑哪台引擎
----------------------
⛔ **它不读 `manifest.json`。**
名片的语义只有一个实现 —— `lib/engines/profile.js`。宿主收的是**已经解析好**
的 JSON。理由是 `shim.py` 第 106 行那句自白：

    #  2) 参数白名单 —— 与 manifest.json 的 param_keys 必须一致
    LOAD_TIME_KEYS = frozenset({...})

「必须一致」＝没有任何东西保证一致。名片语义写两遍（JS 一遍、Python 一遍）
迟早分叉，那正是这个项目在消灭的那类 bug。

    python lib/engines/host.py --profile-json <路径>
    python lib/engines/host.py --profile-json -      # 从 stdin 读

调试时用 `tools/dev/emit_profile.cjs` 打印解析结果，管道灌进来即可。

三条硬纪律（继承自 shim.py，改这个文件前先读）
---------------------------------------------
1. **只用标准库。** 这个进程跑在**引擎自己的 venv** 里，和 broker 的 venv
   没有任何共同依赖。装第三方包 = 给那个环境引入新的冲突面。
2. **启动即加载，不许懒加载。** 冷启动可能 60 秒以上，而请求超时只有 300 秒。
   把加载挪到启动阶段，请求窗口才安全。代价是启动慢 —— 所以有 /health。
3. **洗 sys.path。** 宿主机上别的软件（如 Hermes）会把自己的 site-packages
   注入并排在引擎 venv **前面**，把 tokenizers / numpy 换成它的版本。
   必须在 import 引擎之前剔除。
"""

import io
import json
import os
import sys
import tempfile
import threading
import time
import traceback
import wave

BANNER = "[engine-host / 2026-08-26]"

# ---------------------------------------------------------------------------
#  0) 洗环境 —— 必须在 import 引擎之前
# ---------------------------------------------------------------------------
# 用「路径片段包含」而不是精确相等，因为盘符和用户名会变。
_ALIEN_PATH_MARKERS = (
    os.path.join("hermes", "hermes-agent"),
    os.path.join("hermes-agent", "venv"),
)


def _scrub_sys_path():
    """剔除非本引擎的注入路径，返回 (被剔除的, 剩下的)。"""
    kept, dropped = [], []
    for p in sys.path:
        norm = os.path.normcase(str(p))
        if any(os.path.normcase(m) in norm for m in _ALIEN_PATH_MARKERS):
            dropped.append(p)
        else:
            kept.append(p)
    sys.path[:] = kept
    return dropped, kept


_DROPPED, _KEPT = _scrub_sys_path()

# 离线：宿主永远不该联网下载权重。少一条网络依赖，就少一类
# 「第一次跑得通、换台机器跑不通」。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("MODELSCOPE_OFFLINE", "1")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


# ---------------------------------------------------------------------------
#  1) 播种 —— 契约 §5.2.1
# ---------------------------------------------------------------------------
# ⭐ 每个 RNG 一个独立函数，返回「真的播到了吗」。
#    ⛔ 不许 try/except: pass 吞掉 —— 那会让播种失败变成静默的，
#    而静默失效正是 §1 点名的那个坑。播不到就照实说，由调用方决定怎么办。
def _seed_python(seed):
    import random
    random.seed(seed)
    return "python"


def _seed_numpy(seed):
    import numpy
    numpy.random.seed(seed % (2 ** 32))
    return "numpy"


def _seed_torch(seed):
    import torch
    torch.manual_seed(seed)
    return "torch"


def _seed_torch_cuda(seed):
    import torch
    if not torch.cuda.is_available():
        return None          # 不是错误：这台机器就是没有 CUDA
    torch.cuda.manual_seed_all(seed)
    return "torch.cuda"


SEEDERS = {
    "python": _seed_python,
    "numpy": _seed_numpy,
    "torch": _seed_torch,
    "torch.cuda": _seed_torch_cuda,
}


class SeedPlan(object):
    """把名片里的 call.seed 变成一个可执行的计划。

    三态（契约 §5.2.1）：
      {"arg": "seed"}                 引擎自己收 —— 宿主把它塞进调用参数
      {"mode": "global", "rngs": [..]} 宿主播全局 RNG
      "none"                          不可复现 —— 宿主**显式拒收** seed
    """

    def __init__(self, spec):
        self.arg_name = None
        self.rngs = []
        self.mode = None

        if spec is None:
            # ⛔ 没写 = 今天的行为 = 静默忽略。契约 §5.2.1 要求必须写出来。
            raise ValueError(
                "call.seed 没写。契约 §5.2.1 要求它必须显式写出来："
                '{"arg":"<参数名>"} / {"mode":"global","rngs":[...]} / "none" —— '
                "不写会让「不支持」和「忘了写」长得一模一样，"
                "而后者今天的表现是静默忽略 seed。")

        if spec == "none":
            self.mode = "none"
            return

        if not isinstance(spec, dict):
            raise ValueError("call.seed 只能是 \"none\" 或一个对象，收到 %r" % (spec,))

        if "arg" in spec:
            self.mode = "arg"
            self.arg_name = spec["arg"]
            if not isinstance(self.arg_name, str) or not self.arg_name:
                raise ValueError("call.seed.arg 必须是非空字符串，收到 %r" % (self.arg_name,))
            return

        if spec.get("mode") == "global":
            self.mode = "global"
            self.rngs = list(spec.get("rngs") or [])
            if not self.rngs:
                raise ValueError(
                    'call.seed 写了 mode:"global" 却没列 rngs。'
                    "平台不得替你猜要播哪几个随机源 —— 猜错就是静默失效。")
            unknown = [r for r in self.rngs if r not in SEEDERS]
            if unknown:
                raise ValueError(
                    "call.seed.rngs 里有宿主不认识的随机源：%s（认识的是：%s）"
                    % (", ".join(unknown), ", ".join(sorted(SEEDERS))))
            # scope 是 MUST：播种改的是进程级全局状态
            if spec.get("scope") != "locked":
                raise ValueError(
                    'call.seed 的 scope 必须是 "locked"（契约 §5.2.1）。'
                    "播种改的是**进程级**全局状态，不在同一把锁内的并发请求"
                    "会互相冲掉对方刚播下的种子。")
            return

        raise ValueError("call.seed 认不出来：%r" % (spec,))

    def apply(self, seed):
        """播种。返回实际生效的 RNG 列表（进 meta，供取证）。"""
        if self.mode != "global":
            return None
        applied, failed = [], []
        for name in self.rngs:
            try:
                got = SEEDERS[name](seed)
            except Exception as exc:
                # ⭐ 照实记下来。名片列了却播不到 = 环境和名片对不上，
                #    该由 §6 第一道校验在注册时拦掉，不是运行时假装没事。
                failed.append("%s(%s)" % (name, exc.__class__.__name__))
                continue
            if got:
                applied.append(got)
        if failed:
            sys.stderr.write("%s SEED FAILED on: %s\n" % (BANNER, ", ".join(failed)))
        return {"applied": applied, "failed": failed}


# ---------------------------------------------------------------------------
#  2) 名片描述的那台引擎
# ---------------------------------------------------------------------------
class Engine(object):
    """持有一个已加载的上游模型。

    推理串行化：一块 GPU 上并发跑两个 infer 只会互相拖慢并可能 OOM，
    所以用一把锁把 /tts 排成队。ThreadingHTTPServer 仍然让 /health 在
    推理进行中可以立刻回答 —— 别人在等，但探活不能挂。
    """

    def __init__(self, profile):
        self.profile = profile
        self.call = profile["call"]
        self.seed_plan = SeedPlan(self.call.get("seed"))
        self.obj = None
        self.device = None
        self.ready = False
        self.error = None
        self.load_seconds = None
        self.infer_lock = threading.Lock()
        self.busy = False
        self.served = 0

    # -- 加载 ---------------------------------------------------------------
    def load(self):
        t0 = time.time()
        try:
            module_name = self.call["module"]
            class_name = self.call["class"]
            mod = __import__(module_name, fromlist=[class_name])
            klass = getattr(mod, class_name)

            # 留个证据：装的到底是哪一份源码。搬家/装包出错时这一行最值钱。
            root_mod = sys.modules.get(module_name.split(".")[0])
            sys.stderr.write("%s %s.__file__ = %s\n" % (
                BANNER, module_name.split(".")[0],
                getattr(root_mod, "__file__", "?")))

            init_args = dict(self.call.get("init_args") or {})
            sys.stderr.write("%s constructing %s(%s)\n" % (
                BANNER, class_name, ", ".join(sorted(init_args))))
            self.obj = klass(**init_args)
            self.load_seconds = round(time.time() - t0, 2)
            self.device = _guess_device()
            self.ready = True
            sys.stderr.write("%s ready in %ss on %s\n"
                             % (BANNER, self.load_seconds, self.device))
        except Exception:
            self.error = traceback.format_exc()
            self.load_seconds = round(time.time() - t0, 2)
            sys.stderr.write("%s LOAD FAILED after %ss\n%s\n"
                             % (BANNER, self.load_seconds, self.error))

    # -- 合成 ---------------------------------------------------------------
    def synthesize(self, text, ref_audio_path, call_params, seed=None):
        """返回 (wav_bytes, meta)。"""
        bind = self.call["bind"]
        returns = self.call.get("returns", "file")
        method = getattr(self.obj, self.call["method"])

        kwargs = dict(call_params)
        kwargs[bind["text"]] = text
        if bind.get("ref_audio"):
            kwargs[bind["ref_audio"]] = ref_audio_path

        out_path = None
        if returns == "file":
            fd, out_path = tempfile.mkstemp(prefix="host_", suffix=".wav")
            os.close(fd)
            kwargs[bind["output_path"]] = out_path

        seed_info = None
        try:
            if seed is not None:
                if self.seed_plan.mode == "arg":
                    kwargs[self.seed_plan.arg_name] = seed
                    seed_info = {"applied": ["engine:%s" % self.seed_plan.arg_name],
                                 "failed": []}
                else:
                    # ⭐ 必须在调用之前播，且在同一把锁内 —— 调用方已经持锁。
                    seed_info = self.seed_plan.apply(seed)

            t0 = time.time()
            result = method(**kwargs)
            elapsed = time.time() - t0

            if returns == "file":
                with open(out_path, "rb") as fh:
                    data = fh.read()
                if not data:
                    raise RuntimeError("%s wrote an empty file" % self.call["class"])
            else:
                data = result
                if not isinstance(data, (bytes, bytearray)):
                    raise RuntimeError(
                        'call.returns 写的是 "bytes"，但 %s.%s 返回的是 %s'
                        % (self.call["class"], self.call["method"],
                           type(data).__name__))
                data = bytes(data)

            meta = _wav_meta(data)
            # ⭐ 播了什么必须记下来。只播不记，就分不清「播了」和「以为播了」。
            meta["seed_applied"] = "+".join(seed_info["applied"]) if seed_info and seed_info["applied"] else None
            if seed_info and seed_info["failed"]:
                meta["seed_failed"] = seed_info["failed"]
            meta["infer_seconds"] = round(elapsed, 2)
            if meta.get("duration"):
                meta["rtf"] = round(elapsed / meta["duration"], 2)
            return data, meta
        finally:
            if out_path:
                try:
                    os.unlink(out_path)
                except OSError:
                    pass


def _guess_device():
    """尽力而为，拿不到就 unknown —— 这只是 /health 上的一行信息。"""
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _wav_meta(data):
    """从 WAV 字节里读采样率/声道/时长。拼接侧关心这个 —— 采样率一致才拼得对。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return {
                "bytes": len(data),
                "sample_rate": rate,
                "channels": w.getnchannels(),
                "sample_width": w.getsampwidth(),
                "duration": round(frames / float(rate), 3) if rate else None,
            }
    except Exception:
        return {"bytes": len(data)}


# ---------------------------------------------------------------------------
#  3) HTTP —— 这一段每台引擎逐字一样
# ---------------------------------------------------------------------------
STATE = {"engine": None, "profile": None}


class Handler(BaseHTTPRequestHandler):
    server_version = "AurivoxEngineHost/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 默认那行 access log 会把每个请求打到 stderr，混在推理进度条里没法看。
        pass

    # -- helpers ------------------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # broker 端超时断开时会走到这里。推理已经白跑了，但进程不该死。
            pass

    def _fail(self, code, message, **extra):
        payload = {"detail": message}
        payload.update(extra)
        self._send(code, payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        eng = STATE["engine"]
        prof = STATE["profile"]
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(200 if eng.ready else 503, {
                "ready": eng.ready,
                # ⭐ start.ps1 的轮询靠这个字段提早退出：failed=true 时
                #    继续等下去没有任何意义。
                "failed": bool(eng.error),
                "busy": eng.busy,
                "device": eng.device,
                "load_seconds": eng.load_seconds,
                "served": eng.served,
                "engine": prof["id"],
                "banner": BANNER,
                "seed_mode": eng.seed_plan.mode,
                "seed_rngs": eng.seed_plan.rngs or None,
                "error": eng.error,
                "scrubbed_paths": _DROPPED,
            })
            return
        self._fail(404, "unknown path: %s" % path)

    def do_POST(self):
        eng = STATE["engine"]
        prof = STATE["profile"]
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/tts":
            self._fail(404, "unknown path: %s" % path)
            return

        if not eng.ready:
            # ⭐ 「还在加载」和「加载已经失败」必须分开说。两者都 not ready，
            #    但前者该继续等，后者等到天荒地老也不会好。
            if eng.error:
                self._fail(503,
                           "engine failed to load and will not recover; "
                           "restart the host after fixing the cause",
                           failed=True, load_seconds=eng.load_seconds,
                           error=eng.error)
            else:
                self._fail(503, "engine is still loading; poll /health until ready",
                           failed=False, load_seconds=eng.load_seconds)
            return

        try:
            body = self._read_json()
        except Exception as exc:
            self._fail(400, "request body is not valid JSON: %s" % exc)
            return

        err = validate_request(body, prof, eng.seed_plan)
        if err is not None:
            code, message, extra = err
            self._fail(code, message, **extra)
            return

        text = str(body["text"])
        ref = body.get("ref_audio_path")
        seed = int(body["seed"]) if body.get("seed") is not None else None
        call_time = set(prof["params"].get("call_time") or [])
        call_params = {k: body[k] for k in body if k in call_time}

        with eng.infer_lock:
            eng.busy = True
            try:
                data, meta = eng.synthesize(text, ref, call_params, seed=seed)
                eng.served += 1
            except Exception:
                tb = traceback.format_exc()
                sys.stderr.write("%s INFER FAILED\n%s\n" % (BANNER, tb))
                self._fail(500, "%s inference failed" % prof["id"], traceback=tb)
                return
            finally:
                eng.busy = False

        sys.stderr.write("%s served bytes=%s sr=%s dur=%ss infer=%ss rtf=%s seed=%s\n" % (
            BANNER, meta.get("bytes"), meta.get("sample_rate"), meta.get("duration"),
            meta.get("infer_seconds"), meta.get("rtf"), meta.get("seed_applied")))

        # ⭐ 直接返回 WAV 字节流 —— 模仿传输，不模仿词汇表。
        #    这一条是「lib/ 响应侧零改动」的全部理由。
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Engine", prof["id"])
        self.send_header("X-Sample-Rate", str(meta.get("sample_rate", "")))
        self.send_header("X-Infer-Seconds", str(meta.get("infer_seconds", "")))
        # ⭐ 让「seed 到底生效没有」在 HTTP 层可见。空值就是没生效。
        self.send_header("X-Seed-Applied", str(meta.get("seed_applied") or ""))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------------------
#  4) 请求校验 —— 抽成纯函数，才能不起进程就测
# ---------------------------------------------------------------------------
CORE_KEYS = frozenset({"text", "ref_audio_path", "seed", "format", "media_type"})


def validate_request(body, profile, seed_plan):
    """校验通过返回 None，否则返回 (状态码, 说明, 附加字段)。

    ⭐ 抽成纯函数是有意的：四类 400 是这份宿主里判别力最高的部分，
      它必须能在没有 GPU、没有上游包、不起 HTTP 服务的机器上被逐条测到。
    """
    load_time = set(profile["params"].get("load_time") or [])
    call_time = set(profile["params"].get("call_time") or [])
    formats = set(f.lower() for f in (profile.get("output_formats") or ["wav"]))
    needs_ref = bool(profile.get("capabilities", {}).get("requires_reference_audio"))

    text = body.get("text")
    if not text or not str(text).strip():
        return 400, "'text' is required and must not be empty", {}

    ref = body.get("ref_audio_path")
    if needs_ref:
        if not ref:
            return 400, ("'ref_audio_path' is required (%s clones from a "
                         "reference clip)" % profile["id"]), {}
        if not os.path.isfile(ref):
            return 400, ("reference audio not found on the engine host: %s"
                         % ref), {}

    # ⛔ 未知键拦下不放行：拼错的参数名否则会被静默忽略，看起来像生效了。
    known = CORE_KEYS | call_time | load_time
    if seed_plan.arg_name:
        known = known | {seed_plan.arg_name}
    unknown = sorted(k for k in body if k not in known)
    if unknown:
        return 400, ("unknown parameter(s): %s — a mistyped name would otherwise "
                     "be silently ignored and look like it took effect"
                     % ", ".join(unknown)), {"unknown": unknown}

    # 加载期参数出现在调用里 = 调用方以为能热切，其实不能。
    in_call = sorted(k for k in body if k in load_time)
    if in_call:
        return 400, ("%s can only be set when the engine process starts, not per "
                     "request; restart the host with different flags instead"
                     % ", ".join(in_call)), {"load_time_only": in_call}

    # format / media_type：⛔ 别默默返回 wav 而让调用方以为拿到了它要的 mp3。
    for key in ("format", "media_type"):
        want = body.get(key)
        if want is not None and str(want).lower() not in formats:
            return 400, ("%s=%r is not supported by this engine; it only emits "
                         "%s. Transcoding belongs in the broker, not here."
                         % (key, want, "/".join(sorted(formats)))), \
                {"supported": sorted(formats)}

    seed = body.get("seed")
    if seed is not None:
        # ⭐⭐ 契约 §5.2.1：写了 "none" 就**显式拒收**，绝不收下扔掉。
        if seed_plan.mode == "none":
            return 400, ("this engine declares call.seed = \"none\": it cannot "
                         "reproduce a previous run, so the broker must not record "
                         "a seed for it. Accepting the seed and ignoring it would "
                         "put a seed in meta.json that never took effect."), \
                {"seed_mode": "none"}
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            return 400, "'seed' must be an integer, got %r" % (seed,), {}
        if seed < 0:
            # broker 的 resolveSeed 已经把 -1/空 解析成具体值了；还看到负数
            # 说明它没走那条路，此时静默随机会让 meta.json 记的 seed 失真。
            return 400, ("'seed' must be >= 0; the broker is expected to resolve "
                         "random seeds to a concrete value before calling, so that "
                         "meta.json records the seed that was actually used"), {}
    return None


# ---------------------------------------------------------------------------
#  5) 名片解析结果的形状检查
# ---------------------------------------------------------------------------
REQUIRED_TOP = ("id", "runtime", "call", "params")
REQUIRED_CALL_PY = ("module", "class", "method", "bind")


def validate_profile(profile):
    """返回问题清单。⭐ 空清单才启动 —— 名片不全就别装出一副能跑的样子。"""
    problems = []
    for k in REQUIRED_TOP:
        if k not in profile:
            problems.append("缺 %s" % k)
    call = profile.get("call") or {}
    kind = call.get("kind")
    if kind != "python":
        problems.append(
            "call.kind = %r —— 这份宿主目前只实现了 python 形态（契约 §5.2）。"
            "cli / http 形态是分开的两条路。" % (kind,))
    else:
        for k in REQUIRED_CALL_PY:
            if k not in call:
                problems.append("缺 call.%s" % k)
        bind = call.get("bind") or {}
        if "text" not in bind:
            problems.append("缺 call.bind.text —— 平台不知道该把正文放进哪个参数")
        if call.get("returns", "file") == "file" and "output_path" not in bind:
            problems.append(
                'call.returns 是 "file"，但没有 call.bind.output_path —— '
                "平台不知道该让引擎把音频写到哪里")
    try:
        SeedPlan(call.get("seed"))
    except ValueError as exc:
        problems.append(str(exc))
    return problems


# ---------------------------------------------------------------------------
#  6) main
# ---------------------------------------------------------------------------
def _arg(name, default=None):
    """--name=value 或 --name value 都认。"""
    pref = "--%s=" % name
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a.startswith(pref):
            return a[len(pref):]
        if a == "--%s" % name and i + 1 < len(argv):
            return argv[i + 1]
    return default


def load_profile(source):
    if source == "-":
        return json.loads(sys.stdin.read())
    with open(source, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def main():
    source = _arg("profile-json")
    if not source:
        sys.stderr.write(
            "%s FATAL: --profile-json <路径|-> 是必须的。\n"
            "  宿主**不读 manifest.json** —— 名片语义只有 lib/engines/profile.js\n"
            "  一个实现，写两遍迟早分叉。调试时用：\n"
            "    node tools/dev/emit_profile.cjs <引擎id> | python lib/engines/host.py --profile-json -\n"
            % BANNER)
        return 2

    try:
        profile = load_profile(source)
    except Exception as exc:
        sys.stderr.write("%s FATAL: 读不了解析结果 %s：%s\n" % (BANNER, source, exc))
        return 2

    problems = validate_profile(profile)
    if problems:
        sys.stderr.write("%s FATAL: 解析结果不完整，拒绝启动：\n" % BANNER)
        for p in problems:
            sys.stderr.write("   ⛔ %s\n" % p)
        return 2

    runtime = profile.get("runtime") or {}
    host = _arg("host", os.environ.get("ENGINE_HOST", "127.0.0.1"))
    port = int(_arg("port", os.environ.get("ENGINE_PORT", "0")) or 0)
    if not port:
        sys.stderr.write("%s FATAL: --port=<端口> 是必须的\n" % BANNER)
        return 2

    # 引擎源码目录进 sys.path（名片 runtime.verify.sys_path）
    for p in (runtime.get("sys_path") or []):
        ap = os.path.abspath(p)
        if ap in sys.path:
            sys.path.remove(ap)
        sys.path.insert(0, ap)

    # ⭐ 上游代码里常有 `checkpoints/xxx` 这种相对 CWD 的硬编码，而且是
    #   **调用实参**不是默认值 —— 显式传参救不了。chdir 是唯一不改上游源码
    #   的解法。⛔ 只在这里定一次，之后进程不再改。
    cwd = runtime.get("cwd")
    if cwd:
        cwd = os.path.abspath(cwd)
        if not os.path.isdir(cwd):
            sys.stderr.write("%s FATAL: runtime.cwd 不存在：%s\n" % (BANNER, cwd))
            return 2
        os.chdir(cwd)

    sys.stderr.write("%s starting  engine=%s host=%s port=%s\n"
                     % (BANNER, profile["id"], host, port))
    sys.stderr.write("%s cwd=%s\n" % (BANNER, os.getcwd()))
    sys.stderr.write("%s python=%s\n" % (BANNER, sys.executable))
    sys.stderr.write("%s sys_path+=%s\n" % (BANNER, runtime.get("sys_path") or []))
    if _DROPPED:
        sys.stderr.write("%s scrubbed %d alien sys.path entr%s: %s\n"
                         % (BANNER, len(_DROPPED),
                            "y" if len(_DROPPED) == 1 else "ies", _DROPPED))

    engine = Engine(profile)
    STATE["engine"] = engine
    STATE["profile"] = profile
    sys.stderr.write("%s seed plan = %s %s\n"
                     % (BANNER, engine.seed_plan.mode, engine.seed_plan.rngs or ""))

    # ⭐ 先绑端口再加载模型：这样调用方一 spawn 就能连上 /health 拿到
    #   503 + load_seconds，知道「在起，别急」。反过来那段时间里探活是
    #   「连接被拒」，和「进程崩了」长得一模一样。
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    threading.Thread(target=engine.load,
                     name="%s-load" % profile["id"], daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        sys.stderr.write("%s shutting down\n" % BANNER)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
