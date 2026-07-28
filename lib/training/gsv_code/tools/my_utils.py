import os
import shutil
import subprocess
import numpy as np


def clean_path(path_str):
    if path_str.endswith(("/", "\\")):
        return clean_path(path_str[:-1])
    return path_str.replace("/", os.sep).replace("\\", os.sep).strip(" '\n\"\u202a")


# ── 音频加载统计（本次运行）；供各 prepare 脚本结束时打印 ──
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
            print("[load_audio] ffmpeg fallback failed %s: %s" % (file, e_ff))
    else:
        print("[load_audio] soundfile read failed and no ffmpeg detected; skipping %s: %s" % (file, sf_err))
    AUDIO_STATS["failed"] += 1
    return None
