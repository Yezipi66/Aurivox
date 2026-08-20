# -*- coding: utf-8 -*-
"""Guards for the four silent-failure fixes in the text front end (r12b-fix10).

Imports nothing outside the standard library: every module under test was
written to be loadable without torch, nltk, wordsegment or any model weights,
precisely so that these rules can be checked.

What is guarded here:
  1. seg_reconcile  -- the segmenter's pieces must add back up to its input.
  2. runtime_status -- every silent degradation leaves a readable status bit.
  3. en_hyphen      -- join before split, and never hand a hyphen to prediction.
  4. wiring         -- the engine files actually call all of the above. A rule
                       that is only enforced in a helper nobody calls is not
                       enforced.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GSV_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))          # engines/gpt-sovits
PKG_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))    # holds gsv_code/
for p in (PKG_ROOT, GSV_ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)

from gsv_code.text import en_hyphen  # noqa: E402
from gsv_code.text import runtime_status  # noqa: E402
from gsv_code.text import seg_reconcile  # noqa: E402

CHINESE2 = os.path.join(HERE, "chinese2.py")
ENGLISH = os.path.join(HERE, "english.py")
PREPROCESSOR = os.path.join(
    GSV_ROOT, "infer", "TTS_infer_pack", "TextPreprocessor.py"
)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


# --------------------------------------------------------------------------
# 1. seg_reconcile: the three real losses observed on the user's machine
# --------------------------------------------------------------------------
class ReconcileTest(unittest.TestCase):
    def check(self, clause, pieces):
        segs = [{"lang": lang, "text": text} for lang, text in pieces]
        out = seg_reconcile.reconcile(clause, segs)
        self.assertEqual(
            "".join(s["text"] for s in out),
            clause,
            "reconcile did not restore the clause",
        )
        return out

    def test_probe_case_1_comma_between_digits_and_han(self):
        # 他今年25岁，身高178厘米。 -> the comma vanished
        self.check(
            "他今年25岁，身高178厘米。",
            [("zh", "他今年"), ("zh", "25"), ("zh", "岁"), ("zh", "身高178厘米。")],
        )

    def test_probe_case_2_korean_loses_the_space_after_a_comma(self):
        self.check(
            "안녕하세요, 오늘 날씨가 정말 좋네요.",
            [("ko", "안녕하세요,"), ("ko", "오늘 날씨가 정말 좋네요.")],
        )

    def test_probe_case_3_english_loses_the_space_after_a_question_mark(self):
        self.check(
            "Wait... what? No way!",
            [("en", "Wait... what?"), ("en", "No way!")],
        )

    def test_a_lossless_split_is_returned_untouched(self):
        segs = [{"lang": "zh", "text": "你好"}, {"lang": "en", "text": "world"}]
        out = seg_reconcile.reconcile("你好world", segs)
        self.assertIs(out[0], segs[0])
        self.assertIs(out[1], segs[1])

    def test_a_recovered_run_joins_the_piece_on_its_left(self):
        out = self.check("A, B", [("en", "A,"), ("en", "B")])
        self.assertEqual(out[0]["text"], "A, ")
        self.assertEqual(out[1]["text"], "B")

    def test_a_run_lost_before_the_first_piece_leads_it(self):
        out = self.check("  hi", [("en", "hi")])
        self.assertEqual(out[0]["text"], "  hi")

    def test_a_run_lost_after_the_last_piece_trails_it(self):
        out = self.check("hi。", [("en", "hi")])
        self.assertEqual(out[-1]["text"], "hi。")

    def test_languages_are_never_changed(self):
        out = self.check(
            "你好, world", [("zh", "你好,"), ("en", "world")]
        )
        self.assertEqual([s["lang"] for s in out], ["zh", "en"])

    def test_rewritten_text_is_reported_not_guessed_at(self):
        runtime_status.clear()
        seen = []
        segs = [{"lang": "en", "text": "HELLO"}]
        out = seg_reconcile.reconcile(
            "hello", segs, on_status=lambda k, d: seen.append(k)
        )
        self.assertEqual(seen, ["unalignable"])
        self.assertEqual(out, segs, "unalignable input must be left alone")

    def test_is_lossless_actually_detects_a_loss(self):
        # The positive control: the helper the other tests lean on has to be
        # able to fail.
        self.assertFalse(
            seg_reconcile.is_lossless("a,b", [{"lang": "x", "text": "ab"}])
        )
        self.assertTrue(
            seg_reconcile.is_lossless("ab", [{"lang": "x", "text": "ab"}])
        )


# --------------------------------------------------------------------------
# 2. runtime_status
# --------------------------------------------------------------------------
class RuntimeStatusTest(unittest.TestCase):
    def setUp(self):
        runtime_status.clear()

    def tearDown(self):
        runtime_status.clear()

    def test_nothing_recorded_means_not_degraded(self):
        self.assertFalse(runtime_status.active())
        self.assertEqual(runtime_status.summary(), "no degradation recorded")

    def test_a_note_is_readable_afterwards(self):
        runtime_status.note("chinese2", runtime_status.G2PW_IMPORT_FAILED, "boom")
        self.assertTrue(runtime_status.active())
        self.assertTrue(runtime_status.active(runtime_status.G2PW_IMPORT_FAILED))
        self.assertFalse(runtime_status.active(runtime_status.SEGMENT_TEXT_LOST))
        rec = runtime_status.get(runtime_status.G2PW_IMPORT_FAILED)
        self.assertEqual(rec["component"], "chinese2")
        self.assertEqual(rec["detail"], "boom")
        self.assertEqual(rec["count"], 1)

    def test_repeats_are_counted_not_piled_up(self):
        for _ in range(2000):
            runtime_status.note("chinese2", runtime_status.PRON_OVERRIDE_LENGTH_MISMATCH, "x")
        self.assertEqual(len(runtime_status.snapshot()), 1)
        self.assertEqual(
            runtime_status.get(runtime_status.PRON_OVERRIDE_LENGTH_MISMATCH)["count"],
            2000,
        )

    def test_extra_fields_survive(self):
        runtime_status.note("chinese2", runtime_status.G2PW_MODEL_LOAD_FAILED, "d", g2pw_model_dir="D:/x")
        self.assertEqual(
            runtime_status.get(runtime_status.G2PW_MODEL_LOAD_FAILED)["g2pw_model_dir"],
            "D:/x",
        )

    def test_it_is_readable_from_another_process_through_a_file(self):
        import json
        import tempfile

        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        os.environ["TTS_STATUS_FILE"] = path
        try:
            runtime_status.note("chinese2", runtime_status.G2PW_IMPORT_FAILED, "boom")
            with open(path, encoding="utf-8") as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
            self.assertEqual(len(lines), 1)
            self.assertTrue(lines[0].startswith(runtime_status.MARKER))
            payload = json.loads(lines[0][len(runtime_status.MARKER):])
            self.assertEqual(payload["code"], runtime_status.G2PW_IMPORT_FAILED)
        finally:
            os.environ.pop("TTS_STATUS_FILE", None)
            os.unlink(path)

    def test_a_broken_status_file_never_breaks_synthesis(self):
        os.environ["TTS_STATUS_FILE"] = os.path.join(HERE, "no", "such", "dir", "s.jsonl")
        try:
            runtime_status.note("chinese2", runtime_status.G2PW_IMPORT_FAILED, "boom")
        finally:
            os.environ.pop("TTS_STATUS_FILE", None)
        self.assertTrue(runtime_status.active(runtime_status.G2PW_IMPORT_FAILED))

    def test_summary_names_every_degradation(self):
        runtime_status.note("chinese2", runtime_status.G2PW_IMPORT_FAILED, "a")
        runtime_status.note("LangSegmenter", runtime_status.SEGMENT_TEXT_LOST, "b")
        text = runtime_status.summary()
        self.assertIn(runtime_status.G2PW_IMPORT_FAILED, text)
        self.assertIn(runtime_status.SEGMENT_TEXT_LOST, text)


# --------------------------------------------------------------------------
# 3. en_hyphen
# --------------------------------------------------------------------------
# A stand-in for cmudict holding only what these cases need. RERUN is entry
# 100769 of the real cmudict.rep; RE-RUN is not in it, which is the whole bug.
FAKE_DICT = {
    "rerun": ["R", "IY1", "R", "AH1", "N"],
    "re": ["R", "EY1"],
    "run": ["R", "AH1", "N"],
    "well": ["W", "EH1", "L"],
    "known": ["N", "OW1", "N"],
}


def fake_lookup(word):
    return FAKE_DICT.get(word)


class HyphenTest(unittest.TestCase):
    def test_re_run_joins_and_does_not_split(self):
        phones, how = en_hyphen.resolve("re-run", fake_lookup)
        self.assertEqual(how, en_hyphen.JOIN)
        self.assertEqual(phones, ["R", "IY1", "R", "AH1", "N"])

    def test_the_split_answer_for_re_run_is_the_wrong_one(self):
        # The positive control for the ordering rule: if join were ever moved
        # after split, this is the answer the engine would produce instead --
        # R EY1, the re of do-re-mi.
        self.assertEqual(fake_lookup("re") + fake_lookup("run"),
                         ["R", "EY1", "R", "AH1", "N"])
        self.assertNotEqual(
            en_hyphen.resolve("re-run", fake_lookup)[0],
            ["R", "EY1", "R", "AH1", "N"],
        )

    def test_split_answers_when_the_joined_spelling_is_unknown(self):
        phones, how = en_hyphen.resolve("well-known", fake_lookup)
        self.assertEqual(how, en_hyphen.SPLIT)
        self.assertEqual(phones, ["W", "EH1", "L", "N", "OW1", "N"])

    def test_an_unknown_compound_is_handed_back_not_invented(self):
        self.assertEqual(en_hyphen.resolve("zzz-qqq", fake_lookup), (None, None))

    def test_a_word_without_a_hyphen_is_not_this_rule_s_business(self):
        self.assertEqual(en_hyphen.resolve("rerun", fake_lookup), (None, None))

    def test_degenerate_hyphens_do_not_crash(self):
        for word in ("-", "--", "-run", "run-", "--run--"):
            phones, how = en_hyphen.resolve(word, fake_lookup)
            if word.strip("-"):
                self.assertEqual(phones, ["R", "AH1", "N"], word)
            else:
                self.assertIsNone(phones, word)

    def test_joined_removes_every_hyphen(self):
        self.assertEqual(en_hyphen.joined("a-b--c"), "abc")
        self.assertEqual(en_hyphen.split_parts("a-b--c"), ["a", "b", "c"])


# --------------------------------------------------------------------------
# 4. wiring: the engine has to actually call these
# --------------------------------------------------------------------------
class WiringTest(unittest.TestCase):
    """Text guards.

    Each check is written so that it goes red if the call is deleted, not
    merely if a comment is reworded: the first version of a guard like this
    passed against four forged violations because the keyword it looked for
    also appeared in a comment.
    """

    def test_english_consults_the_hyphen_rule_before_prediction(self):
        src = read(ENGLISH)
        self.assertIn("from gsv_code.text import en_hyphen", src)
        self.assertIn("en_hyphen.resolve(word, self._dict_pron)", src)
        rule = src.index("en_hyphen.resolve(word, self._dict_pron)")
        predict = src.index("self.predict(")
        self.assertLess(rule, predict, "the hyphen rule must run before prediction")

    def test_prediction_never_receives_a_hyphen(self):
        src = read(ENGLISH)
        self.assertIn("self.predict(en_hyphen.joined(word))", src)
        self.assertNotIn("return self.predict(word)", src)

    def test_the_hyphen_rule_only_ever_reads_the_dictionary(self):
        src = read(ENGLISH)
        start = src.index("def _dict_pron")
        body = src[start:src.index("def qryword")]
        self.assertIn("self.cmu", body)
        self.assertNotIn("predict", body)
        self.assertNotIn("wordsegment", body)

    def test_no_segmenter_call_bypasses_the_completeness_guard(self):
        src = read(PREPROCESSOR)
        self.assertIn("def segment_lossless", src)
        self.assertIn("seg_reconcile.reconcile", src)
        body = src[src.index("def segment_lossless"):]
        self.assertNotIn(
            "for tmp in LangSegmenter.getTexts(",
            src,
            "a segmenter call is still bypassing segment_lossless",
        )
        self.assertIn("LangSegmenter.getTexts", body)

    def test_every_silent_degradation_carries_a_status_bit(self):
        src = read(CHINESE2)
        for code in (
            "runtime_status.G2PW_IMPORT_FAILED",
            "runtime_status.G2PW_MODEL_LOAD_FAILED",
            "runtime_status.PRON_OVERLAY_UNAVAILABLE",
            "runtime_status.PRON_OVERRIDE_LENGTH_MISMATCH",
            "runtime_status.ORT_CUDA_DLL_DIR_FAILED",
        ):
            self.assertIn(code, src, code + " has no status bit in chinese2.py")

    def test_both_ways_of_dropping_a_reading_override_are_reported(self):
        # The pypinyin branch discards a user's proofread reading in two
        # different places -- syllable count mismatch, and an override that is
        # not spelled as pinyin. Counting matters: asserting only that the code
        # name appears somewhere passes with one of the two deleted.
        src = read(CHINESE2)
        start = src.index("if _pron is not None:")
        block = src[start:src.index("sub_finals = tone_modifier.modified_tone", start)]
        self.assertEqual(
            block.count("runtime_status.note("), 2,
            "every path that throws away a reading override needs its own "
            "status bit; found a different number of them",
        )
        self.assertEqual(
            block.count("runtime_status.PRON_OVERRIDE_LENGTH_MISMATCH"), 2
        )

    def test_every_status_note_uses_a_declared_code(self):
        # A note() carrying a bare string would set a bit nothing can match on.
        src = read(CHINESE2)
        self.assertEqual(
            src.count("runtime_status.note("),
            sum(src.count("runtime_status." + name) for name in (
                "G2PW_IMPORT_FAILED",
                "G2PW_MODEL_LOAD_FAILED",
                "PRON_OVERLAY_UNAVAILABLE",
                "PRON_OVERRIDE_LENGTH_MISMATCH",
                "ORT_CUDA_DLL_DIR_FAILED",
            )),
            "a note() in chinese2.py is not using a declared status code",
        )

    def test_no_bare_swallowed_exception_is_left_in_chinese2(self):
        src = read(CHINESE2)
        self.assertNotIn("    except Exception:\n        pass", src)

    def test_the_status_codes_the_wiring_names_all_exist(self):
        # Without this, a typo in a code name would make the check above pass
        # against a constant that does not exist.
        for name in (
            "G2PW_IMPORT_FAILED",
            "G2PW_MODEL_LOAD_FAILED",
            "PRON_OVERLAY_UNAVAILABLE",
            "PRON_OVERRIDE_LENGTH_MISMATCH",
            "ORT_CUDA_DLL_DIR_FAILED",
            "SEGMENT_TEXT_LOST",
            "SEGMENT_UNALIGNABLE",
        ):
            self.assertTrue(hasattr(runtime_status, name), name)

    def test_the_preprocessor_records_lost_characters_as_a_status_bit(self):
        src = read(PREPROCESSOR)
        self.assertIn("runtime_status.SEGMENT_TEXT_LOST", src)
        self.assertIn("runtime_status.SEGMENT_UNALIGNABLE", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
