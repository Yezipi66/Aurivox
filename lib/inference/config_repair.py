# -*- coding: utf-8 -*-
"""tts_infer.yaml 的自检与修复。

它是什么
--------
GPT-SoVITS 这台引擎在启动时检查自己那份**机器本地**的活动配置
(lib/inference/tts_infer.yaml): 缺了、空了、或者里面的路径已经指向不存在
的位置, 就从随包的模板 (tts_infer.yaml.example) 重新生成, 旧的先备份。

⭐ 为什么住在引擎这边, 而不是启动脚本里
---------------------------------------
这段逻辑原先长在 tools/scripts/start.ps1 的 Repair-EngineConfig 里
(76 行 PowerShell)。它是 **GPT-SoVITS 独有**的: 别的引擎没有 tts_infer.yaml,
名片里也没有"修配置文件"这个概念。

平台正在改成"按名片起引擎"(契约 v2 §5.1 / §9), 启动的人从 start.ps1 变成
平台自己。引擎特有的收拾工作若留在平台脚本里, 就会变成第二个引擎接进来时
没人敢删、也没人看得懂的残留 —— 所以搬到引擎自己身上: **谁起它都一样修**。

⛔ 只用标准库
-------------
本模块跑在引擎自己的环境里, 且要能在**没有 torch / 没有 yaml 包**的情况下
被测试直接调用 (lib/inference/configRepair.node.test.js 就是这么验它的)。
所以不许 import 第三方包, 也不许 import infer_server。

判据与 PowerShell 原版逐条对齐
------------------------------
1. 模板不存在        -> 什么都不做 (没有可回退的东西, 别把用户的配置删了)
2. 活动配置不存在    -> regen, reason='missing'
3. 内容空白/读不出来 -> regen, reason='empty or unreadable'
4. 值里含 '?'        -> regen, reason='mangled path: ...'
   (GBK 控制台把中文路径写成了问号, 这是真实发生过的事故)
5. 路径不存在        -> regen, reason='stale path: <原值> -> <探测到的绝对路径>'
6. 以上都不中        -> 不动

⭐ 第 5 条只检查两类值: 键名以 `_path` 结尾的, 或者值长得像 Windows 绝对路径
   (`^[A-Za-z]:[\\/]`)。PowerShell 版本注释里记着一个教训: 早期只看"长得像
   绝对路径"的值, 于是**一份路径全是相对写法的死配置每次都被判成健康**。
   `_path` 结尾这条判据就是为补那个洞加的, 移植时一并搬过来。
"""

import os
import re
import shutil
from datetime import datetime

# `key: value` —— 与 PowerShell 版的正则同义
_KV_RE = re.compile(r"^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$")
_COMMENT_RE = re.compile(r"^\s*#")
_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:[\\/]")
_DOT_SLASH_RE = re.compile(r"^\./")


def _strip_quotes(value):
    """去掉首尾的引号。

    对齐 PowerShell 的 `.Trim('"').Trim("'")` —— 它剥的是**首尾连续的**引号
    字符, 不是"配对的一对"。
    """
    return value.strip().strip('"').strip("'")


def decide(live_cfg, example_cfg, project_root, exists=os.path.exists,
           read_text=None):
    """判断要不要重新生成, 返回 (needs_regen, reason)。

    这是纯判断, 不碰磁盘写入 —— 测试直接调它。
    `exists` / `read_text` 可注入, 便于用假盘面验守卫自己会不会红。
    """
    if read_text is None:
        def read_text(path):
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()

    if not exists(example_cfg):
        # 没有模板 = 没有可回退的东西。⛔ 这时候绝不能判 regen:
        # 那会把用户唯一一份配置备份掉然后留下一个空位。
        return (False, "template missing")

    if not exists(live_cfg):
        return (True, "missing")

    try:
        content = read_text(live_cfg)
    except OSError:
        content = None

    if content is None or not content.strip():
        return (True, "empty or unreadable")

    for line in re.split(r"\r?\n", content):
        if _COMMENT_RE.match(line):
            continue
        m = _KV_RE.match(line)
        if not m:
            continue
        key, raw = m.group(1), m.group(2)
        value = _strip_quotes(raw)

        is_path_key = key.endswith("_path")
        looks_absolute = bool(_ABSOLUTE_RE.match(value))
        if not (is_path_key or looks_absolute):
            continue

        if "?" in value:
            return (True, "mangled path: {0}".format(value))

        if looks_absolute:
            probe = value
        elif not project_root:
            probe = None
        else:
            probe = os.path.join(project_root, _DOT_SLASH_RE.sub("", value))

        if probe and not exists(probe):
            return (True, "stale path: {0} -> {1}".format(value, probe))

    return (False, "")


def repair(live_cfg, example_cfg, project_root, log=print,
           now=None):
    """按 decide() 的结论修。返回实际发生的 reason ('' 表示没动)。"""
    needs_regen, reason = decide(live_cfg, example_cfg, project_root)

    if not needs_regen:
        if reason == "template missing":
            log("[cfg][WARN] 模板不存在: {0}, 跳过 tts_infer.yaml 自检".format(example_cfg))
        else:
            log("[cfg] tts_infer.yaml 检查通过")
        return ""

    if os.path.exists(live_cfg):
        stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
        backup = "{0}.bak-{1}".format(live_cfg, stamp)
        try:
            shutil.copyfile(live_cfg, backup)
            log("[cfg] 坏配置已备份 -> {0}".format(os.path.basename(backup)))
        except OSError as exc:
            log("[cfg][WARN] 备份失败 ({0}), 继续重建".format(exc))

    try:
        shutil.copyfile(example_cfg, live_cfg)
        log("[cfg] 已从模板重建 tts_infer.yaml (原因: {0})".format(reason))
        log("      需要的话请在界面里重新选一次 GPT/SoVITS 权重")
    except OSError as exc:
        log("[cfg][ERROR] 无法写入 {0}: {1}".format(live_cfg, exc))
        return ""

    return reason


# ---------------------------------------------------------------------------
# 给 configRepair.node.test.js 用的 JSON 探针。
# ⭐ 只做判断、不写盘 —— 测试要能在不真的破坏任何配置的前提下问它"你会怎么判"。
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    import json
    import sys

    ap = argparse.ArgumentParser(description="tts_infer.yaml repair decision probe")
    ap.add_argument("--live", required=True)
    ap.add_argument("--example", required=True)
    ap.add_argument("--root", default="")
    ns = ap.parse_args()

    needs, why = decide(ns.live, ns.example, ns.root)
    sys.stdout.write(json.dumps({"needs_regen": needs, "reason": why}, ensure_ascii=False))
