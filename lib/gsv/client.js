// ===========================
//  GPT-SoVITS HTTP CLIENT
// ===========================
// Thin HTTP client for the local inference engine (default 127.0.0.1:9880).
// Extracted verbatim from server.js (Stage-0 refactor) — behaviour unchanged.
// The base URL is resolved from the same env var / default server.js used.

const http = require("http");

const GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880";

function gsvRequest(method, pathStr, payload, reqTimeout = 300000, signal = null) {
  return new Promise((resolve, reject) => {
    let url;
    const headers = {};
    let body = null;
    if (method === "GET" && payload) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
      url = new URL(`${GPT_SOVITS_BASE_URL}${pathStr}?${params.toString()}`);
    } else {
      url = new URL(`${GPT_SOVITS_BASE_URL}${pathStr}`);
      if (payload) {
        body = JSON.stringify(payload);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(body);
      }
    }
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers,
      timeout: reqTimeout || 300000,
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

// `opts` (1.0.7): { signal?: AbortSignal, reqTimeout?: number }. Back-compat -
// existing 2-arg callers are unaffected.
function gsvPost(pathStr, payload, opts) {
  return gsvRequest("POST", pathStr, payload, (opts && opts.reqTimeout) || 300000, opts && opts.signal);
}
function gsvGet(pathStr, params) { return gsvRequest("GET", pathStr, params); }

// Streaming POST: unlike gsvRequest (which buffers the whole body via
// Buffer.concat), this resolves as soon as the response HEADERS arrive and hands
// back the LIVE readable response stream WITHOUT buffering. The caller pipes it
// straight to the client for true chunked/low-latency streaming. On a non-2xx
// upstream status the caller is expected to drain `stream` to read the error
// body. The socket keeps flowing until the engine finishes emitting chunks.
function gsvStream(pathStr, payload, reqTimeout = 300000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GPT_SOVITS_BASE_URL}${pathStr}`);
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
      timeout: reqTimeout || 300000,
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

module.exports = { GPT_SOVITS_BASE_URL, gsvRequest, gsvPost, gsvGet, gsvStream };
