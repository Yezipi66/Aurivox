import pickle
import os
import re
import wordsegment
from g2p_en import G2p

from gsv_code.text.symbols import punctuation

from gsv_code.text.symbols2 import symbols

# 连字符复合词规则（join -> split -> 预测）。单独成模块是因为本文件依赖 nltk 和
# wordsegment，测试环境装不上，规则留在这里就没有任何测试跑得到它。
from gsv_code.text import en_hyphen

# 读音校对覆盖层（task7 英语接入）：读音单元 = 词 -> ARPABET 音素列表。
# 注入点 = en_G2p 逐词求出音素后、拼接前；覆盖项直接替换（en 无 word2ph 对齐约束，
# 允许音素数变化）。任何异常/缺失一律原样返回，保证零回归。
try:
    from gsv_code.text import pron_correction as _pron
except Exception as _pron_err:  # pragma: no cover
    print(f"[english] pron_correction unavailable ({_pron_err!r}); reading override disabled.")
    _pron = None

from builtins import str as unicode
from gsv_code.text.en_normalization.expend import normalize
from nltk.tokenize import TweetTokenizer

word_tokenize = TweetTokenizer().tokenize
from nltk import pos_tag

current_file_path = os.path.dirname(__file__)
CMU_DICT_PATH = os.path.join(current_file_path, "cmudict.rep")
CMU_DICT_FAST_PATH = os.path.join(current_file_path, "cmudict-fast.rep")
CMU_DICT_HOT_PATH = os.path.join(current_file_path, "engdict-hot.rep")
CACHE_PATH = os.path.join(current_file_path, "engdict_cache.pickle")
NAMECACHE_PATH = os.path.join(current_file_path, "namedict_cache.pickle")


# 适配中文及 g2p_en 标点
rep_map = {
    "[;:：，；]": ",",
    '["’]': "'",
    "。": ".",
    "！": "!",
    "？": "?",
}


arpa = {
    "AH0",
    "S",
    "AH1",
    "EY2",
    "AE2",
    "EH0",
    "OW2",
    "UH0",
    "NG",
    "B",
    "G",
    "AY0",
    "M",
    "AA0",
    "F",
    "AO0",
    "ER2",
    "UH1",
    "IY1",
    "AH2",
    "DH",
    "IY0",
    "EY1",
    "IH0",
    "K",
    "N",
    "W",
    "IY2",
    "T",
    "AA1",
    "ER1",
    "EH2",
    "OY0",
    "UH2",
    "UW1",
    "Z",
    "AW2",
    "AW1",
    "V",
    "UW2",
    "AA2",
    "ER",
    "AW0",
    "UW0",
    "R",
    "OW1",
    "EH1",
    "ZH",
    "AE0",
    "IH2",
    "IH",
    "Y",
    "JH",
    "P",
    "AY1",
    "EY0",
    "OY2",
    "TH",
    "HH",
    "D",
    "ER0",
    "CH",
    "AO1",
    "AE1",
    "AO2",
    "OY1",
    "AY2",
    "IH1",
    "OW0",
    "L",
    "SH",
}


def replace_phs(phs):
    rep_map = {"'": "-"}
    phs_new = []
    for ph in phs:
        if ph in symbols:
            phs_new.append(ph)
        elif ph in rep_map.keys():
            phs_new.append(rep_map[ph])
        else:
            print("ph not in symbols: ", ph)
    return phs_new


def replace_consecutive_punctuation(text):
    punctuations = "".join(re.escape(p) for p in punctuation)
    pattern = f"([{punctuations}\s])([{punctuations}])+"
    result = re.sub(pattern, r"\1", text)
    return result


def read_dict():
    g2p_dict = {}
    start_line = 49
    with open(CMU_DICT_PATH) as f:
        line = f.readline()
        line_index = 1
        while line:
            if line_index >= start_line:
                line = line.strip()
                word_split = line.split("  ")
                word = word_split[0].lower()

                syllable_split = word_split[1].split(" - ")
                g2p_dict[word] = []
                for syllable in syllable_split:
                    phone_split = syllable.split(" ")
                    g2p_dict[word].append(phone_split)

            line_index = line_index + 1
            line = f.readline()

    return g2p_dict


def read_dict_new():
    g2p_dict = {}
    with open(CMU_DICT_PATH) as f:
        line = f.readline()
        line_index = 1
        while line:
            if line_index >= 57:
                line = line.strip()
                word_split = line.split("  ")
                word = word_split[0].lower()
                g2p_dict[word] = [word_split[1].split(" ")]

            line_index = line_index + 1
            line = f.readline()

    with open(CMU_DICT_FAST_PATH) as f:
        line = f.readline()
        line_index = 1
        while line:
            if line_index >= 0:
                line = line.strip()
                word_split = line.split(" ")
                word = word_split[0].lower()
                if word not in g2p_dict:
                    g2p_dict[word] = [word_split[1:]]

            line_index = line_index + 1
            line = f.readline()

    return g2p_dict


def hot_reload_hot(g2p_dict):
    with open(CMU_DICT_HOT_PATH) as f:
        line = f.readline()
        line_index = 1
        while line:
            if line_index >= 0:
                line = line.strip()
                word_split = line.split(" ")
                word = word_split[0].lower()
                # 自定义发音词直接覆盖字典
                g2p_dict[word] = [word_split[1:]]

            line_index = line_index + 1
            line = f.readline()

    return g2p_dict


def cache_dict(g2p_dict, file_path):
    with open(file_path, "wb") as pickle_file:
        pickle.dump(g2p_dict, pickle_file)


def get_dict():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, "rb") as pickle_file:
            g2p_dict = pickle.load(pickle_file)
    else:
        g2p_dict = read_dict_new()
        cache_dict(g2p_dict, CACHE_PATH)

    g2p_dict = hot_reload_hot(g2p_dict)

    return g2p_dict


def get_namedict():
    if os.path.exists(NAMECACHE_PATH):
        with open(NAMECACHE_PATH, "rb") as pickle_file:
            name_dict = pickle.load(pickle_file)
    else:
        name_dict = {}

    return name_dict


def text_normalize(text):
    # todo: eng text normalize

    # 效果相同，和 chinese.py 保持一致
    pattern = re.compile("|".join(re.escape(p) for p in rep_map.keys()))
    text = pattern.sub(lambda x: rep_map[x.group()], text)

    text = unicode(text)
    text = normalize(text)

    # 避免重复标点引起的参考泄露
    text = replace_consecutive_punctuation(text)
    return text


class en_G2p(G2p):
    def __init__(self):
        super().__init__()
        # 分词初始化
        wordsegment.load()

        # 扩展过时字典, 添加姓名字典
        self.cmu = get_dict()
        self.namedict = get_namedict()

        # 剔除读音错误的几个缩写
        for word in ["AE", "AI", "AR", "IOS", "HUD", "OS"]:
            del self.cmu[word.lower()]

        # 修正多音字
        self.homograph2features["read"] = (["R", "IY1", "D"], ["R", "EH1", "D"], "VBP")
        self.homograph2features["complex"] = (
            ["K", "AH0", "M", "P", "L", "EH1", "K", "S"],
            ["K", "AA1", "M", "P", "L", "EH0", "K", "S"],
            "JJ",
        )

    def _base_pron(self, o_word, pos):
        """单词 -> ARPABET 音素列表（覆盖层注入前的原始读音）。"""
        # 还原 g2p_en 小写操作逻辑
        word = o_word.lower()

        if re.search("[a-z]", word) is None:
            return [word]
        # 先把单字母推出去
        elif len(word) == 1:
            # 单读 A 发音修正, 这里需要原格式 o_word 判断大写
            if o_word == "A":
                return ["EY1"]
            else:
                return self.cmu[word][0]
        # g2p_en 原版多音字处理
        elif word in self.homograph2features:  # Check homograph
            pron1, pron2, pos1 = self.homograph2features[word]
            if pos.startswith(pos1):
                return pron1
            # pos1比pos长仅出现在read
            elif len(pos) < len(pos1) and pos == pos1[: len(pos)]:
                return pron1
            else:
                return pron2
        else:
            # 递归查找预测
            return self.qryword(o_word)

    def __call__(self, text):
        # tokenization
        words = word_tokenize(text)
        tokens = pos_tag(words)  # tuples of (word, tag)

        # steps
        prons = []
        for o_word, pos in tokens:
            pron = self._base_pron(o_word, pos)
            # 读音校对覆盖层（task7 + item 19-C）：按「该词在本次合成里的出现序号」解析，
            # 支持逐次不同读音；next_occ 对每个词无条件自增以保证与预览的出现编号对齐。
            if _pron is not None:
                occ = _pron.next_occ("en", o_word)
                pron = _pron.resolve(o_word, pron, lang="en", occ=occ)

            prons.extend(pron)
            prons.extend([" "])

        return prons[:-1]

    def _dict_pron(self, spelling):
        """词典里查一个拼写，查不到返回 None。给 en_hyphen 用。

        只查词典，不递归、不预测：连字符规则要么拿到词典里的确定答案，要么让位给
        原来的分词和预测两级，不自己制造答案。
        """
        if len(spelling) > 1 and spelling in self.cmu:
            return self.cmu[spelling][0]
        return None

    def qryword(self, o_word):
        word = o_word.lower()

        # 查字典, 单字母除外
        if len(word) > 1 and word in self.cmu:  # lookup CMU dict
            return self.cmu[word][0]

        # 单词仅首字母大写时查找姓名字典
        if o_word.istitle() and word in self.namedict:
            return self.namedict[word][0]

        # 连字符复合词：先合（去连字符查词典），再拆（按连字符切开逐段查词典）。
        # 顺序不能反：re-run 拆开会得到 RE = R EY1（do-re-mi 的 re），合起来才命中
        # 词典里的 RERUN = R IY1 R AH1 N。词典里本来就带连字符的词（E-MAIL 等 909 条）
        # 在上面第一级就返回了，走不到这里。
        if "-" in word:
            hyphen_phones, _hyphen_how = en_hyphen.resolve(word, self._dict_pron)
            if hyphen_phones:
                return hyphen_phones

        # oov 长度小于等于 3 直接读字母
        if len(word) <= 3:
            phones = []
            for w in word:
                # 单读 A 发音修正, 此处不存在大写的情况
                if w == "a":
                    phones.extend(["EY1"])
                elif not w.isalpha():
                    phones.extend([w])
                else:
                    phones.extend(self.cmu[w][0])
            return phones

        # 尝试分离所有格
        if re.match(r"^([a-z]+)('s)$", word):
            phones = self.qryword(word[:-2])[:]
            # P T K F TH HH 无声辅音结尾 's 发 ['S']
            if phones[-1] in ["P", "T", "K", "F", "TH", "HH"]:
                phones.extend(["S"])
            # S Z SH ZH CH JH 擦声结尾 's 发 ['IH1', 'Z'] 或 ['AH0', 'Z']
            elif phones[-1] in ["S", "Z", "SH", "ZH", "CH", "JH"]:
                phones.extend(["AH0", "Z"])
            # B D G DH V M N NG L R W Y 有声辅音结尾 's 发 ['Z']
            # AH0 AH1 AH2 EY0 EY1 EY2 AE0 AE1 AE2 EH0 EH1 EH2 OW0 OW1 OW2 UH0 UH1 UH2 IY0 IY1 IY2 AA0 AA1 AA2 AO0 AO1 AO2
            # ER ER0 ER1 ER2 UW0 UW1 UW2 AY0 AY1 AY2 AW0 AW1 AW2 OY0 OY1 OY2 IH IH0 IH1 IH2 元音结尾 's 发 ['Z']
            else:
                phones.extend(["Z"])
            return phones

        # 尝试进行分词，应对复合词
        comps = wordsegment.segment(word.lower())

        # 无法分词的送回去预测。预测器没见过连字符，喂给它只会得到把连字符
        # 当字母念的结果（re-run -> R IY0 AO1 R N），所以此处一律去掉连字符。
        if len(comps) == 1:
            return self.predict(en_hyphen.joined(word))

        # 可以分词的递归处理
        return [phone for comp in comps for phone in self.qryword(comp)]


_g2p = en_G2p()


def g2p(text):
    # g2p_en 整段推理，剔除不存在的arpa返回
    phone_list = _g2p(text)
    phones = [ph if ph != "<unk>" else "UNK" for ph in phone_list if ph not in [" ", "<pad>", "UW", "</s>", "<s>"]]

    return replace_phs(phones)


def get_word_candidates(o_word):
    """预览：某英文词的候选 ARPABET 读音（每个候选为空格分隔的音素串）。

    来源：多音字 homograph、CMU 词典的多条读音、姓名词典。供前端下拉选择（item 19-B）。
    无候选/异常时返回 []。
    """
    try:
        word = (o_word or "").lower()
        out = []

        def _add(pron):
            try:
                s = " ".join(pron).strip()
            except Exception:
                return
            if s and s not in out:
                out.append(s)

        if word in _g2p.homograph2features:
            pron1, pron2, _ = _g2p.homograph2features[word]
            _add(pron1)
            _add(pron2)
        if len(word) > 1 and word in _g2p.cmu:
            for pron in _g2p.cmu[word]:
                _add(pron)
        if o_word and o_word.istitle() and word in _g2p.namedict:
            for pron in _g2p.namedict[word]:
                _add(pron)
        return out
    except Exception:
        return []


def get_word_arpa(text):
    """预览：文本 -> [(word, readings(ARPABET), source)]，读音已应用覆盖（预览 == 合成）。

    对等中文 chinese2.get_word_pinyins / 日语 japanese.get_word_yomi，返回 (norm_text, tokens)。
    逐词读音推导复用 en_G2p._base_pron，保证与实际合成同源。
    """
    norm = text_normalize(text)
    ov = {}
    lex = {}
    if _pron is not None:
        try:
            ov = _pron.current_overrides("en") or {}
        except Exception:
            ov = {}
        try:
            lex = _pron.load_lexicon("en") or {}
        except Exception:
            lex = {}
    words = word_tokenize(norm)
    tagged = pos_tag(words)
    tokens = []
    occ_seen = {}
    for o_word, pos in tagged:
        occ = occ_seen.get(o_word, 0)
        occ_seen[o_word] = occ + 1
        try:
            base = _g2p._base_pron(o_word, pos)
        except Exception:
            base = [o_word]
        # 预览侧不 set_context，故这里显示 g2p 原值（词级 apply 命中已保存词典时替换）；
        # 用户在前端逐次编辑的读音由前端 state 叠加。occ 供前端定位每一次出现。
        readings = base
        if _pron is not None:
            readings = _pron.apply(o_word, base, lang="en")
        if o_word in ov:
            src = "override"
        elif o_word in lex:
            src = "lexicon"
        else:
            src = "g2p"
        tokens.append({
            "word": o_word,
            "occ": occ,
            "readings": list(readings),
            "candidates": get_word_candidates(o_word),
            "source": src,
        })
    return norm, tokens


if __name__ == "__main__":
    print(g2p("hello"))
    print(g2p(text_normalize("e.g. I used openai's AI tool to draw a picture.")))
    print(g2p(text_normalize("In this; paper, we propose 1 DSPGAN, a GAN-based universal vocoder.")))
