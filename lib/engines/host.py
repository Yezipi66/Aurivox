# -*- coding: utf-8 -*-
"""通用引擎宿主 —— 契约 §12 第 2 步

它是什么
--------
`engines/<id>/shim.py` 的替代品，**一份，所有引擎共用**。
把「传话的」那 294 行样板（HTTP 服务、探活、四类 400 校验、wav 头解析、
推理排队、洗 sys.path）从每台引擎的目录里收上来，只留下名片描述的那部分。

✅ 2026-08-27：`engines/indextts2/shim.py`（523 行）**已经删掉了** ——
契约 §11 判据 8「shim.py 缩到零」结账。判据不是「看着能跑」：
`tools/dev/run_ab.py` 采四段音频比梅尔差，跨路径 0.00% / 天花板 127.25%，
5 条判据 5 过；`tools/dev/verify_launch.py` 照平台真实启动路径起了一次
并真出了声，14 条 14 过。
⇒ 下面凡是引 `shim.py:NNN` 的地方，都是**已删文件的存档引文**，
  保留是因为那些行号是当初每一条设计的出处；别去那个路径找它。

它怎么知道要跑哪台引擎
----------------------
⛔ **它不读 `manifest.json`。**
名片的语义只有一个实现 —— `lib/engines/profile.js`。宿主收的是**已经解析好**
的 JSON。理由是（已删的）`shim.py` 第 106 行那句自白：

    #  2) 参数白名单 —— 与 manifest.json 的 param_keys 必须一致
    LOAD_TIME_KEYS = frozenset({...})

「必须一致」＝没有任何东西保证一致。名片语义写两遍（JS 一遍、Python 一遍）
迟早分叉，那正是这个项目在消灭的那类 bug。

    python lib/engines/host.py --profile-json <路径>
    python lib/engines/host.py --profile-json -      # 从 stdin 读

调试时用 `tools/dev/emit_profile.cjs` 打印解析结果，管道灌进来即可。

三条硬纪律（继承自 shim.py，改这个文件前先读）
---------------------------------------------
1. **只用标准库。** 这个进程跑在**引擎自己的 venv** 里，和 broker 的 venv
   没有任何共同依赖。装第三方包 = 给那个环境引入新的冲突面。
2. **启动即加载，不许懒加载。** 冷启动可能 60 秒以上，而请求超时只有 300 秒。
   把加载挪到启动阶段，请求窗口才安全。代价是启动慢 —— 所以有 /health。
3. **洗 sys.path。** 宿主机上别的软件（如 Hermes）会把自己的 site-packages
   注入并排在引擎 venv **前面**，把 tokenizers / numpy 换成它的版本。
   必须在 import 引擎之前剔除。
"""

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import wave

BANNER = "[engine-host / 2026-08-26]"

# ---------------------------------------------------------------------------
#  0) 洗环境 —— 必须在 import 引擎之前
# ---------------------------------------------------------------------------
# 用「路径片段包含」而不是精确相等，因为盘符和用户名会变。
_ALIEN_PATH_MARKERS = (
    os.path.join("hermes", "hermes-agent"),
    os.path.join("hermes-agent", "venv"),
)


def _scrub_sys_path():
    """剔除非本引擎的注入路径，返回 (被剔除的, 剩下的)。"""
    kept, dropped = [], []
    for p in sys.path:
        norm = os.path.normcase(str(p))
        if any(os.path.normcase(m) in norm for m in _ALIEN_PATH_MARKERS):
            dropped.append(p)
        else:
            kept.append(p)
    sys.path[:] = kept
    return dropped, kept


_DROPPED, _KEPT = _scrub_sys_path()

# 离线：宿主永远不该联网下载权重。少一条网络依赖，就少一类
# 「第一次跑得通、换台机器跑不通」。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("MODELSCOPE_OFFLINE", "1")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402


# ---------------------------------------------------------------------------
#  1) 播种 —— 契约 §5.2.1
# ---------------------------------------------------------------------------
# ⭐ 每个 RNG 一个独立函数，返回「真的播到了吗」。
#    ⛔ 不许 try/except: pass 吞掉 —— 那会让播种失败变成静默的，
#    而静默失效正是 §1 点名的那个坑。播不到就照实说，由调用方决定怎么办。
def _seed_python(seed):
    import random
    random.seed(seed)
    return "python"


def _seed_numpy(seed):
    import numpy
    numpy.random.seed(seed % (2 ** 32))
    return "numpy"


def _seed_torch(seed):
    import torch
    torch.manual_seed(seed)
    return "torch"


def _seed_torch_cuda(seed):
    import torch
    if not torch.cuda.is_available():
        return None          # 不是错误：这台机器就是没有 CUDA
    torch.cuda.manual_seed_all(seed)
    return "torch.cuda"


# ---------------------------------------------------------------------------
#  init_args 里的 {占位符}
# ---------------------------------------------------------------------------
#
# ⛔⛔ 这一段原本**不存在**：`init_args` 是被原样 `dict()` 一下就 `klass(**init_args)`
#   了，于是名片里写 "{checkpoints}/config.yaml" 会把**大括号本身**当字面量传给
#   上游构造函数 —— 上游拿到一个不存在的路径，报一个跟名片毫无关系的错。
#
#   为什么以前没暴露：探针里那台假引擎的 init_args 是写死的字面值，不带占位符。
#   ⇒ 又是「夹具比现实简单」造成的假绿，和 requires_reference_audio 那次同一类。
#
# ⭐ 占位符表**故意和 launchPlan.js 的 PLACEHOLDERS 对齐**（那边是
#   host/port/root/engine_dir/checkpoints）。这里只认路径那三个 —— 构造一个
#   模型对象不需要知道自己监听在哪。两边同名同义，别让它们分叉。
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


def _placeholder_values(profile):
    engine_dir = os.path.abspath(profile.get("dir") or ".")
    # engines/<id>/ 的上两级 = 项目根
    root = os.path.dirname(os.path.dirname(engine_dir))
    runtime = profile.get("runtime") or {}
    ckpt = runtime.get("checkpoints")
    # ⭐ engine_python：kind="cli" 的 argv 第一个词几乎总是「这台引擎自己的
    #   解释器」。名片里写 `runtime.python` 已经有了，⛔ 不该逼作者再抄一遍 ——
    #   抄两遍就会有一天只改了其中一遍，而且不报错。
    py = runtime.get("python")
    return {
        "root": root,
        "engine_dir": engine_dir,
        "engine_python": os.path.abspath(os.path.join(root, py)) if py else None,
        # 名片里 checkpoints 是相对项目根的，这里转成绝对路径再给上游 ——
        # 上游不该关心我们的目录约定。
        "checkpoints": os.path.abspath(os.path.join(root, ckpt)) if ckpt else None,
    }


def _expand_init_args(init_args, profile):
    """把 init_args 里的 {占位符} 换成真路径。

    ⛔ 不认识的占位符**当场抛**，不是原样留着 —— 原样留着会变成一个
      长得像路径的字符串传进上游，错误信息里再也看不出是名片写错了。
    """
    if not init_args:
        return {}
    values = _placeholder_values(profile)
    out = {}
    for key, raw in init_args.items():
        if not isinstance(raw, str):
            out[key] = raw
            continue
        missing = []

        def _sub(m):
            name = m.group(1)
            if name not in values or values[name] is None:
                missing.append(name)
                return m.group(0)
            return values[name]

        expanded = _PLACEHOLDER_RE.sub(_sub, raw)
        if missing:
            raise ValueError(
                "call.init_args.%s 里的占位符 %s 填不出来（认得的是：%s）"
                % (key, ", ".join("{%s}" % m for m in missing),
                   ", ".join("{%s}" % k for k in sorted(values))))
        out[key] = expanded
    return out


def _expand_word(raw, values, where):
    """把一个词里的 {占位符} 换成真路径。认不出来当场抛（同 init_args 的理由）。"""
    missing = []

    def _sub(m):
        name = m.group(1)
        if name not in values or values[name] is None:
            missing.append(name)
            return m.group(0)
        return values[name]

    out = _PLACEHOLDER_RE.sub(_sub, raw)
    if missing:
        raise ValueError(
            "%s 里的占位符 %s 填不出来（认得的是：%s）"
            % (where, ", ".join("{%s}" % m for m in missing),
               ", ".join("{%s}" % k for k in sorted(values))))
    return out


# ---------------------------------------------------------------------------
#  1.5) kind="cli"：一个参数 → 命令行上的 0..N 个词
# ---------------------------------------------------------------------------
#
# ⭐ 这一段是 `call.args` 那张表的**唯一**解释处，而且它必须穷举 —— 没有
#   「其余情况看着办」的分支。看着办 = 宿主替名片作者猜，猜错不报错，
#   只是那个开关没上命令行，声音悄悄变了。
def _render_cli_arg(name, entry, value):
    flag = entry["flag"]
    style = entry.get("style") or "value"

    if style == "boolean":
        # 真才出现；假就整个不出现（上游没有否定式可用）
        return [flag] if value else []

    if style == "boolean_optional":
        # argparse 的 BooleanOptionalAction：「不传」和「传 false」是两件事，
        # 所以这里两种都要出词，⛔ 不能把 false 当成「不传」。
        if flag.startswith("--"):
            return [flag] if value else ["--no-" + flag[2:]]
        raise ValueError(
            'call.args.%s.style = "boolean_optional" 需要长开关（--），现在是 %r'
            % (name, flag))

    if value is None:
        return []

    if style == "join":
        if not isinstance(value, (list, tuple)):
            raise ValueError(
                'call.args.%s.style = "join" 要一个数组，现在收到 %s'
                % (name, type(value).__name__))
        sep = entry.get("join") or ","
        return [flag, sep.join(str(v) for v in value)]

    if style == "repeat":
        if not isinstance(value, (list, tuple)):
            raise ValueError(
                'call.args.%s.style = "repeat" 要一个数组，现在收到 %s'
                % (name, type(value).__name__))
        out = []
        for v in value:
            out.extend([flag, str(v)])
        return out

    if style == "value":
        return [flag, str(value)]

    raise ValueError("call.args.%s.style 认不出来：%r" % (name, style))


def build_cli_argv(call, profile, slots, params):
    """拼出要执行的完整命令。

    slots  —— bind 槽位的实参：{"text": ..., "ref_audio": ..., "output_path": ...}
    params —— 引擎私有参数（call_time），键必须在 call.args 里有一条形状。

    ⛔ 抽成纯函数是有意的：不起进程、不装上游、没有 GPU 也能逐条测到
      —— 四种开关形状写错，是这条路上判别力最高的地方。
    """
    values = _placeholder_values(profile)
    argv = [_expand_word(w, values, "call.argv") for w in (call.get("argv") or [])]
    if not argv:
        raise ValueError('call.kind = "cli" 但 call.argv 是空的')

    bind = call.get("bind") or {}
    for slot in ("text", "ref_audio", "output_path"):
        flag = bind.get(slot)
        if not flag:
            continue
        val = slots.get(slot)
        if val is None:
            continue
        argv.extend([flag, str(val)])

    args_table = call.get("args") or {}
    for name in sorted(params):
        entry = args_table.get(name)
        if not entry:
            # ⛔ 静默丢弃是这条路上最容易犯、最难发现的错：参数在界面上
            #   调了、在请求里到了、在命令行上没有 —— 三处都不报错。
            raise ValueError(
                "参数 %r 没有在 call.args 里说明该变成哪个命令行开关 —— "
                "宿主不替名片猜（认得的有：%s）"
                % (name, ", ".join(sorted(args_table)) or "（一个都没写）"))
        argv.extend(_render_cli_arg(name, entry, params[name]))
    return argv


def _resolve_cwd(profile):
    """算出调用时该待在哪个目录（契约 §5.3 的 `call.cwd`）。

    ⭐ 上游代码里常有 `checkpoints/bpe.model` 这种相对 CWD 的硬编码，而且是
      **调用实参**不是默认值 —— 显式传参救不了，chdir 是唯一不改上游源码的解法。
    ⛔ 但**目录名由名片说了算，不由宿主推**（契约 §5.2「全部是名字，没有一行逻辑」）。
      曾经想过让宿主自己推 `dirname(checkpoints)` —— 那是 IndexTTS2 的巧合，
      焊进通用层就等着下一台引擎踩。推错了不报错，只是路径不对。

    写法两种，和 `runtime.checkpoints` 一个约定：
      - `{engine_dir}` / `{checkpoints}` / `{root}` 槽位（§5.3 的例子就是 `{engine_dir}`）
      - 或者一条**相对项目根**的路径，如 `models/tts/indextts2`
    没写 ⇒ 返回 None ⇒ 不 chdir，待在被拉起来的地方（诚实的默认值）。
    """
    raw = (profile.get("call") or {}).get("cwd")
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("call.cwd 得是一条非空路径，现在是 %r" % (raw,))

    values = _placeholder_values(profile)
    missing = []

    def _sub(m):
        name = m.group(1)
        if name not in values or values[name] is None:
            missing.append(name)
            return m.group(0)
        return values[name]

    expanded = _PLACEHOLDER_RE.sub(_sub, raw)
    if missing:
        raise ValueError(
            "call.cwd 里的占位符 %s 填不出来（认得的是：%s）"
            % (", ".join("{%s}" % m for m in missing),
               ", ".join("{%s}" % k for k in sorted(values))))

    if os.path.isabs(expanded):
        return os.path.normpath(expanded)
    return os.path.normpath(os.path.join(values["root"], expanded))


SEEDERS = {
    "python": _seed_python,
    "numpy": _seed_numpy,
    "torch": _seed_torch,
    "torch.cuda": _seed_torch_cuda,
}


class SeedPlan(object):
    """把名片里的 call.seed 变成一个可执行的计划。

    三态（契约 §5.2.1）：
      {"arg": "seed"}                 引擎自己收 —— 宿主把它塞进调用参数
      {"mode": "global", "rngs": [..]} 宿主播全局 RNG
      "none"                          不可复现 —— 宿主**显式拒收** seed
    """

    def __init__(self, spec):
        self.arg_name = None
        self.rngs = []
        self.mode = None

        if spec is None:
            # ⛔ 没写 = 今天的行为 = 静默忽略。契约 §5.2.1 要求必须写出来。
            raise ValueError(
                "call.seed 没写。契约 §5.2.1 要求它必须显式写出来："
                '{"arg":"<参数名>"} / {"mode":"global","rngs":[...]} / "none" —— '
                "不写会让「不支持」和「忘了写」长得一模一样，"
                "而后者今天的表现是静默忽略 seed。")

        if spec == "none":
            self.mode = "none"
            return

        if not isinstance(spec, dict):
            raise ValueError("call.seed 只能是 \"none\" 或一个对象，收到 %r" % (spec,))

        if "arg" in spec:
            self.mode = "arg"
            self.arg_name = spec["arg"]
            if not isinstance(self.arg_name, str) or not self.arg_name:
                raise ValueError("call.seed.arg 必须是非空字符串，收到 %r" % (self.arg_name,))
            return

        if spec.get("mode") == "global":
            self.mode = "global"
            self.rngs = list(spec.get("rngs") or [])
            if not self.rngs:
                raise ValueError(
                    'call.seed 写了 mode:"global" 却没列 rngs。'
                    "平台不得替你猜要播哪几个随机源 —— 猜错就是静默失效。")
            unknown = [r for r in self.rngs if r not in SEEDERS]
            if unknown:
                raise ValueError(
                    "call.seed.rngs 里有宿主不认识的随机源：%s（认识的是：%s）"
                    % (", ".join(unknown), ", ".join(sorted(SEEDERS))))
            # scope 是 MUST：播种改的是进程级全局状态
            if spec.get("scope") != "locked":
                raise ValueError(
                    'call.seed 的 scope 必须是 "locked"（契约 §5.2.1）。'
                    "播种改的是**进程级**全局状态，不在同一把锁内的并发请求"
                    "会互相冲掉对方刚播下的种子。")
            return

        raise ValueError("call.seed 认不出来：%r" % (spec,))

    def apply(self, seed):
        """播种。返回实际生效的 RNG 列表（进 meta，供取证）。"""
        if self.mode != "global":
            return None
        applied, failed = [], []
        for name in self.rngs:
            try:
                got = SEEDERS[name](seed)
            except Exception as exc:
                # ⭐ 照实记下来。名片列了却播不到 = 环境和名片对不上，
                #    该由 §6 第一道校验在注册时拦掉，不是运行时假装没事。
                failed.append("%s(%s)" % (name, exc.__class__.__name__))
                continue
            if got:
                applied.append(got)
        if failed:
            sys.stderr.write("%s SEED FAILED on: %s\n" % (BANNER, ", ".join(failed)))
        return {"applied": applied, "failed": failed}


# ---------------------------------------------------------------------------
#  2) 名片描述的那台引擎
# ---------------------------------------------------------------------------
class Engine(object):
    """持有一个已加载的上游模型。

    推理串行化：一块 GPU 上并发跑两个 infer 只会互相拖慢并可能 OOM，
    所以用一把锁把 /tts 排成队。ThreadingHTTPServer 仍然让 /health 在
    推理进行中可以立刻回答 —— 别人在等，但探活不能挂。
    """

    def __init__(self, profile):
        self.profile = profile
        self.call = profile["call"]
        self.kind = self.call.get("kind") or "python"
        self.seed_plan = SeedPlan(self.call.get("seed"))
        self.obj = None
        self.device = None
        self.ready = False
        self.error = None
        self.load_seconds = None
        self.infer_lock = threading.Lock()
        self.busy = False
        self.served = 0

    # -- 加载 ---------------------------------------------------------------
    def load(self):
        if self.kind == "cli":
            return self._load_cli()
        return self._load_python()

    def _load_cli(self):
        """cli 形态没有「加载」这一步 —— 每次请求起一个新进程。

        ⛔ 这里**不许**装出一副模型已驻留的样子：`/health` 上的 resident=False
          是给上层看的诚实读数。模型每次重载的代价由驻留策略去解决，
          不该靠宿主谎报。
        """
        t0 = time.time()
        try:
            argv = build_cli_argv(self.call, self.profile,
                                  {"text": "", "output_path": ""}, {})
            exe = argv[0]
            # 只验第一个词能不能找到 —— 这是「装没装对」最早能喊出来的时刻。
            if os.path.isabs(exe) and not os.path.exists(exe):
                raise RuntimeError("call.argv 第一个词指向的可执行文件不存在：%s" % exe)
            sys.stderr.write("%s cli: %s\n" % (BANNER, " ".join(argv)))
            self.load_seconds = round(time.time() - t0, 2)
            self.device = _guess_device()
            self.ready = True
            sys.stderr.write("%s ready (cli, per-request process)\n" % BANNER)
        except Exception:
            self.error = traceback.format_exc()
            self.load_seconds = round(time.time() - t0, 2)
            sys.stderr.write("%s LOAD FAILED\n%s\n" % (BANNER, self.error))

    def _load_python(self):
        t0 = time.time()
        try:
            module_name = self.call["module"]
            class_name = self.call["class"]
            mod = __import__(module_name, fromlist=[class_name])
            klass = getattr(mod, class_name)

            # 留个证据：装的到底是哪一份源码。搬家/装包出错时这一行最值钱。
            root_mod = sys.modules.get(module_name.split(".")[0])
            sys.stderr.write("%s %s.__file__ = %s\n" % (
                BANNER, module_name.split(".")[0],
                getattr(root_mod, "__file__", "?")))

            init_args = _expand_init_args(self.call.get("init_args"), self.profile)
            sys.stderr.write("%s constructing %s(%s)\n" % (
                BANNER, class_name, ", ".join(sorted(init_args))))
            self.obj = klass(**init_args)
            self.load_seconds = round(time.time() - t0, 2)
            self.device = _guess_device()
            self.ready = True
            sys.stderr.write("%s ready in %ss on %s\n"
                             % (BANNER, self.load_seconds, self.device))
        except Exception:
            self.error = traceback.format_exc()
            self.load_seconds = round(time.time() - t0, 2)
            sys.stderr.write("%s LOAD FAILED after %ss\n%s\n"
                             % (BANNER, self.load_seconds, self.error))

    # -- 合成 ---------------------------------------------------------------
    def synthesize(self, text, ref_audio_path, call_params, seed=None):
        """返回 (wav_bytes, meta)。"""
        if self.kind == "cli":
            return self._synthesize_cli(text, ref_audio_path, call_params, seed)
        return self._synthesize_python(text, ref_audio_path, call_params, seed)

    def _synthesize_cli(self, text, ref_audio_path, call_params, seed=None):
        returns = self.call.get("returns", "file")
        params = dict(call_params)
        if seed is not None and self.seed_plan.mode == "arg":
            params[self.seed_plan.arg_name] = seed
            seed_info = {"applied": ["engine:%s" % self.seed_plan.arg_name],
                         "failed": []}
        else:
            # ⛔ mode="global" 在 cli 形态下**播不到**：种子要播的是子进程里的
            #   全局 RNG，我们这个进程播了它也看不见。名片写了就当场喊，
            #   ⛔ 不许收下再默默无效。
            if seed is not None and self.seed_plan.mode == "global":
                raise RuntimeError(
                    'call.seed.mode = "global" 在 kind="cli" 下无效：种子要播的是'
                    "子进程里的随机源，这个进程播不到它。请给上游一个种子开关，"
                    'call.seed 写 {"mode":"arg", ...}。')
            seed_info = None

        out_path = None
        try:
            if returns == "file":
                fd, out_path = tempfile.mkstemp(prefix="host_", suffix=".wav")
                os.close(fd)
            argv = build_cli_argv(
                self.call, self.profile,
                {"text": text, "ref_audio": ref_audio_path,
                 "output_path": out_path},
                params)

            t0 = time.time()
            proc = subprocess.run(
                argv, cwd=_resolve_cwd(self.profile),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            elapsed = time.time() - t0

            tail = (proc.stderr or b"").decode("utf-8", "replace").strip()
            if proc.returncode != 0:
                # ⭐ 照抄子进程说的话。自己重写一遍错误信息 = 把最值钱的
                #   那几行冲掉，剩下一句「合成失败」。
                raise RuntimeError(
                    "%s 退出码 %d\n--- stderr（末尾 4000 字）---\n%s"
                    % (os.path.basename(argv[0]), proc.returncode, tail[-4000:]))

            if returns == "file":
                with open(out_path, "rb") as fh:
                    data = fh.read()
                if not data:
                    raise RuntimeError(
                        "命令退出码 0，却没往 %s 写出任何字节\n"
                        "--- stderr（末尾 4000 字）---\n%s" % (out_path, tail[-4000:]))
            else:
                data = proc.stdout or b""
                if not data:
                    raise RuntimeError(
                        'call.returns 写的是 "bytes"，但命令的 stdout 是空的\n'
                        "--- stderr（末尾 4000 字）---\n%s" % tail[-4000:])

            meta = _wav_meta(data)
            meta["seed_applied"] = (
                "+".join(seed_info["applied"])
                if seed_info and seed_info["applied"] else None)
            meta["infer_seconds"] = round(elapsed, 2)
            if meta.get("duration"):
                meta["rtf"] = round(elapsed / meta["duration"], 2)
            return data, meta
        finally:
            if out_path:
                try:
                    os.unlink(out_path)
                except OSError:
                    pass

    def _synthesize_python(self, text, ref_audio_path, call_params, seed=None):
        bind = self.call["bind"]
        returns = self.call.get("returns", "file")
        method = getattr(self.obj, self.call["method"])

        kwargs = dict(call_params)
        kwargs[bind["text"]] = text
        if bind.get("ref_audio"):
            kwargs[bind["ref_audio"]] = ref_audio_path

        out_path = None
        if returns == "file":
            fd, out_path = tempfile.mkstemp(prefix="host_", suffix=".wav")
            os.close(fd)
            kwargs[bind["output_path"]] = out_path

        seed_info = None
        try:
            if seed is not None:
                if self.seed_plan.mode == "arg":
                    kwargs[self.seed_plan.arg_name] = seed
                    seed_info = {"applied": ["engine:%s" % self.seed_plan.arg_name],
                                 "failed": []}
                else:
                    # ⭐ 必须在调用之前播，且在同一把锁内 —— 调用方已经持锁。
                    seed_info = self.seed_plan.apply(seed)

            t0 = time.time()
            result = method(**kwargs)
            elapsed = time.time() - t0

            if returns == "file":
                with open(out_path, "rb") as fh:
                    data = fh.read()
                if not data:
                    raise RuntimeError("%s wrote an empty file" % self.call["class"])
            else:
                data = result
                if not isinstance(data, (bytes, bytearray)):
                    raise RuntimeError(
                        'call.returns 写的是 "bytes"，但 %s.%s 返回的是 %s'
                        % (self.call["class"], self.call["method"],
                           type(data).__name__))
                data = bytes(data)

            meta = _wav_meta(data)
            # ⭐ 播了什么必须记下来。只播不记，就分不清「播了」和「以为播了」。
            meta["seed_applied"] = "+".join(seed_info["applied"]) if seed_info and seed_info["applied"] else None
            if seed_info and seed_info["failed"]:
                meta["seed_failed"] = seed_info["failed"]
            meta["infer_seconds"] = round(elapsed, 2)
            if meta.get("duration"):
                meta["rtf"] = round(elapsed / meta["duration"], 2)
            return data, meta
        finally:
            if out_path:
                try:
                    os.unlink(out_path)
                except OSError:
                    pass


def _guess_device():
    """尽力而为，拿不到就 unknown —— 这只是 /health 上的一行信息。"""
    try:
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "unknown"


def _wav_meta(data):
    """从 WAV 字节里读采样率/声道/时长。拼接侧关心这个 —— 采样率一致才拼得对。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            frames = w.getnframes()
            rate = w.getframerate()
            return {
                "bytes": len(data),
                "sample_rate": rate,
                "channels": w.getnchannels(),
                "sample_width": w.getsampwidth(),
                "duration": round(frames / float(rate), 3) if rate else None,
            }
    except Exception:
        return {"bytes": len(data)}


# ---------------------------------------------------------------------------
#  3) HTTP —— 这一段每台引擎逐字一样
# ---------------------------------------------------------------------------
STATE = {"engine": None, "profile": None}


class Handler(BaseHTTPRequestHandler):
    server_version = "AurivoxEngineHost/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # 默认那行 access log 会把每个请求打到 stderr，混在推理进度条里没法看。
        pass

    # -- helpers ------------------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # broker 端超时断开时会走到这里。推理已经白跑了，但进程不该死。
            pass

    def _fail(self, code, message, **extra):
        payload = {"detail": message}
        payload.update(extra)
        self._send(code, payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # -- routes -------------------------------------------------------------
    def do_GET(self):
        eng = STATE["engine"]
        prof = STATE["profile"]
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", "/"):
            self._send(200 if eng.ready else 503, {
                "ready": eng.ready,
                # ⭐ start.ps1 的轮询靠这个字段提早退出：failed=true 时
                #    继续等下去没有任何意义。
                "failed": bool(eng.error),
                "busy": eng.busy,
                "device": eng.device,
                "load_seconds": eng.load_seconds,
                # ⭐ 形态和「模型在不在显存里」是两个不同的问题，各占一个字段。
                #   cli 形态每次请求起一个新进程 ⇒ resident=False，⛔ 不许瞒着。
                "call_kind": eng.kind,
                "resident": eng.kind != "cli",
                "served": eng.served,
                "engine": prof["id"],
                "banner": BANNER,
                "seed_mode": eng.seed_plan.mode,
                "seed_rngs": eng.seed_plan.rngs or None,
                "error": eng.error,
                "scrubbed_paths": _DROPPED,
            })
            return
        self._fail(404, "unknown path: %s" % path)

    def do_POST(self):
        eng = STATE["engine"]
        prof = STATE["profile"]
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path != "/tts":
            self._fail(404, "unknown path: %s" % path)
            return

        if not eng.ready:
            # ⭐ 「还在加载」和「加载已经失败」必须分开说。两者都 not ready，
            #    但前者该继续等，后者等到天荒地老也不会好。
            if eng.error:
                self._fail(503,
                           "engine failed to load and will not recover; "
                           "restart the host after fixing the cause",
                           failed=True, load_seconds=eng.load_seconds,
                           error=eng.error)
            else:
                self._fail(503, "engine is still loading; poll /health until ready",
                           failed=False, load_seconds=eng.load_seconds)
            return

        try:
            body = self._read_json()
        except Exception as exc:
            self._fail(400, "request body is not valid JSON: %s" % exc)
            return

        err = validate_request(body, prof, eng.seed_plan)
        if err is not None:
            code, message, extra = err
            self._fail(code, message, **extra)
            return

        text = str(body["text"])
        ref = body.get("ref_audio_path")
        seed = int(body["seed"]) if body.get("seed") is not None else None
        call_time = set(prof["params"].get("call_time") or [])
        call_params = {k: body[k] for k in body if k in call_time}

        with eng.infer_lock:
            eng.busy = True
            try:
                data, meta = eng.synthesize(text, ref, call_params, seed=seed)
                eng.served += 1
            except Exception:
                tb = traceback.format_exc()
                sys.stderr.write("%s INFER FAILED\n%s\n" % (BANNER, tb))
                self._fail(500, "%s inference failed" % prof["id"], traceback=tb)
                return
            finally:
                eng.busy = False

        sys.stderr.write("%s served bytes=%s sr=%s dur=%ss infer=%ss rtf=%s seed=%s\n" % (
            BANNER, meta.get("bytes"), meta.get("sample_rate"), meta.get("duration"),
            meta.get("infer_seconds"), meta.get("rtf"), meta.get("seed_applied")))

        # ⭐ 直接返回 WAV 字节流 —— 模仿传输，不模仿词汇表。
        #    这一条是「lib/ 响应侧零改动」的全部理由。
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Engine", prof["id"])
        self.send_header("X-Sample-Rate", str(meta.get("sample_rate", "")))
        self.send_header("X-Infer-Seconds", str(meta.get("infer_seconds", "")))
        # ⭐ 让「seed 到底生效没有」在 HTTP 层可见。空值就是没生效。
        self.send_header("X-Seed-Applied", str(meta.get("seed_applied") or ""))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------------------
#  4) 请求校验 —— 抽成纯函数，才能不起进程就测
# ---------------------------------------------------------------------------
CORE_KEYS = frozenset({"text", "ref_audio_path", "seed", "format", "media_type"})


def validate_request(body, profile, seed_plan):
    """校验通过返回 None，否则返回 (状态码, 说明, 附加字段)。

    ⭐ 抽成纯函数是有意的：四类 400 是这份宿主里判别力最高的部分，
      它必须能在没有 GPU、没有上游包、不起 HTTP 服务的机器上被逐条测到。
    """
    load_time = set(profile["params"].get("load_time") or [])
    call_time = set(profile["params"].get("call_time") or [])
    formats = set(f.lower() for f in (profile.get("output_formats") or ["wav"]))
    # ⛔ 这里曾经写成 profile.get("capabilities", {}).get("requires_reference_audio")。
    #   `resolveEngineProfile()` 真出的那份里它是**扁平顶层**的，不在 capabilities 下
    #   ⇒ 那个读法在真名片上恒为 None ⇒ needs_ref 恒为 False ⇒
    #   「必须给参考音频」那道 400 **静默消失**（不报错、不告警，闸只是不存在了）。
    #   ⭐ 手写夹具测不出这种形状漂移 —— 见 tools/dev/probe_profile_contract.py。
    needs_ref = bool(profile.get("requires_reference_audio"))

    text = body.get("text")
    if not text or not str(text).strip():
        return 400, "'text' is required and must not be empty", {}

    ref = body.get("ref_audio_path")
    if needs_ref:
        if not ref:
            return 400, ("'ref_audio_path' is required (%s clones from a "
                         "reference clip)" % profile["id"]), {}
        if not os.path.isfile(ref):
            return 400, ("reference audio not found on the engine host: %s"
                         % ref), {}

    # ⛔ 未知键拦下不放行：拼错的参数名否则会被静默忽略，看起来像生效了。
    known = CORE_KEYS | call_time | load_time
    if seed_plan.arg_name:
        known = known | {seed_plan.arg_name}
    unknown = sorted(k for k in body if k not in known)
    if unknown:
        return 400, ("unknown parameter(s): %s — a mistyped name would otherwise "
                     "be silently ignored and look like it took effect"
                     % ", ".join(unknown)), {"unknown": unknown}

    # 加载期参数出现在调用里 = 调用方以为能热切，其实不能。
    in_call = sorted(k for k in body if k in load_time)
    if in_call:
        return 400, ("%s can only be set when the engine process starts, not per "
                     "request; restart the host with different flags instead"
                     % ", ".join(in_call)), {"load_time_only": in_call}

    # format / media_type：⛔ 别默默返回 wav 而让调用方以为拿到了它要的 mp3。
    for key in ("format", "media_type"):
        want = body.get(key)
        if want is not None and str(want).lower() not in formats:
            return 400, ("%s=%r is not supported by this engine; it only emits "
                         "%s. Transcoding belongs in the broker, not here."
                         % (key, want, "/".join(sorted(formats)))), \
                {"supported": sorted(formats)}

    seed = body.get("seed")
    if seed is not None:
        # ⭐⭐ 契约 §5.2.1：写了 "none" 就**显式拒收**，绝不收下扔掉。
        if seed_plan.mode == "none":
            return 400, ("this engine declares call.seed = \"none\": it cannot "
                         "reproduce a previous run, so the broker must not record "
                         "a seed for it. Accepting the seed and ignoring it would "
                         "put a seed in meta.json that never took effect."), \
                {"seed_mode": "none"}
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            return 400, "'seed' must be an integer, got %r" % (seed,), {}
        if seed < 0:
            # broker 的 resolveSeed 已经把 -1/空 解析成具体值了；还看到负数
            # 说明它没走那条路，此时静默随机会让 meta.json 记的 seed 失真。
            return 400, ("'seed' must be >= 0; the broker is expected to resolve "
                         "random seeds to a concrete value before calling, so that "
                         "meta.json records the seed that was actually used"), {}
    return None


# ---------------------------------------------------------------------------
#  5) 名片解析结果的形状检查
# ---------------------------------------------------------------------------
REQUIRED_TOP = ("id", "runtime", "call", "params")
REQUIRED_CALL_PY = ("module", "class", "method", "bind")
REQUIRED_CALL_CLI = ("argv", "bind")


def validate_profile(profile):
    """返回问题清单。⭐ 空清单才启动 —— 名片不全就别装出一副能跑的样子。"""
    problems = []
    for k in REQUIRED_TOP:
        if k not in profile:
            problems.append("缺 %s" % k)
    call = profile.get("call") or {}
    kind = call.get("kind") or "python"
    if kind not in ("python", "cli"):
        problems.append(
            "call.kind = %r —— 这份宿主实现的是 python / cli 两种形态"
            "（契约 §5.2、§5.3）。http 形态是分开的一条路。" % (kind,))
    else:
        required = REQUIRED_CALL_PY if kind == "python" else REQUIRED_CALL_CLI
        for k in required:
            if k not in call:
                problems.append("缺 call.%s" % k)
        if kind == "cli":
            argv = call.get("argv")
            if argv is not None and (not isinstance(argv, list) or not argv
                                     or not all(isinstance(w, str) and w for w in argv)):
                problems.append("call.argv 得是一个非空的字符串数组")
        bind = call.get("bind") or {}
        if "text" not in bind:
            problems.append("缺 call.bind.text —— 平台不知道该把正文放进哪个参数")
        if call.get("returns", "file") == "file" and "output_path" not in bind:
            problems.append(
                'call.returns 是 "file"，但没有 call.bind.output_path —— '
                "平台不知道该让引擎把音频写到哪里")
    try:
        SeedPlan(call.get("seed"))
    except ValueError as exc:
        problems.append(str(exc))
    return problems


# ---------------------------------------------------------------------------
#  6) main
# ---------------------------------------------------------------------------
def _arg(name, default=None):
    """--name=value 或 --name value 都认。"""
    pref = "--%s=" % name
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a.startswith(pref):
            return a[len(pref):]
        if a == "--%s" % name and i + 1 < len(argv):
            return argv[i + 1]
    return default


def load_profile(source):
    if source == "-":
        return json.loads(sys.stdin.read())
    with open(source, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def main():
    source = _arg("profile-json")
    if not source:
        sys.stderr.write(
            "%s FATAL: --profile-json <路径|-> 是必须的。\n"
            "  宿主**不读 manifest.json** —— 名片语义只有 lib/engines/profile.js\n"
            "  一个实现，写两遍迟早分叉。调试时用：\n"
            "    node tools/dev/emit_profile.cjs <引擎id> | python lib/engines/host.py --profile-json -\n"
            % BANNER)
        return 2

    try:
        profile = load_profile(source)
    except Exception as exc:
        sys.stderr.write("%s FATAL: 读不了解析结果 %s：%s\n" % (BANNER, source, exc))
        return 2

    problems = validate_profile(profile)
    if problems:
        sys.stderr.write("%s FATAL: 解析结果不完整，拒绝启动：\n" % BANNER)
        for p in problems:
            sys.stderr.write("   ⛔ %s\n" % p)
        return 2

    runtime = profile.get("runtime") or {}
    host = _arg("host", os.environ.get("ENGINE_HOST", "127.0.0.1"))
    port = int(_arg("port", os.environ.get("ENGINE_PORT", "0")) or 0)
    if not port:
        sys.stderr.write("%s FATAL: --port=<端口> 是必须的\n" % BANNER)
        return 2

    # 引擎源码目录进 sys.path（名片 runtime.verify.sys_path）
    # ⛔ 2026-08-27：这行注释一直是对的，代码却读的是 runtime.sys_path ——
    #   名片里没有那个键，于是永远 += []，最后死在 ModuleNotFoundError。
    #   ⭐ 用的是**校验块**的路径不是笔误：第一道校验（契约 §6）导入哪条路径，
    #     宿主就必须加载哪条路径 —— 不同就等于验的和跑的不是同一个模块。
    sys_path_decl = (runtime.get("verify") or {}).get("sys_path") or []
    for p in sys_path_decl:
        ap = os.path.abspath(p)
        if ap in sys.path:
            sys.path.remove(ap)
        sys.path.insert(0, ap)

    # ⭐ 上游代码里常有 `checkpoints/xxx` 这种相对 CWD 的硬编码，而且是
    #   **调用实参**不是默认值 —— 显式传参救不了。chdir 是唯一不改上游源码
    #   的解法。⛔ 只在这里定一次，之后进程不再改。
    #   ⛔ 读的是 **call.cwd**（契约 §5.3），不是 runtime.cwd。§9 把 runtime.cwd
    #     定义成「启动器从哪儿 spawn」，消费者是 launchPlan.js / start.ps1；
    #     同名不同义，混用会静默 chdir 到项目根，然后上游找不到 checkpoints/。
    try:
        cwd = _resolve_cwd(profile)
    except ValueError as exc:
        sys.stderr.write("%s FATAL: %s\n" % (BANNER, exc))
        return 2
    if cwd:
        if not os.path.isdir(cwd):
            sys.stderr.write(
                "%s FATAL: call.cwd 指向的目录不存在：%s\n"
                "%s        名片 %s 里写的是 %r\n"
                % (BANNER, cwd, BANNER, profile["id"],
                   (profile.get("call") or {}).get("cwd")))
            return 2
        os.chdir(cwd)

    sys.stderr.write("%s starting  engine=%s host=%s port=%s\n"
                     % (BANNER, profile["id"], host, port))
    # ⭐ 印实际值 + 印它是哪来的。判据/路径这类东西「可调但必须可见」，
    #   不然出了岔子只能靠猜是谁把目录挪了。
    sys.stderr.write("%s cwd=%s (%s)\n"
                     % (BANNER, os.getcwd(),
                        ("call.cwd=%r" % (profile.get("call") or {}).get("cwd"))
                        if cwd else "名片没写 call.cwd，沿用启动目录"))
    sys.stderr.write("%s python=%s\n" % (BANNER, sys.executable))
    sys.stderr.write("%s sys_path+=%s\n" % (BANNER, sys_path_decl))
    if _DROPPED:
        sys.stderr.write("%s scrubbed %d alien sys.path entr%s: %s\n"
                         % (BANNER, len(_DROPPED),
                            "y" if len(_DROPPED) == 1 else "ies", _DROPPED))

    engine = Engine(profile)
    STATE["engine"] = engine
    STATE["profile"] = profile
    sys.stderr.write("%s seed plan = %s %s\n"
                     % (BANNER, engine.seed_plan.mode, engine.seed_plan.rngs or ""))

    # ⭐ 先绑端口再加载模型：这样调用方一 spawn 就能连上 /health 拿到
    #   503 + load_seconds，知道「在起，别急」。反过来那段时间里探活是
    #   「连接被拒」，和「进程崩了」长得一模一样。
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    threading.Thread(target=engine.load,
                     name="%s-load" % profile["id"], daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        sys.stderr.write("%s shutting down\n" % BANNER)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
