'use strict';

// 平台 HTTP 面：请求来源校验 / API key / 错误脱敏 / 静态目录边界 / CORS。
// 这里只放「谁可以打这个服务」和「报错怎么说给客户端听」，不认识任何业务。

const path = require('path');
const crypto = require('crypto');

// 环境驱动的配置，默认值与历史行为一致。
const API_KEY = process.env.API_KEY || process.env.BROKER_API_KEY || "";
// 破坏性端点是否强制要求 key。默认关：本机工作站（loopback）免 key。
const REQUIRE_KEY_FOR_DESTRUCTIVE = process.env.REQUIRE_KEY_FOR_DESTRUCTIVE === "1";

// 允许跨域调用这个 broker 的浏览器来源。默认是 Vite 开发服务器，只在开发前端时
// 用得上：生产环境的界面从 web/dist 同源提供，根本不需要 CORS。
// AURIVOX_CORS_ORIGIN 是逗号分隔的白名单（写成 "*" 则放行任何来源），
// 供外部的 OpenAI 兼容客户端从网页里调 /v1。
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

// 只接受 localhost / 127.0.0.1 的 Host 头，或来自 loopback 的请求。
function validateHost(req, res, next) {
  const host = req.headers.host || "";
  const hostname = host.split(":")[0];
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && !isLoopback(req)) {
    return res.status(403).json({ error: "Forbidden: Invalid Host header" });
  }
  next();
}

function requireApiKey(req, res, next) {
  // 本机工作站（训练/推理/资产管理）永远放行 loopback，不需要 key；
  // 只有外部（分发出去的）调用才要 key。
  if (isLoopback(req) && !REQUIRE_KEY_FOR_DESTRUCTIVE) {
    return next();
  }
  if (!API_KEY) {
    return res.status(401).json({ error: "API_KEY not configured for remote access." });
  }

  // 同时支持 'x-api-key' 与 'Authorization: Bearer ***'。
  let key = req.headers["x-api-key"] || "";
  const authHeader = req.headers["authorization"] || "";
  if (!key && authHeader.startsWith("Bearer ")) {
    key = authHeader.slice(7).trim();
  }

  // 定长比较，防侧信道。
  const a = Buffer.from(key);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * 把错误收拾成可以发给客户端的一句话。
 * 完整错误只在服务端日志里，客户端只拿到这句通用提示。
 * @param {Error|string} err 错误对象或错误消息
 * @param {string} [fallback] 可选的上下文，说明是什么失败了
 */
function clientError(err, fallback) {
  if (fallback === undefined) fallback = "Internal server error";
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[clientError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  // 绝不给客户端原始错误细节，只给通用提示。
  return fallback;
}

// 同 clientError，但把真实消息返回给客户端。只用于本机工作台的管理端点
//（仅 loopback：改名、配置、浏览文件），那里用户必须看到可据以行动的具体原因
//（"文件夹被 X 占用"、"路径不可写"），通用提示会让这些端点没法用。
function localError(err) {
  const errMsg = (err && err.message) || (err && err.toString()) || String(err);
  console.error("[localError]", errMsg, err && err.stack ? "\n" + err.stack : "");
  return errMsg;
}

// ---- 静态：assets/ 供音频回放 ----
function safeStaticRoot(rootDir) {
  const root = path.resolve(rootDir);
  return (req, res, next) => {
    let rel;
    try {
      // decodeURIComponent 遇到残缺的百分号序列会抛错，直接拒掉。
      rel = decodeURIComponent(req.path);
    } catch (_) {
      return res.status(400).end();
    }
    // URL 解码后剥掉开头的分隔符；NUL 字节与绝对/盘符路径必须在
    // path.join() 能解释它们之前就拒掉。
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
