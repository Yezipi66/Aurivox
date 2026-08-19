# -*- coding: utf-8 -*-
"""chinese2.py 的 g2pW 标点还原层 —— 零依赖回归测试。

chinese2.py 本身要拉起 torch / transformers / g2pW 权重才能 import，这台机器上
跑测试时通常一样都没有。所以这里用 ast 把要测的几个纯函数从源码里摘出来单独执行，
与 auto_language_test.py 的做法一致。

被测对象：
    _G2PW_INPUT_PUNCT / _G2PW_OUTPUT_PUNCT
    to_g2pw_input(seg)
    from_g2pw_result(pinyins)

背景见 gsv_code/LOCAL-CHANGES.md「g2pW 输入标点还原」一条。
"""
import ast
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "chinese2.py")

WANTED_FUNCS = {"to_g2pw_input", "from_g2pw_result"}
WANTED_NAMES = {"_G2PW_INPUT_PUNCT", "_G2PW_OUTPUT_PUNCT"}


def _load():
    with open(SOURCE, encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=SOURCE)
    picked = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in WANTED_FUNCS:
            picked.append(node)
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and tgt.id in WANTED_NAMES:
                    picked.append(node)
                    break
    ns = {}
    exec(compile(ast.Module(body=picked, type_ignores=[]), SOURCE, "exec"), ns)
    missing = (WANTED_FUNCS | WANTED_NAMES) - set(ns)
    if missing:
        raise AssertionError(
            "chinese2.py 里找不到 %s —— 这一层被删掉或改名了，"
            "半角句点会重新让 g2pW 判错多音字" % sorted(missing))
    return ns


NS = _load()
to_g2pw_input = NS["to_g2pw_input"]
from_g2pw_result = NS["from_g2pw_result"]
IN_MAP = NS["_G2PW_INPUT_PUNCT"]
OUT_MAP = NS["_G2PW_OUTPUT_PUNCT"]


class TestToG2pwInput(unittest.TestCase):
    def test_the_four_sentence_punctuation_marks_go_full_width(self):
        # 这就是缺陷本身：g2pW 拿到 '了一半.' 判 liao3，拿到 '了一半。' 判 le5。
        self.assertEqual(to_g2pw_input("了一半."), "了一半。")
        self.assertEqual(to_g2pw_input("了,你"), "了，你")
        self.assertEqual(to_g2pw_input("真的!"), "真的！")
        self.assertEqual(to_g2pw_input("是吗?"), "是吗？")

    def test_length_is_never_changed(self):
        # 下游按字符下标切拼音，长度一变整句就错位。这是这一层唯一的硬约束。
        for seg in ["了一半.", "这个,那个.已经好了!", "……", "a.b,c!d?e", "", "-", "…"]:
            self.assertEqual(len(to_g2pw_input(seg)), len(seg), seg)

    def test_ellipsis_and_dash_are_left_alone(self):
        # '…' 和 '-' 没有对应的全角中文形式，硬换只会引入新的未知项。
        self.assertEqual(to_g2pw_input("等一下…"), "等一下…")
        self.assertEqual(to_g2pw_input("三-四"), "三-四")

    def test_han_characters_pass_through_untouched(self):
        self.assertEqual(to_g2pw_input("这个问题我修了一半"), "这个问题我修了一半")

    def test_already_full_width_input_is_a_no_op(self):
        # 幂等：连着调两次不会越换越乱。
        once = to_g2pw_input("了一半.")
        self.assertEqual(to_g2pw_input(once), once)


class TestFromG2pwResult(unittest.TestCase):
    def test_full_width_punctuation_comes_back_half_width(self):
        # g2pW 对标点是透传的，喂进去的全角会跟着结果一起出来；
        # chinese2.py 的 `assert c in punctuation` 只认半角，漏掉这步会当场抛
        # AssertionError —— 探针那三次失败就是这么来的。
        self.assertEqual(
            from_g2pw_result(["le5", "yi2", "ban4", "。"]),
            ["le5", "yi2", "ban4", "."])
        self.assertEqual(from_g2pw_result(["le5", "，", "ni3"]), ["le5", ",", "ni3"])
        self.assertEqual(from_g2pw_result(["！", "？"]), ["!", "?"])

    def test_pinyin_entries_are_never_touched(self):
        pin = ["zhe4", "ge5", "wen4", "ti2", "wo3"]
        self.assertEqual(from_g2pw_result(pin), pin)

    def test_list_length_is_never_changed(self):
        for got in [[], ["a"], ["le5", "。", "，", "！", "？", "…", "-"]]:
            self.assertEqual(len(from_g2pw_result(got)), len(got), got)

    def test_half_width_output_is_left_as_is(self):
        # 回退路径（g2pW 不可用）或将来上游改了行为时，这一层必须是无害的。
        self.assertEqual(from_g2pw_result(["le5", "."]), ["le5", "."])


class TestRoundTrip(unittest.TestCase):
    def test_the_two_maps_are_exact_inverses(self):
        self.assertEqual(len(IN_MAP), len(OUT_MAP))
        for half, full in IN_MAP.items():
            self.assertEqual(OUT_MAP[full], half)

    def test_every_half_width_mark_is_one_the_engine_accepts(self):
        # symbols2.punctuation = ["!", "?", "…", ",", ".", "-"]
        # 还原回来的必须全部落在这个集合里，否则下游 assert 会炸。
        allowed = {"!", "?", "\u2026", ",", ".", "-"}
        for half in IN_MAP:
            self.assertIn(half, allowed, half)

    def test_a_whole_segment_survives_the_round_trip(self):
        # 模拟 g2pW 的透传行为：拼音位给拼音，标点位原样吐回。
        seg = "了一半."
        sent = to_g2pw_input(seg)
        fake_model_output = ["le5", "yi2", "ban4", sent[-1]]
        self.assertEqual(
            from_g2pw_result(fake_model_output),
            ["le5", "yi2", "ban4", "."])


class TestCallSites(unittest.TestCase):
    """两处调用点必须都包起来 —— get_word_pinyins 是同一条流水线的第二份实现，
    它的注释承诺了「预览读音 == 实际合成读音」，只改一处校对界面就会开始骗人。"""

    def test_every_g2pw_call_site_wraps_its_input_and_its_result(self):
        with open(SOURCE, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        sites = [i for i, ln in enumerate(lines) if "g2pw._g2pw(" in ln]
        self.assertGreaterEqual(len(sites), 2, "调用点少于 2 处，流水线的某一份被删了？")
        for i in sites:
            window = "\n".join(lines[max(0, i - 4):i + 4])
            self.assertIn("to_g2pw_input", window,
                          "第 %d 行的 g2pw 调用没有把输入还原成全角" % (i + 1))
            self.assertIn("from_g2pw_result", window,
                          "第 %d 行的 g2pw 调用没有把结果换回半角" % (i + 1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
