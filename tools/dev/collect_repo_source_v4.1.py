# -*- coding: utf-8 -*-
"""collect_repo_source.py -- 把「我需要读/改的产品源码」打成一个 zip  [v4 / 2026-08-19]

目的：让助手侧的工作树和你的真机树同步。**不写产品代码，不联网。**

=== v4 为什么重写 ===
v1..v3 连着自伤 5 次，全是同一个病根：**匹配式比要害更宽**。
  ① v1 裸通配 `*token*` 当密钥 -> 吃掉产品源码 pronTokenPositions.js
  ② SKIP_DIRS 含 "build" -> 吃掉整个 tools/build/（发行包定义就在里面）
  ③ 把整个 data/ 当"用户数据" -> DATA_KEEP 的三个随包默认文件全丢
  ④ 512KB 一刀切 -> 悄悄掉文件，且不告诉我掉了什么
  ⑤ 输出起名 aurivox-src-*.zip，绕过了 04_pack_release 的 EXCLUDE_PREFIX
     ("sources_", "manifest-") -> 快照自己进了发行包，占 2.0MB

v4 的四条纪律：
  1. **白名单驱动**：只收明确列出的顶层条目，不再靠"猜哪些该排除"。
     漏收会被自检抓到；错收最多是包大一点，不会让我读到过期/错误的代码。
  2. **判据来自产品定义**：data/ 的裁剪直接 import tools/build/04_pack_release.py
     读 DATA_KEEP，不是我猜的。读不到就明说"用了兜底"。
  3. **自检守卫**：MUST_HAVE 里的关键文件必须在包里，少一个就非零退出。
     这是给 ①②③ 那类自伤上的锁。
  4. **跳过必须可见**：每个被跳过的文件都归到具名理由下并统计；
     超限文件逐个列出（不再有"悄悄掉了"）。

另外内置**闭合检查**：JS 的本地 require/import、Python 的相对 import，
逐条验证目标在包内。断链 = 我拿到的树是残缺的，当场就知道，
而不是等我改代码时才发现少文件。

用法：
    python collect_repo_source.py --list      # 只看清单，不打包（默认）
    python collect_repo_source.py --write     # 真打包
    python collect_repo_source.py --write --with-runtime   # 连嵌入式 CPython 一起
"""
from __future__ import print_function

import collections
import io
import os
import re
import sys
import time

BANNER = "[collector v4 / 2026-08-19]"
def _find_project_root(start):
    """上溯找 server.js 定位项目根（C7）。

    绝不写 dirname(dirname(...)) 这种数层数的写法：本文件当初就在
    项目根，r12c batch13 把它搬进 tools/dev/ 后层数变了，而数层数
    的写法不会报错 —— 只会采集出一棵空树。
    锥点用 server.js 而不是 package.json：node_modules 里遍地是后者。
    """
    d = os.path.abspath(start)
    while True:
        if os.path.exists(os.path.join(d, "server.js")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit(
                "找不到项目根：从 %s 一路上溯都没看见 server.js。"
                % os.path.abspath(start))
        d = parent


ROOT = os.environ.get("AURIVOX_ROOT") or _find_project_root(
    os.path.dirname(os.path.abspath(__file__)))

# ── 1. 白名单：只收这些顶层条目 ────────────────────────────────────────────
#    值 = 该目录的角色，决定它走哪套大小策略。
TOP_ALLOW = collections.OrderedDict([
    ("lib",                  "product"),   # 后端产品源码
    ("web",                  "product"),   # 前端产品源码
    ("tools",                "product"),   # 构建/部署脚本（含发行包定义）
    ("vendor",               "vendored"),  # 预编译第三方（ffmpeg / micromamba / python / node）
    ("engines",              "vendored"),  # 每个 TTS 引擎一个目录，里面是我们维护的上游代码
    ("pipeline",             "vendored"),  # uvr5 / asr / slicer，同上
    ("GPT_SoVITS",           "vendored"),  # 历史遗留，正在评估能否删
    ("data",                 "data"),      # 按产品 DATA_KEEP 裁剪
    ("docs",                 "doc"),
    ("THIRD_PARTY_LICENSES", "doc"),
])

# 根目录散文件：收后缀在此的（开发脚本另行判定）
ROOT_FILE_EXT = {".js", ".cjs", ".mjs", ".json", ".py", ".txt", ".md",
                 ".bat", ".ps1", ".cfg", ".ini", ".example", ".gitignore",
                 ".gitattributes"}
ROOT_FILE_EXTRA = {"LICENSE", "NOTICE", ".env.example", ".gitignore",
                   ".gitattributes"}

# ── 2. 第三方运行时树：永远不收 ───────────────────────────────────────────
#    ⚠ 反向的坑：engines/ 和 pipeline/ 下面装的同样是上游代码，但那是**我们
#    改过、要自己维护的**上游代码（每棵树里都有 LOCAL-CHANGES.md 为证），
#    必须收。别看见"第三方"三个字就顺手排掉。
#    真正不收的只有 vendor/ 下我们一行没动过的成品（micromamba / ffmpeg）
#    和 tools/runtime/ 里下载来的运行时。
THIRD_PARTY_RE = re.compile(
    r"^(vendor/micromamba/"
    r"|vendor/ffmpeg/"
    r"|tools/runtime/"
    r"|tools/wheels/"
    r"|web/node_modules/"
    r"|web/dist/"
    r"|.*/site-packages/"
    r"|.*/dist-packages/"
    r"|.*/node_modules/"
    r"|.*/_vendor/)")

# ── 3. 权重/媒体/产物：按扩展名，这类没有"其实是源码"的风险 ──────────────
WEIGHT_EXT = {".pth", ".ckpt", ".pt", ".onnx", ".bin", ".safetensors", ".h5",
              ".pb", ".npy", ".npz", ".pkl", ".pickle", ".msgpack",
              ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".mp4", ".avi",
              ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".webp",
              ".zip", ".7z", ".tar", ".gz", ".whl", ".exe", ".dll", ".so",
              ".dylib", ".lib", ".pdb", ".obj", ".node", ".wasm",
              ".ttf", ".woff", ".woff2", ".eot", ".db", ".sqlite"}

# ── 4. 过期副本：读到它们我会照着错的改 ───────────────────────────────────
# v4.1 修：v4 只认 `.bak$`，漏了 `tts_infer.yaml.bak-20260817-160832` 这种
# 「带时间戳后缀」的备份 —— 它混进包里，我就会照着 Move-BaseModels 改写**前**
# 的旧配置去改。前八次自伤都是匹配式**过宽**，这次是**过窄**，方向相反、
# 一样有害。所以备份后缀后面允许再跟任意 -/_/. 分隔的时间戳段。
# 尾段只允许**纯数字**（时间戳），不允许任意字母 —— 否则 `models.old_stuff.py`
# 这种正常文件会被当成备份吃掉（我修"过窄"时当场又造了个"过宽"，实测抓到的）。
STALE_RE = re.compile(r"((\.bak|\.orig|\.rej|\.prev)([-_.][0-9]+)*$"
                      r"|~$"
                      r"|^\.patch-backup/|^\.staging/)")

SKIP_DIR_ANY = {".git", "__pycache__", ".pytest_cache", ".mypy_cache",
                ".numba_cache", ".ruff_cache", "node_modules", ".venv",
                "venv", "dist", "build_cache", ".idea", ".vscode"}

# 开发脚本：我自己产的，不需要回传给我
DEV_SCRIPT_RE = re.compile(r"^(apply-r12b-fix.*\.py|probe_.*\.py"
                           r"|collect_repo_source\.py|check_big\.py"
                           r"|fix_.*\.py|mem\d*\.py)$")

# ── 5. 大小策略：按角色分层，不再一刀切 ───────────────────────────────────
#    产品源码不设上限（漏一个产品文件的代价 >> 包大一点）。
SIZE_CAP = {"product": None, "data": None, "doc": 2 * 1024 * 1024,
            "vendored": 1024 * 1024, "root": None}

# ── 6. 自检：这些文件必须在包里，否则整个快照不可信 ───────────────────────
MUST_HAVE = [
    "server.js",
    "package.json",
    "lib/paths.js",
    "lib/paths.node.test.js",
    "lib/inference/tts_infer.yaml",
    "lib/training/model_paths.json",
    "tools/build/04_pack_release.py",       # 发行包唯一定义（②号自伤的锁）
    "tools/build/pack_common.py",
    "tools/run_tests.cjs",
    "tools/scripts/Move-BaseModels.ps1",
    "engines/gpt-sovits/infer/TTS.py",   # 活的引擎代码
    "pipeline/uvr5/uvr5_models.js",
    "data/advanced_params.json",            # ③号自伤的锁
    "data/training_defaults.json",
]

# ── 6b. 全覆盖断言：比 MUST_HAVE 更硬的锁 ─────────────────────────────────
# MUST_HAVE 是"抽查"，而抽查抓不住"匹配式过宽"——我实测重演 ①(*token*) 和
# ④(512KB 一刀切) 两个自伤时，14 项抽查全绿，守卫等于没装。
# 所以这里改成**规则化全覆盖**：下列目录里，磁盘上每一个源码文件都必须进包，
# 差一个就报红并点名。它不依赖我事先想到哪个文件会被误伤。
FULL_COVER = [
    ("lib",              {".js", ".cjs", ".mjs", ".py", ".json", ".yaml", ".yml"}),
    ("tools/build",      {".py", ".js", ".cjs", ".bat", ".ps1"}),
    ("tools/deploy",     {".py", ".js", ".cjs", ".bat", ".ps1"}),
    ("tools/scripts",    {".py", ".js", ".cjs", ".bat", ".ps1"}),
    ("web/src",          {".js", ".ts", ".vue", ".json", ".css"}),
]


def read_bytes(p):
    try:
        with open(p, "rb") as f:
            return f.read()
    except Exception:
        return b""


def read_text(p):
    try:
        return io.open(p, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return ""


def human(b):
    b = float(b)
    for u in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return "%.1f%s" % (b, u)
        b /= 1024.0
    return "%.1fTB" % b


def load_data_keep():
    """DATA_KEEP 必须来自产品定义 —— 我猜错过一次，代价是三个默认文件全丢。"""
    build_dir = os.path.join(ROOT, "tools", "build")
    try:
        import importlib.util as il
        if build_dir not in sys.path:
            sys.path.insert(0, build_dir)      # packer 会 import 同目录 pack_common
        spec = il.spec_from_file_location(
            "_packer", os.path.join(build_dir, "04_pack_release.py"))
        mod = il.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return set(mod.DATA_KEEP), "产品定义 04_pack_release.DATA_KEEP"
    except Exception as e:
        return ({"advanced_params.json", "training_defaults.json", "pron_lexicon"},
                "内置兜底（导入产品定义失败: %s）" % type(e).__name__)


def collect(with_runtime=False):
    data_keep, keep_src = load_data_keep()
    picked = []                                   # (rel, size, role)
    skipped = collections.defaultdict(list)       # reason -> [(rel,size)]

    def role_of(rel):
        top = rel.split("/")[0]
        return TOP_ALLOW.get(top, "root")

    def consider(rel, full):
        try:
            size = os.path.getsize(full)
        except OSError:
            return
        ext = os.path.splitext(rel)[1].lower()
        base = os.path.basename(rel)

        if STALE_RE.search(rel):
            skipped[u"过期副本(.bak/.orig/备份目录) —— 读了会照错的改"].append((rel, size))
            return
        if THIRD_PARTY_RE.match(rel) and not (
                with_runtime and rel.startswith("tools/runtime/")):
            skipped[u"第三方运行时/依赖树（不是我们的源码）"].append((rel, size))
            return
        if ext in WEIGHT_EXT:
            skipped[u"权重/媒体/压缩包（按扩展名，无误伤风险）"].append((rel, size))
            return
        if DEV_SCRIPT_RE.match(base) and "/" not in rel:
            skipped[u"根目录开发脚本（我自己产的，不必回传）"].append((rel, size))
            return

        role = role_of(rel)
        if role == "data":
            seg = rel.split("/")
            if len(seg) > 1 and seg[1] not in data_keep:
                skipped[u"data/ 非 DATA_KEEP 项（每机状态，不进发行包）"].append((rel, size))
                return
        cap = SIZE_CAP.get(role)
        if cap is not None and role in ("product", "data", "root"):
            # 结构性红线：产品源码/随包数据永远不设大小上限。漏一个产品文件的
            # 代价远大于包大一点。④号自伤（512KB 一刀切）就是踩在这里。
            skipped[u"RED 产品源码被大小上限拦下（这类角色本不该有上限）"].append(
                (rel, size))
            return
        if cap is not None and size > cap:
            skipped[u"超过该角色的大小上限（%s 角色上限 %s）"
                    % (role, human(cap))].append((rel, size))
            return
        picked.append((rel, size, role))

    # 顶层白名单目录
    for top, role in TOP_ALLOW.items():
        base_dir = os.path.join(ROOT, top)
        if not os.path.isdir(base_dir):
            continue
        for dp, dn, fn in os.walk(base_dir):
            dn[:] = [d for d in dn if d not in SKIP_DIR_ANY]
            for f in fn:
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, ROOT).replace("\\", "/")
                consider(rel, full)

    # 根目录散文件
    for f in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, f)
        if not os.path.isfile(full):
            continue
        ext = os.path.splitext(f)[1].lower()
        if ext in ROOT_FILE_EXT or f in ROOT_FILE_EXTRA:
            consider(f, full)
        else:
            skipped[u"根目录：非源码后缀"].append((f, os.path.getsize(full)))

    return picked, skipped, data_keep, keep_src


# ── 闭合检查：证明这棵树是自洽的，而不是"看起来挺全" ──────────────────────
JS_REQ = re.compile(r"""(?:require\(|from\s+|import\s+)['"](\.[^'"]+)['"]""")
PY_REL = re.compile(r"^\s*from\s+(\.+)([A-Za-z0-9_.]*)\s+import", re.M)


def closure_check(picked):
    inpkg = set(r for r, _, _ in picked)
    broken = []
    js_n = py_n = 0

    def resolve_js(src, target):
        d = os.path.dirname(src)
        cand = os.path.normpath(os.path.join(d, target)).replace("\\", "/")
        for suf in ("", ".js", ".cjs", ".mjs", ".json", ".ts",
                    "/index.js", "/index.cjs"):
            if cand + suf in inpkg:
                return True
        return False

    for rel, _, _ in picked:
        ext = os.path.splitext(rel)[1].lower()
        full = os.path.join(ROOT, rel.replace("/", os.sep))
        if ext in (".js", ".cjs", ".mjs"):
            txt = read_text(full)
            for m in JS_REQ.finditer(txt):
                js_n += 1
                if not resolve_js(rel, m.group(1)):
                    broken.append(("JS", rel, m.group(1)))
        elif ext == ".py":
            txt = read_text(full)
            for m in PY_REL.finditer(txt):
                py_n += 1
                dots, mod = m.group(1), m.group(2)
                d = os.path.dirname(rel)
                for _ in range(len(dots) - 1):
                    d = os.path.dirname(d)
                cand = (d + "/" + mod.replace(".", "/")) if mod else d
                cand = cand.lstrip("/")
                if not (cand + ".py" in inpkg or cand + "/__init__.py" in inpkg
                        or any(x.startswith(cand + "/") for x in inpkg)):
                    broken.append(("PY", rel, dots + mod))
    return js_n, py_n, broken


def main(argv):
    write = "--write" in argv
    verbose = "--verbose" in argv
    with_runtime = "--with-runtime" in argv

    print("project root : %s" % ROOT)
    print("collector    : %s" % BANNER)
    print("mode         : %s" % ("WRITE（真打包）" if write else "LIST（只看清单，不打包）"))
    print("纪律         : 白名单驱动 / 判据取自产品定义 / 自检守卫 / 跳过全部可见")

    picked, skipped, data_keep, keep_src = collect(with_runtime)
    print("data/ 白名单 : %s -> %s" % (keep_src, ", ".join(sorted(data_keep))))

    total = sum(s for _, s, _ in picked)
    print("\n== 将收进 zip ==")
    print("   %d 个文件，合计 %s" % (len(picked), human(total)))
    by_top = collections.defaultdict(lambda: [0, 0])
    for rel, size, _ in picked:
        top = rel.split("/")[0] if "/" in rel else "(根目录)"
        by_top[top][0] += 1
        by_top[top][1] += size
    for top in sorted(by_top, key=lambda k: -by_top[k][1]):
        n, s = by_top[top]
        print("     %-24s %5d 个  %10s" % (top, n, human(s)))

    # ── 自检：给 ①②③ 那类自伤上的锁 ──
    print("\n== 自检：关键文件必须在包里 ==")
    inpkg = set(r for r, _, _ in picked)
    missing = [m for m in MUST_HAVE if m not in inpkg]
    ondisk_missing = [m for m in missing
                      if not os.path.exists(os.path.join(ROOT, m.replace("/", os.sep)))]
    real_missing = [m for m in missing if m not in ondisk_missing]
    if real_missing:
        print("   RED 磁盘上有、却被我的规则排掉了（= 又一次匹配式过宽）：")
        for m in real_missing:
            print("        - %s" % m)
    else:
        print("   ok  %d/%d 项全部收进（规则没有误伤）"
              % (len(MUST_HAVE) - len(ondisk_missing), len(MUST_HAVE)))
    if ondisk_missing:
        print("   note 这些磁盘上本来就没有（不算误伤，但值得你看一眼）：")
        for m in ondisk_missing:
            print("        - %s" % m)

    # 全覆盖断言（比抽查硬：不依赖我事先想到哪个文件会被误伤）
    print("\n== 全覆盖断言：产品源码目录一个文件都不许漏 ==")
    cover_bad = []
    for sub, exts in FULL_COVER:
        base_dir = os.path.join(ROOT, sub.replace("/", os.sep))
        if not os.path.isdir(base_dir):
            print("   note %-18s 磁盘上没有这个目录，跳过" % sub)
            continue
        want = set()
        for dp, dn, fn in os.walk(base_dir):
            dn[:] = [d for d in dn if d not in SKIP_DIR_ANY]
            for f in fn:
                rel = os.path.relpath(os.path.join(dp, f), ROOT).replace("\\", "/")
                if STALE_RE.search(rel) or THIRD_PARTY_RE.match(rel):
                    continue          # 这两类本来就该排，不算漏
                if os.path.splitext(f)[1].lower() in exts:
                    want.add(rel)
        miss = sorted(want - inpkg)
        if miss:
            cover_bad.extend(miss)
            print("   RED %-18s 磁盘 %4d 个，进包 %4d 个，**漏 %d 个**"
                  % (sub, len(want), len(want) - len(miss), len(miss)))
            for m in miss[:10]:
                print("        - %s" % m)
            if len(miss) > 10:
                print("        ... 另 %d 个" % (len(miss) - 10))
        else:
            print("   ok  %-18s 磁盘 %4d 个，全部进包" % (sub, len(want)))
    structural = [k for k in skipped if k.startswith(u"RED ")]
    if structural:
        print("   RED 结构性违规（规则本身写错了，不是数据的问题）：")
        for k in structural:
            print("        %s —— %d 个" % (k[4:], len(skipped[k])))
    real_missing = real_missing + cover_bad + structural

    # ── 闭合检查 ──
    print("\n== 闭合检查：包内代码的本地依赖是否都在包里 ==")
    js_n, py_n, broken = closure_check(picked)
    print("   JS 本地 require/import %d 条，Python 相对 import %d 条" % (js_n, py_n))
    if broken:
        print("   RED %d 条断链（说明这棵树是残缺的）：" % len(broken))
        for kind, src, tgt in broken[:20]:
            print("        [%s] %s -> %s" % (kind, src, tgt))
        if len(broken) > 20 and not verbose:
            print("        ... 另 %d 条（--verbose 全列）" % (len(broken) - 20))
    else:
        print("   ok  0 条断链 —— 这棵树是自洽的")

    # ── 跳过明细 ──
    print("\n== 跳过明细（每一条都有具名理由；不存在'悄悄掉了'）==")
    for reason in sorted(skipped, key=lambda k: -len(skipped[k])):
        items = skipped[reason]
        s = sum(x[1] for x in items)
        print("   %-52s %5d 个  %10s" % (reason[:52], len(items), human(s)))
    over = [(r, s) for k, v in skipped.items() if u"大小上限" in k for r, s in v]
    if over:
        print("\n   因超限而未收的，逐个列出（%d 个）：" % len(over))
        for r, s in sorted(over, key=lambda x: -x[1]):
            print("     %10s  %s" % (human(s), r))
    if verbose:
        for reason in sorted(skipped):
            print("\n   -- %s --" % reason)
            for r, s in sorted(skipped[reason])[:200]:
                print("      %10s  %s" % (human(s), r))

    if not write:
        print("\n（--list 模式，没有打包。确认清单无误后加 --write）")
        return 1 if (real_missing or broken) else 0

    # ── 打包 ──
    # 文件名必须以 sources_ 开头：04_pack_release.EXCLUDE_PREFIX 认这个前缀，
    # 快照才不会把自己打进发行包（第 ⑤ 号自伤就是起名绕过了它）。
    import zipfile
    name = "sources_aurivox_%s.zip" % time.strftime("%Y%m%d_%H%M%S")
    out = os.path.join(ROOT, name)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel, _, _ in picked:
            # arcname 强制正斜杠：PowerShell 的 Compress-Archive 用反斜杠写
            # 路径，Linux 侧解出来会变成名叫 "a\b.json" 的单个文件（踩过）。
            z.write(os.path.join(ROOT, rel.replace("/", os.sep)), rel)
    print("\n== 已打包 ==")
    print("   %s" % out)
    print("   %d 个文件，压缩后 %s" % (len(picked), human(os.path.getsize(out))))
    print("   前缀 sources_ 会被 04_pack_release.EXCLUDE_PREFIX 自动排除，不会进发行包。")
    return 1 if (real_missing or broken) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
