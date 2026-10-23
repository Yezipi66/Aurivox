# -*- coding:utf-8 -*-
"""FunASR 中文与粤语语音识别：把一个目录的音频转成转写清单与置信度旁车。

输出两个文件：<目录名>.list，每行「音频路径|来源目录|语种|文本」；
<目录名>.conf.json，键是片段文件名，值是 {confidence, no_speech_prob, words}，
schema 与 faster-whisper 那条管线一致，前端校对面板因此能逐词着色。

FunASR 与 Paraformer 是非自回归 CIF 模型，默认不暴露稳定的逐词后验概率。
所以只有返回值里真的带分数字段时才填置信度，否则写 confidence: null，
前端据此不着色：不编造数值，假的「高置信度」比没有更糟。
"""
import argparse
import json
import math
import os
import sys
import traceback

from funasr import AutoModel
from modelscope import snapshot_download
from tqdm import tqdm

# FunASR 权重目录。首选 FUNASR_MODELS_DIR（由 lib/paths.js 经 getCleanEnv 下发）；
# 未设置时一路上溯找 package.json 定位项目根，不按目录层数倒推：层数会随搬迁
# 失准，且不会报错。
def _funasr_models_dir() -> str:
    d = os.environ.get("FUNASR_MODELS_DIR")
    if d:
        return d
    d = os.path.dirname(os.path.abspath(__file__))
    while not os.path.isfile(os.path.join(d, "package.json")):
        parent = os.path.dirname(d)
        if parent == d:
            raise RuntimeError("project root (package.json) not found above " + __file__)
        d = parent
    return os.path.join(d, "models", "asr", "funasr")


MODELS_DIR = _funasr_models_dir()

_funasr_models = {}


def _download_model(model_id: str, local_name: str) -> str:
    """把模型下载到 MODELS_DIR 下的 local_name 目录，已存在则直接复用。

    :param model_id: ModelScope 上的模型 id
    :param local_name: 本地目录名
    :returns: 本地目录路径
    """
    local_path = os.path.join(MODELS_DIR, local_name)
    if not os.path.exists(local_path):
        # 权重不在预期位置时会从 ModelScope 重新下载一份（数 GB），过程是静默的：
        # 不报错，只是慢，事后硬盘上多出一整份。所以下载前先把期望路径打印出来。
        print(
            f"[FunASR] weights not found at {local_path}; downloading {model_id} "
            f"(this can take a while). Set FUNASR_MODELS_DIR if they live elsewhere.",
            flush=True,
        )
        os.makedirs(MODELS_DIR, exist_ok=True)
        snapshot_download(model_id, local_dir=local_path)
    return local_path


def create_model(language="zh"):
    """创建 FunASR 模型并按语种缓存。zh 用 Paraformer 加 VAD 加标点，yue 用
    UniASR，其余语种抛 ValueError。

    :param language: 语种，zh 或 yue
    :returns: AutoModel 实例
    """
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


# FunASR 置信度提取。各版本与各模型返回的字段并不统一，默认不含分数，
# 所以逐个候选字段探测：只有真的带有可解释为概率的分数时才采用，
# 否则返回 (None, [])。
_SCALAR_SCORE_KEYS = ("confidence", "score", "avg_score", "am_score")
_LIST_SCORE_KEYS = ("scores", "token_score", "token_scores", "char_scores", "am_scores")
# 中文与粤语按「字」切词（paraformer 对 zh 不输出空格），其余语言按空白切词。
_CJK_LANGS = {"zh", "yue"}


def _coerce_prob(v):
    """把一个原始分数折算到 [0,1]。

    已在 [0,1] 的原样保留；负值视作对数概率，取指数；大于 1 的值无法可靠
    解释，返回 None。

    :param v: 原始分数
    :returns: [0,1] 内的概率，或 None
    """
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if 0.0 <= x <= 1.0:
        return round(x, 4)
    if x <= 0.0:
        try:
            return round(max(0.0, min(1.0, math.exp(x))), 4)
        except OverflowError:
            return None
    return None


def _tokenize_text(text, language):
    """按语言把识别文本切成用于逐词着色的 token 列表。

    中文与粤语逐个非空白字符切分，其余语言按空白切分；空文本返回空列表。

    :param text: 识别文本
    :param language: 语种
    :returns: token 列表
    """
    if not text:
        return []
    if str(language).lower() in _CJK_LANGS:
        # 中文与粤语逐个非空白字符切分，标点也保留，便于与原文对齐校对。
        return [ch for ch in text if not ch.isspace()]
    return [w for w in text.split() if w]


def _extract_confidence(res, text, language):
    """从 FunASR 单条结果 dict 里提取置信度。

    :param res: FunASR 返回的单条结果
    :param text: 对应的识别文本
    :param language: 语种
    :returns: (confidence, words)；confidence 为 None 且 words 为空表示没有可用分数
    """
    if not isinstance(res, dict):
        return None, []

    # 1) 逐 token 分数数组：数组长度与文本 token 数一致时，给出逐词置信度。
    for key in _LIST_SCORE_KEYS:
        arr = res.get(key)
        if isinstance(arr, (list, tuple)) and arr and all(
            isinstance(x, (int, float)) for x in arr
        ):
            toks = _tokenize_text(text, language)
            probs = [_coerce_prob(x) for x in arr]
            probs = [p for p in probs if p is not None]
            if not probs:
                continue
            words = []
            if toks and len(toks) == len(arr):
                for tk, p in zip(toks, [_coerce_prob(x) for x in arr]):
                    if p is not None:
                        words.append({"w": tk, "p": p})
            conf = round(sum(probs) / len(probs), 4)
            return conf, words

    # 2) 标量分数：只给整行置信度，没有逐词着色。
    for key in _SCALAR_SCORE_KEYS:
        if key in res:
            p = _coerce_prob(res.get(key))
            if p is not None:
                return p, []

    return None, []


def execute_asr(input_folder, output_folder, language):
    """对输入目录里的每个音频做识别，写出转写清单与置信度旁车。

    :param input_folder: 输入音频目录
    :param output_folder: 输出目录，.list 与 .conf.json 都写在这里
    :param language: 语种，zh 或 yue；auto 会被 create_model 拒绝
    :returns: 写出的 .list 文件路径
    """
    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)

    model = create_model(language)

    # 置信度旁车（键=片段文件名，schema 与 faster-whisper 完全一致）。
    conf_map = {}
    have_any_conf = False

    for file_name in tqdm(input_file_names):
        try:
            file_path = os.path.join(input_folder, file_name)
            res = model.generate(input=file_path)[0]
            text = res.get("text", "") if isinstance(res, dict) else str(res)
            output.append(f"{file_path}|{output_file_name}|{language.upper()}|{text}")

            confidence, words = _extract_confidence(res, text, language)
            if confidence is not None or words:
                have_any_conf = True
            conf_map[file_name] = {
                "confidence": confidence,
                "no_speech_prob": None,
                "words": words,
            }
        except Exception:
            print(traceback.format_exc())

    os.makedirs(output_folder, exist_ok=True)
    output_file_path = os.path.join(output_folder, f"{output_file_name}.list")
    with open(output_file_path, "w", encoding="utf-8") as f:
        f.write("\n".join(output))

    # 置信度旁车：<name>.conf.json，与 .list 同目录、同名不同扩展。
    try:
        conf_path = os.path.join(output_folder, f"{output_file_name}.conf.json")
        with open(conf_path, "w", encoding="utf-8") as cf:
            json.dump(conf_map, cf, ensure_ascii=False)
        if have_any_conf:
            print(f"ASR confidence -> {conf_path}", flush=True)
        else:
            # 明确说明：本次返回没有可用的分数字段，旁车里的 confidence 都是 null，
            # 前端据此不着色。
            print(
                "ASR confidence: FunASR returned no usable score fields; "
                f"sidecar written with null confidence -> {conf_path}",
                flush=True,
            )
    except Exception as e:
        print(f"  Warn: failed to write confidence sidecar: {e}", flush=True)

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
