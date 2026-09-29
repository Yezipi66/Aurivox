# -*- coding: utf-8 -*-
"""
stdio 传输层：把引擎宿主变成平台的**子进程**，走 stdin/stdout 传 HTTP/1.1。

================================================================================
 为什么是 stdio（Owner 2026-09-29 裁决：不留命名管道那套）
================================================================================
 端口数：100 台引擎 ⇒ **0 个端口**（只剩 broker 自己的 9886）。

 ⭐ 平台差异：**零**。
    `subprocess` + `pipe` 在 Windows / macOS / Linux 是同一个 API，
    而命名管道那套要 ctypes 调 Win32、POSIX 要 AF_UNIX，两条路两套语义。

 ⭐ 踩过的坑（命名管道那套，2026-09-29 实测，删掉前留档）：
    1. Windows 命名管道**半双工**：客户端一关写端，对端 WriteFile 就失败
       ⇒ 症状「响应头到了、body 截断」，长得像网络抖动。
    2. CreateNamedPipe 的 nMaxInstances 是**系统总配额**，不是「每次能建几个」。
       自己预建 N 个 = 配额被自己吃干 ⇒ 第 N+1 个请求连不上。
    3. `http.request` **静默忽略** `createConnection`（那是 net.connect 的选项）
       ⇒ 症状 ECONNREFUSED，而错误信息一个字都不提 createConnection。
    ⚠ 这三条 stdio 一个都没有。

================================================================================
 协议：**仍然是 HTTP/1.1**（不是自定义二进制）
================================================================================
 引擎那边跑的还是 BaseHTTPRequestHandler，只是把 socket 换成
 stdin/stdout 两条流。⇒ 请求格式、响应格式、错误形状、音频字节
 全部与今天走 HTTP 时**完全一致**。

 ⛔ 不换成自定义二进制协议：那样每一条上层逻辑都会变成「两套实现」，
   而两套实现迟早分叉。

================================================================================
 ⭐⭐ 一条流一个请求 ⇒ 并发模型天然正确
================================================================================
 引擎这一侧：`/tts` 走一把锁排成队（host.py 原有逻辑），/health 随时可答。
 平台这一侧：每个引擎**一个**长连接，stdin/stdout 各一条流，按序发按序收。
 ⇒ 平台侧**不需要** worker 池、不需要实例配额、不需要半双工处理。
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import traceback

BANNER = "[stdio]"

# ⚠ 协议帧的大小上限：单次响应（音频 WAV）可能有好几 MB。
#   这个数只是「防御性上限」—— 正常请求体是 JSON，响应体是 WAV。
MAX_FRAME = 512 * 1024 * 1024


# ---------------------------------------------------------------------------
#  一个「像 socket 的」对端：把 stdin/stdout 包装成 makefile 能用的东西
# ---------------------------------------------------------------------------
class _StdioSocket(object):
    """让 BaseHTTPRequestHandler 能用 self.connection / makefile()。

    ⭐ Handler 一字不改的技术前提就在这里：它只要求
      「有 makefile(mode) / sendall / close」。
    """

    def __init__(self, reader, writer):
        self._r = reader
        self._w = writer
        self._lock = threading.Lock()   # ⭐ 写必须串行：一次响应 = 多次 write
        self._cached_file = None        # ⭐ 所有请求共用一份（见 makefile 的注释）

    def makefile(self, mode="rwb", bufsize=0):
        # ⭐⭐⭐ 必须**永远返回同一个对象**。
        #
        #   socketserver 每个请求都会调一次 makefile()。对真 socket 来说没问题
        #   （内核/socket 自己带缓冲，多个 file 共享同一个 fd 的数据）。
        #   但我们的 _StdioFile 把**缓冲放在自己身上** ⇒ 新的 file 对象
        #   缓冲是空的，而上一个已经读走的字节**回不来了**。
        #   ⭐ 症状：第一个请求正常，之后全乱（405/501/404/空响应），
        #     而协议实现是好的 ⇒ 排查必然跑偏。
        #   ⭐ 所以这里缓存一份，全生命周期共用。
        if self._cached_file is None:
            self._cached_file = _StdioFile(self, mode, bufsize)
        return self._cached_file

    def sendall(self, data, flags=0):
        with self._lock:
            self._w.write(data)
            self._w.flush()

    def send(self, data):
        self.sendall(data)
        return len(data)

    def close(self):
        # ⛔ 不关 stdin/stdout：它们是**父进程给的**，关了父进程那边就废了。
        #   引擎的「连接结束」靠 HTTP 的 keep-alive 语义，不靠关管道。
        pass

    def shutdown(self, how):
        pass

    def settimeout(self, t):
        # ⭐ 刻意不支持：宿主是同步的，假装支持比不支持更坏
        #   （调用方会以为超时生效了）。
        raise socket.timeout("stdio 传输不支持 settimeout（宿主是同步的）")

    def fileno(self):
        raise OSError("stdio 传输没有文件描述符")


class _StdioFile(object):
    """Handler 眼里的 rfile / wfile。"""

    def __init__(self, sock, mode, bufsize):
        self._body_left = 0     # ⭐ 本请求还欠多少 body 字节
        self._s = sock
        self._writable = "w" in mode or "b" in mode
        self._buf = b""
        self._eof = False
        self.closed = False

    def _fill(self, want):
        """往 _buf 里补数据，**最多补到 want**，但只要有就返回。

        ⭐⭐ 必须用 `read1()` 而不是 `read()`。
           `BufferedReader.read(n)` 的语义是「**阻塞直到攒够 n 字节或 EOF**」。
           而 stdin 是**流**：一个请求只有几百字节，read(65536) 会一直等下去
           ⇒ 把后续请求也吞进缓冲（或者干脆挂住）。
           ⭐ 症状：第一个请求正常，之后要么超时要么 501，
             而协议/路由/Handler 全是好的 ⇒ 排查必然跑偏。
           `read1(n)` 的语义才是「有多少拿多少，最多 n」—— 流该有的语义。
        """
        r = self._s._r
        read1 = getattr(r, "read1", None)
        chunk = read1(want) if read1 is not None else r.read(want)
        if not chunk:
            self._eof = True
        else:
            self._buf += chunk

    def read(self, size=-1):
        if size is None or size < 0:
            # ⛔ 负数 = 「读到 EOF」。⛔ **不能**用 _fill(0) 循环到 eof：
            #   HTTP 请求体永远带 Content-Length，走不到这里；
            #   真走到了（Chunked 之类）也该由上层决定要不要，而不是
            #   在一个「读全部」的调用里把整个连接读干。
            out = self._buf
            self._buf = b""
            return out
        while len(self._buf) < size and not self._eof:
            self._fill(size - len(self._buf))
        out, self._buf = self._buf[:size], self._buf[size:]
        return out

    def readline(self, limit=-1):
        # ⛔ **不能**给 sys.stdin.buffer.readline() 传 size。
        #   实测（Windows/Python 3.14）：传了 size 之后它返回的片段里
        #   **可能不含换行**，于是下面 `b"\n" not in self._buf` 永远成立，
        #   循环一直读到下一行 ⇒ Handler 把第二行（Host:）当成了请求行
        #   ⇒ 回 "HTTP/0.9 request type ('Host:')" + 400。
        #   ⭐ 症状极具欺骗性：连上了、有完整响应、只是状态码不对
        #     ⇒ 排查会去查路由，而路由没问题。
        while b"\n" not in self._buf and not self._eof:
            chunk = self._s._r.readline()      # ⭐ 不传 size
            if not chunk:
                self._eof = True
                break
            self._buf += chunk
        i = self._buf.find(b"\n")
        if i < 0:
            out, self._buf = self._buf, b""
            return out
        out, self._buf = self._buf[:i + 1], self._buf[i + 1:]
        # ⭐ 记住本请求体还欠多少。理由见 drain_unread_body()。
        if out[:15].lower() == b"content-length:":
            try:
                self._body_left = int(out.split(b":", 1)[1].strip())
            except ValueError:
                self._body_left = 0
        return out

    def drain_unread_body(self):
        """Handler 提前返回（错误响应）时，把**没读完的请求体**丢掉。

        ⭐⭐ 为什么必须做：HTTP 请求体是**带长度**的字节流。
           `do_POST` 若在读 body 之前就 return（比如引擎还没 ready 时的 503），
           那些字节就**留在流里**，而下一个请求的请求行会被拼在它后面
           ⇒ 解析出乱七八糟的 method ⇒ 501 Unsupported method。

        ⭐ 症状极具欺骗性：第一个请求正常、第二个开始 501，
           而「引擎没 ready」和「501」看起来毫无关系
           ⇒ 排查会跑去查路由表和 HTTP 实现，而两者都是好的。

        ⭐ 顺带说明：这条在**真 socket 上同样是 bug**，只是 HTTP 路线
           因为客户端每次都新开连接（Connection: close）看不出来。
           ⭐⭐ stdio 是长连接，于是它必然暴露 —— 传输层替我们揭了一个
             一直存在的隐患。这正是「长连接更接近真实」的代价与收益。
        """
        left = self._body_left
        self._body_left = 0
        while left > 0 and not self._eof:
            chunk = self._buf[:left]
            self._buf = self._buf[len(chunk):]
            left -= len(chunk)
            if left > 0:
                self._fill(left)
        return

    def readinto(self, b):
        data = self.read(len(b))
        b[:len(data)] = data
        return len(data)

    def write(self, data):
        # ⛔ 不吞异常：写失败必须让上层看见。
        #   吞掉的后果是「宿主以为自己回过了，客户端在等」——
        #   而那种症状是**超时**，长得像「引擎慢」，极难查。
        if not isinstance(data, (bytes, bytearray)):
            data = str(data).encode("utf-8")
        self._s.sendall(bytes(data))
        return len(data)

    def flush(self):
        pass

    def close(self):
        # ⛔ 刻意**不**置 _eof / 不清缓冲。
        #   socketserver 每个请求结束都会 finish() → 关 wfile/rfile。
        #   真 socket 上这没问题（下次 makefile 拿新 fd）；
        #   但我们**共用同一个对象**（见 _StdioSocket.makefile），
        #   ⛔ 一旦在这里把缓冲判死，下一个请求就读到空 ⇒ 循环里
        #   第一个请求之后全都「没人应答」。
        #   ⭐ 真实 socket 的 close 是「关 fd」，而我们的「关」应该是 no-op ——
        #     因为 stdio 的生命周期是**进程级**，不是连接级。
        self.closed = True


# ---------------------------------------------------------------------------
#  引擎这一侧：serve_forever
# ---------------------------------------------------------------------------
def serve(handler_factory, engine_id=None, on_ready=None):
    """在当前进程上跑 Handler，读 stdin 写 stdout，直到 stdin 关掉。

    ⭐ 这个函数**阻塞**。宿主（host.py）调它，然后就没有然后了 ——
      进程活着的全部意义就是「有人在跟我说话」。
    """
    # ⭐⭐ 协议走 **stdout**，日志一律走 **stderr**。
    #   两者混在一起会把 HTTP 帧搅坏 —— 而症状是「客户端解析失败」，
    #   排查方向会跑去查协议实现，而协议实现是好的。
    #   ⛔ 所以这个模块**绝不能**往 stdout 写任何别的东西。
    sock = _StdioSocket(sys.stdin.buffer, sys.stdout.buffer)

    if on_ready:
        on_ready(engine_id)

    # ⭐⭐⭐ 每个请求造一个 Handler 实例，而且**强制它只服务一个请求**。
    #
    #   踩过的三个坑（都在这里）：
    #   1. BaseHTTPRequestHandler.handle() 内部会**循环** handle_one_request()
    #      直到 close_connection ⇒ 一个实例会一直阻塞等下一个请求
    #      ⇒ 我在 handler_factory() 返回之后做的清理**永远等不到**。
    #      ⭐ 所以「处理完再清理」这个想法本身是错的 ——
    #        清理必须发生在**每一个请求内部**。
    #   2. makefile() 每次都调，而缓冲在 file 对象身上 ⇒ 必须共用同一个。
    #   3. do_POST 提前返回（如引擎没 ready 时的 503）时**没读请求体**，
    #      那些字节留在流里 ⇒ 下一个请求的请求行被拼在它后面 ⇒ 501。
    #
    #   ⭐⭐ 顺带一个重要发现：坑 3 在**真 socket 上也是 bug**，只是 HTTP 路线
    #   因为客户端每次新开连接看不出来。stdio 是长连接，必然暴露。
    #   ⭐⭐ 也就是说 stdio 替我们揭出了一个一直存在的隐患。

    handler_cls = handler_factory
    rfile_holder = sock.makefile("rwb")

    class _OneRequest(handler_cls):
        """一个实例 = 一个请求。⭐ 不改 host.py 的 Handler，一个字都不改。"""

        def handle_one_request(self):
            handler_cls.handle_one_request(self)
            # ⭐ 只服务这一个 ⇒ 让基类的循环退出，控制权回到我们手上。
            self.close_connection = True
            # ⭐ 丢掉这个请求**没读完的 body**（见上面坑 3）。
            try:
                rfile_holder.drain_unread_body()
            except Exception:
                pass

    while True:
        try:
            handler = _OneRequest(sock, rfile_holder, ("stdio", 0))
        except (BrokenPipeError, ConnectionResetError):
            sys.stderr.write("%s 连接断了，宿主退出（引擎 %s）\n" % (BANNER, engine_id))
            sys.stderr.flush()
            return 0
