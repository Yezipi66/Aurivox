#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
参数草稿生成器 —— Python 侧。

在**这台引擎自己的解释器**里反射出「有哪些参数、叫什么、默认是什么」，
打成 JSON 交给 Node 侧组装成 manifest 的 parameters[] 段。

⭐ 为什么必须跑在引擎的解释器里（而不是平台那个）：
   每台引擎一套 venv（C12 纪律）。平台的 Python 里没有 torch、transformers、
   也没有任何一台引擎的模块 —— 在那儿 import 必然失败，而那个失败与
   「这台引擎的参数长什么样」毫无关系。跟 env_probe.js 同一个道理。

————————————————————————————————————————————————————————————————
它只回答「事实」，不做任何判断
————————————————————————————————————————————————————————————————
    参数叫什么      ← 反射
    默认值是什么    ← 反射
    类型线索        ← 反射（默认值的 Python 类型 + 注解）
    哪些是加载期    ← 出现在 __init__ 里
    哪些是调用期    ← 出现在目标方法里

⛔ 它**不猜**这些（猜了就等于平台替名片作者做决定，而猜错不报错）：
    这个参数的取值范围、它该是滑块还是下拉、它的中英文标签、
    它跟别的参数有什么条件依赖。

————————————————————————————————————————————————————————————————
用法
————————————————————————————————————————————————————————————————
    python reflect_params.py --spec-file <path>
    python reflect_params.py --spec '{"module":"...","class":"...","method":"..."}'

spec = {module, class, method, sys_path: [...], skip: [...]}

stdout: 一行 JSON
    {"ok": true, "python": {...}, "load": [...], "call": [...], "warnings": [...]}
    {"ok": false, "error": "...", "detail": "..."}

⭐ 退出码永远是 0。「反射不出来」是一个**答案**，不是探针出错 ——
   把它编码进 ok=false，调用方才能区分「这台引擎反射不了」和
   「探针自己没跑起来」。跟 env_probe.py 同一条纪律。
"""

from __future__ import print_function

import inspect
import json
import os
import re
import sys
import traceback

BANNER = "[reflect]"


# ---------------------------------------------------------------------------
#  0) 洗环境 —— 必须在 import 引擎之前
# ---------------------------------------------------------------------------
#  为什么：平台的进程环境里可能带着别的 Python 的路径（开发机上尤其明显，
#  Hermes 就把自己的 site-packages 塞在 sys.path 前面）。那些包一旦先被
#  import 进来，这台引擎拿到的就是**别的那一份** torch —— 而症状是
#  「版本对不上，报错却指向一个跟当前包无关的地方」。
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
#  1) 值的类型线索 —— 只给「线索」，不给结论
# ---------------------------------------------------------------------------
def _kind_of(value):
    """从默认值推出类型线索。

    ⭐ 返回的是**线索**不是判定：默认 0 可能是 int 也可能是 float 的 0，
    默认 None 什么都不说明（那正是最常见的情况）。所以下面每一条都带着
    「这条线索有多硬」一起出去，让调用方决定敢不敢用。
    """
    if value is None:
        return {"kind": "unknown", "confidence": "none",
                "why": "默认值是 None —— 上游没给默认值，或默认就是空"}
    if isinstance(value, bool):
        # ⚠ bool 必须排在 int 前面：Python 里 isinstance(True, int) 是 True
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


# 参数名 → 类型线索。⛔ 全部是**弱线索**，只够用来排序和提醒，
#   不足以替人决定 type —— 判据写在每一行后面。
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
    # ⚠ 这条只提醒「可能是路径」，不是让它进 parameters[] ——
    #   路径类的正确归宿是 call.init_args / {checkpoints}。
    (r"(_path|_dir|_file|_folder)$", "path?", "名字像路径 —— 确认它该不该做成界面格子"),
)


def _hint_from_name(name):
    """从参数名推类型线索。⛔ 弱证据，只用于提醒与排序。"""
    low = name.lower()
    for pattern, kind, why in _NAME_HINTS:
        if re.search(pattern, low):
            return {"kind": kind, "confidence": "weak", "why": why}
    return None


def _annotation_of(param):
    """参数注解。⛔ 拿不到就说拿不到 —— 多数 TTS 上游没写注解。"""
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


# ---------------------------------------------------------------------------
#  2) 反射一个函数
# ---------------------------------------------------------------------------
#  ⛔ 平台自己的三个 bind 槽位**不算引擎参数** —— 它们的归宿是 call.bind，
#    不是 parameters[]。混进去会造成「同一个概念声明两次」。
BIND_SLOTS = ("self", "text", "ref_audio", "output_path")


def _reflect_callable(fn, phase, skip):
    """反射一个可调用对象，返回参数清单。"""
    try:
        sig = inspect.signature(fn)
    except (ValueError, TypeError) as exc:
        return [], "拿不到签名（%s）—— 有些 C 扩展或装饰器包装的函数是这样" % exc

    out = []
    for name, p in sig.parameters.items():
        if name in BIND_SLOTS:
            continue
        if p.kind in (inspect.Parameter.VAR_POSITIONAL,
                      inspect.Parameter.VAR_KEYWORD):
            out.append({
                "name": name, "phase": phase, "skipped": True,
                "why": "变长参数（*args / **kwargs）—— 平台不替你猜怎么展开",
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
            # ⭐⭐ 名字线索。
            #   为什么必须有（实测逼出来的）：IndexTTS2 的 14 个真参数里有
            #   **4 个默认值是 None** —— use_cuda_kernel / emo_audio_prompt /
            #   emo_vector / emo_text。人写的时候是按**参数名的语义**定的类型
            #   （use_* ⇒ 开关，*_prompt ⇒ 音频，*_vector ⇒ 数字数组，*_text ⇒ 文本）。
            #   ⇒ 只看默认值会把这 4 个**全部漏掉**，而漏掉的表现是
            #   「界面上少了一个真实存在的旋钮」，**没有任何报错**。
            #   ⚠ 它是线索不是结论：最终由人定，这里只是别把证据丢了。
            "name_hint": _hint_from_name(name),
        }
        # Literal[...] 里的选项是**上游自己说的**，可以直接用
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
#  3) 主流程
# ---------------------------------------------------------------------------
def reflect(spec):
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
    load, w = _reflect_callable(klass.__init__, "load", skip)
    if w:
        warnings.append("加载期：%s" % w)

    # --- 调用期：目标方法的参数 ---
    call = []
    if method_name:
        fn = getattr(klass, method_name, None)
        if fn is None:
            warnings.append("调用期：%s 上没有 %s 这个方法 —— 只给了加载期"
                            % (class_name, method_name))
        else:
            if isinstance(fn, property):
                fn = fn.fget
            call, w = _reflect_callable(fn, "call", skip)
            if w:
                warnings.append("调用期：%s" % w)
    else:
        warnings.append("没给 method —— 只反射了加载期")

    return {
        "ok": True,
        "python": {
            "version": sys.version.split()[0],
            "executable": sys.executable,
            "module_file": getattr(root, "__file__", None),
        },
        "class": "%s.%s" % (module_name, class_name),
        "method": method_name,
        "load": load,
        "call": call,
        "warnings": warnings,
    }


def main(argv):
    if "--spec-file" in argv:
        path = argv[argv.index("--spec-file") + 1]
        with open(path, "r") as fh:
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
    return 0  # ⭐ 永远是 0：ok=false 是一个答案


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
