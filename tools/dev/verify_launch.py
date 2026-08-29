#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_launch —— 照**平台真正的那条启动路径**起一次引擎，并让它出一段声

    python tools\\dev\\verify_launch.py
    python tools\\dev\\verify_launch.py --ref "D:\\...\\编入队伍.wav"
    python tools\\dev\\verify_launch.py --plan-only        # 不起引擎，只验计划

这个脚本存在的理由
────────────────────────────────────────────────────────────────────────
A/B 判据（run_ab.py，5 条 5 过）证明的是：**host.py 出的音频和 shim.py 一样**。
它是自己拼命令把引擎起起来的 —— 那条命令是脚本写的，不是平台算的。

也就是说，到现在为止**没有任何一次验证走过 `engine-launch-plan.cjs`**。
而那才是 start.ps1 真正用的东西（start.ps1:65-66 调它，:339-342 照它 spawn）。
名片改了 entry、占位符表加了 {profile_json}，这条路上会不会翻车，没人验过。

⇒ 本脚本把那一段补上：出计划 → **照计划原样 spawn** → /health → 真出一段声 → 停。

⛔ 为什么不是「从界面点一下」
────────────────────────────────────────────────────────────────────────
界面上没有 indextts2 —— 这不是漏装，是 §12 第 2 步的**另一半还没做**：

  * start.ps1:57-58  起哪台引擎看环境变量 ENGINE_ID，默认写死 'gpt-sovits'
  * lib/engines/legacyDefault.js  webui 那条合成路径**从来没有「引擎」这个参数**，
    它绑死在写了 legacy_default:true 的那张名片上。该文件自己的注释写明删除
    条件：「当合成路径的每一次调用都自带 engine_id 时（契约 §12 第 2 步）」。

那一半和今天这一刀是两件事，今天这一刀不依赖它。所以验证绕开界面，
直接走启动路径本身 —— 反而更准：界面那条路上还夹着后端和 legacy 绑定，
翻了车说不清是谁的锅。

⭐⭐ 这里面有一条只能在真机上验的东西
────────────────────────────────────────────────────────────────────────
start.ps1:178 认自家引擎是这么认的：

    $isEngine = ($ENGINE_PROC_MARK -and $hay.Contains($ENGINE_PROC_MARK))
                                          ↑ $hay = 进程 Path + CommandLine，全小写

原先记号取「入口的绝对路径」，注释写明理由是「两台引擎的入口都叫 shim.py
是完全可能的」。可是走通用宿主之后，**入口的绝对路径必然是同一个** ——
从「可能撞」变成「必然撞」。撞了的后果就是那段注释自己写的：A 占着端口时
start.ps1 认为「我的引擎已经在跑了」，B 永远起不来，**且不报任何错**。

改法是走宿主时改用 cache/engines/<id>.profile.json 当记号。但「它到底有没有
出现在真起来的那个进程的命令行里」，沙箱里看不到 —— 只能在这里看。
本脚本 [3] 就在看这个。

判据（8 条）
────────────────────────────────────────────────────────────────────────
  [1] 平台算得出计划，且 entry 指向通用宿主
  [2] 名片解析结果真落盘了，且**逐字节等于 emit_profile.cjs 的输出**
      ⭐ 这条是防分叉：A/B 判据喂给 host.py 的是 emit_profile 的输出，
        正式启动喂的是这一份。两份不一样 ⇒ 判据证明的不是正在跑的东西。
  [3] own_process_mark 一台一个，且**真的出现在命令行里**（见上）
  [4] 照计划起得来，/health ready
  [5] 引擎身份来自名片，不是写死的
  [6] 真出一段声，WAV 解析得开、时长不为零
  [7] 同 seed 两次 ⇒ 字节相同（播种没坏）
  [8] 停干净，端口空出来
"""

import argparse
import hashlib
import io
import json
import os
import socket
import struct
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BANNER = "[verify_launch]"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENGINE_ID = "indextts2"

TOTAL = 0
PASSED = 0


class Fail(Exception):
    def __init__(self, message, code=1, hint=""):
        Exception.__init__(self, message)
        self.code = code
        self.hint = hint


def say(msg=""):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def check(ok, title, detail="", hint=""):
    """一条判据。⭐ 过与不过都印出实测值 —— 只印「ok」的报告是不能复核的。"""
    global TOTAL, PASSED
    TOTAL += 1
    if ok:
        PASSED += 1
        say("   ok     %s   %s" % (title, detail))
    else:
        say("   ⛔ 没过  %s   %s" % (title, detail))
        if hint:
            for line in hint.splitlines():
                say("          " + line)
    return ok


# ---------------------------------------------------------------------------
#  小工具
# ---------------------------------------------------------------------------
def port_is_open(port, host="127.0.0.1", timeout=0.35):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
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
    url = "http://127.0.0.1:%d/health" % port
    try:
        resp = urlopen(Request(url, method="GET"), timeout=timeout)
        body, code = resp.read(), resp.getcode()
    except HTTPError as exc:
        body, code = exc.read(), exc.code
    except (URLError, socket.error):
        return False, None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return False, None
    return bool(data.get("ready")) and code == 200, data


def tail(path, n=40):
    try:
        with io.open(path, encoding="utf-8", errors="replace") as f:
            return "".join(f.readlines()[-n:]).rstrip()
    except OSError:
        return "(日志读不到：%s)" % path


def wav_info(raw):
    """够用就好的 WAV 解析。⭐ 判据是字节，不是引擎的自述。"""
    if len(raw) < 44 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return None
    pos, fmt, data_len = 12, None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
        chunk = raw[pos + 8:pos + 8 + size]
        if cid == b"fmt " and len(chunk) >= 16:
            ch, sr, _, _, bits = struct.unpack("<HIIHH", chunk[2:16])
            fmt = (ch, sr, bits)
        elif cid == b"data":
            data_len = size
        pos += 8 + size + (size & 1)
    if not fmt or data_len is None:
        return None
    ch, sr, bits = fmt
    per = max(1, ch * bits // 8)
    return {"channels": ch, "sample_rate": sr, "bits": bits,
            "seconds": (data_len / per) / sr if sr else 0.0}


def run_node(args, what):
    """跑一条 node 命令，拿 stdout。⛔ 不吞错 —— 起不来要带着原因起不来。"""
    node = "node"
    bundled = os.path.join(ROOT, "tools", "runtime", "node", "node.exe")
    if os.path.isfile(bundled):
        node = bundled
    proc = subprocess.Popen([node] + args, cwd=ROOT,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = proc.communicate()
    out = out.decode("utf-8", "replace")
    err = err.decode("utf-8", "replace")
    if proc.returncode != 0:
        raise Fail("%s 失败（退出码 %d）" % (what, proc.returncode), 2,
                   (out + "\n" + err).strip())
    return out


# ---------------------------------------------------------------------------
#  [1][2][3] 计划这一侧 —— 起引擎之前先把能量的都量了
# ---------------------------------------------------------------------------
def verify_plan(port):
    say("")
    say("[1] 平台算得出启动计划吗（这是 start.ps1:65 干的事）")

    raw = run_node([os.path.join("lib", "engines", "engine-launch-plan.cjs"),
                    "--engine", ENGINE_ID, "--port", str(port)],
                   "engine-launch-plan.cjs")
    try:
        plan = json.loads(raw)
    except ValueError:
        raise Fail("启动计划不是合法 JSON", 2, raw[:2000])
    if plan.get("error"):
        raise Fail("平台算不出 %s 的启动计划：%s"
                   % (ENGINE_ID, plan.get("error")), 2,
                   "先跑 node tools\\run_tests.cjs，多半那边也是红的。")

    entry = plan.get("entry") or ""
    check(entry.replace("\\", "/").endswith("lib/engines/host.py"),
          "entry 指向通用宿主，不是引擎专属 shim", entry,
          "名片 engines/%s/manifest.json 的 runtime.entry 没换过来。\n"
          "先跑 python tools\\dev\\apply_profile_json_wiring.py" % ENGINE_ID)

    args = [str(a) for a in (plan.get("args") or [])]
    check("--profile-json" in args,
          "args 里带 --profile-json（宿主的必填参数）",
          " ".join(args))

    say("")
    say("[2] 名片解析结果落盘了吗 —— 而且和判据用的是同一份吗")

    dest = plan.get("profile_json_path")
    check(bool(dest), "计划里给出了 profile 的落点", str(dest),
          "launchPlan.js 没返回 profile_json_path。补丁没打全。")
    if not dest:
        raise Fail("没有落点，后面没法验", 2)

    check(os.path.isfile(dest), "那份文件真的写出来了",
          "%s（%d 字节）" % (os.path.relpath(dest, ROOT),
                            os.path.getsize(dest) if os.path.isfile(dest) else 0),
          "engine-launch-plan.cjs 的 writeHostProfile 没跑到。")
    if not os.path.isfile(dest):
        raise Fail("文件不在，后面没法验", 2)

    # ⭐⭐ 防分叉：A/B 判据喂给 host.py 的是 emit_profile.cjs 的输出；
    #   正式启动喂的是上面这一份。两份要是不一样，那 5 条 5 过证明的
    #   就不是正在跑的这个东西 —— 那种绿是空的。
    ref = os.path.join(ROOT, "cache", "engines", "_verify_ref.profile.json")
    run_node([os.path.join("tools", "dev", "emit_profile.cjs"),
              ENGINE_ID, "--out", ref], "emit_profile.cjs")
    a = open(dest, "rb").read()
    b = open(ref, "rb").read()
    try:
        os.remove(ref)
    except OSError:
        pass
    check(a == b,
          "⭐⭐ 启动路径写的 profile == emit_profile.cjs 的输出（逐字节）",
          "%d 字节 vs %d 字节  sha=%s" % (
              len(a), len(b), hashlib.sha256(a).hexdigest()[:16]),
          "名片语义分叉成两份实现了。A/B 判据证明的将不是正在跑的东西。\n"
          "两边都该走 lib/engines/hostProfile.js 的 buildHostProfile()。")

    say("")
    say("[3] own_process_mark —— start.ps1 靠它认自家引擎")

    mark = (plan.get("own_process_mark") or "")
    hay = ((plan.get("python") or "") + " " + entry + " "
           + " ".join(args)).lower()
    # start.ps1:170 是 (Path + ' ' + CommandLine).ToLowerInvariant()，
    # 然后 :178 直接 Contains。这里照同一个形状验。
    check(bool(mark) and mark in hay,
          "⭐⭐ 记号真的出现在将要执行的命令行里", mark,
          "记号在命令行里找不到 ⇒ Test-IsOwnProcess 认不出自家引擎。\n"
          "后果不是报错，是端口每次往上挪一格 —— 静默的。")

    # ⭐ 走宿主的引擎入口路径**必然相同** ⇒ 记号不能再取入口。
    check(not mark.replace("\\", "/").endswith("lib/engines/host.py"),
          "⭐⭐ 记号不是宿主入口（否则两台引擎的记号会一模一样）", mark,
          "这正是本轮修掉的那个 bug 又回来了：\n"
          "两台引擎都走宿主 ⇒ 入口绝对路径相同 ⇒ 记号相同 ⇒\n"
          "A 占着端口时 start.ps1 认为「我的引擎已经在跑了」，B 永远起不来且不报错。")

    return plan


# ---------------------------------------------------------------------------
#  [4]-[8] 真起真出声
# ---------------------------------------------------------------------------
def spawn(plan, port, log_path, wait_seconds):
    if port_is_open(port):
        raise Fail("%d 端口上已经有人了" % port, 2,
                   "上一轮的窗口可能还开着。先关掉 —— 两台引擎同时活着"
                   "会吃满显存，Windows 上容易直接闪退。")

    # ⭐⭐ 照计划原样拼，一个字都不自己加。
    #   自己加参数 = 验的就不是平台那条路径了，那才是这个脚本最容易白跑的方式。
    cmd = [plan["python"], plan["entry"]] + [str(a) for a in plan["args"]]
    cwd = plan.get("cwd") or ROOT

    say("    " + " ".join(cmd))
    say("    cwd  %s" % cwd)
    say("    日志 -> %s" % os.path.relpath(log_path, ROOT))

    d = os.path.dirname(log_path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    fh = io.open(log_path, "w", encoding="utf-8", errors="replace")
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT)

    t0, last = time.time(), 0.0
    while True:
        rc = proc.poll()
        if rc is not None:
            fh.close()
            raise Fail("引擎还没 ready 就退出了（退出码 %s）" % rc, 2,
                       "它自己说的话（末 40 行）：\n\n%s" % tail(log_path))
        ok, data = health(port)
        if ok:
            say("  ✅ ready，用了 %.1fs" % (time.time() - t0))
            return proc, fh, data
        if data is not None and data.get("failed"):
            fh.close()
            raise Fail("加载失败（/health 说 failed）", 2,
                       "日志末 40 行：\n\n%s" % tail(log_path))
        el = time.time() - t0
        if el > wait_seconds:
            fh.close()
            raise Fail("等了 %.0fs 还没 ready" % el, 2,
                       "日志末 40 行：\n\n%s" % tail(log_path))
        if el - last >= 10.0:
            last = el
            say("    ... 还在加载（%.0fs）" % el)
        time.sleep(1.0)


def shutdown(proc, fh, port):
    if proc.poll() is None:
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            say("    没停下来，强杀")
            try:
                proc.kill()
                proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                pass
    try:
        fh.close()
    except OSError:
        pass
    t0 = time.time()
    while port_is_open(port) and time.time() - t0 < 20:
        time.sleep(0.5)
    return not port_is_open(port)


def synth(port, text, ref, seed, timeout):
    url = "http://127.0.0.1:%d/tts" % port
    payload = {"text": text, "ref_audio_path": ref, "seed": seed}
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, method="POST",
                  headers={"Content-Type": "application/json"})
    try:
        resp = urlopen(req, timeout=timeout)
        return resp.getcode(), dict(resp.headers), resp.read()
    except HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


# ---------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="verify_launch",
        description="照平台真正的启动路径起一次引擎，并让它出一段声")
    ap.add_argument("--ref", default=os.path.join(
        ROOT, "assets", "Papyrus", "raw", "编入队伍.wav"),
        help="参考音频（默认用 A/B 那一段）")
    ap.add_argument("--text", default="今天风很大，我们把窗户关上吧。")
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--port", type=int, default=9883,
                    help="临时端口（默认 9883，避开 A/B 用的 9881/9882）")
    ap.add_argument("--wait", type=float, default=180.0, help="等 ready 的上限（秒）")
    ap.add_argument("--timeout", type=float, default=600.0, help="单次合成超时（秒）")
    ap.add_argument("--plan-only", action="store_true",
                    help="只验计划那三步，不起引擎（快，10 秒内出结果）")
    args = ap.parse_args(argv)

    say("%s 照平台的启动路径起一次 %s" % (BANNER, ENGINE_ID))
    say("  仓库根 %s" % ROOT)
    say("  端口   %d" % args.port)
    say("=" * 74)

    plan = verify_plan(args.port)

    if args.plan_only:
        say("")
        say("=" * 74)
        say("结账：%d 条，%d 过（--plan-only，没起引擎）" % (TOTAL, PASSED))
        return 0 if PASSED == TOTAL else 1

    if not os.path.isfile(args.ref):
        raise Fail("参考音频不在：%s" % args.ref, 2,
                   "换一段：--ref \"D:\\...\\某个.wav\"")

    say("")
    say("[4] 照这份计划，能不能真起来")
    log_path = os.path.join(ROOT, "outputs", "ab", "logs", "verify_launch.log")
    proc, fh, hdata = spawn(plan, args.port, log_path, args.wait)

    ok_all = False
    try:
        check(True, "起来了并且 /health ready",
              "banner=%s device=%s" % (hdata.get("banner"), hdata.get("device")))
        if hdata.get("seed_mode"):
            say("          seed_mode=%s rngs=%s"
                % (hdata.get("seed_mode"), hdata.get("seed_rngs")))

        say("")
        say("[5] 它认为自己是谁 —— 得来自名片，不是写死的")
        check(hdata.get("engine") == ENGINE_ID,
              "/health 报的引擎 id 来自名片", str(hdata.get("engine")),
              "宿主把引擎身份写死了，或者名片没递到。")

        say("")
        say("[6] 真出一段声（⭐ 契约 §11 判据 5：测试全绿不等于能出声）")
        t0 = time.time()
        code, headers, body = synth(args.port, args.text, args.ref,
                                    args.seed, args.timeout)
        el = time.time() - t0
        if code != 200:
            snippet = body.decode("utf-8", "replace")[:600]
            raise Fail("合成返回 %d，不是 200" % code, 1,
                       "它说：%s\n\n日志末 40 行：\n\n%s"
                       % (snippet, tail(log_path)))
        check(True, "POST /tts 返回 200", "%d 字节，用了 %.2fs" % (len(body), el))

        info = wav_info(body)
        check(info is not None, "返回的是解析得开的 WAV",
              "%d 字节" % len(body))
        if info:
            check(info["seconds"] > 0.1,
                  "⭐⭐ 真的有声音（时长不为零）",
                  "%.3fs  %dHz/%dch/%dbit" % (info["seconds"],
                                              info["sample_rate"],
                                              info["channels"], info["bits"]),
                  "0 长度的 WAV 也是合法 WAV —— 不看时长就会把「静默失败」读成绿。")

        out = os.path.join(ROOT, "outputs", "ab", "verify_launch.wav")
        d = os.path.dirname(out)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        with open(out, "wb") as f:
            f.write(body)
        say("          留了一份：%s（自己听一下）" % os.path.relpath(out, ROOT))

        say("")
        say("[7] 播种还活着吗（判据是字节，不是自述）")
        _, _, body2 = synth(args.port, args.text, args.ref,
                            args.seed, args.timeout)
        check(body == body2,
              "⭐⭐ 同 seed 两次 ⇒ 字节完全相同",
              "%d vs %d 字节  sha=%s" % (
                  len(body), len(body2),
                  hashlib.sha256(body).hexdigest()[:16]),
              "同 seed 出来的东西不一样 ⇒ A/B 那 0.00% 的地板是运气，不是性质。")
        ok_all = True
    finally:
        say("")
        say("[8] 停干净")
        freed = shutdown(proc, fh, args.port)
        check(freed, "进程停了，端口空出来了", "%d" % args.port,
              "端口还占着 ⇒ 下次起会挪端口。手工确认没有别的窗口开着。")

    say("")
    say("=" * 74)
    say("结账：%d 条，%d 过，%d 没过" % (TOTAL, PASSED, TOTAL - PASSED))
    if PASSED == TOTAL and ok_all:
        say("判决：**平台照新名片起得来，而且出得了声**。")
        say("")
        say("⭐⭐ 契约 §11 判据 8 **已于 2026-08-27 结账**：")
        say("     engines/indextts2/shim.py   523 行 → 0（文件已删）")
        say("   当时靠的是三份取证，缺一不可、顺序不能倒：")
        say("     ① run_ab.py       host.py 出的音频 == shim.py 出的音频（5/5）")
        say("     ② 本脚本          平台照新名片起得来、出得了声（14/14）")
        say("     ③ probe_host.py   宿主自身的契约自检（29/29）")
        say("   ⛔ ① 已经**不可复现**了 —— shim 那一侧永久消失。那是这一刀的")
        say("     必然代价，不是缺陷。今天起，本脚本是唯一还能验全链路的东西。")
        say("")
        say("   ⭐ 所以这 14 条的意义变了：从「删 shim 之前的放行条件」变成")
        say("     **「改完引擎相关的任何东西之后的回归判据」**。")
        say("     判据 5 写死了：测试全绿不等于能出声，静态检查代替不了这一跑。")
        say("")
        say("   ⛔⛔ 契约 §12 第 2 步**只做完了第一半**，别读成整件事：")
        say("     ① 启动路径走通用宿主                     ✅ 就是本脚本验的")
        say("     ② 合成路径带 engine_id 而不是写死默认引擎  ⛔ 还没做")
        say("     硬证据：start.ps1:57-58 靠环境变量兜底、legacyDefault.js、")
        say("     以及 server.js 里 indextts2 出现 **0 次**。")
        return 0
    say("判决：**先别删 shim.py**。上面没过的那几条得先弄清楚。")
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as exc:
        say("")
        say("%s ⛔ %s" % (BANNER, exc))
        if exc.hint:
            for line in str(exc.hint).splitlines():
                say("   " + line)
        sys.exit(exc.code)
    except KeyboardInterrupt:
        say("")
        say("%s 中断了。⚠ 引擎进程可能还活着 —— 确认一下端口。" % BANNER)
        sys.exit(130)
