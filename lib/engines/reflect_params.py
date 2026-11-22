#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
参数草稿生成器：Python 侧。

在这台引擎自己的解释器里反射出「有哪些参数、叫什么、默认是什么」，
打成 JSON 交给 Node 侧组装成 manifest 的 parameters[] 段。

为什么必须跑在引擎的解释器里（而不是平台那个）：
   每台引擎一套 venv，平台只核对、不代装。平台的 Python 里没有 torch、transformers、
   也没有任何一台引擎的模块：在那儿 import 必然失败，而那个失败与
   「这台引擎的参数长什么样」毫无关系。跟 env_probe.js 同一个道理。

# ------------------------------------------------------------------
它只回答「事实」，不做任何判断
# ------------------------------------------------------------------
    参数叫什么      ← 反射
    默认值是什么    ← 反射
    类型线索        ← 反射（默认值的 Python 类型 + 注解）
    哪些是加载期    ← 出现在 __init__ 里
    哪些是调用期    ← 出现在目标方法里

它不猜这些（猜了就等于平台替名片作者做决定，而猜错不报错）：
    这个参数的取值范围、它该是滑块还是下拉、它的中英文标签、
    它跟别的参数有什么条件依赖。

# ------------------------------------------------------------------
用法
# ------------------------------------------------------------------
    python reflect_params.py --spec-file <path>
    python reflect_params.py --spec '{"module":"...","class":"...","method":"..."}'

spec = {module, class, method, sys_path: [...], skip: [...]}

stdout: 一行 JSON
    {"ok": true, "python": {...}, "load": [...], "call": [...], "warnings": [...]}
    {"ok": false, "error": "...", "detail": "..."}

退出码永远是 0。「反射不出来」是一个答案，不是探针出错，
   把它编码进 ok=false，调用方才能区分「这台引擎反射不了」和
   「探针自己没跑起来」。跟 env_probe.py 同一条纪律。
"""

from __future__ import print_function

import ast
import inspect
import json
import os
import re
import sys
import traceback

# 输出走 UTF-8：Windows 上 stdout 默认是系统代码页（cp936），
#   而这里要吐中文（错误原文、建议、模块名都可能是中文）⇒ 编码不上就
#   UnicodeEncodeError，脚本以非零码死掉，调用方会把它读成「探针自己崩了」，
#   而不是「这台引擎没有可反射的参数」。调用方按 utf-8 解码，这边就得按 utf-8 编码；
#   不依赖调用方传没传 PYTHONIOENCODING。
sys.stdout.reconfigure(encoding='utf-8')

BANNER = "[reflect]"


# ---------------------------------------------------------------------------
#  0) 洗环境：必须在 import 引擎之前
# ---------------------------------------------------------------------------
#  为什么：平台的进程环境里可能带着别的 Python 的路径（开发机上尤其明显，
#  Hermes 就把自己的 site-packages 塞在 sys.path 前面）。那些包一旦先被
# import 进来，这台引擎拿到的就是别的那一份 torch：而症状是
#  「版本不匹配，报错却指向一个跟当前包无关的地方」。
def _scrub_sys_path():
    keep = []
    for p in sys.path:
        norm = os.path.normcase(os.path.abspath(p or "."))
        # 当前项目根下的 lib/ 与 tools/ 不该出现在引擎解释器的路径里
        if os.sep + "hermes" + os.sep in norm:
            continue
        keep.append(p)
    sys.path[:] = keep


# ---------------------------------------------------------------------------
#  1) 值的类型线索：只给「线索」，不给结论
# ---------------------------------------------------------------------------
def _kind_of(value):
    """从默认值推出类型线索。

    返回的是线索不是判定：默认 0 可能是 int 也可能是 float 的 0，
    默认 None 什么都不说明（那正是最常见的情况）。所以下面每一条都带着
    「这条线索有多硬」一起出去，让调用方决定敢不敢用。
    """
    if value is None:
        return {"kind": "unknown", "confidence": "none",
                "why": "默认值是 None：上游没给默认值，或默认就是空"}
    if isinstance(value, bool):
        # bool 必须排在 int 前面：Python 里 isinstance(True, int) 是 True
        return {"kind": "boolean", "confidence": "strong",
                "why": "默认值是 Python bool"}
    if isinstance(value, int):
        return {"kind": "integer", "confidence": "medium",
                "why": "默认值是 Python int（但 int 也可能是被当 bool 用的 0/1）"}
    if isinstance(value, float):
        return {"kind": "number", "confidence": "medium",
                "why": "默认值是 Python float"}
    if isinstance(value, str):
        return {"kind": "text", "confidence": "medium",
                "why": "默认值是 Python str"}
    if isinstance(value, (list, tuple)):
        return {"kind": "list", "confidence": "medium",
                "len": len(value),
                "item_kind": _kind_of(value[0])["kind"] if value else "unknown"}
    if isinstance(value, dict):
        return {"kind": "dict", "confidence": "medium", "keys": sorted(
            str(k) for k in list(value.keys())[:12])}
    return {"kind": "object", "confidence": "weak",
            "type": type(value).__name__}


# 参数名 → 类型线索。全部是弱线索，只够用来排序和提醒，
#   不足以替人决定 type：判据写在每一行后面。
_NAME_HINTS = (
    (r"^(use_|has_|enable|disable|with_|allow_|force_|is_)", "boolean",
     "名字以 use_/has_/enable_ 开头"),
    (r"_enabled$|^enabled$|^flag$", "boolean", "名字像开关"),
    (r"(_prompt|_ref_audio|_audio|_wav|_clip)$|^(audio|voice|speaker|spk)", "audio",
     "名字像音频输入（值是文件路径）"),
    (r"(_vector|_vec|_embedding|_emb|_coeff|_weights)$", "number[]",
     "名字像数字数组（每维一个值）"),
    (r"(_text|prompt_text|_desc|_description|_instruction)$|^(text|desc)", "text",
     "名字像文本"),
    (r"(alpha|beta|ratio|scale|speed|rate|temperature|top_k|top_p|threshold|"
     r"interval|duration|length|steps|num_|max_|min_|silence)$", "number",
     "名字像数值旋钮"),
    (r"^seed$", "number", "种子"),
    # 这条只提醒「可能是路径」，不是让它进 parameters[]，
    #   路径类的正确归宿是 call.init_args / {checkpoints}。
    (r"(_path|_dir|_file|_folder)$", "path?", "名字像路径：确认它该不该做成界面格子"),
)


def _hint_from_name(name):
    """从参数名推类型线索。弱证据，只用于提醒与排序。"""
    low = name.lower()
    for pattern, kind, why in _NAME_HINTS:
        if re.search(pattern, low):
            return {"kind": kind, "confidence": "weak", "why": why}
    return None


def _annotation_of(param):
    """参数注解。拿不到就说拿不到：多数 TTS 上游没写注解。"""
    ann = param.annotation
    if ann is inspect.Parameter.empty:
        return None
    text = str(ann)
    if "typing" in text or "Literal" in text:
        # Literal['a','b'] 里的选项是有用信息，单独摘出来
        return {"raw": text, "literal_choices": _literal_choices(text)}
    return {"raw": text}


def _literal_choices(text):
    """从 Literal['a', 'b'] 的字符串表示里摘出选项。摘不出就返回 None。"""
    if "Literal[" not in text:
        return None
    inner = text.split("Literal[", 1)[1].rsplit("]", 1)[0]
    out = []
    for part in inner.split(","):
        part = part.strip()
        if len(part) >= 2 and part[0] == part[-1] and part[0] in "'\"":
            out.append(part[1:-1])
    return out or None


def _extract_help(doc, name):
    """从 docstring 里按参数名提取说明。

    按优先级试三种风格，拿到就停：
    1. numpy 风格 Parameters 段：name : type 下一行缩进说明
    2. Google 风格 Args: 段：name (type): description 或 name: description
    3. Sphinx 风格 :param name: description
    拿不到返回 None。
    """
    if not doc:
        return None

    # numpy 风格 Parameters 段：`name : type` 换行后跟缩进的说明文字。
    # 先于 Google 处理：否则 `spk_id : str` 会被 Google 的单行正则
    # 误抓成说明 "str"（那是类型不是说明）。
    m = re.search(
        r'^[ \t]*' + re.escape(name) + r'[ \t]*:[ \t]*[^\n]*\n((?:[ \t]+[^\n]*\n?)+)',
        doc, re.MULTILINE
    )
    if m:
        text = ' '.join(line.strip() for line in m.group(1).split('\n') if line.strip())
        if text:
            return text

    # Google 风格 Args: 段：`name (type): description` 或 `name: description`。
    # 要求冒号后非空且同一行有内容：排除 numpy 的 `name : type` 单行形式
    # （那种冒号后是类型，真说明在下一行，已由上面的 numpy 分支处理）。
    m = re.search(
        r'^[ \t]*' + re.escape(name) + r'[ \t]*(?:\([^)]*\))?[ \t]*:[ \t]*(\S.*)$',
        doc, re.MULTILINE
    )
    if m:
        return m.group(1).strip() or None

    # Sphinx 风格 :param name:
    m = re.search(
        r'^[ \t]*:param[ \t]+' + re.escape(name) + r'[ \t]*:[ \t]*(\S.*)$',
        doc, re.MULTILINE
    )
    if m:
        return m.group(1).strip() or None

    return None


# ---------------------------------------------------------------------------
#  2) 反射一个函数
# ---------------------------------------------------------------------------
# 平台自己的三个 bind 槽位不算引擎参数：它们的归宿是 call.bind，
#    不是 parameters[]。混进去会造成「同一个概念声明两次」。
BIND_SLOTS = ("self", "text", "ref_audio", "output_path")

# 被上面这条剔除掉的名字，按「它对应哪个 bind 槽位」另记一份。
#   为什么需要（实测逼出来的）：自动填写（scanAutofill）认槽位靠的就是参数名
#   （output_path / output / out / save_path…）。而反射器为了不让同一概念被
#   声明两次，把这些名字从 parameters[] 里剔掉，于是要找的名字在源头就没了，
#   output_path 永远填不出来，表现为「名片里那一格始终空着、且没有任何报错」。
#   ⇒ 这里不把它们塞回 parameters[]（那才是重复声明），只作为**候选**单独递出去，
#     交由自动填写消费。output_dir 与 output_path 指的是同一个槽位。
BIND_SLOT_NAMES = {
    "text": "text",
    "ref_audio": "ref_audio",
    "output_path": "output_path",
    "output_dir": "output_path",
}


def _bind_candidates(fn, phase):
    """把会被 BIND_SLOTS 剔掉的参数作为 bind 槽位候选递出去。

    只递名字，不改 parameters[]：归宿仍然是 call.bind，不是 parameters[]。
    """
    if fn is None:
        return []
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return []
    out = []
    for name in sig.parameters:
        slot = BIND_SLOT_NAMES.get(name)
        if not slot:
            continue
        # python 路：参数名即 target（与 _reflect_callable 里 python 源的口径一致）
        out.append({"name": name, "target": name, "phase": phase,
                    "bind_slot": slot})
    return out


def _reflect_callable(fn, phase, skip, fallback_doc=None):
    """反射一个可调用对象，返回参数清单。

    fallback_doc：fn 自己没 docstring 时的兜底（加载期用类 docstring，
    Args: 段常写在类上，而 __init__ 没有自己的 docstring）。
    """
    try:
        sig = inspect.signature(fn)
    except (ValueError, TypeError) as exc:
        return [], "拿不到签名（%s）：有些 C 扩展或装饰器包装的函数是这样" % exc
    # docstring 提取：取一次，给每个参数用。
    # __init__ 没有自己的 docstring 时，用类 docstring 兜底（Args: 常写在类上）。
    # 注意：object.__init__ 的默认 docstring 是 "Initialize self. ..." 样板，
    # 它不是空字符串：必须显式识别并当成「没有」，否则 fallback 永远用不上。
    try:
        doc = inspect.getdoc(fn)
    except Exception:
        doc = None
    if not doc or doc.startswith('Initialize self.'):
        doc = fallback_doc
    out = []
    for name, p in sig.parameters.items():
        if name in BIND_SLOTS:
            continue
        if p.kind in (inspect.Parameter.VAR_POSITIONAL,
                      inspect.Parameter.VAR_KEYWORD):
            out.append({
                "name": name, "phase": phase, "skipped": True,
                "why": "变长参数（*args / **kwargs）：平台不替用户猜测怎么展开",
            })
            continue
        if name in skip:
            out.append({
                "name": name, "phase": phase, "skipped": True,
                "why": "spec.skip 点名的参数（宿主自己要用，不进 parameters[]）",
            })
            continue

        has_default = p.default is not inspect.Parameter.empty
        kind = (_kind_of(p.default) if has_default
                else {"kind": "unknown", "confidence": "none",
                      "why": "必填参数，没有默认值"})
        entry = {
            "name": name,
            "phase": phase,
            "required": not has_default,
            "default": None if not has_default else _jsonable(p.default),
            "default_repr": None if not has_default else repr(p.default)[:120],
            "kind": kind,
            "annotation": _annotation_of(p),
            # 名字线索。
            #   为什么必须有（实测逼出来的）：IndexTTS2 的 14 个真参数里有
            #   4 个默认值是 None：use_cuda_kernel / emo_audio_prompt /
            # emo_vector / emo_text。人写的时候是按参数名的语义定的类型
            #   （use_* ⇒ 开关，*_prompt ⇒ 音频，*_vector ⇒ 数字数组，*_text ⇒ 文本）。
            # ⇒ 只看默认值会把这 4 个全部漏掉，而漏掉的表现是
            # 「界面上少了一个真实存在的旋钮」，没有任何报错。
            # 它是线索不是结论：最终由人定，这里只是别把证据丢了。
            "name_hint": _hint_from_name(name),
            # docstring 提取：有就递原文，没有就 null。
            "help": _extract_help(doc, name),
        }
        # Literal[...] 里的选项是上游自己说的，可以直接用
        ann = entry.get("annotation") or {}
        if ann.get("literal_choices"):
            entry["upstream_choices"] = ann["literal_choices"]
        out.append(entry)
    return out, None


def _jsonable(value):
    """把默认值变成能过 JSON 的东西。转不动就说转不动。"""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return dict((str(k), _jsonable(v)) for k, v in value.items())
    return {"__unserializable__": type(value).__name__, "repr": repr(value)[:120]}


# ---------------------------------------------------------------------------
#  2b) 静态解析（AST）：不 import 模块也能拿到签名
# ---------------------------------------------------------------------------
#  为什么优先走这条路：import 一个推理模块会连带加载 torch / lightning，
#  冷启动实测二十多秒，而这二十多秒里 Node 那边同步等着，整个服务被拖住。
#  要拿的是静态事实：参数叫什么、默认值是什么、注解写了什么、说明是什么。
#  这些全写在源码的字面上，ast.parse 读源码就能拿到，不需要执行模块，
#  更不需要把推理栈拉起来。import 路只在静态解析失败时兜底。

# 默认值在源码里是表达式节点。能求值就求值（literal_eval 比 eval 安全，
# 它只认字面量），求不出就留源码文本与一句说明，绝不执行上游代码。
def _default_from_node(node):
    if node is None:
        return None, None, "none"
    try:
        value = ast.literal_eval(node)
        return _jsonable(value), _kind_of(value), "literal"
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        try:
            text = ast.unparse(node)[:120]
        except Exception:
            text = node.__class__.__name__
        # 注解是字面量时也能给类型线索（例如 speed: float = None）
        return None, {"kind": "unknown", "confidence": "none",
                      "why": "默认值是表达式 %s，没有执行它" % text}, "expr"


def _annotation_from_node(node):
    """把注解节点变成与 _annotation_of 同形状的对象。"""
    if node is None:
        return None
    try:
        text = ast.unparse(node)
    except Exception:
        return None
    if "typing" in text or "Literal" in text:
        return {"raw": text, "literal_choices": _literal_choices(text)}
    return {"raw": text}


def _signature_from_fn(fn):
    """从一个 FunctionDef / AsyncFunctionDef 节点取参数清单。

    形状与 _reflect_callable 完全一致，下游 merge / buildDraft 不用分路。
    """
    args = fn.args
    # Python 3.8+ 有 posonlyargs；位置参数与默认值按尾部对齐。
    posonly = list(getattr(args, "posonlyargs", []))
    positional = posonly + list(args.args)
    defaults = list(args.defaults)
    pad = [None] * (len(positional) - len(defaults))
    all_defaults = pad + defaults

    pairs = [(p.arg, d) for p, d in zip(positional, all_defaults)]
    # 关键字参数：kw_defaults 与 kwonlyargs 一一对应，None 表示必填。
    pairs += [(p.arg, d) for p, d in zip(args.kwonlyargs, args.kw_defaults)]
    # *args / **kwargs：平台不替人猜怎么展开，记一条跳过原因。
    var = []
    if args.vararg:
        var.append({"name": args.vararg.arg, "phase": None, "skipped": True,
                    "why": "变长参数（*args）：平台不替用户猜测怎么展开"})
    if args.kwarg:
        var.append({"name": args.kwarg.arg, "phase": None, "skipped": True,
                    "why": "变长参数（**kwargs）：平台不替用户猜测怎么展开"})
    return pairs, var


def _reflect_fn_node(fn, phase, skip, fallback_doc=None):
    """静态反射一个函数节点，返回 (参数清单, 警告)。"""
    if fn is None:
        return [], None
    doc = ast.get_docstring(fn) or fallback_doc
    pairs, var = _signature_from_fn(fn)
    out = []
    for v in var:
        out.append({**v, "phase": phase})
    for name, default_node in pairs:
        if name in BIND_SLOTS:
            continue
        if name in skip:
            out.append({"name": name, "phase": phase, "skipped": True,
                        "why": "spec.skip 点名的参数（宿主自己要用，不进 parameters[]）"})
            continue
        default, kind, source = _default_from_node(default_node)
        default_repr = _safe_unparse(default_node)
        default_repr = default_repr[:120] if default_repr is not None else None
        ann_node = None
        # 注解按名字对应：从位置参数与 kwonly 两段里找同名的那个。
        for p in (getattr(fn.args, "posonlyargs", []) + fn.args.args + fn.args.kwonlyargs):
            if p.arg == name:
                ann_node = p.annotation
                break
        entry = {
            "name": name,
            "phase": phase,
            "required": default_node is None,
            "default": default,
            "default_repr": default_repr,
            "kind": kind,
            "annotation": _annotation_from_node(ann_node),
            "name_hint": _hint_from_name(name),
            "help": _extract_help(doc, name),
        }
        ann = entry.get("annotation") or {}
        if ann.get("literal_choices"):
            entry["upstream_choices"] = ann["literal_choices"]
        out.append(entry)
    return out, None


def _safe_unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return None


def _find_class_node(tree, class_name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return node
    return None


def _find_fn_node(class_node, name):
    if not name or class_node is None:
        return None
    for item in class_node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == name:
            return item
    return None


def _module_source(module_name, sys_path):
    """module 名 → 源码路径。只认 sys_path 下的文件，不碰 site-packages。"""
    if not module_name:
        return None
    rel = os.path.join(*module_name.split("."))
    for base in (sys_path or []):
        for cand in (os.path.join(base, rel + ".py"),
                     os.path.join(base, rel, "__init__.py")):
            if os.path.isfile(cand):
                return cand
    return None


def _reflect_static(spec):
    """AST 静态反射。成功返回结果对象；失败返回 None，由调用方回退 import。"""
    module_name = spec.get("module")
    class_name = spec.get("class")
    method_name = spec.get("method")
    src = _module_source(module_name, spec.get("sys_path"))
    if not src:
        return None
    try:
        with open(src, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read(), filename=src)
    except (OSError, SyntaxError, UnicodeDecodeError):
        return None
    klass = _find_class_node(tree, class_name)
    if klass is None:
        return None

    warnings = []
    skip = list(spec.get("skip") or [])
    class_doc = ast.get_docstring(klass)
    init_node = _find_fn_node(klass, "__init__")
    load, w = _reflect_fn_node(init_node, "load", skip, fallback_doc=class_doc)
    if w:
        warnings.append("加载期：%s" % w)

    # 调用期。方法与加载期同规矩：只反射这一个方法，不是整个类的一锅端。
    partial = False
    call = []
    bind_candidates = []
    for fn_node, phase in ((init_node, "load"),):
        if fn_node is not None:
            for p in (getattr(fn_node.args, "posonlyargs", []) +
                      fn_node.args.args + fn_node.args.kwonlyargs):
                slot = BIND_SLOT_NAMES.get(p.arg)
                if slot:
                    bind_candidates.append({"name": p.arg, "target": p.arg,
                                            "phase": phase, "bind_slot": slot})

    if method_name:
        method_node = _find_fn_node(klass, method_name)
        if method_node is None:
            warnings.append("调用期：%s 上没有 %s 这个方法：只给了加载期"
                            % (class_name, method_name))
            partial = True
        else:
            call, w = _reflect_fn_node(method_node, "call", skip)
            if w:
                warnings.append("调用期：%s" % w)
            for p in (getattr(method_node.args, "posonlyargs", []) +
                      method_node.args.args + method_node.args.kwonlyargs):
                slot = BIND_SLOT_NAMES.get(p.arg)
                if slot:
                    bind_candidates.append({"name": p.arg, "target": p.arg,
                                            "phase": "call", "bind_slot": slot})
    else:
        warnings.append("没给 method：只反射了加载期")
        partial = True

    return {
        "ok": True,
        "partial": partial,
        "partial_reason": (("方法 %s 在 %s 上不存在" % (method_name, class_name))
                           if (partial and method_name) else
                           ("没给 method：只反射了加载期" if partial else None)),
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "module_file": src,
        },
        "class": "%s.%s" % (module_name, class_name),
        "method": method_name,
        "load": load,
        "call": call,
        "bind_candidates": bind_candidates,
        "warnings": warnings,
        "via": "ast",
    }


# ---------------------------------------------------------------------------
#  3) 主流程
# ---------------------------------------------------------------------------
def reflect(spec):
    # 静态优先：签名是写在源码里的静态事实，ast.parse 就够，不必 import。
    #   import 会把 torch / lightning 整条推理栈拉起来（实测二十多秒），
    #   那段时间调用方同步等着，连带把读名片这种毫秒级请求也堵住。
    # 静态路只在「源码就在 sys_path 下」时走得通；模块藏在 venv 的 site-packages
    # 里时退回 import，不让静态路的能力边界变成「这台引擎反射不了」。
    static = _reflect_static(spec)
    if static is not None:
        return static

    _scrub_sys_path()
    for p in (spec.get("sys_path") or []):
        if p and os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    module_name = spec.get("module")
    class_name = spec.get("class")
    method_name = spec.get("method")
    if not module_name or not class_name:
        raise ValueError("spec 要有 module 和 class")

    # 留证据：装的到底是哪一份源码。反射失败时这一行最值钱。
    try:
        mod = __import__(module_name, fromlist=[class_name])
    except Exception:
        return {
            "ok": False,
            "stage": "import-module",
            "error": "import %s 失败" % module_name,
            "detail": traceback.format_exc()[-2000:],
        }
    root = sys.modules.get(module_name.split(".")[0])
    print("%s %s.__file__ = %s" % (BANNER, module_name.split(".")[0],
                                   getattr(root, "__file__", "?")), file=sys.stderr)

    klass = getattr(mod, class_name, None)
    if klass is None:
        names = [n for n in dir(mod) if not n.startswith("_")][:40]
        return {"ok": False, "stage": "get-class",
                "error": "%s 里没有 %s 这个类" % (module_name, class_name),
                "detail": "模块里公开的名字有：%s" % ", ".join(names)}

    warnings = []
    skip = list(spec.get("skip") or [])

    # --- 加载期：__init__ 的参数（去掉 self）---
    # 类 docstring 兜底：Args: 段常写在类上，__init__ 自己没 docstring。
    class_doc = inspect.getdoc(klass)
    load, w = _reflect_callable(klass.__init__, "load", skip, fallback_doc=class_doc)
    if w:
        warnings.append("加载期：%s" % w)
    bind_candidates = _bind_candidates(klass.__init__, "load")

    # --- 调用期：目标方法的参数 ---
    call = []
    # partial：这个结果不完整。
    #   方法名拼错 ⇒ 只反射到加载期 ⇒ 草稿少了整整一段调用期参数。
    #   那不是「警告一下就行」：缺的那一段在界面上表现为
    #   「少了一批真实存在的旋钮」，且没有任何报错。
    # 所以调用方要能据此拒绝写盘，而不是打个 log 继续。
    partial = False
    if method_name:
        fn = getattr(klass, method_name, None)
        if fn is None:
            warnings.append("调用期：%s 上没有 %s 这个方法：只给了加载期"
                            % (class_name, method_name))
            partial = True
        else:
            if isinstance(fn, property):
                fn = fn.fget
            call, w = _reflect_callable(fn, "call", skip)
            if w:
                warnings.append("调用期：%s" % w)
            bind_candidates += _bind_candidates(fn, "call")
    else:
        warnings.append("没给 method：只反射了加载期")
        partial = True

    return {
        "ok": True,
        # partial=true ⇒ 这个结果只覆盖了一部分，调用方必须说出来。
        "partial": partial,
        "partial_reason": (("方法 %s 在 %s 上不存在" % (method_name, class_name))
                           if (partial and method_name) else
                           ("没给 method：只反射了加载期" if partial else None)),
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "module_file": getattr(root, "__file__", None),
        },
        "class": "%s.%s" % (module_name, class_name),
        "method": method_name,
        "load": load,
        "call": call,
        # 自动填写认 bind 槽位的候选（被 parameters[] 剔除的那几个名字）。
        #   纯新增：load / call 两个列表一个字没动，老调用方不受影响。
        "bind_candidates": bind_candidates,
        "warnings": warnings,
        "via": "import",
    }


def main(argv):
    if "--spec-file" in argv:
        path = argv[argv.index("--spec-file") + 1]
        with open(path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    elif "--spec" in argv:
        spec = json.loads(argv[argv.index("--spec") + 1])
    else:
        spec = {}
    try:
        out = reflect(spec)
    except Exception as exc:
        out = {"ok": False, "stage": "reflect",
               "error": str(exc), "detail": traceback.format_exc()[-2000:]}
    print(json.dumps(out, ensure_ascii=False))
    return 0  # 永远是 0：ok=false 是一个答案


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
