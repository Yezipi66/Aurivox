#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deploy_wizard.py — Aurivox 部署向导 (纯控制台 / 黑窗 TUI)。

在环境初始化 / 下载之前运行, 负责与用户交互的四个阶段:

  阶段 1  展示本产品许可 (LICENSE + NOTICE) —— 仅供知情。本软件以 MIT 授权给用户,
          使用/安装无需接受任何附加义务, 因此这里不设"同意"门槛 (只可选择退出安装)。
  阶段 2  选择要下载的上游模型 (核心默认选中, 基座默认 v2Pro; 备用基座 / 可选项按需)。
          同时"只展示不选择"固定的运行环境: Python 依赖 / Node 模块 / 运行时组件。
          (依赖环境必须一致, 不可由用户增减, 仅供知情。)
  阶段 3  第三方许可, 分两类: 3A 平台自带依赖 (运行时 / Python / FFmpeg) 随软件分发,
          仅告知、无需接受; 3B 上游模型权重是可选下载, 才是真正的"同意"环节 —— 用户
          可逐个许可组不同意, 不同意即不下载该许可下的模型 (平台仍照常部署)。
  阶段 4  最终确认将要执行的全部操作 (含裁剪后的最终下载清单)。

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
# 阶段 1: 本产品许可 (仅告知, 无需接受)
# --------------------------------------------------------------------------
def stage_license():
    print("\n")
    rule("#")
    print("  阶段 1 / 4    第一层许可: 本软件 Aurivox 自身 (LICENSE + NOTICE) —— 仅供知情")
    rule("#")
    lic = os.path.join(ROOT, "LICENSE")
    notice = os.path.join(ROOT, "NOTICE")
    if os.path.isfile(lic):
        pager(read_text(lic), "LICENSE (MIT)")
    if os.path.isfile(notice):
        pager(read_text(notice), "NOTICE")
    # MIT 是"授予你权利"的宽松许可, 无需你"接受"任何义务即可使用/安装本软件,
    # 因此这里不设"同意"门槛 —— 仅展示。你随时可选择不安装 (输入 q 退出)。
    print("  本软件以 MIT 许可授权给你 —— 使用/安装无需接受任何附加义务, 以上仅供知情。")
    ans = ask("  回车继续安装 (无需接受) / 输入 q 退出: ").strip().lower()
    if ans == "q":
        print("\n  已退出: 你选择不安装。")
        return False
    return True


# --------------------------------------------------------------------------
# 阶段 2: 模型选择 + 固定环境展示
# --------------------------------------------------------------------------
GROUP_META = [
    # (download_group, 标签, 说明)
    ("core",          "核心底模 + 默认基座 v2Pro", "S1/GPT, v2Pro G+D, 488k 回退基座, SV, cn-hubert, roberta"),
    ("asr",           "ASR faster-whisper large-v3-turbo", "训练时的语音识别 (~1.6GB)"),
    ("funasr",        "FunASR 中文/粤语 ASR (Paraformer+VAD+标点)", "前端可选的中文/粤语 ASR 引擎, 中文更准且自带标点; 来自 ModelScope, ~2.4GB, 可选"),
    ("g2pw",          "G2PW 多音字 (g2pW.onnx)", "中文前端多音字消歧"),
    ("langdetect",    "语言检测 lid.176", "fastText 语言识别"),
    ("alt_v2",        "备用基座 v2 (G+D)", "非默认, 需要 v2 基座时勾选"),
    ("alt_v2proplus", "备用基座 v2ProPlus (G+D)", "非默认, 需要 v2ProPlus 基座时勾选"),
    # UVR5 人声分离拆成 4 个功能子组, 按需勾选 (整套 ~2.5GB 太大; Roformer 占大头 ~1.6GB)。
    ("uvr5_hp",       "UVR5 去伴奏 HP (HP2/HP3/HP5)", "人声/伴奏分离 VR 家族 3 模型, ~0.35GB, 可选"),
    ("uvr5_deecho",   "UVR5 去混响/去回声 DeEcho ×3", "VR-DeEcho Normal/Aggressive/DeReverb, ~0.2GB, 可选"),
    ("uvr5_mdx",      "UVR5 MDX 去混响 (FoxJoy onnx)", "onnx_dereverb_By_FoxJoy 2 文件, ~0.06GB, 可选"),
    ("uvr5_roformer", "UVR5 Roformer 高质量分离 (BS + Mel-Band)", "BS-Roformer + Mel-Band Roformer, 体积大 ~1.6GB, 可选"),
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

    ffmpeg_idx = len(GROUP_META) + 1  # FFmpeg 紧跟在模型组之后, 编号动态计算(避免与末组撞号)
    while True:
        print("\n  上游模型 (输入编号切换勾选; 核心项建议保留):")
        for idx, (g, label, desc) in enumerate(GROUP_META, 1):
            mark = "[x]" if selected.get(g) else "[ ]"
            print(f"   {idx:>2}. {mark} {label}")
            print(f"        {desc}")
        print(f"   {ffmpeg_idx:>2}. [{'x' if ffmpeg else ' '}] FFmpeg (ffmpeg/ffprobe, 转码+去人声; 部署时下载)")
        print("\n   a) 全选   d) 恢复默认   回车) 确认继续   q) 取消部署")
        rule("-")
        c = ask(f"  切换编号 [1-{ffmpeg_idx}] 或 a/d/回车/q: ").strip().lower()
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
        if c.isdigit() and int(c) == ffmpeg_idx:
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
_LIC_ORDER = ["MIT", "Apache-2.0", "PSF", "CC-BY-SA-3.0", "GPL-3.0-or-later"]


def _sort_licenses(keys):
    return sorted(keys, key=lambda k: (_LIC_ORDER.index(k) if k in _LIC_ORDER else 99, str(k)))


def build_platform_license_groups(sel):
    """第二层许可分组 —— 分两类返回 (bundled, fetched):
      bundled : 真正"内置于发行包"的第三方代码/运行时 (随包一并分发, 其许可文本随包携带于
                THIRD_PARTY_LICENSES/runtime/): GPT-SoVITS 代码、CPython 运行时、Node.js
                运行时、jieba_fast / pyopenjtalk 预编译 wheel。
      fetched : 部署时"联网下载、我们并不再分发"的依赖/工具 (我们只触发下载, 许可随下载获得,
                合规义务留在上游分发方): PyPI 依赖闭包、后端 npm 依赖、FFmpeg。因依赖闭包动辄
                数十上百个、各自许可不一, 这里不逐一断言, 而是给出可查阅的许可清单指引。
    返回 (bundled, fetched):
      bundled = [(license, [(kind, name, detail, license_file|None)])]  # 按 license 分组
      fetched = [(name, pointer)]                                       # 每项一条查阅指引"""
    bundled = {}

    def add_bundled(lic, kind, name, detail, lfile=None):
        bundled.setdefault(lic, []).append((kind, name, detail, lfile))

    # --- bundled: 随包运行时 / 引擎代码 (含 GPT-SoVITS) —— 读 runtime/INDEX.json ---
    try:
        idx = load_json(os.path.join(TPL, "runtime", "INDEX.json"))
        for c in idx.get("components", []):
            add_bundled(c.get("license"), "运行时/代码", c.get("component"),
                        c.get("description", "")[:70],
                        os.path.join(TPL, "runtime", c.get("license_file")))
    except Exception:
        pass

    # --- fetched: 每项给出"去哪查许可"的指引, 不逐包断言 license ---
    fetched = []
    # Python 依赖闭包 (部署时 uv/pip 从 PyPI 安装, 不随包)
    fetched.append(("Python 依赖 (PyPI)", "详见 runtime/python_packages.json"))
    # 后端 Node 依赖 (部署时 npm ci 还原, 不随包)。runtime/node_packages.json 由
    # tools/build/gen_node_licenses.py 从已安装 node_modules 的元数据生成(npm license report)。
    has_node_report = False
    try:
        nj = load_json(os.path.join(TPL, "runtime", "node_packages.json"))
        has_node_report = bool(isinstance(nj.get("packages"), list) and nj["packages"])
    except Exception:
        has_node_report = False
    node_ptr = ("详见 package-lock.json / runtime/node_packages.json (npm license report)"
                if has_node_report else
                "详见 package-lock.json / npm license report (npm ci 后生成 runtime/node_packages.json)")
    fetched.append(("Node 依赖 (npm)", node_ptr))
    # FFmpeg (部署时从 BtbN 下载, 不随包; 作为独立进程调用, 其 GPL 不沾染本平台 MIT 代码)
    if sel.get("ffmpeg"):
        lic = "GPL-3.0-or-later"
        try:
            ext = load_json(os.path.join(TPL, "EXTERNAL_TOOLS.json"))
            for t in ext.get("tools", []):
                if t.get("tool_id") == "ffmpeg":
                    lic = t.get("license") or lic
        except Exception:
            pass
        fetched.append(("FFmpeg (ffmpeg/ffprobe)",
                        f"{lic}; 从 BtbN 下载, 作为独立进程调用, 另见 EXTERNAL_TOOLS.json"))

    return ([(k, bundled[k]) for k in _sort_licenses(bundled.keys())], fetched)


def build_model_download_groups(sel, by_group):
    """按"下载分组"列出用户所选的上游模型 (不再按 license 分组, 也不对其许可做任何断言)。
    我们仅代为下载这些权重、并不分发它们; 各权重的许可归其发布者所有, 由用户到各自仓库
    自行阅读。返回 [(group_id, group_label, [components])]。"""
    label_of = {g: lbl for g, lbl, _ in GROUP_META}
    out = []
    for g in sel["model_groups"]:
        comps = by_group.get(g, [])
        if comps:
            out.append((g, label_of.get(g, g), comps))
    return out


def _review_model_group(label, i, n, lines):
    """审阅一个下游模型下载组 —— 只列出该组要下载的模型及其仓库, 请用户到仓库自行阅读其
    许可条款后输入 READ。也可输入 NO 不下载该组、q 退出安装。返回 'accept'/'decline'/'quit'。"""
    rule("-")
    print(f"  模型下载组 {i}/{n}:  {label}")
    rule("-")
    for line in lines:
        print(line)
    print("  以上权重由各自发布者按其许可发布, 我们仅代为下载、并不分发。")
    print("  请到上述仓库自行阅读其许可条款; 确认已阅读后输入 READ 即可下载。")
    while True:
        c = ask("  输入 READ 确认已阅读并下载 / NO 不下载该组 / q 退出安装: ").strip().lower()
        if c == "q":
            return "quit"
        if c == "no":
            return "decline"
        if c in ("read", "ok"):
            return "accept"
        print("  输入无效。请输入 READ / NO / q。")


def stage_licenses(sel, by_group):
    """阶段 3: 3A 平台自带依赖许可仅"告知"(随软件分发, 无需你接受); 3B 上游模型许可
    才是真正的"同意"环节 —— 可逐组不同意, 不同意仅剔除该许可下要下载的模型组。返回更
    新后的 sel (model_groups 可能被裁剪), 用户主动退出安装则返回 None。"""
    print("\n")
    rule("#")
    print("  阶段 3 / 4    第三方许可 (第二层=平台自身代码/依赖=告知, 第三层=下游模型=列出仓库自阅)")
    rule("#")

    # --- 第二层 (3A): 平台自身用到的第三方代码/运行时/依赖 —— 仅告知, 不设门槛 ---
    # 明确区分两类: (A) 真正随发行包内置分发的代码/运行时(合规义务在我们, 已附 NOTICE);
    #             (B) 部署时联网下载、我们并不再分发的依赖/工具(合规义务留在上游分发方)。
    # 两类都无需终端用户"接受"; 只按 license 分组告知。
    bundled, fetched = build_platform_license_groups(sel)
    print("\n  [第二层] 平台自身用到的第三方代码 / 运行时 / 依赖 —— 仅供知悉, 无需签署或接受:")
    print(f"    (A) 随发行包内置分发 ({len(bundled)} 组; 许可文本随包携带于 THIRD_PARTY_LICENSES/runtime/):")
    for lic, items in bundled:
        names = ", ".join(name for _kind, name, _d, _f in items)
        print(f"        · {lic}: {names}")
    print(f"    (B) 部署时联网下载、不随包分发 ({len(fetched)} 项; 我们只触发下载, 许可随下载获得, 不再分发):")
    for name, pointer in fetched:
        print(f"        · {name}: {pointer}")

    # --- 第三层 (3B): 下游模型权重 —— 按"下载组"列出仓库, 用户自行阅读后 READ ---
    # 这些权重我们并不分发, 仅代为下载; 各自许可归其发布者所有, 由用户到仓库自行阅读。
    # 故此处不对许可做任何断言, 只列出该组要下载的模型及其仓库地址。
    mods = build_model_download_groups(sel, by_group)
    declined = set()
    if not mods:
        print("\n  [第三层] 未选择任何下游模型 —— 跳过。")
    else:
        print(f"\n  [第三层] 下游模型权重 ({len(mods)} 组) —— 我们仅代为下载, 并不分发这些权重;")
        print("           各权重的许可归其发布者所有。请到下方各自仓库自行阅读其许可条款。")
        print("           确认已阅读该组请输入 READ; 不想下载该组输入 NO (只跳过该组, 平台照常部署)。")
        for i, (g, label, comps) in enumerate(mods, 1):
            lines = []
            for c in comps:
                lines.append(f"    [模型] {c.get('component_id')}")
                d = c.get("description", "")[:80]
                if d:
                    lines.append(f"           {d}")
                repo = c.get("source_repo") or ""
                if repo:
                    lines.append(f"           仓库: {repo}")
            r = _review_model_group(label, i, len(mods), lines)
            if r == "quit":
                print("\n  已取消部署。")
                return None
            if r == "decline":
                declined.add(g)
                print(f"  已记录: 不下载 [{label}]。")

    # 裁剪: 用户对某下载组输入 NO, 即整组不下载 (平台仍照常部署)。
    kept = [g for g in sel["model_groups"] if g not in declined]
    dropped = [g for g in sel["model_groups"] if g in declined]
    sel = dict(sel)
    sel["model_groups"] = kept
    sel["dropped_for_license"] = dropped
    print("\n  第三方许可审阅完成。")
    return sel


# --------------------------------------------------------------------------
# 阶段 4: 最终确认
# --------------------------------------------------------------------------
# 每组粗略下载体积 (仅用于给用户预估, 非精确)
GROUP_APPROX = {
    "core": 1.9 * 1024**3, "asr": 1.6 * 1024**3, "g2pw": 0.6 * 1024**3,
    "langdetect": 0.13 * 1024**3, "alt_v2": 0.35 * 1024**3,
    "alt_v2proplus": 0.35 * 1024**3,
    # funasr = Paraformer-large + FSMN-VAD + CT-Transformer 标点 + 粤语 UniASR。
    "funasr": 2.4 * 1024**3,
    # UVR5 拆分后的 4 个功能子组 (合计 ~2.5GB, Roformer 占大头)。
    "uvr5_hp": 0.35 * 1024**3, "uvr5_deecho": 0.2 * 1024**3,
    "uvr5_mdx": 0.06 * 1024**3, "uvr5_roformer": 1.6 * 1024**3,
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
    dropped = sel.get("dropped_for_license") or []
    if dropped:
        labels = [next((l for gg, l, _ in GROUP_META if gg == g), g) for g in dropped]
        print("  * 你选择不下载以下模型组, 已从下载清单剔除 (平台照常部署):")
        for lb in labels:
            print(f"       - {lb}")
    print("  2) 下载上游模型 (最终清单):")
    est = 0.0
    for g in sel["model_groups"]:
        label = next((l for gg, l, _ in GROUP_META if gg == g), g)
        ap = GROUP_APPROX.get(g, 0)
        est += ap
        print(f"       - {label}   ~{human(ap)}")
    if not sel["model_groups"]:
        print("       - (无 —— 仅部署平台, 不下载任何模型)")
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
    sel = stage_licenses(sel, by_group)
    if sel is None:
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
