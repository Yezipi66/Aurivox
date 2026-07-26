// ===========================
//  GPT-SoVITS HTTP CLIENT
// ===========================
// Thin HTTP client for the local inference engine (default 127.0.0.1:9880).
// Extracted verbatim from server.js (Stage-0 refactor) — behaviour unchanged.
// The base URL is resolved from the same env var / default server.js used.

const http = require("http");

const GPT_SOVITS_BASE_URL = process.env.GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880";

function gsvRequest(method, pathStr, payload, reqTimeout = 300000) {
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
    if (body) req.write(body);
    req.end();
  });
}

function gsvPost(pathStr, payload) { return gsvRequest("POST", pathStr, payload); }
function gsvGet(pathStr, params) { return gsvRequest("GET", pathStr, params); }

module.exports = { GPT_SOVITS_BASE_URL, gsvRequest, gsvPost, gsvGet };
