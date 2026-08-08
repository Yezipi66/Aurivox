# -*- coding: utf-8 -*-
"""
读音校对 / 发音修正层 (pronunciation correction)

设计目标（task6）：
  * 训练侧 (1-get-text) 与推理侧 (TextPreprocessor) 共用同一个 g2p chokepoint
    (cleaner.clean_text -> chinese2.g2p)，本模块提供一个「读音覆盖层」，让用户
    可以在**词粒度**上修正多音字读音，一次改动两端同时生效。
  * 校正单元 = jieba 分出来的「词 -> 逐字带调拼音」，位置无关，分句/分语言后依然命中，
    且可全局复用（如 乐句 -> [yue4, ju4]）。
  * 两级优先级：单次覆盖(overrides, contextvars) > 全局词典(lexicon, JSON) > g2p 原值。
  * 健壮性第一：任何异常、任何 shape 不匹配都**原样返回**，保证无覆盖时零回归。

存储：<project_root>/data/pron_lexicon/{lang}.json   形如 {"乐句": ["yue4", "ju4"]}
      （用户运行时资产，不入 git；见 .gitignore）

候选来源：G2PWModel/char_bopomofo_dict.json + bopomofo_to_pinyin_wo_tune_dict.json
          （即 g2pW 自身的候选空间，与推理消歧同源）。
"""

import os
import json
import threading
import contextvars

# 诊断开关（task6 fix）：设 PRON_DEBUG=1 时，合成期间逐词打印覆盖命中情况。
_PRON_DEBUG = os.environ.get("PRON_DEBUG", "").strip() not in ("", "0", "false", "False", "no")


def _dbg(msg):
    if _PRON_DEBUG:
        try:
            print("[pron] " + msg, flush=True)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# 路径解析（与 chinese2.py 保持一致的推导方式，且允许环境变量覆盖）
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))          # .../lib/training/gsv_code/text
# 上溯 4 层到项目根（text->gsv_code->training->lib->root），与 chinese2.py 的 project_root 一致，
# 使词典默认路径 == server.js 的 APP_DIR/data/pron_lexicon。
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(_THIS_DIR))))


def _resolve_g2pw_dir():
    env_dir = os.environ.get("g2pw_model_dir")
    if env_dir and os.path.isdir(env_dir):
        return env_dir
    self_contained = os.path.join(_THIS_DIR, "G2PWModel")
    legacy = os.path.join(_PROJECT_ROOT, "GPT_SoVITS", "text", "G2PWModel")
    for d in (self_contained, legacy):
        if os.path.exists(os.path.join(d, "char_bopomofo_dict.json")):
            return d
    return self_contained


def _lexicon_dir():
    env_dir = os.environ.get("PRON_LEXICON_DIR")
    if env_dir:
        return env_dir
    return os.path.join(_PROJECT_ROOT, "data", "pron_lexicon")


def lexicon_path(lang="zh"):
    return os.path.join(_lexicon_dir(), "{}.json".format(lang))


# ---------------------------------------------------------------------------
# 单次覆盖上下文（推理一次合成的临时修正，contextvars 线程/协程安全）
# ---------------------------------------------------------------------------
# 结构：{"zh": {"乐句": ["yue4", "ju4"]}, ...}
_ctx_overrides = contextvars.ContextVar("pron_overrides", default=None)
# 线程无关的全局兜底：推理引擎的 g2p 可能在 worker 线程执行，contextvars 未必传播到位；
# infer_server 单 worker 串行合成，故用一个受锁保护的全局作为兜底（训练为单进程同样安全）。
_global_overrides = None
_global_lock = threading.RLock()

# Position-aware Han readings are applied after language routing. The frontend
# sends keys such as {"@3:这": ["コレ"]}; the segment base lets the ordinary
# Chinese/Cantonese/Japanese cleaners resolve those absolute positions without
# changing their public APIs. Inference is single-model/locked, so the global
# fallback also covers worker-thread execution just like _global_overrides.
_segment_base_ctx = contextvars.ContextVar("pron_segment_base", default=None)
_global_segment_base = 0
_segment_base_lock = threading.RLock()


def set_segment_base(base):
    global _global_segment_base
    try:
        value = int(base or 0)
    except Exception:
        value = 0
    _segment_base_ctx.set(value)
    with _segment_base_lock:
        _global_segment_base = value


def clear_segment_base():
    _segment_base_ctx.set(None)
    global _global_segment_base
    with _segment_base_lock:
        _global_segment_base = 0


def current_segment_base():
    value = _segment_base_ctx.get()
    if value is not None:
        return value
    with _segment_base_lock:
        return _global_segment_base


def _position_reading(lang, absolute_index, char):
    """Return a position-specific reading, if one exists for this character."""
    try:
        if absolute_index is None or not char:
            return None
        # Position keys are language-scoped. Do not use _current_overrides()
        # here because its legacy single-bucket fallback intentionally merges a
        # flat/foreign bucket for old word-level recipes; that would let a JA
        # position reading leak into a ZH cleaner at the same absolute index.
        data = _ctx_overrides.get()
        if data is None:
            with _global_lock:
                data = _global_overrides
        if not data:
            return None
        if all(isinstance(value, dict) for value in data.values()):
            view = data.get(lang, {}) or {}
        else:
            view = data
        entry = view.get("@{}:{}".format(int(absolute_index), char))
        return _pick_reading(entry, None) if entry is not None else None
    except Exception:
        return None


def _normalize_overrides(overrides, lang):
    if not overrides:
        return None
    # 允许两种形态：{词:[拼音]} 或 {语言:{词:[拼音]}}
    try:
        if all(isinstance(v, dict) for v in overrides.values()):
            return {k: dict(v) for k, v in overrides.items()}
    except Exception:
        return None
    return {lang: dict(overrides)}


def set_context(overrides, lang="zh"):
    """在一次合成前调用；overrides 形如 {"乐句": ["yue4","ju4"]} 或 {lang: {...}}。"""
    norm = _normalize_overrides(overrides, lang)
    _ctx_overrides.set(norm)
    global _global_overrides
    with _global_lock:
        _global_overrides = norm
    reset_occ()
    clear_segment_base()
    _dbg("set_context lang=%s -> %s" % (lang, norm))


def clear_context():
    _ctx_overrides.set(None)
    global _global_overrides
    with _global_lock:
        _global_overrides = None
    reset_occ()
    clear_segment_base()


# ---------------------------------------------------------------------------
# 逐次出现计数（item 19-C）：同一个词在文本中多次出现时，按「出现序号」区分覆盖。
# 计数在实际合成的 g2p chokepoint（english.en_G2p.__call__）里逐词自增，
# 于每次合成开始（set_context / clear_context）归零。预览侧不走此计数——预览不
# set_context，故 resolve() 在预览期读到空覆盖、返回 g2p 原值，前端叠加自己的编辑。
# 推理单 worker 串行 + 训练单进程，故用受锁保护的全局字典（与 _global_overrides 同理）。
# ---------------------------------------------------------------------------
_occ_lock = threading.RLock()
_global_occ = {}          # {(lang, word): 已出现次数}


def reset_occ():
    global _global_occ
    with _occ_lock:
        _global_occ = {}


def next_occ(lang, word):
    """返回该 (lang, word) 到目前为止的出现序号（从 0 起），并自增。"""
    with _occ_lock:
        key = (lang, word)
        n = _global_occ.get(key, 0)
        _global_occ[key] = n + 1
        return n


def snapshot_occ():
    with _occ_lock:
        return dict(_global_occ)


def restore_occ(snap):
    """把计数器回滚到某个快照（供 TextPreprocessor 在 <6 音素重试前撤销失败那趟的计数）。"""
    global _global_occ
    with _occ_lock:
        _global_occ = dict(snap or {})


def current_overrides(lang):
    """公共封装：返回当前生效的单次覆盖桶 {word: readings}（无则 {}）。"""
    return _current_overrides(lang)


def overrides_view(lang):
    """匹配器视图：全局词典被单次覆盖叠加后的合并结果 {word: readings}。

    供逐词匹配器（如日语 NJD 覆盖 / 预览）使用：单次 overrides > 全局词典。
    与 apply() 的优先级保持一致，任何异常回落为词典本体。
    """
    try:
        merged = dict(load_lexicon(lang))
    except Exception:
        merged = {}
    try:
        merged.update(_current_overrides(lang) or {})
    except Exception:
        pass
    return merged


def _current_overrides(lang):
    data = _ctx_overrides.get()
    if data is None:
        with _global_lock:
            data = _global_overrides
    if not data:
        return {}
    # 优先精确语言桶；未命中则合并其他语言桶（容错：
    # chinese2 调 apply 时 lang 默认 "zh"，而 set_context 按 text_lang 存储，
    # 两者在 all_zh/auto/yue 等情形下可能不一致。）
    exact = data.get(lang, {}) or {}
    if len(data) == 1:
        # 只有一个语言桶，直接用它（兼容 lang 不一致）
        only = next(iter(data.values())) or {}
        if exact is not only:
            merged = dict(only)
            merged.update(exact)
            return merged
    if exact:
        return exact
    merged = {}
    for d in data.values():
        if isinstance(d, dict):
            merged.update(d)
    return merged


# ---------------------------------------------------------------------------
# 全局词典（JSON，带 mtime 缓存，改动后自动热更新）
# ---------------------------------------------------------------------------
_lex_lock = threading.RLock()
_lex_cache = {}       # lang -> {"mtime": float, "data": dict}


def load_lexicon(lang="zh"):
    path = lexicon_path(lang)
    with _lex_lock:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            _lex_cache[lang] = {"mtime": None, "data": {}}
            return {}
        cached = _lex_cache.get(lang)
        if cached and cached.get("mtime") == mtime:
            return cached["data"]
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
        # 仅保留 {str: [str,...]} 形态
        clean = {}
        for k, v in data.items():
            if isinstance(k, str) and isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v):
                clean[k] = list(v)
        _lex_cache[lang] = {"mtime": mtime, "data": clean}
        return clean


def save_lexicon(lang, data):
    path = lexicon_path(lang)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with _lex_lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        _lex_cache.pop(lang, None)
    return data


def set_lexicon_entry(lang, word, pinyins):
    data = dict(load_lexicon(lang))
    data[word] = list(pinyins)
    return save_lexicon(lang, data)


def delete_lexicon_entry(lang, word):
    data = dict(load_lexicon(lang))
    data.pop(word, None)
    return save_lexicon(lang, data)


# ---------------------------------------------------------------------------
# 核心：读音覆盖应用（注入点在 chinese2._g2p 的 correct_pronunciation 之后）
# ---------------------------------------------------------------------------
def _pick_reading(override, occ):
    """从一个覆盖项里挑出适用于第 occ 次出现的读音列表；挑不到返回 None。

    覆盖项两种形态：
      * list/tuple            —— 词级：所有出现共用同一读音（历史形态，零回归）。
      * dict {"0":[..],"*":[..]} —— 逐次（item 19-C）：按出现序号取；缺则回落 "*"（词级默认）。
    """
    if override is None:
        return None
    if isinstance(override, dict):
        if occ is not None:
            v = override.get(str(occ))
            if v is not None:
                return list(v)
        star = override.get("*")
        return list(star) if star is not None else None
    if isinstance(override, (list, tuple)):
        return list(override)
    return None


def resolve(word, readings, lang="zh", occ=None, position=None):
    """
    对一个词的读音串应用覆盖。优先级：单次 overrides > 全局词典 > 原值。
    语言无关：readings 是字符串列表（zh=逐字带调拼音；ja=[整词假名]；en=ARPABET 音素）。

    occ：该词在本次合成里的出现序号（0 起）。None=词级解析（训练/中文/占位）。
    覆盖项可为 list（词级，全部出现）或 dict（逐次；item 19-C 英文用）。单次上下文
    与全局词典分别尝试，使「只设了第 0 次」的英文词，其它次数仍回落词典/原值。

    * zh/yue：逐字拼音，仅当覆盖项与原拼音**长度一致**时才替换（保证 word2ph 对齐）。
    * ja/en：读音单元非逐字，不做长度约束，直接替换。

    任何异常 / 形状不匹配一律原样返回。无覆盖时零回归。
    """
    try:
        if not word or not readings:
            return readings
        ctx_ov = _current_overrides(lang).get(word)
        picked = _pick_reading(ctx_ov, occ)
        source = "override"
        if picked is None:
            picked = _pick_reading(load_lexicon(lang).get(word), occ)
            source = "lexicon"

        # Start from the ordinary/lexicon result, then overlay any explicit
        # absolute-position readings. Position entries are intentionally applied
        # per character so repeated Han characters remain independent.
        out = list(readings)
        word_applied = False
        if picked is not None:
            if lang in ("zh", "yue") and len(picked) != len(readings):
                _dbg("resolve word=%r override=%s SKIPPED (length %d!=%d)" % (
                    word, picked, len(picked), len(readings)))
            else:
                out = [str(p) for p in picked]
                word_applied = True

        if lang in ("zh", "yue"):
            base = current_segment_base()
            word_start = 0 if position is None else max(0, int(position))
            for i, char in enumerate(word):
                if i >= len(out):
                    break
                positional = _position_reading(lang, base + word_start + i, char)
                if positional and len(positional) == 1:
                    out[i] = str(positional[0])
                    word_applied = True
                    source = "position"

        if not word_applied:
            _dbg("resolve word=%r occ=%r -> no-override" % (word, occ))
            return readings
        _dbg("resolve word=%r occ=%r -> %s (%s)" % (word, occ, out, source))
        return out
    except Exception as _e:
        _dbg("resolve word=%r EXC %r" % (word, _e))
        return readings


def apply(word, readings, lang="zh", position=None):
    """词级读音覆盖；position 是该词在当前文本段中的字符偏移。"""
    return resolve(word, readings, lang, occ=None, position=position)


# ---------------------------------------------------------------------------
# 候选拼音（分语言渲染器：中文用 g2pW 自身候选空间；其它语言留接口）
# ---------------------------------------------------------------------------
_cand_lock = threading.RLock()
_zh_char_bopomofo = None      # 字 -> [注音,...]
_zh_bopomofo_tune = None      # 注音(无调) -> 拼音(无调)


def _load_zh_maps():
    global _zh_char_bopomofo, _zh_bopomofo_tune
    if _zh_char_bopomofo is not None:
        return
    with _cand_lock:
        if _zh_char_bopomofo is not None:
            return
        d = _resolve_g2pw_dir()
        try:
            with open(os.path.join(d, "char_bopomofo_dict.json"), "r", encoding="utf-8") as f:
                cb = json.load(f)
        except Exception:
            cb = {}
        try:
            with open(os.path.join(d, "bopomofo_to_pinyin_wo_tune_dict.json"), "r", encoding="utf-8") as f:
                tune = json.load(f)
        except Exception:
            tune = {}
        _zh_char_bopomofo = cb
        _zh_bopomofo_tune = tune


def _bopomofo_to_pinyin(bopo):
    tone = bopo[-1] if bopo and bopo[-1] in "12345" else "5"
    stem = bopo[:-1] if bopo and bopo[-1] in "12345" else bopo
    py = _zh_bopomofo_tune.get(stem)
    return (py + tone) if py else None


def get_candidates(char, lang="zh"):
    """返回某字所有可能读音（带调拼音）。中文用 g2pW 候选空间；其它语言暂返回 []。"""
    if lang not in ("zh", "yue"):
        return []
    try:
        _load_zh_maps()
        out = []
        for bopo in _zh_char_bopomofo.get(char, []):
            py = _bopomofo_to_pinyin(bopo)
            if py and py not in out:
                out.append(py)
        return out
    except Exception:
        return []


def is_polyphonic(char, lang="zh"):
    return len(get_candidates(char, lang)) > 1


# ---------------------------------------------------------------------------
# 预览：文本 -> 逐词逐字读音 + 候选 + 多音标记（供前端校对面板渲染）
# ---------------------------------------------------------------------------
# --- 单语言子预览（供分句多语预览复用；每个返回 (norm_text, tokens)）--------------
def _preview_ja(text):
    from gsv_code.text import japanese
    norm_text, yomi = japanese.get_word_yomi(text)
    toks = []
    for t in yomi:
        toks.append({
            "word": t.get("word", ""),
            "unit": "word",
            "reading": t.get("reading", ""),
            "editable": True,
            "source": t.get("source", "g2p"),
        })
    return norm_text, toks


def _preview_en(text):
    from gsv_code.text import english
    norm_text, arpa = english.get_word_arpa(text)
    toks = []
    for t in arpa:
        toks.append({
            "word": t.get("word", ""),
            "unit": "word",
            "readings": list(t.get("readings", [])),
            "candidates": list(t.get("candidates", [])),
            "editable": True,
            "source": t.get("source", "g2p"),
        })
    return norm_text, toks


def _preview_zh(text, lang):
    if lang == 'yue':
        from gsv_code.text import cantonese
        norm_text, word_pinyins = cantonese.get_word_jyutpings(text)
    else:
        from gsv_code.text import chinese2
        norm_text, word_pinyins = chinese2.get_word_pinyins(text)
    lex = load_lexicon(lang)
    ov = _current_overrides(lang)
    toks = []
    for word, pys in word_pinyins:
        chars = []
        for i, ch in enumerate(word):
            reading = pys[i] if i < len(pys) else ""
            cands = get_candidates(ch, lang)
            src = "g2p"
            if word in ov:
                src = "override"
            elif word in lex:
                src = "lexicon"
            chars.append({
                "char": ch,
                "reading": reading,
                "candidates": cands,
                "polyphonic": len(cands) > 1,
                "source": src,
            })
        toks.append({"word": word, "unit": "char", "chars": chars})
    return norm_text, toks



def _preview_ko(text):
    """Korean word preview using the same g2pk2 normalizer as synthesis."""
    import re
    from gsv_code.text import korean
    toks = []
    for m in re.finditer(r"[\uac00-\ud7a3]+|[^\uac00-\ud7a3]+", text):
        word = m.group(0)
        if not re.search(r"[\uac00-\ud7a3]", word):
            toks.append({"word": word, "unit": "word", "reading": word, "editable": False, "source": "g2p", "start": m.start(), "end": m.end()})
            continue
        try:
            reading = korean.korean_pronunciation(word)
            unresolved = not bool(reading)
        except Exception:
            reading, unresolved = "", True
        written = list(word)
        spoken = list(reading or "")
        syllables = []
        for i in range(max(len(written), len(spoken))):
            syllables.append({"written": written[i] if i < len(written) else "", "spoken": spoken[i] if i < len(spoken) else "", "changed": i >= len(written) or i >= len(spoken) or written[i] != spoken[i]})
        toks.append({"word": word, "unit": "word", "reading": reading, "editable": True, "source": "g2p", "start": m.start(), "end": m.end(), "syllables": syllables, "needsReview": unresolved or word != reading, "unresolved": unresolved})
    return text, toks

def _preview_placeholder(text):
    toks = [{"word": ch, "unit": "char", "chars": [{
        "char": ch, "reading": "", "candidates": [], "polyphonic": False, "source": "g2p",
    }]} for ch in text]
    return text, toks


def _segment_text(text, base):
    """把混合文本切成 (segLang, segText) 序列（与合成 auto 模式同源的 LangSegmenter）。

    英文/日文/韩文各自成段，其余 CJK 段归入面板基础语系 base（zh/yue/ja），
    从而把嵌在中/日文里的英文单词也暴露成可校对的 token（item 19-A）。
    失败时回退为整段单语。
    """
    try:
        from gsv_code.text.LangSegmenter import LangSegmenter
        segs = LangSegmenter.getTexts(text)  # default_lang="" -> 自动判定 zh/ja/en/ko
    except Exception:
        segs = None
    if not segs:
        return [(base, text)]
    out = []
    for seg in segs:
        try:
            slang = seg.get("lang") or base
            stext = seg.get("text") or ""
        except AttributeError:
            slang, stext = base, str(seg)
        if slang == "en":
            tgt = "en"
        elif slang == "ja":
            tgt = "ja"
        elif slang == "ko":
            tgt = "ko"
        else:
            tgt = base
        out.append((tgt, stext))
    return out or [(base, text)]


def preview(text, lang="zh"):
    """
    文本 -> 逐单元读音（供前端校对面板渲染），并保证「预览读音 == 实际合成读音」。

    item 19-A：始终按语言分句，混合文本里的英文/日文单词也会作为可校对 token 出现。
    每个 token 带 "segLang"（该 token 实际所属语言），前端据此按语言分桶存储覆盖。

    返回 {"lang", "norm_text", "tokens":[...], "langs":[...], "multilingual":bool}，
    token 依语言带 "unit" 标记：
      * zh/yue  unit="char"：{"word","unit","chars":[{char,reading,candidates,polyphonic,source}],"segLang"}
      * ja      unit="word"：{"word","unit","reading"(假名),"editable":true,"source","segLang"}
      * en      unit="word"：{"word","unit","readings"(ARPABET),"candidates":[...],"editable":true,"source","segLang"}
      * ko      unit="word"：韩文书写、实际读音、音节差异与可编辑覆盖。
    """
    result = {"lang": lang, "norm_text": "", "tokens": [], "langs": [], "multilingual": False}
    if not text:
        return result
    base = lang if lang in ("zh", "yue", "ja") else "zh"
    norm_parts = []
    tokens = []
    used = []
    for seg_lang, seg_text in _segment_text(text, base):
        if not seg_text:
            continue
        if not seg_text.strip():
            norm_parts.append(seg_text)   # 保留段间空白/标点
            continue
        try:
            if seg_lang == "en":
                nt, tk = _preview_en(seg_text)
            elif seg_lang == "ja":
                nt, tk = _preview_ja(seg_text)
            elif seg_lang in ("zh", "yue"):
                nt, tk = _preview_zh(seg_text, seg_lang)
            elif seg_lang == "ko":
                nt, tk = _preview_ko(seg_text)
            else:
                nt, tk = _preview_placeholder(seg_text)
        except Exception as e:
            _dbg("preview seg failed ({}): {!r}".format(seg_lang, e))
            nt, tk = _preview_placeholder(seg_text)
        for t in tk:
            t["segLang"] = seg_lang
        tokens.extend(tk)
        norm_parts.append(nt)
        if seg_lang not in used:
            used.append(seg_lang)
    # 逐次出现编号（item 19-C）：跨所有英文段全局重排，使 occ 与合成期的
    # english.en_G2p 全局计数一致，前端据此为「第 N 次出现」单独设置读音。
    occ_seen = {}
    for t in tokens:
        if t.get("segLang") in ("en", "ko") and (t.get("unit") == "word"):
            key = (t.get("segLang"), t.get("word", ""))
            n = occ_seen.get(key, 0)
            occ_seen[key] = n + 1
            t["occ"] = n
    result["norm_text"] = "".join(norm_parts)
    result["tokens"] = tokens
    result["langs"] = used
    result["multilingual"] = len(used) > 1
    if not any(sl in ("zh", "yue", "ja", "en", "ko") for sl in used):
        result["unsupported"] = True
    return result
