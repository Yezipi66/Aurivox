"""
Static import-order auditor for the torch-before-librosa native-crash class.

For each entry script we DFS its LOCAL imports in textual order and record the
first point at which `torch` and `librosa` become loaded (directly OR
transitively). If torch loads strictly before librosa AND librosa is loaded at
all in that process, the entry is FLAGGED as at-risk for the 0xC0000005 crash.
"""
import os, re

# ROOT points at <project>/lib/training. Order of resolution:
#   1) env var  IMPORT_AUDIT_ROOT
#   2) auto-detect relative to this script (packaged at <project>/tools/...)
#   3) fall back to the dev sandbox path
def _detect_root():
    env = os.environ.get("IMPORT_AUDIT_ROOT")
    if env and os.path.isdir(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.path.join(here, "..", "lib", "training"),   # tools/ next to lib/
        os.path.join(here, "lib", "training"),          # run from project root
    ):
        cand = os.path.normpath(cand)
        if os.path.isdir(cand):
            return cand
    return "/app/workspace/sources/lib/training"

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

ENTRIES = [
    ("gsv_code/s2_train.py", ["gsv_code"]),
    ("gsv_code/s1_train.py", ["gsv_code"]),
    ("gsv_code/prepare_datasets/1-get-text.py", ["gsv_code"]),
    ("gsv_code/prepare_datasets/2-get-hubert-wav32k.py", ["gsv_code"]),
    ("gsv_code/prepare_datasets/3-get-semantic.py", ["gsv_code"]),
    ("gsv_code/prepare_datasets/2-get-sv.py", ["gsv_code"]),
    ("gsv-tools/slicer2.py", ["gsv-tools"]),
    ("gsv-tools/uvr5/webui.py", ["gsv-tools", "gsv-tools/uvr5"]),
    ("gsv-tools/asr/funasr_asr.py", ["gsv-tools", "gsv-tools/asr"]),
    ("gsv-tools/asr/fasterwhisper_asr.py", ["gsv-tools", "gsv-tools/asr"]),
    # inference server (launched by start.ps1) + its search roots
    ("../inference/infer_server.py", ["../inference"]),
]

def firstidx(events, kind):
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
