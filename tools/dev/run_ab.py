# -*- coding: utf-8 -*-
"""run_ab —— 一条命令跑完整个 shim vs host 的 A/B 验收

⛔⛔ 2026-08-27：**这个脚本已经跑不了了，而且是故意的。**
   它比的是 engines/indextts2/shim.py 和 lib/engines/host.py，而 shim.py
   在同一天随契约 §11 判据 8 删掉了（523 → 0）。⇒ 老路径那一侧不存在了。

   ⭐ 为什么不一起删：契约 §11 判据 8 拿它的读数结账。判据的可信度来自
     「量了什么、阈值多少、天花板证明了阈值有分辨力」—— 那些只有这份源码
     说得清。删了它，§11 就变成一句没有出处的自我宣称。
   ⚠ 但也别指望重跑：shim 那一侧永久消失了，**这次判决不可复现**。
     不可复现是这一刀的必然代价，不是这个脚本的缺陷。

   ⭐ 还活着的两个：
     tools/dev/verify_launch.py   照平台真实启动路径起引擎并真出声（14 条）
     tools/dev/ab_compare.py      纯离线比两段音频，跟 shim 没关系，随时能用

   最后一次真机读数（2026-08-27，Owner 的机器）：
     地板   梅尔相对差 0.00%   时长差 0.00%
     跨路径 梅尔相对差 0.00%   时长差 0.00%    ← 判据本体
     天花板 梅尔相对差 127.25% 时长差 116.25%  ← 证明 5% 这个阈值分得出差别
     结账：5 条，5 过。判决：host.py 可以替代 shim.py

    python tools/dev/run_ab.py

⭐⭐ 这个脚本**不新增任何判据**。判据仍然全部在 ab_capture.py（七道闸）和
   ab_compare.py（gate-v1 预设）里，它只做三件人做起来容易出错的事：

     ① 按顺序起/停引擎，且**同一时刻只有一台引擎活着**
        （Owner 的真机上同时开两台会闪退；而且实测 shim 窗口已经死过三次。）
     ② 把两侧的 text / ref / seed 用**同一个变量**发出去
        —— 手工两条命令各打一遍，是 G6 每次拦人的根本原因。
     ③ 引擎的 stdout/stderr 落盘成日志；进程要是中途没了，
        **把日志尾巴打出来**，而不是只留一句 10061。

⛔ 它不替代那两把尺子，也不给它们加开关：ab_compare 永远走 --preset gate-v1。

退出码：0 判据过 / 1 判据没过 / 2 环境或参数不对，没跑成
"""

import argparse
import os
import socket
import subprocess
import sys
import time
from urllib.error import URLError, HTTPError
from urllib.request import Request, urlopen
import json

BANNER = "[run_ab]"

# tools/dev/run_ab.py -> 仓库根
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ENGINE_ID = "indextts2"
OUT_DIR = os.path.join("outputs", "ab")
LOG_DIR = os.path.join(OUT_DIR, "logs")
PROFILE_JSON = os.path.join(OUT_DIR, "%s.profile.json" % ENGINE_ID)

# 采集会产出的东西。⭐ 每轮开跑前全清 —— 见 clean_outputs() 的注释。
CAPTURE_ARTIFACTS = (
    "shim-a.wav", "shim-b.wav", "altered.wav", "host.wav",
    "capture-shim.json", "capture-host.json",
)

# ⭐⭐ 天花板参数的默认值**不是 emo_alpha**。
#    上游 infer_v2.py:428-433：没传 emo_audio_prompt 时 emo_alpha 被无条件
#    覆写成 1.0 ⇒ 传 0.3 等于没传 ⇒ altered 和 shim-a 逐字节相同 ⇒ G5 判红。
#    max_text_tokens_per_segment 默认 120，改小会真的多切段（infer_v2.py:512），
#    切完还会插 interval_silence 静音（:685）⇒ 连音频长度都变。
DEFAULT_ALTERED_PARAM = "max_text_tokens_per_segment"
DEFAULT_ALTERED_VALUE = "4"

DEFAULT_REF = os.path.join(
    ROOT, "assets", "Papyrus", "raw", "\u7f16\u5165\u961f\u4f0d.wav")
DEFAULT_TEXT = "\u4eca\u5929\u98ce\u5f88\u5927\uff0c\u6211\u4eec\u628a\u7a97\u6237\u5173\u4e0a\u5427\u3002"
DEFAULT_SEED = 12345


class Fail(Exception):
    def __init__(self, msg, code=2, hint=None):
        Exception.__init__(self, msg)
        self.code = code
        self.hint = hint


# ---------------------------------------------------------------------------
#  小工具
# ---------------------------------------------------------------------------
def say(msg=""):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def stage(n, total, title):
    say("")
    say("=" * 74)
    say("%s [%d/%d] %s" % (BANNER, n, total, title))
    say("=" * 74)


def engine_python():
    """引擎自己的 venv —— ⛔ 不是跑本脚本的这个解释器。"""
    if os.name == "nt":
        p = os.path.join(ROOT, "engines", ENGINE_ID, ".venv", "Scripts", "python.exe")
    else:
        p = os.path.join(ROOT, "engines", ENGINE_ID, ".venv", "bin", "python")
    return p


def port_is_open(port, host="127.0.0.1", timeout=0.5):
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except OSError:
        return False
    finally:
        try:
            s.close()
        except OSError:
            pass


def health(port, timeout=3.0):
    """(ready, payload)。连不上就 (False, None)。"""
    url = "http://127.0.0.1:%d/health" % port
    try:
        resp = urlopen(Request(url, method="GET"), timeout=timeout)
        body = resp.read()
        code = resp.getcode()
    except HTTPError as exc:
        body = exc.read()
        code = exc.code
    except (URLError, socket.error):
        return False, None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return False, None
    return bool(data.get("ready")) and code == 200, data


def tail(path, n=40):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return "(日志读不到：%s)" % path
    return "".join(lines[-n:]).rstrip()


# ---------------------------------------------------------------------------
#  引擎的起与停 —— ⭐ 同一时刻只有一台活着，这是本脚本存在的第一个理由
# ---------------------------------------------------------------------------
class Engine(object):
    def __init__(self, name, cmd, port, log_path):
        self.name = name
        self.cmd = cmd
        self.port = port
        self.log_path = log_path
        self.proc = None
        self.log_fh = None

    def start(self, wait_seconds):
        if port_is_open(self.port):
            raise Fail(
                "%d 端口上已经有人了，不能起 %s" % (self.port, self.name),
                2,
                "上一轮的窗口可能还开着。先把它关掉 —— 两台引擎同时活着"
                "正是要避免的事（显存 + 闪退），而且端口占用会让身份闸失去意义。")

        say("  起 %s ..." % self.name)
        say("    " + " ".join(self.cmd))
        say("    日志 -> %s" % os.path.relpath(self.log_path, ROOT))
        self.log_fh = open(self.log_path, "w", encoding="utf-8", errors="replace")
        self.proc = subprocess.Popen(
            self.cmd, cwd=ROOT,
            stdout=self.log_fh, stderr=subprocess.STDOUT)

        t0 = time.time()
        last_note = 0.0
        while True:
            rc = self.proc.poll()
            if rc is not None:
                raise Fail(
                    "%s 还没 ready 就退出了（退出码 %s）" % (self.name, rc), 2,
                    "下面是它自己说的话（%s 末 40 行）：\n\n%s"
                    % (os.path.relpath(self.log_path, ROOT), tail(self.log_path)))

            ok, data = health(self.port)
            if ok:
                elapsed = time.time() - t0
                say("  ✅ %s ready，用了 %.1fs" % (self.name, elapsed))
                say("     banner=%s device=%s"
                    % (data.get("banner"), data.get("device")))
                if data.get("seed_mode"):
                    say("     seed_mode=%s rngs=%s"
                        % (data.get("seed_mode"), data.get("seed_rngs")))
                return data

            if data is not None and data.get("failed"):
                raise Fail(
                    "%s 加载失败（/health 说 failed）" % self.name, 2,
                    "日志末 40 行：\n\n%s" % tail(self.log_path))

            elapsed = time.time() - t0
            if elapsed > wait_seconds:
                raise Fail(
                    "%s 等了 %.0fs 还没 ready" % (self.name, elapsed), 2,
                    "日志末 40 行：\n\n%s" % tail(self.log_path))
            if elapsed - last_note >= 10.0:
                last_note = elapsed
                say("    ... 还在加载（%.0fs）" % elapsed)
            time.sleep(1.0)

    def stop(self):
        """⭐ 停干净才算停 —— 端口还开着就等于下一台起不来。"""
        if self.proc is None:
            return
        if self.proc.poll() is None:
            say("  停 %s ..." % self.name)
            try:
                self.proc.terminate()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                say("    没停下来，强杀")
                try:
                    self.proc.kill()
                    self.proc.wait(timeout=10)
                except (OSError, subprocess.TimeoutExpired):
                    pass
        if self.log_fh is not None:
            try:
                self.log_fh.close()
            except OSError:
                pass
            self.log_fh = None

        t0 = time.time()
        while port_is_open(self.port) and time.time() - t0 < 20:
            time.sleep(0.5)
        if port_is_open(self.port):
            raise Fail(
                "%s 停了，但 %d 端口还开着" % (self.name, self.port), 2,
                "下一台引擎会因为端口被占起不来。先手工确认没有别的窗口开着。")
        say("  ✅ %s 已停，%d 端口空出来了" % (self.name, self.port))


# ---------------------------------------------------------------------------
#  各步骤
# ---------------------------------------------------------------------------
def preflight(args):
    """先量再走：所有前置文件都得在，缺了当场说清缺哪个。"""
    py = engine_python()
    problems = []
    if not os.path.isfile(py):
        problems.append("引擎 venv 的解释器不在：%s" % py)
    for rel in (os.path.join("engines", ENGINE_ID, "shim.py"),
                os.path.join("lib", "engines", "host.py"),
                os.path.join("tools", "dev", "ab_capture.py"),
                os.path.join("tools", "dev", "ab_compare.py"),
                os.path.join("tools", "dev", "emit_profile.cjs")):
        if not os.path.isfile(os.path.join(ROOT, rel)):
            problems.append("找不到 %s" % rel)
    if not os.path.isdir(os.path.join(ROOT, args.checkpoints)):
        problems.append("checkpoints 目录不在：%s" % args.checkpoints)
    if not os.path.isfile(args.ref):
        problems.append("参考音频不在：%s" % args.ref)
    if problems:
        raise Fail("环境不齐，没开始就停下了：\n   " + "\n   ".join(
            "⛔ " + p for p in problems), 2,
            "这些都是「先量再走」量得出来的东西 —— 让它们在起引擎之前就喊，"
            "比加载 46 秒之后再死强。")
    say("  ✅ 前置齐了（引擎 venv / shim.py / host.py / 两把尺子 / "
        "checkpoints / 参考音频）")


def clean_outputs(out_dir):
    """G7 的正解：**两侧一起清**。

    ⭐ ab_capture 的 G7 拦的是「只重采一半，拿这一轮和上一轮对着比」。
      本脚本每次都把两侧完整重采一遍，那个前提结构上不成立 ⇒ 清是安全的。
    ⛔ 只清采集产物，**不动 profile json** —— 它是上一步 emit 出来的，删了要重出。
    """
    removed = []
    for name in CAPTURE_ARTIFACTS:
        p = os.path.join(out_dir, name)
        if os.path.exists(p):
            os.remove(p)
            removed.append(name)
    if removed:
        say("  清掉上一轮的采集产物：%s" % ", ".join(removed))
        say("     （⭐ 两侧都会在本轮重采，所以清是安全的 —— "
            "G7 拦的是只补一半）")
    else:
        say("  outputs 是干净的")


def emit_profile(args):
    out = os.path.join(ROOT, PROFILE_JSON)
    cmd = [args.node, os.path.join("tools", "dev", "emit_profile.cjs"),
           ENGINE_ID, "--out", PROFILE_JSON]
    say("  " + " ".join(cmd))
    rc = subprocess.call(cmd, cwd=ROOT)
    if rc != 0:
        raise Fail("emit_profile.cjs 退出码 %d" % rc, 2,
                   "名片解析没过，host.py 就没有可吃的东西。"
                   "先看它自己打印的原因。")
    if not os.path.isfile(out):
        raise Fail("emit_profile.cjs 说成功了，但 %s 不在" % PROFILE_JSON, 2)
    say("  ✅ %s（%d 字节）" % (PROFILE_JSON, os.path.getsize(out)))


def capture(role, port, args):
    cmd = [sys.executable, os.path.join("tools", "dev", "ab_capture.py"),
           "--role", role,
           "--url", "http://127.0.0.1:%d" % port,
           "--ref", args.ref,
           "--text", args.text,
           "--seed", str(args.seed),
           "--out", args.out,
           "--timeout", str(args.capture_timeout)]
    if role == "shim":
        # ⭐ 天花板只在 shim 那一侧采（HOST_SHOTS 只有一段），
        #   所以这两个参数**只能**加在这里。
        cmd += ["--altered-param", args.altered_param,
                "--altered-value", args.altered_value]
    say("  " + " ".join(cmd))
    say("")
    rc = subprocess.call(cmd, cwd=ROOT)
    if rc != 0:
        raise Fail(
            "ab_capture --role %s 判红了（退出码 %d）" % (role, rc), rc,
            "⭐ 上面是它自己说的原因，那才是要读的。本脚本不解释、也不放宽 —— "
            "七道闸每一道拦下来都是真事。")


def compare(args):
    cmd = [sys.executable, os.path.join("tools", "dev", "ab_compare.py"),
           "--preset", "gate-v1",
           "--shim-a", os.path.join(args.out, "shim-a.wav"),
           "--shim-b", os.path.join(args.out, "shim-b.wav"),
           "--host", os.path.join(args.out, "host.wav"),
           "--altered", os.path.join(args.out, "altered.wav")]
    say("  " + " ".join(cmd))
    say("")
    return subprocess.call(cmd, cwd=ROOT)


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def build_parser():
    ap = argparse.ArgumentParser(
        prog="run_ab",
        description="一条命令跑完 shim vs host 的 A/B 验收（串行起停，"
                    "同一时刻只有一台引擎活着）")
    ap.add_argument("--ref", default=DEFAULT_REF, help="参考音频（绝对路径）")
    ap.add_argument("--text", default=DEFAULT_TEXT)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--out", default=OUT_DIR)
    ap.add_argument("--shim-port", type=int, default=9881)
    ap.add_argument("--host-port", type=int, default=9882)
    ap.add_argument("--checkpoints",
                    default=os.path.join("models", "tts", ENGINE_ID, "checkpoints"))
    ap.add_argument("--node", default="node")
    ap.add_argument("--load-timeout", type=float, default=300.0,
                    help="等引擎 ready 的上限（秒）")
    ap.add_argument("--capture-timeout", type=float, default=600.0)
    ap.add_argument("--altered-param", default=DEFAULT_ALTERED_PARAM)
    ap.add_argument("--altered-value", default=DEFAULT_ALTERED_VALUE)
    ap.add_argument("--skip-profile", action="store_true",
                    help="profile json 已经在了就别重出")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)

    out_dir = os.path.join(ROOT, args.out)
    log_dir = os.path.join(ROOT, LOG_DIR)
    for d in (out_dir, log_dir):
        if not os.path.isdir(d):
            os.makedirs(d)

    args.ref = os.path.abspath(args.ref)

    total = 6
    say("%s shim vs host —— 全流程" % BANNER)
    say("  仓库根   %s" % ROOT)
    say("  参考音频 %s" % args.ref)
    say("  文本     %s" % args.text)
    say("  seed     %d" % args.seed)
    say("  天花板   %s=%s" % (args.altered_param, args.altered_value))
    say("  端口     shim=%d  host=%d（两个不同号：身份闸靠它拦端口敲错）"
        % (args.shim_port, args.host_port))

    stage(1, total, "先量再走：前置检查 + 清上一轮")
    preflight(args)
    clean_outputs(out_dir)

    stage(2, total, "出名片解析结果（host.py 要吃它）")
    if args.skip_profile and os.path.isfile(os.path.join(ROOT, PROFILE_JSON)):
        say("  --skip-profile：沿用已有的 %s" % PROFILE_JSON)
    else:
        emit_profile(args)

    shim = Engine(
        "shim (老路径)",
        [engine_python(), os.path.join("engines", ENGINE_ID, "shim.py"),
         "--host", "127.0.0.1", "--port", str(args.shim_port),
         "--checkpoints", args.checkpoints],
        args.shim_port, os.path.join(log_dir, "shim.log"))

    host = Engine(
        "host (新路径)",
        [engine_python(), os.path.join("lib", "engines", "host.py"),
         "--profile-json", PROFILE_JSON,
         "--host", "127.0.0.1", "--port", str(args.host_port)],
        args.host_port, os.path.join(log_dir, "host.log"))

    rc = 0
    try:
        stage(3, total, "只起 shim，采三段（shim-a / shim-b / altered）")
        shim.start(args.load_timeout)
        try:
            capture("shim", args.shim_port, args)
        finally:
            # ⭐ 采完立刻停 —— 从这里到 host 起来之间，一台引擎都不占显存。
            shim.stop()

        stage(4, total, "只起 host，采第四段（host）")
        host.start(args.load_timeout)
        try:
            capture("host", args.host_port, args)
        finally:
            host.stop()

        stage(5, total, "两台引擎都停了，下面是纯离线判决")
        say("  确认：%d %s / %d %s"
            % (args.shim_port, "还开着 ⛔" if port_is_open(args.shim_port) else "已关 ✅",
               args.host_port, "还开着 ⛔" if port_is_open(args.host_port) else "已关 ✅"))

        stage(6, total, "判（ab_compare --preset gate-v1）")
        rc = compare(args)
    finally:
        # 任何一步炸了，都别留着进程占显存/端口。
        for eng in (host, shim):
            try:
                eng.stop()
            except Fail:
                pass

    say("")
    say("=" * 74)
    if rc == 0:
        say("%s ✅ 判据过了。四段音频和随行记录在 %s" % (BANNER, args.out))
    else:
        say("%s ⛔ 判据没过（ab_compare 退出码 %d）—— 上面那份判决是要读的东西。"
            % (BANNER, rc))
    say("   引擎日志：%s" % os.path.relpath(log_dir, ROOT))
    say("=" * 74)
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as exc:
        sys.stderr.write("\n%s ⛔ %s\n" % (BANNER, exc))
        if exc.hint:
            sys.stderr.write("   %s\n" % exc.hint)
        sys.exit(exc.code)
    except KeyboardInterrupt:
        sys.stderr.write("\n%s 被 Ctrl-C 打断。⚠ 引擎进程可能还在，"
                         "确认一下 9881/9882 有没有残留。\n" % BANNER)
        sys.exit(130)
