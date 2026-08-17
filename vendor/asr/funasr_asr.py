# -*- coding:utf-8 -*-
"""
FunASR 中文/粤语 ASR — 从 GPT-SoVITS 项目解耦
模型下载到项目内的 gsv-tools/asr/models/ 目录

置信度（Patch #26，对齐 faster-whisper 管线）
-------------------------------------------------
faster-whisper 会在输出目录写一个 `<name>.conf.json` 旁车（sidecar），
schema 为 `{ 片段文件名: {confidence, no_speech_prob?, words:[{w,p}]} }`，
供前端校对面板做逐词/逐行置信度着色。FunASR 之前不产出该旁车，导致选用
FunASR 引擎时校对面板没有置信度提示，两条引擎的体验不一致。

这里补齐：FunASR 也写同名同 schema 的旁车。诚实原则——
FunASR/Paraformer 是非自回归 CIF 模型，默认并不像 whisper 那样暴露稳定的
逐词后验概率。故本实现只在 FunASR 的返回里**真的**带有分数字段时才填充置信度，
否则写 `confidence: null`（前端据此不着色），**绝不编造数值**——因为这是训练前
的 GIGO 质量门，假的“高置信度”会误导校对、比没有更糟。
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


# ── Patch #26：FunASR 置信度提取 ─────────────────────────────────────────
# FunASR 各版本/各模型返回的字段并不统一，且默认多半不含分数。这里做**防御式**
# 探测：只有当返回里真的带有可解释为概率的分数时才采用，否则返回 (None, [])。
_SCALAR_SCORE_KEYS = ("confidence", "score", "avg_score", "am_score")
_LIST_SCORE_KEYS = ("scores", "token_score", "token_scores", "char_scores", "am_scores")
# 中文/粤语按“字”切词（paraformer 对 zh 不输出空格）；其余语言按空白切词。
_CJK_LANGS = {"zh", "yue"}


def _coerce_prob(v):
    """把一个原始分数折算到 [0,1]。
    - 已在 [0,1] → 原样（钳制）。
    - <=0 视作 logprob → exp()。
    - 其他区间无法可靠解释 → None（不编造）。"""
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
    """按语言把识别文本切成用于逐词着色的 token 列表。"""
    if not text:
        return []
    if str(language).lower() in _CJK_LANGS:
        # 逐“非空白字符”，跳过标点后仍保留标点便于对齐（校对可读）。
        return [ch for ch in text if not ch.isspace()]
    return [w for w in text.split() if w]


def _extract_confidence(res, text, language):
    """从 FunASR 单条结果 dict 里尽力提取置信度。
    返回 (confidence: float|None, words: list[{w,p}])。
    只有 res 真带分数才非空；否则 (None, [])。"""
    if not isinstance(res, dict):
        return None, []

    # 1) 逐 token 分数数组：与文本 token 数对齐时 → 真·逐词置信度。
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

    # 2) 标量分数 → 整行置信度（无逐词着色）。
    for key in _SCALAR_SCORE_KEYS:
        if key in res:
            p = _coerce_prob(res.get(key))
            if p is not None:
                return p, []

    return None, []


def execute_asr(input_folder, output_folder, language):
    input_file_names = sorted(os.listdir(input_folder))
    output = []
    output_file_name = os.path.basename(input_folder)

    model = create_model(language)

    # Patch #26：置信度旁车（键=片段文件名，schema 与 faster-whisper 完全一致）。
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
            # 诚实告知：本次 FunASR 返回未携带可用分数，旁车里 confidence 均为 null，
            # 前端不会着色（不编造置信度）。
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
