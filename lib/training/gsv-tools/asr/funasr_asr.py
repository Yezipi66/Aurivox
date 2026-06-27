# -*- coding:utf-8 -*-
"""
FunASR 中文/粤语 ASR — 从 GPT-SoVITS 项目解耦
模型下载到项目内的 gsv-tools/asr/models/ 目录
"""
import argparse
import os
import sys
import traceback

from funasr import AutoModel
from modelscope import snapshot_download
from tqdm import tqdm

# 项目内的模型目录：与脚本同级的 models/ → gsv-tools/asr/models
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

# 模型缓存
_funasr_models = {}


def _download_model(model_id: str, local_name: str) -> str:
    """下载模型到项目内的 models/ 目录"""
    local_path = os.path.join(MODELS_DIR, local_name)
    if not os.path.exists(local_path):
        os.makedirs(MODELS_DIR, exist_ok=True)
        print(f"Downloading: {model_id} -> {local_path}")
        snapshot_download(model_id, local_dir=local_path)
    return local_path


def create_model(language="zh"):
    """创建 FunASR 模型（带缓存）"""
    if language in _funasr_models:
        return _funasr_models[language]

    if language == "zh":
        path_asr = _download_model(
            "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        )
        path_vad = _download_model(
            "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "speech_fsmn_vad_zh-cn-16k-common-pytorch",
        )
        path_punc = _download_model(
            "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
            "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        )
        model = AutoModel(
            model=path_asr, model_revision="v2.0.4",
            vad_model=path_vad, vad_model_revision="v2.0.4",
            punc_model=path_punc, punc_model_revision="v2.0.4",
        )
    elif language == "yue":
        path_asr = _download_model(
            "iic/speech_UniASR_asr_2pass-cantonese-CHS-16k-common-vocab1468-tensorflow1-online",
            "speech_UniASR_asr_2pass-cantonese-CHS-16k-common-vocab1468-tensorflow1-online",
        )
        model = AutoModel(
            model=path_asr, model_revision="master",
        )
    else:
        raise ValueError(f"Language {language} not supported by FunASR")

    print(f"FunASR model loaded: {language.upper()}")
    _funasr_models[language] = model
    return model


def execute_asr(input_folder, output_folder, language):
    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)

    model = create_model(language)

    for file_name in tqdm(input_file_names):
        try:
            file_path = os.path.join(input_folder, file_name)
            text = model.generate(input=file_path)[0]["text"]
            output.append(f"{file_path}|{output_file_name}|{language.upper()}|{text}")
        except Exception:
            print(traceback.format_exc())

    os.makedirs(output_folder, exist_ok=True)
    output_file_path = os.path.join(output_folder, f"{output_file_name}.list")
    with open(output_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output))
    print(f"ASR done -> {output_file_path}")
    return output_file_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-i", "--input_folder", type=str, required=True)
    parser.add_argument("-o", "--output_folder", type=str, required=True)
    parser.add_argument("-l", "--language", type=str, default="zh",
                        choices=["zh", "yue", "auto"])
    cmd = parser.parse_args()
    execute_asr(cmd.input_folder, cmd.output_folder, cmd.language)
