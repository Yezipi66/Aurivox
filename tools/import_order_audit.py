"""审计入口脚本的导入顺序，找出 torch 先于 librosa 加载的原生崩溃风险。

在部分 Windows 机器上，先 import torch 再 import librosa 会触发原生访问违例
（退出码 3221225477 / 0xC0000005，日志为空）。本脚本对每个入口脚本按文本顺序
深度优先遍历它自己的本地导入，记录 torch 与 librosa 第一次被加载的位置
（直接或经本地模块间接加载）。torch 早于 librosa，且该进程确实加载了
librosa 的，记为有风险。

用法：python tools/import_order_audit.py
"""
import os, re

# 项目根目录（带 server.js 的那一层）。定位顺序：
#   1) 环境变量 IMPORT_AUDIT_ROOT
#   2) 从本脚本向上找带 server.js 的目录
#   3) 退回 tools/ 的上一级
def _detect_root():
    env = os.environ.get("IMPORT_AUDIT_ROOT")
    if env and os.path.isdir(env):
        return env
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(8):
        if os.path.exists(os.path.join(d, "server.js")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            break
        d = parent
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ROOT = _detect_root()

TORCH = re.compile(r"^\s*(?:import\s+torch(?:audio|vision)?\b|from\s+torch(?:audio|vision)?\b)")
LIBROSA = re.compile(r"^\s*(?:import\s+librosa\b|from\s+librosa\b)")
IMPORT_RE = re.compile(
    r"^\s*(?:import\s+([A-Za-z0-9_.]+)|from\s+([A-Za-z0-9_.]+)\s+import)"
)
THIRD_PARTY_LEAF = {
    "torch", "torchaudio", "torchvision", "librosa", "numpy", "scipy", "sklearn", "pandas", "pyarrow",
    "numba", "os", "sys", "re", "json", "logging", "warnings", "argparse",
    "math", "time", "glob", "traceback", "subprocess", "collections",
    "typing", "functools", "random", "tqdm", "yaml",
}

def find_local_module(modname, search_dirs):
    """在搜索目录里找本地模块的 .py 文件或包的 __init__.py，找不到返回 None。"""
    rel = modname.replace(".", os.sep)
    for d in search_dirs:
        cand = os.path.join(d, rel + ".py")
        if os.path.isfile(cand):
            return cand
        pkg = os.path.join(d, rel, "__init__.py")
        if os.path.isfile(pkg):
            return pkg
    return None

def analyze(entry, search_dirs):
    """遍历入口脚本的本地导入，返回 (种类, 文件, 行号, 原文) 列表。"""
    events = []
    visited = set()

    def walk(path, dirs):
        if path in visited:
            return
        visited.add(path)
        try:
            lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        except Exception:
            return
        local_dirs = [os.path.dirname(path)] + dirs
        for ln, line in enumerate(lines, 1):
            if TORCH.match(line):
                events.append(("torch", path, ln, line.strip()))
            if LIBROSA.match(line):
                events.append(("librosa", path, ln, line.strip()))
            m = IMPORT_RE.match(line)
            if not m:
                continue
            mod = m.group(1) or m.group(2)
            if not mod:
                continue
            if mod.split(".")[0] in THIRD_PARTY_LEAF:
                continue
            sub = find_local_module(mod, local_dirs)
            if sub:
                walk(sub, dirs)

    walk(entry, search_dirs)
    return events

# 下面的路径都相对项目根。第三方代码按工作流环节分类存放，GPT-SoVITS 一支的
# 三部分同在一根之下。
GSV = "engines/gpt-sovits"
GSV_CODE = GSV + "/gsv_code"
GSV_INFER = GSV + "/infer"
ENTRIES = [
    ("engines/gpt-sovits/gsv_code/s2_train.py", [GSV_CODE]),
    ("engines/gpt-sovits/gsv_code/s1_train.py", [GSV_CODE]),
    ("engines/gpt-sovits/gsv_code/prepare_datasets/1-get-text.py", [GSV_CODE]),
    ("engines/gpt-sovits/gsv_code/prepare_datasets/2-get-hubert-wav32k.py", [GSV_CODE]),
    ("engines/gpt-sovits/gsv_code/prepare_datasets/3-get-semantic.py", [GSV_CODE]),
    # 2-get-sv.py 还会从推理运行时导入 ERes2NetV2 与 kaldi；这里的搜索根与
    # lib/training/steps/preprocess.js 设的 PYTHONPATH 一致。
    ("engines/gpt-sovits/gsv_code/prepare_datasets/2-get-sv.py",
     [GSV_CODE, GSV_INFER]),
    ("pipeline/slicer/slicer2.py", ["pipeline/slicer"]),
    ("pipeline/uvr5/webui.py", ["vendor", "pipeline/uvr5"]),
    ("pipeline/asr/funasr_asr.py", ["vendor", "pipeline/asr"]),
    ("pipeline/asr/fasterwhisper_asr.py", ["vendor", "pipeline/asr"]),
    # 推理服务端（tools/cli/start.js 启动它）及其搜索根
    ("lib/inference/infer_server.py", [GSV_INFER]),
]

def firstidx(events, kind):
    """返回指定种类第一次出现的位置与事件，没有则返回 (None, None)。"""
    for i, e in enumerate(events):
        if e[0] == kind:
            return i, e
    return None, None

print("=" * 78)
print("IMPORT-ORDER AUDIT  (torch-before-librosa == 0xC0000005 risk)")
print("=" * 78)
flagged = []
for rel, extra in ENTRIES:
    entry = os.path.join(ROOT, rel)
    if not os.path.isfile(entry):
        print(f"\n[SKIP] {rel} (not found)")
        continue
    dirs = [os.path.join(ROOT, d) for d in extra] + [ROOT]
    ev = analyze(entry, dirs)
    ti, te = firstidx(ev, "torch")
    li, le = firstidx(ev, "librosa")
    has_torch = ti is not None
    has_lib = li is not None
    risk = (has_torch and has_lib and ti < li)
    status = "FLAG" if risk else ("ok" if (has_lib or has_torch) else "-- (neither)")
    print(f"\n[{status}] {rel}")
    print(f"     torch loaded: {has_torch}   librosa loaded: {has_lib}")
    if has_torch:
        print(f"     first torch  : {os.path.relpath(te[1], ROOT)}:{te[2]}  |  {te[3]}")
    if has_lib:
        print(f"     first librosa: {os.path.relpath(le[1], ROOT)}:{le[2]}  |  {le[3]}")
    if risk:
        flagged.append(rel)

print("\n" + "=" * 78)
if flagged:
    print("FLAGGED (torch before librosa -> at risk):")
    for f in flagged:
        print("   -", f)
else:
    print("No entry loads torch before librosa.")
print("=" * 78)
