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
_SENT_END = set("\u3002\uff01\uff1f!?\u2026\n")  # 。！？ ! ? … newline


_ML_BASE_LANGS = ("zh", "ja", "yue", "ko", "en")


def _norm_base_lang(lang) -> str:
    """Normalize a voice metadata language to a concrete base lang for the
    Auto (Multilingual) fallback (the reading used for kana-free CJK clauses)."""
    s = str(lang or "").lower().replace("all_", "").replace("auto_", "").strip()
    return s if s in _ML_BASE_LANGS else "zh"


def _has_kana(s: str) -> bool:
    return bool(_KANA_RE.search(s))


# Per-character language override: force specific Han-character substrings to a
# language that differs from the dominant one (e.g. read 大丈夫 as Japanese inside
# a Chinese passage, or vice versa). Only zh/yue/ja are meaningful targets.
_ML_OVERRIDE_LANGS = ("zh", "yue", "ja")


def _apply_lang_overrides(langlist, textlist, overrides):
    """Split each (lang, text) segment at override substrings and reassign their
    language. Substring-based -> applies to every occurrence (same character =
    same reading intent). No-op when overrides is empty -> zero regression.
    """
    clean = {}
    for k, v in (overrides or {}).items():
        if not k:
            continue
        lv = _norm_base_lang(v)
        if lv in _ML_OVERRIDE_LANGS:
            clean[k] = lv
    keys = sorted(clean.keys(), key=len, reverse=True)  # longest match first
    if not keys:
        return langlist, textlist

    out_lang, out_text = [], []

    def emit(lang, txt):
        if not txt:
            return
        if out_lang and out_lang[-1] == lang:
            out_text[-1] += txt
        else:
            out_lang.append(lang)
            out_text.append(txt)

    for seg_lang, seg_text in zip(langlist, textlist):
        i, n = 0, len(seg_text)
        while i < n:
            matched = next((k for k in keys if seg_text.startswith(k, i)), None)
            if matched is not None:
                emit(clean[matched], matched)
                i += len(matched)
            else:
                j = i + 1
                while j < n and not any(seg_text.startswith(k, j) for k in keys):
                    j += 1
                emit(seg_lang, seg_text[i:j])
                i = j
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

    def preprocess(self, text: str, lang: str, text_split_method: str, version: str = "v2", auto_base_lang: str = "zh", lang_overrides: dict = None) -> List[Dict]:
        print(f"############ {i18n('切分文本')} ############")
        text = self.replace_consecutive_punctuation(text)
        texts = self.pre_seg_text(text, lang, text_split_method)
        result = []
        print(f"############ {i18n('提取文本Bert特征')} ############")
        for text in tqdm(texts):
            phones, bert_features, norm_text = self.segment_and_extract_feature_for_text(text, lang, version, auto_base_lang, lang_overrides)
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
        self, text: str, language: str, version: str = "v1", auto_base_lang: str = "zh", lang_overrides: dict = None
    ) -> Tuple[list, torch.Tensor, str]:
        return self.get_phones_and_bert(text, language, version, auto_base_lang=auto_base_lang, lang_overrides=lang_overrides)

    def get_phones_and_bert(self, text: str, language: str, version: str, final: bool = False, auto_base_lang: str = "zh", lang_overrides: dict = None):
        with self.bert_lock:
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
                for tmp in LangSegmenter.getTexts(text,"ko"):
                    langlist.append(tmp["lang"])
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
            elif language == "auto_zh_ja":
                # Auto (Multilingual): kana-free CJK defaults to the voice's base
                # language (from asset metadata), but any clause that CONTAINS kana
                # is treated as Japanese so its shared Han characters are read as Japanese too.
                # Ambiguous CJK segments (zh / zh-tw"x") follow the clause default;
                # en/ja/ko keep their detected language.
                base_lang = _norm_base_lang(auto_base_lang)
                for clause in _split_clauses(text):
                    cjk_default = "ja" if _has_kana(clause) else base_lang
                    for tmp in LangSegmenter.getTexts(clause):
                        seg_lang = tmp["lang"]
                        if seg_lang in ("zh", "x"):
                            seg_lang = cjk_default
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
            if lang_overrides and language in ("all_zh", "all_yue", "all_ja", "auto_zh_ja", "auto"):
                langlist, textlist = _apply_lang_overrides(langlist, textlist, lang_overrides)
            # print(textlist)
            # print(langlist)
            phones_list = []
            bert_list = []
            norm_text_list = []
            for i in range(len(textlist)):
                lang = langlist[i]
                phones, word2ph, norm_text = self.clean_text_inf(textlist[i], lang, version)
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
                return self.get_phones_and_bert("." + text, language, version, final=True, auto_base_lang=auto_base_lang, lang_overrides=lang_overrides)

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

    def clean_text_inf(self, text: str, language: str, version: str = "v2"):
        language = language.replace("all_", "")
        phones, word2ph, norm_text = clean_text(text, language, version)
        phones = cleaned_text_to_sequence(phones, version)
        return phones, word2ph, norm_text

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
