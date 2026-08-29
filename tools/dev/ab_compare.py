# -*- coding: utf-8 -*-
"""ab_compare —— 比两段音频差多少（shim.py vs host.py 的验收判据）

⭐ 这个工具有**两个身份**，报告上一眼要能分清：
   ① 给人用的分析工具 —— 参数随便调，想看什么看什么；
   ② 验收判据 —— 只有走具名预设 gate-v1 时才算数。
   参数**不藏**，但**实际取值永远打印在判决里**。传了自定义值照跑照出数，
   只是抬头会写明「本次结果不作为验收判据」。
   ⛔ 锁是靠可见锁的，不是靠不给调。

⭐⭐ 为什么不是「跨路径 ≤5% 就算过」这么一句：
   两次推理即使参数完全相同，结果也不会逐字节相同（浮点精度 + CUDA 非确定
   性 kernel）。所以「差 5%」这句话单独拿出来**不可判定** —— 不知道 5% 算大
   还是算小，除非同时知道**同一条路径自己跟自己差多少**。
   于是三个数一起报：

     地板   shim 跑两次，同 seed          精度噪声有多大
     跨路径 shim vs host，同 seed          ← 真正要判的，≤ 阈值才算过
     天花板 shim vs shim，但故意改一个参数  这个阈值到底有没有分辨力

   判据是**两条**：跨路径 ≤ 阈值 **且** 天花板 > 阈值。
   后一条是把验红纪律用在判据自己身上 —— 要是连「参数被改了」都差不到阈值
   以上，那这个阈值就是个放行一切的数，跨路径过了也什么都没证明。

⛔ 纯标准库，一个第三方包都不引（连 numpy 都不用）。
   不是洁癖 —— 是**判据工具不该挑解释器**。broker 的嵌入式 runtime 里没有
   numpy，引擎 venv 里才有；工具要是依赖 numpy，就得跟着引擎 venv 跑，
   于是换一台引擎、换一个 venv、numpy 版本一变，判据的数就可能跟着变。
   一个会因为环境而摇摆的判据，我们已经栽过一次（stderr 按字节截尾那次，
   同一份代码两台机器两种判决）。慢一点无所谓，它一共也跑不了几次。

用法：
    # 判据模式（四个 wav 齐了才有判决）
    python tools/dev/ab_compare.py --shim-a A1.wav --shim-b A2.wav \
        --host H.wav --altered C.wav

    # 分析模式（随手比两段，不出判决）
    python tools/dev/ab_compare.py --pair one.wav two.wav

退出码：0 判据过 / 1 判据没过 / 2 参数或文件不对，没比成
"""

import argparse
import cmath
import math
import os
import struct
import sys
import wave

# ---------------------------------------------------------------------------
# 具名预设 —— 判据只认这一套值，且每次都原样打印
# ---------------------------------------------------------------------------

PRESETS = {
    "gate-v1": {
        "n_fft": 1024,
        "hop": 256,
        "n_mels": 80,
        "fmin": 0.0,
        "fmax": 0.0,          # 0 = 奈奎斯特
        "eps": 1e-10,
        "mel_threshold": 0.05,   # 5%
        "dur_threshold": 0.05,   # 5%
    },
}

DEFAULT_PRESET = "gate-v1"


# ---------------------------------------------------------------------------
# 读 wav —— 只认 PCM，格式对不上当场说清楚，不猜
# ---------------------------------------------------------------------------

class AudioError(Exception):
    pass


class Clip(object):
    def __init__(self, path, rate, channels, sampwidth, samples):
        self.path = path
        self.rate = rate
        self.channels = channels
        self.sampwidth = sampwidth
        self.samples = samples          # 已混成单声道的 float 列表，范围约 [-1,1]

    @property
    def duration(self):
        return len(self.samples) / float(self.rate) if self.rate else 0.0

    def describe(self):
        return "%d Hz / %d ch / %d bit / %.3f s / %d 帧" % (
            self.rate, self.channels, self.sampwidth * 8,
            self.duration, len(self.samples))


def _decode_frames(raw, sampwidth, channels):
    """把 PCM 字节解成 [-1,1] 的 float，并把多声道平均成单声道。

    ⭐ 平均成单声道只影响**分析**，不影响判据的严格性 —— 声道数本身有一道
      单独的硬闸（必须完全相同），不会被这里的平均糊弄过去。
    """
    if sampwidth == 1:
        # 8-bit wav 是无符号的
        vals = [(b - 128) / 128.0 for b in bytearray(raw)]
    elif sampwidth == 2:
        n = len(raw) // 2
        vals = [v / 32768.0 for v in struct.unpack("<%dh" % n, raw[:n * 2])]
    elif sampwidth == 3:
        vals = []
        for i in range(0, len(raw) - 2, 3):
            b0, b1, b2 = raw[i], raw[i + 1], raw[i + 2]
            if not isinstance(b0, int):      # py2 兼容，无害
                b0, b1, b2 = ord(b0), ord(b1), ord(b2)
            v = b0 | (b1 << 8) | (b2 << 16)
            if v & 0x800000:
                v -= 0x1000000
            vals.append(v / 8388608.0)
    elif sampwidth == 4:
        n = len(raw) // 4
        vals = [v / 2147483648.0 for v in struct.unpack("<%di" % n, raw[:n * 4])]
    else:
        raise AudioError("不认识的位深：每样本 %d 字节" % sampwidth)

    if channels <= 1:
        return vals
    out = []
    for i in range(0, len(vals) - channels + 1, channels):
        out.append(sum(vals[i:i + channels]) / float(channels))
    return out


def read_wav(path):
    if not os.path.exists(path):
        raise AudioError("文件不在：%s" % path)
    try:
        w = wave.open(path, "rb")
    except wave.Error as e:
        raise AudioError("%s 打不开（只认 PCM WAV）：%s" % (path, e))
    try:
        channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        rate = w.getframerate()
        raw = w.readframes(w.getnframes())
    finally:
        w.close()
    if not raw:
        raise AudioError("%s 里一个采样都没有" % path)
    samples = _decode_frames(raw, sampwidth, channels)
    return Clip(path, rate, channels, sampwidth, samples)


# ---------------------------------------------------------------------------
# FFT / 梅尔 —— 手写，因为不引 numpy
# ---------------------------------------------------------------------------

def _fft(a):
    """迭代式 radix-2 FFT。长度必须是 2 的幂（预设里 n_fft 就是）。"""
    n = len(a)
    if n & (n - 1):
        raise AudioError("n_fft 必须是 2 的幂，收到 %d" % n)
    # 位反转重排
    out = list(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            out[i], out[j] = out[j], out[i]
    size = 2
    while size <= n:
        ang = -2.0 * math.pi / size
        step = cmath.exp(complex(0.0, ang))
        for start in range(0, n, size):
            wcur = complex(1.0, 0.0)
            half = size >> 1
            for k in range(start, start + half):
                u = out[k]
                v = out[k + half] * wcur
                out[k] = u + v
                out[k + half] = u - v
                wcur *= step
        size <<= 1
    return out


def _hann(n):
    if n == 1:
        return [1.0]
    return [0.5 - 0.5 * math.cos(2.0 * math.pi * i / (n - 1)) for i in range(n)]


def _hz_to_mel(f):
    return 2595.0 * math.log10(1.0 + f / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def _mel_filters(rate, n_fft, n_mels, fmin, fmax):
    """标准三角梅尔滤波器组，返回 [(起始bin, [权重...]), ...]。"""
    if fmax <= 0:
        fmax = rate / 2.0
    n_bins = n_fft // 2 + 1
    lo, hi = _hz_to_mel(fmin), _hz_to_mel(fmax)
    points = [_mel_to_hz(lo + (hi - lo) * i / (n_mels + 1))
              for i in range(n_mels + 2)]
    bins = [int(math.floor((n_fft + 1) * p / float(rate))) for p in points]
    bins = [max(0, min(n_bins - 1, b)) for b in bins]

    filters = []
    for m in range(1, n_mels + 1):
        left, center, right = bins[m - 1], bins[m], bins[m + 1]
        weights = []
        start = left
        for k in range(left, right + 1):
            if k < center and center > left:
                weights.append((k - left) / float(center - left))
            elif k == center:
                weights.append(1.0)
            elif k > center and right > center:
                weights.append((right - k) / float(right - center))
            else:
                weights.append(0.0)
        filters.append((start, weights))
    return filters


def log_mel(clip, cfg):
    """算对数梅尔谱，返回帧列表（每帧 n_mels 个数）。

    ⚠ 已知敏感点（**没有加特殊处理，这是有意的**）：
      对数谱在没能量的频带里偏敏感 —— 那里的值是 log10(0 + eps) = −10，
      掺一点噪声就能抬起来一大截，而这一格在听感上并不存在。

      我一度加过一刀 `top_db=80`（把低于「全谱最大值 − 80dB」的值夹住）来
      压这个，写了一整段理由。**然后量了，理由是错的**：满频带音频上夹与
      不夹 1.00 倍、带限 1.07 倍，而在真有静音段的那一栏是 0.66 倍 ——
      夹完数字反而从 3.11% 涨到 4.73%。它不但没抑制，还放大了。
      ⇒ 撤回，删掉。**没验住的机关不留。**

      真正兜住这件事的是**地板闸**：地板是从真音频上量出来的，静音敏感度
      要是真的咬人，地板会先超阈值并明说「红的是阈值不是 host」。
      一道从实测里长出来的通用闸，胜过一刀凭想象加的特例。
    """
    n_fft = cfg["n_fft"]
    hop = cfg["hop"]
    eps = cfg["eps"]
    win = _hann(n_fft)
    filters = _mel_filters(clip.rate, n_fft, cfg["n_mels"],
                           cfg["fmin"], cfg["fmax"])
    x = clip.samples
    frames = []
    pos = 0
    while pos + n_fft <= len(x):
        chunk = [complex(x[pos + i] * win[i], 0.0) for i in range(n_fft)]
        spec = _fft(chunk)
        power = [abs(spec[k]) ** 2 for k in range(n_fft // 2 + 1)]
        row = []
        for start, weights in filters:
            acc = 0.0
            for i, wgt in enumerate(weights):
                k = start + i
                if k < len(power):
                    acc += power[k] * wgt
            row.append(math.log10(acc + eps))
        frames.append(row)
        pos += hop
    return frames


def relative_l2(fa, fb):
    """‖A−B‖ / ‖A‖ —— 无量纲，本身就是个百分比。

    ⭐ 用相对量而不是绝对量：不受音量、绝对时长影响，5% 直接可读。
    ⭐ 两段长度不同时按短的截齐 —— 时长本身另有一道闸管着，
      不会靠这里的截齐偷偷放过差很多的。
    """
    n = min(len(fa), len(fb))
    if n == 0:
        raise AudioError("音频太短，一帧都凑不出（检查 n_fft / hop 和音频长度）")
    num = 0.0
    den = 0.0
    for t in range(n):
        ra, rb = fa[t], fb[t]
        for k in range(len(ra)):
            d = ra[k] - rb[k]
            num += d * d
            den += ra[k] * ra[k]
    if den <= 0.0:
        raise AudioError("参照那段的能量是 0，比不出相对差")
    return math.sqrt(num) / math.sqrt(den)


# ---------------------------------------------------------------------------
# 比一对
# ---------------------------------------------------------------------------

class Pair(object):
    def __init__(self, label, a, b, cfg):
        self.label = label
        self.a = a
        self.b = b
        self.hard = []          # 硬闸：不给容差的那些

        # ⛔ 采样率 / 声道 / 位深必须完全相同，不设容差 ——
        #   这三个不是精度问题，差了就是接错线。
        if a.rate != b.rate:
            self.hard.append("采样率不同：%d vs %d" % (a.rate, b.rate))
        if a.channels != b.channels:
            self.hard.append("声道数不同：%d vs %d" % (a.channels, b.channels))
        if a.sampwidth != b.sampwidth:
            self.hard.append("位深不同：%d vs %d 位"
                             % (a.sampwidth * 8, b.sampwidth * 8))

        self.dur_rel = (abs(a.duration - b.duration) / a.duration
                        if a.duration > 0 else float("inf"))
        if self.hard:
            self.mel_rel = None
        else:
            self.mel_rel = relative_l2(log_mel(a, cfg), log_mel(b, cfg))

    def line(self):
        if self.hard:
            return "%-8s ⛔ %s" % (self.label, "；".join(self.hard))
        return ("%-8s 梅尔相对差 %6.2f%%   时长差 %5.2f%%   (%.3fs vs %.3fs)"
                % (self.label, self.mel_rel * 100.0, self.dur_rel * 100.0,
                   self.a.duration, self.b.duration))


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def build_cfg(args):
    """返回 (cfg, is_preset, 改过的键)。"""
    cfg = dict(PRESETS[args.preset])
    changed = []
    for key in ("n_fft", "hop", "n_mels", "fmin", "fmax",
                "mel_threshold", "dur_threshold"):
        val = getattr(args, key)
        if val is not None and val != cfg[key]:
            cfg[key] = val
            changed.append(key)
    return cfg, (not changed), changed


def print_header(args, cfg, is_preset, changed):
    print("ab_compare —— shim.py vs host.py 的音频比对")
    print("=" * 74)
    if is_preset:
        print("预设：%s（判据模式）" % args.preset)
    else:
        print("⚠ 非预设参数（改了：%s）—— **本次结果不作为验收判据**"
              % ", ".join(changed))
        print("  想当判据请去掉这些选项，跑回 --preset %s。" % args.preset)
    print("  实际取值：n_fft=%d hop=%d n_mels=%d fmin=%g fmax=%g eps=%g"
          % (cfg["n_fft"], cfg["hop"], cfg["n_mels"], cfg["fmin"],
             cfg["fmax"], cfg["eps"]))
    print("  阈值：梅尔 %.2f%%   时长 %.2f%%"
          % (cfg["mel_threshold"] * 100.0, cfg["dur_threshold"] * 100.0))
    print("")


def main(argv=None):
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--preset", default=DEFAULT_PRESET, choices=sorted(PRESETS))
    ap.add_argument("--shim-a", help="shim 第一次（参照）")
    ap.add_argument("--shim-b", help="shim 第二次，同 seed —— 用来量噪声地板")
    ap.add_argument("--host", help="host 那条，同 seed —— 真正要判的")
    ap.add_argument("--altered",
                    help="shim 但故意改了一个参数 —— 用来验阈值有没有分辨力")
    ap.add_argument("--pair", nargs=2, metavar=("A", "B"),
                    help="分析模式：随手比两段，不出判决")
    for key, kind in (("n_fft", int), ("hop", int), ("n_mels", int),
                      ("fmin", float), ("fmax", float),
                      ("mel_threshold", float), ("dur_threshold", float)):
        ap.add_argument("--" + key.replace("_", "-"), dest=key, type=kind,
                        default=None)
    args = ap.parse_args(argv)

    cfg, is_preset, changed = build_cfg(args)
    print_header(args, cfg, is_preset, changed)

    try:
        # ---- 分析模式 -------------------------------------------------
        if args.pair:
            a = read_wav(args.pair[0])
            b = read_wav(args.pair[1])
            print("  A  %s  %s" % (os.path.basename(a.path), a.describe()))
            print("  B  %s  %s" % (os.path.basename(b.path), b.describe()))
            print("")
            print("  " + Pair("这一对", a, b, cfg).line())
            print("")
            print("（分析模式：只报数，不出判决）")
            return 0

        need = {"--shim-a": args.shim_a, "--shim-b": args.shim_b,
                "--host": args.host, "--altered": args.altered}
        missing = sorted(k for k, v in need.items() if not v)
        if missing:
            print("⛔ 判据模式要四段音频，缺了：%s" % ", ".join(missing))
            print("")
            print("  为什么四段都要 —— 少一段判据就退化成不可判定的：")
            print("    --shim-a / --shim-b   同一条路径跑两次 ⇒ 噪声地板")
            print("    --host                跨路径 ⇒ 真正要判的那个")
            print("    --altered             故意改过参数 ⇒ 验阈值有没有分辨力")
            print("")
            print("  只想随手比两段？用 --pair A.wav B.wav（不出判决）。")
            return 2

        a1 = read_wav(args.shim_a)
        a2 = read_wav(args.shim_b)
        h = read_wav(args.host)
        c = read_wav(args.altered)

        print("  参照 shim-a   %s" % a1.describe())
        print("  地板 shim-b   %s" % a2.describe())
        print("  跨路径 host   %s" % h.describe())
        print("  天花板 altered %s" % c.describe())
        print("")

        floor = Pair("地板", a1, a2, cfg)
        cross = Pair("跨路径", a1, h, cfg)
        ceil = Pair("天花板", a1, c, cfg)
        for p in (floor, cross, ceil):
            print("  " + p.line())
        print("")

    except AudioError as e:
        print("⛔ %s" % e)
        return 2

    # ---- 判决 ---------------------------------------------------------
    verdicts = []
    verdicts.append(("跨路径没有硬性不一致（采样率/声道/位深）",
                     not cross.hard,
                     "；".join(cross.hard) if cross.hard else "三项都相同"))
    if not cross.hard:
        verdicts.append(("⭐⭐ 跨路径梅尔差 ≤ %.2f%%" % (cfg["mel_threshold"] * 100),
                         cross.mel_rel <= cfg["mel_threshold"],
                         "实测 %.2f%%" % (cross.mel_rel * 100)))
        verdicts.append(("⭐⭐ 跨路径时长差 ≤ %.2f%%" % (cfg["dur_threshold"] * 100),
                         cross.dur_rel <= cfg["dur_threshold"],
                         "实测 %.2f%%" % (cross.dur_rel * 100)))
    if ceil.hard:
        verdicts.append(("⭐⭐ 天花板 > %.2f%%（否则阈值没有分辨力）"
                         % (cfg["mel_threshold"] * 100), False,
                         "天花板那段的格式就对不上，量不出来"))
    else:
        verdicts.append(("⭐⭐ 天花板 > %.2f%%（否则阈值没有分辨力，全绿是空转）"
                         % (cfg["mel_threshold"] * 100),
                         ceil.mel_rel > cfg["mel_threshold"],
                         "实测 %.2f%%" % (ceil.mel_rel * 100)))
    # ⭐⭐ 地板也必须是一道闸，不能只当参考打印出来。
    #   道理：地板 = 同一条路径自己跟自己的差。它要是已经超过阈值，
    #   那这个阈值**根本达不到** —— 此时跨路径红了，红的不是 host.py，是阈值。
    #   这两种红长得一模一样，但要查的地方完全相反。不分开，你会去查一个
    #   不存在的 bug。
    if not floor.hard:
        floor_ok = floor.mel_rel <= cfg["mel_threshold"]
        verdicts.append(
            ("⭐⭐ 地板 ≤ %.2f%%（地板超阈值 ⇒ 红的是阈值不是 host）"
             % (cfg["mel_threshold"] * 100),
             floor_ok,
             "实测 %.2f%%" % (floor.mel_rel * 100)
             + ("" if floor_ok else " —— 同一条路径自己都过不了这个阈值")))

    if not floor.hard and not cross.hard:
        print("  参考：跨路径 / 地板 = %.2f 倍（越接近 1 越说明差异全是精度噪声）"
              % (cross.mel_rel / floor.mel_rel if floor.mel_rel > 0
                 else float("inf")))
        print("")

    for name, ok, note in verdicts:
        print("  %-6s %s   [%s]" % ("ok" if ok else "⛔", name, note))

    passed = all(ok for _, ok, _ in verdicts)
    print("")
    print("=" * 74)
    print("结账：%d 条，%d 过" % (len(verdicts),
                                sum(1 for _, o, _ in verdicts if o)))
    if not is_preset:
        print("")
        print("⚠ 再说一次：本次用的是非预设参数，**这个判决不作为验收依据**。")
        return 0 if passed else 1
    if passed:
        print("判决：host.py 可以替代 shim.py")
        return 0

    # ⭐ 红了要先说清是**哪一种**红 —— 查的地方完全不同
    if not floor.hard and floor.mel_rel > cfg["mel_threshold"]:
        print("判决：⛔ 这一轮不能用来判 host.py。")
        print("")
        print("  地板（%.2f%%）自己就超过了阈值（%.2f%%）—— 同一条路径跑两次都过"
              % (floor.mel_rel * 100, cfg["mel_threshold"] * 100))
        print("  不了，说明这个阈值在这套音频上达不到。**要改的是阈值，不是"
              "host.py。**")
        print("  合理的下一步：把阈值定在地板之上（常见做法是地板的 2~3 倍），"
              "再重跑；")
        print("  ⛔ 但别一路调到跨路径正好过 —— 那是调到绿，不是判据。")
    else:
        print("判决：还不能替代 —— 上面 ⛔ 那几条")
    return 1


if __name__ == "__main__":
    sys.exit(main())
