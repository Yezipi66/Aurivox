# modified from https://github.com/CjangCjengh/vits/blob/main/text/japanese.py
import re
import os
import hashlib

try:
    import pyopenjtalk

    current_file_path = os.path.dirname(__file__)

    # 防止win下无法读取模型
    if os.name == "nt":
        python_dir = os.getcwd()
        OPEN_JTALK_DICT_DIR = pyopenjtalk.OPEN_JTALK_DICT_DIR.decode("utf-8")
        if not (re.match(r"^[A-Za-z0-9_/\\:.\-]*$", OPEN_JTALK_DICT_DIR)):
            if OPEN_JTALK_DICT_DIR[: len(python_dir)].upper() == python_dir.upper():
                OPEN_JTALK_DICT_DIR = os.path.join(os.path.relpath(OPEN_JTALK_DICT_DIR, python_dir))
            else:
                import shutil

                if not os.path.exists("TEMP"):
                    os.mkdir("TEMP")
                if not os.path.exists(os.path.join("TEMP", "ja")):
                    os.mkdir(os.path.join("TEMP", "ja"))
                if os.path.exists(os.path.join("TEMP", "ja", "open_jtalk_dic")):
                    shutil.rmtree(os.path.join("TEMP", "ja", "open_jtalk_dic"))
                shutil.copytree(
                    pyopenjtalk.OPEN_JTALK_DICT_DIR.decode("utf-8"),
                    os.path.join("TEMP", "ja", "open_jtalk_dic"),
                )
                OPEN_JTALK_DICT_DIR = os.path.join("TEMP", "ja", "open_jtalk_dic")
            pyopenjtalk.OPEN_JTALK_DICT_DIR = OPEN_JTALK_DICT_DIR.encode("utf-8")

        if not (re.match(r"^[A-Za-z0-9_/\\:.\-]*$", current_file_path)):
            if current_file_path[: len(python_dir)].upper() == python_dir.upper():
                current_file_path = os.path.join(os.path.relpath(current_file_path, python_dir))
            else:
                if not os.path.exists("TEMP"):
                    os.mkdir("TEMP")
                if not os.path.exists(os.path.join("TEMP", "ja")):
                    os.mkdir(os.path.join("TEMP", "ja"))
                if not os.path.exists(os.path.join("TEMP", "ja", "ja_userdic")):
                    os.mkdir(os.path.join("TEMP", "ja", "ja_userdic"))
                    shutil.copyfile(
                        os.path.join(current_file_path, "ja_userdic", "userdict.csv"),
                        os.path.join("TEMP", "ja", "ja_userdic", "userdict.csv"),
                    )
                current_file_path = os.path.join("TEMP", "ja")

    def get_hash(fp: str) -> str:
        hash_md5 = hashlib.md5()
        with open(fp, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()

    USERDIC_CSV_PATH = os.path.join(current_file_path, "ja_userdic", "userdict.csv")
    USERDIC_BIN_PATH = os.path.join(current_file_path, "ja_userdic", "user.dict")
    USERDIC_HASH_PATH = os.path.join(current_file_path, "ja_userdic", "userdict.md5")
    # 如果没有用户词典，就生成一个；如果有，就检查md5，如果不一样，就重新生成
    if os.path.exists(USERDIC_CSV_PATH):
        if (
            not os.path.exists(USERDIC_BIN_PATH)
            or get_hash(USERDIC_CSV_PATH) != open(USERDIC_HASH_PATH, "r", encoding="utf-8").read()
        ):
            pyopenjtalk.mecab_dict_index(USERDIC_CSV_PATH, USERDIC_BIN_PATH)
            with open(USERDIC_HASH_PATH, "w", encoding="utf-8") as f:
                f.write(get_hash(USERDIC_CSV_PATH))

    if os.path.exists(USERDIC_BIN_PATH):
        pyopenjtalk.update_global_jtalk_with_user_dict(USERDIC_BIN_PATH)
except Exception:
    # print(e)
    import pyopenjtalk

    # failed to load user dictionary, ignore.
    pass


from gsv_code.text.symbols import punctuation

# ---------------------------------------------------------------------------
# 读音校对覆盖层（task7 日语接入）
#   * 覆盖单元 = 表层词组 -> 假名读音串（音読み/訓読み 由词决定，不逐字选候选）。
#   * 注入点 = pyopenjtalk.run_frontend() 得到逐词素 NJD 特征后、make_label() 转音素前，
#     改写命中词条的假名读音（read/pron），再交给 make_label —— 与中文「逐词读音推导后、
#     转音素前 apply」一一对应。
#   * accent（音高核）本版不做（task7 已对齐）：改读音后将 acc 归 0（平板）以避免
#     accent 位越界，mora_size 重算。任何异常一律回落原 NJD，保证零回归。
# ---------------------------------------------------------------------------
try:
    from gsv_code.text import pron_correction as _pron
except Exception as _pron_err:  # pragma: no cover
    print(f"[japanese] pron_correction unavailable ({_pron_err!r}); reading override disabled.")
    _pron = None

# 小书きかな（拗音/小母音）不独立成拍；ッ/ン/ー 各成一拍。
_JA_SMALL_KANA = set("ァィゥェォャュョヮ")


def _to_katakana(s):
    """把用户输入的假名统一成片假名（pyopenjtalk 的 pron 原生即片假名）。"""
    try:
        import jaconv
        return jaconv.hira2kata(s)
    except Exception:
        return s


def _count_mora(kana):
    """按拍数统计片假名 mora（小书きかな不计拍）。至少 1，供 NJD mora_size 用。"""
    n = 0
    for ch in kana or "":
        if ch in _JA_SMALL_KANA:
            continue
        n += 1
    return max(n, 1)


def _feat_surface(f):
    return f.get("string") or f.get("orig") or ""


def _feat_reading(f):
    # pron = 実際の発音（アクセント抜きの片假名）, read = 読み。優先 pron。
    return f.get("pron") or f.get("read") or ""


def _apply_yomi_override_njd(njd):
    """Route C：按表层词组覆盖 NJD 假名读音（单词素精确 + 相邻词素贪婪合并）。

    命中词条时，把该跨度合并为一个词素：string/orig=词组、read/pron=覆盖假名、
    mora_size 重算、acc 归 0（本版不控 accent）。任何异常回落原 njd。
    """
    if _pron is None or not njd:
        return njd
    try:
        view = _pron.overrides_view("ja") or {}
    except Exception:
        view = {}
    if not view:
        return njd
    try:
        surfaces = [_feat_surface(f) for f in njd]
        n = len(njd)
        out = []
        i = 0
        max_span = 8
        while i < n:
            matched = False
            for span in range(min(max_span, n - i), 0, -1):
                key = "".join(surfaces[i:i + span])
                if key and key in view:
                    vals = view[key]
                    kana_raw = None
                    if isinstance(vals, (list, tuple)) and vals:
                        kana_raw = vals[0]
                    elif isinstance(vals, str):
                        kana_raw = vals
                    if kana_raw:
                        kana = _to_katakana(str(kana_raw))
                        base = dict(njd[i])
                        base["string"] = key
                        base["orig"] = key
                        base["read"] = kana
                        base["pron"] = kana
                        base["mora_size"] = _count_mora(kana)
                        base["acc"] = 0
                        base["chain_flag"] = -1
                        out.append(base)
                        i += span
                        matched = True
                        break
            if not matched:
                out.append(njd[i])
                i += 1
        return out
    except Exception as _e:
        print(f"[japanese] yomi override skipped ({_e!r}).")
        return njd


def get_word_yomi(text):
    """预览：文本 -> [(word, reading, source)]，读音已应用覆盖（预览 == 合成）。

    对等中文 chinese2.get_word_pinyins，返回 (norm_text, tokens)。
    """
    norm = text_normalize(text)
    try:
        njd = pyopenjtalk.run_frontend(norm)
    except Exception:
        njd = []
    try:
        njd2 = _apply_yomi_override_njd(njd)
    except Exception:
        njd2 = njd
    ov = {}
    lex = {}
    if _pron is not None:
        try:
            ov = _pron.current_overrides("ja") or {}
        except Exception:
            ov = {}
        try:
            lex = _pron.load_lexicon("ja") or {}
        except Exception:
            lex = {}
    tokens = []
    for f in (njd2 or []):
        w = _feat_surface(f)
        r = _feat_reading(f)
        if w in ov:
            src = "override"
        elif w in lex:
            src = "lexicon"
        else:
            src = "g2p"
        tokens.append({"word": w, "reading": r, "source": src})
    return norm, tokens


# Regular expression matching Japanese without punctuation marks:
_japanese_characters = re.compile(
    r"[A-Za-z\d\u3005\u3040-\u30ff\u4e00-\u9fff\uff11-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9d]"
)

# Regular expression matching non-Japanese characters or punctuation marks:
_japanese_marks = re.compile(
    r"[^A-Za-z\d\u3005\u3040-\u30ff\u4e00-\u9fff\uff11-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9d]"
)

# List of (symbol, Japanese) pairs for marks:
_symbols_to_japanese = [(re.compile("%s" % x[0]), x[1]) for x in [("％", "パーセント")]]


# List of (consonant, sokuon) pairs:
_real_sokuon = [
    (re.compile("%s" % x[0]), x[1])
    for x in [
        (r"Q([↑↓]*[kg])", r"k#\1"),
        (r"Q([↑↓]*[tdjʧ])", r"t#\1"),
        (r"Q([↑↓]*[sʃ])", r"s\1"),
        (r"Q([↑↓]*[pb])", r"p#\1"),
    ]
]

# List of (consonant, hatsuon) pairs:
_real_hatsuon = [
    (re.compile("%s" % x[0]), x[1])
    for x in [
        (r"N([↑↓]*[pbm])", r"m\1"),
        (r"N([↑↓]*[ʧʥj])", r"n^\1"),
        (r"N([↑↓]*[tdn])", r"n\1"),
        (r"N([↑↓]*[kg])", r"ŋ\1"),
    ]
]


def post_replace_ph(ph):
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
    }

    if ph in rep_map.keys():
        ph = rep_map[ph]
    return ph


def replace_consecutive_punctuation(text):
    punctuations = "".join(re.escape(p) for p in punctuation)
    pattern = f"([{punctuations}])([{punctuations}])+"
    result = re.sub(pattern, r"\1", text)
    return result


def symbols_to_japanese(text):
    for regex, replacement in _symbols_to_japanese:
        text = re.sub(regex, replacement, text)
    return text


def preprocess_jap(text, with_prosody=False):
    """Reference https://r9y9.github.io/ttslearn/latest/notebooks/ch10_Recipe-Tacotron.html"""
    text = symbols_to_japanese(text)
    # English words to lower case, should have no influence on japanese words.
    text = text.lower()
    sentences = re.split(_japanese_marks, text)
    marks = re.findall(_japanese_marks, text)
    text = []
    for i, sentence in enumerate(sentences):
        if re.match(_japanese_characters, sentence):
            if with_prosody:
                text += pyopenjtalk_g2p_prosody(sentence)[1:-1]
            else:
                p = pyopenjtalk.g2p(sentence)
                text += p.split(" ")

        if i < len(marks):
            if marks[i] == " ":  # 防止意外的UNK
                continue
            text += [marks[i].replace(" ", "")]
    return text


def text_normalize(text):
    # todo: jap text normalize

    # 避免重复标点引起的参考泄露
    text = replace_consecutive_punctuation(text)
    return text


# Copied from espnet https://github.com/espnet/espnet/blob/master/espnet2/text/phoneme_tokenizer.py
def pyopenjtalk_g2p_prosody(text, drop_unvoiced_vowels=True):
    """Extract phoneme + prosoody symbol sequence from input full-context labels.

    The algorithm is based on `Prosodic features control by symbols as input of
    sequence-to-sequence acoustic modeling for neural TTS`_ with some r9y9's tweaks.

    Args:
        text (str): Input text.
        drop_unvoiced_vowels (bool): whether to drop unvoiced vowels.

    Returns:
        List[str]: List of phoneme + prosody symbols.

    Examples:
        >>> from espnet2.text.phoneme_tokenizer import pyopenjtalk_g2p_prosody
        >>> pyopenjtalk_g2p_prosody("こんにちは。")
        ['^', 'k', 'o', '[', 'N', 'n', 'i', 'ch', 'i', 'w', 'a', '$']

    .. _`Prosodic features control by symbols as input of sequence-to-sequence acoustic
        modeling for neural TTS`: https://doi.org/10.1587/transinf.2020EDP7104

    """
    _njd = pyopenjtalk.run_frontend(text)
    try:
        _njd = _apply_yomi_override_njd(_njd)
    except Exception:
        pass
    labels = pyopenjtalk.make_label(_njd)
    N = len(labels)

    phones = []
    for n in range(N):
        lab_curr = labels[n]

        # current phoneme
        p3 = re.search(r"\-(.*?)\+", lab_curr).group(1)
        # deal unvoiced vowels as normal vowels
        if drop_unvoiced_vowels and p3 in "AEIOU":
            p3 = p3.lower()

        # deal with sil at the beginning and the end of text
        if p3 == "sil":
            assert n == 0 or n == N - 1
            if n == 0:
                phones.append("^")
            elif n == N - 1:
                # check question form or not
                e3 = _numeric_feature_by_regex(r"!(\d+)_", lab_curr)
                if e3 == 0:
                    phones.append("$")
                elif e3 == 1:
                    phones.append("?")
            continue
        elif p3 == "pau":
            phones.append("_")
            continue
        else:
            phones.append(p3)

        # accent type and position info (forward or backward)
        a1 = _numeric_feature_by_regex(r"/A:([0-9\-]+)\+", lab_curr)
        a2 = _numeric_feature_by_regex(r"\+(\d+)\+", lab_curr)
        a3 = _numeric_feature_by_regex(r"\+(\d+)/", lab_curr)

        # number of mora in accent phrase
        f1 = _numeric_feature_by_regex(r"/F:(\d+)_", lab_curr)

        a2_next = _numeric_feature_by_regex(r"\+(\d+)\+", labels[n + 1])
        # accent phrase border
        if a3 == 1 and a2_next == 1 and p3 in "aeiouAEIOUNcl":
            phones.append("#")
        # pitch falling
        elif a1 == 0 and a2_next == a2 + 1 and a2 != f1:
            phones.append("]")
        # pitch rising
        elif a2 == 1 and a2_next == 2:
            phones.append("[")

    return phones


# Copied from espnet https://github.com/espnet/espnet/blob/master/espnet2/text/phoneme_tokenizer.py
def _numeric_feature_by_regex(regex, s):
    match = re.search(regex, s)
    if match is None:
        return -50
    return int(match.group(1))


def g2p(norm_text, with_prosody=True):
    phones = preprocess_jap(norm_text, with_prosody)
    phones = [post_replace_ph(i) for i in phones]
    # todo: implement tones and word2ph
    return phones


if __name__ == "__main__":
    phones = g2p("Hello.こんにちは！今日もNiCe天気ですね！tokyotowerに行きましょう！")
    print(phones)
