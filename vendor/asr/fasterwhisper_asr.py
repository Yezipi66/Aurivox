"""
Faster Whisper ASR — 从 GPT-SoVITS 项目解耦
移除 tools.* 依赖，改为使用项目内的 asr_utils
"""
import argparse
import json
import math
import os
import shutil
import sys
import traceback

import requests
import torch
from faster_whisper import WhisperModel
try:
    from faster_whisper import BatchedInferencePipeline
    HAS_BATCHED = True
except ImportError:
    HAS_BATCHED = False
from huggingface_hub import snapshot_download as snapshot_download_hf
from modelscope import snapshot_download as snapshot_download_ms
from tqdm import tqdm

# 项目内工具（替代 tools.my_utils 和 tools.asr.config）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from asr.asr_utils import load_cudnn, get_asr_models

# FunASR / DAMO Chinese post-processing is intentionally disabled: on Windows
# it repeatedly hangs/crashes for zh/yue, which was the sole reason Chinese ASR
# failed while ja/en worked. All languages now use faster-whisper only.
HAS_FUNASR = False

# fmt: off
language_code_list = [
    "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo",
    "br", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es",
    "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw",
    "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja",
    "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo",
    "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt",
    "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt",
    "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq",
    "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl",
    "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "zh", "yue",
    "auto",
]
# fmt: on

# FunASR 中文模型缓存
_funasr_models = {}

# ── Patch #22：繁→简（简体中文强制）─────────────────────────────────────
# 本产品只面向简体中文，从不支持繁体。faster-whisper 对 zh/yue 可能混吐简/繁，
# 这里在 ASR 源头统一转简体，使下游（.list / segments / 推理 / 前端）全链路一致。
# 转换器优先级：OpenCC(t2s) → zhconv(zh-hans) → 原样透传并告警（绝不因此让 ASR 崩溃）。
_t2s_fn = None
_t2s_ready = False


def _get_t2s():
    """惰性构建繁→简转换器，失败则返回 None（透传）。"""
    global _t2s_fn, _t2s_ready
    if _t2s_ready:
        return _t2s_fn
    _t2s_ready = True
    try:
        import opencc  # type: ignore
        _conv = opencc.OpenCC("t2s")
        _t2s_fn = lambda s: _conv.convert(s)
        print("[zh] simplified conversion via OpenCC (t2s)", flush=True)
        return _t2s_fn
    except Exception as e:
        print(f"[zh] OpenCC unavailable ({e}); trying zhconv", flush=True)
    try:
        from zhconv import convert as _zhconvert  # type: ignore
        _t2s_fn = lambda s: _zhconvert(s, "zh-hans")
        print("[zh] simplified conversion via zhconv (zh-hans)", flush=True)
        return _t2s_fn
    except Exception as e:
        print(f"[zh] zhconv unavailable ({e}); simplified conversion DISABLED (passthrough)", flush=True)
    _t2s_fn = None
    return None


def _to_simplified(text):
    """繁→简；转换器缺失或异常时原样返回。"""
    if not text:
        return text
    fn = _get_t2s()
    if fn is None:
        return text
    try:
        return fn(text)
    except Exception:
        return text


# 仅对中文族语言做繁→简（日文汉字简化规则不同，绝不动 ja）。
_SIMPLIFY_LANGS = {"zh", "yue"}


# ── Patch #23：ASR 置信度 ────────────────────────────────────────────────
def _segment_confidence(avg_logprob, no_speech_prob, word_probs):
    """把 whisper 的对数概率折算成 [0,1] 置信度。
    优先用 word-level 概率均值；否则用 exp(avg_logprob)；再按 no_speech_prob 惩罚。"""
    base = None
    if word_probs:
        base = sum(word_probs) / len(word_probs)
    elif avg_logprob is not None:
        try:
            base = math.exp(avg_logprob)  # logprob<=0 → (0,1]
        except Exception:
            base = None
    if base is None:
        return None
    nsp = no_speech_prob if isinstance(no_speech_prob, (int, float)) else 0.0
    nsp = min(max(nsp, 0.0), 1.0)
    conf = base * (1.0 - nsp)
    return round(max(0.0, min(1.0, conf)), 4)


def _faster_whisper_dir() -> str:
    """faster-whisper 权重目录。

    首选 FASTER_WHISPER_DIR（由 lib/paths.js 经 getCleanEnv 下发）；
    兜底一路上溯找 package.json 定位项目根，绝不数目录层数 —— 迁此之前
    这里按 __file__ 数了两级，代码一搬层数就失准，且不报错（引擎契约 C7）。
    """
    d = os.environ.get("FASTER_WHISPER_DIR")
    if d:
        return d
    d = os.path.dirname(os.path.abspath(__file__))
    while not os.path.isfile(os.path.join(d, "package.json")):
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("project root (package.json) not found above " + __file__)
        d = parent
    return os.path.join(d, "models", "asr", "faster-whisper")


def _download_model(model_size: str, model_dir: str):
    """下载模型到指定目录"""
    url = "https://huggingface.co/api/models/gpt2"
    try:
        requests.get(url, timeout=3)
        source = "HF"
    except Exception:
        source = "ModelScope"

    if source == "HF":
        if model_size == "large-v3-turbo":
            repo_id = "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
        elif "distil" in model_size:
            repo_id = f"Systran/faster-{model_size}-whisper-{model_size}"
        else:
            repo_id = f"Systran/faster-whisper-{model_size}"

        files = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]
        if "large-v3" in model_size or "distil" in model_size:
            files.append("preprocessor_config.json")
            files.append("vocabulary.json")
            files.remove("vocabulary.txt")

        print(f"Downloading from HF: {repo_id} -> {model_dir}")
        snapshot_download_hf(
            repo_id, local_dir=model_dir,
            local_dir_use_symlinks=False, allow_patterns=files,
        )
    else:
        repo_id = "XXXXRT/faster-whisper"
        files = [f"faster-whisper-{model_size}/{f}" for f in
                 ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "vocabulary.json",
                  "preprocessor_config.json"]]
        # ModelScope 仓库把权重放在 faster-whisper-<size>/ 前缀下。若直接 local_dir=model_dir,
        # 会落成 model_dir/faster-whisper-<size>/...(双层嵌套, ASR 找不到 model.bin)。
        # 故下载到 model_dir 的父目录, 让该前缀正好落成 model_dir 本身。
        parent = os.path.dirname(os.path.abspath(model_dir)) or "."
        print(f"Downloading from ModelScope: {repo_id} -> {parent}")
        snapshot_download_ms(
            repo_id, local_dir=parent,
            allow_patterns=files,
        )

    # 安全兜底: 无论何种来源, 若权重意外落到 model_dir/faster-whisper-<size>/ 里,
    # 把该嵌套目录内容上移一层, 保证 model.bin 直接位于 model_dir 根下。
    nested = os.path.join(model_dir, f"faster-whisper-{model_size}")
    if os.path.isdir(nested) and os.path.exists(os.path.join(nested, "model.bin")):
        for fn in os.listdir(nested):
            src = os.path.join(nested, fn)
            dst = os.path.join(model_dir, fn)
            if not os.path.exists(dst):
                shutil.move(src, dst)
        try:
            shutil.rmtree(nested)
        except OSError:
            pass


def _get_model_path(model_size: str, asr_models_dir: str) -> str:
    """权重目录 = <权重根>/<model_size>。这是全脚本唯一一处计算它的地方。

    以 model.bin 是否存在为准，而不是目录是否存在：一次被中断的下载会留下一个
    有目录、没权重的空壳，那时"目录存在"是真的，"权重可用"是假的。
    """
    model_dir = os.path.join(asr_models_dir, model_size)
    if not os.path.exists(os.path.join(model_dir, "model.bin")):
        # 静默重下是本项目已发生过两次的事故：路径一错就悄悄再拉几个 GB，
        # 不报错、不提示，只是很慢，硬盘上多出一份。此处必须先喊出来。
        print(
            f"[faster-whisper] weights not found at {model_dir}; downloading {model_size}. "
            f"Set FASTER_WHISPER_DIR if they live elsewhere.",
            flush=True,
        )
        os.makedirs(asr_models_dir, exist_ok=True)
        _download_model(model_size, model_dir)
    return model_dir


def _funasr_only_asr(input_file: str, language: str) -> str:
    """FunASR 中文后处理（可选）"""
    if not HAS_FUNASR:
        return ""
    try:
        if language not in _funasr_models:
            from modelscope import snapshot_download
            if language == "zh":
                model_id = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            else:
                model_id = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            local_path = snapshot_download(model_id)
            _funasr_models[language] = AutoModel(model=local_path)
        text = _funasr_models[language].generate(input=input_file)[0]["text"]
        return text
    except Exception:
        return ""


def execute_asr(input_folder, output_folder, model_path, language, precision,
                batch_size=8, beam_size=1, force_simplified=True):
    if language == "auto":
        language = None
    print(f"Loading model: {model_path}", flush=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = WhisperModel(model_path, device=device, compute_type=precision)

    # 批量推理管线（可用则用，否则降级为普通 model）
    use_batched = HAS_BATCHED and device == "cuda" and batch_size > 1
    asr_engine = BatchedInferencePipeline(model=model) if use_batched else model
    if use_batched:
        print(f"Using BatchedInferencePipeline, batch_size={batch_size}", flush=True)
    if force_simplified:
        _get_t2s()  # 预热转换器并在日志中暴露可用性

    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)
    # Patch #23：置信度旁车（sidecar），键为片段文件名（basename），绝不写入 .list 第 5 列。
    conf_map = {}

    def _transcribe(fp, want_words):
        # 片段已是 VAD 切好的短音频：关闭冗余 vad_filter；beam_size=1 贪心。
        kw = dict(audio=fp, beam_size=beam_size, vad_filter=False, language=language)
        if use_batched:
            kw["batch_size"] = batch_size
        if want_words:
            kw["word_timestamps"] = True
        return asr_engine.transcribe(**kw)

    # 部分 BatchedInferencePipeline 版本不支持 word_timestamps；探测一次后决定，
    # 失败则整轮降级为 segment-level 置信度（绝不因可选特性丢文本）。
    want_words = True

    for file_name in tqdm(input_file_names):
        try:
            file_path = os.path.join(input_folder, file_name)
            # word_timestamps=True 以拿到 word-level 概率（置信度着色用）。
            try:
                segments, info = _transcribe(file_path, want_words)
            except TypeError as te:
                if want_words:
                    print(f"  word_timestamps unsupported ({te}); falling back to segment-level confidence", flush=True)
                    want_words = False
                    segments, info = _transcribe(file_path, False)
                else:
                    raise
            text = ""
            words = []
            word_probs = []
            logprob_sum = 0.0
            logprob_n = 0
            no_speech_min = None
            # Pure faster-whisper for every language (zh/yue included).
            for segment in segments:
                text += segment.text
                alp = getattr(segment, "avg_logprob", None)
                if isinstance(alp, (int, float)):
                    logprob_sum += alp
                    logprob_n += 1
                nsp = getattr(segment, "no_speech_prob", None)
                if isinstance(nsp, (int, float)):
                    no_speech_min = nsp if no_speech_min is None else min(no_speech_min, nsp)
                seg_words = getattr(segment, "words", None) or []
                for w in seg_words:
                    wt = getattr(w, "word", "")
                    wp = getattr(w, "probability", None)
                    if wp is None:
                        continue
                    words.append({"w": wt, "p": round(float(wp), 4)})
                    word_probs.append(float(wp))

            lang = (info.language or "").lower()
            if force_simplified and lang in _SIMPLIFY_LANGS:
                text = _to_simplified(text)
                for wd in words:
                    wd["w"] = _to_simplified(wd["w"])

            avg_logprob = (logprob_sum / logprob_n) if logprob_n else None
            confidence = _segment_confidence(avg_logprob, no_speech_min, word_probs)
            conf_map[file_name] = {
                "confidence": confidence,
                "no_speech_prob": round(no_speech_min, 4) if isinstance(no_speech_min, (int, float)) else None,
                "words": words,
            }

            output.append(f"{file_path}|{output_file_name}|{info.language.upper()}|{text}")
        except Exception as e:
            print(f"  Error: {file_name}: {e}", flush=True)

    os.makedirs(output_folder, exist_ok=True)
    output_file_path = os.path.join(output_folder, f"{output_file_name}.list")
    with open(output_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output))
    # 置信度旁车：<name>.conf.json，与 .list 同目录、同名不同扩展。
    try:
        conf_path = os.path.join(output_folder, f"{output_file_name}.conf.json")
        with open(conf_path, "w", encoding="utf-8") as cf:
            json.dump(conf_map, cf, ensure_ascii=False)
        print(f"ASR confidence -> {conf_path}", flush=True)
    except Exception as e:
        print(f"  Warn: failed to write confidence sidecar: {e}", flush=True)
    print(f"ASR done -> {output_file_path}", flush=True)
    return output_file_path


load_cudnn()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input_folder", type=str, required=True)
    parser.add_argument("-o", "--output_folder", type=str, required=True)
    parser.add_argument("-s", "--model_size", type=str, default="large-v3",
                        choices=get_asr_models() + ["large"])  # "large" 兼容别名 -> 下方归一化为 large-v3
    parser.add_argument("-l", "--language", type=str, default="ja",
                        choices=language_code_list)
    parser.add_argument("-p", "--precision", type=str, default="float16",
                        choices=["float16", "float32", "int8"])
    parser.add_argument("--model_dir", type=str, default=None,
                        help="faster-whisper weights root; weights are read from "
                             "<dir>/<model_size>. Default: models/asr/faster-whisper "
                             "(override with FASTER_WHISPER_DIR).")
    parser.add_argument("-b", "--batch_size", type=int, default=8)
    parser.add_argument("--beam_size", type=int, default=1)
    # Patch #22：强制简体中文（默认开）。--no-force-simplified 可关闭。
    parser.add_argument("--force-simplified", dest="force_simplified",
                        action="store_true", default=True,
                        help="Convert zh/yue output to Simplified Chinese (default on)")
    parser.add_argument("--no-force-simplified", dest="force_simplified",
                        action="store_false",
                        help="Keep faster-whisper's raw zh output (may mix traditional)")

    cmd = parser.parse_args()
    model_size = cmd.model_size
    if model_size == "large":
        model_size = "large-v3"

    # 模型路径。只有一条计算方式，见 _get_model_path()。
    #
    # 这里原本自己拼 "faster-whisper-<size>"，而 _get_model_path() 拼的是
    # "<size>" —— 同一个脚本里两套算法，取决于有没有传 --model_dir。调用方传了
    # 目录，脚本却在它下面找一个多带前缀的子目录，找不到就静默重下，于是硬盘上
    # 出现了两份 large-v3，各 2.9 GB。这个失败模式在本项目已经发生三次
    # （large-v3、FunASR、以及此处），成因每次都一样：同一个事实有两处实现。
    asr_models_dir = cmd.model_dir or _faster_whisper_dir()
    model_path = _get_model_path(model_size, asr_models_dir)

    execute_asr(
        input_folder=cmd.input_folder,
        output_folder=cmd.output_folder,
        model_path=model_path,
        language=cmd.language,
        precision=cmd.precision,
        batch_size=cmd.batch_size,
        beam_size=cmd.beam_size,
        force_simplified=cmd.force_simplified,
    )
