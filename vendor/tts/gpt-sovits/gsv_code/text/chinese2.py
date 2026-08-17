import os
import re

import cn2an
from pypinyin import lazy_pinyin, Style
from pypinyin.contrib.tone_convert import to_finals_tone3, to_initials

from gsv_code.text.symbols import punctuation
from gsv_code.text.tone_sandhi import ToneSandhi
from gsv_code.text.zh_normalization.text_normlization import TextNormalizer

normalizer = lambda x: cn2an.transform(x, "an2cn")

current_file_path = os.path.dirname(__file__)


def _find_project_root(start):
    """自 start 向上寻找含 server.js 的目录，即项目根。

    与 lib/paths.js 的 detectAppDir 保持同一判定依据。上溯到文件系统根仍未
    找到时才退回本目录自身，此时调用方会得到一个不存在的权重路径并显式报错，
    好过按目录层数推导——本文件已随目录调整搬过一次，写死的层数会在搬迁后
    静默指向错误位置。
    """
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "server.js")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return os.path.abspath(start)
        d = parent
pinyin_to_symbol_map = {
    line.split("\t")[0]: line.strip().split("\t")[1]
    for line in open(os.path.join(current_file_path, "opencpop-strict.txt")).readlines()
}

import jieba_fast
import logging

jieba_fast.setLogLevel(logging.CRITICAL)
import jieba_fast.posseg as psg

# is_g2pw_str = os.environ.get("is_g2pw", "True")##默认开启
# is_g2pw = False#True if is_g2pw_str.lower() == 'true' else False
is_g2pw = True  # True if is_g2pw_str.lower() == 'true' else False
# g2pW (ONNX polyphone disambiguation) is OPTIONAL and is frequently absent on
# Windows installs: the g2pw folder ships only an (empty) G2PWModel/ placeholder,
# so `from gsv_code.text.g2pw import G2PWPinyin` fails ("cannot import name
# G2PWPinyin ... unknown location"). That import failure made EVERY Chinese line
# fail phoneme conversion, leaving the training set empty ("phoneme has 0 rows").
# Do the real import defensively and degrade to the pypinyin path (already
# implemented below) so Chinese fine-tune still works without g2pW.
if is_g2pw:
    try:
        from gsv_code.text.g2pw import G2PWPinyin, correct_pronunciation
    except Exception as _g2pw_err:
        print(f"[chinese2] g2pW unavailable ({_g2pw_err!r}); using pypinyin fallback for Chinese.")
        is_g2pw = False
if is_g2pw:
    # print("当前使用g2pw进行拼音推理")
    parent_directory = os.path.dirname(current_file_path)
    # 优先从环境变量 bert_path 读取，其次用项目内的默认路径。
    # 项目根 = 自本目录向上第一个含 server.js 的目录，与 lib/paths.js 的判定一致。
    # 不数目录层数：本目录若再次搬迁，数层数会静默指向错误位置而不报错。
    project_root = _find_project_root(current_file_path)

    # 权重统一存放在项目根的 models/ 下。环境变量由 lib/training/python_helper.js
    # 的 getCleanEnv() 注入；直接手工运行本脚本时，用下面的默认路径。
    def _models_dir(*parts):
        return os.path.join(project_root, "models", "tts", "gpt-sovits", *parts)

    # bert_path 是上游约定的环境变量名，保持原样以免破坏既有用法。
    bert_path = (
        os.environ.get("bert_path")
        or os.environ.get("GSV_BERT_DIR")
        or _models_dir("chinese-roberta-wwm-ext-large")
    )

    # G2PWModel 目录。原先会在"自包含目录"与项目根 GPT_SoVITS/text/ 之间挑一个
    # 含 g2pW.onnx 的，那是历史上同一份 600 MB 权重被放两处的产物；两处都已并入
    # models/，兜底分支随之删除 —— 留着它只会在权重缺失时悄悄指向一个已被删掉的
    # 目录，然后退化成 pypinyin，读音变差而不报错。
    g2pw_model_dir = (
        os.environ.get("g2pw_model_dir")
        or os.environ.get("G2PW_DIR")
        or _models_dir("G2PWModel")
    )

    try:
        g2pw = G2PWPinyin(
            model_dir=g2pw_model_dir,
            model_source=bert_path,
            v_to_u=False,
            neutral_tone_with_five=True,
        )
    except Exception as _g2pw_err:
        # 不抛出：中文仍能用 pypinyin 念出来，只是多音字准确率下降。但必须把
        # 查找过的两个绝对路径打出来，否则"读音变差"这种症状无从追查。
        print(
            f"[chinese2] g2pW model load failed ({_g2pw_err!r}); "
            f"falling back to pypinyin, polyphone accuracy will drop.\n"
            f"[chinese2]   g2pw model dir : {g2pw_model_dir}\n"
            f"[chinese2]   bert model dir : {bert_path}\n"
            f"[chinese2]   override with env g2pw_model_dir / bert_path"
        )
        is_g2pw = False

rep_map = {
    "：": ",",
    "；": ",",
    "，": ",",
    "。": ".",
    "！": "!",
    "？": "?",
    "\n": ".",
    "·": ",",
    "、": ",",
    "...": "…",
    "$": ".",
    "/": ",",
    "—": "-",
    "~": "…",
    "～": "…",
}

tone_modifier = ToneSandhi()

# 读音校对层（task6）：词粒度多音字修正；模块缺失或异常时降级为 no-op，保证零回归。
try:
    from gsv_code.text import pron_correction as _pron
except Exception as _pron_err:  # pragma: no cover
    print(f"[chinese2] pron_correction unavailable ({_pron_err!r}); pronunciation override disabled.")
    _pron = None


def replace_punctuation(text):
    text = text.replace("嗯", "恩").replace("呣", "母")
    pattern = re.compile("|".join(re.escape(p) for p in rep_map.keys()))

    replaced_text = pattern.sub(lambda x: rep_map[x.group()], text)

    replaced_text = re.sub(r"[^\u4e00-\u9fa5" + "".join(punctuation) + r"]+", "", replaced_text)

    return replaced_text


def g2p(text):
    pattern = r"(?<=[{0}])\s*".format("".join(punctuation))
    sentences = [i for i in re.split(pattern, text) if i.strip() != ""]
    phones, word2ph = _g2p(sentences)
    return phones, word2ph


def get_word_pinyins(text):
    """预览/校对用：返回 (norm_text, [(word, [pinyin,...]), ...])。

    复刻 _g2p 的逐词拼音推导（g2pW 整句推理 + correct_pronunciation + 读音覆盖层），
    停在 opencpop 符号映射之前，保证「预览读音 == 实际合成读音」。
    非 g2pw 回退时用 pypinyin TONE3。标点/英文段不计入 token。
    """
    norm_text = text_normalize(text)
    pattern = r"(?<=[{0}])\s*".format("".join(punctuation))
    segments = [i for i in re.split(pattern, norm_text) if i.strip() != ""]
    processed = [re.sub("[a-zA-Z]+", "", seg) for seg in segments]

    g2pw_batch = []
    cursor = 0
    if is_g2pw:
        batch_inputs = [seg for seg in processed if seg]
        g2pw_batch = g2pw._g2pw(batch_inputs) if batch_inputs else []

    out = []
    for seg in processed:
        seg_cut = tone_modifier.pre_merge_for_modify(psg.lcut(seg))
        pinyins = []
        if is_g2pw and seg:
            pinyins = g2pw_batch[cursor]
            cursor += 1
        pre_word_length = 0
        for word, pos in seg_cut:
            now_word_length = pre_word_length + len(word)
            if pos == "eng":
                pre_word_length = now_word_length
                continue
            if is_g2pw:
                word_pinyins = correct_pronunciation(word, pinyins[pre_word_length:now_word_length])
            else:
                word_pinyins = lazy_pinyin(word, neutral_tone_with_five=True, style=Style.TONE3)
            if _pron is not None:
                word_pinyins = _pron.apply(word, word_pinyins, position=pre_word_length)
            out.append((word, list(word_pinyins)))
            pre_word_length = now_word_length
    return norm_text, out


def _get_initials_finals(word):
    initials = []
    finals = []

    orig_initials = lazy_pinyin(word, neutral_tone_with_five=True, style=Style.INITIALS)
    orig_finals = lazy_pinyin(word, neutral_tone_with_five=True, style=Style.FINALS_TONE3)

    for c, v in zip(orig_initials, orig_finals):
        initials.append(c)
        finals.append(v)
    return initials, finals


must_erhua = {"小院儿", "胡同儿", "范儿", "老汉儿", "撒欢儿", "寻老礼儿", "妥妥儿", "媳妇儿"}
not_erhua = {
    "虐儿",
    "为儿",
    "护儿",
    "瞒儿",
    "救儿",
    "替儿",
    "有儿",
    "一儿",
    "我儿",
    "俺儿",
    "妻儿",
    "拐儿",
    "聋儿",
    "乞儿",
    "患儿",
    "幼儿",
    "孤儿",
    "婴儿",
    "婴幼儿",
    "连体儿",
    "脑瘫儿",
    "流浪儿",
    "体弱儿",
    "混血儿",
    "蜜雪儿",
    "舫儿",
    "祖儿",
    "美儿",
    "应采儿",
    "可儿",
    "侄儿",
    "孙儿",
    "侄孙儿",
    "女儿",
    "男儿",
    "红孩儿",
    "花儿",
    "虫儿",
    "马儿",
    "鸟儿",
    "猪儿",
    "猫儿",
    "狗儿",
    "少儿",
}


def _merge_erhua(initials: list[str], finals: list[str], word: str, pos: str) -> list[list[str]]:
    """
    Do erhub.
    """
    # fix er1
    for i, phn in enumerate(finals):
        if i == len(finals) - 1 and word[i] == "儿" and phn == "er1":
            finals[i] = "er2"

    # 发音
    if word not in must_erhua and (word in not_erhua or pos in {"a", "j", "nr"}):
        return initials, finals

    # "……" 等情况直接返回
    if len(finals) != len(word):
        return initials, finals

    assert len(finals) == len(word)

    # 与前一个字发同音
    new_initials = []
    new_finals = []
    for i, phn in enumerate(finals):
        if (
            i == len(finals) - 1
            and word[i] == "儿"
            and phn in {"er2", "er5"}
            and word[-2:] not in not_erhua
            and new_finals
        ):
            phn = "er" + new_finals[-1][-1]

        new_initials.append(initials[i])
        new_finals.append(phn)

    return new_initials, new_finals


def _g2p(segments):
    phones_list = []
    word2ph = []
    g2pw_batch_results = []
    g2pw_batch_cursor = 0
    processed_segments = [re.sub("[a-zA-Z]+", "", seg) for seg in segments]
    if is_g2pw:
        batch_inputs = [seg for seg in processed_segments if seg]
        g2pw_batch_results = g2pw._g2pw(batch_inputs) if batch_inputs else []

    for seg in processed_segments:
        pinyins = []
        seg_cut = psg.lcut(seg)
        seg_cut = tone_modifier.pre_merge_for_modify(seg_cut)
        initials = []
        finals = []

        if not is_g2pw:
            word_position = 0
            for word, pos in seg_cut:
                current_word_position = word_position
                word_position += len(word)
                if pos == "eng":
                    continue
                sub_initials, sub_finals = _get_initials_finals(word)
                # 读音校对层（pypinyin 回退分支）：g2pW 不可用时仍让词粒度读音覆盖生效。
                if _pron is not None:
                    _base_py = lazy_pinyin(word, neutral_tone_with_five=True, style=Style.TONE3)
                    _ov_py = _pron.apply(word, _base_py, position=current_word_position)
                    if list(_ov_py) != list(_base_py):
                        if os.environ.get("PRON_DEBUG"):
                            print(f"[pron] apply(pypinyin) word={word!r} in={list(_base_py)} -> {list(_ov_py)}", flush=True)
                        if len(_ov_py) == len(sub_finals):
                            _ni, _nf, _ok = [], [], True
                            for _py in _ov_py:
                                if _py and _py[0].isalpha():
                                    _ni.append(to_initials(_py))
                                    _nf.append(to_finals_tone3(_py, neutral_tone_with_five=True))
                                else:
                                    _ok = False
                                    break
                            if _ok:
                                sub_initials, sub_finals = _ni, _nf
                        elif os.environ.get("PRON_DEBUG"):
                            print(f"[pron] apply(pypinyin) length mismatch word={word!r} ov={len(_ov_py)} finals={len(sub_finals)}; kept base", flush=True)
                sub_finals = tone_modifier.modified_tone(word, pos, sub_finals)
                # 儿化
                sub_initials, sub_finals = _merge_erhua(sub_initials, sub_finals, word, pos)
                initials.append(sub_initials)
                finals.append(sub_finals)
                # assert len(sub_initials) == len(sub_finals) == len(word)
            initials = sum(initials, [])
            finals = sum(finals, [])
            # print("pypinyin结果", initials, finals)
        else:
            # g2pw采用整句推理（批量推理，逐句取结果）
            if seg:
                pinyins = g2pw_batch_results[g2pw_batch_cursor]
                g2pw_batch_cursor += 1

            pre_word_length = 0
            for word, pos in seg_cut:
                sub_initials = []
                sub_finals = []
                now_word_length = pre_word_length + len(word)

                if pos == "eng":
                    pre_word_length = now_word_length
                    continue

                word_pinyins = pinyins[pre_word_length:now_word_length]

                # 多音字消歧
                word_pinyins = correct_pronunciation(word, word_pinyins)

                # 读音校对层：词粒度覆盖（单次 overrides > 全局词典 > g2p）；无覆盖时原样返回
                if _pron is not None:
                    word_pinyins = _pron.apply(word, word_pinyins, position=pre_word_length)

                for pinyin in word_pinyins:
                    if pinyin[0].isalpha():
                        sub_initials.append(to_initials(pinyin))
                        sub_finals.append(to_finals_tone3(pinyin, neutral_tone_with_five=True))
                    else:
                        sub_initials.append(pinyin)
                        sub_finals.append(pinyin)

                pre_word_length = now_word_length
                sub_finals = tone_modifier.modified_tone(word, pos, sub_finals)
                # 儿化
                sub_initials, sub_finals = _merge_erhua(sub_initials, sub_finals, word, pos)
                initials.append(sub_initials)
                finals.append(sub_finals)

            initials = sum(initials, [])
            finals = sum(finals, [])
            # print("g2pw结果",initials,finals)

        for c, v in zip(initials, finals):
            raw_pinyin = c + v
            # NOTE: post process for pypinyin outputs
            # we discriminate i, ii and iii
            if c == v:
                assert c in punctuation
                phone = [c]
                word2ph.append(1)
            else:
                v_without_tone = v[:-1]
                tone = v[-1]

                pinyin = c + v_without_tone
                assert tone in "12345"

                if c:
                    # 多音节
                    v_rep_map = {
                        "uei": "ui",
                        "iou": "iu",
                        "uen": "un",
                    }
                    if v_without_tone in v_rep_map.keys():
                        pinyin = c + v_rep_map[v_without_tone]
                else:
                    # 单音节
                    pinyin_rep_map = {
                        "ing": "ying",
                        "i": "yi",
                        "in": "yin",
                        "u": "wu",
                    }
                    if pinyin in pinyin_rep_map.keys():
                        pinyin = pinyin_rep_map[pinyin]
                    else:
                        single_rep_map = {
                            "v": "yu",
                            "e": "e",
                            "i": "y",
                            "u": "w",
                        }
                        if pinyin[0] in single_rep_map.keys():
                            pinyin = single_rep_map[pinyin[0]] + pinyin[1:]

                assert pinyin in pinyin_to_symbol_map.keys(), (pinyin, seg, raw_pinyin)
                new_c, new_v = pinyin_to_symbol_map[pinyin].split(" ")
                new_v = new_v + tone
                phone = [new_c, new_v]
                word2ph.append(len(phone))

            phones_list += phone
    return phones_list, word2ph


def replace_punctuation_with_en(text):
    text = text.replace("嗯", "恩").replace("呣", "母")
    pattern = re.compile("|".join(re.escape(p) for p in rep_map.keys()))

    replaced_text = pattern.sub(lambda x: rep_map[x.group()], text)

    replaced_text = re.sub(r"[^\u4e00-\u9fa5A-Za-z" + "".join(punctuation) + r"]+", "", replaced_text)

    return replaced_text


def replace_consecutive_punctuation(text):
    punctuations = "".join(re.escape(p) for p in punctuation)
    pattern = f"([{punctuations}])([{punctuations}])+"
    result = re.sub(pattern, r"\1", text)
    return result


def text_normalize(text):
    # https://github.com/PaddlePaddle/PaddleSpeech/tree/develop/paddlespeech/t2s/frontend/zh_normalization
    tx = TextNormalizer()
    sentences = tx.normalize(text)
    dest_text = ""
    for sentence in sentences:
        dest_text += replace_punctuation(sentence)

    # 避免重复标点引起的参考泄露
    dest_text = replace_consecutive_punctuation(dest_text)
    return dest_text


if __name__ == "__main__":
    text = "啊——但是《原神》是由,米哈\游自主，研发的一款全.新开放世界.冒险游戏"
    text = "呣呣呣～就是…大人的鼹鼠党吧？"
    text = "你好"
    text = text_normalize(text)
    print(g2p(text))


# # 示例用法
# text = "这是一个示例文本：,你好！这是一个测试..."
# print(g2p_paddle(text))  # 输出: 这是一个示例文本你好这是一个测试
