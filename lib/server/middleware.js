'use strict';

// ============================================================================
//  平台 HTTP 面：请求来源校验 / API key / 错误脱敏 / 静态目录边界 / CORS
// ============================================================================
//
// 从 server.js 逐字搬来（P0 拆分任务 1），行为零变化。
//
// 搬出来的理由：server.js 是全仓唯一会被 require 就 listen 的文件（见它末尾
// 的 require.main 守卫），住在里面的函数永远进不了测试进程。
//
// 这里只放「谁可以打这个服务」和「报错怎么说给客户端听」，不认识任何业务。

const path = require('path');
const crypto = require('crypto');

// 环境驱动的配置，默认值与历史行为一致。
const API_KEY = process.env.API_KEY || process.env.BROKER_API_KEY || "";
// 破坏性端点是否强制要求 key。默认关：本机工作站（loopback）免 key。
const REQUIRE_KEY_FOR_DESTRUCTIVE = process.env.REQUIRE_KEY_FOR_DESTRUCTIVE === "1";

// CORS (1.0.7): the browser origin(s) allowed to call this broker cross-origin.
// Default is the Vite dev server (http://127.0.0.1:5173), used ONLY during
// frontend development — in production the UI is served same-origin from
// web/dist and needs no CORS at all. Set AURIVOX_CORS_ORIGIN to a comma-separated
// allow-list (or "*" for any) to let an external OpenAI-compatible client call
// /v1 from a web page.
const CORS_ORIGIN = (process.env.AURIVOX_CORS_ORIGIN || "http://127.0.0.1:5173").trim();

// cors() 的配置。写成函数是为了让 server.js 那一行 app.use 保持原样可读，
// 而读环境变量的动作只在这里发生一次。
function corsOptions() {
  return {
    origin: CORS_ORIGIN === "*" ? true
      : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

function isLoopback(req) {
  const ip = req.ip || req.connection?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function validateHost(req, res, next) {
  const host = req.headers.host || "";
  const hostname = host.split(":")[0];
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && !isLoopback(req)) {
    return res.status(403).json({ error: "Forbidden: Invalid Host header" });
  }
  next();
}

function requireApiKey(req, res, next) {
  // Local workstation (training/inference/asset management) — always allow loopback, never need key.
  // Only external (distribution) calls require key.
  if (isLoopback(req) && !REQUIRE_KEY_FOR_DESTRUCTIVE) {
    return next();
  }
  if (!API_KEY) {
    return res.status(401).json({ error: "API_KEY not configured for remote access." });
  }
  
  // Support both 'x-api-key' and 'Authorization: Bearer ***'
  let key = req.headers["x-api-key"] || "";
  const authHeader = req.headers["authorization"] || "";
  if (!key && authHeader.startsWith("Bearer ")) {
    key = authHeader.slice(7).trim();
  }

  // Timing-safe comparison to prevent side-channel attacks
  const a = Buffer.from(key);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Sanitize error for client response.
 * Logs the full error server-side; returns a safe generic message to the client.
 * @param {Error|string} err - The error object or message
 * @param {string} [fallback] - Optional context about what failed (e.g. "voices.json error")
 */
function clientError(err, fallback) {
  if (fallback === undefined) fallback = "Internal server error";
  // Always log full error server-side
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[clientError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  // Return only the generic fallback to the client — never raw error details
  return fallback;
}

// Like clientError but RETURNS THE REAL MESSAGE to the client. Use only for
// local-workbench management endpoints (loopback-only: rename, config, fs browse)
// where a meaningful message ("folder locked by X", "path not writable") is
// essential for the user to act — the generic mask makes those unusable.
function localError(err) {
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[localError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  return errMsg;
}

// ---- Static: assets/ for audio playback ----
function safeStaticRoot(rootDir) {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    let rel;
    try {
      // decodeURIComponent can throw on malformed percent sequences; reject them.
      rel = decodeURIComponent(req.path);
    } catch (_) {
      return res.status(400).end();
    }
    // Strip leading separators after URL decoding. Reject NUL bytes and
    // absolute / drive paths before path.join() can interpret them.
    rel = rel.replace(/^[\\/]+/, "");
    if (rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
      return res.status(404).end();
    }
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return res.status(404).end();
    }
    next();
  };
}

module.exports = {
  API_KEY,
  REQUIRE_KEY_FOR_DESTRUCTIVE,
  CORS_ORIGIN,
  corsOptions,
  isLoopback,
  validateHost,
  requireApiKey,
  clientError,
  localError,
  safeStaticRoot,
};
