"""
本地自包含推理 HTTP 服务 (infer_server.py)

由 GPT-SoVITS 的 api_v2.py 本地化移植而来,使本项目不再依赖外部
D:\\AI\\GPT-SoVITS-v2pro-20250604 引擎即可完成推理。

启动:
    <venv>\\python.exe lib\\inference\\infer_server.py -a 127.0.0.1 -p 9880 -c lib\\inference\\tts_infer.yaml

接口 (与 server.js 调用 1:1 兼容):
    GET  /                       健康检查 (返回 200)
    POST /tts                    文本转语音, 返回 audio/wav 字节流
    GET  /tts                    同上 (query 参数)
    GET  /set_gpt_weights?weights_path=     热加载 GPT 权重
    GET  /set_sovits_weights?weights_path=  热加载 SoVITS 权重
    GET  /control?command=restart|exit      进程控制
"""

import os
import sys
import traceback
from typing import Generator, Union

# ------------------------------------------------------------------
# Force UTF-8 I/O. On a Chinese Windows console the default stdout/stderr
# encoding is GBK (cp936); when the engine logs text containing characters GBK
# cannot represent (e.g. the U+FFFD replacement char), Python raises
# UnicodeEncodeError inside the request path and the whole /v1/audio/speech call
# fails with a 502. Reconfiguring to UTF-8 with errors="replace" makes logging
# lossless-enough and never crash, regardless of how the process is launched
# (start.ps1 launches this directly, bypassing server.js's clean env).
os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ============================================================
# 路径与环境初始化 (必须在 import TTS / librosa 之前)
# ============================================================
THIS_DIR = os.path.dirname(os.path.abspath(__file__))      # .../lib/inference
LIB_DIR = os.path.dirname(THIS_DIR)                         # .../lib
PROJECT_ROOT = os.path.dirname(LIB_DIR)                     # 项目根

# gsv_code 作为包导入需要 lib/training 在 path 上; TTS/sv/BigVGAN/sr/TTS_infer_pack 需要 lib/inference 在 path 上
sys.path.insert(0, os.path.join(LIB_DIR, "training"))
sys.path.insert(0, THIS_DIR)
# 训练脚本以裸名 `import utils` 引用 gsv_code/utils.py, 训练出的 SoVITS 权重把 hps
# (utils.HParams 对象) pickle 进 checkpoint["config"], 其模块引用记为裸名 `utils`。
# 反序列化 (load_sovits_new -> torch.load) 需要裸 `import utils` 能解析, 否则报
# "No module named 'utils'" 导致 set_sovits_weights 400、训练模型无法加载。
# 用 append 放在 path 末尾: 既能解析裸 utils, 又不遮蔽推理端/训练包已有的
# 同名顶层模块 (gsv_code 下有 text/tools/module/configs), 保持既有导入顺序不变。
sys.path.append(os.path.join(LIB_DIR, "training", "gsv_code"))

# 让 yaml 里的相对底模路径 (./lib/training/...) 始终相对项目根解析
os.chdir(PROJECT_ROOT)

# numba (librosa 依赖) 缓存目录: 指向项目内可写目录, 避免 site-packages 只读导致的 PermissionError
os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(PROJECT_ROOT, ".numba_cache"))
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)

# Windows 上 numpy/soundfile/sklearn 等各自捆绑 OpenMP/MKL 运行时, 若在 torch 之前加载,
# 会与 torch 的 OpenMP 产生重复运行时冲突, 导致首次 torch 重运算 (加载/构建模型) 时
# 静默访问冲突崩溃 (无 Python traceback)。两个措施规避:
#   1) 允许重复 OpenMP 运行时共存 (官方推荐的兜底开关, 这一条已足以规避 OpenMP 冲突)
#   2) 固定 native 库加载顺序: 先 librosa, 再 torch
#
# 注意 (2) 的方向: 早期版本是"抢先 import torch"。但在部分 Windows 机器上,
# 若 torch 先于 librosa 加载, librosa 的 import 会触发 native 访问冲突
# (进程以 3221225477 / 0xC0000005 退出, 且无任何 Python traceback / 空日志),
# 经逐库 bisect 确认崩溃点正是 "torch-then-librosa" 这个顺序。librosa 会连带
# 加载 numpy/soundfile/numba 等; 有了上面的 KMP_DUPLICATE_LIB_OK 兜底,
# 让 librosa 先加载不会重新引入当初的 OpenMP 重复运行时崩溃, 反而能同时避开
# torch-then-librosa 崩溃。因此这里改为先 import librosa, 再 import torch。
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
import librosa  # noqa: F401  # 必须在 torch 之前, 规避 torch-then-librosa native 崩溃
import torch  # noqa: F401

import argparse
import asyncio
import signal
import wave
import subprocess
import numpy as np
import soundfile as sf
from io import BytesIO
import threading

from fastapi import FastAPI, Response
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn
from pydantic import BaseModel

from gsv_code.tools.i18n.i18n import I18nAuto
from TTS import TTS, TTS_Config
from TTS_infer_pack.text_segmentation_method import get_method_names as get_cut_method_names

i18n = I18nAuto()
cut_method_names = get_cut_method_names()

parser = argparse.ArgumentParser(description="TTS Broker self-contained inference api")
parser.add_argument("-c", "--tts_config", type=str,
                    default=os.path.join(THIS_DIR, "tts_infer.yaml"), help="tts_infer.yaml 路径")
parser.add_argument("-a", "--bind_addr", type=str, default="127.0.0.1", help="default: 127.0.0.1")
parser.add_argument("-p", "--port", type=int, default=9880, help="default: 9880")
args = parser.parse_args()

config_path = args.tts_config
port = args.port
host = args.bind_addr
argv = sys.argv

if config_path in [None, ""]:
    config_path = os.path.join(THIS_DIR, "tts_infer.yaml")

# 活动配置缺失时从模板复制(活动 yaml 会被运行时热加载回写, 故不入库)
if not os.path.exists(config_path):
    _example = config_path + ".example"
    if os.path.exists(_example):
        import shutil
        shutil.copyfile(_example, config_path)
        print(f"[config] {config_path} not found, copied from template: {_example}")
    else:
        print(f"[config] warning: neither {config_path} nor template {_example} exists")

tts_config = TTS_Config(config_path)
print(tts_config)
tts_pipeline = TTS(tts_config)

# tts_pipeline 是模块级全局单例, 被所有请求共享。切换 GPT/SoVITS 权重
# (init_t2s_weights / init_vits_weights) 与推理 (run) 会并发访问同一对象:
# 若一次推理进行中另一请求切了权重, 推理会读到半加载状态而抛异常 (/tts 返回 400
# -> server.js 返回 500), 刷新后 (权重已切完) 又正常 —— 典型竞态。
# 用一把互斥锁把"切权重"与"推理"串行化: 切模型时新推理排队等待, 反之亦然。
_model_lock = asyncio.Lock()

APP = FastAPI()


class TTS_Request(BaseModel):
    text: str = None
    text_lang: str = None
    ref_audio_path: str = None
    aux_ref_audio_paths: list = None
    prompt_lang: str = None
    prompt_text: str = ""
    top_k: int = 15
    top_p: float = 1
    temperature: float = 1
    text_split_method: str = "cut5"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    speed_factor: float = 1.0
    fragment_interval: float = 0.3
    seed: int = -1
    media_type: str = "wav"
    streaming_mode: Union[bool, int] = False
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    sample_steps: int = 32
    super_sampling: bool = False
    overlap_length: int = 2
    min_chunk_length: int = 16
    # 读音校对（task6）：本次合成的词粒度读音覆盖，形如 {"乐句": ["yue4","ju4"]}
    pron_overrides: dict = None
    # Auto (Multilingual)：kana-free CJK 片段的兜底语言（取自音色元数据语言）
    auto_base_lang: str = None
    # 逐字语言覆盖：{子串 -> 强制语言}，把共享汉字强制读成反向语言（zh/yue/ja）
    lang_overrides: dict = None


class PronPreviewRequest(BaseModel):
    text: str = None
    lang: str = "zh"


def _normalize_pron_lang(lang):
    lang = (lang or "zh").lower().replace("all_", "").replace("auto_", "").replace("auto", "zh")
    return lang or "zh"


def pack_ogg(io_buffer: BytesIO, data: np.ndarray, rate: int):
    def handle_pack_ogg():
        with sf.SoundFile(io_buffer, mode="w", samplerate=rate, channels=1, format="ogg") as audio_file:
            audio_file.write(data)

    stack_size = 4096 * 4096
    try:
        threading.stack_size(stack_size)
        t = threading.Thread(target=handle_pack_ogg)
        t.start()
        t.join()
    except RuntimeError as e:
        print("RuntimeError: {}".format(e))
    except ValueError as e:
        print("ValueError: {}".format(e))
    return io_buffer


def pack_raw(io_buffer: BytesIO, data: np.ndarray, rate: int):
    io_buffer.write(data.tobytes())
    return io_buffer


def pack_wav(io_buffer: BytesIO, data: np.ndarray, rate: int):
    io_buffer = BytesIO()
    sf.write(io_buffer, data, rate, format="wav")
    return io_buffer


def pack_aac(io_buffer: BytesIO, data: np.ndarray, rate: int):
    # 注意: aac 依赖系统 ffmpeg 二进制。本项目已解耦 ffmpeg, 故 aac 默认不可用。
    # server.js 默认 media_type=wav, 不会走到这里。如需 aac 请自行安装 ffmpeg。
    process = subprocess.Popen(
        ["ffmpeg", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
         "-c:a", "aac", "-b:a", "192k", "-vn", "-f", "adts", "pipe:1"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out, _ = process.communicate(input=data.tobytes())
    io_buffer.write(out)
    return io_buffer


def pack_audio(io_buffer: BytesIO, data: np.ndarray, rate: int, media_type: str):
    if media_type == "ogg":
        io_buffer = pack_ogg(io_buffer, data, rate)
    elif media_type == "aac":
        io_buffer = pack_aac(io_buffer, data, rate)
    elif media_type == "wav":
        io_buffer = pack_wav(io_buffer, data, rate)
    else:
        io_buffer = pack_raw(io_buffer, data, rate)
    io_buffer.seek(0)
    return io_buffer


def wave_header_chunk(frame_input=b"", channels=1, sample_width=2, sample_rate=32000):
    wav_buf = BytesIO()
    with wave.open(wav_buf, "wb") as vfout:
        vfout.setnchannels(channels)
        vfout.setsampwidth(sample_width)
        vfout.setframerate(sample_rate)
        vfout.writeframes(frame_input)
    wav_buf.seek(0)
    return wav_buf.read()


def handle_control(command: str):
    if command == "restart":
        os.execl(sys.executable, sys.executable, *argv)
    elif command == "exit":
        os.kill(os.getpid(), signal.SIGTERM)
        exit(0)


def check_params(req: dict):
    text: str = req.get("text", "")
    text_lang: str = req.get("text_lang", "")
    ref_audio_path: str = req.get("ref_audio_path", "")
    media_type: str = req.get("media_type", "wav")
    prompt_lang: str = req.get("prompt_lang", "")
    text_split_method: str = req.get("text_split_method", "cut5")

    if ref_audio_path in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "ref_audio_path is required"})
    if text in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "text is required"})
    if text_lang in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "text_lang is required"})
    elif text_lang.lower() not in tts_config.languages:
        return JSONResponse(status_code=400,
            content={"message": f"text_lang: {text_lang} is not supported in version {tts_config.version}"})
    if prompt_lang in [None, ""]:
        return JSONResponse(status_code=400, content={"message": "prompt_lang is required"})
    elif prompt_lang.lower() not in tts_config.languages:
        return JSONResponse(status_code=400,
            content={"message": f"prompt_lang: {prompt_lang} is not supported in version {tts_config.version}"})
    if media_type not in ["wav", "raw", "ogg", "aac"]:
        return JSONResponse(status_code=400, content={"message": f"media_type: {media_type} is not supported"})
    if text_split_method not in cut_method_names:
        return JSONResponse(status_code=400, content={"message": f"text_split_method:{text_split_method} is not supported"})
    return None


async def tts_handle(req: dict):
    streaming_mode = req.get("streaming_mode", False)
    return_fragment = req.get("return_fragment", False)
    media_type = req.get("media_type", "wav")

    check_res = check_params(req)
    if check_res is not None:
        return check_res

    if streaming_mode == 0:
        streaming_mode = False; return_fragment = False; fixed_length_chunk = False
    elif streaming_mode == 1:
        streaming_mode = False; return_fragment = True; fixed_length_chunk = False
    elif streaming_mode == 2:
        streaming_mode = True; return_fragment = False; fixed_length_chunk = False
    elif streaming_mode == 3:
        streaming_mode = True; return_fragment = False; fixed_length_chunk = True
    else:
        return JSONResponse(status_code=400,
            content={"message": "the value of streaming_mode must be 0, 1, 2, 3(int) or true/false(bool)"})

    req["streaming_mode"] = streaming_mode
    req["return_fragment"] = return_fragment
    req["fixed_length_chunk"] = fixed_length_chunk

    streaming_mode = streaming_mode or return_fragment

    # 读音校对（task6）：设置本次合成的词粒度读音覆盖上下文；缺模块时静默降级。
    pron_overrides = req.pop("pron_overrides", None)
    _pron_active = False
    if pron_overrides:
        try:
            from gsv_code.text import pron_correction
            _pron_lang = _normalize_pron_lang(req.get("text_lang"))
            print(f"[infer_server] pron_overrides received (lang={_pron_lang}): {pron_overrides}", flush=True)
            pron_correction.set_context(pron_overrides, _pron_lang)
            _pron_active = True
        except Exception as _e:
            print(f"[infer_server] pron override set failed: {_e!r}")

    def _clear_pron():
        if _pron_active:
            try:
                from gsv_code.text import pron_correction
                pron_correction.clear_context()
            except Exception:
                pass

    # 与切权重互斥: 整个推理期间持锁, 防止 run() 读到半加载权重。
    # 非流式路径全程在事件循环线程上 (next() 同步阻塞), 直接 release 即可;
    # 流式路径下生成器在 starlette 线程池里迭代, 故用 call_soon_threadsafe
    # 把 release 调度回事件循环线程, 避免跨线程操作 asyncio.Lock。
    _loop = asyncio.get_running_loop()
    await _model_lock.acquire()
    _lock_state = {"released": False}

    def _release_lock_threadsafe():
        if _lock_state["released"]:
            return
        _lock_state["released"] = True
        try:
            _loop.call_soon_threadsafe(_model_lock.release)
        except RuntimeError:
            # 兜底: 事件循环已关闭/停止时 call_soon_threadsafe 会抛 RuntimeError
            # (例如进程正在退出、请求被中断)。此时无法再调度回事件循环线程,
            # 只能就地直接 release, 确保锁不会因崩溃路径而永久泄漏, 阻塞后续请求。
            try:
                _model_lock.release()
            except Exception:
                pass

    _handed_to_stream = False
    try:
        tts_generator = tts_pipeline.run(req)
        if streaming_mode:
            def streaming_generator(tts_generator: Generator, media_type: str):
                try:
                    if_frist_chunk = True
                    for sr, chunk in tts_generator:
                        if if_frist_chunk and media_type == "wav":
                            yield wave_header_chunk(sample_rate=sr)
                            media_type = "raw"
                            if_frist_chunk = False
                        yield pack_audio(BytesIO(), chunk, sr, media_type).getvalue()
                finally:
                    _clear_pron()
                    _release_lock_threadsafe()

            resp = StreamingResponse(
                streaming_generator(tts_generator, media_type),
                media_type=f"audio/{media_type}",
            )
            _handed_to_stream = True  # 锁的释放交给流式生成器的 finally
            return resp
        else:
            sr, audio_data = next(tts_generator)
            audio_data = pack_audio(BytesIO(), audio_data, sr, media_type).getvalue()
            _clear_pron()
            return Response(audio_data, media_type=f"audio/{media_type}")
    except Exception as e:
        _clear_pron()
        return JSONResponse(status_code=400, content={"message": "tts failed", "Exception": str(e)})
    finally:
        if not _handed_to_stream and not _lock_state["released"]:
            _lock_state["released"] = True
            _model_lock.release()


@APP.get("/")
async def health():
    # server.js (line 722) 用 GET / 做健康检查, 返回 200 即视为 online
    return JSONResponse(status_code=200, content={"message": "infer_server online", "version": tts_config.version})


@APP.get("/control")
async def control(command: str = None):
    if command is None:
        return JSONResponse(status_code=400, content={"message": "command is required"})
    handle_control(command)


@APP.get("/tts")
async def tts_get_endpoint(
    text: str = None, text_lang: str = None, ref_audio_path: str = None,
    aux_ref_audio_paths: list = None, prompt_lang: str = None, prompt_text: str = "",
    top_k: int = 15, top_p: float = 1, temperature: float = 1,
    text_split_method: str = "cut5", batch_size: int = 1, batch_threshold: float = 0.75,
    split_bucket: bool = True, speed_factor: float = 1.0, fragment_interval: float = 0.3,
    seed: int = -1, media_type: str = "wav", parallel_infer: bool = True,
    repetition_penalty: float = 1.35, sample_steps: int = 32, super_sampling: bool = False,
    streaming_mode: Union[bool, int] = False, overlap_length: int = 2, min_chunk_length: int = 16,
):
    req = {
        "text": text, "text_lang": text_lang.lower() if text_lang else text_lang,
        "ref_audio_path": ref_audio_path, "aux_ref_audio_paths": aux_ref_audio_paths,
        "prompt_text": prompt_text, "prompt_lang": prompt_lang.lower() if prompt_lang else prompt_lang,
        "top_k": top_k, "top_p": top_p, "temperature": temperature,
        "text_split_method": text_split_method, "batch_size": int(batch_size),
        "batch_threshold": float(batch_threshold), "speed_factor": float(speed_factor),
        "split_bucket": split_bucket, "fragment_interval": fragment_interval, "seed": seed,
        "media_type": media_type, "streaming_mode": streaming_mode, "parallel_infer": parallel_infer,
        "repetition_penalty": float(repetition_penalty), "sample_steps": int(sample_steps),
        "super_sampling": super_sampling, "overlap_length": int(overlap_length),
        "min_chunk_length": int(min_chunk_length),
    }
    return await tts_handle(req)


@APP.post("/tts")
async def tts_post_endpoint(request: TTS_Request):
    req = request.dict()
    return await tts_handle(req)


@APP.post("/pron/preview")
async def pron_preview(request: PronPreviewRequest):
    # 读音校对（task6）：文本 -> 逐词逐字读音 + 候选 + 多音标记。
    # 复用引擎已加载的 g2pW，保证预览读音 == 实际合成读音。
    try:
        from gsv_code.text import pron_correction
        data = pron_correction.preview(request.text or "", _normalize_pron_lang(request.lang))
        return JSONResponse(status_code=200, content=data)
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "pron preview failed", "Exception": str(e)})


@APP.get("/set_refer_audio")
async def set_refer_audio(refer_audio_path: str = None):
    try:
        async with _model_lock:
            tts_pipeline.set_ref_audio(refer_audio_path)
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "set refer audio failed", "Exception": str(e)})
    return JSONResponse(status_code=200, content={"message": "success"})


@APP.get("/set_gpt_weights")
async def set_gpt_weights(weights_path: str = None):
    try:
        if weights_path in ["", None]:
            return JSONResponse(status_code=400, content={"message": "gpt weight path is required"})
        async with _model_lock:
            tts_pipeline.init_t2s_weights(weights_path)
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "change gpt weight failed", "Exception": str(e)})
    return JSONResponse(status_code=200, content={"message": "success"})


@APP.get("/set_sovits_weights")
async def set_sovits_weights(weights_path: str = None):
    try:
        if weights_path in ["", None]:
            return JSONResponse(status_code=400, content={"message": "sovits weight path is required"})
        async with _model_lock:
            tts_pipeline.init_vits_weights(weights_path)
    except Exception as e:
        return JSONResponse(status_code=400, content={"message": "change sovits weight failed", "Exception": str(e)})
    return JSONResponse(status_code=200, content={"message": "success"})


if __name__ == "__main__":
    try:
        if host == "None":
            host = None
        uvicorn.run(app=APP, host=host, port=port, workers=1)
    except Exception:
        traceback.print_exc()
        os.kill(os.getpid(), signal.SIGTERM)
        exit(0)
