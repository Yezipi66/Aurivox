"""Dependency-free regression check for the backend Auto Han resolver.

The full TextPreprocessor imports torch and model packages. This focused test
extracts only the two pure routing functions so it can run before the model
runtime is installed:
    python vendor/tts/gpt-sovits/infer/TTS_infer_pack/auto_language_test.py
"""
import ast
import re
import unittest
from pathlib import Path

SOURCE = Path(__file__).with_name("TextPreprocessor.py")
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))
NODES = []
for node in TREE.body:
    if isinstance(node, ast.FunctionDef) and node.name in {"_has_kana", "_resolve_auto_segment_language"}:
        NODES.append(node)
NS = {"re": re, "_KANA_RE": re.compile(r"[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]")}
exec(compile(ast.fix_missing_locations(ast.Module(body=NODES, type_ignores=[])), str(SOURCE), "exec"), NS)


class AutoLanguageTests(unittest.TestCase):
    def test_kana_free_detector_ja_falls_back_to_clause_base(self):
        resolve = NS["_resolve_auto_segment_language"]
        self.assertEqual(resolve("ja", "今日", "zh"), "zh")
        self.assertEqual(resolve("ja", "今日", "yue"), "yue")

    def test_actual_kana_keeps_japanese(self):
        resolve = NS["_resolve_auto_segment_language"]
        self.assertEqual(resolve("ja", "今日は", "zh"), "ja")

    def test_cjk_detector_labels_follow_clause_fallback(self):
        resolve = NS["_resolve_auto_segment_language"]
        self.assertEqual(resolve("zh", "今日", "zh"), "zh")
        self.assertEqual(resolve("x", "今日", "yue"), "yue")


if __name__ == "__main__":
    unittest.main()
