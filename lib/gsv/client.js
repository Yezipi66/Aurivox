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
//   ⭐ 刀 A1（2026-08-31）收尾：**不传 baseUrl 就当场抛**（requireBaseUrl）。
//     本模块从此一台引擎都不认识 —— 它只是一根管子，两头都由调用方指定。
//     ⛔ 不许在这个文件里出现任何引擎名、任何端口号、任何名片查询。

const http = require("http");

// ⭐⭐⭐ 刀 A1（2026-08-31）：这里过去有 legacyProfile() / defaultBaseUrl() /
//   defaultTimeout() —— 三个都靠 resolveLegacyDefaultProfile() 去「名片上写
//   legacy_default 的那台」。**全部已删**，连同 lib/engines/legacyDefault.js。
//   最后一个用户是 /api/pron/preview，它已改成跟着当前选中的引擎走
//   （lib/routes/pron.js，Owner 2026-08-31 12:22 裁决④）。
//
// ⚠ 连带删掉的还有模块级导出 GPT_SOVITS_BASE_URL 那个 getter：
//   它是「这个模块知道一个默认地址」的最后一处痕迹。
//   ⛔ 健康探测请自己解析要探哪台（server.js:67 有它自己的同名常量，
//     那一个读的是环境变量，与本模块无关）。

// 传输层超时的兜底值 —— ⚠ 这是**socket 层的保险丝，不是引擎参数**。
// ⭐ 正常路径永远用不到它：每个调用方都从名片拿 { baseUrl, timeout_ms } 一起传。
//   它只在「有人传了地址却没传超时」时兜一下，免得一个卡住的连接永远不返回。
// ⛔ 不做成环境变量 —— 环境变量意味着「这是给用户调的」，而这个数不是。
const TRANSPORT_FALLBACK_TIMEOUT_MS = 120000;

// 地址没给出来就当场停，并说清是谁没给。
// ⛔ 不回落：回落把「调用点漏传了地址」表现成「另一台引擎报了个看不懂的错」。
function requireBaseUrl(baseUrl, pathStr) {
  if (baseUrl) return baseUrl;
  const err = new Error(
    `发往 ${pathStr} 的请求没有说要连哪台引擎（调用方没传 baseUrl）。` +
    `平台不替它挑一台 —— 挑错的症状是「界面上选的是 A，报错却是 B 说的话」，几乎查不出来。` +
    `请在调用处传 { baseUrl: <那台引擎的 base_url> }（通常来自 resolveEngineProfile(engine_id).base_url）。`);
  err.code = 'ENGINE_BASE_URL_MISSING';
  throw err;
}

// `baseUrl` (契约 v2 第 1 步): 按次指定要连哪台引擎。不传 = 老路径引擎。
function gsvRequest(method, pathStr, payload, reqTimeout = 0, signal = null, baseUrl = null) {
  return new Promise((resolve, reject) => {
    let url;
    const base = requireBaseUrl(baseUrl, pathStr);
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
      timeout: reqTimeout || TRANSPORT_FALLBACK_TIMEOUT_MS,
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
    const url = new URL(`${requireBaseUrl(baseUrl, pathStr)}${pathStr}`);
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
      timeout: reqTimeout || TRANSPORT_FALLBACK_TIMEOUT_MS,
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

// ⭐ 刀 A1：_resetProfileCache 也删了 —— 本模块从此**不缓存任何引擎信息**，
//   因为它从此**不知道任何引擎**。地址每次由调用方连着请求一起给。
//   ⛔ 一个「重置缓存」的测试钩子存在，本身就是在说这里藏着一份状态。
module.exports = { gsvRequest, gsvPost, gsvGet, gsvStream };
