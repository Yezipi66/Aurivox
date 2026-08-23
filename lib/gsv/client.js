// ===========================
//  ENGINE HTTP CLIENT
// ===========================
// Thin HTTP client for a local inference engine.
//
// 契约 v2 第 1 步改动（2026-08-23）：
//   之前这里是 `const GPT_SOVITS_BASE_URL = env || "http://127.0.0.1:9880"` ——
//   一个模块级常量，在 require 的那一刻就定死了。后果是**整个进程只能对话
//   一台引擎**，而且那台引擎的地址是 GPT-SoVITS 的。工作流画布上的引擎节点
//   哪怕选了别的引擎，请求还是会发到 9880。
//
//   现在地址和超时都从名片来（engines/<id>/manifest.json），且都可以按次覆盖：
//     gsvPost(path, payload, { baseUrl, reqTimeout })
//
//   ⚠ 行为兼容：不传 baseUrl 时，解析的是「老路径引擎」（名片里写
//     legacy_default:true 的那一个），它的名片声明了 base_url_env =
//     GPT_SOVITS_BASE_URL ⇒ 环境变量照旧生效，默认值照旧是 9880。
//     也就是说，今天所有调用方的行为一个字没变。

const http = require("http");

const { resolveLegacyDefaultProfile } = require("../engines/legacyDefault");

// 名片解析是读盘 + 校验，不该每个请求做一次；但也不能在 require 时做 ——
// 那会让「名片写错」表现为「服务起不来且栈里全是 require」。所以：懒解析 +
// 记住结果，第一次真正要发请求时才读。
let _cached = null;
function legacyProfile() {
  if (!_cached) _cached = resolveLegacyDefaultProfile();
  return _cached;
}
// 测试用：让下一次调用重新读名片。
function _resetProfileCache() { _cached = null; }

function defaultBaseUrl() { return legacyProfile().base_url; }
function defaultTimeout() { return legacyProfile().timeout_ms; }

// `baseUrl` (契约 v2 第 1 步): 按次指定要连哪台引擎。不传 = 老路径引擎。
function gsvRequest(method, pathStr, payload, reqTimeout = 0, signal = null, baseUrl = null) {
  return new Promise((resolve, reject) => {
    let url;
    const base = baseUrl || defaultBaseUrl();
    const headers = {};
    let body = null;
    if (method === "GET" && payload) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      url = new URL(`${base}${pathStr}?${params.toString()}`);
    } else {
      url = new URL(`${base}${pathStr}`);
      if (payload) {
        body = JSON.stringify(payload);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }
    }
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers,
      timeout: reqTimeout || defaultTimeout(),
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    // 1.0.7: let a caller (graceful shutdown / interrupted:true) abort the
    // in-flight upstream engine request. Destroying the socket rejects this
    // promise so the in-flight registry unwinds and the process can exit promptly.
    if (signal) {
      const onAbort = () => { try { req.destroy(); } catch (_) {} reject(new Error("aborted")); };
      if (signal.aborted) onAbort();
      else { try { signal.addEventListener("abort", onAbort, { once: true }); } catch (_) {} }
    }
    if (body) req.write(body);
    req.end();
  });
}

// `opts` (1.0.7): { signal?: AbortSignal, reqTimeout?: number }
//       (契约 v2 第 1 步): { baseUrl?: string }
// Back-compat - existing 2-arg callers are unaffected.
function gsvPost(pathStr, payload, opts) {
  return gsvRequest("POST", pathStr, payload,
    (opts && opts.reqTimeout) || 0, opts && opts.signal, (opts && opts.baseUrl) || null);
}
function gsvGet(pathStr, params, opts) {
  return gsvRequest("GET", pathStr, params,
    (opts && opts.reqTimeout) || 0, null, (opts && opts.baseUrl) || null);
}

// Streaming POST: unlike gsvRequest (which buffers the whole body via
// Buffer.concat), this resolves as soon as the response HEADERS arrive and hands
// back the LIVE readable response stream WITHOUT buffering. The caller pipes it
// straight to the client for true chunked/low-latency streaming. On a non-2xx
// upstream status the caller is expected to drain `stream` to read the error
// body. The socket keeps flowing until the engine finishes emitting chunks.
function gsvStream(pathStr, payload, reqTimeout = 0, opts) {
  return new Promise((resolve, reject) => {
    const baseUrl = (opts && opts.baseUrl) || null;
    const url = new URL(`${baseUrl || defaultBaseUrl()}${pathStr}`);
    let body = null;
    const headers = {};
    if (payload) {
      body = JSON.stringify(payload);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method: "POST", headers,
      timeout: reqTimeout || defaultTimeout(),
    };
    const req = http.request(options, (res) => {
      // Resolve with the LIVE stream; do not buffer. The connection stays open
      // and the engine keeps pushing audio chunks the caller relays downstream.
      resolve({ statusCode: res.statusCode, headers: res.headers, stream: res, request: req });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { gsvRequest, gsvPost, gsvGet, gsvStream, _resetProfileCache };

// 老导出保留，但从「常量」变成「取值时才算」。
//
// 为什么不直接删：routes/system.js 的健康探测、server.js 的启动横幅都在读它，
// 而且读的时机是启动早期。留成 getter 可以让这些调用方一个字不改，同时保证
// 它们看到的地址与真正发请求用的地址是**同一个来源** —— 分成两个来源过一次，
// 结果是健康页显示绿色、合成却连不上，那种问题查起来最费时间。
//
// ⚠ 这个键将在第 2 步（合成路径按引擎解析地址）之后删除。新代码请用
//   gsvPost(..., { baseUrl }) 或 resolveEngineProfile(id).base_url。
Object.defineProperty(module.exports, "GPT_SOVITS_BASE_URL", {
  enumerable: true,
  get() { return defaultBaseUrl(); },
});
