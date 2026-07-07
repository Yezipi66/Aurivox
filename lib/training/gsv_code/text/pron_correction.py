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
    _dbg("set_context lang=%s -> %s" % (lang, norm))


def clear_context():
    _ctx_overrides.set(None)
    global _global_overrides
    with _global_lock:
        _global_overrides = None


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
def apply(word, readings, lang="zh"):
    """
    对一个词的读音串应用覆盖。优先级：单次 overrides > 全局词典 > 原值。
    语言无关：readings 是一个字符串列表（zh=逐字带调拼音；ja=[整词假名]；en=ARPABET 音素）。

    * zh/yue：逐字拼音，仅当覆盖项与原拼音**长度一致**时才替换
      （保证 word2ph 对齐不被破坏）。
    * ja/en：读音单元非「逐字」（ja 整词一串假名；en 一词多音素），不做长度约束，
      直接以覆盖项替换（无 word2ph 对齐依赖）。

    任何异常 / 形状不匹配一律原样返回。无覆盖时零回归。
    """
    try:
        if not word or not readings:
            return readings
        source = "override"
        override = _current_overrides(lang).get(word)
        if override is None:
            override = load_lexicon(lang).get(word)
            source = "lexicon"
        if override is None:
            _dbg("apply word=%r in=%s -> no-override" % (word, list(readings)))
            return readings
        if lang in ("zh", "yue") and len(override) != len(readings):
            # zh/yue 逐字对齐：长度不一致（分词边界差异等）——跳过以免破坏 word2ph
            _dbg("apply word=%r in=%s override=%s SKIPPED (length %d!=%d)" % (
                word, list(readings), list(override), len(readings), len(override)))
            return readings
        out = [str(p) for p in override]
        _dbg("apply word=%r in=%s -> %s (%s)" % (word, list(readings), out, source))
        return out
    except Exception as _e:
        _dbg("apply word=%r EXC %r" % (word, _e))
        return readings


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
def preview(text, lang="zh"):
    """
    文本 -> 逐单元读音（供前端校对面板渲染），并保证「预览读音 == 实际合成读音」。

    返回 {"lang", "norm_text", "tokens":[...]}，token 依语言带 "unit" 标记：
      * zh/yue  unit="char"：{"word","unit","chars":[{char,reading,candidates,polyphonic,source}]}
                （逐字，可从候选下拉选读音）。
      * ja      unit="word"：{"word","unit","reading"(假名),"editable":true,"source"}
                （逐词，直接改写正确假名；无候选下拉）。
      * en      unit="word"：{"word","unit","readings"(ARPABET 列表),"editable":true,"source"}
                （逐词，直接改写音标）。
      * ko/其它 占位（unsupported=true）。
    """
    result = {"lang": lang, "norm_text": "", "tokens": []}
    if not text:
        return result
    if lang == "ja":
        try:
            from gsv_code.text import japanese
            norm_text, yomi = japanese.get_word_yomi(text)
        except Exception as e:
            result["error"] = "preview failed: {!r}".format(e)
            return result
        result["norm_text"] = norm_text
        for t in yomi:
            result["tokens"].append({
                "word": t.get("word", ""),
                "unit": "word",
                "reading": t.get("reading", ""),
                "editable": True,
                "source": t.get("source", "g2p"),
            })
        return result
    if lang == "en":
        try:
            from gsv_code.text import english
            norm_text, arpa = english.get_word_arpa(text)
        except Exception as e:
            result["error"] = "preview failed: {!r}".format(e)
            return result
        result["norm_text"] = norm_text
        for t in arpa:
            result["tokens"].append({
                "word": t.get("word", ""),
                "unit": "word",
                "readings": list(t.get("readings", [])),
                "editable": True,
                "source": t.get("source", "g2p"),
            })
        return result
    if lang in ("zh", "yue"):
        try:
            from gsv_code.text import chinese2
            norm_text, word_pinyins = chinese2.get_word_pinyins(text)
        except Exception as e:
            result["error"] = "preview failed: {!r}".format(e)
            return result
        result["norm_text"] = norm_text
        lex = load_lexicon(lang)
        ov = _current_overrides(lang)
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
            result["tokens"].append({"word": word, "unit": "char", "chars": chars})
        return result
    # 其它语言：占位（Phase 3/4 逐语言补全；ko 标 untested）
    result["norm_text"] = text
    result["tokens"] = [{"word": ch, "chars": [{
        "char": ch, "reading": "", "candidates": [], "polyphonic": False, "source": "g2p",
    }]} for ch in text]
    result["unsupported"] = True
    return result
