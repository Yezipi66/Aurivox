#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
参数「说明文本」提取原型 —— 回答一个问题：
    「平台能不能自动拿到每个参数的**人话解释**？」

reflect_params.py 只反射「有哪些参数、默认值、类型线索」，
它**一个字说明文本都不读** ⇒ 用户看到 `emo_alpha` 不知道那是什么。
本脚本在**同一个参数集合**（reflect_params.py 的输出）上，试着从三个源把说明补回来：

  (a) docstring  —— 类 docstring + __init__ / 方法 docstring。
      支持两种写法（中英文都读，只认结构不认语言）：
        · Google 风格  `Args:` / `参数:` 段 + `name (type): desc`
        · Sphinx 风格  `:param name: desc`
      以及 gpt-sovits 那种「dict 里每个 key 的注释」：
        `"top_k": 15,   # int. top k sampling`

  (b) argparse help=  —— 对**有 CLI** 的引擎，静态解析它的 argparse 定义
      （AST，不 import 引擎），把 `help="..."` 抽出来，并按**显式别名表**
      把 `--voice` 这种开关名映射回 Python 参数名。

  (c) Literal[...] 选项 —— 从签名注解里摘 `Literal['a','b']` 的取值集合。

⭐ 设计纪律（跟 reflect_params.py 一脉相承）：
    · 只回答「事实」，不做判断 —— 拿到什么报什么，拿不到就报 null。
    · ⛔ 不猜。别名映射是**显式表**；命中与否都写进结果，绝不悄悄联想。
    · 参数集合**不自己造**：直接用 reflect_params.py 的输出，保证覆盖率
      的分母 = 平台今天真实看到的参数个数（index 25 / cosy 13 / sovits 2）。
    · 纯 stdlib + AST（引擎解释器只用来跑 reflect_params）。

用法：
    python tools/dev/probe_param_docs.py                        # 跑全部三台
    python tools/dev/probe_param_docs.py --engine index-tts
    python tools/dev/probe_param_docs.py --json out.json        # 完整结果落盘
    python tools/dev/probe_param_docs.py --reflect-json r.json  # 跳过反射，用现成的

退出码永远 0：提取不到说明是**答案**，不是脚本出错。
"""

from __future__ import print_function

import argparse as _argparse
import ast
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


# ===========================================================================
#  0) 引擎档案 —— 三台引擎各自的「说明文本可能藏在哪」
# ===========================================================================
#  ⭐ 为什么要有这张表：说明文本**不在标准位置**。同一台引擎里，
#     类 docstring / 方法 docstring / CLI help / dict 注释，四处都可能写，
#     而平台无从得知该去哪读 ⇒ 接入时必须由人（名片作者）指路。
#     ⭐ 这正是本次原型要暴露的**主要障碍**，见报告。
PROFILES = {
    "index-tts": {
        "python": "engines/index-tts/.venv/Scripts/python.exe",
        "spec": {"module": "indextts.infer_v2_5", "class": "IndexTTS2",
                 "method": "infer", "sys_path": ["engines/index-tts"]},
        "doc_files": ["engines/index-tts/indextts/infer_v2_5.py"],
        "cli_files": ["engines/index-tts/indextts/cli.py",
                      "engines/index-tts/indextts/cli_v2.py"],
    },
    "cosyvoice2": {
        "python": "engines/cosyvoice2/.venv/Scripts/python.exe",
        "spec": {"module": "cosyvoice.cli.cosyvoice", "class": "CosyVoice2",
                 "method": "inference_zero_shot",
                 "sys_path": ["engines/cosyvoice2",
                              "engines/cosyvoice2/third_party/Matcha-TTS"]},
        "doc_files": ["engines/cosyvoice2/cosyvoice/cli/cosyvoice.py"],
        # ⭐ 反例 2：cosyvoice2 的**推理方法本身没有 CLI**。带 argparse 的是
        #    它的 runtime 示例（fastapi client / webui）。开关名与 Python
        #    参数名**部分一致**，且 CLI 只暴露了 7 个调用期参数里的 4 个。
        "cli_files": ["engines/cosyvoice2/runtime/python/fastapi/client.py",
                      "engines/cosyvoice2/webui.py"],
    },
    "gpt-sovits": {
        "python": "engines/gpt-sovits/.venv/Scripts/python.exe",
        "spec": {"module": "TTS", "class": "TTS", "method": "run",
                 "sys_path": ["engines/gpt-sovits/infer", "engines/gpt-sovits"]},
        "doc_files": ["engines/gpt-sovits/infer/TTS.py"],
        "cli_files": [],
        # ⭐ 反例 1：`TTS.run(inputs: dict)` 签名只有 configs/inputs，
        #    真参数在 **dict 里**。说明写在 run() docstring 的 `Args:` 段，
        #    形式是 `"key": default,  # comment`。
        "dict_params_in_docstring": True,
    },
}


# ===========================================================================
#  1) docstring 解析 —— Google `Args:` / Sphinx `:param:` / dict 注释
# ===========================================================================
_GOOGLE_SECTION_HEAD = re.compile(
    r"^(Args|Arguments|Parameters|参数|参数说明)\s*:\s*$", re.I)
_SECTION_TAIL = re.compile(
    r"^(Returns|Return|Yields|Raises|Examples?|Notes?|Attributes|References|"
    r"返回|返回结果|抛出|异常|示例|例子|注意)\s*:?\s*$", re.I)
_GOOGLE_ARG = re.compile(
    r"^(?P<name>\*{0,2}[A-Za-z_][A-Za-z0-9_]*)\s*"
    r"(?:\((?P<type>[^)]*)\))?\s*(?::|--|—)\s*(?P<desc>.*)$")
_SPHINX_PARAM = re.compile(
    r"^:param\s+(?:(?P<type>[A-Za-z_][\w\.\[\], ]*?)\s+)?"
    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<desc>.*)$")


def parse_google_args(docstring):
    """从 Google 风格 `Args:` 段摘 {参数名: 说明}。只认结构，不认语言。"""
    if not docstring:
        return {}
    out = {}
    in_args = False
    cur = None
    base_indent = None
    for raw in docstring.splitlines():
        stripped = raw.strip()
        indent = len(raw) - len(raw.lstrip())
        if not in_args:
            if _GOOGLE_SECTION_HEAD.match(stripped):
                in_args = True
                base_indent = None
            continue
        if _SECTION_TAIL.match(stripped):
            break
        if not stripped:
            cur = None
            continue
        if base_indent is None:
            base_indent = indent
        m = _GOOGLE_ARG.match(stripped)
        if m and indent == base_indent and not _SECTION_TAIL.match(stripped):
            name = m.group("name").lstrip("*")
            cur = name
            out[name] = {"text": (m.group("desc") or "").strip(),
                         "type_hint": (m.group("type") or "").strip() or None}
        elif cur is not None:
            out[cur]["text"] = (out[cur]["text"] + " " + stripped).strip()
    return out


def parse_sphinx_params(docstring):
    """从 Sphinx 风格 `:param name: desc` 摘 {参数名: 说明}。"""
    if not docstring:
        return {}
    out = {}
    cur = None
    for raw in docstring.splitlines():
        stripped = raw.strip()
        m = _SPHINX_PARAM.match(stripped)
        if m:
            cur = m.group("name")
            out[cur] = {"text": (m.group("desc") or "").strip(),
                        "type_hint": (m.group("type") or "").strip() or None}
            continue
        if stripped.startswith(":") and cur is not None:
            if not stripped.startswith(":param"):
                cur = None
            continue
        if cur is not None and stripped:
            out[cur]["text"] = (out[cur]["text"] + " " + stripped).strip()
    return out


def parse_dict_params_in_docstring(docstring):
    """摘「dict 里每个 key 的注释」：`"top_k": 15,   # int. top k sampling`。

    ⭐ gpt-sovits 的 `TTS.run(inputs: dict)` 真参数藏在 dict 里，签名看不到；
       这是**上游唯一**写下这些 key 语义的地方（dataclass/yaml 里都没有）。
    """
    if not docstring:
        return {}
    out = {}
    pat = re.compile(r'^\s*"(?P<key>[A-Za-z_][A-Za-z0-9_]*)"\s*:\s*'
                     r'.*?#\s*(?P<desc>.+?)\s*$')
    for raw in docstring.splitlines():
        m = pat.match(raw)
        if m:
            out[m.group("key")] = {"text": m.group("desc").strip(), "type_hint": None}
    return out


def parse_docstring(docstring):
    merged = {}
    for src in (parse_google_args(docstring), parse_sphinx_params(docstring),
                parse_dict_params_in_docstring(docstring)):
        for k, v in src.items():
            merged.setdefault(k, v)
    return merged


# ===========================================================================
#  2) AST —— 类/方法 docstring、签名注解、Literal
# ===========================================================================
def _read(path):
    with io.open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _func_node(klass, method):
    for node in klass.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method:
            return node
    return None


def _literal_choices_from_annotation(ann_node):
    if ann_node is None:
        return None
    if isinstance(ann_node, ast.Subscript):
        base = ann_node.value
        name = base.id if isinstance(base, ast.Name) else (
            base.attr if isinstance(base, ast.Attribute) else None)
        if name == "Literal":
            elts = ann_node.slice
            elts = elts.elts if isinstance(elts, ast.Tuple) else [elts]
            out = []
            for e in elts:
                if isinstance(e, ast.Constant) and isinstance(e.value, str):
                    out.append(e.value)
                elif isinstance(e, ast.Name) and e.id == "None":
                    out.append(None)
            return out or None
    return None


def _sig_params(func_node):
    """AST 签名：{name: {default_repr, literal_choices, annotation, varargs}}。"""
    out = {}
    args = func_node.args
    positional = getattr(args, "posonlyargs", []) + args.args
    defaults = list(args.defaults)
    padded = [None] * (len(positional) - len(defaults)) + defaults
    for a, d in zip(positional, padded):
        out[a.arg] = {
            "default_repr": ast.unparse(d) if d is not None else None,
            "literal_choices": _literal_choices_from_annotation(a.annotation),
            "annotation": ast.unparse(a.annotation) if a.annotation is not None else None}
    for a, d in zip(args.kwonlyargs, args.kw_defaults):
        out[a.arg] = {
            "default_repr": ast.unparse(d) if d is not None else None,
            "literal_choices": _literal_choices_from_annotation(a.annotation),
            "annotation": ast.unparse(a.annotation) if a.annotation is not None else None}
    if args.vararg:
        out[args.vararg.arg] = {"varargs": True}
    if args.kwarg:
        out[args.kwarg.arg] = {"varargs": True}
    return out


class SourceIndex(object):
    """一个源文件的 AST 索引，支持在本文件内按基类名找方法（尽力而为）。

    ⭐ 为什么要处理继承：cosyvoice2 的 `inference_zero_shot` 定义在基类
      `CosyVoice` 里，spec 点的是子类 `CosyVoice2`。找不到就以为「没写」，
      那是把「继承」误判成「没写」。
    """

    def __init__(self, path):
        self.path = path
        self.tree = ast.parse(_read(path))
        self.classes = {}
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ClassDef):
                self.classes[node.name] = node

    def resolve_method(self, class_name, method):
        seen, stack = set(), [class_name]
        while stack:
            cn = stack.pop(0)
            if cn in seen:
                continue
            seen.add(cn)
            klass = self.classes.get(cn)
            if klass is None:
                continue
            fn = _func_node(klass, method)
            if fn is not None:
                return cn, fn
            for b in klass.bases:
                bname = b.id if isinstance(b, ast.Name) else (
                    b.attr if isinstance(b, ast.Attribute) else None)
                if bname:
                    stack.append(bname)
        return None, None

    def resolve_init(self, class_name):
        return self.resolve_method(class_name, "__init__")


def resolve_module_file(module, sys_paths):
    parts = module.split(".")
    for sp in sys_paths:
        base = sp if os.path.isabs(sp) else os.path.join(ROOT, sp)
        cand = os.path.join(base, *parts)
        for p in (cand + ".py", os.path.join(cand, "__init__.py")):
            if os.path.isfile(p):
                return os.path.abspath(p)
    return None


# ===========================================================================
#  3) argparse 静态解析（AST，不 import）
# ===========================================================================
def parse_argparse_file(path):
    """静态解析一个文件里所有 add_argument。⛔ 不 import：import CLI 会执行
    顶层代码（可能拉 gradio/模型），且各引擎解释器不同。只读**声明**。"""
    if not os.path.isfile(path):
        return []
    try:
        tree = ast.parse(_read(path))
    except SyntaxError as exc:
        return [{"__error__": "SyntaxError: %s" % exc}]
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not (isinstance(fn, ast.Attribute) and fn.attr == "add_argument"):
            continue
        rec = {"file": os.path.relpath(path, ROOT).replace("\\", "/"),
               "option_strings": [], "dest": None, "help": None,
               "choices": None, "action": None, "type": None,
               "required": None, "default": None}
        for a in node.args:
            if isinstance(a, ast.Constant) and isinstance(a.value, str):
                rec["option_strings"].append(a.value)
        for kw in node.keywords:
            if kw.arg == "help" and isinstance(kw.value, ast.Constant):
                rec["help"] = kw.value.value
            elif kw.arg == "choices" and isinstance(kw.value, (ast.List, ast.Tuple)):
                rec["choices"] = [e.value for e in kw.value.elts
                                  if isinstance(e, ast.Constant)]
            elif kw.arg == "action" and isinstance(kw.value, ast.Constant):
                rec["action"] = kw.value.value
            elif kw.arg == "type" and isinstance(kw.value, ast.Name):
                rec["type"] = kw.value.id
            elif kw.arg == "required" and isinstance(kw.value, ast.Constant):
                rec["required"] = kw.value.value
            elif kw.arg == "default" and isinstance(kw.value, ast.Constant):
                rec["default"] = kw.value.value
        longs = [o for o in rec["option_strings"] if o.startswith("--")]
        if longs:
            rec["dest"] = longs[0][2:].replace("-", "_")
        elif rec["option_strings"]:
            rec["dest"] = rec["option_strings"][0].replace("-", "_")
        if rec["option_strings"] or rec["dest"]:
            out.append(rec)
    return out


# ===========================================================================
#  4) 别名表 —— CLI 开关名 / dict key  ->  Python 参数名
# ===========================================================================
#  ⭐ 这是**唯一**需要人写的一张表。它不是「聪明」，是「知识」：
#    `--voice` 和 `spk_audio_prompt` 之间没有任何字符串或结构联系，
#    只有读过代码的人知道它们指同一件事。
#  ⛔ 命中就命中，不命中就报「未映射」，绝不猜。
ALIASES = {
    # index-tts：cli.py / cli_v2.py 开关 -> infer_v2_5.infer 参数
    "voice": "spk_audio_prompt",
    "emotion_audio": "emo_audio_prompt",
    "emotion_text": "emo_text",
    "emotion_vector": "emo_vector",
    "emotion_weight": "emo_alpha",
    "output": "output_path",
    "config": "cfg_path",
    "model_dir": "model_dir",
    "device": "device",
    "verbose": "verbose",
    "text": "text",
    # ⚠ 故意**不**把 --fp16 映到 use_bf16：cli_v2 的 --fp16 是给 infer_v2 的
    #   use_fp16 用的，而 infer_v2_5 把它改名成了 use_bf16。名字对上、语义
    #   未必等价 ⇒ 按纪律只能映到字面同名的 use_fp16，让 use_bf16 落到
    #   「未映射」。（这条正是「自动映射会错」的活证据，见报告。）
    "fp16": "use_fp16",
    "cuda_kernel": "use_cuda_kernel",
    "deepspeed": "use_deepspeed",
    "accel": "use_accel",
    "torch_compile": "use_torch_compile",
    # cosyvoice2：runtime client 开关 -> inference_zero_shot 参数（同名）
    "tts_text": "tts_text",
    "prompt_text": "prompt_text",
    "prompt_wav": "prompt_wav",
    "spk_id": "spk_id",
    "zero_shot_spk_id": "zero_shot_spk_id",
    "instruct_text": "instruct_text",
    # gpt-sovits：payload dict key -> run() 的 inputs dict key（同名）
    "ref_audio_path": "ref_audio_path",
    "text_lang": "text_lang",
    "prompt_lang": "prompt_lang",
    "top_k": "top_k",
    "top_p": "top_p",
    "temperature": "temperature",
    "repetition_penalty": "repetition_penalty",
    "speed_factor": "speed_factor",
    "text_split_method": "text_split_method",
    "batch_size": "batch_size",
    "batch_threshold": "batch_threshold",
    "split_bucket": "split_bucket",
    "fragment_interval": "fragment_interval",
    "parallel_infer": "parallel_infer",
    "sample_steps": "sample_steps",
    "super_sampling": "super_sampling",
    "streaming_mode": "streaming_mode",
    "overlap_length": "overlap_length",
    "min_chunk_length": "min_chunk_length",
    "seed": "seed",
}


# ===========================================================================
#  5) 反射：拿平台今天真实看到的参数集合
# ===========================================================================
def run_reflect(profile):
    """调用 reflect_params.py（⛔ 不改它），拿 load/call 参数清单。"""
    py = os.path.join(ROOT, profile["python"])
    script = os.path.join(ROOT, "lib", "engines", "reflect_params.py")
    cmd = [py, script, "--spec", json.dumps(profile["spec"])]
    try:
        proc = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=180)
    except Exception as exc:
        return {"ok": False, "error": "reflect 调用失败: %s" % exc}
    last = ""
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        if line.strip().startswith("{"):
            last = line.strip()
    if not last:
        return {"ok": False, "error": "reflect 没有输出 JSON"}
    try:
        return json.loads(last)
    except ValueError as exc:
        return {"ok": False, "error": "reflect 输出不是 JSON: %s" % exc}


# ===========================================================================
#  6) 主流程 —— 一台引擎，三个源
# ===========================================================================
def probe_engine(name, profile, reflect):
    spec = profile["spec"]
    class_name, method_name = spec["class"], spec.get("method")
    sys_paths = spec.get("sys_path") or []

    result = {"engine": name, "class": "%s.%s" % (spec["module"], class_name),
              "method": method_name, "sources": {}, "params": [],
              "dict_params": [], "warnings": [], "reflect_ok": bool(reflect.get("ok"))}

    if not reflect.get("ok"):
        result["warnings"].append("reflect 失败：%s" % reflect.get("error"))
        return result

    # --- 6.1 找类源文件 ---
    mod_file = resolve_module_file(spec["module"], sys_paths)
    if not mod_file:
        result["warnings"].append("找不到 module %s 的源文件" % spec["module"])
        return result
    result["sources"]["module_file"] = os.path.relpath(mod_file, ROOT).replace("\\", "/")

    doc_files = []
    for p in [mod_file] + [os.path.join(ROOT, f) for f in profile.get("doc_files", [])]:
        ap = os.path.abspath(p)
        if os.path.isfile(ap) and ap not in doc_files:
            doc_files.append(ap)

    # --- 6.2 类/方法/__init__ docstring ---
    init_docs, method_docs, class_docs = {}, {}, {}
    init_node = method_node = None
    for df in doc_files:
        try:
            idx = SourceIndex(df)
        except SyntaxError as exc:
            result["warnings"].append("解析 %s 失败：%s" % (df, exc))
            continue
        klass = idx.classes.get(class_name)
        if klass is None:
            continue
        cd = ast.get_docstring(klass)
        if cd:
            class_docs.setdefault(df, parse_docstring(cd))
        _, inode = idx.resolve_init(class_name)
        if inode is not None and init_node is None:
            init_node = (df, inode)
            idoc = ast.get_docstring(inode)
            if idoc:
                init_docs = parse_docstring(idoc)
        if method_name:
            _, mnode = idx.resolve_method(class_name, method_name)
            if mnode is not None and method_node is None:
                method_node = (df, mnode)
                mdoc = ast.get_docstring(mnode)
                if mdoc:
                    method_docs = parse_docstring(mdoc)

    # --- 6.3 AST 签名（Literal 选项 / 注解）---
    load_sig = _sig_params(init_node[1]) if init_node else {}
    call_sig = _sig_params(method_node[1]) if method_node else {}
    result["sources"]["load_params_from"] = (
        os.path.relpath(init_node[0], ROOT).replace("\\", "/") if init_node else None)
    result["sources"]["call_params_from"] = (
        os.path.relpath(method_node[0], ROOT).replace("\\", "/") if method_node else None)

    # --- 6.4 argparse ---
    cli_records = []
    for cf in profile.get("cli_files", []):
        cli_records.extend(parse_argparse_file(os.path.join(ROOT, cf)))
    result["sources"]["cli_files"] = profile.get("cli_files", [])
    result["sources"]["cli_records"] = [r for r in cli_records if "dest" in r]
    cli_help = {}
    for rec in cli_records:
        if rec.get("dest") and rec.get("help"):
            cli_help.setdefault(rec["dest"], rec)

    # --- 6.5 dict 参数（gpt-sovits）---
    dict_docs = {}
    if profile.get("dict_params_in_docstring") and method_node is not None:
        dict_docs = parse_dict_params_in_docstring(ast.get_docstring(method_node[1]) or "")

    # --- 6.6 逐参数归并（参数集合来自 reflect）---
    def _rel(p):
        return os.path.relpath(p, ROOT).replace("\\", "/")

    def lookup(pname, phase):
        """返回 (说明文本, 来源, 出处)。三个源按优先级依次试。

        ⭐ 出处（source_detail）不是装饰：自动提取的说明必须能指回「哪一行」，
          否则跟人拍脑袋写的没区别，出了错无从核对。
        """
        if phase == "call" and pname in method_docs:
            return (method_docs[pname]["text"], "docstring(method)",
                    "%s :: %s.%s docstring" % (_rel(method_node[0]), class_name, method_name))
        if pname in init_docs:
            return (init_docs[pname]["text"], "docstring(__init__)",
                    "%s :: %s.__init__ docstring" % (_rel(init_node[0]), class_name))
        for df, dmap in class_docs.items():
            if pname in dmap:
                return (dmap[pname]["text"], "docstring(class)",
                        "%s :: class %s docstring" % (_rel(df), class_name))
        if pname in dict_docs:
            return (dict_docs[pname]["text"], "docstring(dict-key)",
                    "%s :: %s.%s docstring (dict 注释)" %
                    (_rel(method_node[0]), class_name, method_name))
        if pname in cli_help:
            rec = cli_help[pname]
            return (rec["help"], "argparse(same-name)",
                    "%s :: %s" % (rec["file"], " ".join(rec["option_strings"]) or rec["dest"]))
        for dest, rec in cli_help.items():
            if ALIASES.get(dest) == pname:
                return (rec["help"], "argparse(alias:%s)" % dest,
                        "%s :: %s" % (rec["file"], " ".join(rec["option_strings"]) or dest))
        return None, "none", None

    def build(phase, reflist, sig):
        rows = []
        for entry in reflist:
            pname = entry["name"]
            meta = sig.get(pname, {})
            text, src, detail = lookup(pname, phase)
            rows.append({
                "name": pname, "phase": phase,
                "skipped_by_reflect": bool(entry.get("skipped")),
                "reflect_why": entry.get("why"),
                "doc": text, "source": src, "source_detail": detail,
                "why": None if text else "三个源都没拿到",
                "literal_choices": meta.get("literal_choices"),
                "annotation": meta.get("annotation"),
                "default_repr": entry.get("default_repr"),
            })
        return rows

    result["params"] = (build("load", reflect.get("load", []), load_sig)
                        + build("call", reflect.get("call", []), call_sig))

    # --- 6.7 dict 参数单独成组（反例 1 的发现）---
    if dict_docs:
        for k, v in dict_docs.items():
            result["dict_params"].append({
                "name": k, "phase": "call(dict)", "doc": v["text"],
                "source": "docstring(dict-key)",
                "in_reflect": any(p["name"] == k for p in result["params"]),
            })

    # --- 6.8 覆盖率 ---
    def summarize(rows):
        total = len(rows)
        with_doc = [p for p in rows if p["doc"]]
        by_src = {}
        for p in with_doc:
            key = p["source"].split("(")[0]
            by_src[key] = by_src.get(key, 0) + 1
        return {"total": total, "with_doc": len(with_doc),
                "pct": round(100.0 * len(with_doc) / total, 1) if total else 0.0,
                "by_source": by_src,
                "no_doc": [p["name"] for p in rows if not p["doc"]],
                "with_literal_choices": [p["name"] for p in rows if p.get("literal_choices")]}

    result["coverage"] = summarize(result["params"])
    result["coverage_dict"] = summarize(result["dict_params"])
    return result


def main(argv):
    ap = _argparse.ArgumentParser(description="参数说明文本提取原型")
    ap.add_argument("--engine", choices=list(PROFILES.keys()))
    ap.add_argument("--json", help="完整结果写到此文件")
    ap.add_argument("--reflect-json", help="用现成的 reflect 结果（跳过跑引擎）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    precomputed = {}
    if args.reflect_json:
        with io.open(args.reflect_json, "r", encoding="utf-8") as fh:
            precomputed = json.load(fh)

    targets = [args.engine] if args.engine else list(PROFILES.keys())
    results = {}
    for name in targets:
        refl = precomputed.get(name) or run_reflect(PROFILES[name])
        results[name] = probe_engine(name, PROFILES[name], refl)

    if args.json:
        with io.open(args.json, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(results, ensure_ascii=False, indent=2))
        print(">> JSON 写入 %s" % args.json, file=sys.stderr)

    if not args.quiet:
        for name, r in results.items():
            print("\n" + "=" * 80)
            print("引擎 %s  —— %s.%s" % (name, r["class"], r["method"]))
            print("  类源文件      : %s" % r["sources"].get("module_file"))
            print("  加载期参数来自: %s" % r["sources"].get("load_params_from"))
            print("  调用期参数来自: %s" % r["sources"].get("call_params_from"))
            print("  CLI 文件      : %s" % r["sources"].get("cli_files"))
            for w in r["warnings"]:
                print("  ⚠ %s" % w)
            print("  " + "-" * 76)
            for p in r["params"]:
                doc = p["doc"] or "——（无）"
                if len(doc) > 56:
                    doc = doc[:53] + "..."
                print("   [%-4s] %-26s %-22s %s" % (p["phase"], p["name"], p["source"], doc))
            c = r["coverage"]
            print("  " + "-" * 76)
            print("  签名参数覆盖：%d/%d = %.1f%%  来源 %s" %
                  (c["with_doc"], c["total"], c["pct"], c["by_source"]))
            if c["no_doc"]:
                print("  无说明：%s" % ", ".join(c["no_doc"]))
            if r["dict_params"]:
                cd = r["coverage_dict"]
                print("  " + "-" * 76)
                print("  ⭐ dict 参数（签名看不到，从 docstring 摘出）：%d 个，%d 有说明"
                      % (cd["total"], cd["with_doc"]))

    print("\n" + "=" * 80)
    print("覆盖率汇总（真实跑出）")
    for name, r in results.items():
        c = r["coverage"]
        extra = ""
        if r["dict_params"]:
            cd = r["coverage_dict"]
            extra = "   +dict %d/%d" % (cd["with_doc"], cd["total"])
        print("  %-12s %2d/%2d = %5.1f%%   来源 %s%s" %
              (name, c["with_doc"], c["total"], c["pct"], c["by_source"], extra))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
