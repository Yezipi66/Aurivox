#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""ab_capture —— 给 ab_compare 采四段音频，且**不许采错**

⛔⛔ 2026-08-27：`--role shim` 那一半已经没有对象了 —— engines/indextts2/shim.py
   随契约 §11 判据 8 删掉了（523 → 0）。这个脚本连同 run_ab.py 一起退休，
   留着是因为 §11 拿它们的读数结账，判据的出处不能是空气。详见 run_ab.py 抬头。
   ⚠ `--role host` 那一半技术上还能单跑，但**单侧采样不构成任何判据** ——
     A/B 的全部意义就是两侧对比。要验 host 一侧，用 tools/dev/verify_launch.py。

用法（两条路径各起一台，各跑一次；两次的 text/ref/seed 必须一模一样）：

    # 1) 老路径 shim.py 已经在 9881 上跑着
    python tools/dev/ab_capture.py --role shim --url http://127.0.0.1:9881 ^
        --ref D:\\path\\to\\reference.wav --text "……" --seed 12345

    # 2) 新路径 host.py 起在 9882 上
    python tools/dev/ab_capture.py --role host --url http://127.0.0.1:9882 ^
        --ref D:\\path\\to\\reference.wav --text "……" --seed 12345

    # 3) 判
    python tools/dev/ab_compare.py --shim-a outputs/ab/shim-a.wav ^
        --shim-b outputs/ab/shim-b.wav --host outputs/ab/host.wav ^
        --altered outputs/ab/altered.wav

--role shim 出三段（地板的两段 + 天花板那段），--role host 出一段。
⭐ 三段在同一个进程、同一次加载里采完 —— 中间不重启，地板才量的是
   「同一条路径的精度噪声」，而不是「两次加载的差别」。

---------------------------------------------------------------------------
⭐⭐ 这个脚本存在的全部理由，是**假绿比红更贵**
---------------------------------------------------------------------------
「跨路径差 ≤5%」这句话有太多种绿得毫无意义的方式：

  · 两个 --url 其实指向同一台服务（端口敲错一位）⇒ 跨路径当然 0%，全绿，
    但什么也没证明。            ← G1 拦
  · 播种压根没生效 ⇒ 量的是两次随机，地板会大得离谱，红的不是 host.py。
                                ← G4 拦
  · 天花板那段的参数改了等于没改（这个参数在当前配置下是空转）⇒ 阈值
    没有分辨力，判据是摆设。      ← G5 拦
  · 两轮采的句子/参考音频/seed 不一样 ⇒ 长得就像「host.py 坏了」。
                                ← G6 拦
  · outputs/ab 里躺着上一轮的旧 wav，这轮只重采了一半 ⇒ 拿新旧对着比。
                                ← G7 拦

⛔ 每一条都是**硬失败**，不是警告。采集阶段拦不住的，到判决阶段就分不清了。

纯标准库：判据链上的工具不该挑解释器。broker 的 tools/runtime/python 里
没有 numpy，引擎 venv 里才有；工具要是依赖 numpy 就得跟着引擎 venv 跑，
换个引擎、换个 venv、numpy 版本一变，判据的数就可能跟着变。
"""

import argparse
import hashlib
import json
import os
import sys
import time
import wave

try:                                   # py3
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
except ImportError:                    # pragma: no cover - py2 不支持
    sys.stderr.write("ab_capture 需要 Python 3\n")
    raise SystemExit(2)

BANNER = "[ab_capture]"

# ---------------------------------------------------------------------------
#  身份识别 —— 两条路径的 /health 天然长得不一样，正好拿来防「端口认错」
# ---------------------------------------------------------------------------
# ⭐ 两个独立判据一起用：banner 前缀 + seed_mode 字段在不在。
#   任何一个对不上就拒采。用两个是因为 banner 里有日期，将来会改；
#   seed_mode 是 host.py 独有的结构，不会因为改版本号就没了。
ROLE_SPEC = {
    "shim": {
        "banner_startswith": "[indextts2-shim",
        "has_seed_mode": False,
        "human": "老路径 engines/indextts2/shim.py",
    },
    "host": {
        "banner_startswith": "[engine-host",
        "has_seed_mode": True,
        "human": "新路径 lib/engines/host.py",
    },
}

# --role shim 要出的三段；--role host 只出一段。
SHIM_SHOTS = ("shim-a", "shim-b", "altered")
HOST_SHOTS = ("host",)


class Fail(Exception):
    """带退出码的失败。2 = 你给的东西不对，1 = 采到的东西不对。"""

    def __init__(self, msg, code=1, hint=None):
        Exception.__init__(self, msg)
        self.code = code
        self.hint = hint


# ---------------------------------------------------------------------------
#  HTTP —— 只用标准库，且把响应头一起带回来（X-Seed-Applied 是承重的）
# ---------------------------------------------------------------------------
def http_get_json(url, timeout):
    try:
        resp = urlopen(Request(url, method="GET"), timeout=timeout)
    except HTTPError as exc:
        body = exc.read()
        try:
            return exc.code, json.loads(body.decode("utf-8", "replace"))
        except Exception:
            return exc.code, {"_raw": body[:400].decode("utf-8", "replace")}
    except URLError as exc:
        raise Fail("连不上 %s：%s" % (url, exc.reason), 2,
                   "确认那一侧的进程还在，端口没敲错。")
    with resp:
        raw = resp.read()
    try:
        return resp.getcode(), json.loads(raw.decode("utf-8", "replace"))
    except Exception as exc:
        raise Fail("%s 回的不是 JSON：%s" % (url, exc), 1)


def http_post_tts(url, payload, timeout):
    data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, method="POST",
                  headers={"Content-Type": "application/json"})
    try:
        resp = urlopen(req, timeout=timeout)
    except HTTPError as exc:
        detail = exc.read()[:600].decode("utf-8", "replace")
        raise Fail("POST %s 回了 %d：%s" % (url, exc.code, detail), 1)
    except URLError as exc:
        raise Fail("POST %s 连不上：%s" % (url, exc.reason), 2)
    with resp:
        body = resp.read()
        headers = dict((k.lower(), v) for k, v in resp.getheaders())
        code = resp.getcode()
    return code, headers, body


# ---------------------------------------------------------------------------
#  WAV —— 只读元数据。真正的比对在 ab_compare 里，这里只确认「是段能听的」
# ---------------------------------------------------------------------------
def wav_meta(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        rate = w.getframerate()
        return {
            "sample_rate": rate,
            "channels": w.getnchannels(),
            "sample_width_bits": w.getsampwidth() * 8,
            "frames": n,
            "seconds": round(n / float(rate), 4) if rate else None,
        }


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
#  G1：这一侧到底是谁
# ---------------------------------------------------------------------------
def check_identity(base_url, role, timeout):
    spec = ROLE_SPEC[role]
    code, health = http_get_json(base_url.rstrip("/") + "/health", timeout)

    banner = str(health.get("banner") or "")
    has_seed_mode = "seed_mode" in health

    who = "banner=%r seed_mode=%s" % (banner, "有" if has_seed_mode else "无")

    ok_banner = banner.startswith(spec["banner_startswith"])
    ok_shape = (has_seed_mode == spec["has_seed_mode"])

    if not (ok_banner and ok_shape):
        # ⭐ 报文要能一眼看出「我连到的其实是另一条路径」
        other = "host" if role == "shim" else "shim"
        looks_like_other = (
            banner.startswith(ROLE_SPEC[other]["banner_startswith"])
            or has_seed_mode == ROLE_SPEC[other]["has_seed_mode"])
        extra = ""
        if looks_like_other:
            extra = ("\n   ⭐ 它看起来其实是 **%s**（%s）—— 十有八九是端口敲错了。"
                     % (other, ROLE_SPEC[other]["human"]))
        raise Fail(
            "⛔ --role %s 说的是 %s，但 %s 上那一位不是它：%s%s"
            % (role, spec["human"], base_url, who, extra),
            2,
            "两个 --url 要是指向同一台服务，跨路径差当然是 0%，"
            "全绿但什么也没证明 —— 所以这里必须拦死。")

    if code != 200 or not health.get("ready"):
        raise Fail(
            "⛔ %s 还没 ready（HTTP %s，ready=%r failed=%r）"
            % (base_url, code, health.get("ready"), health.get("failed")),
            2,
            "模型还在加载就采，采到的是 503 不是音频。"
            "轮询 /health 到 ready=true 再来。")

    return health


# ---------------------------------------------------------------------------
#  采一发
# ---------------------------------------------------------------------------
def shoot(base_url, name, payload, out_dir, timeout):
    url = base_url.rstrip("/") + "/tts"
    t0 = time.time()
    code, headers, body = http_post_tts(url, payload, timeout)
    elapsed = time.time() - t0

    if code != 200:
        raise Fail("%s：HTTP %d" % (name, code), 1)

    ctype = (headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype != "audio/wav":
        raise Fail("%s：Content-Type 是 %r，不是 audio/wav" % (name, ctype), 1)

    path = os.path.join(out_dir, name + ".wav")
    with open(path, "wb") as f:
        f.write(body)

    try:
        meta = wav_meta(path)
    except Exception as exc:
        raise Fail("%s：写下来的 %d 字节不是能解析的 WAV：%s"
                   % (name, len(body), exc), 1)

    seed_applied = headers.get("x-seed-applied") or ""

    # ---- G4：播种真的生效了吗 ------------------------------------------
    # ⭐⭐ 这条不拦住，地板量的就是「两次随机」而不是「精度噪声」，
    #    而地板一大，跨路径必然跟着红 —— 那个红指向的是错的地方。
    if payload.get("seed") is not None and not seed_applied.strip():
        raise Fail(
            "⛔ %s：请求里给了 seed=%r，但响应头 X-Seed-Applied 是空的 —— "
            "播种没生效。" % (name, payload.get("seed")), 1,
            "此时「地板」量的是两次随机，不是精度噪声；"
            "地板一大跨路径必然跟着红，而那个红指向的地方是错的。"
            "先把播种修好再采。")

    return {
        "name": name,
        "file": os.path.basename(path),
        "bytes": len(body),
        "sha256": sha256_file(path),
        "seed_applied": seed_applied,
        "engine_header": headers.get("x-engine") or "",
        "http_seconds": round(elapsed, 3),
        "request": payload,
        "wav": meta,
    }


# ---------------------------------------------------------------------------
#  主流程
# ---------------------------------------------------------------------------
def sidecar_path(out_dir, role):
    return os.path.join(out_dir, "capture-%s.json" % role)


def preflight_files(out_dir, shots, role, force):
    """G7：不许拿旧 wav 和新 wav 对着比。"""
    existing = [n + ".wav" for n in shots
                if os.path.exists(os.path.join(out_dir, n + ".wav"))]
    side = sidecar_path(out_dir, role)
    if os.path.exists(side):
        existing.append(os.path.basename(side))
    if not existing:
        return
    if not force:
        raise Fail(
            "⛔ outputs 里已经有上一轮的东西了：%s" % ", ".join(existing), 2,
            "只重采一半，就会拿这一轮的和上一轮的对着比 —— 那个差值"
            "既不是地板也不是跨路径，是**两轮之间**的差。\n"
            "   要么删掉整个目录重采两侧，要么加 --force（然后记得**两侧都重采**）。")
    sys.stderr.write("%s ⚠ --force：覆盖 %s —— 记得**两侧都重采**，"
                     "只补一侧等于拿两轮对着比。\n"
                     % (BANNER, ", ".join(existing)))


def cross_role_check(out_dir, role, common):
    """G6：host 那轮的 text/ref/seed 必须和 shim 那轮逐字相同。"""
    if role != "host":
        return None
    side = sidecar_path(out_dir, "shim")
    if not os.path.exists(side):
        raise Fail(
            "⛔ 还没采过 shim 那一侧（%s 不在）" % side, 2,
            "先跑 --role shim。它出三段（地板两段 + 天花板一段），"
            "host 这一侧只补第四段。")
    with open(side, "r", encoding="utf-8") as f:
        prev = json.load(f)
    prev_common = prev.get("common") or {}
    diff = [k for k in ("text", "ref_audio_path", "seed")
            if prev_common.get(k) != common.get(k)]
    if diff:
        lines = ["⛔ 这一轮和 shim 那一轮给的东西不一样：%s" % ", ".join(diff)]
        for k in diff:
            lines.append("      %-16s shim=%r" % (k, prev_common.get(k)))
            lines.append("      %-16s host=%r" % ("", common.get(k)))
        raise Fail("\n   ".join(lines), 2,
                   "两侧输入不同，出来的差值长得**和「host.py 坏了」一模一样**，"
                   "但要查的地方完全相反。所以这里拦死，不给容差。")
    return prev


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="ab_capture",
        description="给 ab_compare 采四段音频（两侧各跑一次）")
    ap.add_argument("--role", required=True, choices=sorted(ROLE_SPEC),
                    help="这一侧是哪条路径")
    ap.add_argument("--url", required=True, help="那一侧的 base url")
    ap.add_argument("--ref", required=True,
                    help="参考音频路径（⭐ 这是**引擎那台机器**上的路径）")
    ap.add_argument("--text", required=True, help="要合成的句子")
    ap.add_argument("--seed", type=int, default=12345)
    ap.add_argument("--out", default=os.path.join("outputs", "ab"))
    ap.add_argument("--timeout", type=float, default=600.0,
                    help="单次请求超时（秒）；TTS 慢，默认给 600")
    # ⛔ 出厂默认原先是 emo_alpha=0.3，那是**坏的默认值**：真机实测天花板那段
    #   和 shim-a **逐字节相同**（差 0%）。原因在上游 —— infer_v2.py:428-433
    #   无条件覆写 emo_alpha，名片传什么都不算数。
    #   天花板差 0% ⇒ 阈值在放行一切 ⇒ 全绿是空转。所以默认值必须换成一个
    #   在当前配置下**真的起作用**的参数。max_text_tokens_per_segment=4 实测
    #   把 3.15s 变成 6.80s、梅尔差 127.25%，闸门当场证明自己有分辨力。
    ap.add_argument("--altered-param", default="max_text_tokens_per_segment",
                    help="天花板那段改哪个参数（默认 max_text_tokens_per_segment）")
    ap.add_argument("--altered-value", default="4",
                    help="改成什么值（默认 4）")
    ap.add_argument("--force", action="store_true",
                    help="覆盖已有文件（⚠ 覆盖后两侧都要重采）")
    args = ap.parse_args(argv)

    print("%s 采集 —— %s" % (BANNER, ROLE_SPEC[args.role]["human"]))
    print("=" * 74)

    if not str(args.text).strip():
        raise Fail("--text 不能是空的", 2)

    out_dir = os.path.abspath(args.out)
    shots = SHIM_SHOTS if args.role == "shim" else HOST_SHOTS

    common = {
        "text": args.text,
        "ref_audio_path": args.ref,
        "seed": args.seed,
    }

    # ⭐⭐ 顺序是有讲究的：**先问「我连到的是谁」**，再管工作流。
    #   两者都会红的时候（比如端口敲错、而且还没采过 shim），身份那条才是
    #   要先说的 —— 「你在跟另一条路径说话」是最根本的错，而「先跑 shim」
    #   是把端口修对之后照样要做的下一步。
    #   反过来先报工作流，Owner 会去补采 shim，然后**再一次**撞在同一个错端口上。
    health = check_identity(args.url, args.role, min(args.timeout, 30.0))
    print("  身份 ok   banner=%s  device=%s"
          % (health.get("banner"), health.get("device")))
    if args.role == "host":
        print("            seed_mode=%s rngs=%s"
              % (health.get("seed_mode"), health.get("seed_rngs")))

    preflight_files(out_dir, shots, args.role, args.force)
    cross_role_check(out_dir, args.role, common)

    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    # 天花板那段：把一个参数**故意改掉**，用来证明阈值有分辨力
    altered_val = args.altered_value
    for cast in (int, float):
        try:
            altered_val = cast(args.altered_value)
            break
        except (TypeError, ValueError):
            continue

    results = []
    for name in shots:
        payload = dict(common)
        if name == "altered":
            payload[args.altered_param] = altered_val
        print("  采 %-8s ..." % name, end="")
        sys.stdout.flush()
        info = shoot(args.url, name, payload, out_dir, args.timeout)
        results.append(info)
        print("  %d 字节  %.2fs  %s  seed_applied=%s"
              % (info["bytes"], info["wav"]["seconds"] or 0.0,
                 "%dHz/%dch/%dbit" % (info["wav"]["sample_rate"],
                                      info["wav"]["channels"],
                                      info["wav"]["sample_width_bits"]),
                 info["seed_applied"] or "(空)"))

    # ---- G5：天花板那一刀真的改到东西了吗 -----------------------------
    if args.role == "shim":
        by = dict((r["name"], r) for r in results)
        if by["altered"]["sha256"] == by["shim-a"]["sha256"]:
            raise Fail(
                "⛔ 天花板那段和 shim-a **逐字节相同** —— 改 %s=%r 等于没改。"
                % (args.altered_param, altered_val), 1,
                "天花板的用处是证明「5% 这个阈值分得出差别」。"
                "它要是 0%，阈值就是在放行一切，全绿是空转。\n"
                "   换一个在当前配置下真的起作用的参数（--altered-param / "
                "--altered-value），别把这条关掉。")
        # 地板那两段字节相同是**合法的**（说明这条路径完全确定），不拦。
        if by["shim-a"]["sha256"] == by["shim-b"]["sha256"]:
            print("\n  ℹ 地板那两段逐字节相同 —— 这条路径是完全确定的，"
                  "地板会是 0%。这是好事，不是问题。")

    side = sidecar_path(out_dir, args.role)
    with open(side, "w", encoding="utf-8") as f:
        json.dump({
            "role": args.role,
            "url": args.url,
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "common": common,
            "altered": {"param": args.altered_param, "value": altered_val}
                       if args.role == "shim" else None,
            "health": health,
            "shots": results,
        }, f, ensure_ascii=False, indent=2)

    print("\n%s ✅ %s 这一侧采完了，%d 段 → %s"
          % (BANNER, args.role, len(results), out_dir))
    print("   留了一份 %s（记着这轮到底给了什么、拿回了什么）"
          % os.path.basename(side))

    if args.role == "shim":
        print("\n下一步：把 host.py 起在**另一个端口**上，然后")
        print("   python tools/dev/ab_capture.py --role host --url "
              "http://127.0.0.1:<那个端口> \\")
        print("       --ref %s --text <同一句> --seed %d" % (args.ref, args.seed))
        print("   ⭐ text / ref / seed 三个必须一模一样 —— 不一样会被 G6 拦下。")
    else:
        print("\n下一步：判")
        print("   python tools/dev/ab_compare.py \\")
        for n in ("shim-a", "shim-b", "host", "altered"):
            flag = {"shim-a": "--shim-a", "shim-b": "--shim-b",
                    "host": "--host", "altered": "--altered"}[n]
            print("       %s %s \\" % (flag, os.path.join(args.out, n + ".wav")))
        print("   （最后一行的反斜杠去掉）")

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Fail as exc:
        sys.stderr.write("\n%s %s\n" % (BANNER, exc))
        if exc.hint:
            sys.stderr.write("   %s\n" % exc.hint)
        sys.exit(exc.code)
