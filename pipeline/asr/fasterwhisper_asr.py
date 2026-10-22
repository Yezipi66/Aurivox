"""faster-whisper 语音识别：把一个目录的音频转成转写清单与置信度旁车。

输出两个文件：<目录名>.list，每行「音频路径|来源目录|语种|文本」；
<目录名>.conf.json，键是片段文件名，值是 {confidence, no_speech_prob, words}，
供前端校对面板做逐词着色。
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

# 项目内工具在 asr 包里，import 前把包的父目录放进 sys.path。
# 要的是包的父目录，不是项目根：本文件就在 asr/ 包内，「自己目录的父目录」
# 是自指的，跟着 asr/ 一起搬不会失准。
# 但它仍是一次层数推导，所以补一条存在性断言：本文件被挪出 asr/ 包时立刻报错，
# 而不是 import 到别处的同名模块。
_PKG_PARENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.exists(os.path.join(_PKG_PARENT, "asr", "asr_utils.py")):
    raise RuntimeError(
        "asr/asr_utils.py not found under %r: fasterwhisper_asr.py must stay "
        "inside the 'asr' package directory. Do not derive this path by "
        "counting directory levels (engine contract C7)." % _PKG_PARENT)
sys.path.insert(0, _PKG_PARENT)
from asr.asr_utils import load_cudnn, get_asr_models

# FunASR 与 DAMO 的中文后处理已停用：在 Windows 上它对 zh/yue 反复挂起或崩溃。
# 所有语种一律只用 faster-whisper。
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

_funasr_models = {}

# 繁简转换（简体中文强制）。产品只面向简体中文，不支持繁体；faster-whisper 对
# zh/yue 可能混吐简/繁，所以在 ASR 源头统一转简体，下游（.list / segments /
# 推理 / 前端）拿到的文本才一致。转换器优先级：OpenCC(t2s) → zhconv(zh-hans)
# → 原样透传并告警，不因转换失败让 ASR 中断。
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


# 繁简转换只作用于中文族语言：日文汉字的简化规则不同，ja 一律不动。
_SIMPLIFY_LANGS = {"zh", "yue"}


def _segment_confidence(avg_logprob, no_speech_prob, word_probs):
    """把 whisper 的对数概率折算成 [0,1] 置信度。

    优先用 word-level 概率均值；否则用 exp(avg_logprob)；再按 no_speech_prob 惩罚。
    没有可用概率时返回 None。

    :param avg_logprob: 片段的平均对数概率
    :param no_speech_prob: 片段的无语音概率
    :param word_probs: 逐词概率列表
    :returns: [0,1] 内的置信度，没有可用概率时为 None
    """
    base = None
    if word_probs:
        base = sum(word_probs) / len(word_probs)
    elif avg_logprob is not None:
        try:
            base = math.exp(avg_logprob)  # logprob 不大于 0 ⇒ 结果落在 (0, 1]
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

    首选 FASTER_WHISPER_DIR（由 lib/paths.js 经 getCleanEnv 下发）；未设置时
    一路上溯找 package.json 定位项目根，不按目录层数倒推：层数会随搬迁失准，
    且不会报错。

    :returns: 权重根目录；找不到项目根时抛 RuntimeError
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
    """把权重下载到指定目录。

    先探测 HuggingFace 是否可达，不可达时改用 ModelScope。

    :param model_size: 权重规格，例如 large-v3
    :param model_dir: 权重目录
    """
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
        # ModelScope 仓库把权重放在 faster-whisper-<size>/ 前缀下。直接下到
        # model_dir 会落成 model_dir/faster-whisper-<size>/（双层嵌套，ASR 找不到
        # model.bin），所以下到 model_dir 的父目录，让该前缀正好落成 model_dir。
        parent = os.path.dirname(os.path.abspath(model_dir)) or "."
        print(f"Downloading from ModelScope: {repo_id} -> {parent}")
        snapshot_download_ms(
            repo_id, local_dir=parent,
            allow_patterns=files,
        )

    # 兜底：权重若落在 model_dir/faster-whisper-<size>/ 里，把这层内容上移，
    # 保证 model.bin 直接位于 model_dir 根下。
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
    有目录、没权重的空壳，那时「目录存在」是真的，「权重可用」是假的。

    :param model_size: 权重规格，例如 large-v3
    :param asr_models_dir: 权重根目录
    :returns: 权重目录；权重缺失时先下载再返回
    """
    model_dir = os.path.join(asr_models_dir, model_size)
    if not os.path.exists(os.path.join(model_dir, "model.bin")):
        # 权重缺失时重新下载是静默的：不报错，只是很慢，硬盘上多出一份。
        # 所以下载前先把期望路径打印出来。
        print(
            f"[faster-whisper] weights not found at {model_dir}; downloading {model_size}. "
            f"Set FASTER_WHISPER_DIR if they live elsewhere.",
            flush=True,
        )
        os.makedirs(asr_models_dir, exist_ok=True)
        _download_model(model_size, model_dir)
    return model_dir


def _funasr_only_asr(input_file: str, language: str) -> str:
    """FunASR 中文后处理。HAS_FUNASR 为假时直接返回空串。"""
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
    """对输入目录里的每个音频做识别，写出转写清单与置信度旁车。

    :param input_folder: 输入音频目录
    :param output_folder: 输出目录，.list 与 .conf.json 都写在这里
    :param model_path: faster-whisper 权重目录
    :param language: 语种，auto 表示交给模型自行判断
    :param precision: 计算精度，例如 float16
    :param batch_size: 批量推理的批大小，小于 1 时不用批量管线
    :param beam_size: beam 搜索宽度
    :param force_simplified: 是否把 zh/yue 的输出统一转成简体中文
    :returns: 写出的 .list 文件路径
    """
    if language == "auto":
        language = None
    print(f"Loading model: {model_path}", flush=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = WhisperModel(model_path, device=device, compute_type=precision)

    # 批量推理管线：faster-whisper 版本支持、在 CUDA 上、batch_size 大于 1 时用它，
    # 否则用普通 model。
    use_batched = HAS_BATCHED and device == "cuda" and batch_size > 1
    asr_engine = BatchedInferencePipeline(model=model) if use_batched else model
    if use_batched:
        print(f"Using BatchedInferencePipeline, batch_size={batch_size}", flush=True)
    if force_simplified:
        _get_t2s()  # 预热转换器，并在日志里体现转换器是否可用

    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)
    # 置信度旁车：键是片段文件名（basename）。不写进 .list，那份清单是 4 列，
    # 文本在第 4 列，多一列会并进文本里。
    conf_map = {}

    def _transcribe(fp, want_words):
        # 输入片段是流水线切片出的短音频：关掉冗余的 vad_filter。beam_size 默认 1，
        # 即贪心解码。
        kw = dict(audio=fp, beam_size=beam_size, vad_filter=False, language=language)
        if use_batched:
            kw["batch_size"] = batch_size
        if want_words:
            kw["word_timestamps"] = True
        return asr_engine.transcribe(**kw)

    # 部分 BatchedInferencePipeline 版本不支持 word_timestamps：探测一次，失败就整轮
    # 降级为 segment 级置信度，不因可选特性丢文本。
    want_words = True

    for file_name in tqdm(input_file_names):
        try:
            file_path = os.path.join(input_folder, file_name)
            # 打开 word_timestamps 才能拿到逐词概率，供置信度着色使用。
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
            # 所有语种（含 zh/yue）一律走 faster-whisper。
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
                        choices=get_asr_models() + ["large"])  # "large" 是兼容别名，下面统一归一化为 large-v3
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
    # 强制简体中文（默认开）。--no-force-simplified 可关闭。
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

    # 模型路径只有一种算法，在 _get_model_path() 里：权重目录是 <权重根>/<model_size>，
    # 不带 "faster-whisper-" 前缀（那个前缀只属于 HuggingFace / ModelScope 的仓库名）。
    # 两处各算一套的后果是静默的：脚本在调用方给的目录下找一个多带前缀的子目录，
    # 找不到就重新下载一份同一份权重。
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
