# -*- coding: utf-8 -*-

import os, tempfile
os.environ.setdefault("NUMBA_CACHE_DIR", os.path.join(tempfile.gettempdir(), "numba_cache"))
os.makedirs(os.environ["NUMBA_CACHE_DIR"], exist_ok=True)

import sys

inp_text = os.environ.get("inp_text")
inp_wav_dir = os.environ.get("inp_wav_dir")
exp_name = os.environ.get("exp_name")
i_part = os.environ.get("i_part")
all_parts = os.environ.get("all_parts")
if "_CUDA_VISIBLE_DEVICES" in os.environ:
    os.environ["CUDA_VISIBLE_DEVICES"] = os.environ["_CUDA_VISIBLE_DEVICES"]

# IMPORTANT: import librosa BEFORE torch.
# On some Windows machines, importing librosa AFTER torch triggers a native
# access-violation (process exits with 3221225477 / 0xC0000005 and an EMPTY
# log). `from gsv_code.feature_extractor import cnhubert` below pulls in torch
# transitively (cnhubert.py imports torch), and `import torch` follows, so
# librosa must be imported here first. Harmless on machines that don't crash.
import librosa  # noqa: F401

from gsv_code.feature_extractor import cnhubert

opt_dir = os.environ.get("opt_dir")
cnhubert.cnhubert_base_path = os.environ.get("cnhubert_base_dir")
import torch

is_half = eval(os.environ.get("is_half", "True")) and torch.cuda.is_available()

import traceback
import numpy as np
from scipy.io import wavfile
import librosa

now_dir = os.getcwd()
sys.path.append(now_dir)

# 内联 tools.my_utils 的兼容层（避免 tools 依赖）
# 统一保证 load_audio 返回 1D float32 单声道，并统计有效/跳过条数。
import numpy as np
import shutil
import subprocess


def clean_path(path_str):
    if path_str.endswith(("\\", "/")):
        return clean_path(path_str[:-1])
    path_str = path_str.replace("/", os.sep).replace("\\", os.sep)
    return path_str.strip(" '\n\"\u202a")


AUDIO_STATS = {
    "total": 0,       # 尝试加载总数
    "loaded": 0,      # 成功返回
    "downmixed": 0,   # 多声道 -> 单声道
    "resampled": 0,   # 发生重采样
    "via_ffmpeg": 0,  # soundfile 失败后由 ffmpeg 兜底成功
    "failed": 0,      # 两种后端均失败、被跳过
}


def reset_audio_stats():
    for _k in AUDIO_STATS:
        AUDIO_STATS[_k] = 0


def format_audio_stats(prefix="[load_audio]"):
    s = AUDIO_STATS
    return (
        "%s total=%d loaded=%d (downmixed=%d, resampled=%d, via_ffmpeg=%d) failed=%d"
        % (prefix, s["total"], s["loaded"], s["downmixed"], s["resampled"], s["via_ffmpeg"], s["failed"])
    )


_FFMPEG = None


def _ffmpeg_available():
    global _FFMPEG
    if _FFMPEG is None:
        _FFMPEG = shutil.which("ffmpeg") or ""
    return bool(_FFMPEG)


def _to_mono(audio):
    # soundfile 立体声返回 (frames, channels)；取声道平均下混为单声道。
    if audio.ndim > 1:
        return audio.mean(axis=1), True
    return audio, False


def _resample_audio(audio, orig_sr, sr):
    if orig_sr == sr:
        return audio, False
    from scipy.signal import resample
    return resample(audio, int(len(audio) * sr / orig_sr)), True


def _load_soundfile(file, sr):
    import soundfile as sf
    audio, orig_sr = sf.read(file, dtype="float32")
    audio, did_down = _to_mono(audio)
    audio, did_res = _resample_audio(audio, orig_sr, sr)
    return np.ascontiguousarray(audio, dtype=np.float32), did_down, did_res


def _load_ffmpeg(file, sr):
    # 官方原版做法：ffmpeg 强制单声道 (ac=1) + 目标采样率。
    cmd = [_FFMPEG or "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
           "-i", file, "-f", "f32le", "-acodec", "pcm_f32le",
           "-ac", "1", "-ar", str(sr), "-"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError((proc.stderr or b"").decode("utf-8", "ignore")[-300:] or "ffmpeg failed")
    return np.frombuffer(proc.stdout, dtype=np.float32).copy()


def load_audio(file, sr):
    """加载音频并保证返回 1D float32 单声道（目标采样率 sr）。

    优先 soundfile（不需要 ffmpeg，best-effort 处理 wav/flac/ogg 等）；
    失败且系统装有 ffmpeg 时用官方原版方式兜底（mp3/m4a/aac 等）；
    仍失败则计入 failed 并返回 None（调用方跳过该条）。
    统计见 AUDIO_STATS / format_audio_stats()。
    """
    file = clean_path(file)
    AUDIO_STATS["total"] += 1
    try:
        audio, did_down, did_res = _load_soundfile(file, sr)
        AUDIO_STATS["loaded"] += 1
        if did_down:
            AUDIO_STATS["downmixed"] += 1
        if did_res:
            AUDIO_STATS["resampled"] += 1
        return audio
    except Exception as e_sf:
        sf_err = e_sf
    if _ffmpeg_available():
        try:
            audio = _load_ffmpeg(file, sr)
            AUDIO_STATS["loaded"] += 1
            AUDIO_STATS["via_ffmpeg"] += 1
            return audio
        except Exception as e_ff:
            print("[load_audio] ffmpeg 兜底失败 %s: %s" % (file, e_ff))
    else:
        print("[load_audio] soundfile 读取失败且未检测到 ffmpeg，跳过 %s: %s" % (file, sf_err))
    AUDIO_STATS["failed"] += 1
    return None

# from config import cnhubert_base_path
# cnhubert.cnhubert_base_path=cnhubert_base_path
# inp_text=sys.argv[1]
# inp_wav_dir=sys.argv[2]
# exp_name=sys.argv[3]
# i_part=sys.argv[4]
# all_parts=sys.argv[5]
# os.environ["CUDA_VISIBLE_DEVICES"]=sys.argv[6]
# cnhubert.cnhubert_base_path=sys.argv[7]
# opt_dir="/data/docker/liujing04/gpt-vits/fine_tune_dataset/%s"%exp_name

from time import time as ttime
import shutil


def my_save(fea, path):  #####fix issue: torch.save doesn't support chinese path
    dir = os.path.dirname(path)
    name = os.path.basename(path)
    # tmp_path="%s/%s%s.pth"%(dir,ttime(),i_part)
    tmp_path = "%s%s.pth" % (ttime(), i_part)
    torch.save(fea, tmp_path)
    shutil.move(tmp_path, "%s/%s" % (dir, name))


hubert_dir = "%s/4-cnhubert" % (opt_dir)
wav32dir = "%s/5-wav32k" % (opt_dir)
os.makedirs(opt_dir, exist_ok=True)
os.makedirs(hubert_dir, exist_ok=True)
os.makedirs(wav32dir, exist_ok=True)

maxx = 0.95
alpha = 0.5
if torch.cuda.is_available():
    device = "cuda:0"
# elif torch.backends.mps.is_available():
#     device = "mps"
else:
    device = "cpu"
model = cnhubert.get_model()
# is_half=False
if is_half == True:
    model = model.half().to(device)
else:
    model = model.to(device)

nan_fails = []


def name2go(wav_name, wav_path):
    hubert_path = "%s/%s.pt" % (hubert_dir, wav_name)
    if os.path.exists(hubert_path):
        return
    tmp_audio = load_audio(wav_path, 32000)
    if tmp_audio is None:
        return
    tmp_max = np.abs(tmp_audio).max()
    if tmp_max > 2.2:
        print("%s-filtered,%s" % (wav_name, tmp_max))
        return
    tmp_audio32 = (tmp_audio / tmp_max * (maxx * alpha * 32768)) + ((1 - alpha) * 32768) * tmp_audio
    tmp_audio32b = (tmp_audio / tmp_max * (maxx * alpha * 1145.14)) + ((1 - alpha) * 1145.14) * tmp_audio
    tmp_audio = librosa.resample(tmp_audio32b, orig_sr=32000, target_sr=16000)  # 不是重采样问题
    tensor_wav16 = torch.from_numpy(tmp_audio)
    if is_half == True:
        tensor_wav16 = tensor_wav16.half().to(device)
    else:
        tensor_wav16 = tensor_wav16.to(device)
    ssl = model.model(tensor_wav16.unsqueeze(0))["last_hidden_state"].transpose(1, 2).cpu()  # torch.Size([1, 768, 215])
    if np.isnan(ssl.detach().numpy()).sum() != 0:
        nan_fails.append((wav_name, wav_path))
        print("nan filtered:%s" % wav_name)
        return
    wavfile.write(
        "%s/%s" % (wav32dir, wav_name),
        32000,
        tmp_audio32.astype("int16"),
    )
    my_save(ssl, hubert_path)


reset_audio_stats()

with open(inp_text, "r", encoding="utf8") as f:
    lines = f.read().strip("\n").split("\n")

for line in lines[int(i_part) :: int(all_parts)]:
    try:
        # wav_name,text=line.split("\\t")
        wav_name, spk_name, language, text = line.split("|")
        wav_name = clean_path(wav_name)
        if inp_wav_dir != "" and inp_wav_dir != None:
            wav_name = os.path.basename(wav_name)
            if not wav_name.endswith(".wav"):
                wav_path = "%s/%s.wav" % (inp_wav_dir, wav_name)
                # Try without numeric suffix if not found
                if not os.path.exists(wav_path):
                    import re
                    base = re.sub(r'_\d+$', '', wav_name)
                    alt_path = "%s/%s.wav" % (inp_wav_dir, base)
                    if os.path.exists(alt_path):
                        wav_path = alt_path
            else:
                wav_path = "%s/%s" % (inp_wav_dir, wav_name)

        else:
            wav_path = wav_name
            wav_name = os.path.basename(wav_name)
        name2go(wav_name, wav_path)
    except:
        print(line, traceback.format_exc())

if len(nan_fails) > 0 and is_half == True:
    is_half = False
    model = model.float()
    for wav in nan_fails:
        try:
            name2go(wav[0], wav[1])
        except:
            print(wav_name, traceback.format_exc())

print(format_audio_stats("[2-hubert] audio load stats:"))

# Guard: if no hubert features were produced, fail loudly instead of silently
import glob
produced = len(glob.glob("%s/*.pt" % hubert_dir))
if produced == 0:
    print("ERROR: no hubert features produced; check inp_text delimiter / wav paths", file=sys.stderr)
    sys.exit(1)
