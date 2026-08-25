#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""
04_pack_release.py — assemble the distributable "extract-and-run" release zip.

What goes IN:
  * source (server.js, lib/, web/ minus node_modules), pre-built web/dist
  * package*.json (incl. package-lock.json) — deps are RESTORED at deploy time
    via `npm ci`, NOT shipped (see BLACKLIST). Ship the lockfile so the restore
    is reproducible.
  * tools/ (build + deploy + scripts + wheels + runtime[python+node])
  * root entries: deploy.bat start.bat stop.bat, README_用户版.txt,
    requirements.txt, package*.json, business configs (server.js, *.json)
  * tools\deploy\: bootstrap.ps1, install_torch.ps1, download_models.py,
    download_ffmpeg.py (deploy/ops scripts live here, not at the root)
What stays OUT (BLACKLIST — users download / generate):
  * ALL models (~9GB): pretrained / asr / uvr5 weights / *.onnx / *.bin ...
  * vendor/ffmpeg (~275MB, OPTIONAL — only vocal separation; via download_ffmpeg.py)
  * venv/ (built at deploy time), assets/ (your trained chars), voices/ data/
  * ALL node_modules (backend + web) — restored at deploy time via `npm ci`
    (reduces bundle size AND avoids redistributing third-party npm packages)
  * .git .staging logs outputs backups caches, dev junk
  * old temp/dev scripts + leftover patch folders (see EXCLUDE_FILES/TOP_EXCLUDE)
  * *.pdb debug symbols shipped by the embedded python

Run AFTER 01_build_frontend + 02_make_wheelhouse + 03_fetch_runtimes:
    python tools\\build\\04_pack_release.py
    python tools\\build\\04_pack_release.py --version 1.0.0 --out dist\\release.zip
"""

import argparse
import os
import sys
import time
import zipfile

import pack_common

PRODUCT = "Aurivox"

# Release size budget. The heavy payloads (models ~9GB, torch, ffmpeg, venv) are
# NOT shipped — they are downloaded at deploy time — so the extract-and-run zip
# must stay small. These are enforced by the packer (override via CLI flags).
MAX_UNCOMPRESSED_MB = 500
MAX_COMPRESSED_MB = 200

# Directory names dropped ONLY when they sit at the repo TOP level. These are
# generic words ("data", "assets", "output", "dist" ...) that also legitimately
# occur DEEP inside dependencies (e.g. web/dist is our built frontend, and many
# node/python packages ship a "data"/"assets" folder). Matching them by bare
# name at any depth would wrongly delete needed files — that is exactly why an
# earlier build shipped without web/dist. So these are anchored to the top level.
TOP_EXCLUDE = {
    # ".venv" 搬去了 NAME_EXCLUDE：它不是"通用词"，是 Python 虚拟环境的
    # 约定名，任何深度出现的 .venv 都一定是虚拟环境。留在这里只能挡住
    # 顶层的，挡不住 engines\<id>\.venv\（每引擎一套，各 8GB 起）。
    # "venv_idx241" 已删：那个目录被移到 D:\Project\env_backup\，
    # 项目内不存在 ⇒ 死条目。排除清单腐烂的表现不是报错，是包大了
    # 没人发现，所以死条目要当场删，不要"留着也没坏处"。
    "venv", "assets", ".staging",
    # dev-time backups written by the apply-r12b-fix*.py patch scripts
    # (57 files, 1.8MB). Same category as .staging, which is already here.
    #
    # r12c-batch15: this entry went STALE and silently stopped matching. It
    # names a TOP-LEVEL ".patch-backup" (leading dot); the patch scripts have
    # since written to "cache/patch-backup/" (no dot, one level deeper). The
    # rule kept evaluating, kept matching nothing, and 73 backup files -- five
    # r12b-era timestamped snapshots plus the r12c-batch12/13/14 backups,
    # including their applied.patch diffs -- shipped to end users. Kept here
    # for machines that still carry the old top-level folder; the live catch
    # is now the "patch-backup" entry in NAME_EXCLUDE, which is anchored to the
    # directory NAME at ANY depth and therefore survives the next move.
    ".patch-backup",
    # cache/ is scratch: patch backups (above), the HuggingFace hub cache
    # (cache/hf/...), and one-off build logs. Nothing here is read on a fresh
    # install -- every consumer recreates its own cache on first use.
    "cache",
    # .hermes/ is dev-only tooling state. Zero references from any shipped
    # code path (grepped across js/cjs/py/bat/ps1/json: the only two hits are
    # comments in dev scripts), yet it shipped one 14.3KB file.
    ".hermes",
    "logs", "log", "outputs", "output", "backups", "tmp", "temp",
    "cr-sandbox", "voices", "dist",  # top-level dist = our own output
    # leftover folders from extracting an older distribution-kit patch in place
    "distribution-kit-patch", "root",
    # dev-only training recipes / experiment configs — not needed at runtime
    "recipes",
}

# Top-level directory NAME PREFIXES dropped only at the repo top level. This
# catches the per-engine Python virtualenvs (venv_idx241 today, plus future
# venv_idx2* etc. for IndexTTS2) without having to enumerate each one. Each of
# these ships a full CUDA torch stack (~gigabytes) and is REBUILT at deploy
# time, so it must never land in the extract-and-run zip. Anchored to the top
# level so a legit deep "venv_*" inside a dependency is never touched.
TOP_EXCLUDE_PREFIX = ("venv_", "venv-", ".venv_")

# Top-level "data/" holds ALL runtime data since the step-2 move (it used to be
# scattered across the repo root). It can no longer be dropped wholesale: the
# two shipped default files live there now and used to ship from the root. So
# data/ is pruned by an ALLOWLIST instead — anything not named here (the voice
# registry, its backups, recipes, canvas graphs and run state, the per-machine
# app-config.json) is per-installation state and must never ship.
DATA_KEEP = {
    "advanced_params.json",   # shipped defaults, overridable by the user
    "training_defaults.json",  # ditto
    "pron_lexicon",            # shipped pronunciation dictionaries
}

# Dev/VCS/cache junk safe to drop at ANY depth.
NAME_EXCLUDE = {
    ".git", ".hg", ".svn",
    # r12c batch16: 每引擎自带一套 Python 环境（GSV 是 torch 2.2.0+cu121，
    # IndexTTS2 是 2.8.0+cu128 —— 四个 minor 版本 + 两个 CUDA 大版本之差，
    # 合并共享会把两个引擎的稳定性焊死，所以隔离是唯一解）。这些环境
    # 现在住在 engines\<id>\.venv\，在 deploy 时重建，绝不进发行包。
    # ⭐ 放这里而不是 TOP_EXCLUDE：TOP_EXCLUDE 是给 data/assets/dist 这类
    #    **通用词**用的（深层可能是依赖自己的合法目录，误删过 web/dist）。
    #    ".venv" 不是通用词，它是虚拟环境的约定名，和 __pycache__ 同类。
    ".venv",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".numba_cache", ".cache", ".gradio", ".ipynb_checkpoints",
    # r12c-batch15: apply-*.py patch backups, by DIRECTORY NAME at any depth.
    # TOP_EXCLUDE already drops "cache" and ".patch-backup", but both of those
    # are anchored to a specific location -- which is exactly how the original
    # ".patch-backup" rule died when the backups moved into cache/. This entry
    # is location-independent on purpose: it is the one that keeps working
    # after the next move.
    "patch-backup",
}

# The bundled portable Node runtime keeps its OWN node_modules (that is where npm
# itself lives: tools/runtime/node/node_modules/npm/...). It must be shipped or
# `npm.cmd` is a hollow shell and the deploy-time `npm ci` cannot run. Every
# OTHER node_modules (the app's backend + web deps) is dropped — see the
# node_modules rule in in_excluded_tree(). This anchor marks the ONE we keep.
NODE_RUNTIME_PREFIX = "tools/runtime/node/"

# Specific subtrees (relative paths) to drop wherever they are anchored.
PATH_EXCLUDE = {
    os.path.join("web", "node_modules"),
    # r12c-batch15: tools/dev holds ASSISTANT-GENERATED dev tooling -- the
    # apply-r12c-batch*.py patch scripts, collect_repo_source*.py, and the
    # read-only probes. r12c-batch13 moved them OUT of the repo root (the root
    # layout guard only inspects depth 1) and into tools/dev -- but tools/ is
    # shipped wholesale, so "tidying the root" quietly moved them INTO the
    # release. Caught by arithmetic: --dry-run reported 5908 files while the
    # probe reported 5909, and the one extra file was the probe itself, which
    # had just been dropped into tools/dev. Same failure mode as the stale
    # ".patch-backup" rule above: a depth-anchored guard vs. content that moved.
    os.path.join("tools", "dev"),
    # ffmpeg is OPTIONAL (only vocal separation / UVR5 needs it) and ~275MB.
    # Users fetch it on demand via download_ffmpeg.py, so keep it out of source.
    os.path.join("vendor", "ffmpeg"),
    # cmake is installed by 02_make_wheelhouse.bat purely to BUILD wheels
    # ("pip install --upgrade pip setuptools wheel cmake") and is never
    # used at runtime. KEEP_EXT holds .exe unconditionally, so without
    # this entry cmake-gui.exe (32.3MB), ctest.exe (13.8MB), cpack.exe
    # (12.9MB), cmake.exe (12.8MB) and CMake.qch (9.0MB) all shipped:
    # 4165 files, 92.8MB -- the single largest thing in the release.
    os.path.join("tools", "runtime", "python", "Lib", "site-packages", "cmake"),
    # (removed 2026-08-25) The "vendor/micromamba" exclusion is gone.
    # vendor\micromamba was deleted from disk on 2026-08-24 and contract clause
    # C12.3 now forbids introducing a second package ecosystem (conda-forge) at
    # all -- the reason is licence-manifest boundaries, not technology.
    # So unlike the GPT_SoVITS/ rule in .gitignore (deliberately kept as an
    # anti-regression guard, because weights CAN get re-downloaded into place),
    # this tree will not come back. A rule pointing at a dead end is worse than
    # no rule: it tells the next reader we still use conda.
    # Engine virtualenvs live in engines\<id>\.venv\ and are already covered by
    # NAME_EXCLUDE above.
    # There are two gsv_code trees on disk; the live engine is
    # engines/gpt-sovits/gsv_code. This old one holds no code that
    # anything imports -- BUT it used to hold four runtime *data* files
    # (namedict_cache.pickle, ja_userdic/{userdict.csv,user.dict,userdict.md5})
    # which are loaded by path, not by import, so "zero references" never
    # applied to them. They were migrated into the live tree on 2026-08-19;
    # before that migration this exclusion silently shipped releases with an
    # empty English name dictionary and no Japanese user dictionary.
    # Do not re-derive "unused" for data files from import graphs.
    os.path.join("vendor", "gsv_code"),
    # vendor/gsv-infer is a CUDA compilation artifact leftover (1 byte,
    # BigVGAN/alias_free_activation/cuda/build/_). The live BigVGAN lives
    # in engines/gpt-sovits/infer/BigVGAN. Zero references, never should
    # have shipped, but without this exclusion it does.
    os.path.join("vendor", "gsv-infer"),
    # Pure model dirs (no needed code lives here). All of these live under
    # models/ since r12b; the old vendor/gsv-tools/... entries listed here
    # before pointed at directories that no longer exist, so nothing was
    # actually being excluded.
    #
    # models/ is NOT excluded wholesale on purpose: models/tts/gpt-sovits/
    # G2PWModel/ also holds the polyphone dictionaries, which are small, are
    # NOT re-downloaded (download_models.py only fetches g2pW.onnx out of the
    # official zip) and therefore must ship. The 635MB .onnx beside them is
    # dropped by EXCLUDE_EXT.
    os.path.join("models", "tts", "gpt-sovits", "v1"),
    os.path.join("models", "tts", "gpt-sovits", "v2"),
    os.path.join("models", "tts", "gpt-sovits", "v2Pro"),
    os.path.join("models", "tts", "gpt-sovits", "v2ProPlus"),
    os.path.join("models", "tts", "gpt-sovits", "sv"),
    os.path.join("models", "tts", "gpt-sovits", "chinese-hubert-base"),
    os.path.join("models", "tts", "gpt-sovits", "chinese-roberta-wwm-ext-large"),
    # ASR weights only; the ASR scripts (fasterwhisper_asr.py, asr_utils.py,
    # funasr_asr.py, config.py) live in pipeline/asr/ and do ship.
    os.path.join("models", "asr"),
    os.path.join("models", "separation"),
    os.path.join("models", "vocoder"),
    os.path.join("models", "sr"),
    os.path.join("models", "lang"),
    # r12c batch16: 四条 vendor/gsv-tools/* 排除已删（pretrained /
    # asr/faster-whisper-large-v3 / asr/models / uvr5/uvr5_weights）。
    # 权重自 r12b 起住在 models/ 下，vendor/gsv-tools 这棵树已不存在
    # ⇒ 这四条一条也没在排除任何东西，是**冗余不是保险**。
    # ⭐ 真正的保险是 EXCLUDE_EXT（已含全套权重扩展名）+ 新增的
    #    tools/build/check_release_size.py（按体量兜底）。
    #    按名字排除总会漏 —— 这四条本身就是漏掉的证据。
    # （fix12 那段考古注释随三条陈旧路径一并删除。它记的教训——"规则
    #   写错了不会报错，只会静默不生效"——已由 check_release_size.py
    #   接管，那是**结构性**的接管，不是再写一条注释提醒下一个人。）
    # r12c: the GPT-SoVITS tree moved vendor/tts/gpt-sovits -> engines/gpt-sovits.
    # These two entries are written segment-by-segment, so the textual
    # "vendor/tts/gpt-sovits" -> "engines/gpt-sovits" sweep did NOT catch them.
    # Left stale they would silently stop excluding, and the weights would be
    # packed into the release — the failure mode is a 600MB-larger zip, not an
    # error, which is exactly the kind that ships unnoticed.
    os.path.join("engines", "gpt-sovits", "gsv_code", "pretrained_models"),
    # SR (24k->48k bandwidth-extension) weights: user-downloaded, not source
    os.path.join("engines", "gpt-sovits", "infer", "sr", "AP_BWE_main", "24kto48k"),
}

# stray model/media files anywhere (keeps sibling json/py/txt that code needs,
# e.g. G2PWModel keeps its dicts but drops the 635MB g2pW.onnx)
EXCLUDE_EXT = {
    ".pth", ".ckpt", ".pt", ".onnx", ".bin", ".safetensors", ".h5", ".pb",
    ".npy", ".npz", ".pkl", ".gguf", ".ggml",
    ".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma",
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
    ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".zst",
    ".pdb",  # debug symbols (embedded python ships ~50MB of these; unused at runtime)
    ".pyc", ".pyo",  # compiled bytecode; a loose *.pyc beside a *.py is NOT caught
                     # by the __pycache__ dir rule and would otherwise ship
}
# never drop these even if large (runtime + wheels + ffmpeg live here)
KEEP_EXT = {".exe", ".dll", ".whl", ".node", ".pyd", ".so", ".lib"}

# Extensions whose bytes are ALREADY compressed. Re-running DEFLATE over them
# burns CPU for ~0% size gain (a .whl is itself a zip; PNG/woff2/gz are packed),
# so we store them uncompressed (ZIP_STORED). The archived size is unchanged vs
# deflating (both ~= the file's own size), but we skip the compressor entirely,
# which is a large chunk of pack time. Note: .dll/.exe/.pyd are deliberately NOT
# here — they DO compress meaningfully, so they keep DEFLATE to respect the size
# budget.
STORED_EXT = {
    ".whl", ".zip", ".7z", ".gz", ".bz2", ".xz", ".zst", ".rar",
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".woff", ".woff2",
}


def _compress_type_for(name):
    """ZIP_STORED for already-compressed payloads, else ZIP_DEFLATED."""
    return (zipfile.ZIP_STORED
            if os.path.splitext(name)[1].lower() in STORED_EXT
            else zipfile.ZIP_DEFLATED)

# Specific files to drop (BLACKLIST). These are old temp/dev scripts, build
# by-products and stray reports that used to litter the project root. Excluding
# them by exact name keeps the release clean without an allowlist, so newly
# added source files ship automatically (developer-friendly).
EXCLUDE_FILES = {
    # stray reports / caches (junk at any depth)
    "tree_report.txt",  # loose *.pyc now dropped generically via EXCLUDE_EXT
    "requirements.lock.current.txt",
    # Relocation ledger written by tools/scripts/Move-BaseModels.ps1. It
    # sits in models/ ROOT, and models/ is deliberately not excluded
    # wholesale (G2PWModel's dictionaries must ship), while PATH_EXCLUDE
    # only lists subdirectories under it -- so this per-machine run record
    # slipped through. .csv is not in EXCLUDE_EXT either, by design:
    # data/pron_lexicon ships .csv dictionaries.
    ".r12b-move-journal.csv",
    # G2PWModel/record.log -- training run output, not a shipped asset.
    "record.log",
    # Regenerable pickle caches. Dropped BY NAME, not by extension: the
    # three .pickle files in gsv_code/text do NOT behave alike.
    #   engdict_cache.pickle  english.py:224  else: read_dict(); cache_dict()
    #   polyphonic.pickle     g2pw.py:118     else: read_dict(); cache_dict()
    # both rebuild themselves on first use, so shipping the dev machine's
    # copy is pure weight. But:
    #   namedict_cache.pickle english.py:237  else: name_dict = {}
    # has NO rebuild path -- it degrades silently to an empty dictionary.
    # An extension-wide .pickle rule would therefore break English name
    # pronunciation on end-user machines with no error anywhere. Keep it
    # shipping; only the two self-rebuilding caches are dropped.
    "engdict_cache.pickle",
    "polyphonic.pickle",
    # per-machine user state written by the running app (paths.js). It pins an
    # ABSOLUTE assetsRoot from whatever machine last ran; shipping it forces
    # every tester's assets/.staging onto the dev machine's D:\ path. Must NOT
    # ship -- paths.js then correctly defaults to <install-root>\assets.
    "app-config.json",
    # dev machine's voice roster (server.js loadVoices() returns {} if absent).
    # Shipping it makes every tester see phantom voices that don't exist locally.
    "voices.json",
    # deploy-time state written by deploy_wizard.py (per-machine selection); must
    # not ship in a source release.
    ".deploy_selection.json", ".deploy_models.txt", ".deploy_ffmpeg.txt",
    # PER-MACHINE runtime state (lib\inference\tts_infer.yaml). It pins THIS
    # box's ABSOLUTE model paths + device + the last-selected GPT/SoVITS weights
    # and is hot-rewritten by the running engine. Shipping it forces every
    # tester onto the dev machine's D:\ paths, so the engine fails to load after
    # extract. The release carries tts_infer.yaml.example instead (different
    # basename, kept) and start.ps1 regenerates the live file on first run.
    "tts_infer.yaml",
    # "nul" is a RESERVED Windows device name, not a real file. It gets created
    # accidentally by a shell redirect bug (e.g. `... >nul` run in a context that
    # writes a literal file). It cannot be extracted on Windows (the OS rejects
    # the name) and must never ship. Drop it at any depth.
    "nul", "NUL",
}
# Old junk that lived AT THE PROJECT ROOT. Matched ONLY at top level so we don't
# accidentally drop legit same-named files that now live deeper, e.g. the real
# launchers tools\scripts\start.ps1 / stop.ps1 and the dev tool
# tools\scripts\dump_tree.ps1 must still ship.
ROOT_EXCLUDE_FILES = {
    "dump_tree.ps1",
    # superseded packer / one-off surgery & patch scripts
    "pack_sources.py", "apply_gsv_patch3.py", "surgery.py", "test_phase4.js",
    # old root launchers, replaced by start.bat + tools\scripts\*.ps1. NOTE: the
    # CURRENT user-facing stop launcher IS the root stop.bat (it calls
    # tools\scripts\stop.ps1) and MUST ship — do not blacklist it here. Only the
    # truly obsolete root scripts below are dropped.
    "start.ps1", "start.vbs", "stop.ps1",
    "restart.bat", "run_start.bat",
    # superseded by download_models.py wizard
    "configure_models.bat",
    # IndexTTS2 bring-up EXPERIMENTS — dev-only scratch scripts kept in the repo
    # while that engine is being wired up. They hardcode dev-machine paths and
    # must not ship to end users. (The real, user-facing IndexTTS setup runs from
    # the deploy wizard / bootstrap, not these.)
    "try_indextts2.ps1", "try_indextts2_stage2.ps1", "try_indextts2_stage2_v2.ps1",
    "setup_indextts_env_v2.bat",
    # stray backup copy of server.js (a .txt duplicate) — not real source.
    "server.js.txt",
    # packer-generated release metadata. version.json / manifest-*.json are
    # injected fresh into the zip root from the `included` list on every pack.
    # A stale copy left in the source root would (1) self-reference into the new
    # manifest and (2) be written a SECOND time at the same arcname (duplicate
    # zip entry). Drop any on-disk residue so the generated ones always win.
    # (manifest-<ver>.json is handled via EXCLUDE_PREFIX below.)
    "version.json",
}
EXCLUDE_PREFIX = ("sources_", "manifest-")  # sources_YYYYMMDD.zip snapshots;
# manifest-<ver>.json is generated fresh into the zip and never shipped from disk


def root_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))  # tools/build -> root


def norm(p):
    return p.replace("\\", "/")


# The ZIP format cannot represent a modification time before 1980-01-01; zipfile
# raises "ZIP does not support timestamps before 1980" and aborts the whole pack.
# Some files legitimately carry a pre-1980 (or zeroed / epoch-0) mtime — e.g.
# artifacts unpacked by tools that don't preserve dates, or files touched to a
# bogus timestamp. Clamp any such time up to the ZIP epoch (1980-01-01) so the
# pack never crashes on one stray file. Returns a (Y,M,D,h,m,s) tuple.
_ZIP_MIN_DATE = (1980, 1, 1, 0, 0, 0)


def zip_date_time(full):
    try:
        t = time.localtime(os.path.getmtime(full))[:6]
    except OSError:
        return _ZIP_MIN_DATE
    return t if t[0] >= 1980 else _ZIP_MIN_DATE


def in_excluded_tree(rel):
    r = norm(rel)
    # top-level anchored name PREFIXES (e.g. venv_idx241, venv_idx2 for the
    # IndexTTS/IndexTTS2 engines) — match only the first path segment so a deep
    # "venv_*" inside a dependency is left alone.
    top_seg = r.split("/", 1)[0]
    if top_seg.startswith(TOP_EXCLUDE_PREFIX):
        return True
    # node_modules at ANY depth is dropped (app backend + web deps are restored
    # at deploy via `npm ci`), with ONE exception: the portable node runtime's
    # own node_modules, which IS npm itself and must ship. Keeping it here means
    # `tools\runtime\node\npm.cmd ci` actually works on the target machine.
    if "node_modules" in r.split("/"):
        return not r.startswith(NODE_RUNTIME_PREFIX)
    # top-level data/ — allowlist, see DATA_KEEP
    if top_seg == "data":
        rest = r.split("/", 2)
        if len(rest) == 1:
            return False           # the directory itself
        return rest[1] not in DATA_KEEP
    # top-level anchored names (e.g. "dist", but NOT "web/dist")
    for t in TOP_EXCLUDE:
        if r == t or r.startswith(t + "/"):
            return True
    # specific subtree paths, wherever anchored
    for t in PATH_EXCLUDE:
        t = norm(t)
        if r == t or r.startswith(t + "/"):
            return True
    return False


def _json_dumps(obj):
    import json
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB"):
        if f < 1024 or u == "GB":
            return f"{f:.1f}{u}"
        f /= 1024.0


def collect_included(root, out_abspath=None):
    """Walk `root` applying the release blacklist and return the shipped file
    list as [(relpath, fullpath, size), ...], sorted by relpath.

    Shared by the packer (writes the zip) and gen_manifest.py (documents an
    already-built/extracted release tree) so both agree byte-for-byte on what
    "the release" is. `out_abspath` (the zip being written) is skipped so a
    re-pack into the same dir never swallows its own output."""
    included = []
    for dp, dns, fns in os.walk(root):
        rel_dir = os.path.relpath(dp, root)
        rel_dir = "" if rel_dir == "." else rel_dir
        # prune subtrees
        keep_dns = []
        for d in dns:
            child = os.path.join(rel_dir, d) if rel_dir else d
            if d in NAME_EXCLUDE or in_excluded_tree(child):
                continue
            keep_dns.append(d)
        dns[:] = keep_dns
        if rel_dir and in_excluded_tree(rel_dir):
            continue
        for fn in fns:
            rel = os.path.join(rel_dir, fn) if rel_dir else fn
            full = os.path.join(dp, fn)
            if out_abspath and os.path.abspath(full) == out_abspath:
                continue
            if fn in EXCLUDE_FILES or fn.startswith(EXCLUDE_PREFIX):
                continue
            if rel_dir == "" and fn in ROOT_EXCLUDE_FILES:
                continue
            ext = os.path.splitext(fn)[1].lower()
            if ext in EXCLUDE_EXT and ext not in KEEP_EXT:
                continue
            try:
                sz = os.path.getsize(full)
            except OSError:
                continue
            included.append((rel, full, sz))
    included.sort()
    return included


def main():
    ap = argparse.ArgumentParser(description="Pack the extract-and-run release zip.")
    ap.add_argument("--root", default=None)
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--out", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-uncompressed-mb", type=int, default=MAX_UNCOMPRESSED_MB,
                    help="fail if the shipped (uncompressed) payload exceeds this")
    ap.add_argument("--max-compressed-mb", type=int, default=MAX_COMPRESSED_MB,
                    help="fail if the written zip exceeds this")
    ap.add_argument("--allow-oversize", action="store_true",
                    help="warn instead of failing when a size budget is exceeded")
    args = ap.parse_args()

    root = os.path.abspath(args.root) if args.root else root_dir()
    # app version = single source of truth from package.json; --version overrides
    # only when the caller explicitly passes a non-default value.
    app_version = pack_common.read_app_version(root)
    version = args.version if args.version != "1.0.0" else app_version
    top = f"{PRODUCT}-{version}"
    ts = time.strftime("%Y%m%d_%H%M%S")
    out = os.path.abspath(args.out) if args.out else os.path.join(root, "dist", f"{top}-win-x64-{ts}.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    print("=" * 64)
    print("Pack release  ->", out)
    print("root :", root)
    print("=" * 64)

    included = collect_included(root, out_abspath=out)
    total = sum(sz for _, _, sz in included)
    big = [(rel, sz) for rel, _, sz in included if sz > 100 * 1024 * 1024]
    print(f"files: {len(included)}   uncompressed: {human(total)}")

    # ---- size budget: uncompressed (checked before writing the zip) ----------
    max_unc = args.max_uncompressed_mb * 1024 * 1024
    if total > max_unc:
        print(f"\n[SIZE-FAIL] uncompressed {human(total)} exceeds budget "
              f"{args.max_uncompressed_mb}MB.")
        print("  largest shipped files:")
        for rel, _, sz in sorted(included, key=lambda x: -x[2])[:15]:
            print(f"    {human(sz):>9}  {norm(rel)}")
        if not args.allow_oversize:
            print("  aborting (pass --allow-oversize to override).")
            return 3
        print("  [allow-oversize] continuing despite over-budget uncompressed size.")

    # show which top-level files ship (quick sanity check that nothing odd slips in)
    root_kept = sorted(r for r, _, _ in included if "/" not in norm(r))
    print("\n[root] top-level files shipped (%d):" % len(root_kept))
    for r in root_kept:
        print("   +", r)

    if big:
        print("\nlarge files kept (sanity-check these are wanted, e.g. ffmpeg/runtime):")
        for rel, sz in sorted(big, key=lambda x: -x[1]):
            print(f"  {human(sz):>9}  {norm(rel)}")

    # runtime/wheels presence warnings
    def has(relpath):
        return any(norm(r).startswith(norm(relpath)) for r, _, _ in included)
    for need, hint in [
        ("web/dist/index.html", "run 01_build_frontend.bat"),
        ("tools/runtime/python/python.exe", "run 03_fetch_runtimes.py"),
        ("tools/runtime/node/node.exe", "run 03_fetch_runtimes.py"),
        ("package-lock.json", "ship the root lockfile so deploy can `npm ci` reproducibly"),
        ("THIRD_PARTY_LICENSES/models/MODEL_SOURCES.json", "unify licenses under THIRD_PARTY_LICENSES/"),
        ("THIRD_PARTY_LICENSES/EXTERNAL_TOOLS.json", "ffmpeg external-tool license inventory"),
        ("tools/deploy/deploy_wizard.py", "deploy wizard (license/select/confirm TUI)"),
        ("deploy.bat", "deploy launcher"),
        ("data/advanced_params.json", "shipped defaults moved from the repo root into data/"),
        ("data/training_defaults.json", "shipped defaults moved from the repo root into data/"),
        ("stop.bat", "root stop launcher (calls tools\\scripts\\stop.ps1)"),
    ]:
        if not any(norm(r) == norm(need) or norm(r).startswith(norm(need)) for r, _, _ in included):
            print(f"  [WARN] missing {need}  -> {hint}")

    # ---- HARD preflight: the r12c relocation targets ------------------------
    # Everything above is a [WARN]: it prints and packs anyway. That is fine for
    # "you forgot to build the frontend" but wrong for the trees r12c MOVED,
    # because the failure mode there is a zip that extracts and then cannot
    # synthesise anything -- with no error at pack time. Note that not one of
    # the WARN entries above mentions engines/ or pipeline/, so a clean
    # "0 warnings" run proved only that the PRE-r12c files were still there.
    #
    # Floors are set at roughly half the 2026-08-20 measured counts, so normal
    # churn cannot trip them but "the tree moved / emptied" always does:
    #   engines/gpt-sovits 183   pipeline/uvr5 58   pipeline/asr 6
    #   pipeline/slicer 2        lib 135
    required = [
        ("engines/gpt-sovits/", 100, "live TTS engine (r12c: was vendor/tts/gpt-sovits)"),
        ("pipeline/uvr5/",       30, "vocal separation (r12c: was vendor/uvr5)"),
        ("pipeline/asr/",         3, "speech recognition (r12c: was vendor/asr)"),
        ("pipeline/slicer/",      1, "audio slicing (r12c: was vendor/slicer)"),
        ("lib/",                 50, "our own server-side code"),
    ]
    hard_fail = []
    for prefix, floor, what in required:
        n = sum(1 for r, _, _ in included if norm(r).startswith(prefix))
        if n < floor:
            hard_fail.append((prefix, n, floor, what))
    if not any(norm(r) == "server.js" for r, _, _ in included):
        hard_fail.append(("server.js", 0, 1, "broker main program"))
    if hard_fail:
        print("\n[PREFLIGHT-FAIL] the release is missing code it cannot run without:")
        for prefix, n, floor, what in hard_fail:
            print(f"    {prefix:<26} {n:>5} file(s), expected >= {floor}   ({what})")
        print("  This is a FAIL, not a warning: such a zip extracts cleanly and")
        print("  then fails at runtime, which is the kind that ships unnoticed.")
        print("  Check the exclusion tables above and the layout in docs/ROOT_LAYOUT.md.")
        return 4

    # data/ is per-installation state apart from the DATA_KEEP allowlist. A leak
    # here ships the dev box's voice roster / canvas graphs to every tester.
    leaked_data = [r for r, _, _ in included
                   if norm(r).startswith("data/")
                   and norm(r).split("/")[1] not in DATA_KEEP]
    if leaked_data:
        print("  [WARN] %d per-installation file(s) under data/ leaked into the release. e.g. %s"
              % (len(leaked_data), norm(leaked_data[0])))
    whl = [r for r, _, _ in included if norm(r).startswith("tools/wheels/") and r.endswith(".whl")]
    if not whl:
        print("  [WARN] no wheels in tools/wheels -> run 02_make_wheelhouse.bat (jieba_fast/pyopenjtalk)")
    # node_modules must NOT ship -- deps are restored at deploy via `npm ci` --
    # EXCEPT the bundled node runtime's own npm (tools/runtime/node/...). If any
    # OTHER node_modules slipped through the blacklist, flag it (bloat + license).
    leaked_nm = [r for r, _, _ in included
                 if "node_modules/" in norm(r) and not norm(r).startswith(NODE_RUNTIME_PREFIX)]
    if leaked_nm:
        print("  [WARN] %d node_modules file(s) leaked into the release (should be 0; deploy runs `npm ci`). e.g. %s"
              % (len(leaked_nm), norm(leaked_nm[0])))
    # tts_infer.yaml is PER-MACHINE runtime state (this box's absolute model
    # paths + last-selected weights, hot-rewritten by the engine). It must NEVER
    # ship: the release carries tts_infer.yaml.example and start.ps1 regenerates
    # the live file on first run. Flag either a leaked live yaml (blacklist miss)
    # or a missing template so a broken release is caught at pack time.
    leaked_cfg = [r for r, _, _ in included if os.path.basename(norm(r)) == "tts_infer.yaml"]
    if leaked_cfg:
        print("  [WARN] tts_infer.yaml (per-machine runtime config) leaked into the release "
              "(should be 0; ship only tts_infer.yaml.example). e.g. %s" % norm(leaked_cfg[0]))
    if not any(os.path.basename(norm(r)) == "tts_infer.yaml.example" for r, _, _ in included):
        print("  [WARN] missing tts_infer.yaml.example -> engine/start.ps1 cannot regenerate its config on first run")

    # ---- version.json + manifest (P0: single source of truth for updates) ----
    # Built from the exact `included` list so the manifest can never disagree
    # with what ends up in the zip. Both are injected at the package root; they
    # do NOT appear as manifest entries (metadata describes the payload, not
    # itself). Layer fingerprints in version.json gate hot-patch eligibility.
    manifest = pack_common.build_manifest(PRODUCT, version, included)
    ver = pack_common.build_version(
        PRODUCT, version, manifest,
        runtime=pack_common.read_runtime_versions(os.path.dirname(os.path.abspath(__file__))),
        git_commit=pack_common.git_short_commit(root),
    )
    layer_counts = {}
    for e in manifest["files"]:
        layer_counts[e["layer"]] = layer_counts.get(e["layer"], 0) + 1
    print("\n[version] app=%s  runtime py=%s node=%s  git=%s" % (
        ver["app"], ver["runtime"]["python"], ver["runtime"]["node"], ver["git_commit"]))
    print("[layers]  " + "  ".join(f"{k}:{layer_counts.get(k, 0)}" for k in ("A", "R", "W", "N", "M")))

    if args.dry_run:
        print("\n(DRY-RUN) no zip written.")
        print("(DRY-RUN) version.json / manifest-%s.json not written." % version)
        return 0

    manifest_name = f"manifest-{version}.json"
    manifest_bytes = (_json_dumps(manifest)).encode("utf-8")
    version_bytes = (_json_dumps(ver)).encode("utf-8")

    print("\nwriting zip ...")
    _UTF8_BOM = b"\xef\xbb\xbf"
    clamped = []  # files whose pre-1980 mtime we clamped to the ZIP epoch
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr(norm(os.path.join(top, "version.json")), version_bytes)
        z.writestr(norm(os.path.join(top, manifest_name)), manifest_bytes)
        for rel, full, _ in included:
            arc = norm(os.path.join(top, rel))
            # Force a UTF-8 BOM onto every .ps1. Windows PowerShell 5.1 parses a
            # BOM-less script using the system ANSI codepage (GBK on zh-CN), which
            # mangles our non-ASCII (Chinese) strings and can even break syntax
            # (a mis-decoded byte lands on a quote, unterminating a string ->
            # "Missing '}'" parse errors). A BOM makes it decode as UTF-8 correctly.
            # Enforcing it here means the release is safe even if an editor/git
            # stripped the BOM from the source file.
            if full.lower().endswith(".ps1"):
                with open(full, "rb") as fh:
                    data = fh.read()
                if not data.startswith(_UTF8_BOM):
                    data = _UTF8_BOM + data
                dt = zip_date_time(full)
                if dt is _ZIP_MIN_DATE:
                    clamped.append(rel)
                zi = zipfile.ZipInfo(arc, date_time=dt)
                zi.compress_type = zipfile.ZIP_DEFLATED
                z.writestr(zi, data)
            else:
                # Fast path uses z.write (streams from disk). But z.write reads the
                # file's mtime and a pre-1980 timestamp makes zipfile raise and
                # abort the whole pack. Only for those rare files do we fall back
                # to a manual ZipInfo with a clamped date; everything else keeps
                # the efficient streaming write.
                try:
                    raw_year = time.localtime(os.path.getmtime(full))[0]
                except OSError:
                    raw_year = 0
                ct = _compress_type_for(full)
                if raw_year < 1980:
                    clamped.append(rel)
                    zi = zipfile.ZipInfo(arc, date_time=_ZIP_MIN_DATE)
                    zi.compress_type = ct
                    with open(full, "rb") as fh:
                        z.writestr(zi, fh.read())
                else:
                    z.write(full, arcname=arc, compress_type=ct)
    zsize = os.path.getsize(out)
    if clamped:
        print("  [note] clamped pre-1980 mtime -> 1980-01-01 on %d file(s) "
              "(ZIP cannot store older dates); e.g. %s"
              % (len(clamped), norm(clamped[0])))

    # Also emit version.json + manifest next to the zip. The manifest is a
    # standalone GitHub Release asset (the patch/index generators consume it);
    # the version.json sidecar mirrors the one inside the package for reference.
    dist_dir = os.path.dirname(out)
    pack_common.write_json(os.path.join(dist_dir, manifest_name), manifest)
    pack_common.write_json(os.path.join(dist_dir, f"version-{version}.json"), ver)

    # ---- size budget: compressed (checked after writing the zip) -------------
    max_cmp = args.max_compressed_mb * 1024 * 1024
    size_fail = zsize > max_cmp

    print("=" * 64)
    print(f"OK  {out}")
    print(f"    uncompressed: {human(total)}  (budget {args.max_uncompressed_mb}MB)")
    print(f"    compressed  : {human(zsize)}  (budget {args.max_compressed_mb}MB)   (top folder: {top}/)")
    print(f"    sidecars    : {manifest_name}, version-{version}.json (in dist/)")
    if size_fail:
        print(f"\n[SIZE-FAIL] compressed {human(zsize)} exceeds budget {args.max_compressed_mb}MB.")
        if not args.allow_oversize:
            print("  (zip written, but reporting failure; pass --allow-oversize to treat as OK.)")
            print("=" * 64)
            return 3
        print("  [allow-oversize] treating over-budget compressed size as OK.")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    sys.exit(main())
