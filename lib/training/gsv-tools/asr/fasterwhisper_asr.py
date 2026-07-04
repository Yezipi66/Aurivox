"""
Faster Whisper ASR — 从 GPT-SoVITS 项目解耦
移除 tools.* 依赖，改为使用项目内的 asr_utils
"""
import argparse
import os
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
                 ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]]
        print(f"Downloading from ModelScope: {repo_id} -> {model_dir}")
        snapshot_download_ms(
            repo_id, local_dir=model_dir,
            allow_patterns=files,
        )


def _get_model_path(model_size: str, asr_models_dir: str) -> str:
    """获取模型路径，如果不存在则下载"""
    model_dir = os.path.join(asr_models_dir, f"faster-whisper-{model_size}")
    if not os.path.exists(model_dir):
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
                batch_size=8, beam_size=1):
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

    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)

    for file_name in tqdm(input_file_names):
        try:
            file_path = os.path.join(input_folder, file_name)
            # 片段已是 VAD 切好的短音频：关闭冗余 vad_filter；beam_size=1 贪心
            if use_batched:
                segments, info = asr_engine.transcribe(
                    audio=file_path, beam_size=beam_size,
                    vad_filter=False, language=language,
                    batch_size=batch_size,
                )
            else:
                segments, info = asr_engine.transcribe(
                    audio=file_path, beam_size=beam_size,
                    vad_filter=False, language=language,
                )
            text = ""
            # Pure faster-whisper for every language (zh/yue included).
            for segment in segments:
                text += segment.text
            output.append(f"{file_path}|{output_file_name}|{info.language.upper()}|{text}")
        except Exception as e:
            print(f"  Error: {file_name}: {e}", flush=True)

    os.makedirs(output_folder, exist_ok=True)
    output_file_path = os.path.join(output_folder, f"{output_file_name}.list")
    with open(output_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output))
    print(f"ASR done -> {output_file_path}", flush=True)
    return output_file_path


load_cudnn()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input_folder", type=str, required=True)
    parser.add_argument("-o", "--output_folder", type=str, required=True)
    parser.add_argument("-s", "--model_size", type=str, default="large-v3",
                        choices=get_asr_models())
    parser.add_argument("-l", "--language", type=str, default="ja",
                        choices=language_code_list)
    parser.add_argument("-p", "--precision", type=str, default="float16",
                        choices=["float16", "float32", "int8"])
    parser.add_argument("--model_dir", type=str, default=None,
                        help="Models directory (default: gsv-tools/asr/models)")
    parser.add_argument("-b", "--batch_size", type=int, default=8)
    parser.add_argument("--beam_size", type=int, default=1)

    cmd = parser.parse_args()
    model_size = cmd.model_size
    if model_size == "large":
        model_size = "large-v3"

    # 模型路径
    if cmd.model_dir:
        model_path = os.path.join(cmd.model_dir, f"faster-whisper-{model_size}")
    else:
        asr_models_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "asr", "models")
        model_path = _get_model_path(model_size, asr_models_dir)

    execute_asr(
        input_folder=cmd.input_folder,
        output_folder=cmd.output_folder,
        model_path=model_path,
        language=cmd.language,
        precision=cmd.precision,
        batch_size=cmd.batch_size,
        beam_size=cmd.beam_size,
    )
