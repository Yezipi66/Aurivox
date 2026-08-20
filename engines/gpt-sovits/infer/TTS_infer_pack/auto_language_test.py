"""Dependency-free regression check for the backend Auto language router.

The full TextPreprocessor imports torch and the model packages. This test
extracts only the pure routing functions from the source, so it runs on a bare
Python with no venv, no weights and no GPU:

    python engines/gpt-sovits/infer/TTS_infer_pack/auto_language_test.py

What it does NOT cover: the language DETECTOR (fast_langdetect / split_lang)
that labels each fragment. That needs the model weights. Here the detector is
replaced by a deterministic stub that labels fragments by script alone --
Hangul is ko, Latin is en, kana is ja, Han is "zh" -- which is exactly the
information the real detector can be relied on to produce. Everything this
file asserts is therefore about OUR routing decisions, not about the detector's
accuracy. For the detector itself, run probe_auto_language.py in the venv.
"""
import ast
import re
import sys
import typing
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("TextPreprocessor.py")

# seg_reconcile and runtime_status are standard-library only, on purpose: the
# completeness guard has to be loadable in exactly this kind of bare
# environment, otherwise nothing here could check it.
_GSV_ROOT = Path(__file__).resolve().parents[2]          # engines/gpt-sovits
for _p in (str(_GSV_ROOT), str(_GSV_ROOT.parent.parent.parent)):
    if _p not in sys.path:
        sys.path.insert(0, _p)
from gsv_code.text import runtime_status  # noqa: E402
from gsv_code.text import seg_reconcile  # noqa: E402
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))

# Pull the routing layer out of the module without importing it. Names are
# listed explicitly: a wildcard would silently start (or stop) covering things.
WANTED = {
    "_KANA_RE", "_QUOTE_PAIRS", "_SENT_END", "_ML_BASE_LANGS",
    "_YUE_STRONG_RE", "_YUE_WEAK_RE", "_HAN_RE",
    "_YUE_STRONG_SCORE", "_YUE_WEAK_SCORE",
    "_YUE_GENERAL_HAN_PENALTY", "_YUE_THRESHOLD",
    "_ML_OVERRIDE_LANGS",
    "_norm_base_lang", "_has_kana", "_resolve_auto_segment_language",
    "_has_strong_yue_marker", "_yue_score", "_is_yue_clause",
    "_split_clauses", "_apply_lang_overrides", "resolve_auto_multilingual",
    "_seg_status", "segment_lossless",
}

NODES = []
FOUND = set()
for node in TREE.body:
    name = None
    if isinstance(node, ast.FunctionDef):
        name = node.name
    elif isinstance(node, ast.Assign) and len(node.targets) == 1 \
            and isinstance(node.targets[0], ast.Name):
        name = node.targets[0].id
    if name in WANTED:
        NODES.append(node)
        FOUND.add(name)

MISSING = WANTED - FOUND
if MISSING:
    raise SystemExit(
        "TextPreprocessor.py no longer defines: %s\n"
        "The router was renamed or moved. Update this test rather than "
        "deleting the check -- a test that silently covers nothing is worse "
        "than no test." % ", ".join(sorted(MISSING))
    )

NS = {
    "re": re,
    "List": typing.List,
    "LangSegmenter": None,
    "seg_reconcile": seg_reconcile,
    "runtime_status": runtime_status,
}
exec(compile(ast.fix_missing_locations(ast.Module(body=NODES, type_ignores=[])),
             str(SOURCE), "exec"), NS)

resolve_auto = NS["resolve_auto_multilingual"]
resolve_seg = NS["_resolve_auto_segment_language"]
split_clauses = NS["_split_clauses"]
yue_score = NS["_yue_score"]
is_yue = NS["_is_yue_clause"]
has_kana = NS["_has_kana"]
apply_overrides = NS["_apply_lang_overrides"]


# --- stub detector ----------------------------------------------------------
# Labels a fragment by script only. This mirrors what the real detector can
# actually know: Hangul/Latin/kana are unambiguous, Han is not.
_HANGUL = re.compile(r"[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]")
_KANA = re.compile(r"[\u3040-\u309F\u30A0-\u30FF]")
_LATIN = re.compile(r"[A-Za-z]")
_HAN = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF]")


def _script(ch):
    if _HANGUL.match(ch):
        return "ko"
    if _KANA.match(ch):
        return "ja"
    if _LATIN.match(ch):
        return "en"
    if _HAN.match(ch):
        return "zh"
    return None


def stub_get_texts(text):
    """Split into maximal same-script runs; punctuation joins the run before it."""
    out = []
    for ch in text:
        s = _script(ch)
        if s is None:
            if out:
                out[-1]["text"] += ch
                continue
            s = "zh"
        if out and out[-1]["lang"] == s:
            out[-1]["text"] += ch
        else:
            out.append({"lang": s, "text": ch})
    return out


def route(text, base="zh"):
    """(langlist, textlist) -> compact list of (lang, text) for readable asserts."""
    langs, texts = resolve_auto(text, base, get_texts=stub_get_texts)
    return list(zip(langs, texts))


def langs_of(text, base="zh"):
    return [lang for lang, _ in route(text, base)]


class ClauseSplitting(unittest.TestCase):
    """Clause boundaries decide how far a language signal can spread."""

    def test_comma_bounds_a_signal(self):
        # Without the comma boundary, one kana would recolour the whole line.
        self.assertEqual(
            split_clauses("\u6211\u559c\u6b22\u4f60\uff0c\u3042\u306a\u305f\u304c\u597d\u304d\u3002"),
            ["\u6211\u559c\u6b22\u4f60\uff0c", "\u3042\u306a\u305f\u304c\u597d\u304d\u3002"],
        )

    def test_quoted_span_is_its_own_clause(self):
        self.assertEqual(
            split_clauses("\u4ed6\u8bf4\u300c\u3053\u3093\u306b\u3061\u306f\u300d\u5c31\u8d70\u4e86"),
            ["\u4ed6\u8bf4", "\u300c\u3053\u3093\u306b\u3061\u306f\u300d", "\u5c31\u8d70\u4e86"],
        )

    def test_unclosed_quote_does_not_swallow_the_rest(self):
        # A stray opening bracket must not turn everything after it into one clause.
        self.assertEqual(
            split_clauses("\u4ed6\u8bf4\u300c\u4f60\u597d\u3002\u518d\u89c1\u3002"),
            ["\u4ed6\u8bf4\u300c\u4f60\u597d\u3002", "\u518d\u89c1\u3002"],
        )


class KanaContagion(unittest.TestCase):
    """Kana in a clause makes that clause's shared Han read as Japanese.

    This is intended: 'Han in a Japanese sentence' is the common case. The
    tests below pin down HOW FAR it spreads, because the failure mode is a
    Chinese sentence read with Japanese pronunciation.
    """

    def test_kana_clause_reads_its_han_as_japanese(self):
        self.assertEqual(langs_of("\u4eca\u65e5\u306f\u3044\u3044\u5929\u6c17\u3067\u3059\u306d\u3002"), ["ja"])

    def test_kana_does_not_cross_a_comma(self):
        got = route("\u6211\u559c\u6b22\u4f60\uff0c\u3042\u306a\u305f\u3082\u597d\u304d\u3002")
        self.assertEqual(got[0], ("zh", "\u6211\u559c\u6b22\u4f60\uff0c"))
        self.assertEqual(got[-1][0], "ja")

    def test_kana_does_not_cross_a_quote(self):
        got = route("\u4ed6\u8bf4\u300c\u3053\u3093\u306b\u3061\u306f\u300d\u5c31\u8d70\u4e86\u3002")
        self.assertEqual(got[0], ("zh", "\u4ed6\u8bf4"))
        self.assertEqual(got[-1], ("zh", "\u5c31\u8d70\u4e86\u3002"))

    def test_kana_DOES_spread_inside_one_clause(self):
        # Documented, deliberate, and the most likely thing to sound wrong:
        # a Chinese clause with a single katakana loanword is read as Japanese
        # end to end. There is no comma here, so nothing bounds it.
        self.assertEqual(
            langs_of("\u6211\u5f88\u559c\u6b22\u65e5\u672c\u7684\u30a2\u30cb\u30e1\u6587\u5316"),
            ["ja"],
        )


class Cantonese(unittest.TestCase):
    """Cantonese is detected from a fixed list of marker characters."""

    def test_marker_dense_clause_is_cantonese(self):
        self.assertTrue(is_yue("\u4f62\u54cb\u55ba\u5497\u5462\u5566"))

    def test_traditional_chinese_alone_is_not_cantonese(self):
        # Traditional script says nothing about the spoken language.
        self.assertFalse(is_yue("\u6211\u5011\u4eca\u5929\u8981\u53bb\u81fa\u7063\u65c5\u884c"))

    def test_a_single_marker_in_a_long_clause_is_diluted(self):
        # 1 strong marker = 2.0, minus 0.05 per Han char. A long clause needs
        # more than one marker. Pinned so the constants cannot drift unnoticed.
        long_clause = "\u55ba" + "\u4e2d" * 20
        self.assertLess(yue_score(long_clause), 1.5)
        self.assertFalse(is_yue(long_clause))

    def test_a_single_marker_in_a_short_clause_is_enough(self):
        self.assertTrue(is_yue("\u4f62\u55ba\u5497"))

    def test_cantonese_clause_routes_its_han_to_yue(self):
        self.assertEqual(langs_of("\u4f62\u54cb\u55ba\u5497\u5462\u5566"), ["yue"])

    def test_cantonese_and_mandarin_clauses_coexist(self):
        got = route("\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c\u4f62\u54cb\u55ba\u5497\u5462\u5566\u3002")
        self.assertEqual([lang for lang, _ in got], ["zh", "yue"])


class Korean(unittest.TestCase):
    """Hangul is unambiguous and must never be overridden by a clause default."""

    def test_hangul_stays_korean_in_a_chinese_clause(self):
        self.assertEqual(
            route("\u6211\u8bf4\uc548\ub155\ud558\uc138\uc694\u597d\u4e0d\u597d"),
            [("zh", "\u6211\u8bf4"), ("ko", "\uc548\ub155\ud558\uc138\uc694"), ("zh", "\u597d\u4e0d\u597d")],
        )

    def test_hangul_stays_korean_in_a_japanese_clause(self):
        # The clause contains kana, so cjk_default is ja. Hangul must survive it.
        self.assertIn("ko", langs_of("\u79c1\u306f\uc548\ub155\ud558\uc138\uc694\u3068\u8a00\u3044\u307e\u3057\u305f"))

    def test_hanja_in_a_korean_line_is_NOT_read_as_korean(self):
        # Known limitation, asserted so it is a decision and not a surprise:
        # Han characters in Korean text fall to the base language, because
        # nothing in the clause marks them as Korean.
        self.assertEqual(
            route("\ud55c\uad6d\uc5b4\ub294\u97d3\u570b\u8a9e\uc785\ub2c8\ub2e4"),
            [("ko", "\ud55c\uad6d\uc5b4\ub294"), ("zh", "\u97d3\u570b\u8a9e"), ("ko", "\uc785\ub2c8\ub2e4")],
        )


class English(unittest.TestCase):
    def test_latin_stays_english_between_han(self):
        self.assertEqual(
            route("\u6211\u7528ChatGPT\u5199\u4ee3\u7801"),
            [("zh", "\u6211\u7528"), ("en", "ChatGPT"), ("zh", "\u5199\u4ee3\u7801")],
        )

    def test_latin_stays_english_inside_a_kana_clause(self):
        self.assertIn("en", langs_of("\u79c1\u306fPython\u3092\u4f7f\u3044\u307e\u3059"))


class BaseLanguageFallback(unittest.TestCase):
    """Han with no signal at all follows the voice's own base language."""

    def test_plain_han_follows_base(self):
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base="zh"), ["zh"])
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base="yue"), ["yue"])
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base="ja"), ["ja"])

    def test_unknown_base_falls_back_to_chinese(self):
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base="fr"), ["zh"])
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base=""), ["zh"])
        self.assertEqual(langs_of("\u4eca\u5929\u5929\u6c14\u5f88\u597d", base=None), ["zh"])

    def test_prefixed_base_names_are_accepted(self):
        # Voice metadata stores all_zh / auto_zh_ja_yue style values.
        self.assertEqual(langs_of("\u4eca\u5929", base="all_yue"), ["yue"])

    def test_detector_ja_without_kana_is_overruled(self):
        # The detector cannot tell Chinese Han from Japanese Han. When it
        # guesses ja on a kana-free fragment, the clause default wins.
        self.assertEqual(resolve_seg("ja", "\u4eca\u65e5", "zh"), "zh")
        self.assertEqual(resolve_seg("ja", "\u4eca\u65e5\u306f", "zh"), "ja")


class FiveLanguageMix(unittest.TestCase):
    """One line containing all five, to pin the interaction."""

    def test_all_five_in_one_line(self):
        text = ("\u4eca\u5929\u5929\u6c14\u5f88\u597d\uff0c"          # zh
                "\u79c1\u306f\u5143\u6c17\u3067\u3059\uff0c"          # ja (kana)
                "\u4f62\u54cb\u55ba\u5497\u5462\u5566\uff0c"          # yue (markers)
                "\uc548\ub155\ud558\uc138\uc694\uff0c"                # ko (hangul)
                "nice to meet you\u3002")                             # en
        self.assertEqual(langs_of(text), ["zh", "ja", "yue", "ko", "en"])


class PositionOverrides(unittest.TestCase):
    """The manual per-character override, applied after routing."""

    def test_override_forces_one_position(self):
        langs, texts = apply_overrides(["zh"], ["\u4eca\u5929\u5929\u6c14"], {"@0": "ja"})
        self.assertEqual(list(zip(langs, texts)), [("ja", "\u4eca"), ("zh", "\u5929\u5929\u6c14")])

    def test_character_global_keys_are_ignored(self):
        # Only @index keys are honoured; a bare character key would hit every
        # occurrence of that character, which the picker never promises.
        langs, texts = apply_overrides(["zh"], ["\u4eca\u5929"], {"\u4eca": "ja"})
        self.assertEqual(list(zip(langs, texts)), [("zh", "\u4eca\u5929")])

    def test_override_to_an_unsupported_language_is_ignored(self):
        langs, texts = apply_overrides(["zh"], ["\u4eca\u5929"], {"@0": "ko"})
        self.assertEqual(list(zip(langs, texts)), [("zh", "\u4eca\u5929")])

    def test_override_stranded_on_a_kana_is_dropped(self):
        # r12b-fix6. Overrides are stored as absolute character indices and
        # persisted, so an override made on an earlier text lands on whatever
        # character now sits at that index. The user-reported case: a Japanese
        # line whose first character こ was read as Chinese, with nothing lit up
        # in the picker to explain why. A Han-language override on a non-Han
        # character is meaningless by definition, so it is dropped here.
        #
        # This must stay enforced on the engine side and not only in the web
        # client: the same payload can arrive from a recipe saved before the fix.
        langs, texts = apply_overrides(["ja"], ["\u3053\u3093\u306b\u3061\u306f"], {"@0": "zh"})
        self.assertEqual(list(zip(langs, texts)), [("ja", "\u3053\u3093\u306b\u3061\u306f")])

    def test_override_stranded_on_a_latin_letter_or_digit_is_dropped(self):
        langs, texts = apply_overrides(["en"], ["ab1"], {"@0": "zh", "@2": "ja"})
        self.assertEqual(list(zip(langs, texts)), [("en", "ab1")])

    def test_override_past_the_end_of_the_text_is_dropped(self):
        langs, texts = apply_overrides(["zh"], ["\u4eca\u5929"], {"@9": "ja"})
        self.assertEqual(list(zip(langs, texts)), [("zh", "\u4eca\u5929")])

    def test_a_live_override_still_applies_next_to_a_dropped_one(self):
        # Discriminating counter-proof: dropping the stranded entry must not
        # take the valid entry in the same payload down with it.
        langs, texts = apply_overrides(
            ["ja"], ["\u3053\u306e\u6f22\u5b57"], {"@0": "zh", "@2": "zh"})
        self.assertEqual(
            list(zip(langs, texts)),
            [("ja", "\u3053\u306e"), ("zh", "\u6f22"), ("ja", "\u5b57")])

    def test_han_class_matches_the_web_picker(self):
        # The picker offers a character for selection when web/src/lib/
        # hanLanguage.js calls it Han. If this side disagrees the selection is
        # dropped with no error on either side. U+F914 is a CJK compatibility
        # ideograph, present in the web regex but missing here until 2026-08-17.
        langs, texts = apply_overrides(["ja"], ["\uf914"], {"@0": "zh"})
        self.assertEqual(list(zip(langs, texts)), [("zh", "\uf914")])


class TextIsNeverLost(unittest.TestCase):
    """The router's output text must equal its input text.

    The real detector drops characters -- a comma between digits and Han, the
    space after a comma in Korean, the space after a question mark in English
    were all observed on the user's machine. The script stub above cannot
    reproduce that (it returns everything it is given), so these tests drive
    the router with a stub that deliberately drops what the real one drops.
    Without the positive control the check would pass on a broken router.
    """

    def lossy(self, dropped):
        """A detector stub that swallows every character in `dropped`.

        It drops them at piece boundaries, which is the shape the real loss
        has: the probe lost a comma between two runs and a space between two
        runs, never a character from the middle of one.
        """
        splitter = re.compile("[" + re.escape(dropped) + "]")

        def stub(text):
            out = []
            for piece in splitter.split(text):
                if piece:
                    out.extend(stub_get_texts(piece))
            return out
        return stub

    def route_with(self, text, stub, base="zh"):
        langs, texts = resolve_auto(text, base, get_texts=stub)
        return "".join(texts)

    def test_the_stub_really_does_lose_characters(self):
        # Positive control: if this ever stops dropping, every assert below
        # would pass for the wrong reason.
        stub = self.lossy(",\uff0c")
        raw = "".join(seg["text"] for seg in stub("a,b"))
        self.assertEqual(raw, "ab")
        self.assertNotIn(",", raw)

    def test_a_dropped_comma_comes_back(self):
        text = "\u4ed6\u4eca\u5e7425\u5c81\uff0c\u8eab\u9ad8178\u5398\u7c73\u3002"
        self.assertEqual(self.route_with(text, self.lossy("\uff0c")), text)

    def test_a_dropped_space_comes_back(self):
        text = "Wait what No way"
        self.assertEqual(self.route_with(text, self.lossy(" ")), text)

    def test_the_loss_is_recorded_as_a_status_bit(self):
        runtime_status.clear()
        try:
            self.route_with("a b c", self.lossy(" "))
            self.assertTrue(
                runtime_status.active(runtime_status.SEGMENT_TEXT_LOST),
                "characters were restored but nothing was recorded",
            )
        finally:
            runtime_status.clear()

    def test_a_clean_detector_records_nothing(self):
        runtime_status.clear()
        try:
            route("\u4f60\u597dworld")
            self.assertFalse(runtime_status.active())
        finally:
            runtime_status.clear()


if __name__ == "__main__":
    unittest.main(verbosity=2)
