# -*- coding: utf-8 -*-
"""GPT-SoVITS 引擎活动配置（lib/inference/tts_infer.yaml）的自检与修复。

引擎启动时检查自己那份机器本地的活动配置：缺了、空了，或里面的路径指向
不存在的位置，就从随包的模板（tts_infer.yaml.example）重新生成，原文件先备份。
要重建的情形由 decide() 逐条判定。

依赖只有标准库（os / re / shutil / datetime）。本模块跑在引擎自己的环境里，
必须在没有 torch、没有 yaml 包的情况下也能被测试直接调用。
由 infer_server.py 在启动时调用，所以修复跟着引擎走，与谁发起启动无关。
"""

import os
import re
import shutil
from datetime import datetime

# 匹配「键名: 值」一行：键名只含字母、数字与下划线，值取到行尾（首尾空白去掉）。
_KV_RE = re.compile(r"^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$")
_COMMENT_RE = re.compile(r"^\s*#")
_ABSOLUTE_RE = re.compile(r"^[A-Za-z]:[\\/]")
_DOT_SLASH_RE = re.compile(r"^\./")


def _strip_quotes(value):
    """剥掉首尾的引号。

    剥的是首尾连续的引号字符，不是配对的一对。
    """
    return value.strip().strip('"').strip("'")


def decide(live_cfg, example_cfg, project_root, exists=os.path.exists,
           read_text=None):
    """判断活动配置是否需要重建，返回 (needs_regen, reason)。

    纯判断，不碰磁盘写入，测试直接调用它。exists 与 read_text 可注入，
    便于用假盘面验证守卫本身会不会红。

    按顺序命中即返回：
      - 模板不存在 → (False, "template missing")。没有可回退的东西时重建，
        等于把用户唯一一份配置备份走，只剩一个空位。
      - 活动配置不存在 → (True, "missing")。
      - 内容空白或读不出来 → (True, "empty or unreadable")。
      - 路径类的值里有问号 → (True, "mangled path: <值>")。问号说明写入时
        被非 UTF-8 代码页破坏过，中文路径在 GBK 控制台里会写成问号。
      - 路径指向的位置不存在 → (True, "stale path: <原值> -> <探测到的路径>")。
      - 其余 → (False, "")。

    只有两类值参与路径探测：键名以 _path 结尾的，以及以盘符加冒号开头的
    Windows 绝对路径。只看绝对路径会漏掉相对写法的死路径。

    :param live_cfg: 活动配置的文件路径
    :param example_cfg: 模板的文件路径
    :param project_root: 相对路径的基准目录；为空时跳过相对路径的探测
    :param exists: 判断路径是否存在的函数，默认 os.path.exists
    :param read_text: 读取文件内容的函数，默认按 UTF-8 打开
    :returns: (needs_regen, reason)；reason 为空字符串表示无需重建
    """
    if read_text is None:
        def read_text(path):
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()

    if not exists(example_cfg):
        # 没有模板就没有可回退的东西，此时不判重建：
        # 重建流程会先把用户唯一一份配置备份走，只剩一个空位。
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
    """按 decide() 的结论修复活动配置，返回实际发生的 reason（空字符串表示没动）。

    重建前把原文件复制成 <原名>.bak-<时间戳>。备份失败只告警，仍继续重建；
    写盘失败时返回空字符串，不抛异常。

    :param live_cfg: 活动配置的文件路径
    :param example_cfg: 模板的文件路径
    :param project_root: 相对路径的基准目录
    :param log: 日志函数，默认 print
    :param now: 时间戳来源，默认 datetime.now
    :returns: 实际发生的 reason；没动或写盘失败时是空字符串
    """
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


# 给 configRepair.node.test.js 用的 JSON 探针。
# 只做判断、不写盘：测试要能在不真的破坏任何配置的前提下问它「你会怎么判」。
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
    # 输出走 UTF-8：Windows 上 stdout 默认是系统代码页（cp1252/cp936），
    # reason 里可能有中文路径，编码不上就是 UnicodeEncodeError。
    # 调用方按 utf-8 解码，这边就得按 utf-8 编码。
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdout.write(json.dumps({"needs_regen": needs, "reason": why}, ensure_ascii=False))
