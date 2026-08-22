# -*- coding: utf-8 -*-
"""IndexTTS2 HTTP shim for Aurivox  [batch18 / 2026-08-22]

它是什么
--------
一个「传话的」。把 IndexTTS2 的 Python API 包成 HTTP，让 broker 用和
GPT-SoVITS 完全相同的方式调用它：POST /tts -> 返回 WAV 字节流。

它不是什么
----------
⛔ 它**不翻译参数**。broker 传什么键，就原样交给 IndexTTS2；不认识的键
   直接报错，不静默丢弃。理由：翻译错了不会报错，只是声音不对 —— 那是
   最难查的一类 bug。抽象「管道」，不抽象「推理」。

三条硬纪律（改这个文件前先读）
------------------------------
1. **只用标准库。** 这个进程跑在引擎自己的 venv 里（torch 2.8 + cu128），
   和 broker 的 venv 没有任何共同依赖。装第三方包 = 给这个环境引入新的
   冲突面。http.server 够用。

2. **启动即加载模型，不许懒加载。** 实测冷启动 import 34.55s +
   construct 26.51s ≈ 61s，加上一次推理 224s，合计 285s —— broker 侧的
   请求超时是 300s，只剩 15s 余量。把这 61s 挪到启动阶段，请求窗口才安全。
   代价是启动慢，所以有 /health 让 start.ps1 轮询。

3. **洗 sys.path。** 宿主机上装了 Hermes，它会把自己的 site-packages
   注入 sys.path 且排在引擎 venv **前面**，导致 tokenizers / numpy 被换成
   它的版本。实测这会让「依赖看起来漂移了」。必须在 import 引擎之前剔除。
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

# ---------------------------------------------------------------------------
#  0) 洗环境 —— 必须在 import indextts 之前
# ---------------------------------------------------------------------------
# Hermes 注入的路径特征。用「路径片段包含」而不是精确相等，因为盘符和
# 用户名会变。两条都要滤：venv 的 site-packages，以及 agent 自己那条。
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


# 引擎源码的父目录 = 本文件所在目录（engines/indextts2/），indextts 是它下面的包。
_ENGINE_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ENGINE_ROOT in sys.path:
    sys.path.remove(_ENGINE_ROOT)
sys.path.insert(0, _ENGINE_ROOT)

_DROPPED, _KEPT = _scrub_sys_path()

# 离线：这个 shim 永远不该联网下载权重。少一条网络依赖，就少一类
# 「第一次跑得通、换台机器跑不通」。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("MODELSCOPE_OFFLINE", "1")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

# ---------------------------------------------------------------------------
#  1) 配置 —— 全部来自命令行/环境变量，不在代码里写死任何绝对路径
# ---------------------------------------------------------------------------
BANNER = "[indextts2-shim / 2026-08-22]"


def _arg(name, default=None):
    """--name=value 或 --name value 都认。"""
    pref = "--%s=" % name
    for i, a in enumerate(sys.argv[1:]):
        if a.startswith(pref):
            return a[len(pref):]
        if a == "--%s" % name and i + 2 <= len(sys.argv) - 1:
            return sys.argv[i + 2]
    return default


HOST = _arg("host", os.environ.get("INDEXTTS2_HOST", "127.0.0.1"))
PORT = int(_arg("port", os.environ.get("INDEXTTS2_PORT", "9881")))
# 权重目录：上游代码里有 `checkpoints/xxx` 这类相对 CWD 的硬编码，所以
# 启动时会 chdir 到它的父目录（见 main）。这里要的是 checkpoints 目录本身。
CKPT_DIR = _arg("checkpoints", os.environ.get("INDEXTTS2_CHECKPOINTS", ""))
CFG_PATH = _arg("config", os.environ.get("INDEXTTS2_CONFIG", ""))

# ---------------------------------------------------------------------------
#  2) 参数白名单 —— 与 manifest.json 的 param_keys 必须一致
# ---------------------------------------------------------------------------
# ⛔ 不在表上的键 -> 400，不静默忽略。这条和 broker 侧 adapter.js 抛
#    FG_ENGINE_PARAM_UNKNOWN 是同一个道理，只是防线在两端各设一道：
#    broker 那道防拼写错误，这道防「manifest 和 shim 不同步」。
#
# ⭐ 分两类，因为它们的生命周期不同：
#    - LOAD_TIME：构造 IndexTTS2 时用，改它要重启进程。shim 只在启动时读。
#    - CALL_TIME：每次 infer 用。
LOAD_TIME_KEYS = frozenset({
    "use_fp16", "use_cuda_kernel", "use_deepspeed",
    "use_accel", "use_torch_compile",
})

CALL_TIME_KEYS = frozenset({
    "emo_alpha",
    "interval_silence",
    "verbose",
    "max_text_tokens_per_segment",
})

# broker 每次都会送的核心载荷，不算「引擎方言」。
CORE_KEYS = frozenset({"text", "ref_audio_path", "seed", "format", "media_type"})

# ⭐ CORE_KEYS 里的键「被接受」不等于「被使用」。broker 认真解析 seed、把它写进
#   meta.json，并承诺 Rerun 能复现同一段音频（见 server.js resolveSeed 的注释）。
#   若 shim 收下 seed 却不用，Rerun 就会给出不同的声音，而 meta 里白纸黑字记着
#   一个没生效的 seed —— 这是「不报错，只是声音不对」的典型。
#   所以下面每一个 CORE_KEY 都必须有明确归宿：要么真正生效，要么显式拒绝。
_SUPPORTED_FORMATS = frozenset({"wav"})


# ---------------------------------------------------------------------------
#  3) 模型持有者
# ---------------------------------------------------------------------------
class Engine(object):
    """持有一个已加载的 IndexTTS2。

    推理串行化：一块 GPU 上并发跑两个 infer 只会互相拖慢并可能 OOM，
    所以用一把锁把 /tts 排成队。ThreadingHTTPServer 仍然让 /health 在
    推理进行中可以立刻回答 —— 这正是我们需要的：别人在等，但探活不能挂。
    """

    def __init__(self):
        self.tts = None
        self.device = None
        self.ready = False
        self.error = None
        self.load_seconds = None
        self.infer_lock = threading.Lock()
        self.busy = False
        self.served = 0

    def load(self, cfg_path, model_dir):
        t0 = time.time()
        try:
            from indextts.infer_v2 import IndexTTS2
            import indextts

            # 留个证据：装的到底是哪一份源码。搬家/装包出错时这一行最值钱。
            sys.stderr.write("%s indextts.__file__ = %s\n"
                             % (BANNER, getattr(indextts, "__file__", "?")))

            self.tts = IndexTTS2(
                cfg_path=cfg_path,
                model_dir=model_dir,
                # 这五个全关 = 性能地板，但也是「一定能跑」的配方。
                # 实测 RTF 32。想提速先动 config.yaml 里的扩散步数
                # （s2mel 占 61%），不要从这里开始试。
                use_cuda_kernel=False,
                use_deepspeed=False,
                use_accel=False,
                use_torch_compile=False,
                use_fp16=False,
            )
            self.device = str(getattr(self.tts, "device", "?"))
            self.ready = True
            self.load_seconds = round(time.time() - t0, 2)
            sys.stderr.write("%s READY device=%s load=%.2fs\n"
                             % (BANNER, self.device, self.load_seconds))
        except Exception:
            self.error = traceback.format_exc()
            self.load_seconds = round(time.time() - t0, 2)
            sys.stderr.write("%s LOAD FAILED after %.2fs\n%s\n"
                             % (BANNER, self.load_seconds, self.error))

    def apply_seed(self, seed):
        """让 seed 真正生效。返回实际生效的描述，供响应头回报。

        ⚠ 诚实边界：manual_seed 只能保证「同一台机器、同一份权重、同一份
        输入」可复现。CUDA 上部分 kernel 本身非确定性，跨 GPU 型号不保证。
        这比「收下 seed 然后扔掉」强得多，但它不是数学意义上的保证。
        """
        try:
            import random as _random
            _random.seed(seed)
        except Exception:
            pass
        applied = []
        try:
            import numpy as _np
            _np.random.seed(seed % (2 ** 32))
            applied.append("numpy")
        except Exception:
            pass
        try:
            import torch as _torch
            _torch.manual_seed(seed)
            if _torch.cuda.is_available():
                _torch.cuda.manual_seed_all(seed)
                applied.append("torch+cuda")
            else:
                applied.append("torch")
        except Exception:
            pass
        return "+".join(applied) if applied else "python-random-only"

    def synthesize(self, text, ref_audio_path, call_params, seed=None):
        """返回 (wav_bytes, meta)。infer 只会写文件，所以写临时文件再读回。"""
        fd, out_path = tempfile.mkstemp(prefix="idx2_", suffix=".wav")
        os.close(fd)
        seed_applied = None
        try:
            if seed is not None:
                # 必须在 infer 之前播种，且在同一把锁内 —— 否则两个并发请求会
                # 互相冲掉对方的随机状态。
                seed_applied = self.apply_seed(int(seed))
            t0 = time.time()
            self.tts.infer(
                spk_audio_prompt=ref_audio_path,
                text=text,
                output_path=out_path,
                **call_params
            )
            elapsed = time.time() - t0
            with open(out_path, "rb") as fh:
                data = fh.read()
            if not data:
                raise RuntimeError("IndexTTS2 wrote an empty file")
            meta = _wav_meta(data)
            meta["seed_applied"] = seed_applied
            meta["infer_seconds"] = round(elapsed, 2)
            if meta.get("duration"):
                meta["rtf"] = round(elapsed / meta["duration"], 2)
            return data, meta
        finally:
            try:
                os.unlink(out_path)
            except OSError:
                pass


def _wav_meta(data):
    """从 WAV 字节里读采样率/声道/时长。拼接侧关心这个：IndexTTS2 出
    22050Hz，而 broker 插入的静音段也硬编码 22050 —— 一致才拼得对。"""
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


ENGINE = Engine()


# ---------------------------------------------------------------------------
#  4) HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "IndexTTS2Shim/1.0"
    protocol_version = "HTTP/1.1"

    # 默认那行 access log 会把每个请求打到 stderr，混在推理进度条里没法看。
    def log_message(self, fmt, *args):
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
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", "/"):
            code = 200 if ENGINE.ready else 503
            self._send(code, {
                "ready": ENGINE.ready,
                # ⭐ start.ps1 的轮询靠这个字段提早退出：failed=true 时继续
                #    等下去没有任何意义，应立刻报错并把 error 打进日志。
                "failed": bool(ENGINE.error),
                "busy": ENGINE.busy,
                "device": ENGINE.device,
                "load_seconds": ENGINE.load_seconds,
                "served": ENGINE.served,
                "engine": "indextts2",
                "banner": BANNER,
                # 加载失败时把 traceback 交出去。让 start.ps1 的轮询能在
                # 日志里看见死因，而不是只看到「一直没起来」。
                "error": ENGINE.error,
                "scrubbed_paths": _DROPPED,
            })
            return
        self._fail(404, "unknown path: %s" % path)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/tts":
            self._fail(404, "unknown path: %s" % path)
            return

        if not ENGINE.ready:
            # ⭐ 「还在加载」和「加载已经失败」必须分开说。两者都 not ready，
            #    但前者该继续等，后者等到天荒地老也不会好 —— 混成一句话，
            #    就会有人盯着「still loading」等满超时才发现进程早死了。
            if ENGINE.error:
                self._fail(503,
                           "engine failed to load and will not recover; "
                           "restart the shim after fixing the cause",
                           failed=True, load_seconds=ENGINE.load_seconds,
                           error=ENGINE.error)
            else:
                self._fail(503, "engine is still loading; poll /health until ready",
                           failed=False, load_seconds=ENGINE.load_seconds)
            return

        try:
            body = self._read_json()
        except Exception as exc:
            self._fail(400, "request body is not valid JSON: %s" % exc)
            return

        text = body.get("text")
        if not text or not str(text).strip():
            self._fail(400, "'text' is required and must not be empty")
            return

        ref = body.get("ref_audio_path")
        if not ref:
            self._fail(400, "'ref_audio_path' is required (IndexTTS2 clones from a reference clip)")
            return
        if not os.path.isfile(ref):
            self._fail(400, "reference audio not found on the engine host: %s" % ref)
            return

        # ⛔ 未知键拦下不放行。见文件头第一条纪律。
        unknown = [k for k in body
                   if k not in CORE_KEYS
                   and k not in CALL_TIME_KEYS
                   and k not in LOAD_TIME_KEYS]
        if unknown:
            self._fail(400,
                       "unknown parameter(s): %s — a mistyped name would otherwise "
                       "be silently ignored and look like it took effect" % ", ".join(sorted(unknown)),
                       unknown=sorted(unknown))
            return

        # 加载期参数出现在调用里 = 调用方以为能热切，其实不能。明确报错，
        # 不要假装接受。（GPT-SoVITS 能热切权重，IndexTTS2 不能。）
        load_time_in_call = [k for k in body if k in LOAD_TIME_KEYS]
        if load_time_in_call:
            self._fail(400,
                       "%s can only be set when the engine process starts, not per "
                       "request; restart the shim with different flags instead"
                       % ", ".join(sorted(load_time_in_call)),
                       load_time_only=sorted(load_time_in_call))
            return

        # format / media_type：只出 wav。⛔ 别默默返回 wav 而让调用方以为拿到了
        # 它要的 mp3 —— 那是个到播放时才会暴露的错误。
        for key in ("format", "media_type"):
            want = body.get(key)
            if want is not None and str(want).lower() not in _SUPPORTED_FORMATS:
                self._fail(400,
                           "%s=%r is not supported by this engine; it only emits "
                           "wav. Transcoding belongs in the broker, not here."
                           % (key, want),
                           supported=sorted(_SUPPORTED_FORMATS))
                return

        # seed：转成 int 才能播种。给了但转不了，报错而不是当没给。
        seed = body.get("seed")
        if seed is not None:
            try:
                seed = int(seed)
            except (TypeError, ValueError):
                self._fail(400, "'seed' must be an integer, got %r" % (seed,))
                return
            if seed < 0:
                # broker 的 resolveSeed 已经把 -1/空 解析成具体值了；还看到负数
                # 说明它没走那条路，此时静默随机会让 meta.json 记的 seed 失真。
                self._fail(400,
                           "'seed' must be >= 0; the broker is expected to resolve "
                           "random seeds to a concrete value before calling, so that "
                           "meta.json records the seed that was actually used")
                return

        call_params = {k: body[k] for k in body if k in CALL_TIME_KEYS}

        with ENGINE.infer_lock:
            ENGINE.busy = True
            try:
                data, meta = ENGINE.synthesize(str(text), ref, call_params, seed=seed)
                ENGINE.served += 1
            except Exception:
                tb = traceback.format_exc()
                sys.stderr.write("%s INFER FAILED\n%s\n" % (BANNER, tb))
                self._fail(500, "IndexTTS2 inference failed", traceback=tb)
                return
            finally:
                ENGINE.busy = False

        sys.stderr.write("%s served bytes=%s sr=%s dur=%ss infer=%ss rtf=%s\n" % (
            BANNER, meta.get("bytes"), meta.get("sample_rate"),
            meta.get("duration"), meta.get("infer_seconds"), meta.get("rtf")))

        # 和 GPT-SoVITS /tts 同形：直接返回 WAV 字节流。
        # ⭐ 这一条是「lib/ 响应侧零改动」的全部理由 —— 模仿传输，不模仿词汇表。
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Engine", "indextts2")
        self.send_header("X-Sample-Rate", str(meta.get("sample_rate", "")))
        self.send_header("X-Infer-Seconds", str(meta.get("infer_seconds", "")))
        # ⭐ 让「seed 到底生效没有」在 HTTP 层可见。空值就是没生效，一眼能看出来，
        #   不用去猜。
        self.send_header("X-Seed-Applied", str(meta.get("seed_applied") or ""))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------------------
#  5) main
# ---------------------------------------------------------------------------
def main():
    if not CKPT_DIR:
        sys.stderr.write("%s FATAL: --checkpoints=<dir> is required\n" % BANNER)
        return 2
    ckpt = os.path.abspath(CKPT_DIR)
    if not os.path.isdir(ckpt):
        sys.stderr.write("%s FATAL: checkpoints dir not found: %s\n" % (BANNER, ckpt))
        return 2
    cfg = os.path.abspath(CFG_PATH) if CFG_PATH else os.path.join(ckpt, "config.yaml")
    if not os.path.isfile(cfg):
        sys.stderr.write("%s FATAL: config not found: %s\n" % (BANNER, cfg))
        return 2

    # ⭐ 上游代码里有 `checkpoints/glossary.yaml` / `checkpoints/bpe.model`
    #    这种相对 CWD 的硬编码，而且是**调用实参**不是默认值 —— 显式传参
    #    救不了。chdir 到 checkpoints 的父目录是唯一不改上游源码的解法。
    #    ⛔ 别在别处再 chdir；这里定一次，之后进程不再改。
    os.chdir(os.path.dirname(ckpt))

    sys.stderr.write("%s starting  host=%s port=%s\n" % (BANNER, HOST, PORT))
    sys.stderr.write("%s cwd=%s\n" % (BANNER, os.getcwd()))
    sys.stderr.write("%s checkpoints=%s\n" % (BANNER, ckpt))
    sys.stderr.write("%s config=%s\n" % (BANNER, cfg))
    sys.stderr.write("%s python=%s\n" % (BANNER, sys.executable))
    if _DROPPED:
        sys.stderr.write("%s scrubbed %d alien sys.path entr%s: %s\n"
                         % (BANNER, len(_DROPPED),
                            "y" if len(_DROPPED) == 1 else "ies", _DROPPED))

    # ⭐ 先绑端口再加载模型：这样 start.ps1 一 spawn 就能连上 /health 拿到
    #    503 + load_seconds，知道「在起，别急」。反过来（先加载后绑端口）
    #    那 61 秒里探活是「连接被拒」，和「进程崩了」长得一模一样。
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True

    loader = threading.Thread(
        target=ENGINE.load, args=(cfg, ckpt), name="indextts2-load", daemon=True)
    loader.start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        sys.stderr.write("%s shutting down\n" % BANNER)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
