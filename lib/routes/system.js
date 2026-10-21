// 健康检查与模型版本状态路由。共用 server.js 的作用域符号由 `ctx` 注入，路径不变。

const express = require("express");
// 逐台健康复用 /api/engines 那份探活，不在这里另写一个：两处各写一遍探活，迟早会分叉。
const { listEngines } = require("../engines/registry");
const { resolveEngineProfile } = require("../engines/profile");
const { probeEngineOnline } = require("./engines");

// 逐台健康：契约 §12 第 2 步。
// `engine_online` 与 `gpt_sovits_url` 两个老字段仍原样保留（取值方式不动），但已标记退役：
// 前端零消费。等价信息由新键 `engines[].base_url` / `engines[].online` 承载，
// 响应新增 `deprecated` 数组点名这两个字段 + 迁移目标。
// 于是同一台老引擎会被探两次（老字段一次、列表里一次）：老字段的含义必须完全不依赖
// 名片体系，否则 manifest.json 的逗号写错，表现出来就是「webui 说引擎掉线了」。
async function listEngineHealth() {
  let manifests;
  try {
    manifests = listEngines();
  } catch (err) {
    return { engines: [], errors: [{ id: null, code: (err && err.code) || null,
      error: `列举引擎失败：${(err && err.message) || err}` }] };
  }
  const resolved = [];
  const errors = [];
  for (const m of manifests) {
    try {
      resolved.push(resolveEngineProfile(m.id));
    } catch (err) {
      errors.push({ id: m.id, code: (err && err.code) || null,
        error: (err && err.message) || String(err) });
    }
  }
  const probes = await Promise.all(resolved.map((p) => probeEngineOnline(p)));
  return {
    engines: resolved.map((p, i) => ({
      id: p.id,
      label: p.label,
      base_url: p.base_url,
      // 三态，不是布尔：null = 名片没写 runtime.ready_endpoint，平台不知道该访问哪儿判断死活。
      // 「不知道」和「确定离线」糊成同一个假值，界面上那个灰点就说不清了。
      online: probes[i].online,
    })),
    errors,
  };
}

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { GPT_SOVITS_BASE_URL, checkBaseModelsForVersion, checkFfmpeg, detectCuda, http, normModelVersion, noteEngineHealth } = ctx;
  // 引擎地址只从这里解析一次，用后端其余部分同一个环境变量（GPT_SOVITS_BASE_URL）。
  // 健康检查不许写死端口：start.ps1 把引擎挪到别的端口时会导出这个变量，写死的探针
  // 会一直误报 engine_online:false。
  const ENGINE_URL = (GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880").replace(/\/+$/, "");

  let APP_VERSION = "0.0.0";
  try { APP_VERSION = require("../../package.json").version || APP_VERSION; } catch (_) {}

router.get("/api/health", async (req, res) => {
  let engine_online = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${ENGINE_URL}/`, { signal: ctrl.signal });
    clearTimeout(t);
    engine_online = r.ok;
  } catch (err) {
    console.warn("[system] 引擎健康探测失败:", err.message);
    engine_online = false;
  }
  // 把存活状态喂给换模型缓存：offline→online 的翻转说明引擎重启过、常驻权重没了。
  if (typeof noteEngineHealth === "function") noteEngineHealth(engine_online);
  let per = { engines: [], errors: [] };
  try {
    per = await listEngineHealth();
  } catch (err) {
    per = { engines: [], errors: [{ id: null, code: (err && err.code) || null,
      error: `逐台健康失败：${(err && err.message) || err}` }] };
  }
  res.json({
    ok: true,
    version: APP_VERSION,
    engine_online,          // RETIRED — see response.deprecated
    gpt_sovits_url: ENGINE_URL, // RETIRED — use engines[].base_url instead
    deprecated: [
      { key: 'engine_online', use: 'engines[].online', since: APP_VERSION },
      { key: 'gpt_sovits_url', use: 'engines[].base_url', since: APP_VERSION },
    ],
    engines: per.engines,
    engine_errors: per.errors,
    ffmpeg_available: checkFfmpeg(),
    // 键名仍叫 `cuda`：前端 web/src/App.jsx 与 TrainingTab 四处在读它，改键名要连前端那四处一起改。
    // 有 Intel/AMD 卡而没有 N 卡时，device_name 有值而 available=false：那不是故障。
    cuda: detectCuda(),
  });
});

router.get("/api/models/status", (req, res) => {
  const raw = req.query.versions != null ? String(req.query.versions)
            : (req.query.version != null ? String(req.query.version) : 'v2');
  const seen = new Set(); const versions = [];
  for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const nv = normModelVersion(tok);
    if (!seen.has(nv)) { seen.add(nv); versions.push(checkBaseModelsForVersion(nv)); }
  }
  if (!versions.length) versions.push(checkBaseModelsForVersion('v2'));
  const anyBlocking = versions.some((v) => v.blocking);
  const anyDegraded = versions.some((v) => v.degraded);
  res.json({ versions, anyBlocking, anyDegraded, ...versions[0] });
});

  return router;
};
