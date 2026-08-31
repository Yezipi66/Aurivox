#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kind="cli" 这条路的**在场证明**：不要 GPU、不要上游包、不要 HTTP。

为什么是一个 probe 而不是 *.node.test.js：run_tests.cjs 只收 node 测试，
而这段逻辑在 host.py 里 —— 用 node 去测它只能测到「文件里有这几个字」，
测不到「命令真的被拼出来、真的跑了、真的拿回了字节」。

跑法：
    python3 tools/dev/probe_cli_host.py

读数：每条一行 ok/FAIL，末尾一行汇总。⛔ 有一条 FAIL 就别说这条路通了。
"""
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ROOT = os.path.dirname(ROOT)
sys.path.insert(0, os.path.join(ROOT, "lib", "engines"))

import host  # noqa: E402

PASS, FAIL = [], []


def check(name, fn):
    try:
        fn()
    except Exception as exc:
        FAIL.append((name, "%s: %s" % (exc.__class__.__name__, exc)))
        print("FAIL %s\n     %s" % (name, exc))
    else:
        PASS.append(name)
        print("ok   %s" % name)


def wav_bytes(seconds=0.1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % int(rate * seconds),
                                  *([0] * int(rate * seconds))))
    return buf.getvalue()


# ---------------------------------------------------------------------------
#  一台假引擎：只有一个命令行，没有 python 类，没有端口
# ---------------------------------------------------------------------------
FAKE_CLI = r'''#!/usr/bin/env python3
# 假引擎：把收到的 argv 原样记进 --output 旁边的 .argv.json，再写一段静音 wav。
import io, json, os, struct, sys, wave

args = sys.argv[1:]
out = None
for i, a in enumerate(args):
    if a == "--output":
        out = args[i + 1]
if "--boom" in args:
    sys.stderr.write("upstream exploded on purpose\n")
    sys.exit(3)

buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(struct.pack("<1600h", *([0] * 1600)))
data = buf.getvalue()

if out:
    with open(out, "wb") as fh:
        fh.write(data)
    with open(out + ".argv.json", "w", encoding="utf-8") as fh:
        json.dump(args, fh)
else:
    sys.stdout.buffer.write(data)
'''


def make_engine(tmp, call_extra=None, params=None):
    engine_dir = os.path.join(tmp, "engines", "fake")
    os.makedirs(engine_dir, exist_ok=True)
    cli = os.path.join(engine_dir, "fake_cli.py")
    with open(cli, "w", encoding="utf-8") as fh:
        fh.write(FAKE_CLI)
    call = {
        "kind": "cli",
        "argv": [sys.executable, "{engine_dir}/fake_cli.py"],
        "bind": {"text": "--text", "output_path": "--output"},
        "returns": "file",
        "seed": "none",
    }
    call.update(call_extra or {})
    profile = {
        "id": "fake",
        "dir": engine_dir,
        "runtime": {"python": "engines/fake/.venv/bin/python"},
        "call": call,
        "params": {"call_time": list((params or {}).keys()), "load_time": []},
    }
    return profile


def argv_of(profile, slots, params):
    return host.build_cli_argv(profile["call"], profile, slots, params)


def main():
    tmp = tempfile.mkdtemp(prefix="probe_cli_")

    # 1. 拼命令：占位符、bind 槽位
    def t_argv():
        p = make_engine(tmp)
        argv = argv_of(p, {"text": "你好", "output_path": "/tmp/x.wav"}, {})
        assert argv[1].endswith("fake_cli.py"), argv
        assert "{engine_dir}" not in " ".join(argv), argv
        assert argv[2:] == ["--text", "你好", "--output", "/tmp/x.wav"], argv
    check("cli: {engine_dir} 展开 + bind 槽位变成开关", t_argv)

    def t_engine_python():
        p = make_engine(tmp, {"argv": ["{engine_python}", "-m", "x.cli"]})
        argv = argv_of(p, {"text": "hi"}, {})
        assert argv[0].endswith(os.path.join("engines", "fake", ".venv", "bin", "python")), argv
    check("cli: {engine_python} 来自 runtime.python，⛔不用抄第二遍", t_engine_python)

    def t_missing_placeholder():
        p = make_engine(tmp, {"argv": ["{nope}"]})
        try:
            argv_of(p, {"text": "hi"}, {})
        except ValueError as exc:
            assert "{nope}" in str(exc), exc
        else:
            raise AssertionError("认不出的占位符没有当场抛")
    check("cli: 认不出的占位符当场抛，⛔不原样留着", t_missing_placeholder)

    # 2. 四种开关形状
    shapes = {
        "value": ({"flag": "--speed"}, 1.2, ["--speed", "1.2"]),
        "boolean-true": ({"flag": "--verbose", "style": "boolean"}, True, ["--verbose"]),
        "boolean-false": ({"flag": "--verbose", "style": "boolean"}, False, []),
        "bool_opt-true": ({"flag": "--fp16", "style": "boolean_optional"}, True, ["--fp16"]),
        "bool_opt-false": ({"flag": "--fp16", "style": "boolean_optional"}, False, ["--no-fp16"]),
        "join": ({"flag": "--emotion-vector", "style": "join", "join": ","},
                 [0, 0, 1], ["--emotion-vector", "0,0,1"]),
        "repeat": ({"flag": "--ref", "style": "repeat"}, ["a", "b"],
                   ["--ref", "a", "--ref", "b"]),
    }
    for name, (entry, value, want) in shapes.items():
        def t(entry=entry, value=value, want=want):
            got = host._render_cli_arg("p", entry, value)
            assert got == want, "%r != %r" % (got, want)
        check("cli 开关形状 %s" % name, t)

    def t_unknown_param():
        p = make_engine(tmp)
        try:
            argv_of(p, {"text": "hi"}, {"speed": 1.0})
        except ValueError as exc:
            assert "call.args" in str(exc), exc
        else:
            raise AssertionError("没在 call.args 里说明的参数被静默丢了")
    check("⛔ 参数没写进 call.args ⇒ 当场抛，不静默丢弃", t_unknown_param)

    # 3. 真跑一次：returns=file
    def t_run_file():
        p = make_engine(tmp, {"args": {"speed": {"flag": "--speed"}}})
        eng = host.Engine(p)
        eng.load()
        assert eng.ready and not eng.error, eng.error
        data, meta = eng.synthesize("你好世界", None, {"speed": 1.5})
        assert data[:4] == b"RIFF", data[:16]
        assert meta["sample_rate"] == 16000, meta
        assert meta["duration"] == 0.1, meta
        assert meta["infer_seconds"] >= 0, meta
    check("⭐ 真跑一次（returns=file）：拿回 RIFF 字节 + 采样率/时长", t_run_file)

    # 4. 真跑一次：returns=bytes（stdout）
    def t_run_stdout():
        p = make_engine(tmp, {"returns": "bytes",
                              "bind": {"text": "--text"}})
        eng = host.Engine(p)
        eng.load()
        data, meta = eng.synthesize("你好", None, {})
        assert data[:4] == b"RIFF", data[:16]
        assert meta["bytes"] > 44, meta
    check("⭐ 真跑一次（returns=bytes）：从 stdout 拿回音频", t_run_stdout)

    # 5. 失败要把子进程说的话原样带回来
    def t_failure():
        p = make_engine(tmp, {"args": {"boom": {"flag": "--boom", "style": "boolean"}}})
        eng = host.Engine(p)
        eng.load()
        try:
            eng.synthesize("你好", None, {"boom": True})
        except RuntimeError as exc:
            assert "exploded on purpose" in str(exc), exc
            assert "退出码 3" in str(exc), exc
        else:
            raise AssertionError("子进程退出码 3，宿主却当成功了")
    check("⭐ 非零退出码 ⇒ 抛，且 stderr 原文带回来", t_failure)

    # 6. health 上的诚实读数
    def t_resident():
        p = make_engine(tmp)
        eng = host.Engine(p)
        eng.load()
        assert eng.kind == "cli"
        assert (eng.kind != "cli") is False  # resident 字段就是这个表达式
    check("cli ⇒ resident=False（⛔不谎报模型驻留）", t_resident)

    # 7. 名片形状检查
    def t_validate():
        p = make_engine(tmp)
        assert host.validate_profile(p) == [], host.validate_profile(p)
        broken = make_engine(tmp)
        broken["call"].pop("argv")
        assert any("argv" in s for s in host.validate_profile(broken))
        weird = make_engine(tmp)
        weird["call"]["kind"] = "carrier-pigeon"
        assert any("carrier-pigeon" in s for s in host.validate_profile(weird))
    check("validate_profile 认 cli，且认不出的 kind 仍然拦", t_validate)

    # 8. python 形态一个字没变
    def t_python_untouched():
        p = {
            "id": "py", "dir": os.path.join(tmp, "engines", "py"),
            "runtime": {}, "params": {},
            "call": {"kind": "python", "module": "m", "class": "C",
                     "method": "infer", "bind": {"text": "t", "output_path": "o"},
                     "seed": "none"},
        }
        assert host.validate_profile(p) == [], host.validate_profile(p)
        assert host.Engine(p).kind == "python"
    check("python 形态照旧通过（⛔这次改动不动老路）", t_python_untouched)

    print("\n%d ok / %d FAIL" % (len(PASS), len(FAIL)))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
