# -*- coding: utf-8 -*-
"""probe_host_methods —— 一次请求一个方法（call.methods）

为什么单独一支探针
------------------
`probe_host.py` 用**单方法**名片（call.method）跑通了宿主的一切。但它验不到
「这次请求走的是哪个方法」——那张名片只有一个入口可走，**换参数也换不到
方法**。

⭐ 而多方法是真引擎的常态：CosyVoice2 有五个推理方法（sft / zero_shot /
cross_lingual / instruct2 / vc），IndexTTS2 有一个（infer）。它们要的输入
**互不相同**：sft 要 spk_id 不用参考音频，vc 要两个音频不用 text，
instruct2 要 instruct_text。平台若只认一个方法，用户传对了参数也换不到
方法，合成出**错的**声音还不报错。

⚠️ 这支探针用假引擎（只用标准库），所以它在本机、CI、无 GPU 的机器上都能
   跑完整套 —— 不靠「真 CosyVoice2 跑通了」这种一次性证据。

⭐ 它抓的是**平台自己的**错，不是引擎的错：方法选择、参数归属、别名绑定、
   未知方法拒收、单方法向后兼容。
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HOST_PY = os.path.join(ROOT, "lib", "engines", "host.py")
PY = sys.executable

ROWS = []


def row(name, ok, note=""):
    ROWS.append((name, ok, note))
    print("   %-6s %s%s" % ("ok" if ok else "FAIL", name,
                            ("   %s" % note) if note else ""))


def detail_of(raw):
    """⛔ 绝不能让「被测对象返回了意料之外的东西」把这支探针自己搞崩。"""
    try:
        return json.loads(raw.decode("utf-8")).get("detail", "")
    except Exception:
        return "<非 JSON 响应，%d 字节：%r…>" % (len(raw), raw[:16])


def guarded(section):
    def deco(fn):
        def run(*a, **kw):
            try:
                return fn(*a, **kw)
            except Exception as exc:
                row("⛔ [%s] 这一节自己抛异常了（探针缺陷，不是结论）" % section,
                    False, "%s: %s" % (type(exc).__name__, exc))
        return run
    return deco


# --------------------------------------------------------------- 假引擎
# ⭐ 五个方法**都真实存在**，而且各自把收到的参数写进 WAV 的注释块里。
#   宿主要「选对方法」就必然调到了它 —— 被调到的那个才有话说。
FAKE_ENGINE = u'''# -*- coding: utf-8 -*-
"""假引擎：五个推理方法，每一个都把自己的名字和收到的参数报出来。

⛔ 它不假装自己是任何真引擎。方法名刻意起成 upstream_zero_shot 这种
   无关的名字 —— 如果宿主的「方法选择」其实是硬编码成某个名字，这支探针
   会立刻红，而不是因为名字恰好对上而骗过自己。
"""
import json, os, struct, sys, wave

STAMP = {}


def _wav(stamp):
    # 在 WAV 后面挂一段 JSON 探针戳 —— 平台原样返回字节，我们从字节里读回
    # 「到底哪个方法被调了、拿到了什么参数」。
    payload = json.dumps(stamp, sort_keys=True).encode("utf-8")
    rate = 8000
    n = 400
    raw = b"\\x00\\x00" * n
    hdr = b"RIFF" + struct.pack("<I", 36 + len(raw) + len(payload)) + b"WAVE"
    hdr += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    hdr += b"data" + struct.pack("<I", len(raw)) + raw
    return hdr + payload


class MultiMethodTTS(object):
    def __init__(self, model_dir):
        if not os.path.isdir(model_dir):
            raise RuntimeError("model_dir 展开后不是一个存在的目录：%r" % model_dir)

    def _rec(self, method, kwargs, text, ref):
        return {"method": method, "text": text, "ref": ref,
                "kwargs": {k: (v if isinstance(v, (str, int, float, bool, type(None)))
                               else str(type(v).__name__))
                           for k, v in kwargs.items()}}

    def upstream_sft(self, tts_text, spk_id):
        return _wav(self._rec("upstream_sft", {"spk_id": spk_id}, tts_text, None))

    def upstream_zero_shot(self, tts_text, prompt_text, prompt_wav):
        return _wav(self._rec("upstream_zero_shot",
                              {"prompt_text": prompt_text}, tts_text, prompt_wav))

    def upstream_cross_lingual(self, tts_text, prompt_wav):
        return _wav(self._rec("upstream_cross_lingual", {}, tts_text, prompt_wav))

    def upstream_instruct2(self, tts_text, instruct_text, prompt_wav):
        return _wav(self._rec("upstream_instruct2",
                              {"instruct_text": instruct_text}, tts_text, prompt_wav))

    def upstream_vc(self, source_wav, prompt_wav):
        # ⭐ vc 不读 text —— 探针要能发现「宿主硬塞了一个空 text 进去」。
        return _wav(self._rec("upstream_vc", {}, None, None))

    # ⭐⭐ 签名上**必填**、但复用音色那条路上根本不用的那两个参数。
    #   真机上栽过：不给 ⇒ TypeError: missing 2 required positional arguments，
    #   而那条报错完全指不到「你该用 blank_when」——它看着像「你少填了参数」。
    def upstream_blank_needed(self, tts_text, prompt_text, prompt_wav, saved_spk=""):
        # ⭐ 上游自己会 assert「saved_spk 不能是空串」——所以这两个空串
        #   必须是**真给到了**，而不是压根没给。这正是 blank_when 的用途。
        assert prompt_text == "" and prompt_wav == "", (
            "blank_when 没生效：prompt_text=%r prompt_wav=%r"
            % (prompt_text, prompt_wav))
        assert saved_spk != "", "saved_spk 必须原样传下去"
        return _wav(self._rec("upstream_blank_needed",
                              {"saved_spk": saved_spk}, tts_text, None))
'''


# --------------------------------------------------------------- 名片
def make_manifest(tmp, multi=True):
    """⭐ multi=True 写 call.methods（多方法）；False 写 call.method（单方法，
    用来证明**向后兼容**：旧名片一个字不改也照跑）。"""
    call = {
        "kind": "python",
        "module": "fake_engine",
        "class": "MultiMethodTTS",
        # ⭐ 占位符只有 {checkpoints} / {engine_dir} / {engine_python} / {root}
        #   —— 没有 {model_dir}，用它会响亮地失败（好过默默传错路径）。
        "init_args": {"model_dir": "{checkpoints}"},
        "returns": "bytes",
        # ⭐ 契约 §5.2.1：种子必须显式写出来 —— 不写的话「不支持」和
        #   「忘了写」长得一模一样，而这个假引擎根本没用随机数。
        "seed": "none",
        # ⭐⭐ 2026-10-01：顶层 bind **必须带 ref_audio**（值随便，下面会被
        #   pop 掉 output_path 但保留这个键）。
        #
        #   为什么：真实的 cosyvoice-300m-sft 名片就是这样 ——
        #     顶层   bind = {text: tts_text, ref_audio: prompt_wav}
        #     sft    bind = {text: tts_text}          ← 故意**不写** ref_audio
        #   宿主 merge 之后仍带 ref_audio ⇒ 把参考音频塞进 kwargs ⇒ 上游
        #     TypeError: inference_sft() got an unexpected keyword
        #               argument 'prompt_wav'
        #
        #   ⚠️ 这个夹具原来顶层**只有 text** ⇒ 那个 bug 在它上面**不可复现**
        #   ⇒ 我第一版守卫断言写对了、20 条全绿，变异却抓不到（因为压根没
        #   触发）。夹具比现实简单 = 假绿，这跟 host.py:135 注释里记的是
        #   同一类病。
        "bind": {"text": "tts_text", "ref_audio": "prompt_wav"},
    }
    call["bind"].pop("output_path", None)
    if multi:
        call["methods"] = {
            "sft": {
                "method": "upstream_sft",
                # ⭐ 与 300m-sft 的真名片同形：**不写** ref_audio 键
                #   （原夹具写的是 ref_audio: None —— 那是「显式不要」，
                #   和「没提」不是一回事，恰好绕过了要测的那条路径）。
                "bind": {"text": "tts_text"},
                "requires_text": True,
                "requires_ref_audio": False,
                "call_time": ["spk_id"],
            },
            "zero_shot": {
                "method": "upstream_zero_shot",
                "bind": {"text": "tts_text", "ref_audio": "prompt_wav"},
                "requires_text": True,
                "requires_ref_audio": True,
                "call_time": ["prompt_text", "prompt_text"],
            },
            "cross_lingual": {
                "method": "upstream_cross_lingual",
                "bind": {"text": "tts_text", "ref_audio": "prompt_wav"},
                "requires_text": True,
                "requires_ref_audio": True,
                "call_time": [],
            },
            "instruct2": {
                "method": "upstream_instruct2",
                "bind": {"text": "tts_text", "ref_audio": "prompt_wav"},
                "requires_text": True,
                "requires_ref_audio": True,
                # ⭐ 假引擎的 upstream_instruct2(tts_text, instruct_text,
                #   prompt_wav) **没有** prompt_text 参数 —— 参考文本在它那里
                #   是 prompt_wav，不是 prompt_text。名片写错引擎名会得到
                #   TypeError（好过默默传错），但那是**探针自己**的错，不是平台的。
                "call_time": ["instruct_text"],
            },
            # ⭐ vc：不要 text，要两个音频。
            "vc": {
                "method": "upstream_vc",
                "bind": {"ref_audio": "prompt_wav"},
                "requires_text": False,
                "requires_ref_audio": True,
                "call_time": ["source_wav"],
            },
        }
        # ⭐⭐ 真机上栽过的两件事，在这里各有对应的一条：
        #   · 复用已存音色时**不要**参考音频 → ref_audio_optional_if
        #   · 签名必填但那条路不用的参数要**填空串** → blank_when
        call["methods"]["reuse"] = {
            "method": "upstream_blank_needed",
            "bind": {"text": "tts_text", "ref_audio": "prompt_wav"},
            "requires_text": True, "requires_ref_audio": True,
            "call_time": ["saved_spk"],
            "blank_when": {"prompt_text": "saved_spk", "ref_audio_path": "saved_spk"},
        }
        call["ref_audio_optional_if"] = ["saved_spk"]
        call["default_method"] = "zero_shot"
        # 单方法分支下 host.py 仍会读 call["bind"]["output_path"]，
        # 所以多方法这张也得有 —— returns=bytes 时其实用不到，但白名单要求。
        call["bind"]["output_path"] = "out_wav"
    else:
        call["method"] = "upstream_zero_shot"
        call["bind"].update({"ref_audio": "prompt_wav", "output_path": "out_wav"})

    return {
        "id": "fakemulti",
        "requires_reference_audio": True,
        "output_formats": ["wav"],
        "runtime": {
            # ⭐ runtime.python 是**字符串**（相对或绝对的解释器/venv 路径）。
            #   写成 {"kind":...,"bin":...} 会让宿主拿 dict 去 os.path.join
            #   ⇒ TypeError，报错还完全指不到名片 —— 这是我探针自己踩的。
            "python": PY,
            "entry": "host.py",
            "args": [],
            "cwd": tmp,
            "checkpoints": os.path.join(tmp, "models"),
            # ⭐ 假引擎就住在临时目录里 —— 必须让它进 sys_path，否则宿主
            #   import 不到（⛔ 宿主不把 cwd 塞进 sys_path，这是对的）。
            "verify": {"imports": [], "sys_path": [tmp]},
        },
        "call": call,
        "params": {"load_time": [], "call_time": ["spk_id", "prompt_text",
                                                  "instruct_text", "source_wav"]},
    }


def start_host(profile_dir, profile, port):
    env = dict(os.environ)
    for k in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
        env.pop(k, None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.Popen(
        [PY, HOST_PY, "--profile-json", os.path.join(profile_dir, "profile.json"),
         "--host", "127.0.0.1", "--port", str(port)],
        cwd=profile_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    t0 = time.time()
    while time.time() - t0 < 60:
        if proc.poll() is not None:
            return None, base, "引擎进程退出 rc=%s" % proc.returncode
        try:
            with urllib.request.urlopen(base + "/health", timeout=4) as resp:
                if resp.status == 200:
                    return proc, base, ""
        except urllib.error.HTTPError:
            pass          # 503 = 还在加载，正常
        except Exception:
            time.sleep(0.4)
    return None, base, "60 秒未 ready"


def post(base, payload):
    req = urllib.request.Request(
        base + "/tts", data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def stamp_of(raw):
    """从 WAV 尾巴上把假引擎的探针戳读回来。

    ⚠️ 2026-09-30 踩过：戳的 JSON 里 key 是按字典序排的（sort_keys=True），
       所以 **kwargs 一定排在最前面**。用 `rindex(b"{")` 会撞上内层的
       「{"instruct_text": …}」⇒ 解出半个 JSON ⇒ 实到 None。
       —— 9 条 FAIL 全是这个读取器的锅，不是宿主的。
    """
    try:
        tail = raw[raw.rindex(b"WAVfmt "):] if False else raw
        # 从头找第一个完整的 JSON 对象：{'method': …，keys 已排序 ⇒ 以 "method" 开头
        start = raw.index(b'{"kwargs"') if b'{"kwargs"' in raw else raw.index(b'{"method"')
        return json.loads(raw[start:].decode("utf-8"))
    except Exception:
        return {}


def probe_multi(port):
    tmp = tempfile.mkdtemp(prefix="probeing_")
    try:
        with io.open(os.path.join(tmp, "fake_engine.py"), "w", encoding="utf-8") as f:
            f.write(FAKE_ENGINE)
        model_dir = os.path.join(tmp, "models")
        os.makedirs(model_dir)
        prof = make_manifest(tmp, multi=True)
        with io.open(os.path.join(tmp, "profile.json"), "w", encoding="utf-8") as f:
            json.dump(prof, f, ensure_ascii=False)

        proc, base, err = start_host(tmp, prof, port)
        if proc is None:
            row("多方法：起得来吗", False, err)
            return

        ref = os.path.join(tmp, "ref.wav")
        with open(ref, "wb") as f:
            f.write(_tiny_wav())

        try:
            # --- 默认方法（不带 method）---------------------------------
            st, raw = post(base, {"text": "今天天气不错。", "ref_audio_path": ref,
                                  "prompt_text": "参考文本"})
            s = stamp_of(raw)
            row("不带 method ⇒ 走 default_method",
                st == 200 and s.get("method") == "upstream_zero_shot",
                "HTTP %s 实到 %s" % (st, s.get("method")))

            # --- 逐个方法 ---------------------------------------------
            cases = [
                ("sft", {"text": "你好。", "spk_id": "中文女"},
                 "upstream_sft", {}),
                ("cross_lingual", {"text": "Hello.", "ref_audio_path": ref},
                 "upstream_cross_lingual", {}),
                ("instruct2", {"text": "你好。", "ref_audio_path": ref,
                               "instruct_text": "用四川话说"},
                 "upstream_instruct2", {}),
                ("vc", {"source_wav": ref, "ref_audio_path": ref},
                 "upstream_vc", {}),
            ]
            for mname, payload, expect_method, _ in cases:
                payload = dict(payload)
                payload["method"] = mname
                st, raw = post(base, payload)
                s = stamp_of(raw)
                row("method=%s ⇒ 真到 %s" % (mname, expect_method),
                    st == 200 and s.get("method") == expect_method,
                    "HTTP %s 实到 %s" % (st, s.get("method")))

            # --- 方法级参数真的传下去了吗 -------------------------------
            st, raw = post(base, {"method": "instruct2", "text": "你好。",
                                  "ref_audio_path": ref,
                                  "instruct_text": "用四川话说"})
            s = stamp_of(raw)
            kw = s.get("kwargs") or {}
            row("instruct2 的 instruct_text 真的到了上游",
                kw.get("instruct_text") == "用四川话说", "kwargs=%s" % kw)

            st, raw = post(base, {"method": "sft", "text": "你好。", "spk_id": "中文女"})
            s = stamp_of(raw)
            kw = s.get("kwargs") or {}
            row("sft 的 spk_id 真的到了上游",
                kw.get("spk_id") == "中文女", "kwargs=%s" % kw)

            # --- ⭐ vc 不该收到一个空 text ------------------------------
            st, raw = post(base, {"method": "vc", "source_wav": ref,
                                  "ref_audio_path": ref})
            s = stamp_of(raw)
            row("vc 不给 text 也能跑（不被「text 不能为空」误杀）",
                st == 200 and s.get("method") == "upstream_vc", "HTTP %s" % st)
            row("⭐ vc 没被硬塞一个空 text 进去",
                "tts_text" not in (s.get("kwargs") or {}),
                "kwargs=%s" % (s.get("kwargs"),))

            # --- ⭐ sft 不该被要求给参考音频 ------------------------------
            st, raw = post(base, {"method": "sft", "text": "你好。", "spk_id": "x"})
            row("⭐ sft 不用给参考音频（不被全局要求误杀）", st == 200, "HTTP %s" % st)

            # ⛔⛔ 这条请求**故意带上** ref_audio_path。理由：sft 不需要参考音频，
            #   但界面上参考音频那一栏是**公共的**（用户可能刚选了一个），
            #   请求里就会多带这一个键。宿主必须**按方法裁掉**它 ——
            #   2026-10-01 真机上正是这样炸的：
            #     TypeError: inference_sft() got an unexpected keyword
            #               argument 'prompt_wav'
            #   ⚠️ 上面那条不带 ref 的请求**测不到这个 bug**（不带就没有可裁的），
            #   第一版守卫就栽在这儿：断言写对了，请求却不会触发它。
            st, raw = post(base, {"method": "sft", "text": "你好。",
                                  "spk_id": "x", "ref_audio_path": ref})
            _s = stamp_of(raw)
            _kw = _s.get("kwargs") or {}
            # ⚠️ 判据是「kwargs **恰好**是 {spk_id}」，不是「里面没有
            #   prompt_wav」。后者在 kwargs 变成 {} 时也会绿 —— 那是我第一版
            #   写错的（变异测试立刻暴露：kwargs={} 时第一条仍然 ok）。
            #   「恰好相等」才同时盯住两件事：多传了会红、漏传了也会红。
            row("⭐⭐ sft 的 kwargs **恰好**只有 spk_id（参考音频被裁掉、"
                "该传的没漏）",
                _kw == {"spk_id": "x"}, "kwargs=%s" % (_kw,))

            # ⭐⭐ 2026-10-01 真机抓到（cosyvoice-300m-sft 的 sft）：上面那条
            #   只看 HTTP 200，**没看 kwargs 里有什么** ⇒ 一个真 bug 从它
            #   底下过去了 ——
            #     sft 声明 requires_ref_audio=False（用内置音色），而顶层
            #     bind 有 ref_audio ⇒ merge 之后仍在 ⇒ 宿主把参考音频塞进
            #     kwargs ⇒ 上游报
            #       TypeError: inference_sft() got an unexpected keyword
            #                 argument 'prompt_wav'
            #   夹具这边同样是 sft.bind={text} + 顶层 bind 带 ref_audio，
            #   所以**这个 bug 在夹具上本来就可复现**，只是没人断言 kwargs。
            #   ⚠ 判据是「kwargs 里不该有那个键」，不是「HTTP 200」——
            #     200 只说明上游没抱怨，不说明我们没多发东西。
            # --- ⭐ blank_when：签名必填但那条路不用的参数要拿到空串 ------
            st, raw = post(base, {"method": "reuse", "text": "你好。",
                                  "saved_spk": "my_spk"})
            row("⭐ blank_when 生效（假引擎里 assert 过那两个空串）",
                st == 200 and stamp_of(raw).get("method") == "upstream_blank_needed",
                "HTTP %s %s" % (st, raw[:60]))
            row("⭐ ref_audio_optional_if 生效（复用音色不必给参考音频）",
                st == 200, "HTTP %s" % st)

            # ⛔ 触发参数不在 ⇒ 不许填空串（那会把上游的参数悄悄清掉）
            st, raw = post(base, {"method": "reuse", "text": "你好。"})
            row("⛔ 没给触发参数就不填（不偷偷清掉用户的参数）", st == 400,
                "HTTP %s" % st)

            # --- 未知方法要拒 -------------------------------------------
            st, raw = post(base, {"method": "nonexistent", "text": "x",
                                  "ref_audio_path": ref})
            row("未知 method ⇒ 400（不是静默走默认）", st == 400,
                "HTTP %s %s" % (st, detail_of(raw)[:90]))

            # --- 方法级要求真的覆盖全局 ---------------------------------
            st, raw = post(base, {"method": "cross_lingual", "text": "hi",
                                  "ref_audio_path": ref, "prompt_text": "不该出现"})
            row("只属于别的方法的参数 ⇒ 400（不会悄悄带过去）", st == 400,
                "HTTP %s %s" % (st, detail_of(raw)[:90]))

            # --- 缺参考音频仍要拦 ---------------------------------------
            st, raw = post(base, {"method": "zero_shot", "text": "hi"})
            row("zero_shot 缺参考音频 ⇒ 400", st == 400,
                "HTTP %s %s" % (st, detail_of(raw)[:90]))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def probe_single_backcompat(port):
    """⭐ 向后兼容：旧名片（call.method 单数）一个字不改，行为必须一模一样。"""
    tmp = tempfile.mkdtemp(prefix="probesingle_")
    try:
        with io.open(os.path.join(tmp, "fake_engine.py"), "w", encoding="utf-8") as f:
            f.write(FAKE_ENGINE)
        os.makedirs(os.path.join(tmp, "models"))
        prof = make_manifest(tmp, multi=False)
        with io.open(os.path.join(tmp, "profile.json"), "w", encoding="utf-8") as f:
            json.dump(prof, f, ensure_ascii=False)
        proc, base, err = start_host(tmp, prof, port)
        if proc is None:
            row("单方法旧名片还能跑", False, err)
            return
        ref = os.path.join(tmp, "ref.wav")
        with open(ref, "wb") as f:
            f.write(_tiny_wav())
        try:
            st, raw = post(base, {"text": "今天天气不错。", "ref_audio_path": ref,
                                  "prompt_text": "参考"})
            s = stamp_of(raw)
            row("旧名片 call.method 不带 methods 也照跑",
                st == 200 and s.get("method") == "upstream_zero_shot",
                "HTTP %s 实到 %s" % (st, s.get("method")))
            # ⭐ 旧名片上请求带 method（哪怕等于它）也不该炸 —— 同一份请求
            #   要能同时跑新旧两种名片。
            st, raw = post(base, {"method": "upstream_zero_shot", "text": "x",
                                  "ref_audio_path": ref, "prompt_text": "参考"})
            row("旧名片上带 method（= 它自己）不炸", st == 200, "HTTP %s" % st)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _tiny_wav():
    import struct
    rate, n = 8000, 400
    raw = b"\x00\x00" * n
    return (b"RIFF" + struct.pack("<I", 36 + len(raw)) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", len(raw)) + raw)


def base_port():
    """借一个空闲端口 ⛔ 写死会撞上正在跑的引擎。"""
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@guarded("多方法")
def main():
    print("== 多方法：一次请求一个方法 ==")
    probe_multi(base_port())


@guarded("向后兼容")
def main2():
    print("== 单方法旧名片：向后兼容 ==")
    probe_single_backcompat(base_port())


if __name__ == "__main__":
    main()
    main2()
    bad = [r for r in ROWS if not r[1]]
    print("\n== %d 条，%d FAIL ==" % (len(ROWS), len(bad)))
    sys.exit(1 if bad else 0)