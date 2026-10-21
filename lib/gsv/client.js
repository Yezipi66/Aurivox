// 引擎的 HTTP 客户端。地址和超时都从名片来（engines/<id>/manifest.json），且都可以
// 按次覆盖：gsvPost(path, payload, { baseUrl, reqTimeout })。不传 baseUrl 就当场抛。
// 本模块一台引擎都不认识：它只是一根管子，两头都由调用方指定。
// 不许在这个文件里出现任何引擎名、任何端口号、任何名片查询。

const http = require("http");

// 传输层超时的兜底值：这是 socket 层的保险丝，不是引擎参数。
// 正常路径永远用不到它：每个调用方都从名片拿 { baseUrl, timeout_ms } 一起传。
// 它只在「有人传了地址却没传超时」时兜一下，免得一个卡住的连接永远不返回。
// 不做成环境变量：环境变量意味着「这是给用户调的」，而这个数不是。
const TRANSPORT_FALLBACK_TIMEOUT_MS = 120000;

// 地址没给出来就当场停，并说清是谁没给。
// 不回落：回落把「调用点漏传了地址」表现成「另一台引擎报了个看不懂的错」。
function requireBaseUrl(baseUrl, pathStr) {
  if (baseUrl) return baseUrl;
  const err = new Error(
    `发往 ${pathStr} 的请求没有说要连哪台引擎（调用方没传 baseUrl）。` +
    `平台不替它挑一台：挑错的症状是「界面上选的是 A，报错却是 B 说的话」，几乎查不出来。` +
    `请在调用处传 { baseUrl: <那台引擎的 base_url> }（通常来自 resolveEngineProfile(engine_id).base_url）。`);
  err.code = 'ENGINE_BASE_URL_MISSING';
  throw err;
}

// 按次指定要连哪台引擎。不传 baseUrl 就抛。
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
    // signal 让调用方（优雅停机、interrupted:true）能中止发往引擎的在途请求。
    // 销毁 socket 会 reject 这个 promise，在途登记表因此能解开，进程也能及时退出。
    if (signal) {
      const onAbort = () => { try { req.destroy(); } catch (_) {} reject(new Error("aborted")); };
      if (signal.aborted) onAbort();
      else { try { signal.addEventListener("abort", onAbort, { once: true }); } catch (_) {} }
    }
    if (body) req.write(body);
    req.end();
  });
}

// opts: { signal?: AbortSignal, reqTimeout?: number, baseUrl?: string }
// 兼容老的两参数调用方。
function gsvPost(pathStr, payload, opts) {
  return gsvRequest("POST", pathStr, payload,
    (opts && opts.reqTimeout) || 0, opts && opts.signal, (opts && opts.baseUrl) || null);
}
function gsvGet(pathStr, params, opts) {
  return gsvRequest("GET", pathStr, params,
    (opts && opts.reqTimeout) || 0, null, (opts && opts.baseUrl) || null);
}

// 流式 POST：不像 gsvRequest 那样把整个响应体缓冲下来，它在响应头一到就 resolve，
// 并交出活的可读流。调用方把它直接接到客户端上，才能有真正的分块低延迟。
// 上游返回非 2xx 时，调用方要自己把 stream 读完才能读到错误体。
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
      // 交出活的流，不缓冲：引擎继续推音频块给调用方转发。
      resolve({ statusCode: res.statusCode, headers: res.headers, stream: res, request: req });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

// 本模块不缓存任何引擎信息，因为它不知道任何引擎。一个「重置缓存」的测试钩子存在，
// 本身就是在说这里藏着一份状态。
module.exports = { gsvRequest, gsvPost, gsvGet, gsvStream };
