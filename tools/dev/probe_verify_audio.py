#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""C1 探针的实测台：起一个**行为已知**的假宿主，看 verify_audio.py 判得对不对。

⛔ 为什么不写在 node --test 里：那些要起 HTTP 服务、要 spawn python，
   塞进 npm test 会让 1675 条测试里多两条慢的、且依赖 python 在 PATH 上。
   ⇒ 这一份是**按需跑的取证脚本**（tools/dev/），守卫在
   lib/engines/verifyAudio.node.test.js（纯函数那一层）。
"""
import io
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE = os.path.join(ROOT, "lib", "engines", "verify_audio.py")

PORT_BASE = 19960  # ⭐ 每次换端口：TCPServer 关闭有延迟，同端口连上前一个会「连不上」


def make_handler(health_body, health_status, post_status, post_body,
                 no_text_validation=False):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, payload, ctype="application/json"):
            b = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def do_GET(self):
            if self.path.rstrip("/") in ("/health", ""):
                self._send(health_status, health_body)
            else:
                self._send(404, {"error": "unknown"})

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {}
            if no_text_validation:
                # ⭐ 这个宿主**根本不验** —— 缺 text 也放行。
                #   B 级必须抓它：那种宿主会让拼错的参数静默生效。
                self._send(200, b"RIFF....WAVEfmt ", "audio/wav")
                return
            if "text" not in body:
                self._send(post_status, post_body)
            else:
                self._send(200, b"RIFF....WAVEfmt ", "audio/wav")
    return H


_case_no = [0]


def run_case(name, expect_ok, **kw):
    _case_no[0] += 1
    port = PORT_BASE + _case_no[0]
    srv = socketserver.TCPServer(("127.0.0.1", port), make_handler(**kw))
    srv.allow_reuse_address = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    spec = {"level": "B", "base_url": "http://127.0.0.1:%d" % port, "ready_timeout": 5}
    f = os.path.join(os.environ.get("TEMP", "."), "c1spec.json")
    with open(f, "w") as fh:
        json.dump(spec, fh)
    r = subprocess.run([sys.executable, PROBE, "--spec-file", f],
                       capture_output=True, text=True)
    srv.shutdown()
    try:
        out = json.loads(r.stdout)
    except Exception:
        print("  %-46s 💥 探针输出不是 JSON: %r" % (name, r.stdout[:120]))
        return False
    got = bool(out.get("ok"))
    good = (got == expect_ok)
    # ⭐ 额外要求：失败时必须**说清是哪一步**。一个「连不上」不算抓到了契约问题。
    if not expect_ok and got is False:
        stage = out.get("stage")
        want_stage = kw.pop("_want_stage", None) if False else None
        good = good and (stage is not None)
    print("  %-46s %s  期望 ok=%-5s 实得 ok=%-5s  %s" % (
        name, "✅" if good else "⛔", expect_ok, got,
        "%s: %s" % (out.get("stage"), (out.get("error") or "")[:50])))
    return good


def main():
    print("\nC1 · B 级判别力实测（假宿主，行为已知）\n")
    ok = True
    healthy = dict(health_body={"ready": True, "call_kind": "python",
                                "resident": True, "device": "cuda"},
                   health_status=200, post_status=400,
                   post_body={"error": "'text' is required and must not be empty"})

    ok &= run_case("健康的宿主 ⇒ 该过", True, **healthy)
    ok &= run_case("宿主不验参数（缺 text 也放行）⇒ 必须抓",
                   False, no_text_validation=True,
                   health_body=healthy["health_body"],
                   health_status=healthy["health_status"],
                   post_status=healthy["post_status"],
                   post_body=healthy["post_body"])
    ok &= run_case("加载失败（failed=true）⇒ 必须抓",
                   False, health_body={"ready": False, "failed": True,
                                       "error": "CUDA out of memory"},
                   health_status=503, post_status=400,
                   post_body={"error": "x"})
    ok &= run_case("还在加载（failed 缺省）⇒ 必须抓",
                   False, health_body={"ready": False}, health_status=503,
                   post_status=400, post_body={"error": "x"})
    ok &= run_case("缺 text 的 400 没点名 text ⇒ 必须抓",
                   False, health_body={"ready": True, "call_kind": "python",
                                       "resident": True},
                   health_status=200, post_status=400,
                   post_body={"error": "bad request"})
    ok &= run_case("缺 text 返回 500（宿主自己炸了）⇒ 必须抓",
                   False, **dict(healthy, post_status=500,
                                 post_body={"error": "boom"}))
    # 连不上：不起服务，直接指向一个没人听的端口
    import socketserver as _ss
    try:
        _sock = _ss.socket.socket()
    except Exception:
        pass
    spec = {"level": "B", "base_url": "http://127.0.0.1:1", "ready_timeout": 3}
    f = os.path.join(os.environ.get("TEMP", "."), "c1spec2.json")
    with open(f, "w") as fh:
        json.dump(spec, fh)
    r = subprocess.run([sys.executable, PROBE, "--spec-file", f],
                       capture_output=True, text=True)
    out = json.loads(r.stdout)
    good = (out.get("ok") is False and out.get("stage") == "health")
    ok &= good
    print("  %-46s %s  stage=%s  %s" % (
        "连不上 ⇒ 必须抓", "✅" if good else "⛔", out.get("stage"),
        str(out.get("error"))[:50]))

    print("\n结论:", "全部符合预期" if ok else "有判别力问题")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
