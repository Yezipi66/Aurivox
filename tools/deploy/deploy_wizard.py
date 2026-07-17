#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deploy_wizard.py — Aurivox 部署向导 (纯控制台 / 黑窗 TUI)。

在环境初始化 / 下载之前运行, 负责与用户交互的四个阶段:

  阶段 1  展示本产品许可 (LICENSE + NOTICE), 用户接受后继续。
  阶段 2  选择要下载的上游模型 (核心默认选中, 基座默认 v2Pro; 备用基座 / 可选项按需)。
          同时"只展示不选择"固定的运行环境: Python 依赖 / Node 模块 / 运行时组件。
          (依赖环境必须一致, 不可由用户增减, 仅供知情。)
  阶段 3  分组展示第三方许可 (按许可类型分组, 列出该许可下的模型 / Python 包 / 组件),
          用户逐组确认已阅读。
  阶段 4  最终确认将要执行的全部操作。

通过后把用户选择写入 tools/deploy/.deploy_selection.json 以及两个纯文本旁车文件
(.deploy_models.txt / .deploy_ffmpeg.txt); 随后 deploy.bat 调用 bootstrap.ps1,
由 bootstrap.ps1 读取旁车文件, 非交互地完成环境初始化 + 模型下载 + ffmpeg 下载。

退出码:
  0   用户完成全部确认 (已写入 selection)。
  10  用户在任一阶段拒绝 / 退出 (deploy.bat 应中止部署)。
  2   资源文件缺失等错误。

仅用标准库, 可由内嵌 Python (tools/runtime/python) 在建 venv 之前直接运行。
"""

import datetime
import json
import os
import sys

# 让中文在 Windows 传统控制台也能正确输出 (deploy.bat 亦会 chcp 65001)。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
def project_root():
    here = os.path.dirname(os.path.abspath(__file__))
    cur = here
    for _ in range(5):
        if os.path.exists(os.path.join(cur, "server.js")) or \
           os.path.exists(os.path.join(cur, "THIRD_PARTY_LICENSES")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return os.path.dirname(os.path.dirname(here))  # tools/deploy -> root


ROOT = project_root()
TPL = os.path.join(ROOT, "THIRD_PARTY_LICENSES")
SELECTION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".deploy_selection.json")


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def rule(ch="=", n=64):
    print(ch * n)


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def human(n):
    f = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or u == "TB":
            return f"{f:.1f}{u}"
        f /= 1024.0


def ask(prompt):
    try:
        return input(prompt)
    except (EOFError, KeyboardInterrupt):
        print()
        return ""


def pager(text, title):
    """分页展示长文本, 空行继续, q 退出浏览。"""
    lines = text.splitlines()
    rule()
    print(f"  {title}   ({len(lines)} 行)")
    rule()
    page = 22
    i = 0
    while i < len(lines):
        for ln in lines[i:i + page]:
            print(ln)
        i += page
        if i < len(lines):
            c = ask(f"  -- 第 {i}/{len(lines)} 行, 回车继续 / q 跳到末尾 -- ").strip().lower()
            if c == "q":
                break
    rule()


# --------------------------------------------------------------------------
# 阶段 1: 本产品许可
# --------------------------------------------------------------------------
def stage_license():
    print("\n")
    rule("#")
    print("  阶段 1 / 4    Aurivox 软件许可 (LICENSE + NOTICE)")
    rule("#")
    lic = os.path.join(ROOT, "LICENSE")
    notice = os.path.join(ROOT, "NOTICE")
    if os.path.isfile(lic):
        pager(read_text(lic), "LICENSE (MIT)")
    if os.path.isfile(notice):
        pager(read_text(notice), "NOTICE")
    print("  继续部署即表示你已阅读并接受上述 MIT 许可与 NOTICE 声明。")
    ans = ask("  输入 ACCEPT 接受并继续 (其它任意键取消): ").strip()
    if ans.upper() != "ACCEPT":
        print("\n  已取消: 未接受软件许可。")
        return False
    return True


# --------------------------------------------------------------------------
# 阶段 2: 模型选择 + 固定环境展示
# --------------------------------------------------------------------------
GROUP_META = [
    # (download_group, 标签, 说明)
    ("core",          "核心底模 + 默认基座 v2Pro", "S1/GPT, v2Pro G+D, 488k 回退基座, SV, cn-hubert, roberta"),
    ("asr",           "ASR faster-whisper large-v3-turbo", "训练时的语音识别 (~1.6GB)"),
    ("g2pw",          "G2PW 多音字 (g2pW.onnx)", "中文前端多音字消歧"),
    ("langdetect",    "语言检测 lid.176", "fastText 语言识别"),
    ("alt_v2",        "备用基座 v2 (G+D)", "非默认, 需要 v2 基座时勾选"),
    ("alt_v2proplus", "备用基座 v2ProPlus (G+D)", "非默认, 需要 v2ProPlus 基座时勾选"),
    ("uvr5",          "UVR5 去人声 HP2 (可选)", "训练预处理去伴奏, 可选"),
]


def load_models():
    p = os.path.join(TPL, "models", "MODEL_SOURCES.json")
    data = load_json(p)
    comps = data.get("components", [])
    by_group = {}
    for c in comps:
        by_group.setdefault(c.get("download_group"), []).append(c)
    return data, by_group


def stage_select(by_group):
    print("\n")
    rule("#")
    print("  阶段 2 / 4    选择要下载的上游模型")
    rule("#")
    # 依据 MODEL_SOURCES 的 default_selected 预设默认勾选。
    selected = {}
    for g, _label, _desc in GROUP_META:
        comps = by_group.get(g, [])
        default = any(c.get("default_selected") for c in comps)
        selected[g] = default
    # ffmpeg (转码/去人声用, 默认开; 不影响依赖一致性, 仅是外部工具)
    ffmpeg = True

    while True:
        print("\n  上游模型 (输入编号切换勾选; 核心项建议保留):")
        for idx, (g, label, desc) in enumerate(GROUP_META, 1):
            comps = by_group.get(g, [])
            lics = sorted({c.get("license") for c in comps if c.get("license")})
            mark = "[x]" if selected.get(g) else "[ ]"
            print(f"   {idx:>2}. {mark} {label}")
            print(f"        {desc}  | 许可: {', '.join(lics) or '—'}")
        print(f"    8. [{'x' if ffmpeg else ' '}] FFmpeg (ffmpeg/ffprobe, 转码+去人声; GPL-3.0, 部署时下载)")
        print("\n   a) 全选   d) 恢复默认   回车) 确认继续   q) 取消部署")
        rule("-")
        c = ask("  切换编号 [1-8] 或 a/d/回车/q: ").strip().lower()
        if c == "":
            break
        if c == "q":
            return None
        if c == "a":
            for g, _l, _d in GROUP_META:
                selected[g] = True
            ffmpeg = True
            continue
        if c == "d":
            for g, _l, _d in GROUP_META:
                selected[g] = any(x.get("default_selected") for x in by_group.get(g, []))
            ffmpeg = True
            continue
        if c == "8":
            ffmpeg = not ffmpeg
            continue
        if c.isdigit() and 1 <= int(c) <= len(GROUP_META):
            g = GROUP_META[int(c) - 1][0]
            selected[g] = not selected.get(g)
            continue
        print("  无效输入。")

    groups = [g for g, _l, _d in GROUP_META if selected.get(g)]
    if not groups:
        print("\n  未选择任何模型组。")
        if ask("  确认不下载任何模型? 输入 yes 继续: ").strip().lower() != "yes":
            return stage_select(by_group)

    # 只展示、不可选: 固定运行环境
    show_fixed_environment()
    return {"model_groups": groups, "ffmpeg": ffmpeg}


def show_fixed_environment():
    print("\n")
    rule()
    print("  固定运行环境 (依赖必须一致, 不可增减, 以下仅供知情)")
    rule()
    # Python 依赖
    pp = os.path.join(TPL, "runtime", "python_packages.json")
    try:
        d = load_json(pp)
        cnt = d.get("count") or len(d.get("packages", []))
        bundled = [p for p in d.get("packages", []) if p.get("bundled")]
        print(f"  Python 依赖: {cnt} 个 (uv pip install), 其中随包 wheel {len(bundled)} 个:")
        for p in bundled:
            print(f"     - {p.get('name')} {p.get('version')} (本地编译, {p.get('license') or 'MIT'})")
        print("     其余均由 uv 从 PyPI 安装; torch/torchaudio 由 install_torch 单独安装。")
    except Exception:
        print("  Python 依赖: (python_packages.json 不可读)")
    # 运行时组件
    ri = os.path.join(TPL, "runtime", "INDEX.json")
    try:
        d = load_json(ri)
        print("  随包运行时/代码组件:")
        for c in d.get("components", []):
            print(f"     - {c.get('component')}  ({c.get('license')})")
    except Exception:
        pass
    # Node 后端模块
    print("  Node 后端模块: 随包内置 (express/multer 等生产依赖), 无需选择。")
    rule()


# --------------------------------------------------------------------------
# 阶段 3: 分组展示第三方许可, 逐组确认
# --------------------------------------------------------------------------
def build_license_groups(sel, by_group):
    """按许可类型聚合本次将要下载/使用的第三方项。返回 Orderede list of
    (license, [ (kind, name, detail, license_file|None) ])."""
    groups = {}

    def add(lic, kind, name, detail, lfile=None):
        groups.setdefault(lic, []).append((kind, name, detail, lfile))

    # 选中的模型
    for g in sel["model_groups"]:
        for c in by_group.get(g, []):
            add(c.get("license") or "未标注", "模型", c.get("component_id"),
                c.get("description", "")[:70], None)

    # 随包运行时/代码组件 (始终随发行包)
    try:
        idx = load_json(os.path.join(TPL, "runtime", "INDEX.json"))
        for c in idx.get("components", []):
            add(c.get("license"), "运行时", c.get("component"),
                c.get("description", "")[:70],
                os.path.join(TPL, "runtime", c.get("license_file")))
    except Exception:
        pass

    # FFmpeg (若选)
    if sel.get("ffmpeg"):
        try:
            ext = load_json(os.path.join(TPL, "EXTERNAL_TOOLS.json"))
            for t in ext.get("tools", []):
                if t.get("tool_id") == "ffmpeg":
                    add(t.get("license"), "工具", "FFmpeg (ffmpeg/ffprobe)",
                        "部署时从 BtbN 下载, 不随包分发", None)
        except Exception:
            add("GPL-3.0-or-later", "工具", "FFmpeg (ffmpeg/ffprobe)",
                "部署时下载, 不随包分发", None)

    # Python 依赖闭包 (整体一条, 许可各自随 PyPI)
    add("各自许可 (PyPI)", "Python 依赖", "requirements.txt 依赖闭包",
        "由 uv 从 PyPI 安装, 详见 runtime/python_packages.json", None)

    # 稳定排序: 常见许可优先
    order = ["MIT", "Apache-2.0", "PSF", "CC-BY-SA-3.0", "GPL-3.0-or-later"]
    keys = sorted(groups.keys(), key=lambda k: (order.index(k) if k in order else 99, str(k)))
    return [(k, groups[k]) for k in keys]


def stage_licenses(sel, by_group):
    print("\n")
    rule("#")
    print("  阶段 3 / 4    第三方许可 (按许可类型分组, 请逐组确认)")
    rule("#")
    lgroups = build_license_groups(sel, by_group)
    print(f"  本次涉及 {len(lgroups)} 种许可类型。每组需单独确认已阅读。\n")
    for i, (lic, items) in enumerate(lgroups, 1):
        rule("-")
        print(f"  许可组 {i}/{len(lgroups)}:  {lic}")
        rule("-")
        seen_files = []
        for kind, name, detail, lfile in items:
            print(f"    [{kind}] {name}")
            if detail:
                print(f"           {detail}")
            if lfile and lfile not in seen_files and os.path.isfile(lfile):
                seen_files.append(lfile)
        while True:
            opts = "  输入 READ 确认已阅读本组"
            if seen_files:
                opts += " / v 查看完整许可文本"
            opts += " / q 取消部署: "
            c = ask(opts).strip().lower()
            if c == "q":
                print("\n  已取消: 未确认第三方许可。")
                return False
            if c == "v" and seen_files:
                for f in seen_files:
                    pager(read_text(f), os.path.basename(f))
                continue
            if c == "read":
                break
            print("  请输入 READ 以确认, 或 v 查看, 或 q 取消。")
    print("\n  已逐组确认全部第三方许可。")
    return True


# --------------------------------------------------------------------------
# 阶段 4: 最终确认
# --------------------------------------------------------------------------
# 每组粗略下载体积 (仅用于给用户预估, 非精确)
GROUP_APPROX = {
    "core": 1.9 * 1024**3, "asr": 1.6 * 1024**3, "g2pw": 0.6 * 1024**3,
    "langdetect": 0.13 * 1024**3, "alt_v2": 0.35 * 1024**3,
    "alt_v2proplus": 0.35 * 1024**3, "uvr5": 0.06 * 1024**3,
}


def stage_confirm(sel, by_group):
    print("\n")
    rule("#")
    print("  阶段 4 / 4    最终确认: 将要执行的操作")
    rule("#")
    print("  1) 环境初始化 (固定, 保证依赖一致):")
    print("       - 用内嵌 Python 3.11 创建 venv\\")
    print("       - pip install uv, 然后 uv pip install -r requirements.txt")
    print("       - 安装本地 wheel: jieba_fast, pyopenjtalk")
    print("       - 安装 PyTorch (CUDA, install_torch)")
    print("  2) 下载上游模型:")
    est = 0.0
    for g in sel["model_groups"]:
        label = next((l for gg, l, _ in GROUP_META if gg == g), g)
        ap = GROUP_APPROX.get(g, 0)
        est += ap
        print(f"       - {label}   ~{human(ap)}")
    if not sel["model_groups"]:
        print("       - (未选择任何模型)")
    if sel.get("ffmpeg"):
        print("  3) 下载 FFmpeg (ffmpeg/ffprobe, Windows x64, GPL-3.0) -> vendor\\ffmpeg\\")
    print(f"\n  预计模型下载总量: ~{human(est)} (实际以下载为准, 已存在的会跳过)")
    rule("-")
    ans = ask("  确认开始执行? 输入 YES 开始 (其它任意键取消): ").strip()
    return ans.upper() == "YES"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main():
    if not os.path.isdir(TPL):
        print(f"[wizard] 找不到 THIRD_PARTY_LICENSES 目录: {TPL}", file=sys.stderr)
        return 2
    try:
        _models_meta, by_group = load_models()
    except Exception as e:
        print(f"[wizard] 无法读取 MODEL_SOURCES.json: {e}", file=sys.stderr)
        return 2

    if not stage_license():
        return 10
    sel = stage_select(by_group)
    if sel is None:
        print("\n  已取消部署。")
        return 10
    if not stage_licenses(sel, by_group):
        return 10
    if not stage_confirm(sel, by_group):
        print("\n  已取消部署。")
        return 10

    out = {
        "accepted": True,
        "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
        "model_groups": sel["model_groups"],
        "ffmpeg": bool(sel.get("ffmpeg")),
    }
    with open(SELECTION_FILE, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    # 供 bootstrap.ps1 直接读取的两个纯文本旁车文件 (避免在 ps1/bat 里解析 JSON):
    # .deploy_models.txt = 逗号分隔的模型组; .deploy_ffmpeg.txt = 1/0。
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, ".deploy_models.txt"), "w", encoding="ascii") as fh:
        fh.write(",".join(sel["model_groups"]))
    with open(os.path.join(here, ".deploy_ffmpeg.txt"), "w", encoding="ascii") as fh:
        fh.write("1" if sel.get("ffmpeg") else "0")
    print("\n  选择已保存: %s" % SELECTION_FILE)
    print("  即将开始环境初始化与下载 ...")
    return 0


if __name__ == "__main__":
    sys.exit(main())
