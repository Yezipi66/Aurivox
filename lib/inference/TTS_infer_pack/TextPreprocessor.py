import os
import sys
import threading

from tqdm import tqdm

now_dir = os.getcwd()
sys.path.append(now_dir)

import re
import torch
from gsv_code.text.LangSegmenter import LangSegmenter
from gsv_code.text import chinese
from typing import Dict, List, Tuple
from gsv_code.text.cleaner import clean_text
from gsv_code.text import cleaned_text_to_sequence
from transformers import AutoModelForMaskedLM, AutoTokenizer
from TTS_infer_pack.text_segmentation_method import split_big_text, splits, get_method as get_seg_method

from gsv_code.tools.i18n.i18n import I18nAuto, scan_language_list

language = os.environ.get("language", "Auto")
language = sys.argv[-1] if sys.argv[-1] in scan_language_list() else language
i18n = I18nAuto(language=language)
punctuation = set(["!", "?", "…", ",", ".", "-"])

# --- Auto (Multilingual): zh/ja shared Han-character disambiguation ----------
# Kana (hiragana/katakana, incl. half-width) is the only unambiguous Japanese
# signal; shared Han characters are ambiguous. We split text into clauses
# bounded by sentence terminators and paired quotes, then let the presence of
# kana in a clause decide whether that clause's Han characters are read as
# Japanese or Chinese.
_KANA_RE = re.compile(r"[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]")
_QUOTE_PAIRS = {
    "\u300c": "\u300d",  # 「 」
    "\u300e": "\u300f",  # 『 』
    "\u201c": "\u201d",  # “ ”
    "\u2018": "\u2019",  # ‘ ’
    "\uff08": "\uff09",  # （ ）
    "(": ")",
    "\u3008": "\u3009",  # 〈 〉
    "\u300a": "\u300b",  # 《 》
    "\u3010": "\u3011",  # 【 】
}
# Clause boundaries: sentence terminators + paired quotes + comma-family.
# The comma (，、,) is included so a kana/yue-marker signal is confined to a
# short clause instead of leaking across an entire sentence.
_SENT_END = set("\u3002\uff01\uff1f!?\u2026\n\uff0c\u3001,;:")  # 。！？ ! ? … \n ，、 , ; :


_ML_BASE_LANGS = ("zh", "ja", "yue", "ko", "en")


def _norm_base_lang(lang) -> str:
    """Normalize a voice metadata language to a concrete base lang for the
    Auto (Multilingual) fallback (the reading used for kana-free CJK clauses)."""
    s = str(lang or "").lower().replace("all_", "").replace("auto_", "").strip()
    return s if s in _ML_BASE_LANGS else "zh"


def _has_kana(s: str) -> bool:
    return bool(_KANA_RE.search(s))


def _resolve_auto_segment_language(seg_lang: str, seg_text: str, cjk_default: str) -> str:
    """Resolve detector output inside auto_zh_ja_yue.

    A kana-free Han fragment may be labelled ``ja`` by LangSegmenter because
    Chinese/Japanese Han cannot be distinguished from script alone. In Auto
    mode actual kana is the stronger Japanese signal; otherwise shared Han
    follows the clause's Cantonese/base fallback.
    """
    if seg_lang in ("zh", "x"):
        return cjk_default
    if seg_lang == "ja" and not _has_kana(seg_text):
        return cjk_default
    return seg_lang


# Cantonese detection (auto_zh_ja): conservative, weighted, character-based.
# Strong markers are Cantonese function words/particles that are almost never
# used in Mandarin; weak markers are common in Cantonese writing but can also
# appear in general Chinese text. English/Korean are excluded here — they go
# through their own g2p pipeline and are never counted.
_YUE_STRONG_RE = re.compile(r'[喺嘅佢哋咩冇唔啲嚟咗噉俾畀]')
_YUE_WEAK_RE = re.compile(r'[嘢啱係既咁啦喇咪嘥攞揾餸攰瞓]')
_HAN_RE = re.compile(r'[\u3400-\u4DBF\u4E00-\u9FFF]')
_YUE_STRONG_SCORE = 2.0
_YUE_WEAK_SCORE = 1.0
_YUE_GENERAL_HAN_PENALTY = 0.05
_YUE_THRESHOLD = 1.5

def _has_strong_yue_marker(s: str) -> bool:
    # Deliberately conservative: Traditional Chinese alone is not Cantonese.
    return bool(_YUE_STRONG_RE.search(str(s or '')))


def _yue_score(s: str) -> float:
    """Weighted Cantonese likelihood score for a clause.

    strong marker +2 each, weak marker +1 each, general Han char -0.05 each,
    English/Korean ignored. A clause with total score > _YUE_THRESHOLD (1.5) is
    treated as Cantonese. This replaces the old single-strong-marker rule so a
    clause full of weak markers (or one strong marker diluted by many general
    Han chars) is classified correctly.
    """
    if not s:
        return 0.0
    strong = len(_YUE_STRONG_RE.findall(s))
    weak = len(_YUE_WEAK_RE.findall(s))
    han = len(_HAN_RE.findall(s))
    return strong * _YUE_STRONG_SCORE + weak * _YUE_WEAK_SCORE - han * _YUE_GENERAL_HAN_PENALTY


def _is_yue_clause(s: str) -> bool:
    """True if a clause's weighted Cantonese score exceeds the threshold."""
    return _yue_score(s) > _YUE_THRESHOLD


# Per-character language override: force specific Han-character positions to a
# language that differs from the dominant one (e.g. read 大丈夫 as Japanese inside
# a Chinese passage, or vice versa). The payload uses @absoluteIndex keys; only
# zh/yue/ja are meaningful targets.
_ML_OVERRIDE_LANGS = ("zh", "yue", "ja")


def _apply_lang_overrides(langlist, textlist, overrides, with_positions=False, absolute_start=0):
    """Apply absolute-position (@N) Han overrides after segmentation.

    Returns the original two-tuple by default for compatibility. When
    ``with_positions`` is true, a third list contains the original absolute
    character positions for each emitted segment; the cleaner uses those bases
    to apply the matching ``@N:char`` pronunciation overrides.
    """
    position = {}
    for k, v in (overrides or {}).items():
        lv = _norm_base_lang(v)
        if lv not in _ML_OVERRIDE_LANGS:
            continue
        if isinstance(k, str) and k.startswith("@") and k[1:].isdigit():
            position[int(k[1:])] = lv
        # Character-global legacy keys are intentionally ignored. They would
        # affect every occurrence of a repeated character and violate the
        # position-specific picker contract.

    out_lang, out_text, out_positions = [], [], []

    def emit(lang, txt, positions):
        if not txt:
            return
        if (
            out_lang
            and out_lang[-1] == lang
            and out_positions[-1]
            and positions
            and out_positions[-1][-1] + 1 == positions[0]
        ):
            out_text[-1] += txt
            out_positions[-1].extend(positions)
        else:
            out_lang.append(lang)
            out_text.append(txt)
            out_positions.append(list(positions))

    absolute = int(absolute_start or 0)
    for seg_lang, seg_text in zip(langlist, textlist):
        i = 0
        while i < len(seg_text):
            original_position = absolute + i
            forced_lang = position.get(original_position)
            if forced_lang:
                emit(forced_lang, seg_text[i], [original_position])
            else:
                emit(seg_lang, seg_text[i], [original_position])
            i += 1
        absolute += len(seg_text)

    if with_positions:
        return out_lang, out_text, out_positions
    return out_lang, out_text


def _split_clauses(text: str) -> List[str]:
    """Split into clauses bounded by sentence terminators and paired quotes.

    Quoted spans become their own clause so a Japanese quote embedded in a
    Chinese sentence does not turn the surrounding Chinese Japanese (and vice
    versa). Kana "contagion" is therefore confined to a single clause.
    """
    clauses = []
    buf = ""
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        close = _QUOTE_PAIRS.get(ch)
        if close is not None:
            j = text.find(close, i + 1)
            if j != -1:
                if buf:
                    clauses.append(buf)
                    buf = ""
                clauses.append(text[i:j + 1])
                i = j + 1
                continue
        buf += ch
        if ch in _SENT_END:
            clauses.append(buf)
            buf = ""
        i += 1
    if buf:
        clauses.append(buf)
    return [c for c in clauses if c]


def get_first(text: str) -> str:
    pattern = "[" + "".join(re.escape(sep) for sep in splits) + "]"
    text = re.split(pattern, text)[0].strip()
    return text


def merge_short_text_in_array(texts: str, threshold: int) -> list:
    if (len(texts)) < 2:
        return texts
    result = []
    text = ""
    for ele in texts:
        text += ele
        if len(text) >= threshold:
            result.append(text)
            text = ""
    if len(text) > 0:
        if len(result) == 0:
            result.append(text)
        else:
            result[len(result) - 1] += text
    return result


class TextPreprocessor:
    def __init__(self, bert_model: AutoModelForMaskedLM, tokenizer: AutoTokenizer, device: torch.device):
        self.bert_model = bert_model
        self.tokenizer = tokenizer
        self.device = device
        self.bert_lock = threading.RLock()

    @staticmethod
    def segment_offsets(source_text: str, segments: list) -> list:
        """Return absolute Unicode code-point offsets for derived text segments.

        Python's len/index semantics are code-point based, matching the @N
        coordinates emitted by the web UI. The text splitter may append a final
        punctuation mark or merge short lines; when an exact search is not
        possible, the best safe fallback is the current cursor rather than
        reusing offset zero for every segment.
        """
        source = str(source_text or "")
        offsets = []
        cursor_code_unit = 0
        for segment in segments or []:
            value = str(segment or "")
            at = source.find(value, cursor_code_unit)
            if at < 0:
                offsets.append(len(source[:cursor_code_unit]))
                continue
            offsets.append(len(source[:at]))
            cursor_code_unit = at + len(value)
        return offsets

    def preprocess(self, text: str, lang: str, text_split_method: str, version: str = "v2", auto_base_lang: str = "zh", lang_overrides: dict = None) -> List[Dict]:
        print(f"############ {i18n('切分文本')} ############")
        text = self.replace_consecutive_punctuation(text)
        texts = self.pre_seg_text(text, lang, text_split_method)
        offsets = self.segment_offsets(text, texts)
        result = []
        print(f"############ {i18n('提取文本Bert特征')} ############")
        for index, segment in enumerate(tqdm(texts)):
            position_offset = offsets[index] if index < len(offsets) else 0
            phones, bert_features, norm_text = self.segment_and_extract_feature_for_text(
                segment, lang, version, auto_base_lang, lang_overrides, position_offset=position_offset
            )
            if phones is None or norm_text == "":
                continue
            res = {
                "phones": phones,
                "bert_features": bert_features,
                "norm_text": norm_text,
            }
            result.append(res)
        return result

    def pre_seg_text(self, text: str, lang: str, text_split_method: str):
        text = text.strip("\n")
        if len(text) == 0:
            return []
        if text[0] not in splits and len(get_first(text)) < 4:
            text = "。" + text if lang != "en" else "." + text
        print(i18n("实际输入的目标文本:"))
        print(text)

        seg_method = get_seg_method(text_split_method)
        text = seg_method(text)

        while "\n\n" in text:
            text = text.replace("\n\n", "\n")

        _texts = text.split("\n")
        _texts = self.filter_text(_texts)
        _texts = merge_short_text_in_array(_texts, 5)
        texts = []

        for text in _texts:
            # 解决输入目标文本的空行导致报错的问题
            if len(text.strip()) == 0:
                continue
            if not re.sub("\W+", "", text):
                # 检测一下，如果是纯符号，就跳过。
                continue
            if text[-1] not in splits:
                text += "。" if lang != "en" else "."

            # 解决句子过长导致Bert报错的问题
            if len(text) > 510:
                texts.extend(split_big_text(text))
            else:
                texts.append(text)

        print(i18n("实际输入的目标文本(切句后):"))
        print(texts)
        return texts

    def segment_and_extract_feature_for_text(
        self, text: str, language: str, version: str = "v1", auto_base_lang: str = "zh", lang_overrides: dict = None, position_offset: int = 0
    ) -> Tuple[list, torch.Tensor, str]:
        return self.get_phones_and_bert(
            text, language, version, auto_base_lang=auto_base_lang,
            lang_overrides=lang_overrides, position_offset=position_offset,
        )

    def get_phones_and_bert(self, text: str, language: str, version: str, final: bool = False, auto_base_lang: str = "zh", lang_overrides: dict = None, position_offset: int = 0):
        with self.bert_lock:
            # Korean proofing overrides are human-readable Hangul replacements.
            # Apply per occurrence before Korean g2p; Latin and Han remain in their own pipelines.
            try:
                from gsv_code.text import pron_correction as _pc
                _ko = _pc.current_overrides("ko") or {}
                for _word, _entry in _ko.items():
                    if not isinstance(_word, str) or not _word:
                        continue
                    _n = {"v": 0}
                    def _ko_repl(_m, _e=_entry, _n=_n):
                        _i = _n["v"]; _n["v"] += 1
                        _chosen = _pc._pick_reading(_e, _i)
                        return (_chosen[0] if _chosen else _m.group(0))
                    text = re.sub(re.escape(_word), _ko_repl, text)
            except Exception:
                pass
            # item 19-C: snapshot the per-occurrence counter so the <6-phone retry
            # below (which re-runs g2p on the same text) doesn't double-count word
            # occurrences and desync position-level English overrides.
            try:
                from gsv_code.text import pron_correction as _pron_occ
                _occ_snap = _pron_occ.snapshot_occ()
            except Exception:
                _pron_occ = None
                _occ_snap = None
            text = re.sub(r' {2,}', ' ', text)
            textlist = []
            langlist = []
            if language == "all_zh":
                for tmp in LangSegmenter.getTexts(text,"zh"):
                    langlist.append(tmp["lang"])
                    textlist.append(tmp["text"])
            elif language == "all_yue":
                for tmp in LangSegmenter.getTexts(text,"zh"):
                    if tmp["lang"] == "zh":
                        tmp["lang"] = "yue"
                    langlist.append(tmp["lang"])
                    textlist.append(tmp["text"])
            elif language == "all_ja":
                for tmp in LangSegmenter.getTexts(text,"ja"):
                    langlist.append(tmp["lang"])
                    textlist.append(tmp["text"])
            elif language == "all_ko":
                for tmp in LangSegmenter.getTexts(text):
                    seg_lang = tmp["lang"]
                    if seg_lang in ("zh", "x"):
                        seg_lang = "zh"
                    elif seg_lang == "ja" and not _has_kana(tmp["text"]):
                        seg_lang = "zh"
                    if langlist and seg_lang == langlist[-1]:
                        textlist[-1] += tmp["text"]
                    else:
                        langlist.append(seg_lang)
                        textlist.append(tmp["text"])
            elif language == "en":
                langlist.append("en")
                textlist.append(text)
            elif language == "auto":
                for tmp in LangSegmenter.getTexts(text):
                    langlist.append(tmp["lang"])
                    textlist.append(tmp["text"])
            elif language == "auto_yue":
                for tmp in LangSegmenter.getTexts(text):
                    if tmp["lang"] == "zh":
                        tmp["lang"] = "yue"
                    langlist.append(tmp["lang"])
                    textlist.append(tmp["text"])
            elif language == "auto_zh_ja_yue" or language == "auto_zh_ja":
                # Auto (Multilingual): kana-free CJK defaults to the voice's base
                # language (from asset metadata), but any clause that CONTAINS kana
                # is treated as Japanese so its shared Han characters are read as Japanese too.
                # Cantonese (yue) clauses are detected via weighted character scoring.
                # Ambiguous CJK segments (zh / zh-tw"x") follow the clause default;
                # en/ja/ko keep their detected language.
                base_lang = _norm_base_lang(auto_base_lang)
                for clause in _split_clauses(text):
                    cjk_default = "ja" if _has_kana(clause) else ("yue" if _is_yue_clause(clause) else base_lang)
                    for tmp in LangSegmenter.getTexts(clause):
                        seg_lang = _resolve_auto_segment_language(
                            tmp["lang"], tmp["text"], cjk_default
                        )
                        if langlist and seg_lang == langlist[-1]:
                            textlist[-1] += tmp["text"]
                        else:
                            langlist.append(seg_lang)
                            textlist.append(tmp["text"])
            else:
                for tmp in LangSegmenter.getTexts(text):
                    if langlist:
                        if (tmp["lang"] == "en" and langlist[-1] == "en") or (tmp["lang"] != "en" and langlist[-1] != "en"):
                            textlist[-1] += tmp["text"]
                            continue
                    if tmp["lang"] == "en":
                        langlist.append(tmp["lang"])
                    else:
                        # 因无法区别中日韩文汉字,以用户输入为准
                        langlist.append(language)
                    textlist.append(tmp["text"])
            # Per-character language override (Auto Multilingual + strict CJK modes):
            # force user-selected Han-character runs to their reverse language.
            position_bases = []
            if lang_overrides and language in ("all_zh", "all_yue", "all_ja", "auto_zh_ja_yue", "auto_zh_ja", "auto"):
                langlist, textlist, segment_positions = _apply_lang_overrides(
                    langlist, textlist, lang_overrides, with_positions=True, absolute_start=position_offset
                )
                position_bases = [positions[0] if positions else 0 for positions in segment_positions]
            else:
                cursor = position_offset
                for segment in textlist:
                    position_bases.append(cursor)
                    cursor += len(segment)
            # print(textlist)
            # print(langlist)
            phones_list = []
            bert_list = []
            norm_text_list = []
            for i in range(len(textlist)):
                lang = langlist[i]
                phones, word2ph, norm_text = self.clean_text_inf(
                    textlist[i], lang, version, position_base=position_bases[i] if i < len(position_bases) else 0
                )
                bert = self.get_bert_inf(phones, word2ph, norm_text, lang)
                phones_list.append(phones)
                norm_text_list.append(norm_text)
                bert_list.append(bert)
            bert = torch.cat(bert_list, dim=1)
            phones = sum(phones_list, [])
            norm_text = "".join(norm_text_list)

            if not final and len(phones) < 6:
                if _pron_occ is not None and _occ_snap is not None:
                    _pron_occ.restore_occ(_occ_snap)
                return self.get_phones_and_bert("." + text, language, version, final=True, auto_base_lang=auto_base_lang, lang_overrides=lang_overrides, position_offset=position_offset - 1)

            return phones, bert, norm_text

    def get_bert_feature(self, text: str, word2ph: list) -> torch.Tensor:
        with torch.no_grad():
            inputs = self.tokenizer(text, return_tensors="pt")
            for i in inputs:
                inputs[i] = inputs[i].to(self.device)
            res = self.bert_model(**inputs, output_hidden_states=True)
            res = torch.cat(res["hidden_states"][-3:-2], -1)[0].cpu()[1:-1]
        assert len(word2ph) == len(text)
        phone_level_feature = []
        for i in range(len(word2ph)):
            repeat_feature = res[i].repeat(word2ph[i], 1)
            phone_level_feature.append(repeat_feature)
        phone_level_feature = torch.cat(phone_level_feature, dim=0)
        return phone_level_feature.T

    def clean_text_inf(self, text: str, language: str, version: str = "v2", position_base: int = 0):
        language = language.replace("all_", "")
        # The language-specific cleaners call the shared pronunciation layer
        # internally. Set the original-text base while they run so @N:char
        # readings can be applied to the correct occurrence.
        try:
            from gsv_code.text import pron_correction
            pron_correction.set_segment_base(position_base)
        except Exception:
            pron_correction = None
        try:
            phones, word2ph, norm_text = clean_text(text, language, version)
            phones = cleaned_text_to_sequence(phones, version)
            return phones, word2ph, norm_text
        finally:
            if pron_correction is not None:
                try:
                    pron_correction.clear_segment_base()
                except Exception:
                    pass

    def get_bert_inf(self, phones: list, word2ph: list, norm_text: str, language: str):
        language = language.replace("all_", "")
        if language == "zh":
            feature = self.get_bert_feature(norm_text, word2ph).to(self.device)
        else:
            feature = torch.zeros(
                (1024, len(phones)),
                dtype=torch.float32,
            ).to(self.device)

        return feature

    def filter_text(self, texts):
        _text = []
        if all(text in [None, " ", "\n", ""] for text in texts):
            raise ValueError(i18n("请输入有效文本"))
        for text in texts:
            if text in [None, " ", ""]:
                pass
            else:
                _text.append(text)
        return _text

    def replace_consecutive_punctuation(self, text):
        punctuations = "".join(re.escape(p) for p in punctuation)
        pattern = f"([{punctuations}])([{punctuations}])+"
        result = re.sub(pattern, r"\1", text)
        return result
