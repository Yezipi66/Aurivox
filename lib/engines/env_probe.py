# -*- coding: utf-8 -*-
"""引擎环境探针 —— 在**引擎自己的解释器**里跑，回答「这台引擎装没装」。

平台对引擎环境的立场是 **只验不建**（Owner 2026-08-24 拍板）：不装环境、
不装包、不管版本，只核对名片说的那个模块/类/方法在不在。核对不过 =
这台引擎没装，平台不代劳也不背书。

⛔ 只用标准库
-------------
这个文件会被**任意引擎的 venv** 拿去跑（IndexTTS2 的 torch 2.8+cu128、
GPT-SoVITS 的 2.2+cu121，将来还有别的）。这些环境之间没有共同依赖，
唯一能指望的就是标准库。这条纪律和 engines/_shim 那份是同一条。

⛔ 不许 import 名片没点名的东西
-------------------------------
探针只 import `spec.imports` 里逐条列出的模块。不许"顺手 import torch
看看有没有 GPU" —— 那会把平台的假设塞进本该由名片说了算的地方。

输入/输出
---------
    python env_probe.py --spec-file <path>      # 或 --spec <json>
    stdout: 一行 JSON  {"ok": bool, "python": {...}, "checks": [...]}

⭐ 退出码永远是 0（除非探针自己崩了）。「没装」是一个**答案**，不是探针
   出错 —— 把它编码进 ok=false，调用方才能区分"引擎没装"和"探针没跑起来"。
"""

import json
import sys


def _describe_python():
    return {
        "executable": sys.executable,
        "version": "%d.%d.%d" % sys.version_info[:3],
    }


def _check_one(item):
    """检查一条 {module, class, methods, init_params}。"""
    module_name = item.get("module")
    result = {
        "module": module_name,
        "class": item.get("class"),
        "ok": False,
        "detail": "",
        "missing": [],
    }

    try:
        import importlib
        mod = importlib.import_module(module_name)
    except BaseException as exc:
        # ⛔ 这里必须抓 BaseException 而不是 Exception：native 扩展导入失败
        # 时抛的不一定是 Exception 的子类（见过 SystemExit 和裸 KeyboardInterrupt
        # 形状的东西），漏网的话探针自己会以非零码死掉，调用方就分不清
        # 「引擎没装」和「探针崩了」。
        result["detail"] = "import 失败: %s: %s" % (type(exc).__name__, exc)
        result["missing"].append("module:%s" % module_name)
        return result

    result["module_file"] = getattr(mod, "__file__", None)

    class_name = item.get("class")
    if not class_name:
        result["ok"] = True
        result["detail"] = "模块能 import"
        return result

    target = getattr(mod, class_name, None)
    if target is None:
        result["detail"] = "模块里没有 %s" % class_name
        result["missing"].append("class:%s.%s" % (module_name, class_name))
        return result

    for name in item.get("methods") or []:
        attr = getattr(target, name, None)
        if attr is None or not callable(attr):
            result["missing"].append("method:%s.%s" % (class_name, name))

    init_params = item.get("init_params") or []
    if init_params:
        try:
            import inspect
            sig = inspect.signature(target.__init__)
            names = set(sig.parameters)
            # **kwargs 的存在意味着"什么名字都收"，这时候按名字核对没有意义，
            # 核对通过也说明不了什么 —— 老实记下来，别假装检查过了。
            has_var_kw = any(p.kind == inspect.Parameter.VAR_KEYWORD
                             for p in sig.parameters.values())
            if has_var_kw:
                result["init_params_note"] = "构造函数收 **kwargs，参数名核对不具判别力"
            else:
                for name in init_params:
                    if name not in names:
                        result["missing"].append("init_param:%s(%s)" % (class_name, name))
        except (TypeError, ValueError) as exc:
            result["init_params_note"] = "读不出构造函数签名: %s" % exc

    result["ok"] = not result["missing"]
    result["detail"] = "都在" if result["ok"] else "缺: " + ", ".join(result["missing"])
    return result


def run(spec):
    for entry in spec.get("sys_path") or []:
        if entry not in sys.path:
            sys.path.insert(0, entry)

    checks = [_check_one(item) for item in spec.get("imports") or []]
    return {
        "ok": all(c["ok"] for c in checks) if checks else True,
        "python": _describe_python(),
        "sys_path_added": spec.get("sys_path") or [],
        "checks": checks,
    }


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description="Aurivox engine environment probe")
    ap.add_argument("--spec", default=None, help="JSON 规格（直接传）")
    ap.add_argument("--spec-file", default=None, help="JSON 规格文件路径")
    ns = ap.parse_args(argv)

    if ns.spec_file:
        with open(ns.spec_file, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    elif ns.spec:
        spec = json.loads(ns.spec)
    else:
        spec = json.loads(sys.stdin.read() or "{}")

    sys.stdout.write(json.dumps(run(spec), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
